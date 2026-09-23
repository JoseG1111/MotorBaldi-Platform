# ADR 0007 — RBAC + ABAC deny por defecto

packages/authz es el único motor de decisiones: actor activo, permiso, política registrada y contexto/recurso. Sin política: DENY; excepción en política: DENY. Actor se construye servidor, jamás desde body/workspace UI. Fase 0 no registra permisos de negocio. Principal protegido requiere sesión válida y email verificado; consulta solo identidad propia.

Fase 1 añadirá resolución de membresías multirrol/sedes desde DB en cada acción y middleware de autorización; registro de política no debe sustituir verificación de pertenencia. Tests negativos comprueban anónimo, actor inactivo, acción desconocida y organización distinta. No superadmin catch-all ni atributo único users.role.
