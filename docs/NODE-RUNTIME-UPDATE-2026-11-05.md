# Mise à jour du runtime Node — 5 novembre 2026

## Décision

Le dépôt épingle Node.js 24.22.2 LTS, publié le 28 octobre 2026. La version 24.22.1 du 21 octobre était bien le correctif de sécurité visé au début de cette tranche; 24.22.2 est le patch LTS plus récent disponible à la vérification. Le dépôt ne passe pas à Node 26 et le lockfile pnpm n'a pas changé.

La source officielle décrit 24.22.2 comme une version LTS avec des backports V8 et une correction de contexte asynchrone des écritures stream : <https://nodejs.org/en/blog/release/v24.22.2>. Le correctif de sécurité du 21 octobre et les vulnérabilités couvertes par 24.22.1 sont consignés par le projet Node ici : <https://nodejs.org/en/blog/vulnerability/october-2026-security-releases>.

## Fichiers alignés

- `.node-version`, `.nvmrc`, `package.json` (`engines`), CI et les deux étapes du `Dockerfile` fixent 24.22.2.
- `tools/pnpm.ps1` vérifie le pin et installe, si nécessaire, l'archive Windows dans `%LOCALAPPDATA%\VeyroBot\runtime`. Les SHA-256 x64 et arm64 viennent de la page SHASUMS officielle de la version. Le shim Corepack reste limité au processus VeyroBot.
- Le lanceur NVDA, le contrôle de runtime de l'intégration de restauration, le profil de ressources, README, AGENTS.md, ROADMAP et le document de régression courante ont été alignés. Les anciens rapports de mesures et la référence historique de revue ne sont pas modifiés.
- L'image `node:24.22.2-bookworm-slim` existe dans le registre officiel. Son exécution directe renvoie `v24.22.2`. Après le correctif Next.js documenté ci-dessous, les images applicatives ont aussi été construites et démarrées dans un Compose jetable; le processus bot y utilisait un worker simulé sans Client/Gateway Discord.

## Environnement et espace disque

Le diagnostic initial a trouvé 40,74 Gio libres sur C:, aucun worktree temporaire Git, `apps/dashboard/.next` généré (363 495 500 octets) et des sorties `dist` reproductibles de moins de 1 Mio chacune. Les caches Firefox et les rapports présents dans `%LOCALAPPDATA%\Temp\veyrobot-*` ont été conservés. Aucun fichier de source, capture, rapport, runtime antérieur, donnée utilisateur ou volume PostgreSQL/Redis n'a été supprimé. L'espace libre observé ensuite était 40,86 Gio.

Après démarrage de Docker Desktop 29.8.2, `docker system df` indiquait 23,45 Gio d'images, 32,01 Gio de cache de build et 4,756 Gio de volumes locaux. Aucun prune, nettoyage de cache partagé ou suppression de volume n'a été effectué. Les conteneurs VeyroBot de développement et leurs volumes ont été préservés. Les deux conteneurs de test portaient le label `com.veyrobot.scope=node-security-update`; PostgreSQL utilisait tmpfs. L'image Redis a créé son volume anonyme déclaré `/data`, même avec RDB/AOF désactivés. Je l'ai laissé intact après l'arrêt du conteneur conformément à la consigne de ne supprimer aucun volume.

Docker Desktop a relancé automatiquement `bot-discord-bot-1`, configuré par le Compose local; il est ensuite resté en redémarrage parce que les conteneurs PostgreSQL et Redis de développement étaient arrêtés. Je n'ai lu ni ses logs ni ses variables d'environnement, je ne l'ai pas arrêté et aucun test de cette tranche ne l'a utilisé. Le worker de tous les tests était simulé.

## Vérifications locales

Environnement : Windows x64, Node global laissé inchangé, Node de projet `v24.22.2`, pnpm `10.18.3`, PostgreSQL `17.11` et Redis `7.4.11` isolés. Les URL de test utilisaient des identifiants fictifs et des ports loopback temporaires. Aucun bot réel ni mutation Discord n'a été lancé par ces essais.

Réussis :

