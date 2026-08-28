/**
 * POC — Chaîne de 3 agents (Supervisor -> Research Sub-agent -> Validation Sub-agent -> Supervisor).
 * Variante plus complexe du test agent-à-agent : vérifie que le tracing reste
 * UNE SEULE TRACE CONTINUE même avec plusieurs sauts successifs entre agents,
 * pas juste un aller-retour simple.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node three-agent-chain.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage, AIMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR); // WARN/ERROR seulement cette fois - moins verbeux

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-three-agent-chain";

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
      responses: [`[${agentName}] Réponse simulée pour tester la chaîne de tracing.`],
    });
  }
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

// --- État partagé entre les 3 agents ---
const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  researchResult: Annotation({ reducer: (_, u) => u, default: () => null }),
  validationResult: Annotation({ reducer: (_, u) => u, default: () => null }),
});

// --- Agent 1 : Supervisor (routeur, ne fait qu'orchestrer) ---
function supervisorRouterNode(state) {
  console.log("[1. Supervisor] Réception de la requête, délégation vers le Research Agent");
  return {};
}

// --- Agent 2 : Research Sub-agent (premier maillon de la chaîne) ---
async function researchAgentNode(state) {
  console.log("[2. Research Agent] Recherche d'informations en cours...");
  const llm = getLlm("ResearchAgent");
  const userQuery = state.messages[0].content;

  const response = await llm.invoke([
    new SystemMessage(
      "Tu es un agent de recherche. Trouve des informations factuelles et " +
      "concises sur le sujet demandé, en 2 phrases maximum."
    ),
    new HumanMessage(userQuery),
  ]);

  return { researchResult: response.content };
}

// --- Agent 3 : Validation Sub-agent (deuxième maillon, reçoit le résultat de l'Agent 2) ---
async function validationAgentNode(state) {
  console.log("[3. Validation Agent] Vérification et enrichissement du résultat de recherche...");
  const llm = getLlm("ValidationAgent");

  const response = await llm.invoke([
    new SystemMessage(
      "Tu es un agent de validation. Vérifie la cohérence de l'information " +
      "fournie et ajoute une précision technique complémentaire, en 1-2 phrases."
    ),
    new HumanMessage(`Information à valider: ${state.researchResult}`),
  ]);

  return { validationResult: response.content };
}

// --- Retour à l'Agent 1 : Supervisor (synthèse finale) ---
async function supervisorSynthesizeNode(state) {
  console.log("[4. Supervisor] Synthèse finale à partir des résultats des 2 sous-agents");
  const llm = getLlm("Supervisor");

  const response = await llm.invoke([
    new SystemMessage(
      "Tu es le superviseur. Combine la recherche et la validation ci-dessous " +
      "en une réponse finale claire pour l'utilisateur."
    ),
    new HumanMessage(
      `Recherche: ${state.researchResult}\nValidation: ${state.validationResult}`
    ),
  ]);

  return { messages: [response] };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouterNode)
    .addNode("research_agent", researchAgentNode)
    .addNode("validation_agent", validationAgentNode)
    .addNode("supervisor_synthesize", supervisorSynthesizeNode)
    .setEntryPoint("supervisor_router")
    .addEdge("supervisor_router", "research_agent")
    .addEdge("research_agent", "validation_agent")
    .addEdge("validation_agent", "supervisor_synthesize")
    .addEdge("supervisor_synthesize", END);

  return graph.compile();
}

async function main() {
  const tracerProvider = setupTracing();
  const app = buildGraph();

  console.log("=== Test chaîne de 3 agents : Supervisor -> Research -> Validation -> Supervisor ===\n");

  const result = await app.invoke({
    messages: [new HumanMessage("Explique ce qu'est le tracing distribué en observabilité")],
    researchResult: null,
    validationResult: null,
  });

  console.log("\n--- Réponse finale (après passage dans les 3 agents) ---");
  console.log(result.messages[result.messages.length - 1].content);

  console.log("\n=== Vérification à faire dans Grafana ===");
  console.log("Explore -> Tempo -> service.name = " + (process.env.OTEL_SERVICE_NAME || "aizo-poc-three-agent-chain"));
  console.log("Question clé : les 4 étapes (router, research, validation, synthesize)");
  console.log("apparaissent-elles TOUTES dans UNE SEULE trace, même avec 2 sauts d'agent à agent ?");

  await tracerProvider.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
