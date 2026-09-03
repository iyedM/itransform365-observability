/**
 * POC — Gestion des erreurs entre agents.
 * Teste 2 scénarios :
 *   A) Erreur GÉRÉE : le Sub-agent échoue, le Supervisor le détecte et
 *      répond avec un message de repli (fallback).
 *   B) Erreur NON GÉRÉE (crash) : le Sub-agent lève une exception non
 *      catchée - on vérifie si la trace partielle arrive quand même
 *      jusqu'à Tempo, avec l'erreur visible sur le span concerné.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node agent-error-handling.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation, START } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

function setupTracing(serviceName) {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";

  const provider = new NodeTracerProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: serviceName }),
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

// --- Simule un échec de sous-agent : timeout ou service indisponible ---
function simulateSubagentFailure() {
  throw new Error("Sub-agent unavailable: connection timeout after 5000ms (simulated failure)");
}

// =========================================================================
// SCÉNARIO A — Erreur GÉRÉE avec fallback
// =========================================================================

const GraphStateA = Annotation.Root({
  messages: Annotation({ reducer: (existing, update) => existing.concat(update), default: () => [] }),
  subagentFailed: Annotation({ reducer: (_, u) => u, default: () => false }),
});

function supervisorRouterA(state) {
  console.log("[Scénario A - Supervisor] Délégation vers le Sub-agent");
  return {};
}

async function subagentWithFailureHandled(state) {
  try {
    console.log("[Scénario A - Sub-agent] Tentative d'exécution...");
    simulateSubagentFailure();
  } catch (err) {
    console.log(`[Scénario A - Sub-agent] Échec détecté : ${err.message}`);
    // On enregistre explicitement l'erreur sur le span actif, mais on
    // NE relance PAS l'exception - le Supervisor va gérer un fallback
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.recordException(err);
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    }
    return { subagentFailed: true };
  }
}

async function supervisorFallbackA(state) {
  if (state.subagentFailed) {
    console.log("[Scénario A - Supervisor] Sub-agent en échec - réponse de repli");
    return {
      messages: [{ content: "Désolé, le service de recherche est temporairement indisponible. Veuillez réessayer plus tard." }],
    };
  }
  return { messages: [{ content: "Réponse normale (pas d'échec détecté)." }] };
}

function buildGraphA() {
  return new StateGraph(GraphStateA)
    .addNode("supervisor_router", supervisorRouterA)
    .addNode("subagent", subagentWithFailureHandled)
    .addNode("supervisor_fallback", supervisorFallbackA)
    .addEdge(START, "supervisor_router")
    .addEdge("supervisor_router", "subagent")
    .addEdge("subagent", "supervisor_fallback")
    .addEdge("supervisor_fallback", END)
    .compile();
}

// =========================================================================
// SCÉNARIO B — Erreur NON GÉRÉE (crash sans filet de sécurité)
// =========================================================================

const GraphStateB = Annotation.Root({
  messages: Annotation({ reducer: (existing, update) => existing.concat(update), default: () => [] }),
});

function supervisorRouterB(state) {
  console.log("[Scénario B - Supervisor] Délégation vers le Sub-agent");
  return {};
}

async function subagentWithUnhandledCrash(state) {
  console.log("[Scénario B - Sub-agent] Tentative d'exécution...");
  // Aucun try/catch ici - l'exception remonte telle quelle et fait planter le graphe
  simulateSubagentFailure();
  return {};
}

function buildGraphB() {
  return new StateGraph(GraphStateB)
    .addNode("supervisor_router", supervisorRouterB)
    .addNode("subagent_crash", subagentWithUnhandledCrash)
    .addEdge(START, "supervisor_router")
    .addEdge("supervisor_router", "subagent_crash")
    .addEdge("subagent_crash", END)
    .compile();
}

// =========================================================================

async function runScenarioA() {
  console.log("\n========================================");
  console.log("SCÉNARIO A — Erreur GÉRÉE (fallback)");
  console.log("========================================\n");

  const provider = setupTracing("aizo-poc-error-handled");
  const app = buildGraphA();
  const tracer = trace.getTracer("error-test-runner");

  let capturedTraceId;
  await tracer.startActiveSpan("main-invocation", async (span) => {
    capturedTraceId = span.spanContext().traceId;
    console.log(`[Trace ID] ${capturedTraceId}`);

    const result = await app.invoke({
      messages: [new HumanMessage("Cherche des infos sur le tracing distribué")],
      subagentFailed: false,
    });

    console.log("\n--- Résultat final ---");
    console.log(result.messages[result.messages.length - 1].content);
    span.end();
  });

  console.log(`\nCherche dans Tempo (service: aizo-poc-error-handled) : ${capturedTraceId}`);
  console.log("Vérifie : le span 'subagent' doit apparaître en ERREUR (rouge),");
  console.log("mais la trace globale doit être COMPLÈTE (le Supervisor a quand même répondu).");

  await provider.forceFlush();
  await new Promise((r) => setTimeout(r, 2000));
}

async function runScenarioB() {
  console.log("\n========================================");
  console.log("SCÉNARIO B — Erreur NON GÉRÉE (crash)");
  console.log("========================================\n");

  const provider = setupTracing("aizo-poc-error-unhandled");
  const app = buildGraphB();
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

  console.log(`\nCherche dans Tempo (service: aizo-poc-error-unhandled) : ${capturedTraceId}`);
  console.log("Vérifie : est-ce que la trace PARTIELLE (jusqu'au point de crash) arrive");
  console.log("quand même dans Tempo, avec le span 'subagent_crash' visible en erreur ?");

  await provider.forceFlush();
  await new Promise((r) => setTimeout(r, 2000));
}

async function main() {
  await runScenarioA();
  await runScenarioB();
  process.exit(0);
}

main().catch((err) => {
  console.error("Erreur inattendue dans le script lui-même:", err);
  process.exit(1);
});
