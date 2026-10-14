# Régression de connexion des routes (13 octobre 2026)

## Cause vérifiée

Le cookie OAuth émis par l’API est encodé pour son transport HTTP. Dans le nouveau layout serveur Next.js, `cookies().get('veyrobot_session').value` fournit la valeur décodée. Le layout la transmettait telle quelle dans un nouvel en-tête `Cookie` à l’API. Cette représentation était rejetée par `@fastify/secure-session` : l’API renvoyait 401, le layout redirigeait vers `/`, puis l’accueil renvoyait automatiquement vers le premier serveur. Les appels répétés pouvaient atteindre la limite globale de 90 requêtes/minute de l’API et produire des 429 sur `/me` et `/guilds`.

Le test avec OAuth simulé a vérifié que l’API accepte le cookie émis par le callback (200), rejette sa valeur décodée (401), puis que la route Next authentifiée répond 200 une fois la valeur réencodée lors de la transmission serveur vers API. L’accueil ne redirige plus automatiquement : la sélection est explicite.

## Diagnostic sans secrets

Le code et l’identifiant de requête sont renvoyés par l’API dans les réponses d’échec ciblées. Les erreurs de chargement de configuration consignent endpoint, statut, durée, code et identifiant de corrélation quand la réponse API en contient un. Les journaux Fastify retirent les paramètres de requête de l’URL, notamment le code du callback OAuth. Aucun cookie ou jeton n’est écrit dans ces diagnostics.

| Situation | Réponse / affichage |
| --- | --- |
| Session absente ou expirée | 401, retour à la connexion |
| Serveur interdit ou bot absent | 403/404, accès refusé |
| API inaccessible ou en erreur | état stable, session conservée, Réessayer manuel |
| Discord 429 | 429 `DISCORD_RATE_LIMIT`, session conservée |
| Limite API locale | 429 `API_RATE_LIMIT`, session conservée |
| Discord indisponible | 502 `DISCORD_UNAVAILABLE`, session conservée |

La lecture des dossiers ne relance plus immédiatement une requête après chaque échec ; son intervalle reste borné à 30 secondes sur les pages concernées. Les erreurs de configuration n’entraînent aucune nouvelle tentative automatique. `cache: 'no-store'` est utilisé pour les lectures authentifiées du layout.

## Validation

- Lint, vérification TypeScript, suite de tests et builds réussis avec Node 24.17 ou supérieur.
- Test d’intégration PostgreSQL/API/Next : OAuth simulé, serveur autorisé, route directe, actualisation, cookie absent, API arrêtée, 429 Discord, dossiers et persistance. Aucun appel de modération Discord réel.
- HTTP local après redémarrage : `/health` 200 ; `/` 200 ; `/api/me` et `/api/guilds` sans session 401 `SESSION_ABSENT` ; route de serveur sans session 307.

Le navigateur intégré étant indisponible, le parcours OAuth Discord réel et la stabilité visuelle après navigation doivent encore être contrôlés dans le navigateur de l’utilisateur. Ouvrir `http://localhost:3000`, se connecter, choisir le serveur, ouvrir directement `/dashboard/1559536950317289614/overview`, actualiser, naviguer entre deux pages, puis utiliser précédent/suivant. Dans l’onglet Réseau, vérifier que les appels `/api/me`, `/api/guilds` et `/guilds/:id/config` cessent après le chargement, et signaler tout statut d’échec avec `x-request-id`, sans transmettre de cookie ni de code OAuth.
