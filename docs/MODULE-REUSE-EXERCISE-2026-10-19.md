# Exercice de reprise d’un module — 2026-10-19

## Portée et limites de la revue

Exercice effectué à partir du commit `ced415bdbb8631609c03cecafee9351c4dde7ac6`, sur un worktree détaché temporaire. Un module fictif « Aperçu fictif » a traversé contrat/configuration, migration DB, cas d’usage partagé, route API autorisée par serveur, adaptateur bot simulé, page Dashboard et tests. Le code du module n’a pas été intégré à la branche produit. Après les vérifications, son worktree a été retiré de l’inscription Git; Windows a laissé le répertoire temporaire local avec des fichiers ignorés (`node_modules` et sorties de build), car la suppression de ce résidu a été refusée. Aucun conteneur de test ne reste actif.

J’ai une connaissance préalable du dépôt et de ses tests. Cet exercice vérifie que le parcours documenté est réalisable et met en évidence ses points de friction; il ne constitue pas une reprise indépendante par une nouvelle contributrice ou un nouveau contributeur.

## Protocole reproductible

Versions utilisées : Node `v24.21.0`, pnpm `10.18.3`, PostgreSQL `17` isolé et Redis `7` isolé. Les conteneurs avaient des noms propres à l’exercice, des ports liés à `127.0.0.1`, une base vide et aucun volume partagé. Les appels OAuth/Discord de la suite API étaient interceptés par le mock de test. Le bot n’a pas été connecté à Gateway et son adaptateur de l’exercice n’avait pas de client Discord.

Le worktree temporaire a été installé avec `corepack pnpm install --frozen-lockfile --offline`. Après avoir ajouté le code fictif, le schéma et une migration additive, le protocole utilisé était :

```powershell
$env:PATH = "$env:LOCALAPPDATA\VeyroBot\runtime\node-v24.21.0-win-x64;$env:PATH"
$env:DATABASE_URL = 'postgresql://lab:lab-only@127.0.0.1:55432/veyrobot_lab?schema=public'
$env:REDIS_URL = 'redis://127.0.0.1:56379'
$env:RUN_POSTGRES_INTEGRATION = '1'
$env:RUN_REDIS_INTEGRATION = '1'
$env:RUN_DASHBOARD_ROUTE_INTEGRATION = '1'
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm --filter @veyrobot/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
corepack pnpm build
corepack pnpm test
```

`pnpm test` a exécuté les tests unitaires et les intégrations activées; la route Next construite a été servie par l’intégration API existante. Pour reproduire l’exercice lui-même, consulter les étapes et assertions ci-dessous et créer les mêmes fichiers uniquement dans un worktree détaché. Aucun module d’exercice n’est laissé dans les sources du produit.

## Parcours et assertions

- Contrat public : identifiant `module-lab`, configuration typée avec valeur par défaut `enabled: false`.
- DB : `labPreviewEnabled BOOLEAN NOT NULL DEFAULT false`; la migration était additive. Une configuration absente et une nouvelle ligne retournent toutes deux `false`.
- Cas d’usage `packages/moderation` : fonction pure qui refuse un module désactivé et produit un aperçu validé lorsqu’il est activé.
- API : `POST /guilds/:guildId/module-lab/preview` appelle `requireInstalledGuild(..., true)` avant le cas d’usage, puis valide la charge utile et Origin/CSRF. L’intégration a vérifié le refus pour une guilde non autorisée, l’état désactivé, l’activation, le résultat, l’isolation d’une seconde guilde autorisée et le refus après désactivation.
- Bot : un adaptateur de réponse simulé appelle le même cas d’usage. Le test vérifie le refus désactivé, le texte retourné activé et l’absence d’appel quand le module est désactivé. Aucun listener Gateway ni commande slash n’a été enregistré.
- Dashboard : une entrée de catalogue, un interrupteur repris par la sauvegarde de configuration existante et une route sous le layout serveur `dashboard/[guildId]`. L’intégration Next a vérifié l’accès avec cookie, le titre rendu, et la redirection sans session.
- Tests de limites : autorisation/inter-guilde dans l’intégration API, activation par défaut désactivée, changements de configuration, adaptateur simulé, typecheck, frontières/cycles et recherche d’artefacts serveur dans le bundle client.