- `tools/pnpm.ps1 --version` et `tools/pnpm.ps1 exec node --version` : pnpm `10.18.3`, Node `v24.22.2`.
- `tools/pnpm.ps1 install --frozen-lockfile` : réussi, lockfile inchangé.
- `tools/pnpm.ps1 db:generate`, `db:migrate` : client Prisma généré et 14 migrations appliquées sur la base jetable; `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` : aucun écart.
- `tools/pnpm.ps1 typecheck`, `lint` et `test` : réussis. La suite a exécuté les intégrations PostgreSQL/Redis/API et le parcours Chromium construit; les échanges Discord/OAuth étaient simulés.
- Intégration navigateur Firefox construite avec PostgreSQL isolé : réussie, incluant navigation, paramètres, erreur 429 simulée, conservation des dossiers et déconnexion.
- `deploy/http-performance.integration.mjs` : réussi, 145 requêtes offertes, 132 acceptées, 13 refus d'admission 429, 131 demandes uniques terminées; charge locale avec adaptateur Discord contrôlé, sans capacité Discord réelle déduite.
- `deploy/bot-lifecycle.integration.mjs` : réussi avec Gateway simulé et trois cycles de reconnexion. L'appel initial via le lanceur standard n'a pas transmis ses variables locales au sous-processus du banc; la relance a utilisé un `PATH` limité au processus avec Node 24.22.2 et Corepack, sans changer les réglages de la machine. Le nombre de timers est resté à six, le pool PostgreSQL à une connexion, les caches de membres et bans à zéro, puis le pool et les timers ont été fermés à l'arrêt.
- `deploy/redis-saturation.integration.mjs` et `deploy/redis-memory.integration.mjs` : réussis, y compris les refus Redis, les reprises BullMQ, le test OOM cgroup isolé et la reprise du témoin AOF. Ces chiffres concernent leurs scénarios dédiés, pas le dimensionnement de toute l'application.
- `docker manifest inspect` et `docker pull node:24.22.2-bookworm-slim` : réussis; le conteneur de base a renvoyé `v24.22.2`.

Échecs et limites observés :

