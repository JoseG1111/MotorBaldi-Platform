/** Owner-approved customer policy; subscription benefits never confer staff permissions. */
export const CUSTOMER_PLANS = {
  free: {
    vehicleLimit: 1,
    manualMaintenanceLimit: 5,
    reminderDays: [15],
    personalizedSupport: false,
    assistedRequestLimit: 0,
  },
  premium: {
    vehicleLimit: 3,
    manualMaintenanceLimit: null,
    assistedRequestLimit: null,
    reminderDays: [30, 15, 7, 1],
    personalizedSupport: true,
  },
  prices: {
    MONTHLY: {
      amountMinor: 2990000,
      currency: "COP",
      planCode: "ACOMPANAMIENTO_MONTHLY",
    },
    ANNUAL: {
      amountMinor: 28800000,
      currency: "COP",
      planCode: "ACOMPANAMIENTO_ANNUAL",
    },
  },
} as const;
export const CUSTOMER_PLAN_FEATURES = [
  {
    category: "Cuenta y vehículos",
    label: "Cuenta permanente, gestión personal y privacidad",
    free: "Incluido",
    premium: "Incluido",
  },
  {
    category: "Cuenta y vehículos",
    label: "Vehículos registrados activos",
    free: "1",
    premium: "Hasta 3",
  },
  {
    category: "Cuenta y vehículos",
    label: "Perfil, matrícula e información básica; kilometraje manual",
    free: "Incluido",
    premium: "Incluido",
  },
  {
    category: "SOAT y RTM",
    label: "Registro manual de vencimientos y estado en el Portal",
    free: "Incluido",
    premium: "Seguimiento avanzado",
  },
  {
    category: "SOAT y RTM",
    label: "Canales autorizados de compra de SOAT y búsqueda de CDA",
    free: "Autoservicio, cuando estén disponibles",
    premium: "Autoservicio y orientación personalizada",
  },
  {
    category: "SOAT y RTM",
    label: "Orientación para renovar SOAT",
    free: "No incluido",
    premium: "Asistida, por canales autorizados",
  },
  {
    category: "SOAT y RTM",
    label: "Coordinación de citas de RTM",
    free: "No incluido",
    premium: "Con CDA autorizados disponibles",
  },
  {
    category: "Alertas y notificaciones",
    label: "Alertas de vencimiento dentro del Portal",
    free: "Básicas",
    premium: "Avanzadas",
  },
  {
    category: "Alertas y notificaciones",
    label: "Recordatorios por correo antes del vencimiento",
    free: "15 días",
    premium: "30, 15, 7 y 1 días",
  },
  {
    category: "Alertas y notificaciones",
    label: "Recordatorios por WhatsApp",
    free: "No incluido",
    premium: "Con autorización e integración configurada",
  },
  {
    category: "Alertas y notificaciones",
    label: "Seguimiento personalizado de vencimientos",
    free: "No incluido",
    premium: "Incluido",
  },
  {
    category: "Mantenimiento e historial",
    label:
      "Historial básico y lectura de registros autorizados de talleres e inspecciones",
    free: "Incluido",
    premium: "Incluido",
  },
  {
    category: "Mantenimiento e historial",
    label: "Entradas manuales de mantenimiento",
    free: "Hasta 5",
    premium: "Ilimitadas, con uso razonable",
  },
  {
    category: "Mantenimiento e historial",
    label: "Seguimiento preventivo según la información disponible",
    free: "No incluido",
    premium: "Incluido",
  },
  {
    category: "Mantenimiento e historial",
    label: "Resumen mensual y seguimiento de varios vehículos",
    free: "No incluido",
    premium: "Incluido",
  },
  {
    category: "Talleres y servicios",
    label: "Descubrimiento de talleres y servicios automotores",
    free: "Incluido",
    premium: "Incluido",
  },
  {
    category: "Talleres y servicios",
    label: "Solicitudes de contacto con talleres",
    free: "Autoservicio",
    premium: "Autoservicio y asistencia",
  },
  {
    category: "Talleres y servicios",
    label: "Búsqueda y coordinación humana de servicios",
    free: "No incluido",
    premium: "Incluido",
  },
  {
    category: "Asistencia personal",
    label: "Acceso directo al equipo por WhatsApp",
    free: "No incluido",
    premium: "Canal oficial, cuando esté configurado",
  },
  {
    category: "Asistencia personal",
    label: "Gestiones asistidas elegibles",
    free: "No incluido",
    premium: "Ilimitadas, sin cuota mensual",
  },
  {
    category: "Asistencia personal",
    label: "Orientación automotriz y seguimiento de solicitudes",
    free: "No incluido",
    premium: "Personalizado para vehículos cubiertos",
  },
  {
    category: "Marketplace y aliados",
    label: "Descubrimiento público de repuestos",
    free: "Incluido",
    premium: "Incluido",
  },
  {
    category: "Marketplace y aliados",
    label: "Red de talleres y servicios autorizados",
    free: "Autoservicio",
    premium: "Acceso y acompañamiento",
  },
  {
    category: "Marketplace y aliados",
    label: "Beneficios comerciales de aliados",
    free: "Según condiciones públicas",
    premium: "Solo cuando existan acuerdos reales",
  },
  {
    category: "Soporte de plataforma",
    label: "Centro de ayuda, documentación y herramientas de cuenta",
    free: "Autoservicio",
    premium: "Autoservicio y soporte personalizado",
  },
  {
    category: "Soporte de plataforma",
    label: "Soporte técnico personalizado",
    free: "No incluido",
    premium: "Incluido",
  },
  {
    category: "Soporte de plataforma",
    label: "Privacidad, derechos de datos, seguridad y recuperación de cuenta",
    free: "Disponible",
    premium: "Disponible",
  },
] as const;
export const CUSTOMER_PLAN_FAQ = [
  [
    "¿Cuál es la diferencia entre Gratis y Premium?",
    "Gratis te permite organizar un vehículo. Premium añade hasta tres vehículos, recordatorios avanzados y acompañamiento personalizado con gestiones elegibles ilimitadas.",
  ],
  [
    "¿Puedo usar MotorBaldi gratis?",
    "Sí. La cuenta básica es permanente y cuesta COP $0. Conservas las herramientas de privacidad, seguridad y recuperación de cuenta.",
  ],
  [
    "¿Cuántos vehículos puedo registrar?",
    "Gratis permite un vehículo activo; Premium, hasta tres. El plan de cliente es independiente de tus permisos en talleres u organizaciones.",
  ],
  [
    "¿Qué significa asistencia ilimitada?",
    "Puedes solicitar orientación y coordinación para tus vehículos cubiertos sin cuota mensual. La atención se presta dentro de los horarios publicados; no significa disponibilidad 24/7 ni servicios de terceros gratuitos.",
  ],
  [
    "¿Me ayudan a renovar el SOAT?",
    "Premium incluye orientación hacia canales autorizados. La contratación, el pago y la emisión corresponden al proveedor autorizado; MotorBaldi no emite pólizas.",
  ],
  [
    "¿Me ayudan con la RTM?",
    "El equipo puede orientarte y coordinar con CDA autorizados disponibles. Una cita solo queda confirmada cuando el proveedor la confirma; MotorBaldi no realiza la inspección.",
  ],
  [
    "¿Las reparaciones mecánicas están incluidas?",
    "No. Reparaciones, seguros, inspecciones y otros servicios de terceros se pagan por separado. La orientación no sustituye un diagnóstico profesional ni incluye asistencia de emergencia.",
  ],
  [
    "¿Puedo cancelar Premium?",
    "Sí, desde la administración de tu plan. La cancelación de renovación conserva los beneficios del período ya pagado hasta su vencimiento.",
  ],
  [
    "¿Qué pasa con mis datos al cancelar?",
    "Tu historial se conserva. Al volver a Gratis se aplican sus límites y los vehículos adicionales quedan restringidos; una nueva activación válida de Premium restaura la funcionalidad elegible.",
  ],
  [
    "¿El plan anual tiene beneficios distintos?",
    "No. Mensual y anual incluyen los mismos beneficios. Solo cambian el período de facturación y el precio, mostrados en el selector de planes.",
  ],
  [
    "¿Cómo se procesan los pagos?",
    "Los pagos solo se habilitan mediante el flujo autorizado y verificado. Si no están disponibles, elegir Premium registra una solicitud pendiente: no cobra ni activa beneficios.",
  ],
] as const;

