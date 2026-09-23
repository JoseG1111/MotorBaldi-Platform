# ADR 0010 — Proxy, mutaciones y degradación HTTP

Status: SUPERSEDED by ADR 0014 for Worker runtime behavior.

`TRUSTED_PROXIES` declara IP/CIDR de proxies operados y verificados; `none` declara conexión directa. Staging/production deben suministrarlo explícitamente. No se aceptan /0 ni boolean true. El firewall debe impedir rutas que evadan el proxy previsto. Fastify deriva client IP de la cadena confiable, nunca del header arbitrario.

Cada ruta mutante declara `mutationPolicy`. Sin declaración: DENY. Browser usa origin exacto permitido con cookies host-only HttpOnly/SameSite; rutas alternativas deben proporcionar autenticador explícito y no aceptan cookies. Webhooks futuros implementarán validación criptográfica sobre raw bytes en ese autenticador; mobile/machine verificará credenciales propias. La infraestructura no declara todavía webhooks públicos.

Rate limit: contador Redis atómico con expiración. Auth falla 503 si Redis no está disponible; API general degrada a límite por proceso 60/min/IP, memoria acotada y 503 cuando alcanza capacidad. Es una protección de emergencia adicional al borde, no una cuota global distribuida. Health omite rate limiting y DB determina readiness; Redis/storage indisponibles aparecen `degraded` sin retirar réplicas capaces de operar sin ellos. Los comandos dependientes deben fallar explícitamente.

DTOs utilizan `validateRequest` y objetos Zod strict para body/params/query. Normalización declarada por transformaciones del contrato; errores solamente campos del schema y códigos seguros. Logs registran método, plantilla de ruta, estado, duración y requestId; nunca URL/query/body. Excepciones conservan clase segura y basename/línea de stack, no mensajes ni paths completos.
