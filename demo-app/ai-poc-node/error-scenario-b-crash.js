/**
 * POC — Scénario B : Erreur NON GÉRÉE (crash sans filet de sécurité).
 * Script séparé (processus Node.js indépendant) - voir error-scenario-a-handled.js
 * pour l'explication du pourquoi ces 2 scénarios sont dans des fichiers distincts.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node error-scenario-b-crash.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel, trace } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation, START } = require("@langchain/langgraph");
const { HumanMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const provider = new NodeTracerProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: "aizo-poc-error-unhandled" }),
  });
  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

function simulateSubagentFailure() {
  throw new Error("Sub-agent unavailable: connection timeout after 5000ms (simulated failure)");
}

const GraphState = Annotation.Root({
  messages: Annotation({ reducer: (existing, update) => existing.concat(update), default: () => [] }),
});

function supervisorRouter(state) {
  console.log("[Supervisor] Délégation vers le Sub-agent");
  return {};
}

async function subagentWithUnhandledCrash(state) {
  console.log("[Sub-agent] Tentative d'exécution...");
  // Aucun try/catch - l'exception remonte telle quelle et fait planter le graphe
  simulateSubagentFailure();
  return {};
}

function buildGraph() {
  return new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouter)
    .addNode("subagent_crash", subagentWithUnhandledCrash)
    .addEdge(START, "supervisor_router")
    .addEdge("supervisor_router", "subagent_crash")
    .addEdge("subagent_crash", END)
    .compile();
}

async function main() {
  console.log("=== SCÉNARIO B — Erreur NON GÉRÉE (crash) ===\n");

  const provider = setupTracing();
  const app = buildGraph();
  const tracer = trace.getTracer("error-test-runner");

  let capturedTraceId;
  try {
    await tracer.startActiveSpan("main-invocation", async (span) => {
      capturedTraceId = span.spanContext().traceId;
      console.log(`[Trace ID] ${capturedTraceId}`);

      await app.invoke({
        messages: [new HumanMessage("Cherche des infos sur le tracing distribué")],
      });

      span.end();
    });
  } catch (err) {
    console.log(`\n[Crash capturé au niveau du programme] ${err.message}`);
  }

  console.log(`\nCherche dans Tempo : ${capturedTraceId}`);
  console.log("(service.name = aizo-poc-error-unhandled)");
  console.log("Vérifie : est-ce que la trace PARTIELLE (jusqu'au point de crash) arrive");
  console.log("quand même dans Tempo, avec le span 'subagent_crash' visible en erreur ?");

  await provider.forceFlush();
  await new Promise((r) => setTimeout(r, 2000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
