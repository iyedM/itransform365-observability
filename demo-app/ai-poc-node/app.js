/**
 * POC — Petit graphe LangGraph.js instrumenté avec OpenTelemetry (via OpenInference).
 * Équivalent Node.js du POC Python, pour correspondre à la stack réelle de l'équipe.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node app.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, ToolMessage } = require("@langchain/core/messages");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

// --- Instrumentation OpenTelemetry (via OpenInference) ---
// Contrairement à Python (où l'instrumentation est automatique), LangChain.js
// exige une instrumentation manuelle du module de callbacks - c'est la seule
// vraie différence structurelle par rapport à la version Python.

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-langgraph-js";

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
}

// --- Détection du mode mock (pas de clé -> LLM simulé) ---
const MOCK_MODE = !process.env.LITELLM_KEY;

function getLlm() {
  if (MOCK_MODE) {
    console.log("[MOCK_MODE actif - aucune clé LITELLM_KEY détectée, réponses simulées]\n");
    // FakeListChatModel équivalent en JS
    const { FakeListChatModel } = require("@langchain/core/utils/testing");
    return new FakeListChatModel({
      responses: ["Voici une réponse simulée pour tester le pipeline de tracing."],
    });
  } else {
    return new ChatOpenAI({
      modelName: "qwen3.6-35b",
      openAIApiKey: process.env.LITELLM_KEY,
      configuration: { baseURL: "https://litellm.itransform365.com" },
      temperature: 0,
    });
  }
}

// --- Outil simulé (équivalent Tavily/Neo4j dans AIZO) ---
const searchKnowledgeBase = tool(
  async ({ query }) => {
    return `[résultat simulé pour: ${query}] Voici une information pertinente trouvée dans la base.`;
  },
  {
    name: "search_knowledge_base",
    description: "Simule une recherche dans une base de connaissances (équivalent Tavily/Neo4j dans AIZO).",
    schema: z.object({
      query: z.string(),
    }),
  }
);

// --- État du graphe ---
const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  taskType: Annotation({
    reducer: (_, update) => update,
    default: () => "",
  }),
});

// --- Nœuds du graphe (Router -> Chatbot -> Tool -> End) ---

function routerNode(state) {
  const lastMessage = state.messages[state.messages.length - 1].content;
  let taskType = "chat";
  if (/cherche|trouve/i.test(lastMessage)) {
    taskType = "retrieval";
  }
  return { taskType };
}

async function chatbotNode(state) {
  const llm = getLlm();
  if (MOCK_MODE) {
    const response = await llm.invoke(state.messages);
    return { messages: [response] };
  } else {
    const llmWithTools = llm.bindTools([searchKnowledgeBase]);
    const response = await llmWithTools.invoke(state.messages);
    return { messages: [response] };
  }
}

function shouldUseTool(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
    return "tools";
  }
  return END;
}

async function toolNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolMessages = [];
  for (const toolCall of lastMessage.tool_calls) {
    if (toolCall.name === "search_knowledge_base") {
      const result = await searchKnowledgeBase.invoke(toolCall.args);
      toolMessages.push(new ToolMessage({ content: result, tool_call_id: toolCall.id }));
    }
  }
  return { messages: toolMessages };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("router", routerNode)
    .addNode("chatbot", chatbotNode)
    .addNode("tools", toolNode)
    .setEntryPoint("router")
    .addEdge("router", "chatbot")
    .addConditionalEdges("chatbot", shouldUseTool, { tools: "tools", [END]: END })
    .addEdge("tools", "chatbot");

  return graph.compile();
}

async function main() {
  setupTracing();
  const app = buildGraph();

  const result = await app.invoke({
    messages: [new HumanMessage("Cherche des informations sur l'observabilité Kubernetes")],
    taskType: "",
  });

  console.log("\n--- Réponse finale ---");
  console.log(result.messages[result.messages.length - 1].content);
  console.log(`\nTask type détecté: ${result.taskType}`);
  console.log("\nVérifie la trace dans Grafana -> Explore -> Tempo -> service.name = aizo-poc-langgraph-js");

  // Laisse le temps au BatchSpanProcessor d'exporter avant de quitter
  await new Promise((resolve) => setTimeout(resolve, 2000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