Les résultats produits par l’exercice étaient : DB `13/13`, contracts `9/9`, moderation `39/39`, API `13/13` pour les tests unitaires cache/IP/diagnostic plus smoke et intégration complète, bot `11/11`, Dashboard `19/19`. Les comptages incluent les tests déjà présents du dépôt, pas seulement ceux du module fictif. L’intégration DB/API utilisait PostgreSQL 17 réel jetable; le chemin bot BullMQ de la suite utilisait Redis 7 réel jetable et son adaptateur Discord contrôlé. Aucun appel Discord réel ni contrôle visuel navigateur du composant fictif n’a eu lieu.

`node tools/check-boundaries.mjs` a vérifié 98 fichiers source sans import interdit ni cycle local. Après build, les chunks navigateur sous `apps/dashboard/.next/static/chunks` ne contenaient ni `moduleLabPreview`, ni `ModuleLabDisabledError`, ni import `@veyrobot/moderation`. Le bundle contenait seulement le contrat public de l’identifiant et la vue cliente.

## Fichiers temporaires du prototype

Le worktree a été désinscrit de Git, mais son répertoire temporaire local avec des fichiers ignorés subsiste; aucun des fichiers ci-dessous n’appartient à la branche ni au commit du présent rapport. Cette liste permet d’examiner le trajet essayé sans intégrer le code fictif ni des artefacts de build :

| Fichier temporaire | Étape examinée |
|---|---|
| `packages/contracts/src/module-lab.ts`, son test et `packages/contracts/package.json` | Identifiant/contrat public, valeur de configuration désactivée, export du sous-chemin et test du contrat. |
| `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261019000000_module_lab/migration.sql`, `packages/db/src/guild-config.ts` et son test | Champ persisté `false` par défaut, migration additive, lecture/écriture de configuration et test de désactivation par défaut. |
| `packages/moderation/src/module-lab.ts`, son test et `packages/moderation/package.json` | Cas d’usage partagé, validation activé/désactivé et export du service. |
| `apps/api/src/module-lab-routes.ts`, `apps/api/src/index.ts`, `apps/api/src/guild-routes.ts`, `apps/api/test/integration.mjs` | Enregistrement de route, autorisation de guilde, validation de requête et intégration PostgreSQL couvrant accès refusé, activation, isolement et désactivation. |
| `apps/bot/src/module-lab-adapter.ts`, `apps/bot/test/module-lab-adapter.test.mjs` | Adaptateur simulé appelant le même cas d’usage et test du comportement désactivé/activé; aucun client Gateway. |
| `apps/dashboard/app/dashboard-types.ts`, `apps/dashboard/app/config-draft.ts` et son test, `apps/dashboard/app/module-registry.ts`, `apps/dashboard/app/route-view.tsx`, `apps/dashboard/app/module-lab-view.tsx`, `apps/dashboard/app/dashboard/[guildId]/module-lab/page.tsx` | Projection UI, conservation du brouillon/version de configuration, route protégée par le layout existant et contrôle de l’absence de code serveur dans les chunks client. |

Les assertions spécifiques sont décrites dans « Parcours et assertions » et les résultats exacts dans « Protocole reproductible ». Les chiffres de suites sont les totaux du dépôt exécutés durant l’exercice; ils ne sont pas le nombre de tests ajoutés par le prototype.

## Ambiguïtés et étapes rencontrées

