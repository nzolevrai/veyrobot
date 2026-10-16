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

CI exécute `deploy/redis-saturation.integration.mjs` avec PostgreSQL 17 éphémère et un conteneur Redis 7 dédié configuré à faible `maxmemory`/`noeviction`. Le test sature par écriture réelle, utilise le dispatcher et le worker de production et des méthodes Discord contrôlées, puis libère la mémoire et vérifie actions, échéance, états persistés et absence de seconde mutation. Le diagnostic BullMQ est maintenant vérifié comme une erreur `OOM` de Redis, distincte d'une panne de connexion; le compteur `dispatcherOutboxQueriesDuringBackoff` ne couvre que les réveils pendant la fenêtre de backoff, et reste à zéro avec les erreurs additionnelles. Cette intégration ne simule pas un OOM cgroup.

`deploy/production-resource-profile.integration.mjs` démarre les images applicatives de la référence Compose dans un projet Docker jetable, initialise PostgreSQL 17 et Redis 7, inspecte `.HostConfig.Memory` pour chaque service, envoie 60 demandes à travers le cas d'usage DB et le dispatcher/worker/exécuteur de production avec un adaptateur Discord contrôlé, draine puis observe 30 secondes au repos. API `/health` et dashboard `/` sont sondés; il ne traverse pas HTTP/OAuth pour l'admission ni le navigateur. La génération de charge reste hors des cgroups des services. Le harnais nettoie son projet et ses volumes dans `finally`.

Le run local du 16 octobre 2026 (Node 24.19.0, Docker 29.8.2, hôte Windows/Docker Desktop) a confirmé ces limites réelles : PostgreSQL 1 GiB, Redis 384 MiB, migration 512 MiB, API 512 MiB, bot 768 MiB, dashboard 512 MiB. La charge a fini 60/60 opérations; latence admission p50/p95/p99 = 16/22/38 ms, acceptation→début = 300/788/792 ms et acceptation→fin = 355/847/852 ms, avec mutation Discord simulée de 50 ms. Les distributions ne s'additionnent pas. Aucun échec de sondes API/dashboard, OOM ni redémarrage n'a été observé. Pics cgroup : PostgreSQL 94 MiB, Redis 14 MiB, API 81 MiB, bot 124 MiB, dashboard 102 MiB; heaps Node max : API 27 MiB, dashboard 35 MiB, bot 46 MiB. Les sommes de RSS de processus lues par `docker top` étaient respectivement 153, 9, 113, 154 et 132 MiB; elles peuvent compter plusieurs fois les pages partagées et ne représentent pas la mémoire physique unique. `docker stats` working set était lui aussi rapporté séparément du cgroup. La file est retombée à zéro; maximum observé deux opérations en attente; PostgreSQL a utilisé au plus 5 connexions. Le générateur était un processus hôte distinct. Ces chiffres sont un essai court, sur cette machine et ce profil, pas un dimensionnement définitif; la mémoire libre hôte minimale observée pendant l'essai était 579 MiB, sans attribution certaine à VeyroBot ou Docker.

`deploy/redis-memory.integration.mjs` teste séparément Redis 7 avec AOF `everysec`, `noeviction`, `maxmemory=256 MiB` et cgroup 384 MiB. Le run local a écrit 60 000 valeurs aléatoires de 2 KiB et 1 000 écritures concurrentes de 8 KiB, observé `BGREWRITEAOF` actif pendant les écritures puis terminé avec succès, et vérifié 61 000 clés. Le pic cgroup était 227 MiB, `docker stats` working set 204 MiB, `used_memory` max 192 MiB, `used_memory_rss` 207 MiB, `mem_not_counted_for_evict`/buffer AOF 8 octets, et COW final rapporté par Redis `aof_last_cow_size` 2,1 MiB (`current_cow_peak` échantillonné 0,9 MiB); le cgroup avait environ 157 MiB de marge au pic. Ainsi, l'écart configuré de 128 MiB a été suffisant pour cette charge aléatoire et cette réécriture observée, sans atteindre les 256 MiB de `maxmemory`. La vitesse d'écriture, la taille, la fragmentation et la croissance du dataset peuvent augmenter la COW et les buffers; la marge n'est pas universelle et le résultat n'établit pas un seuil sûr au voisinage de `maxmemory`.

