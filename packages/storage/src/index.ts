import { fileTypeFromBuffer } from "file-type";
import { Problem } from "@motorbaldi/contracts";
import { auditStatement } from "@motorbaldi/db/audit";
import { newId, sha256Hex } from "@motorbaldi/shared";

export interface MalwareScanner {
  scan(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<"CLEAN" | "INFECTED" | "UNAVAILABLE">;
}

export const unavailableScanner: MalwareScanner = {
  scan: async () => "UNAVAILABLE",
};

export const deterministicTestScanner: MalwareScanner = {
  scan: async (bytes) =>
    new TextDecoder().decode(bytes).includes("EICAR") ? "INFECTED" : "CLEAN",
};

export interface FileServiceOptions {
  scanner: MalwareScanner;
  authorizeDownload?: (
    actorAccountId: string,
    fileId: string,
  ) => Promise<boolean>;
}

export function files(
  db: D1Database,
  bucket: R2Bucket,
  options: FileServiceOptions,
) {
  return {
    async requestUpload(
      uploadedByAccountId: string,
      mime: string,
      size: number,
      requestId: string,
    ) {
      if (
        !["image/png", "image/jpeg", "application/pdf"].includes(mime) ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 10485760
      ) {
        throw new Problem(400, "INVALID_FILE", "Invalid file");
      }
      const id = newId();
      const key = "quarantine/" + id;
      await db.batch([
        db
          .prepare(
            "INSERT INTO storage_files(id, uploaded_by_account_id, object_key, declared_mime, size_bytes, request_id) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(id, uploadedByAccountId, key, mime, size, requestId),
        auditStatement(db, {
          actorId: uploadedByAccountId,
          action: "file.upload_requested",
          resourceType: "file",
          resourceId: id,
          requestId,
        }),
      ]);
      return { id, key, expiresIn: 120 };
    },

    async putQuarantineObject(id: string, bytes: Uint8Array, mime: string) {
      const row = await db
        .prepare(
          "SELECT object_key, declared_mime, size_bytes FROM storage_files WHERE id = ?",
        )
        .bind(id)
        .first<{
          object_key: string;
          declared_mime: string;
          size_bytes: number;
        }>();
      if (!row || row.declared_mime !== mime || row.size_bytes !== bytes.length)
        throw new Problem(409, "FILE_STATE", "Upload metadata mismatch");
      await bucket.put(row.object_key, bytes, {
        httpMetadata: { contentType: mime },
      });
      const recorded = await db
        .prepare(
          "UPDATE storage_files SET status = 'QUARANTINED', updated_at = ? WHERE id = ? AND status = 'PENDING_UPLOAD'",
        )
        .bind(new Date().toISOString(), id)
        .run();
      if ((recorded.meta.changes ?? 0) !== 1) {
        await bucket.delete(row.object_key);
        throw new Problem(409, "FILE_STATE", "Upload state changed");
      }
    },

    async scan(id: string, requestId: string) {
      const token = newId();
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + 60000).toISOString();
      const claimed = await db
        .prepare(
          "UPDATE storage_files SET status = 'SCANNING', scan_token = ?, scan_started_at = ?, scan_lease_until = ?, scan_attempts = scan_attempts + 1, last_error_code = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'QUARANTINED' RETURNING object_key, declared_mime, size_bytes",
        )
        .bind(token, now.toISOString(), leaseUntil, now.toISOString(), id)
        .first<{
          object_key: string;
          declared_mime: string;
          size_bytes: number;
        }>();
      if (!claimed)
        throw new Problem(409, "FILE_STATE", "File cannot be scanned");

      let status: "ACTIVE" | "REJECTED" | "QUARANTINED" = "QUARANTINED";
      let errorCode: string | null = null;
      let hash: string | null = null;
      let activeKey: string | null = null;
      const object = await bucket.get(claimed.object_key);
      const bytes = object
        ? new Uint8Array(await object.arrayBuffer())
        : new Uint8Array();
      const detected = await fileTypeFromBuffer(bytes);
      if (
        bytes.length !== claimed.size_bytes ||
        detected?.mime !== claimed.declared_mime
      ) {
        status = "REJECTED";
        errorCode = "FILE_CONTENT_INVALID";
      } else {
        const scan = await options.scanner.scan(
          bytes,
          AbortSignal.timeout(10000),
        );
        if (scan === "INFECTED") {
          status = "REJECTED";
          errorCode = "MALWARE_DETECTED";
        } else if (scan === "UNAVAILABLE") {
          errorCode = "SCANNER_UNAVAILABLE";
        } else {
          hash = await sha256Hex(bytes);
          activeKey = "active/" + id + "/" + token;
          await db
            .prepare(
              "INSERT INTO storage_file_promotions(object_key, file_id, scan_token) VALUES (?, ?, ?)",
            )
            .bind(activeKey, id, token)
            .run();
          await bucket.put(activeKey, bytes, {
            httpMetadata: { contentType: claimed.declared_mime },
          });
          status = "ACTIVE";
        }
      }

      const finishedAt = new Date().toISOString();
      const finalization = await db
        .prepare(
          "UPDATE storage_files SET status = ?, active_key = CASE WHEN ? = 'ACTIVE' THEN ? ELSE active_key END, sha256 = CASE WHEN ? = 'ACTIVE' THEN ? ELSE sha256 END, scan_token = NULL, scan_lease_until = NULL, last_error_code = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'SCANNING' AND scan_token = ? AND scan_lease_until > ?",
        )
        .bind(
          status,
          status,
          activeKey,
          status,
          hash,
          errorCode,
          finishedAt,
          id,
          token,
          finishedAt,
        )
        .run();
      const owned = (finalization.meta.changes ?? 0) === 1;
      if (activeKey) {
        await db
          .prepare(
            "UPDATE storage_file_promotions SET status = ?, updated_at = ? WHERE object_key = ? AND status = 'RESERVED'",
          )
          .bind(
            owned && status === "ACTIVE" ? "REFERENCED" : "CLEANUP",
            finishedAt,
            activeKey,
          )
          .run();
      }
      if (!owned)
        throw new Problem(409, "SCAN_LEASE_LOST", "Scan ownership was lost");
      await auditStatement(db, {
        actorId: null,
        action: "file.scan_" + status.toLowerCase(),
        resourceType: "file",
        resourceId: id,
        requestId,
      }).run();
      return status;
    },

    async download(id: string, actorAccountId: string) {
      if (!(await options.authorizeDownload?.(actorAccountId, id)))
        throw new Problem(404, "FILE_NOT_FOUND", "File not found");
      const file = await db
        .prepare(
          "SELECT active_key FROM storage_files WHERE id = ? AND status = 'ACTIVE'",
        )
        .bind(id)
        .first<{ active_key: string }>();
      if (!file?.active_key)
        throw new Problem(404, "FILE_NOT_FOUND", "File not found");
      return bucket.get(file.active_key);
    },

    async cleanupOrphanPromotions(limit = 100) {
      const rows =
        (
          await db
            .prepare(
              "SELECT p.object_key FROM storage_file_promotions p JOIN storage_files f ON f.id = p.file_id WHERE p.status IN ('RESERVED','CLEANUP') AND f.active_key IS NOT p.object_key LIMIT ?",
            )
            .bind(limit)
            .all<{ object_key: string }>()
        ).results ?? [];
      for (const row of rows) {
        await bucket.delete(row.object_key);
        await db
          .prepare(
            "UPDATE storage_file_promotions SET status = 'DELETED', updated_at = ? WHERE object_key = ?",
          )
          .bind(new Date().toISOString(), row.object_key)
          .run();
      }
      return rows.length;
    },

    async recoverExpiredFileScans(limit = 100, maxAttempts = 5) {
      const now = new Date().toISOString();
      const rows =
        (
          await db
            .prepare(
              "SELECT id, scan_attempts FROM storage_files WHERE status = 'SCANNING' AND scan_lease_until <= ? ORDER BY scan_lease_until LIMIT ?",
            )
            .bind(now, limit)
            .all<{ id: string; scan_attempts: number }>()
        ).results ?? [];
      for (const row of rows) {
        const terminal = row.scan_attempts >= maxAttempts;
        await db
          .prepare(
            "UPDATE storage_files SET status = ?, scan_token = NULL, scan_lease_until = NULL, last_error_code = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'SCANNING' AND scan_lease_until <= ?",
          )
          .bind(
            terminal ? "REJECTED" : "QUARANTINED",
            terminal ? "SCAN_ATTEMPTS_EXHAUSTED" : "SCAN_LEASE_EXPIRED",
            now,
            row.id,
            now,
          )
          .run();
      }
      return rows.length;
    },

    async cleanupStaleUploads(limit = 100, olderThanMs = 60 * 60 * 1000) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const rows =
        (
          await db
            .prepare(
              "SELECT id, object_key FROM storage_files WHERE status IN ('PENDING_UPLOAD','QUARANTINED','REJECTED') AND created_at <= ? ORDER BY created_at LIMIT ?",
            )
            .bind(cutoff, limit)
            .all<{ id: string; object_key: string }>()
        ).results ?? [];
      for (const row of rows) {
        await bucket.delete(row.object_key);
        await db
          .prepare(
            "UPDATE storage_files SET status = 'DELETED', last_error_code = 'STALE_UPLOAD_CLEANUP', updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('PENDING_UPLOAD','QUARANTINED','REJECTED')",
          )
          .bind(new Date().toISOString(), row.id)
          .run();
      }
      return rows.length;
    },
  };
}
