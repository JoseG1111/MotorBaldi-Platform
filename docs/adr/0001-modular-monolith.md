# ADR 0001 — Monolito modular y transición pnpm

Aceptado para Fase 0. Conservar marketing/PHP en raíz evita cambiar rutas y producción. apps/marketing documenta el wrapper lógico; portal/admin se reservan hasta disponer de identidad. API NestJS/Fastify y worker Node separados; paquetes por responsabilidad. Build TypeScript raíz inicialmente; imports relativos explícitos, ninguna dependencia de Core hacia PHP/HubSpot. pnpm único lockfile, Node 24. CI staging del marketing solo después de checks; no despliegue Core automático sin infraestructura seleccionada.

Consecuencia: no todos los directorios son aplicaciones activas. Una fase posterior podrá mover marketing mediante ADR, comparación de dist, E2E y rollout reversible. No microservicios.
