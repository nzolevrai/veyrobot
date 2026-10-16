# Budgets mémoire et saturation Redis — 16 octobre 2026

## Portée et point de départ mesuré

Les valeurs ci-dessous sont des **enveloppes initiales configurables**, destinées au déploiement Compose mono-hôte documenté. Elles ne démontrent pas une capacité en serveurs ou en débit. Elles devront être révisées à partir de RSS sous charge, des compteurs Redis, de la croissance PostgreSQL et de la mémoire libre de l'hôte.

Le meilleur point de référence existant est une campagne de 30 minutes du pipeline de production (PostgreSQL 17, Redis 7, dispatcher/worker/exécuteur réels et Discord simulé), puis 5 minutes de repos : pic RSS bot de 271 MiB et RSS à repos de 128 MiB; heap observé de 49,5 à 39,7 MiB. Cette campagne n'avait pas de limite cgroup, n'était pas un test de saturation mémoire et n'incluait pas HTTP/OAuth. Une observation passive distincte du Gateway connecté a relevé 143,2–146,0 MiB RSS et 37,8–45,7 MiB heap, sans ventilation des caches par taille de serveur. Voir [PERFORMANCE-BASELINE.md](PERFORMANCE-BASELINE.md) et [FOUNDATION-QUALITY-REVIEW-2026-10-15.md](FOUNDATION-QUALITY-REVIEW-2026-10-15.md).

## Enveloppes de départ

| Service | Heap V8 old-space | Limite conteneur | Part non heap incluse dans la limite |
|---|---:|---:|---|
| API | 256 MiB | 512 MiB | 256 MiB pour young/code space, stacks, Prisma/libpq, TLS, buffers et natif |
| Dashboard | 256 MiB | 512 MiB | 256 MiB pour Next/React, buffers, stacks et natif |
| Bot | 384 MiB | 768 MiB | 384 MiB pour Gateway/discord.js, compression, buffers, stacks et natif |
| Migration | 256 MiB | 512 MiB | marge d'outils Prisma, moteurs natifs et buffers |
| PostgreSQL | sans heap Node | 1 GiB | mémoire partagée, backend par connexion, buffers de requête et système |
| Redis | sans heap Node | 384 MiB | 128 MiB entre `maxmemory` et le cgroup |

Le heap Node ne représente ni toute la mémoire du processus ni le RSS. `--max-old-space-size` ne borne pas les buffers externes, les autres espaces V8, stacks et allocations natives; Docker impose la limite RSS/cgroup. Un OOM peut donc survenir avant que l'ancien espace V8 atteigne sa valeur maximale.

Les limites et heaps sont paramétrables via les variables `*_MEMORY_LIMIT`, `*_NODE_HEAP_MB`, `REDIS_MEMORY_LIMIT` et `REDIS_MAXMEMORY` de `deploy/production.env.example`. Les valeurs définies simultanément dans un fichier d'environnement réel sont à vérifier et à garder cohérentes. Les plafonds de mémoire des services persistants totalisent environ 3,125 GiB; réserver en plus au moins 1,5 GiB à l'OS, Docker, au cache disque et aux pointes de l'hôte. Une machine de 5 GiB utilisables est un plancher arithmétique pour ces caps, pas un sizing validé; prévoir davantage si d'autres workloads partagent l'hôte. Compose n'alloue pas ces caps à l'avance et ils ne remplacent pas les mesures.

Les valeurs PostgreSQL et API/dashboard sont des premières limites opératoires : aucun pic spécifique à ces processus sous cgroup n'a encore été mesuré. Les ajuster après un essai représentatif et vérifier les arrêts OOM avant ouverture du trafic. La base conserve le pool borné déjà configuré; compter les connexions d'administration en plus.

## Redis et persistance

Le service a `maxmemory=256mb`, `maxmemory-policy noeviction`, sous un cgroup de 384 MiB. L'écart de 128 MiB (33 % du conteneur) est un budget explicite pour allocations non comptées par `maxmemory`, clients/connections, buffers, fragmentation et opérations AOF. Ce n'est pas une garantie que toute réécriture AOF tient dans cette marge; suivre le RSS conteneur et les événements OOM. Si le RSS s'approche de la limite avant `maxmemory`, réduire le plafond Redis ou augmenter ensemble les deux valeurs après mesure, sans augmenter automatiquement la limite lors d'un test.

Redis conserve l'AOF sur le volume, avec `appendfsync everysec`; la perte au crash du stockage Redis peut donc inclure les dernières écritures. Les snapshots RDB planifiés sont explicitement désactivés (`save ""`) pour éviter un deuxième mécanisme de snapshot et les pics fork/copy-on-write associés. `BGREWRITEAOF` reste susceptible de consommer de la mémoire supplémentaire. Le volume et l'AOF augmentent les écritures disque et l'espace utilisé. La file Redis n'est pas la source durable : les demandes et échéances restent dans PostgreSQL, puis le dispatcher les republie après reprise. `noeviction` refuse les écritures de file plutôt que d'évincer arbitrairement ses clés BullMQ.

