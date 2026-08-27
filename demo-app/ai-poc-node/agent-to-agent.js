/**
 * POC — Communication agent-à-agent (Supervisor -> Sub-agent) instrumentée avec OpenTelemetry.
 * Teste si le tracing reste UNE SEULE trace continue quand un agent délègue à un autre,
 * ou si ça se casse en traces séparées.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node agent-to-agent.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

// Active les logs internes d'OpenTelemetry - indispensable pour voir les
// vraies erreurs d'export (auth, connexion, sérialisation...), qui restent
// sinon complètement silencieuses avec le SDK Node.js.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

const { StateGraph, END, Annotation } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage, AIMessage } = require("@langchain/core/messages");

// --- Instrumentation OpenTelemetry ---
function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-agent-to-agent";

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
  });

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

const MOCK_MODE = !process.env.LITELLM_KEY;

function getLlm(systemRole) {
  if (MOCK_MODE) {
    const { FakeListChatModel } = require("@langchain/core/utils/testing");
    return new FakeListChatModel({
      responses: [`[${systemRole}] Réponse simulée pour tester le pipeline de tracing.`],
    });
  }
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

// --- État partagé entre Supervisor et Sub-agent ---
const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  taskType: Annotation({
    reducer: (_, update) => update,
    default: () => "",
  }),
  subagentResult: Annotation({
    reducer: (_, update) => update,
    default: () => null,
  }),
});

// --- Nœud Supervisor : décide de déléguer ou répondre directement ---
function supervisorRouterNode(state) {
  const lastMessage = state.messages[state.messages.length - 1].content;
  const taskType = /cherche|trouve|recherche/i.test(lastMessage) ? "retrieval" : "chat";
  console.log(`[Supervisor] Requête classée: ${taskType}`);
  return { taskType };
}

function shouldDelegate(state) {
  return state.taskType === "retrieval" ? "delegate_to_subagent" : "supervisor_direct_answer";
}

// --- Sub-agent : un agent spécialisé, distinct, avec son propre rôle/prompt ---
// C'est ICI que se joue le vrai test : cet appel LLM doit apparaître comme un
// span imbriqué DANS LA MÊME TRACE que le Supervisor, pas comme une trace séparée.
async function subagentNode(state) {
  console.log("[Sub-agent] Invoqué par le Supervisor pour une tâche de recherche spécialisée");

  const llm = getLlm("ResearchSubAgent");
  const userQuery = state.messages[0].content;

  const subagentMessages = [
    new SystemMessage(
      "Tu es un sous-agent spécialisé dans la recherche d'informations techniques. " +
      "Réponds de façon concise et factuelle, en 2-3 phrases maximum."
    ),
    new HumanMessage(userQuery),
  ];

  const response = await llm.invoke(subagentMessages);

  return {
    subagentResult: response.content,
    messages: [new AIMessage(`[Résultat du sous-agent] ${response.content}`)],
  };
}

// --- Supervisor : synthétise la réponse finale à partir du résultat du sous-agent ---
async function supervisorSynthesizeNode(state) {
  console.log("[Supervisor] Synthèse de la réponse finale à partir du résultat du sous-agent");

  const llm = getLlm("Supervisor");
  const synthesisMessages = [
    new SystemMessage(
      "Tu es le superviseur. Un sous-agent spécialisé a fourni les informations suivantes. " +
      "Reformule-les en une réponse claire et complète pour l'utilisateur."
    ),
    new HumanMessage(`Résultat du sous-agent: ${state.subagentResult}`),
  ];

  const response = await llm.invoke(synthesisMessages);
  return { messages: [response] };
}

// --- Supervisor : répond directement sans déléguer (cas "chat" simple) ---
async function supervisorDirectAnswerNode(state) {
  console.log("[Supervisor] Réponse directe, pas de délégation nécessaire");
  const llm = getLlm("Supervisor");
  const response = await llm.invoke(state.messages);
  return { messages: [response] };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouterNode)
    .addNode("delegate_to_subagent", subagentNode)
    .addNode("supervisor_direct_answer", supervisorDirectAnswerNode)
    .addNode("supervisor_synthesize", supervisorSynthesizeNode)
    .setEntryPoint("supervisor_router")
    .addConditionalEdges("supervisor_router", shouldDelegate, {
      delegate_to_subagent: "delegate_to_subagent",
      supervisor_direct_answer: "supervisor_direct_answer",
    })
    .addEdge("delegate_to_subagent", "supervisor_synthesize")
    .addEdge("supervisor_synthesize", END)
    .addEdge("supervisor_direct_answer", END);

  return graph.compile();
}

async function main() {
  const tracerProvider = setupTracing();
  const app = buildGraph();

  console.log("=== Test agent-à-agent : Supervisor -> Sub-agent ===\n");

  const result = await app.invoke({
    messages: [new HumanMessage("Cherche des informations sur l'observabilité Kubernetes")],
    taskType: "",
    subagentResult: null,
  });

  console.log("\n--- Réponse finale (après délégation au sous-agent) ---");
  console.log(result.messages[result.messages.length - 1].content);

  console.log("\n=== Vérification à faire dans Grafana ===");
  console.log("Explore -> Tempo -> service.name = " + (process.env.OTEL_SERVICE_NAME || "aizo-poc-agent-to-agent"));
  console.log("Question clé : est-ce que 'delegate_to_subagent' et 'supervisor_synthesize'");
  console.log("apparaissent comme DEUX SPANS DANS LA MÊME TRACE, ou comme deux traces séparées ?");
  console.log("Si c'est une seule trace continue -> le tracing agent-à-agent fonctionne correctement.");

  // Force l'envoi de tous les spans en attente avant de quitter le process -
  // le BatchSpanProcessor n'exporte pas immédiatement, il faut le forcer.
  console.log("\n[Flush] Envoi forcé des spans en attente vers le Collector...");
  await tracerProvider.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log("[Flush] Terminé.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
