# ADR 0006 — Contenedores administrados, entornos separados

Status: SUPERSEDED by ADR 0022 for Platform CF-0.

API y worker como imágenes Node 24 multistage/no-root; PostgreSQL administrado/Redis administrado/R2; Cloudflare DNS/CDN/WAF delante de ingress HTTPS. Mantener marketing hosting actual. No seleccionar una cuenta, región o proveedor compute sin datos del propietario. Terraform foundation R2 privado; contrato de recursos adicionales en infra/terraform/README.md.

Staging y producción con state, red, DB, Redis, bucket y secretos distintos. Config valida TLS remoto y nombres por entorno. Migrador separado del runtime. Target backups/PITR + restore probado. No apply ni despliegue producción realizado. Docker build y Terraform validate en CI; aprobación y credenciales externas para provisión real.
