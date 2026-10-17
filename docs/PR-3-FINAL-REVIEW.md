# Synthèse finale de revue — PR #3

Référence de code de cette synthèse : PR #3, branche `hardening/foundation-quality`, commit F14 `638c8f5bb181ea0538e900f2f747eaf669fa863f`. La PR est ouverte et non fusionnée. Les checks requis sont verts sur ce SHA ([CI run #113](https://github.com/nzolevrai/veyrobot/actions/runs/39036780166)); consulter aussi l'onglet [Checks de la PR](https://github.com/nzolevrai/veyrobot/pull/3/checks) pour le commit documentaire le plus récent. Cette synthèse ne constitue pas une validation de production. Le développement et les vérifications décrits ici restent locaux; AWS est envisagé plus tard et aucune ressource AWS n'a été créée.

## Constats des revues indépendantes F1–F14

| Constat | État | Preuve dans le code/tests | Limite restante |
|---|---|---|---|
| F1 — cache discord.js des bans | Corrigé | `packages/moderation/src/executor.ts`; tests d'intégration `packages/moderation/src/executor.integration.test.ts` avec `GuildBanManager` réel et REST contrôlé, lecture fraîche sans cache | Aucun appel Discord réel; comportement externe reste tributaire de l'API Discord. |
| F2 — permission Administrator | Corrigé | helper de permissions partagé dans `packages/contracts`; tests contracts/modération/API couvrant bit Administrator, permissions spécifiques et hiérarchie | Aucun test réel avec rôles Discord; ordre et hiérarchie reposent sur les contrôles simulés. |
| F3 — acquittement et erreurs d'interactions | Corrigé | `apps/bot/src/interactions.ts`, tests bot des états defer/reply/editReply et rejets; gestion contrôlée de l'arrêt | Le superviseur de production doit redémarrer/alerter; Compose de développement n'est pas une supervision éprouvée. |
| F4 — proxy et quotas | Corrigé dans le code; condition d'hébergement | `apps/api/src/index.ts`, `apps/dashboard/app/api/proxy.ts`, tests d'intégration quotas et chaîne signée | L'ingress/WAF réel doit écraser l'identité source et protéger l'API; limites Fastify par instance. |
| F5 — échéances après restauration ancienne | Corrigé selon procédure supportée | `packages/db/src/restore-quarantine.ts`; tests PostgreSQL et guide `docs/BACKUP-RESTORE-VERIFICATION-2026-10-15.md` | La procédure exige rotation effective de l'epoch externe; une restauration hors procédure n'est pas détectée universellement. |
| F6 — failed/uncertain selon phase | Corrigé | `packages/moderation/src/executor.ts`; tests de phase/reaper | Aucun contrat atomique entre Discord et PostgreSQL; mutation ambiguë reste à réconcilier humainement. |
| F7 — générations et décisions concurrentes | Corrigé avec ambiguïtés externes explicites | Tests PostgreSQL de production executor/expiration, dont tests F7 dédiés et barrières de concurrence dans `packages/moderation`; registre `docs/REVIEW-F1-F14-2026-10-15.md` | Le contrôle SQL final ne peut fermer la course entre dernière lecture et appel Discord. Aucun « exactly once » externe n'est promis. |
| F8 — désactivation de module | Décision produit validée | `docs/ARCHITECTURE.md`, tests service/worker : désactivation bloque les nouvelles demandes, mais les actions acceptées et échéances confirmées continuent | Aucun arrêt d'urgence des opérations déjà acceptées n'est livré. |
| F9 — erreurs API et cookie OAuth incomplet | Corrigé | `apps/api/src/error-details.ts`, `packages/contracts/src/error-details.ts`, tests de sortie réelle des loggers API/bot et intégration validation grant | Les messages d'exception bruts sont omis; collecte diagnostique volontairement limitée. Pas de détection universelle de secrets arbitraires. |
| F10 — pagination des guildes OAuth | Infirmé comme défaut | `apps/api/src/index.ts` demande jusqu'à la limite documentée; décision consignée dans `docs/REVIEW-F1-F14-2026-10-15.md` avec source Discord | La liste est bornée par l'API Discord; un utilisateur au-delà du maximum documenté n'obtient pas une pagination inexistante pour cet endpoint. |
| F11 — Redis/BullMQ et migrations en CI | Corrigé | `.github/workflows/ci.yml`, suites d'intégration Redis/BullMQ et contrôle schéma/migrations | La CI utilise Redis/PostgreSQL jetables; elle ne prouve pas les caractéristiques d'un hébergement de production. |
| F12 — Compose, ports et identité d'exécution | Corrigé pour la référence déclarative; déploiement non éprouvé | `deploy/compose.production.yaml`, tests/CI de configuration et `docs/PRODUCTION-REFERENCE.md` | Aucun service public provisionné; secret manager, TLS, stockage distant, alertes et exploitation réelle restent à configurer. |
| F13 — CSP Next | Corrigé pour `script-src`; validation navigateur partielle | `apps/dashboard/proxy.ts`, layout dynamique et contrôle Chrome headless documenté dans `docs/ROADMAP.md` | `style-src 'unsafe-inline'` reste; revue visuelle desktop/mobile à effectuer. |
| F14 — mémoire et cycle de vie Gateway | Mesuré passivement; fermeture du Client attendue avant libération du verrou | Commit `638c8f5`; `docs/F14-GATEWAY-MEMORY-2026-10-17.md`, instantanés agrégés dans `apps/bot/src/index.ts`, tests `apps/bot/test/resource-snapshot.test.mjs` et `apps/bot/test/shutdown-order.test.mjs` | 11 mesures au repos sur une guilde ne démontrent pas la croissance des caches par taille/activité ni une capacité. Pas de charge Gateway/REST représentative ou mémoire cgroup sur l'hébergement. |

