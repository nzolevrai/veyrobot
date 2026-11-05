# Mise à jour du runtime Node — 5 novembre 2026

## Décision

Le dépôt épingle Node.js 24.22.2 LTS, publié le 28 octobre 2026. La version 24.22.1 du 21 octobre était bien le correctif de sécurité visé au début de cette tranche; 24.22.2 est le patch LTS plus récent disponible à la vérification. Le dépôt ne passe pas à Node 26 et le lockfile pnpm n'a pas changé.

La source officielle décrit 24.22.2 comme une version LTS avec des backports V8 et une correction de contexte asynchrone des écritures stream : <https://nodejs.org/en/blog/release/v24.22.2>. Le correctif de sécurité du 21 octobre et les vulnérabilités couvertes par 24.22.1 sont consignés par le projet Node ici : <https://nodejs.org/en/blog/vulnerability/october-2026-security-releases>.

## Fichiers alignés

- `.node-version`, `.nvmrc`, `package.json` (`engines`), CI et les deux étapes du `Dockerfile` fixent 24.22.2.
- `tools/pnpm.ps1` vérifie le pin et installe, si nécessaire, l'archive Windows dans `%LOCALAPPDATA%\VeyroBot\runtime`. Les SHA-256 x64 et arm64 viennent de la page SHASUMS officielle de la version. Le shim Corepack reste limité au processus VeyroBot.
- Le lanceur NVDA, le contrôle de runtime de l'intégration de restauration, le profil de ressources, README, AGENTS.md, ROADMAP et le document de régression courante ont été alignés. Les anciens rapports de mesures et la référence historique de revue ne sont pas modifiés.
- L'image `node:24.22.2-bookworm-slim` existe dans le registre officiel. Son exécution directe renvoie `v24.22.2`; l'image applicative finale n'a pas pu être construite, voir les validations.

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

- `tools/pnpm.ps1 build` et une nouvelle tentative du build dashboard ont compilé le code, fini TypeScript et généré les pages, puis échoué avec `SecurityFatalError` : la version Next.js installée est signalée vulnérable. Aucune dépendance n'a été modifiée, conformément au périmètre Node uniquement. En conséquence, le build applicatif final, l'image VeyroBot finale et le contrôle Node exécuté dans cette image ne sont pas validés. La CI sur le commit doit confirmer ce blocage dans son environnement; un correctif Next séparé sera nécessaire si elle reproduit l'échec.
- `deploy/backup-restore.integration.mjs` s'est arrêté avant sauvegarde car `powershell.exe` ne pouvait pas charger `Microsoft.PowerShell.Security`/`Get-Acl` dans cet environnement. `deploy/test-backup-postgres.ps1` a échoué sur l'absence d'un overload `Directory.CreateDirectory(path, mode)` dans le PowerShell utilisé localement. Ces erreurs de compatibilité/exécution Windows ne sont pas des erreurs Node; les workflows dédiés CI restent nécessaires.
- La construction de l'image applicative complète et les intégrations dépendantes de celle-ci n'ont pas été exécutées localement après l'alerte Next.

## Historique de revue

La base locale de cette intervention était `9a3c9d194320a037f7c7318e6ceacb2325581e1f`, le commit que la synthèse de revue globale de Claude indiquait comme révisé. `1ace6dc01ccfac57210bedfaa070115bdac5dda1` est un commit antérieur de revue F1–F14, conservé comme référence historique. Ces deux SHA correspondent à des étapes différentes; aucun rapport historique n'a été réécrit pour les rendre identiques.

## Exploitation

Cette mise à jour aligne le runtime local, CI et les bases d'image. Elle ne valide pas un déploiement AWS, une configuration TLS/proxy publique, une connexion Gateway réelle, ni l'image applicative finale tant que le build Next est bloqué. Les mesures historiques gardent leur version Node réellement utilisée.
