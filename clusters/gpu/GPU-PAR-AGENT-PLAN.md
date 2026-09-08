# GPU consumption par agent — Plan et stratégie d'attribution

## Statut

Configuration préparée, **pas encore testée** — nécessite un accès au serveur/cluster
possédant les GPU physiques (2x RTX A6000), qui n'est pas disponible depuis
l'environnement de développement local actuel (k3d, sans GPU).

## Ce que dcgm-exporter fait nativement

`dcgm-exporter` est l'outil officiel NVIDIA pour exposer les métriques GPU
(utilisation %, mémoire VRAM, température, énergie, erreurs ECC) au format
Prometheus — exactement le même mécanisme que `node-exporter` pour le
CPU/RAM, déjà utilisé dans ce projet depuis la Phase 1.

**Métriques de base fournies, par GPU physique** (pas encore par agent) :
- `DCGM_FI_DEV_GPU_UTIL` — utilisation GPU en %
- `DCGM_FI_DEV_FB_USED` / `DCGM_FI_DEV_FB_FREE` — mémoire VRAM utilisée/libre
- `DCGM_FI_DEV_GPU_TEMP` — température
- `DCGM_FI_DEV_POWER_USAGE` — consommation électrique

## Le vrai défi : attribuer l'usage à un agent précis

Par défaut, ces métriques sont **par GPU physique**, pas par processus ou
par agent qui l'utilise. Sur un serveur avec 2 GPU partagés entre plusieurs
agents, il faut un mécanisme d'attribution. Deux stratégies possibles,
selon comment les agents sont réellement déployés :

### Stratégie A — Mapping par Pod Kubernetes (si chaque agent = 1 Pod dédié)

Si l'infrastructure déploie chaque agent (ou groupe d'agents) dans son
propre Pod Kubernetes avec un GPU alloué explicitement (via
`nvidia.com/gpu: 1` dans les resource requests), `dcgm-exporter` peut
activer son option **`kubeMapping`** — il ajoute alors automatiquement les
labels `pod`, `namespace`, `container` à chaque métrique GPU, en
interrogeant l'API Kubernetes pour savoir quel Pod utilise quel GPU.

**Prérequis obligatoire** : le **NVIDIA device plugin pour Kubernetes**
doit être installé sur le cluster GPU — c'est lui qui rend les GPU
"allouables" par Kubernetes et qui fournit l'info de mapping à
`dcgm-exporter`. Sans ce plugin, le mapping ne fonctionne pas, seules les
métriques brutes par GPU physique sont disponibles.

**Résultat attendu** : une requête du type
```
DCGM_FI_DEV_GPU_UTIL{pod="aizo-research-agent-xyz"}
```
permettrait de filtrer directement l'utilisation GPU par agent, en
supposant que le nom du Pod correspond au nom de l'agent (convention à
établir).

### Stratégie B — Profiling par processus (si plusieurs agents partagent un GPU/Pod)

Si plusieurs agents tournent dans le **même** Pod ou processus (partage
d'un GPU sans isolation Kubernetes stricte), le mapping par Pod ne suffit
pas — il faut descendre au niveau du **PID**, via les métriques DCP (Data
Center Profiling) de DCGM, qui exposent l'utilisation GPU par processus
individuel. Plus fin, mais plus complexe à corréler avec le nom logique
de l'agent (il faut relier PID → agent applicatif, ce que le code de
l'agent devrait exposer lui-même, par exemple en loggant son PID au
démarrage).

## Recommandation

**Attendre de connaître le vrai mode de déploiement des agents sur le
serveur GPU** avant de choisir entre Stratégie A ou B — c'est une question
à poser explicitement à l'équipe : est-ce que chaque agent aura son propre
Pod/conteneur avec GPU alloué (Stratégie A, plus simple), ou est-ce que
plusieurs agents partageront le même processus/Pod (Stratégie B, plus
complexe) ?

## Déploiement (une fois l'accès obtenu)

```bash
helm repo add gpu-helm-charts https://nvidia.github.io/dcgm-exporter/helm-charts
helm repo update

helm install dcgm-exporter gpu-helm-charts/dcgm-exporter \
  -n observability -f dcgm-exporter-values.yaml
```

Vérification :
```bash
kubectl get pods -n observability -l app.kubernetes.io/name=dcgm-exporter
kubectl port-forward -n observability svc/dcgm-exporter 9400:9400
curl http://localhost:9400/metrics | grep DCGM_FI_DEV_GPU_UTIL
```

Le ServiceMonitor est déjà activé dans les values (`serviceMonitor.enabled:
true`, avec le label `release: kube-prom` cohérent avec le pattern déjà
utilisé pour les autres composants du projet) — Prometheus devrait le
scraper automatiquement sans configuration supplémentaire, sur le même
principe que `demo-api`/`otel-collector` en Phase 1.

## Fichiers concernés

- `dcgm-exporter-values.yaml` — configuration Helm prête à l'emploi
