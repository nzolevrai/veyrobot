# Référence de déploiement du socle actuel

Cette configuration prépare un déploiement mono-hôte à faible volume ; elle n'a pas été déployée ni éprouvée sous trafic public. Elle n'engage aucun fournisseur ni coût. Le bot reste un seul processus, protégé par son verrou PostgreSQL. L'API est également une seule instance : ses limites HTTP en mémoire ne se coordonnent pas entre replicas.

## Topologie de référence

`deploy/compose.production.yaml` décrit PostgreSQL 17, Redis 7, une tâche de migrations, l'API, le dashboard et un bot unique. PostgreSQL et Redis n'ont aucun port publié. L'API n'est joignable que depuis le réseau Compose; le dashboard écoute sur `127.0.0.1:3000`. Un ingress TLS géré sur l'hôte reçoit Internet et transmet uniquement au dashboard. Le Dockerfile exécute l'image avec l'utilisateur `node`, et la référence retire les capabilities Linux et interdit l'élévation de privilèges.

Préparer sur l'hôte un fichier **non suivi** `.env.production` depuis `deploy/production.env.example`, `.secrets/redis.conf` depuis `deploy/redis.conf.example` et `.secrets/postgres_password` depuis `deploy/postgres-password.example`; remplacer les placeholders par des valeurs générées et les conserver dans un gestionnaire externe. Le secret PostgreSQL monté doit correspondre au mot de passe de `DATABASE_URL`; le mot de passe Redis de sa configuration doit correspondre à `REDIS_URL`. L'image Postgres reçoit son mot de passe par fichier monté plutôt que par variable d'environnement. Les secrets OAuth, bot, session, PostgreSQL, Redis et HMAC doivent être distincts. Les mots de passe inclus dans les URI doivent être encodés pour URL.

Exemple d'ordre d'exploitation, après construction/revue de l'image et mise en place des secrets :

```powershell
Copy-Item deploy/production.env.example .env.production
# Éditer .env.production hors du dépôt et remplacer tous les placeholders.
docker compose --env-file .env.production -f deploy/compose.production.yaml config --quiet
docker compose --env-file .env.production -f deploy/compose.production.yaml build
docker compose --env-file .env.production -f deploy/compose.production.yaml up -d postgres redis
docker compose --env-file .env.production -f deploy/compose.production.yaml run --rm migrate
docker compose --env-file .env.production -f deploy/compose.production.yaml up -d api dashboard bot
```

Ne lancer ces commandes que sur l'hôte d'exploitation choisi. Avant une mise à jour, sauvegarder PostgreSQL, vérifier les migrations additives, exécuter `migrate` avec la nouvelle image et observer `/ready` avant de reprendre le trafic. La configuration ne fournit pas de stockage de sauvegarde externe, de TLS, de WAF ni de supervision gérée.

## Budgets de ressources

Les limites cgroup Compose, heaps Node et leur justification figurent dans [MEMORY-REDIS-BUDGETS-2026-10-16.md](MEMORY-REDIS-BUDGETS-2026-10-16.md). Valeurs initiales : API 512 MiB/heap old-space 256 MiB; Dashboard 512/256; bot 768/384; PostgreSQL 1 GiB; Redis 384 MiB conteneur et 256 MiB `maxmemory`; migration 512/256. Configurer les limites via les variables documentées et garder la marge Redis de 128 MiB. Les 3,125 GiB de caps de services persistants laissent au moins 1,5 GiB pour OS/Docker/pointes; 5 GiB hôte est un plancher de configuration, pas une capacité mesurée. Vérifier avec `docker compose config` et `docker inspect`; la CI exécute un probe de limite cgroup.

Redis reste sur AOF avec `appendfsync everysec`, RDB périodique désactivé et `noeviction`. PostgreSQL garde les opérations durables. En saturation, le dispatcher utilise un backoff exponentiel plafonné à 30 s et reprend la lecture de l'outbox après succès. Cette configuration réduit la fréquence de tentatives; elle n'ajoute ni stockage métrique ni alertes gérées.

## Chaîne de confiance de l'adresse client

