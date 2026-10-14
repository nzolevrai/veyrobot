# Préparer une validation Discord réelle

Les tests unitaires et PostgreSQL fonctionnent sans application Discord. OAuth, Gateway et commandes slash nécessitent les identifiants d’une application de test et un serveur de test que vous administrez. Le bot ne doit pas être essayé dans un serveur de production pendant cette étape.

## Créer l’application de test

1. Dans le [Discord Developer Portal](https://discord.com/developers/applications), créez une application dédiée aux essais. Dans **Bot**, créez/réinitialisez son token et gardez-le uniquement dans votre gestionnaire local de secrets. Ne l’ajoutez ni au dépôt ni à une conversation.
2. Notez l’Application ID et le Client Secret depuis **OAuth2 / General**. Dans **OAuth2 / Redirects**, ajoutez exactement `http://localhost:4000/oauth/discord/callback`.
3. Dans **Bot / Privileged Gateway Intents**, aucun intent privilégié n’est requis. Le client ne demande que `Guilds`. Les commandes s’exécutent par interactions; le contenu des messages et la liste des membres ne sont pas activés.
4. Dans **Installation**, activez l’installation sur serveur (Guild Install). Pour ce premier essai limité à la présence et à `/warn`, sélectionnez les scopes `bot` et `applications.commands`, puis laissez les permissions du bot à **Aucune** (`permissions=0`). Les commandes d’application ne requièrent pas de permissions du bot, et `/warn` ne modifie pas Discord. Le compte qui l’utilise doit être propriétaire du serveur ou posséder `Moderate Members`. N’accordez pas `Administrator`. Les permissions supplémentaires ne seront nécessaires que pour tester ultérieurement les sanctions ou actions de salon; à ce moment-là, accordez uniquement celles du module testé et placez le rôle du bot au-dessus des cibles concernées.
5. Créez un serveur Discord de test privé, ajoutez-y au moins un compte de test non privilégié, puis installez l’application uniquement dans ce serveur. Copiez l’identifiant du serveur de test avec le mode développeur Discord.

OAuth du dashboard utilise `identify guilds`; un serveur s’affiche seulement si le compte en est propriétaire ou possède **Gérer le serveur**. Pour éviter tout essai de sanction pendant cette préparation, installe le bot uniquement dans le serveur privé de test et n’utilise pas les commandes autres que `/warn`. La liste OAuth est mise en cache au plus dix secondes; le cache est borné.

## Configuration locale

Depuis la racine, copiez `.env.example` vers `.env` et remplissez localement `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` et `DISCORD_TEST_GUILD_ID`. Générez `SESSION_KEY` avec `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Les URL locales, PostgreSQL et Redis ont des valeurs de développement dans le modèle. Ne publiez jamais `.env`.

Le démarrage et le script de déploiement signalent les noms de variables manquantes/invalides sans afficher leurs valeurs. La validation de format d’un snowflake vérifie seulement sa forme; Discord validera l’accès réel.

```powershell
docker compose up -d postgres redis
corepack pnpm db:migrate
corepack pnpm dev
```

Ouvrez `http://localhost:3000`, connectez-vous via Discord, sélectionnez le serveur de test et consultez l’état du bot. Pour publier les commandes de test, dans un second terminal:

```powershell
corepack pnpm --filter @veyrobot/bot deploy:commands
```

Le script requiert `DISCORD_TEST_GUILD_ID` et utilise exclusivement la route Discord des commandes propres à ce serveur. Son écriture ne touche pas aux commandes globales ni aux commandes des autres serveurs. Dans le serveur de test, exécutez `/warn` sur un compte de test et vérifiez le même identifiant de dossier dans le dashboard.

Les commandes `/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban` et `/tempban` y seront également visibles. Ne les exécutez pas sur un membre réel sans instruction explicite portant sur cette action et cette cible. Les tests locaux couvrent leurs contrôles et résultats avec des doubles, sans envoyer de sanction Discord.

## Limites de la preuve d’expiration

Le ban temporaire stocke en base son échéance et un marqueur aléatoire inclus dans la raison du ban Discord. À échéance, le worker relit la ressource de ban et ne débannit que si la raison contient encore ce marqueur. Une raison absente ou modifiée, un utilisateur déjà débanni, ou une erreur réseau devient un état `à vérifier`; aucun second débannissement n’est tenté automatiquement. Un administrateur peut toutefois réutiliser/copier le marqueur, ou changer la décision sans que Discord expose un identifiant de génération de ban. Cette comparaison réduit le risque sans prouver l’historique complet. Les changements externes et les actions déjà acceptées par Discord dont la réponse se perd nécessitent donc une vérification humaine.

Discord documente le champ `reason` dans l’objet Ban, le droit `BAN_MEMBERS` et la route Get Guild Ban. Les commandes de serveur sont isolées par guilde et prennent effet immédiatement. Voir [Guild Resource](https://docs.discord.com/developers/resources/guild), [Application Commands](https://docs.discord.com/developers/docs/interactions/slash-commands), [OAuth2](https://docs.discord.com/developers/topics/oauth2) et [Permissions](https://docs.discord.com/developers/topics/permissions).
