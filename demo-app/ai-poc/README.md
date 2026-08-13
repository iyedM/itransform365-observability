# POC — LangGraph + OpenTelemetry

Petit graphe LangGraph (Router → Chatbot ⇄ Tool → End) instrumenté avec
OpenTelemetry via OpenInference, pour valider l'approche d'observabilité
avant de toucher au vrai backend AIZO Adviser.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt --break-system-packages
```

## Variables d'environnement nécessaires

```bash
export OPENAI_API_KEY="sk-..."          # clé fournie par Haykel (ou provider équivalent)
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_SERVICE_NAME="aizo-poc-langgraph"
```

## Prérequis côté cluster

Le Collector OpenTelemetry doit être accessible en local via port-forward
(déjà fait si tu utilises `scripts/start-port-forwards-tmux.sh`) :

```bash
kubectl port-forward -n observability svc/otel-collector-opentelemetry-collector 4317:4317
```

## Lancer le POC

```bash
python app.py
```

## Vérifier le résultat

1. **Traces** : Grafana → Explore → Tempo → Service Name = `aizo-poc-langgraph`
   → tu dois voir une trace avec plusieurs spans imbriqués (Router → Chatbot → Tool → Chatbot)

2. **Structure attendue** : chaque nœud du graphe LangGraph doit apparaître
   comme un span distinct, avec les appels LLM sous-jacents visibles en détail
   (modèle utilisé, tokens, latence) — grâce à l'auto-instrumentation OpenInference.

## Note sur le choix de librairie

**OpenInference** (par Arize) a été choisi plutôt que l'intégration OTel
native de LangSmith, car :
- Vendor-neutral — n'importe quel backend OTel peut recevoir les traces
  (pas besoin du SDK/plateforme LangSmith)
- Auto-instrumentation — aucune modification du code du graphe nécessaire
  pour obtenir les spans, juste `LangChainInstrumentor().instrument()`
- Cohérent avec l'approche déjà utilisée en Phase 1 (auto-instrumentation
  OpenTelemetry pour Flask, même principe ici pour LangChain)

## Prochaine étape une fois validé

- Ajouter un attribut `task_type` explicite sur chaque span (via
  `trace.get_current_span().set_attribute(...)`) pour pouvoir filtrer
  les métriques par type de tâche dans Grafana
- Tester avec un vrai LiteLLM proxy en amont plutôt qu'un appel direct
  à `ChatOpenAI`, pour valider le routing multi-provider