## Saturation et reprises

Le dispatcher traite désormais une erreur d'écriture Redis comme une panne du plan de publication partagé : il arrête la passe après la première erreur, laisse PostgreSQL intact et applique un backoff de 1, 2, 4, 8, 16 puis 30 secondes maximum. Les réveils de slash suivent ce backoff également. Un succès de publication réinitialise le backoff. Les erreurs restent corrélées par la clé de composant statique; le logger du bot les agrège et limite leur émission. Pendant une saturation persistante, une action ou une échéance due peut donc attendre jusqu'à 30 s avant la prochaine tentative de publication; son enregistrement PostgreSQL reste durable. Un job déjà actif peut finir et enregistrer son résultat dans PostgreSQL pendant que Redis refuse les écritures; les claims de la base empêchent une rediffusion de répéter une mutation déjà finalisée. Les échéances restent planifiées et repassent par la réconciliation SQL une fois Redis disponible.

CI exécute `deploy/redis-saturation.integration.mjs` avec PostgreSQL 17 éphémère et un conteneur Redis 7 dédié configuré à faible `maxmemory`/`noeviction`. Le test sature par écriture réelle, utilise le dispatcher et le worker de production et des méthodes Discord contrôlées, puis libère la mémoire et vérifie actions, échéance, états persistés et absence de seconde mutation. Il ne se connecte pas au Gateway et ne prouve pas la pression d'un Redis de production ni la mémoire applicative sous cgroup. `deploy/verify-compose-budgets.mjs` vérifie également la configuration résolue et inspecte `HostConfig.Memory` d'un conteneur probe créé par Compose.

## Surveillance et seuils initiaux

Les champs `redis.usedMemoryBytes`, `redis.maxMemoryBytes`, `redis.connectedClients` et `redis.oomErrors` sont écrits dans l'instantané opérationnel JSON bot à chaque minute; ils n'ont pas de stockage métrique ni d'alerte gérée attachée. La même ligne contient `queue.waiting/active/delayed/failed`, RSS, heap, mémoire externe, erreur et compteur de requêtes SQL. `docker stats` fournit RSS et limite cgroup des cinq services; l'état `OOMKilled` et les redémarrages viennent de Docker. PostgreSQL n'expose pas encore son usage mémoire à l'instantané applicatif.

| Signal | Seuil initial de revue/alerte | Source et statut |
|---|---|---|
| Redis `used_memory / maxmemory` | avertir à 75 % pendant 5 min; agir/revoir à 90 % | instantané bot livré; seuil à configurer dans l'outil externe |
| Redis `oomErrors` | toute hausse | `INFO errorstats` dans l'instantané; aucune alerte déployée |
| RSS conteneur / limite | avertir à 75 % pendant 5 min; intervention à 90 % | `docker stats`; aucun collecteur déployé |
| Refus BullMQ / attente demandée | tout refus Redis; âge `requested` > 60 s; file croissante 5 min | erreurs bot/SQL opérationnelles; seuils à brancher |
| Échéance en retard | âge > 60 s | métriques SQL bot; alerte non déployée |
| OOM ou redémarrages | tout OOM, ou plus de 2 redémarrages en 10 min | `docker inspect`/superviseur; pas d'alerte déployée |

Les seuils sont des valeurs initiales de triage, pas des SLO validés. Ne pas exporter de séries par serveur, utilisateur ou opération. Un tableau de bord et des notifications d'alerte restent à déployer sur l'hôte choisi.

## Répétabilité et sources

Depuis la racine avec Docker Compose v2, Node 24.21 et les valeurs d'exemple (l'epoch fictif ci-dessous est uniquement nécessaire pour rendre le Compose) :

```powershell
$env:VEYROBOT_RECOVERY_EPOCH = '00000000000000000000000000000000'
node deploy/verify-compose-budgets.mjs
```

Le script résout `deploy/compose.production.yaml`, vérifie les budgets/heap par service et démarre un probe Alpine 64 MiB; il vérifie ensuite `docker inspect .HostConfig.Memory`. CI lance aussi le test de saturation réel ci-dessus. Les campagnes historiques citées ne se sont pas déroulées sous les nouveaux caps; aucun avant/après ni gain de performance n'est revendiqué dans cette tranche.

Sources primaires consultées le 16 octobre 2026 : [Compose Deploy Specification](https://docs.docker.com/reference/compose-file/deploy/) et [Compose services](https://docs.docker.com/reference/compose-file/services/) (support de `deploy.resources` à confirmer par le probe Docker de CI); [BullMQ Going to production](https://docs.bullmq.io/guide/going-to-production) (recommande `noeviction`); [Redis eviction](https://redis.io/docs/latest/develop/reference/eviction/) (`noeviction` refuse les écritures); [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) (`appendfsync everysec`).
