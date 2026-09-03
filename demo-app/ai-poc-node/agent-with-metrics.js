/**
 * POC — Agent instrumenté avec traces ET métriques Prometheus.
 * Valide le module metrics.js : latence, taux d'erreur, tokens,
 * exportés comme vraies métriques agrégeables (pas juste des attributs
 * de trace), avec le label "agent" pour filtrer par agent précis.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node agent-with-metrics.js
 *
 * Lance plusieurs fois de suite pour avoir des données à visualiser
 * dans Prometheus (une seule exécution ne donne qu'un point).
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");
const { setupMetrics, recordAgentCall } = require("./metrics");

const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const SERVICE_NAME = "aizo-agent-with-metrics";

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const provider = new NodeTracerProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME }),
  });
  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

function getLlm() {
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

async function runAgent(agentName, query, metrics, simulateFailure = false) {
  const startTime = Date.now();
  console.log(`[${agentName}] Traitement de la requête...`);

  try {
    if (simulateFailure) {
      throw new Error("Simulated failure for error-rate testing");
    }

    const llm = getLlm();
    const response = await llm.invoke([
      new SystemMessage("Réponds en une phrase concise."),
      new HumanMessage(query),
    ]);

    const durationMs = Date.now() - startTime;
    const usage = response.response_metadata?.tokenUsage || {};

    recordAgentCall(metrics, agentName, durationMs, "success", {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
    });

    console.log(`[${agentName}] Succès en ${durationMs}ms (tokens: ${usage.totalTokens || "N/A"})`);
    return response.content;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordAgentCall(metrics, agentName, durationMs, "error");
    console.log(`[${agentName}] Échec en ${durationMs}ms : ${err.message}`);
    return null;
  }
}

async function main() {
  const tracerProvider = setupTracing();
  const metrics = setupMetrics(SERVICE_NAME);

  console.log("=== Test métriques agent (latence, erreurs, tokens) ===\n");

  // Plusieurs appels pour avoir des données exploitables (percentiles, taux d'erreur)
  await runAgent("research-agent", "Qu'est-ce que Kubernetes ?", metrics, false);
  await runAgent("research-agent", "Explique le tracing distribué", metrics, false);
  await runAgent("research-agent", "Test d'échec simulé", metrics, true); // simule une erreur
  await runAgent("validation-agent", "Vérifie cette information sur Docker", metrics, false);

  console.log("\n=== Vérification à faire dans Prometheus ===");
  console.log("agent_requests_total{service_name=\"" + SERVICE_NAME + "\"}");
  console.log("agent_request_duration_milliseconds_bucket");
  console.log("agent_tokens_consumed_sum");
  console.log("\nNote : laisse ~10s pour que le PeriodicExportingMetricReader envoie les données");

  await tracerProvider.forceFlush();
  await new Promise((r) => setTimeout(r, 10000)); // laisse le temps à l'export des métriques
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
