# VeyroBot Discord

Plateforme de modération en cours de réalisation. Le socle contient OAuth/dashboard, dossiers d'avertissement partagés avec `/warn`, timeout, retrait du timeout, kick, ban/unban et ban temporaire via PostgreSQL, BullMQ, dashboard et commandes slash. Les sanctions réelles ne sont pas lancées par les tests.

## Prérequis

- Node.js 24.17.0 ou plus récent (minimum officiel de discord.js 14.27.0); `.node-version` et `.nvmrc` sélectionnent le patch LTS courant 24.21.0. pnpm refuse les versions sous le minimum.
- pnpm 10.18.3, Docker Desktop avec moteur Linux ou PostgreSQL 17 + Redis 7.
- Application Discord Developer Portal, client OAuth, token bot et un serveur de test pour les parcours live.

## Développement local

1. Installer/sélectionner Node 24.17+ avec nvm-windows, fnm ou le gestionnaire de versions de votre choix; vérifier `node --version`.
2. `corepack prepare pnpm@10.18.3 --activate`; copier `.env.example` vers `.env` puis définir les valeurs ci-dessous. Ce fichier est exclu de Git.
3. Suivre [la préparation Discord de test](docs/DISCORD-TEST-SETUP.md). Enregistrer exactement `http://localhost:4000/oauth/discord/callback` comme URI de redirection. OAuth utilise `identify guilds`; le bot demande uniquement l'intent `Guilds` et les permissions `ModerateMembers`, `KickMembers`, `BanMembers` (pas Administrator).
4. Pour l'infrastructure seulement : `docker compose up -d postgres redis`; puis `corepack pnpm install`, `corepack pnpm db:generate`, `corepack pnpm db:migrate`.
5. Renseigner aussi `DISCORD_TEST_GUILD_ID`; `corepack pnpm --filter @veyrobot/bot deploy:commands` publie exclusivement dans cette guilde de test. Puis `corepack pnpm dev`; ouvrir `http://localhost:3000`.

Variables indispensables du fichier `.env` : `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_TEST_GUILD_ID` et `SESSION_KEY`. Générer cette clé localement : `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Ne pas transmettre les secrets par chat, ticket ou commit. `DATABASE_URL` et `REDIS_URL` dans l'exemple visent les services Compose depuis la machine hôte. En cas de configuration absente ou invalide, l'API, le bot et le script de commandes affichent les noms des variables en cause sans afficher leurs valeurs.

La connexion actuelle utilise `corepack.cmd` sous Windows, qui peut lancer le Node installé dans `C:\Program Files\nodejs` même si un autre Node est devant dans `PATH`. Faire les validations avec le Node sélectionné par votre gestionnaire de version; la CI et Docker exécutent Node 24.21.0. Le bot est un processus permanent séparé de l'API et du dashboard.

## Docker Compose application

Après création de `.env` et configuration du Developer Portal, `docker compose --profile app up --build` lance PostgreSQL, Redis, une migration puis l'API, le bot et le dashboard sur les ports 4000/3000. L'image est basée sur `node:24.21.0-bookworm-slim`. Pour une mise à jour, sauvegarder la base, vérifier les migrations, garder l'image précédente pour retour arrière. Sauvegarde de dev : `pg_dump`; tester la restauration dans une base isolée avant production.

Dans le dashboard, tous les modules d’action sont désactivés par défaut, même pour un serveur déjà connu. Activez **Avertissements** sur la page `/dashboard/[guildId]/warnings`, puis sauvegardez avant d’utiliser `/warn` ou son formulaire. Le lien d’invitation demande `permissions=0` pour ce parcours initial; les actions Discord supplémentaires nécessitent d’accorder ensuite au bot les permissions indiquées dans la matrice. Une désactivation n’annule pas les demandes déjà engagées ni les échéances de bans temporaires confirmées.

## Vérification

`corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm build`. `DATABASE_URL` doit être définie même pour la suite simulée, car le package DB l'exige à l'import ; une URL factice convient si l'intégration est désactivée. L'intégration PostgreSQL s'exécute seulement avec migration appliquée et `RUN_POSTGRES_INTEGRATION=1`; elle couvre notamment les dossiers et la configuration par serveur. CI démarre PostgreSQL 17 et lance la migration avant les tests. Les tests des actions Discord utilisent des doubles; ils ne contactent aucun serveur. La validation visuelle et les parcours Discord réels sont des vérifications séparées.

Les demandes actives de modération sont limitées à 5 000 globalement et 100 par serveur par défaut (`MAX_PENDING_GLOBAL`, `MAX_PENDING_PER_GUILD`) ; une file pleine répond 429. Une opération acceptée reste dans PostgreSQL même si Redis est indisponible. Une seule instance bot peut tenir le verrou de démarrage PostgreSQL avec le même token. `GET /health` est la liveness API ; `GET /ready` vérifie PostgreSQL. Le nettoyage par lots se lance explicitement avec `corepack pnpm --filter @veyrobot/db maintenance:retention` sur une base sauvegardée ; voir [la politique et les limites](docs/RELIABILITY-REVIEW-2026-10-14.md).

Le proxy dashboard refuse les corps API dépassant 1 MiB pendant la lecture et limite l'appel amont à `API_PROXY_TIMEOUT_MS` (10 000 ms par défaut). L'annulation du navigateur est transmise à l'amont. Des instantanés opérationnels agrégés sont journalisés chaque minute par l'API et le bot ; ils ne remplacent pas une supervision persistante. Les nouveaux essais de panne, restauration et charge sont dans [les vérifications de reprise](docs/RELIABILITY-VERIFICATION-2026-10-14.md).

## Limites actuelles

PostgreSQL local, migrations et persistance d'avertissement ont été validés. L'utilisateur a précédemment validé OAuth, la sélection de serveur et `/warn` sur son serveur privé ; les nouveaux réglages et la navigation n'ont pas été revalidés en direct. La purge bornée, le slowmode et le verrouillage de salon sont implémentés avec des tests simulés, sans action Discord réelle vérifiée dans cette tranche. Il manque encore softban, surnoms, actions vocales, AutoMod, règles automatiques, raid, équipe, rapports, recours et facturation. Le worker bot unique n'est pas un déploiement sharded ou multi-processus mesuré. Une revue visuelle du dashboard dans le navigateur reste à faire.

Lire [l'architecture](docs/ARCHITECTURE.md), la [revue de fiabilité et les mesures](docs/RELIABILITY-REVIEW-2026-10-14.md), le [guide d'exploitation](docs/OPERATIONS.md), la [convention de module](docs/MODULE-CONVENTION.md), la [matrice des fonctionnalités](docs/FEATURE-MATRIX.md), la [roadmap/reprise](docs/ROADMAP.md) et la [configuration du serveur Discord de test](docs/DISCORD-TEST-SETUP.md). Les sources Discord doivent être revérifiées avant chaque lancement public; aucun nombre de serveurs ni garantie de capacité n'est annoncé.
