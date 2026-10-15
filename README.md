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

Après création de `.env` et configuration du Developer Portal, `docker compose --profile app up --build` lance PostgreSQL, Redis, une migration puis l'API, le bot et le dashboard. Le Compose racine est réservé au développement local : ses ports sont liés à `127.0.0.1`, ses identifiants sont locaux et l'API utilise `NODE_ENV=development` (cookies non `Secure`). La référence mono-hôte sans déploiement public est [deploy/compose.production.yaml](deploy/compose.production.yaml) avec [son guide](docs/PRODUCTION-REFERENCE.md) et son [modèle de variables externes](deploy/production.env.example). Elle exige un ingress TLS qui écrase `X-Real-IP`, un plafond WAF global, un secret HMAC commun mais externe à Next/API et des sauvegardes planifiées hors hôte. L'image runtime s'exécute avec l'utilisateur non-root `node`. La référence n'a pas été déployée; elle ne constitue pas une validation d'exploitation.

Dans le dashboard, tous les modules d’action sont désactivés par défaut, même pour un serveur déjà connu. Activez **Avertissements** sur la page `/dashboard/[guildId]/warnings`, puis sauvegardez avant d’utiliser `/warn` ou son formulaire. Le lien d’invitation demande `permissions=0` pour ce parcours initial; les actions Discord supplémentaires nécessitent d’accorder ensuite au bot les permissions indiquées dans la matrice. Une désactivation n’annule pas les demandes déjà engagées ni les échéances de bans temporaires confirmées.

## Vérification

`corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm build`. `DATABASE_URL` doit être définie même pour la suite simulée, car le package DB l'exige à l'import ; une URL factice convient si l'intégration est désactivée. L'intégration PostgreSQL s'exécute seulement avec migration appliquée et `RUN_POSTGRES_INTEGRATION=1`; elle couvre notamment les dossiers et la configuration par serveur. CI démarre PostgreSQL 17 et lance la migration avant les tests. Les tests des actions Discord utilisent des doubles; ils ne contactent aucun serveur. La validation visuelle et les parcours Discord réels sont des vérifications séparées.

Les demandes actives de modération sont limitées à 5 000 globalement et 100 par serveur par défaut (`MAX_PENDING_GLOBAL`, `MAX_PENDING_PER_GUILD`) ; une file pleine répond 429. Une opération acceptée reste dans PostgreSQL même si Redis est indisponible. Une seule instance bot peut tenir le verrou de démarrage PostgreSQL avec le même token. `GET /health` est la liveness API ; `GET /ready` vérifie PostgreSQL. Le nettoyage par lots se lance explicitement avec `corepack pnpm --filter @veyrobot/db maintenance:retention` sur une base sauvegardée ; voir [la politique et les limites](docs/RELIABILITY-REVIEW-2026-10-14.md).

Le proxy dashboard refuse les corps API dépassant 1 MiB pendant la lecture et limite l'appel amont à `API_PROXY_TIMEOUT_MS` (10 000 ms par défaut). L'annulation du navigateur est transmise à l'amont. En production, les scripts Next portent un nonce CSP unique sans `unsafe-inline` dans `script-src`; ce rendu dynamique limite le cache HTML. Des instantanés opérationnels agrégés sont journalisés chaque minute par l'API et le bot ; ils ne remplacent pas une supervision persistante. Voir [la synthèse des limites du socle](docs/FOUNDATION-QUALITY-REVIEW-2026-10-15.md).

## Limites actuelles

Le propriétaire rapporte avoir validé manuellement sur son serveur privé OAuth, navigation, actualisation, déconnexion, refus d'accès après déconnexion, paramètres persistants, activation/désactivation, avertissements du dashboard et `/warn`, timeout/retrait immédiat, slowmode et restauration. Cette déclaration n'est pas une reproduction indépendante. Ban, unban, kick, purge et autres actions non citées ne sont pas validées en réel. Un contrôle Chrome headless du dashboard construit valide la CSP; le contrôle visuel desktop/mobile reste à faire. La purge de dossiers d'action reste désactivée et la croissance est à surveiller. Il manque encore softban, surnoms, actions vocales, AutoMod, règles automatiques, raid, équipe, rapports, recours et facturation. Le worker bot unique n'est pas un déploiement sharded ou multi-processus mesuré.

Lire [l'architecture](docs/ARCHITECTURE.md), la [revue de fiabilité et les mesures](docs/RELIABILITY-REVIEW-2026-10-14.md), le [guide d'exploitation](docs/OPERATIONS.md), la [référence de déploiement](docs/PRODUCTION-REFERENCE.md), le [registre des limites ouvertes](docs/FOUNDATION-QUALITY-REVIEW-2026-10-15.md), la [convention de module](docs/MODULE-CONVENTION.md), la [matrice des fonctionnalités](docs/FEATURE-MATRIX.md), la [roadmap/reprise](docs/ROADMAP.md) et la [configuration du serveur Discord de test](docs/DISCORD-TEST-SETUP.md). Les sources Discord doivent être revérifiées avant chaque lancement public; aucun nombre de serveurs ni garantie de capacité n'est annoncé.
