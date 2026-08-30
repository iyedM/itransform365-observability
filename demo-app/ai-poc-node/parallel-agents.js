/**
 * POC — Appels d'agents en PARALLÈLE (fan-out / fan-in).
 * Le Supervisor délègue SIMULTANÉMENT à deux sous-agents indépendants,
 * puis attend que LES DEUX aient terminé avant de synthétiser.
 *
 * Teste si le tracing reste cohérent (une seule trace) quand des agents
 * s'exécutent en parallèle plutôt que séquentiellement.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node parallel-agents.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation, START } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-parallel-agents";

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

const MOCK_MODE = !process.env.LITELLM_KEY;

function getLlm(agentName) {
  if (MOCK_MODE) {
    const { FakeListChatModel } = require("@langchain/core/utils/testing");
    return new FakeListChatModel({
      responses: [`[${agentName}] Réponse simulée (test parallèle).`],
    });
  }
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

// --- État partagé - deux résultats distincts remplis en parallèle ---
const GraphState = Annotation.Root({
  query: Annotation({ reducer: (_, u) => u, default: () => "" }),
  researchResult: Annotation({ reducer: (_, u) => u, default: () => null }),
  translationResult: Annotation({ reducer: (_, u) => u, default: () => null }),
  finalAnswer: Annotation({ reducer: (_, u) => u, default: () => null }),
});

function supervisorRouterNode(state) {
  console.log("[Supervisor] Délégation SIMULTANÉE vers Research Agent + Translation Agent");
  return {};
}

// --- Agent A : recherche factuelle (branche parallèle 1) ---
async function researchAgentNode(state) {
  const startedAt = Date.now();
  console.log("[Research Agent] Démarrage...");
  const llm = getLlm("ResearchAgent");
  const response = await llm.invoke([
    new SystemMessage("Réponds en 2 phrases factuelles maximum, en français."),
    new HumanMessage(state.query),
  ]);
  console.log(`[Research Agent] Terminé en ${Date.now() - startedAt}ms`);
  return { researchResult: response.content };
}

// --- Agent B : traduction/reformulation (branche parallèle 2, indépendante de A) ---
async function translationAgentNode(state) {
  const startedAt = Date.now();
  console.log("[Translation Agent] Démarrage...");
  const llm = getLlm("TranslationAgent");
  const response = await llm.invoke([
    new SystemMessage("Traduis cette question en anglais, rien d'autre."),
    new HumanMessage(state.query),
  ]);
  console.log(`[Translation Agent] Terminé en ${Date.now() - startedAt}ms`);
  return { translationResult: response.content };
}

// --- Supervisor : ne s'exécute qu'après que LES DEUX branches sont terminées ---
async function supervisorJoinNode(state) {
  console.log("[Supervisor] Les deux agents ont terminé - synthèse en cours");
  const llm = getLlm("Supervisor");
  const response = await llm.invoke([
    new SystemMessage("Combine ces deux résultats en une réponse claire pour l'utilisateur."),
    new HumanMessage(
      `Résultat recherche: ${state.researchResult}\n` +
      `Traduction de la question: ${state.translationResult}`
    ),
  ]);
  return { finalAnswer: response.content };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouterNode)
    .addNode("research_agent", researchAgentNode)
    .addNode("translation_agent", translationAgentNode)
    .addNode("supervisor_join", supervisorJoinNode)
    .addEdge(START, "supervisor_router")
    // Fan-out : le router envoie vers LES DEUX agents en même temps
    .addEdge("supervisor_router", "research_agent")
    .addEdge("supervisor_router", "translation_agent")
    // Fan-in : supervisor_join attend que LES DEUX branches soient terminées
    // (comportement natif de LangGraph : un nœud avec plusieurs prédécesseurs
    // n'est déclenché qu'une fois que tous ses prédécesseurs du même "superstep"
    // ont fini - pas besoin de logique de synchronisation manuelle)
    .addEdge("research_agent", "supervisor_join")
    .addEdge("translation_agent", "supervisor_join")
    .addEdge("supervisor_join", END);

  return graph.compile();
}

const { trace } = require("@opentelemetry/api");

async function main() {
  const tracerProvider = setupTracing();
  const app = buildGraph();
  const tracer = trace.getTracer("aizo-poc-parallel-agents-runner");

  console.log("=== Test agents en PARALLÈLE : Research + Translation simultanés ===\n");

  let result;
  let capturedTraceId;

  await tracer.startActiveSpan("main-invocation", async (span) => {
    capturedTraceId = span.spanContext().traceId;
    console.log(`[Trace ID] ${capturedTraceId}\n`);

    const globalStart = Date.now();
    result = await app.invoke({
      query: "Qu'est-ce que le tracing distribué en observabilité ?",
    });
    const totalTime = Date.now() - globalStart;

    console.log(`\n--- Réponse finale (temps total: ${totalTime}ms) ---`);
    console.log(result.finalAnswer);

    span.end();
  });

  console.log("\n=== Vérification à faire dans Grafana ===");
  console.log(`Cherche directement par Trace ID : ${capturedTraceId}`);
  console.log("(TraceQL -> tape juste l'ID, sans accolades)");
  console.log("Question clé 1 : research_agent et translation_agent apparaissent-ils");
  console.log("comme DEUX SPANS QUI SE CHEVAUCHENT DANS LE TEMPS (parallèles), ou l'un après l'autre ?");
  console.log("Question clé 2 : le temps total est-il proche du PLUS LONG des deux appels");
  console.log("(vrai parallélisme) ou de la SOMME des deux (exécution séquentielle déguisée) ?");

  await tracerProvider.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
