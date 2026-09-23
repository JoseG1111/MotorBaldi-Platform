const envFile = ".env";
const exampleFile = "config/legacy-hubspot.env.example";

try {
  process.loadEnvFile?.(envFile);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const token = process.env.MOTORBALDI_HUBSPOT_TOKEN;
const pipelineId = process.env.MOTORBALDI_HUBSPOT_PIPELINE || "default";
const stageId = process.env.MOTORBALDI_HUBSPOT_STAGE || "1433840728";
const apiBase = process.env.MOTORBALDI_HUBSPOT_API_BASE || "https://api.hubapi.com";
const apiVersion = "2026-03";

if (!token || token.startsWith("pat-na1-reemplaza")) {
  throw new Error(
    `Falta MOTORBALDI_HUBSPOT_TOKEN. Configúralo en ${envFile} usando ${exampleFile} como referencia, o en el entorno.`,
  );
}

async function getJson(path) {
  const response = await fetch(`${apiBase.replace(/\/$/, "")}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body.message || body.category || "respuesta no válida";
    throw new Error(`HubSpot respondió HTTP ${response.status}: ${reason}`);
  }
  return body;
}

const pipeline = await getJson(
  `/crm/pipelines/${apiVersion}/deals/${encodeURIComponent(pipelineId)}`,
);
const stage = await getJson(
  `/crm/pipelines/${apiVersion}/deals/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(stageId)}`,
);

if (pipeline.id !== pipelineId) {
  throw new Error(`HubSpot devolvió un pipeline inesperado: ${pipeline.id}`);
}
if (stage.id !== stageId || stage.archived === true) {
  throw new Error(`La etapa ${stageId} no está disponible en el pipeline ${pipelineId}.`);
}

console.log(
  `HubSpot OK: token aceptado; pipeline ${pipeline.id}; etapa ${stage.id} (${stage.label}). No se crearon registros.`,
);