Le frontal TLS doit écouter sur 443, appliquer sa limite publique et **remplacer**, jamais concaténer, `X-Real-IP` par l'adresse source qu'il a lui-même observée. Il transmet `Host` et `X-Forwarded-Proto: https` et n'expose pas directement le port 3000 sur Internet. Par exemple, pour Nginx sur le même hôte :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
```

Next retire les en-têtes `Forwarded` et `X-Forwarded-*` reçus du navigateur avant d'appeler l'API. Il signe l'IP seulement si `DASHBOARD_TRUSTED_CLIENT_IP_HEADER=x-real-ip` et le secret HMAC sont configurés. L'API vérifie la signature en temps constant; une valeur non signée ou malformée retombe sur l'IP de socket et ne peut pas choisir son seau. Cette chaîne n'est sûre que si l'ingress remplace `X-Real-IP` par l'adresse source qu'il a observée; le HMAC n'atteste pas la vérité d'une valeur signée par un proxy mal configuré. Si l'ingress ne remplace pas l'en-tête, supprimer cette configuration et garder la limitation au frontal : dans ce cas les demandes anonymes via Next partagent volontairement le seau socket. `API_TRUSTED_PROXIES` reste vide car aucune adresse `X-Forwarded-*` n'est utilisée pour les décisions API. Avant parsing et lecture des grants de session, l'API impose `API_PREAUTH_RATE_LIMIT_MAX` (180/minute/IP par défaut); cela ne borne pas toutes les lectures PostgreSQL : `/ready` exécute un `SELECT 1` distinct et doit rester privé à la supervision par la topologie réseau. Ensuite seuls les grants valides sélectionnent le quota distinct `API_RATE_LIMIT_MAX` (90/minute/session par défaut). Les grants absents, incomplets, expirés, révoqués ou indisponibles retombent sur l'IP et une panne DB ne donne aucun privilège. Les sessions valides restent aussi soumises au plafond IP pré-auth agrégé. Les compteurs sont en mémoire par processus, donc le WAF/ingress doit garder un plafond global. Le quota de `/installation-check` est appliqué en `preHandler`, après validation du grant, et reste limité à 5/minute/session dans un compteur distinct du quota général. Un 429 Discord transmet son `Retry-After` sans retry.

OAuth et API partagent des limites en mémoire par instance; l'ingress/WAF doit donc garder un plafond public global. Ne répliquer l'API qu'après ajout ou choix d'un limiteur distribué maintenu et tests d'isolation. Ne répliquer aucun bot avec le même token.

## CSP et cache Next.js

La version installée est Next.js 16.4.0. La CSP par nonce suit son guide CSP local et la documentation officielle consultée le 15 octobre 2026 ([Content Security Policy](https://nextjs.org/docs/app/guides/content-security-policy), [Proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)). Le nonce par requête exige le rendu dynamique et attache les scripts générés par Next; les pages HTML ne sont donc pas servies du cache Full Route/ISR ou CDN par défaut. Le contrôle Chrome 155 headless valide la présence du nonce et l'absence de violations détectées, mais le cache de production et le rendu visuel restent à contrôler avant mise en production.

## Cookies, arrêt, sondes et alertes

`NODE_ENV=production` active les cookies HttpOnly, SameSite=Lax et Secure. Le TLS externe est obligatoire. Vérifier l'URL OAuth et l'origine du dashboard avant ouverture publique. Compose relance les processus applicatifs en échec et envoie SIGTERM; l'API ferme Prisma et le bot libère le verrou Gateway. `/health` vérifie la vie de l'API, `/ready` PostgreSQL; la santé du bot, Redis, files BullMQ et Gateway doit être collectée séparément. Une sonde HTTP n'atteste pas une connexion Discord.

Suivre et alerter sans labels utilisateur/serveur : profondeur et âge maximal des demandes, échéances en retard, dossiers `uncertain`, échecs API/Discord et 429, boucles événementielles, RSS/heap, pool DB et connexions Redis. Envisager alerte à tout nouveau `uncertain` et au-delà de 1 minute d'âge d'une échéance; ces seuils sont des valeurs initiales d'exploitation, pas des SLO issus d'une charge publique. Un superviseur doit alerter si le bot redémarre en boucle. Conserver les logs structurés avec `requestId` sans cookies, tokens ni contenus sensibles.

## Sauvegarde et croissance

`deploy/backup-postgres.ps1` crée une archive custom-format sur un chemin externe choisi par `VEYROBOT_BACKUP_DIR`, et imprime seulement chemin et SHA-256. Planifier le script avec le Planificateur de tâches Windows ou un ordonnanceur de l'hôte, avec un compte dédié dont l'accès au répertoire est restreint. Le script ne supprime pas les copies et n'envoie pas vers un fournisseur distant; assurer chiffrement, copie hors hôte, contrôle d'intégrité, alerte d'échec et politique de conservation dans l'environnement d'exploitation. Tester périodiquement une restauration dans une base isolée. Après restauration ancienne, suivre `docs/OPERATIONS.md` : arrêter API/bot/dispatchers, restaurer sur une base distincte, appliquer la quarantaine incluant les échéances TEMPBAN futures, réconcilier manuellement avec les preuves Discord puis redémarrer contrôlé. Une action postérieure à la sauvegarde peut manquer de celle-ci; la quarantaine n'autorise jamais sa répétition.

La purge de `ModerationCase` demeure désactivée. Mesurer chaque jour `pg_total_relation_size('"ModerationCase"')`, le nombre par statut et l'espace libre du volume. Seuils provisoires recommandés : avertir sous 30 % d'espace libre, escalader sous 15 %; suspendre les admissions de modération avant saturation si l'espace ne peut être accru. Ils doivent être ajustés à la vitesse de croissance observée. Les dossiers actifs, incertains, operationId et échéances sont conservés; tombstones durables et horizon d'idempotence restent à concevoir avant toute purge.

## Limites et critères de palier

Cette référence ne prouve ni capacité en nombre de serveurs ni latence Internet. Mesurer CPU, mémoire Gateway par taille de guilde, âge de file, p95/p99, 429, et connexions pendant plusieurs campagnes. Le palier suivant n'est justifié que par une saturation soutenue reproductible; la coordination REST multi-processus, l'orchestration de shards et l'idempotence des reprises sont un chantier distinct.
