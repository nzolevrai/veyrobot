# Sauvegarde et restauration PostgreSQL

## Sauvegarde publiée

Prérequis : PowerShell 5.1 ou `pwsh`, Docker Compose v2, service PostgreSQL 17 défini par `deploy/compose.production.yaml`, fichier `.env.production` fourni hors dépôt, et répertoire de destination privé sur stockage chiffré. Le script ne reçoit aucun mot de passe PostgreSQL en argument : `pg_dump` utilise les variables déjà présentes dans le conteneur. Ne pas activer la trace des arguments Docker ni publier la sortie contenant le chemin local.

Exécuter depuis la racine du dépôt, avec `.env.production` provisionné par l'exploitant :

```powershell
$env:VEYROBOT_BACKUP_DIR = 'D:\private\veyrobot-backups'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/backup-postgres.ps1
```

Le script produit un nom UTC avec identifiant aléatoire, crée d'abord un temporaire dans le répertoire de destination, vérifie les codes de sortie de Compose/`pg_dump`/`docker cp`/`pg_restore`, puis exécute `pg_restore --list` sur une copie de l'archive revenue du poste hôte. Il calcule le SHA-256 de cette archive validée. L'archive et le fichier `<archive>.sha256` sont publiés par `File.Move` dans le même répertoire; le sidecar, publié en dernier, est le marqueur de complétude. Les collisions échouent sans écrasement. Une sauvegarde antérieure n'est ni remplacée ni supprimée.

Un consommateur doit ignorer tout `*.backup` sans sidecar correspondant. En cas d'arrêt brutal après le renommage de l'archive mais avant celui du checksum, le fichier final peut rester sans sidecar; il est incomplet et ne doit pas être restauré. Le script tente de supprimer cet orphelin lorsqu'il reçoit une erreur normale. Les fichiers temporaires cachés (`.*.tmp`) ne sont jamais des sauvegardes publiées; après vérification qu'aucun run ne les utilise, l'exploitant peut les retirer. Le répertoire de sortie est restreint au compte d'exécution (Windows : ACL sans héritage, Unix : mode 0700) et les fichiers au mode 0600/ACL du propriétaire.

Le SHA-256 détecte une corruption ou une altération après création, mais ne prouve pas à lui seul la restaurabilité. La lecture `pg_restore --list` donne une validation minimale; un exercice de restauration périodique reste nécessaire.

## Vérifier et restaurer en quarantaine

1. Choisir une base PostgreSQL 17 isolée, sans API, bot, worker, dispatcher ni autre consommateur VeyroBot. Ne jamais restaurer par-dessus la base active.
2. Vérifier que le sidecar existe et correspond au nom de l'archive :

   ```powershell
   $archive = 'D:\private\veyrobot-backups\veyrobot-<id>.backup'
   $checksumLine = Get-Content -Raw -LiteralPath "${archive}.sha256"
   $expected = ($checksumLine.Trim() -split '\s+')[0]
   $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
   if ($actual -ne $expected) { throw 'Archive checksum mismatch.' }
   ```

3. Créer une base cible vide et restaurer avec PostgreSQL 17 `pg_restore --no-owner`. Restaurer le schéma et les données; ne pas démarrer l'application à ce stade.
4. Pointer `DATABASE_URL` uniquement vers la base isolée, puis exécuter :

   ```powershell
   $env:RESTORE_QUARANTINE_CONFIRM = '1'
   corepack pnpm --filter @veyrobot/db exec tsx src/restore-quarantine-cli.ts
   ```

   Le CLI transforme les dossiers `requested`/`running` et les échéances TEMPBAN planifiées/en cours en `uncertain`, et révoque dans la transaction tous les `SessionGrant` restaurés qui n'étaient pas déjà révoqués. Une session restaurée ne permet donc pas de réutiliser un ancien cookie : chaque utilisateur devra refaire OAuth après la remise en service.

5. Vérifier les compteurs du CLI, les dossiers `uncertain`, les générations/décisions de BAN et les échéances. Comparer les sanctions et expirations avec les traces externes disponibles. Si aucune preuve ne permet de conclure, conserver `uncertain`; ne pas remettre automatiquement l'action en file.
6. Avant le redémarrage, faire vérifier la cible, la quarantaine et les secrets de connexion par l'exploitant. Démarrer ensuite l'API, confirmer `/ready`, puis un seul processus bot. Cette procédure n'établit pas une atomicité avec Discord et ne remplace pas la réconciliation humaine.

## Tests de cette tranche

- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/test-backup-postgres.ps1` exécute le véritable script avec un mock PowerShell de la commande Docker. Il couvre les retours d'échec simulés de `pg_dump`, des deux copies, de `pg_restore`, une collision de publication, les fichiers temporaires résiduels, la conservation d'une ancienne archive, les ACL Windows et deux appels concurrents. Ces tests ne prouvent pas le comportement des exécutables Docker/PostgreSQL réels.
- `node deploy/backup-restore.integration.mjs` démarre un projet Compose temporaire PostgreSQL 17, applique les migrations, crée des données de test, appelle le véritable script de sauvegarde, vérifie le sidecar, demande à `pg_restore` réel de rejeter une archive tronquée, restaure une seconde base, exécute le CLI de quarantaine puis vérifie le dispatcher de production avec une file contrôlée. Aucun processus API, bot, Gateway ou worker n'est démarré et aucun appel Discord n'est effectué.
- Sur le poste Windows vérifié le 15 octobre 2026, le run PostgreSQL 17 a pris 1 411,6 ms pour sauvegarder et 263,2 ms pour restaurer un jeu migré de 20 781 octets; le conteneur a appliqué la quarantaine à deux opérations, une échéance future et un grant. Ce petit jeu mesure uniquement ce run local; il ne définit pas de RPO/RTO ni ne prédit la durée sur une base de production.

Une archive sur le même hôte n'est pas une sauvegarde externe. La production doit copier les archives complètes et leurs sidecars vers un stockage distinct, chiffré, à accès limité et avec rétention surveillée. Aucun test de stockage distant, de panne de machine, de chiffrement au repos fourni par l'hébergeur ni de restauration à l'échelle de production n'a été fait.
