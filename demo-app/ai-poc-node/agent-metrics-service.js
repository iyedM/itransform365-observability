/**
 * Service persistant (pas un script ponctuel) — traite des requêtes en
 * continu, pour que les métriques Prometheus s'accumulent correctement
 * dans le temps, comme demo-api en Phase 1. Contrairement au script
 * batch précédent (agent-with-metrics.js), ce process ne meurt jamais
 * entre deux requêtes.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node agent-metrics-service.js
 *
 * Laisse-le tourner, puis génère du trafic dans un autre terminal :
 *   for i in {1..30}; do curl -s http://localhost:4002/invoke -X POST \
 *     -H "Content-Type: application/json" \
 *     -d '{"agent":"research-agent","query":"test"}' ; sleep 1; done
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

const express = require("express");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const SERVICE_NAME = "aizo-agent-metrics-service";

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

const tracerProvider = setupTracing();
const metrics = setupMetrics(SERVICE_NAME);

const app = express();
app.use(express.json());

app.post("/invoke", async (req, res) => {
  const agentName = req.body.agent || "research-agent";
  const query = req.body.query || "Question de test";
  // 10% d'échec simulé aléatoire, pour avoir un vrai taux d'erreur à observer
  const simulateFailure = Math.random() < 0.1;

  const startTime = Date.now();

  try {
    if (simulateFailure) {
      throw new Error("Simulated random failure");
    }

    const llm = getLlm();
    const response = await llm.invoke([
      new SystemMessage("Réponds en une phrase très courte."),
      new HumanMessage(query),
    ]);

    const durationMs = Date.now() - startTime;
    const usage = response.response_metadata?.tokenUsage || {};

    recordAgentCall(metrics, agentName, durationMs, "success", {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
    });

    console.log(`[${agentName}] Succès en ${durationMs}ms`);
    res.json({ status: "success", content: response.content, duration_ms: durationMs });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordAgentCall(metrics, agentName, durationMs, "error");
    console.log(`[${agentName}] Échec en ${durationMs}ms : ${err.message}`);
    res.status(500).json({ status: "error", message: err.message, duration_ms: durationMs });
  }
});

const PORT = 4002;
app.listen(PORT, () => {
  console.log(`[Service] Démarré sur le port ${PORT} - reste actif en continu`);
  console.log(`[Service] Génère du trafic : curl -X POST http://localhost:${PORT}/invoke -H "Content-Type: application/json" -d '{"agent":"research-agent","query":"test"}'`);
});

process.on("SIGTERM", async () => {
  await tracerProvider.forceFlush();
  process.exit(0);
});
