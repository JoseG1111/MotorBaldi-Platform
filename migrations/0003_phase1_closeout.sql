PRAGMA foreign_keys = ON;

INSERT INTO authz_role_permissions(role_id,permission_code)
VALUES ('org-admin','org.member.role.manage')
ON CONFLICT(role_id,permission_code) DO NOTHING;

CREATE INDEX IF NOT EXISTS org_invitations_expiry ON org_invitations(status,expires_at,id);
CREATE INDEX IF NOT EXISTS org_membership_requests_expiry ON org_membership_requests(status,expires_at,id);
CREATE INDEX IF NOT EXISTS professional_credentials_expiry ON professional_credentials(status,expires_at,id);
