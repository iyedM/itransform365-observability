# Setup cluster local — observability-lab

## Prérequis système (à faire une seule fois par machine)
Augmenter les limites inotify — sinon les nœuds "agent" restent bloqués indéfiniment
au démarrage dès qu'il y en a plus d'un (containerd ne finit jamais son init) :

    sudo sysctl fs.inotify.max_user_instances=512
    sudo sysctl fs.inotify.max_user_watches=524288
    echo "fs.inotify.max_user_instances=512" | sudo tee -a /etc/sysctl.conf
    echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p

## Créer le cluster

    k3d cluster create observability-lab \
      --agents 2 \
      --port "8090:80@loadbalancer" \
      --port "8453:443@loadbalancer" \
      --k3s-arg "--disable=traefik@server:0"

Note : port 8080 est déjà pris par un autre conteneur (web_nginx) sur cette machine,
d'où l'usage de 8090/8453 plutôt que 8080/8443.

## Vérifier que tout va bien

    docker ps -a --filter "name=k3d-observability-lab"
    kubectl get nodes

Les 4 conteneurs (server-0, agent-0, agent-1, serverlb) doivent être "Up",
et les 3 nœuds "Ready".

## Supprimer le cluster proprement

    k3d cluster delete observability-lab