/** Operational display metadata only; authorization uses canonical server entitlement evidence. */
export const CUSTOMER_OPERATIONAL_BENEFITS = [
  {
    code: "support_whatsapp",
    label: "Asistencia humana por WhatsApp",
    readiness: "READY",
  },
  {
    code: "history_enhanced",
    label: "Historial manual y gestión de vehículos",
    readiness: "READY",
  },
  {
    code: "maintenance_reminders",
    label: "Envío externo de recordatorios",
    readiness: "PROVIDER_UNAVAILABLE",
  },
  {
    code: "workshop_assistance",
    label: "Orientación para encontrar talleres",
    readiness: "READY",
  },
  {
    code: "service_assistance",
    label: "Solicitudes de coordinación de servicios",
    readiness: "READY",
  },
  {
    code: "service_followup",
    label: "Seguimiento de solicitudes asistidas",
    readiness: "READY",
  },
  {
    code: "expenses",
    label: "Control de gastos",
    readiness: "NOT_IMPLEMENTED",
  },
  {
    code: "partner_benefits",
    label: "Beneficios comerciales de aliados",
    readiness: "AGREEMENT_REQUIRED",
  },
  {
    code: "monthly_summaries",
    label: "Resumen mensual en el Portal",
    readiness: "READY",
  },
  {
    code: "automatic_monthly_summary",
    label: "Envío automático de resúmenes mensuales",
    readiness: "PROVIDER_UNAVAILABLE",
  },
] as const;

export const CUSTOMER_SUPPORT_PURPOSE_LABELS = {
  TECHNICAL: "Soporte técnico personalizado",
  VEHICLE_ASSISTANCE: "Acompañamiento del vehículo",
  PRIVACY: "Privacidad y derechos sobre datos",
  SECURITY: "Seguridad de la cuenta",
  ACCOUNT: "Acceso y gestión de la cuenta",
  COMPLAINT: "Queja o reclamación",
} as const;

/** Public authoritative directories inspected 2026-10-11; no insurer/CDA partnership or reservation implied. */
export const CUSTOMER_VEHICLE_REFERENCES = [
  {
    label: "Consultar canales SOAT autorizados en Fasecolda",
    url: "https://www.fasecolda.com/ramos/soat/companias-autorizadas/",
  },
  {
    label: "Buscar un CDA en el directorio oficial del RUNT",
    url: "https://www.runt.gov.co/directorio-de-actores",
  },
] as const;
