# Limitations connues — à reprendre plus tard si besoin

## Exemplars (lien metrics → traces)

**Statut** : Non fonctionnel malgré une configuration complète et correcte.

**Ce qui a été fait** :
- `exemplar-storage` activé côté Prometheus (`enableFeatures: [exemplar-storage]`)
- `enable_open_metrics: true` activé sur l'exporter Prometheus du Collector
- Format OpenMetrics confirmé actif (vérifié via `curl -H "Accept: application/openmetrics-text"`)

**Cause racine identifiée** : l'auto-instrumentation Python d'OpenTelemetry
(`opentelemetry-instrumentation-flask` v0.48b0) ne génère pas d'exemplars
automatiquement sur les métriques HTTP qu'elle produit. C'est une limite connue
de l'écosystème OpenTelemetry côté Python, moins mature que les SDK Go/Java
sur ce point précis.

**Solutions possibles pour plus tard** :
1. Instrumentation manuelle des métriques de latence (remplacer les métriques
   auto-générées par des métriques créées à la main, avec le trace_id courant
   attaché explicitement en exemplar)
2. Surveiller les futures versions du SDK Python OpenTelemetry — cette
   fonctionnalité est activement développée dans l'écosystème

**Contournement actuel** : le pivot metric→trace se fait indirectement en
filtrant Tempo par service_name + fenêtre de temps correspondant au pic
observé dans Prometheus. Le pivot log→trace, lui, fonctionne parfaitement
(trace_id injecté dans les logs JSON structurés, voir demo-api/app.py).