Le même script a provoqué un arrêt Redis réellement marqué `OOMKilled=true` (exit 137) dans un conteneur jetable de 48 MiB, puis l'a redémarré avec son volume AOF et retrouvé la clé témoin écrite avant l'arrêt. `maxmemory=0` a été contrôlé dans ce scénario; il s'agit donc bien d'un OOM cgroup, distinct d'un refus logique `maxmemory`. Il n'exerce pas simultanément PostgreSQL et le worker de production : la conservation des demandes et la reprise du pipeline de production sont démontrées par l'intégration distincte `redis-saturation.integration.mjs` au refus `noeviction`, pas par l'arrêt cgroup. Le comportement complet d'une mutation en vol lors d'un véritable OOM cgroup reste à éprouver sur un runner de référence; aucun retry de mutation incertaine n'est autorisé.

Le profil Compose a révélé deux problèmes réels de démarrage Redis. Le secret était monté sous `redis_config` alors que la commande/healthcheck lisaient `/run/secrets/redis.conf`; le service utilise maintenant explicitement la cible `redis.conf`. Sur Linux, Redis abandonnait ensuite les privilèges vers l'utilisateur `redis`, qui ne pouvait pas lire le fichier hôte secret en mode `0600`. Le point d'entrée copie donc le fichier depuis le montage secret vers le système de fichiers éphémère du conteneur, applique `redis:redis` et `0400`, puis démarre Redis avec `setpriv` sous son compte non-root. Le profil réel et la vérification Compose contrôlent cette séquence. Le fichier source reste protégé par les permissions du déploiement; le secret en clair n'est ni en argument ni dans les logs.

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

Les deux intégrations Docker suivantes sont lancées séparément en CI après les tests de code; elles utilisent seulement des identifiants et adaptations Discord fictifs. Pour les exécuter localement, installer les dépendances et activer explicitement :

```powershell
$env:RUN_REDIS_MEMORY_INTEGRATION = '1'
node deploy/redis-memory.integration.mjs
$env:RUN_PRODUCTION_RESOURCE_PROFILE = '1'
$env:ALLOW_LOCAL_RESOURCE_PROFILE = '1'
node deploy/production-resource-profile.integration.mjs
```

Les tests OOM nécessitent que Docker applique les limites cgroup, et les contrôles sont bloquants si `OOMKilled` ou les limites inspectées ne correspondent pas. Le profil applicatif s'auto-nettoie, utilise son propre projet Compose et réalise seulement des GET de santé API/dashboard plus le chemin DB/worker simulé.

Le script résout `deploy/compose.production.yaml`, vérifie les budgets/heap par service et démarre un probe Alpine 64 MiB; il vérifie ensuite `docker inspect .HostConfig.Memory`. CI lance aussi le test de saturation réel ci-dessus. Les campagnes historiques citées ne se sont pas déroulées sous les nouveaux caps; aucun avant/après ni gain de performance n'est revendiqué dans cette tranche.

Sources primaires consultées le 16 octobre 2026 : [Compose Deploy Specification](https://docs.docker.com/reference/compose-file/deploy/) et [Compose services](https://docs.docker.com/reference/compose-file/services/) (support de `deploy.resources` à confirmer par le probe Docker de CI); [BullMQ Going to production](https://docs.bullmq.io/guide/going-to-production) (recommande `noeviction`); [Redis eviction](https://redis.io/docs/latest/develop/reference/eviction/) (`noeviction` refuse les écritures); [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) (`appendfsync everysec`).