1. La première formulation de `MODULE-CONVENTION.md` attribuait l’identifiant activable à `packages/contracts`, alors que la source consommée par l’API est `packages/db/src/guild-config.ts` et que le catalogue de présentation est `apps/dashboard/app/module-registry.ts`. Cette ambiguïté documentaire a été corrigée dans cette tranche; elle n’est pas un défaut restant du code.
2. **Échec exploratoire DB → contracts :** la commande qui a échoué était `corepack pnpm --filter @veyrobot/db build`, lancée comme première étape du script racine `corepack pnpm typecheck`. À ce moment, le prototype avait ajouté à la DB un import `@veyrobot/contracts/module-lab`. Le build DB s’exécutait avant `corepack pnpm --filter @veyrobot/contracts build`; la cible déclarée dans `exports` pointait donc vers un artefact `dist` de contracts qui n’avait pas encore été construit. Le message était une résolution impossible du sous-chemin exporté (`Cannot find module '@veyrobot/contracts/module-lab'`). Ce n’était pas une dépendance architecturalement interdite ni un cycle démontré; c’était une dépendance ajoutée sans respecter l’ordre de build courant, avec son artefact de package absent. Une telle dépendance aurait aussi nécessité de déclarer la dépendance dans le manifeste DB et de revoir l’ordre racine. Le prototype a retiré cet import et n’a pas introduit DB → contracts. Après ce retrait, `corepack pnpm typecheck` a passé dans la campagne d’exercice; le problème ne subsiste donc pas dans l’état committé. La convention corrigée demande de revoir ordre de build et duplications ensemble si un contrat de configuration partagé devient nécessaire. Aucun nouveau parcours de build n’est nécessaire pour ce constat : l’absence de la dépendance est vérifiable dans `packages/db/package.json` et le succès du typecheck final a été observé lors de l’exercice.
3. Le module fictif n’avait pas de comportement serveur Discord : son adaptateur bot ne pouvait donc que représenter la frontière d’appel et tester le cas d’usage partagé. Un vrai module qui émettrait des actions doit aussi définir commande/événement, permissions/intents, admission durable, claims et cas d’incertitude prévus par la convention.
4. Le Dashboard a été construit et rendu par serveur, mais l’exercice n’a pas exécuté la validation visuelle clavier/mobile ni un vrai OAuth; la suite a utilisé des sessions et services simulés.

Une incompatibilité `exports` a aussi été rencontrée dans le prototype : TSX chargeait le catalogue client par la condition `require`, alors que le sous-chemin fictif n’exposait que `import`. L’entrée `require` du contrat d’exercice l’a résolue; cela ne révèle pas de défaut dans les exports existants du produit.

## Corrections apportées au dépôt

Le guide a été corrigé pour préciser que les modules activables et leur validation/configuration sont aujourd’hui portés par le package DB, que le catalogue Dashboard est une projection UI séparée, et qu’une migration vers un contrat partagé doit respecter l’ordre de build et supprimer les duplications dans la même tranche. Ce rapport conserve la trace du parcours temporaire et de ses résultats. Aucun code de module, générateur ou nouvel abonnement n’a été ajouté au produit.

## Réévaluation des axes 1 et 2

Les notes ci-dessous évaluent le socle local mono-processus et les critères déjà convenus; la confiance est donnée séparément de la qualité estimée. La démonstration a été réalisée par une personne connaissant déjà le dépôt.

| Axe | Note | Confiance | Éléments qui soutiennent la note | Écart restant vers 9/10 | Travail minimal et clôture observable |
|---|---:|---|---|---|---|
| 1. Architecture et séparation des responsabilités | 9/10 | Moyenne | Le trajet a séparé contrats publics, configuration persistée, règles pures, HTTP/autorisation, adaptateur bot et présentation UI. La migration était additive; l’intégration a couvert isolation/activation; frontières et cycles ont passé. La documentation nomme désormais les propriétaires réels. | Aucun défaut architectural concret vers le seuil 9 n’a été reproduit dans le périmètre local mono-processus. Le contrat de configuration n’est pas centralisé : DB et Dashboard gardent des représentations distinctes, un compromis explicitement documenté plutôt qu’un défaut démontré dans l’exercice. | Aucun changement supplémentaire justifié par cette tranche. Réévaluer seulement si une divergence réelle de schéma/DTO ou une difficulté de changement apparaît. |
| 2. Lisibilité, maintenabilité et ajout d’un module | 9/10 | Moyenne à faible | Le parcours réutilise les conventions et points d’extension existants sans générateur ni nouvelle abstraction. Les tests de service, d’autorisation par guilde, de désactivation, d’adaptateur et de route protégée ont passé; la table des fichiers temporaires permet de reconstituer l’exercice sans conserver son code. | Aucune difficulté concrète de maintenance n’a subsisté après clarification. Le manque d’une contributrice ou d’un contributeur réellement indépendant réduit la confiance de cette évaluation, mais n’est pas un défaut logiciel et ne justifie pas de baisser la note de qualité. Le prototype n’a pas couvert une vraie commande Discord, volontairement hors de ce test sans mutation réelle. | Pas de nouvelle abstraction ni de correction code demandée. Une reprise indépendante améliorerait la confiance, sans constituer un nouveau critère de qualité. |

L’axe 11 reste à **8/10** comme demandé, en attente de l’observation manuelle NVDA; ses critères ne changent pas. Cet exercice n’évalue pas AWS, le sharding ni la capacité à grande échelle.