## Réserves ciblées ajoutées par les revues

| Sujet | État | Preuve | Limites |
|---|---|---|---|
| Quota par session après validation grant et ordre `/installation-check` | Corrigé | Tests API/PostgreSQL de sessions valides, révoquées, expirées, OAuth incomplet; deux sessions même IP; test de non-régression du hook `preHandler` et limites distinctes | Compteurs en mémoire par instance; `/ready` est un contrôle DB distinct à protéger au niveau réseau. |
| Assainissement des erreurs | Corrigé | Sortie réelle des loggers API/bot, canaris multi-formats, intégration panne grant/503 corrélé | Les textes d'exception sont omis plutôt que filtrés; champs contextuels futurs doivent rester explicitement autorisés. |
| Sauvegarde et reprise | Corrigé pour le protocole documenté | `deploy/backup-postgres.ps1`, CI PostgreSQL 17 sauvegarde/restauration réelle, tests ACL/échecs et gate/quarantaine dans `packages/db`; rapport de vérification référencé ci-dessous | Epoch stocké hors snapshot indispensable; archive locale seule non externalisée; taille/RPO/RTO de production non mesurés. |
| Budgets mémoire et saturation Redis | Corrigé et éprouvé dans des limites de test | `deploy/compose.production.yaml`, intégrations Redis/BullMQ de saturation, AOF, récupération courte/stalled et OOM cgroup; `docs/MEMORY-REDIS-BUDGETS-2026-10-16.md` | Budget/configuration n'est pas une capacité; essais modestes et dépendants de l'hôte, pas de profilage Gateway complet. |
| Canonicalisation et identité IP signée (D1/D2/G1) | Corrigé et test de bout en bout réussi | `packages/contracts/src/client-ip.ts`; `apps/dashboard/app/api/proxy.ts`; `apps/dashboard/app/proxy.test.ts`; `apps/api/test/integration.mjs` avec Next construit, API et ingress local, deux IP source socket distinctes | L'ingress public et son réseau ne sont pas déployés/testés. Un proxy mal configuré peut signer une adresse fausse; NAT partage le quota IP. |

## État de fusion

### Bloqueurs de fusion

Aucun défaut bloquant n'a été identifié dans les constats F1–F14 et les tranches ciblées. Sur le commit F14 `638c8f5bb181ea0538e900f2f747eaf669fa863f`, `validate` et `backup-script` du run #113 sont réussis. Les checks du commit documentaire actuel doivent aussi rester verts avant toute fusion. Aucun blocage de code connu n'est identifié; la PR reste ouverte, sans fusion automatique. Cette conclusion n'est pas une validation de mise en production.

### Conditions avant production

- **Validé localement / par CI sur le code F14** : typecheck, lint, build et suite workspace sous Node 24.19.0; CI #113 (`validate` et `backup-script`) sur le commit F14 `638c8f5bb181ea0538e900f2f747eaf669fa863f`; connexion Gateway réelle passive au seul serveur privé autorisé pendant environ dix minutes; mesures RSS/heap/cache et test à barrière de l'ordre d'arrêt. Les tests automatisés Discord utilisent des adaptateurs contrôlés. Les parcours manuels confirmés par le propriétaire sont listés dans `FEATURE-MATRIX.md`.
- **Vérification de livraison** : l'état des checks du commit documentaire le plus récent est celui affiché dans [Checks de la PR #3](https://github.com/nzolevrai/veyrobot/pull/3/checks); le run #113 cité ci-dessus n'est pas présenté comme un check de ce commit ultérieur.
- **Réservé au futur hébergement AWS** : réseau/VPC et groupes de sécurité, ingress/WAF/TLS et écrasement des en-têtes, accès privé à l'API et aux bases, gestion/rotation des secrets, plafonds mémoire et marge de l'hôte, supervision/redémarrage/alertes, sauvegardes externes chiffrées et restauration/quarantaine avec epoch externe. Aucun de ces éléments AWS n'a été provisionné ou testé; aucun service AWS n'a été créé.
- Faire une revue visuelle du Dashboard desktop/mobile; mesurer les caches Gateway sur une population et tailles de guildes représentatives et suivre la croissance de `ModerationCase` (purge toujours désactivée).
- Conserver le compromis CSP documenté : `script-src` sans `unsafe-inline`, `style-src` le permet encore.

### Évolutions conditionnées aux mesures

- Coordination REST multi-processus/sharding uniquement si une saturation mesurée justifie de dépasser le processus bot unique.
- Tombstones et archivage de dossiers avant toute politique de purge; le coût de stockage croît avec les opérations.
- Revoir quotas, admission, budgets et profils après une campagne représentative de trafic HTTP et de tailles de guildes sur l'hébergement cible.

## Documents de preuve

- [Architecture](ARCHITECTURE.md) et [exploitation](OPERATIONS.md)
- [Registre F1–F14](REVIEW-F1-F14-2026-10-15.md)
- [Restauration](BACKUP-RESTORE-VERIFICATION-2026-10-15.md)
- [Budgets mémoire/Redis](MEMORY-REDIS-BUDGETS-2026-10-16.md)
- [Chaîne IP de confiance](IP-TRUST-CHAIN.md)
- [Mesures de performance](PERFORMANCE-BASELINE.md)
- [Mesure F14 Gateway](F14-GATEWAY-MEMORY-2026-10-17.md)
