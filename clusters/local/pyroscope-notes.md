# Pyroscope — installation

Installé avec les valeurs par défaut du chart (pas de values.yaml custom) :

    helm install pyroscope grafana/pyroscope -n observability

Déploie deux composants :
- pyroscope-0 (StatefulSet) — stockage des profils
- pyroscope-alloy-0 (StatefulSet) — scrape les endpoints pprof via annotations sur les Pods
  (contrairement à l'Alloy des logs, celui-ci n'a pas besoin d'être un DaemonSet :
  il ne lit pas de fichiers locaux par nœud, il scrape des endpoints HTTP pprof
  exposés par des Pods spécifiques désignés via annotations, donc un nombre fixe
  d'instances suffit)

Pour instrumenter une app, ajouter ces annotations sur son Pod/Deployment :

    profiles.grafana.com/memory.scrape: "true"
    profiles.grafana.com/memory.port: "8080"
    profiles.grafana.com/cpu.scrape: "true"
    profiles.grafana.com/cpu.port: "8080"

URL Grafana (data source) : http://pyroscope.observability.svc.cluster.local.:4040
