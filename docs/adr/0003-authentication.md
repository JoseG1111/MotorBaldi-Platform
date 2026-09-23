# ADR 0003 — Better Auth con PostgreSQL

Status: SUPERSEDED by ADR 0014 and ADR 0015 for runtime/database integration. Better Auth remains selected.

Better Auth 1.7.5 seleccionado después de verificar integración Fastify, sesiones PostgreSQL y plugin TOTP. Contraseñas y criptografía delegadas. Tablas `iam.auth_*` son infraestructura del proveedor, no personas MotorBaldi. Principal expone accountId técnico, personId null hasta vínculo verificado en Fase 1. Sin users.role. No cache de sesión que retrase revocación.

Rutas permitidas: email sign-in, sesión, logout/list/revoke y verificación TOTP/backup. Signup, recuperación y provisión se mantienen cerradas hasta tener identidad/consentimientos/transporte email; no onboarding ficticio. MFA-ready mediante schema/plugin, no roles privilegiados ni superadmin bootstrap. Activar enrollment requiere rutas y auditoría correspondientes en Fase 1. Cookies host-only, HttpOnly, SameSite=Lax, Secure remoto; origen exacto obligatorio en comandos. Fallos de login y lifecycle de sesión emiten security events. Debe revisarse schema contra actualización del proveedor.

Fuentes: [instalación](https://better-auth.com/docs/installation), [Fastify](https://better-auth.com/docs/integrations/fastify), [opciones](https://better-auth.com/docs/reference/options). Sin credenciales externas requeridas para pruebas.

Fase 0.1: `AUTH_SECRETS` contiene array JSON `{version,value}` soportado por `BetterAuthOptions.secrets` de 1.7.5. Primer elemento cifra contenido nuevo; anteriores descifran envelopes versionados. Versiones únicas, enteras no negativas, secretos >=32 caracteres; requerido remoto. `AUTH_SECRET` se conserva exclusivamente como fallback legacy para material anterior al envelope. Test usa contexto/crypto oficiales del framework y verifica decrypt anterior tras rotación. No se implementa criptografía propia. Identidad de cuenta futura: ADR 0011. Política origin route-aware: ADR 0010.
