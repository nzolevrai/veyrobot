# Guide de revue indépendante

Ce guide décrit les preuves disponibles pour la PR [#1](https://github.com/nzolevrai/veyrobot/pull/1). **Commit de code et tests à examiner : `bb021d4066c28d3af00f9517d183c7d0aa95e3c6`**, comparé au précédent commit relu `5219f2f99f2a1eb0446bb7aacf18c589d4f90528`. Les tests PostgreSQL F7 passent sur ce commit dans les runs [push](https://github.com/nzolevrai/veyrobot/actions/runs/38686299290) et [PR](https://github.com/nzolevrai/veyrobot/actions/runs/38686303138). La tête de PR peut ensuite inclure ce commit documentaire; vérifier aussi les checks attachés à cette tête exacte. La PR reste en brouillon et ne doit pas être fusionnée automatiquement.

ChatGPT, Claude et Gemini peuvent utiliser le même SHA et les commandes ci-dessous, mais doivent examiner le code eux-mêmes. Rapporter chaque constat avec chemin/ligne, scénario reproductible, gravité et impact; signaler aussi les zones non vérifiables depuis le dépôt. Ne pas inférer une garantie à partir d’un test simulé.

## Architecture et points d’entrée

- `apps/api/src/index.ts` : composition Fastify, sessions, contrôle de session, autorisations Discord, readiness et métriques API. Plugins de routes dans `oauth-routes.ts`, `guild-routes.ts` et `moderation-routes.ts`.
- `apps/bot/src/index.ts` : composition Gateway et cycle de vie mono-processus. `dispatcher.ts` republie les demandes durables PostgreSQL dans BullMQ; `worker.ts` vérifie leur serveur, gère la concurrence et appelle les exécuteurs.
- `packages/moderation/src/service.ts` : validation des demandes et écriture durable, sans import de Discord.js. `executor.ts` contient vérifications de permissions, appels Discord et réconciliation; `index.ts` préserve l’export historique. L’API importe le sous-chemin `service`, le bot utilise l’export racine.
- `packages/db` : schéma Prisma, migrations, transactions d’admission, accès aux dossiers, rétention et quarantaine après restauration.
- `apps/dashboard` : Next.js, proxy serveur vers l’API, parcours OAuth et interface. Les contrats et traitements serveur ne sont pas inclus dans le bundle client.

## Invariants à examiner

1. Toute donnée d’action est rattachée au `guildId` validé par l’API; une session copiée est révoquée côté serveur à la déconnexion. Les mutations Dashboard exigent session, origine, CSRF et version de configuration.
2. L’`operationId` est stable, unique et associé à la charge utile originale. PostgreSQL est la source durable; Redis n’est qu’un transport. Claim et transitions sont conditionnels, avec bail et fencing.
3. Un seul bot peut démarrer avec le token dans le déploiement pris en charge. Une action active maximum par serveur, quatre workers, admission plafonnée à 5 000 globalement et 100 par serveur par défaut.
4. Un échec Discord explicite devient `failed`; un résultat ambigu après début d’appel devient `uncertain`. Le fencing protège les écritures internes, mais ne peut annuler un appel Discord déjà parti. Discord ne donne pas ici de garantie générale d’exécution exactement une fois.
5. Une échéance active est protégée par état, génération et bail. Les décisions externes concurrentes restent une limite connue; Discord ne fournit pas une suppression conditionnelle du ban sur génération.
6. Une sauvegarde ancienne n’est pas redémarrée directement : arrêter les exécutables, restaurer en maintenance, lancer la quarantaine et réconcilier les états incertains avant toute reprise.

## Reproduction propre

Pré requis : Node 24.21.0, pnpm 10.18.3, Docker Compose, PostgreSQL 17 et Redis 7. Aucune valeur de `.env` n’est requise pour les tests simulés; l’intégration API crée ses identifiants fictifs dans son processus enfant.

```powershell
corepack pnpm install --frozen-lockfile
docker compose up -d postgres redis
$env:DATABASE_URL = 'postgresql://<user>:<password>@127.0.0.1:5432/veyrobot?schema=public'
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
$env:RUN_POSTGRES_INTEGRATION = '1'
$env:RUN_REDIS_INTEGRATION = '1'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
$env:RUN_DASHBOARD_ROUTE_INTEGRATION = '1'
corepack pnpm test
```

Utiliser une base locale jetable/sauvegardée, jamais une base de production. CI doit définir explicitement `RUN_POSTGRES_INTEGRATION`, `RUN_REDIS_INTEGRATION` et `RUN_DASHBOARD_ROUTE_INTEGRATION`; si l’un manque, les suites concernées signalent qu’elles ont été ignorées et les résultats ne satisfont pas la revue. Le banc de charge dédié exige une base isolée nommée `veyrobot_arch_bench` et Redis DB 9; son protocole et ses paramètres sont dans `RELIABILITY-VERIFICATION-2026-10-14.md`.

### Preuves F7 et finalisation concurrente

`packages/moderation/src/executor.integration.test.ts` couvre maintenant sur PostgreSQL réel l’échec explicite d’une demande récente, une décision active, une décision incertaine avec ancien marqueur Discord conservé, le contrôle final juste avant expiration, la finalisation d’un BAN confirmé pendant qu’une génération plus récente est admise/appliquée, l’échec de la transaction après réponse, la réconciliation/rediffusion et l’isolation entre guildes. Le code finalise le dossier confirmé et n’avance `appliedGeneration` qu’avec une mise à jour conditionnelle qui ne remplace pas une génération déjà appliquée plus récente; le jeton de claim et le bail restent vérifiés. Le succès d’un dossier décrit l’accusé Discord reçu, pas la décision désirée actuellement.

Les barrières de concurrence ont des timeouts explicites, sont libérées dans `finally`, et les données sont supprimées dans `finally`. La vérification par mutation ciblée doit retirer les contrôles d’incertitude et de dernière lecture et constater que l’expiration devient dangereuse; retirer le signal d’une barrière doit échouer rapidement avec un message de timeout, sans immobiliser le runner. Ces scénarios utilisent un adaptateur contrôlé, pas Discord réel.

Les intégrations nécessitent `RUN_POSTGRES_INTEGRATION=1` et PostgreSQL 17 isolé. Le poste Windows n’a pas de PostgreSQL, Redis ou Docker accessibles; les résultats de la tête finale doivent donc venir de CI. Discord et PostgreSQL ne forment toujours pas une transaction atomique, et une nouvelle demande peut arriver après le dernier contrôle SQL mais avant le DELETE Discord.
## Preuves et lacunes par axe

## Défauts vérifiés et corrections de cette tranche

- **Fiabilité, modérée** — `apps/api/src/oauth-routes.ts` attendait sans échéance les échanges OAuth token et profil; une réponse réseau bloquée pouvait retenir la requête. Les deux appels ont maintenant un timeout de 8 s et une réponse 502 générique. Reproduction : `apps/api/test/integration.mjs` configure le faux endpoint token pour rester suspendu 9 s; le callback doit répondre 502 avant cela, puis le flux OAuth nominal est relancé.
- **Exactitude des mesures, modérée** — `apps/bot/tools/bench-production.mjs` créait les bans temporaires avec une échéance déjà dépassée d’une seconde et appelait le temps avant `Queue.add` une publication. Les mesures de sérialisation et d’attente se chevauchaient lorsque l’enqueue précédait la fin de l’action précédente. Le banc utilise maintenant `queueAddStartedAt`, la dernière tentative d’enqueue et sépare l’attente d’exécution du temps de sérialisation; les anciennes valeurs concernées sont historiques, pas une référence corrigée.
- **Couverture CI, modérée** — le scénario du serveur Next construit et du proxy pouvait être omis quand `RUN_DASHBOARD_ROUTE_INTEGRATION` n’était pas défini. La CI l’active désormais explicitement en plus de PostgreSQL réel.
- **Frontière d’import, maintenabilité** — l’API chargeait l’export complet de modération et donc le module Discord.js bien qu’elle ne fasse que valider/enregistrer une demande. Les fonctions de service sont isolées sous `@veyrobot/moderation/service`, l’exécuteur reste sous `executor` et l’export historique évite une migration en bloc des consommateurs. Le test de frontière vérifie le graphe local; vérifier également le graphe construit et les tests après changement.

La relecture des autres chemins ne produit pas à elle seule une preuve exhaustive. Les limites de fencing face à un appel Discord en cours, l’effet des changements externes sur une échéance et le manque de coordination REST entre API et bot restent documentés, pas présentés comme corrigés.

| Axe proposé | Preuves à relire | Éléments encore manquants |
|---|---|---|
| Sécurité et isolation | Tests API/PostgreSQL de guildes croisées, session copiée après logout, origine/CSRF, proxy borné; revue de `requireInstalledGuild` et des routes d’action | Test d’intrusion indépendant et validation du modèle de déploiement réel |
| Exactitude des opérations | Comparaison d’`operationId`/charge utile; tests d’admission concurrente; exécuteur de production avec doublons, erreurs explicites/ambiguës et échéances | Appels Discord contrôlés sur serveur de test avec autorisation humaine; les tests simulés ne prouvent pas le comportement réseau réel |
| Reprise après panne | Tests PostgreSQL/BullMQ, processus enfant interrompu, fencing, restauration isolée et quarantaine | Essai de restauration dans l’environnement d’exploitation et observation des preuves Discord avant réactivation |
| Architecture et maintenabilité | `tools/check-boundaries.mjs`, lint, TypeScript, revue des points d’entrée et du flux PostgreSQL→dispatcher→worker | Avis indépendants sur les frontières métier/Discord et les décisions de configuration |
| Performance et ressources | Campagne corrigée : 9 300 offres, 8 500 acceptées, 800 refus, 0 échec/incertitude; p95 total calme 3,960 s, dominante 22,185 s (sérialisation 22,168 s), échéances 1,195 s; RSS 245,9→113,8 Mo après drainage/repos. Détails et protocole dans `RELIABILITY-VERIFICATION-2026-10-14.md`. | Aucun chiffre de simulation ne démontre une capacité Gateway/REST Discord ou un nombre de serveurs en production; pools/attente maximaux ne sont pas des percentiles |
| Tests et reproductibilité | Sur `bb021d4`, CI a réussi migrations et diff schéma, `typecheck`, `build`, `lint` et tous les tests sans saut : db 10/10, contracts 4/4, moderation 35/35, API cache 3/3 + smoke/intégration, bot 5/5 dont Redis/BullMQ, Dashboard 13/13 et scénario proxy construit. Les runs push et PR sont verts. | Recontrôler les checks sur tout nouveau SHA de tête; validation visuelle navigateur et Discord réel absentes |
| Exploitation et observabilité | snapshots agrégés RSS/heap/boucle, files/âges, pool et états incertains; runbook de restauration | Alertes, sauvegarde planifiée et restauration éprouvée par l’exploitant |

## Critères de fusion

Recommander la fusion uniquement si la CI est verte sur le SHA examiné, si l’intégration PostgreSQL et le serveur Next sont exécutés, et si chaque défaut de sécurité, perte de données ou rejeu dangereux est corrigé ou explicitement bloquant. Les évaluateurs peuvent conclure qu’un axe nécessite des corrections; cette grille ne prédéfinit aucune note.

Le socle mesuré est un monolithe modulaire avec un processus bot, une API séparée, admission bornée et tests de l’exécuteur de production contre un adaptateur Discord contrôlé. Le déploiement massif n’est pas validé. Ne pas activer plusieurs processus avec le même token avant propriété/routage des shards, coordination REST globale entre API et bot, démarrage progressif et reprise multi-instance. Une revue ou validation navigateur/Discord ne doit effectuer aucune sanction ni suppression réelle.

## Limites restantes avant production

- Le rate limit des routes publiques reste partagé selon l’adresse que l’infrastructure transmet à Fastify; le proxy Next ne garantit pas une IP cliente attestée dans tous les hébergements.
- Aucun parcours visuel complet n’a été validé dans un navigateur.
- Aucun appel Discord réel n’a été exécuté; permissions, latences et résultats REST sont simulés dans ces tests.
- La mémoire Gateway par serveur et l’effet réel des caches discord.js restent à mesurer avec un bot connecté et des guildes représentatives.
- La restauration est testée isolément, mais la procédure doit être répétée par l’exploitant sur son environnement et inclure la réconciliation manuelle avant reprise des mutations.
- La CSP conserve `unsafe-inline`; son durcissement doit être testé contre le rendu Next avant activation.

## Revue guidée manuelle

Pour une validation navigateur, démarrer PostgreSQL/Redis et les applications avec des identifiants Discord de test fournis par le propriétaire; vérifier connexion OAuth, profil, sélection d’un serveur autorisé, état de module désactivé, brouillon/sauvegarde, avertissement et déconnexion. Ne cliquer sur aucune action de sanction. Pour une validation Discord, limiter le parcours à lecture des permissions et commandes inoffensives sur une guilde de test; obtenir une autorisation séparée avant toute mutation.
