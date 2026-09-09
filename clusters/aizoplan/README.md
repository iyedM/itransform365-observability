# Cluster aizoplan-mgt — Déploiement production

## Accès
- Kubeconfig fourni par Koussay, stocké localement dans ~/.kube/aizoplan/config
  (JAMAIS committé - voir .gitignore)
- Namespace alloué : `tempo` uniquement - ne rien modifier ailleurs sur ce cluster

## Tempo → OVH Object Storage

Déployé avec succès. Config dans `tempo-values.yaml` (ignoré par Git, contient
les vraies clés OVH).

**Piège rencontré et résolu** : erreur de signature S3 ("request signature 
does not match") malgré des credentials valides. Cause : il manquait
`region: rbx` et `forcepathstyle: true` dans la config - nécessaires pour
OVH Object Storage (contrairement à AWS S3 où ces valeurs ont des défauts
qui fonctionnent sans les préciser).

**Statut** : Pod `1/1 Running`, stable, ingestion de traces confirmée
(vérifié via le WAL local du Pod).

## Bucket
- Nom : tempo-bucket
- Endpoint : s3.rbx.io.cloud.ovh.net
- Région : rbx (Roubaix)
