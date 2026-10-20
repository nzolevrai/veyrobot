# Corrélation du diagnostic de modération — 20 octobre 2026

## Portée

Cette tranche part de `4d89e1c8174517b81bb830172a42ee2b090e0163` et ne met pas en place de tracing distribué. Elle relie les journaux déjà structurés avec le `requestId` HTTP et l'`operationId` stable de PostgreSQL. Les identifiants restent des champs de logs, jamais des labels de métriques. Une nouvelle tentative HTTP peut avoir un nouveau `requestId` et retrouver le même `operationId` idempotent.

## Chaîne couverte

| Étape | Événement et champs utiles | Source |
|---|---|---|
| Admission HTTP durable | `moderation_admitted`, `requestId`, `operationId`, `phase=postgres_admission` | API, après le commit PostgreSQL et avant la réponse 202 |
| Publication BullMQ | `moderation_dispatch`, `operationId`, `kind`, `phase=queue_publish`, `outcome=published\|deferred` | Dispatcher de production après `Queue.add` ou son échec |
| Exécution | `moderation_execution`, `operationId`, `caseId`, `phase=discord_execution`, `outcome`, `status` si terminal, `durationMs` | Worker et exécuteur de production |
| Exception du worker | `moderation_execution_error`, `operationId`, `caseId`, `phase`, code de diagnostic autorisé | Frontière du worker; textes et causes bruts d'exception omis |
| Réconciliation du bail | `moderation_reconciliation`, `operationId`, `caseId`, `from`, `status`, `phase=lease_reconciliation` | Transition conditionnelle effectivement gagnée en PostgreSQL |

Une erreur pendant l'écriture finale ne constitue pas une issue persistée. Le worker la journalise comme exception et issue `interrupted`; après expiration du bail, la réconciliation peut produire un événement `running` → `uncertain`. PostgreSQL reste la source de vérité, Redis/BullMQ le transport. L'absence d'un événement de publication ne prouve pas qu'une publication n'a pas eu lieu.

Les logs ne consignent pas le motif complet, les cookies, tokens, secrets ou textes d'exception bruts. Les codes sont filtrés par l'assainisseur existant. Les journaux par opération ont une cardinalité élevée par nature; les métriques restent agrégées par catégorie/action/état.

## Incident reproductible

L'intégration API existante crée une session de test, soumet une action par HTTP et capture la sortie réelle du logger API et des loggers du bot. Elle lance le dispatcher et le worker de production contre une Queue isolée, mais fournit un adaptateur Discord contrôlé. Cet adaptateur confirme une mutation simulée. Un proxy de test sur l'écriture PostgreSQL finale injecte ensuite une erreur contenant des canaris secrets et un code Prisma autorisé. Après vérification de l'état `running`/`discord_request_inflight`, le test expire le bail en base isolée et appelle l'enveloppe de réconciliation de production. Il vérifie l'état final `uncertain`, l'ordre des événements bot, le lien des identifiants, l'absence des canaris et l'absence de seconde mutation à la rediffusion.

Le scénario ne prétend pas exercer Discord réel, tuer le processus pendant une mutation, ni rendre atomiques PostgreSQL et Discord. La panne SQL est déterministement injectée après le succès du simulateur; le bail est déplacé par le test pour éviter une attente de deux minutes.

Commande reproductible depuis la racine, avec Node 24.21.0, pnpm 10.18.3, une base PostgreSQL 17 isolée migrée et un Redis 7 isolé :

```powershell
$env:DATABASE_URL = 'postgresql://<user>:<password>@127.0.0.1:<port>/<database>?schema=public'
$env:REDIS_URL = 'redis://127.0.0.1:<port>'
$env:RUN_POSTGRES_INTEGRATION = '1'
$env:RUN_DASHBOARD_ROUTE_INTEGRATION = '1'
corepack pnpm --filter @veyrobot/api test
```

Le test de corrélation est dans `apps/api/test/integration.mjs`; il importe les sorties compilées de `apps/bot` après les builds que CI exécute. Il n'utilise aucun identifiant Discord réel.

## Résultats locaux de cette tranche

Environnement : Node 24.21.0 sélectionné seulement pour ce terminal, pnpm 10.18.3, PostgreSQL 17 et Redis 7 démarrés dans des conteneurs jetables dédiés à `127.0.0.1`; migrations appliquées à une base vide. Aucun bot local ni dispatcher n'utilisait cette base.

Vérifications réussies : `db:generate`, `db:migrate`, `typecheck`, `build`, `lint`, tests API/intégration (dont route Next construite), tests du package moderation avec toutes les intégrations PostgreSQL, et tests bot avec intégration Redis/BullMQ. Le test API a observé une seule mutation simulée, puis `uncertain` après l'incident et la réconciliation. Les canaris du message d'exception ne figurent pas dans la sortie finale des deux loggers.

Le test PostgreSQL concurrent d'admission produit une sortie Prisma d'échec de contrainte unique attendue par le test et passe; cette sortie n'est pas une fuite du scénario de corrélation. Les checks GitHub doivent être vérifiés séparément sur le SHA poussé.

## Diagnostic opérateur

Suivre la procédure [Incident — demande de modération](OPERATIONS.md#suivre-une-demande-de-modération) : partir du `x-request-id` de la réponse, retrouver l'admission API, relever l'`operationId`, puis suivre publication, exécution et éventuelle réconciliation. En cas d'issue `interrupted`, absence de statut final ou `uncertain`, confirmer l'état durable dans PostgreSQL et comparer l'état Discord manuellement avant toute reprise. Ne pas convertir une absence de log en preuve d'absence d'appel.

## Réévaluation ciblée de l'axe 10

**9/10, confiance moyenne à élevée pour le socle local mono-processus.** La preuve de clôture est le scénario intégré capturant les loggers réels de l'API et du bot avec le trajet HTTP → PostgreSQL → BullMQ → worker/exécuteur → réconciliation, et vérifiant la corrélation, l'ordre, la sûreté des logs et l'absence de répétition. Le runbook indique comment partir d'un identifiant de requête et atteindre l'état durable. La note ne signifie pas que toute opération du produit est tracée ainsi : les autres erreurs API/REST et les incidents d'hébergement n'ont pas été instrumentés exhaustivement. Aucune collecte centralisée, alerte active ni expérience Discord réelle n'est démontrée; cela limite la confiance pour l'exploitation publique mais ne bloque pas la clôture locale de cet axe.