- **Fait historique avant la tranche Next.js :** sous Node `v24.22.2`, Next.js `16.4.0` a terminé compilation, TypeScript et génération des pages, puis le build a échoué avec le message `Error [SecurityFatalError]: Your version of Next.js is affected by a known security vulnerability.` Le message de Next indiquait que la commande s'arrêtait pour afficher la recommandation et citait l'endpoint npm `/-/npm/v1/security/advisories/bulk`. Le même résultat a été reproduit sur le commit `6e33758` avant la mise à jour ci-dessous.
- La différence avec la CI est expliquée par le chemin du CLI Next 16.4.0, et non par une désactivation de la protection : le dépôt utilisait sa politique `experimental.agentUpgrade: security` par défaut; le processus local a été identifié comme `codex`, ce qui fait exécuter l'évaluation de sécurité de l'agent et produire le `SecurityFatalError`. Dans `next/dist/build/index.js`, le build CI non interactif appelle le rappel sans signal de terminal; dans `nudge.js`, l'évaluation est abandonnée lorsqu'aucun agent n'est détecté et qu'il n'y a pas de terminal interactif. La CI verte n'avait donc pas effectué la même vérification de version.
- Les deux exécutions GitHub Actions sur le commit exact `6e33758f6acaa500491bfbb66b3bd996ea741540` ont ensuite réussi : [run push 42116781923](https://github.com/nzolevrai/veyrobot/actions/runs/42116781923) et [run PR 42116795964](https://github.com/nzolevrai/veyrobot/actions/runs/42116795964). Elles valident les commandes et intégrations CI de ce SHA, mais ne changent pas le fait que leur build n'avait pas déclenché le garde-fou d'agent local.
- `deploy/backup-restore.integration.mjs` s'est arrêté avant sauvegarde car `powershell.exe` ne pouvait pas charger `Microsoft.PowerShell.Security`/`Get-Acl` dans cet environnement. `deploy/test-backup-postgres.ps1` a échoué sur l'absence d'un overload `Directory.CreateDirectory(path, mode)` dans le PowerShell utilisé localement. Ces erreurs de compatibilité/exécution Windows ne sont pas des erreurs Node; les workflows dédiés CI restent nécessaires.
- La construction de l'image applicative complète et les intégrations dépendantes de celle-ci n'avaient pas été exécutées localement au moment du premier rapport; elles ont été exécutées avec Next.js 16.4.5 dans la section suivante.

## Historique de revue

La base locale de cette intervention était `9a3c9d194320a037f7c7318e6ceacb2325581e1f`, le commit que la synthèse de revue globale de Claude indiquait comme révisé. `1ace6dc01ccfac57210bedfaa070115bdac5dda1` est un commit antérieur de revue F1–F14, conservé comme référence historique. Ces deux SHA correspondent à des étapes différentes; aucun rapport historique n'a été réécrit pour les rendre identiques.

## Exploitation

Cette mise à jour aligne le runtime local, CI et les bases d'image. Elle ne valide pas un déploiement AWS, une configuration TLS/proxy publique ni une connexion Gateway réelle. Les mesures historiques gardent leur version Node réellement utilisée.

## Correctif de sécurité Next.js — 5 novembre 2026

### Décision et portée des avis

La version stable retenue est Next.js 16.4.5, publiée dans le bulletin officiel de sécurité du 3 novembre. Le projet était sur la branche 16 active et la mise à jour ne change pas de major.

- [GHSA-673q-mjm6-r5xr](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr) touche Next 16 jusqu'à 16.4.0 inclus. Le scénario décrit les Cache Components/App Router et une fonction use cache retournant plusieurs typed arrays. Le bulletin précise qu'il n'existe pas de contournement connu et recommande la mise à jour même si l'application ne déclare pas une telle fonction. Une recherche du code dashboard n'a trouvé aucun use cache; cela réduit la correspondance fonctionnelle au scénario, sans remplacer le correctif.
- [GHSA-2464-fhr4-w9xw](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw) touche Next 16.0.0 à 16.4.0; le bulletin décrit un RCE dans Image Optimization avec SVG sur Linux glibc. Le code dashboard ne référence pas next/image, et le lockfile avait déjà sharp 0.35.5, qui satisfait le seuil de contournement sharp >=0.35.5 de l'avis. Le correctif Next reste appliqué car le traitement de l'image fait partie du runtime framework et la route ne doit pas dépendre d'une protection indirecte par seule version transitive.
- L'avis React amont [GHSA-xqc2-xf4c-x3h3](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3) porte sur les paquets react-server-dom-*, pas sur react ou react-dom eux-mêmes. Ils ne sont pas installés séparément dans le graphe pnpm; Next fournit son intégration RSC. Aucun changement direct de React n'était nécessaire dans cette tranche. Next 16.4.5 est le runtime corrigé.
- Le bulletin officiel [Next.js November 2026 Security Release](https://nextjs.org/blog/november-2026-security-release) publie 16.4.5 et 15.5.29; 16.4.5 corrige aussi les avis supplémentaires listés pour novembre. La documentation de support confirme que Next 16 est la branche Active LTS.

apps/dashboard/package.json a été relevé de ^16.4.0 à ^16.4.5. pnpm-lock.yaml verrouille Next et ses binaires @next/env/SWC en 16.4.5; React, React DOM et sharp 0.35.5 sont inchangés. Aucun langage, design, lockfile de runtime Node ou autre architecture n'a changé.

### Vérifications locales après mise à jour

Environnement vérifié par le lanceur du dépôt : Node v24.22.2, pnpm 10.18.3, Windows x64, Docker Desktop 29.8.2, PostgreSQL 17-alpine et Redis 7-alpine jetables sur loopback. Les identifiants OAuth/Discord des conteneurs Compose étaient fictifs. Le bot de développement bot-discord-bot-1 était en redémarrage alors que ses dépendances Compose étaient arrêtées; seul ce conteneur a été arrêté. Son inspection indiquait aucun montage de volume; sa configuration et toute donnée durable éventuelle n'ont pas été supprimées.

Résultats :

- tools/pnpm.ps1 install --frozen-lockfile a réussi après la modification; aucune mise à jour non nécessaire de React ou sharp n'a été faite.
- db:generate, db:migrate (14 migrations sur PostgreSQL 17 isolé) et prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code ont réussi; aucun écart schéma/migrations.
- tools/pnpm.ps1 typecheck, lint, build et test ont réussi. Le test complet a exécuté les intégrations PostgreSQL/Redis et API/Next, le parcours Chromium, ainsi que les tests de packages et du dashboard. Le dashboard a ensuite passé séparément le même parcours sous Firefox Playwright 153.0.
- Le parcours navigateur de production a vérifié le nonce CSP par réponse, l'absence de unsafe-inline dans script-src, les routes OAuth simulées, la transmission et révocation des cookies, la déconnexion, les paramètres et les erreurs 429 simulées. apps/dashboard/tools/check-csp-browser.mjs a aussi réussi sous Chrome : rendu Next, nonce présent et aucune violation CSP détectée.
- deploy/production-resource-profile.integration.mjs a construit puis démarré les images de production dans un projet Compose temporaire. Les conteneurs PostgreSQL, Redis, API, dashboard et bot ont atteint leur état prêt; chaque conteneur Node contrôlé renvoyait v24.22.2. L'essai a confirmé les limites cgroup déclarées. Le worker bot était le harnais de l'intégration de production, sans Client/Gateway, avec adaptateur Discord simulé; cette mesure ne valide pas une connexion Gateway réelle. Les ressources du projet Compose temporaire ont été nettoyées par le scénario; les ressources de développement n'ont pas été touchées.
- Le contrôle du CLI Next n'a pas été contourné : après mise à jour, le build Next 16.4.5 s'est terminé normalement sous l'environnement local qui avait déclenché le SecurityFatalError sur 16.4.0.

tools/pnpm.ps1 audit --prod a toujours signalé 17 avis de dépendances de production dans d'autres branches du workspace (6 high, 7 moderate, 4 low). La sortie JSON ne contenait aucun avis sur next, sharp, react, react-dom ou les paquets react-server-dom-*. Ce scan global reste une liste de suivi distincte; ces dépendances étrangères à la tranche n'ont pas été modifiées ici.

Les builds locaux échoués sur Next 16.4.0 restent consignés comme historique; ils ne sont pas remplacés par un récit de réussite rétroactif. Aucun appel Discord réel, déploiement public ou fusion n'a été effectué.
