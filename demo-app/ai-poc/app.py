"""
POC — Petit graphe LangGraph instrumenté avec OpenTelemetry.
Simule le pattern Router -> Chatbot -> Tool -> End décrit dans l'architecture AIZO.

Usage :
    export OPENAI_API_KEY="sk-..."   # ou la clé fournie par Haykel
    export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"  # via port-forward vers le Collector
    python app.py
"""

import os
from typing import TypedDict, Annotated
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, AIMessage

# --- Instrumentation OpenTelemetry (via OpenInference) ---
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from openinference.instrumentation.langchain import LangChainInstrumentor

# Mode test : si aucune clé API n'est fournie, on simule le LLM plutôt que
# d'appeler un vrai provider - permet de valider tout le pipeline
# (graphe + tracing) avant d'avoir la clé de Haykel.
MOCK_MODE = not bool(os.environ.get("OPENAI_API_KEY"))


def get_llm():
    """Retourne un vrai ChatOpenAI si une clé est disponible, sinon un LLM simulé."""
    if MOCK_MODE:
        from langchain_core.language_models.fake_chat_models import FakeListChatModel
        print("[MOCK_MODE actif - aucune clé API détectée, réponses simulées]\n")
        return FakeListChatModel(responses=[
            "Voici une réponse simulée pour tester le pipeline de tracing.",
        ])
    else:
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model="gpt-4o-mini", temperature=0)

def setup_tracing():
    """Configure OpenTelemetry pour envoyer les traces vers le Collector."""
    otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    service_name = os.environ.get("OTEL_SERVICE_NAME", "aizo-poc-langgraph")

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    # Instrumente automatiquement tous les appels LangChain/LangGraph -
    # pas besoin d'ajouter des spans manuellement dans le code du graphe
    LangChainInstrumentor().instrument()


# --- Définition du graphe (Router -> Chatbot -> Tool -> End) ---

class GraphState(TypedDict):
    messages: Annotated[list, add_messages]
    task_type: str  # routing / chat / retrieval / vision / memory / cypher... (voir archi AIZO)


@tool
def search_knowledge_base(query: str) -> str:
    """Simule une recherche dans une base de connaissances (équivalent Tavily/Neo4j dans AIZO)."""
    return f"[résultat simulé pour: {query}] Voici une information pertinente trouvée dans la base."


def router_node(state: GraphState) -> GraphState:
    """Classifie la requête - équivalent du Router dans l'archi AIZO."""
    last_message = state["messages"][-1].content
    # Classification simplifiée pour la démo - dans AIZO, ça détermine
    # laquelle des 7 tâches (routing/chat/vision/retrieval/etc.) s'applique
    task_type = "chat"
    if "cherche" in last_message.lower() or "trouve" in last_message.lower():
        task_type = "retrieval"
    return {"messages": state["messages"], "task_type": task_type}


def chatbot_node(state: GraphState) -> GraphState:
    """Génère une réponse ou demande un outil - équivalent du Chatbot dans l'archi AIZO."""
    llm = get_llm()
    if MOCK_MODE:
        # FakeListChatModel ne supporte pas bind_tools() - on simule
        # directement une réponse finale sans appel d'outil pour ce test
        response = llm.invoke(state["messages"])
    else:
        llm_with_tools = llm.bind_tools([search_knowledge_base])
        response = llm_with_tools.invoke(state["messages"])
    return {"messages": [response], "task_type": state["task_type"]}


def should_use_tool(state: GraphState) -> str:
    """Décide si on passe par le tool node ou si on termine directement."""
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tools"
    return END


def tool_node(state: GraphState) -> GraphState:
    """Exécute l'outil demandé et renvoie le résultat au chatbot - équivalent du Tool node AIZO."""
    last_message = state["messages"][-1]
    results = []
    for tool_call in last_message.tool_calls:
        if tool_call["name"] == "search_knowledge_base":
            result = search_knowledge_base.invoke(tool_call["args"])
            results.append({"tool_call_id": tool_call["id"], "content": result})
    from langchain_core.messages import ToolMessage
    tool_messages = [
        ToolMessage(content=r["content"], tool_call_id=r["tool_call_id"])
        for r in results
    ]
    return {"messages": tool_messages, "task_type": state["task_type"]}


def build_graph():
    graph = StateGraph(GraphState)

    graph.add_node("router", router_node)
    graph.add_node("chatbot", chatbot_node)
    graph.add_node("tools", tool_node)

    graph.set_entry_point("router")
    graph.add_edge("router", "chatbot")
    graph.add_conditional_edges("chatbot", should_use_tool, {"tools": "tools", END: END})
    graph.add_edge("tools", "chatbot")

    return graph.compile()


if __name__ == "__main__":
    setup_tracing()
    app = build_graph()

    # Requête de test - chaque exécution produit une trace complète
    # (Router -> Chatbot -> [Tool] -> Chatbot -> End) visible dans Tempo
    result = app.invoke({
        "messages": [HumanMessage(content="Cherche des informations sur l'observabilité Kubernetes")],
        "task_type": "",
    })

    print("\n--- Réponse finale ---")
    print(result["messages"][-1].content)
    print(f"\nTask type détecté: {result['task_type']}")
    print("\nVérifie la trace dans Grafana -> Explore -> Tempo -> service.name = aizo-poc-langgraph")
