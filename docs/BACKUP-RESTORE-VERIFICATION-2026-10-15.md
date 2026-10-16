# Sauvegarde et restauration PostgreSQL

## Sauvegarde publiée

Prérequis : PowerShell 5.1 ou `pwsh`, Docker Compose v2, PostgreSQL 17 dans `deploy/compose.production.yaml`, fichier `.env.production` hors dépôt, et destination sur stockage chiffré privé. La voie Unix supportée est Linux avec GNU `stat`, `chmod`, `id` et `sh`. Le mot de passe PostgreSQL n'est jamais passé en argument : `pg_dump` utilise l'environnement du conteneur. Ne pas activer le traçage des arguments Docker ni publier la sortie qui contient le chemin local.

```powershell
$env:VEYROBOT_BACKUP_DIR = 'D:\private\veyrobot-backups'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/backup-postgres.ps1
```

Le script crée un répertoire temporaire unique sous la destination, détient un verrou de plage exclusif `.active`, vérifie les codes de sortie Compose, `pg_dump`, `docker cp` et `pg_restore`, puis valide par `pg_restore --list` la copie recopiée sur l'hôte. Il calcule le SHA-256 de cette copie. L'archive puis son sidecar `<archive>.sha256` sont publiés par renommage dans le même répertoire; le sidecar est le marqueur de complétude. Les collisions échouent sans écrasement et les anciennes sauvegardes ne sont jamais remplacées ni supprimées.

Sur Windows, une nouvelle destination reçoit une DACL protégée autorisant seulement le compte sauvegarde courant, LocalSystem et le groupe Administrators local, en FullControl. Le propriétaire doit appartenir à ces mêmes identités; le compte courant garde une ACE explicite. Une destination préexistante n'est jamais modifiée : le script la refuse si une ACE, un SID, un droit ou un héritage est hors de cette politique. Il vérifie le dossier, les temporaires (dont `.active`), les archives et les sidecars. Les chemins existants ne peuvent traverser de lien symbolique, point de jonction ou autre reparse point. Le parent doit être contrôlé par l'exploitant et ne pas permettre à un tiers de remplacer le sous-dossier. Sous Linux, le dossier appartient à l'UID du processus et vaut 0700; les fichiers valent 0600 dès leur création. Le conteneur crée son répertoire sous `umask 077` et mode 0700, avant d'y écrire l'archive.

Tout fichier `*.backup` sans sidecar correspondant est incomplet et doit être ignoré. Un arrêt brutal entre publication de l'archive et du sidecar peut laisser cet orphelin; un arrêt plus tôt laisse un répertoire `.work`. Les temporaires ne sont pas des sauvegardes publiées. Leur nettoyage est borné, ne cible que les répertoires générés et ignore un verrou détenu :

```powershell
deploy/backup-postgres.ps1 -CleanupStaleTemporaries -StaleAfterHours 24 -MaxCleanupItems 20
```

Le seuil d'âge est une précaution, pas une preuve que le contenu est complet. Le SHA-256 détecte une altération depuis sa création, mais n'établit pas la restaurabilité. `pg_restore --list` valide la structure minimale; un essai de restauration est requis.

## Verrou technique de reprise

Le marqueur PostgreSQL d'un snapshot ne prouve pas la fraîcheur du snapshot. Le protocole supporté conserve `VEYROBOT_RECOVERY_EPOCH` (32 octets aléatoires hexadécimaux recommandés) dans un gestionnaire de secrets indépendant des sauvegardes. L'API et le bot comparent son hash au singleton `RecoveryGate` avant d'écouter, de créer le worker ou de publier des jobs. Valeur absente, différente, mal formée ou base indisponible : démarrage refusé.

À la première installation seulement, après migration et avant tout démarrage, initialiser une fois le gate :

```powershell
$env:RECOVERY_GATE_INITIALIZE = '1'
corepack pnpm --filter @veyrobot/db recovery-gate:init
```

Pour restaurer :

1. Arrêter API, bot, maintenance et tout autre consommateur.
2. Faire tourner `VEYROBOT_RECOVERY_EPOCH` dans le gestionnaire de secrets externe. Ne pas copier l'ancienne valeur dans la cible.
3. Créer une cible PostgreSQL distincte initialement isolée, vérifier le sidecar et le SHA-256, puis restaurer avec PostgreSQL 17 `pg_restore --no-owner`. Ne jamais restaurer par-dessus la base active.
4. Pointer les commandes de maintenance uniquement vers la cible, injecter le nouvel epoch depuis la source externe et exécuter :

   ```powershell
   $env:RESTORE_QUARANTINE_CONFIRM = '1'
   corepack pnpm --filter @veyrobot/db recovery:quarantine
   ```

5. Cette transaction met en `uncertain` les opérations `requested`/`running`, les échéances TEMPBAN `pending`/`scheduled`/`running`, révoque les sessions restaurées et inscrit le hash du nouvel epoch. Toute erreur annule l'ensemble. Un redémarrage avant le commit reste bloqué. Après succès, API et bot ne démarrent qu'avec le même nouvel epoch.
6. Examiner les opérations et comparer les actions/échéances avec les preuves Discord et les journaux externes. L'absence de preuve reste `uncertain`; elle n'autorise jamais un rejeu automatique. Les utilisateurs refont OAuth après révocation des grants.

Ce protocole garantit l'ordre uniquement pour la procédure opérée : arrêt, rotation externe, restauration en cible isolée, quarantaine puis démarrage. Il ne détecte pas un snapshot restauré par une procédure non supportée qui ne fait pas tourner l'epoch externe, ni la copie de cet epoch avec la base. Le gestionnaire de secrets et le chemin d'exploitation doivent rester indépendants des sauvegardes.

## Tests et preuves

- Windows : `powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/test-backup-postgres.ps1`. Le véritable script est exécuté avec Docker simulé; tests des erreurs `pg_dump`, copies, validation et publication, préservation d'une sauvegarde antérieure, collision, parallélisme, nettoyage borné, arrêt forcé et ACL. Le test Windows ajoute une ACE explicite `BUILTIN\Users` à un dossier préexistant et vérifie le refus avant toute copie, puis contrôle les ACL des temporaires, archives et sidecars. Ces cas ne sont pas des essais PostgreSQL réel.
- Linux : la CI exécute `pwsh -NoProfile -File deploy/test-backup-postgres.ps1` pour couvrir `stat`/`chmod`/`id` et la voie de permissions Unix.
- PostgreSQL réel : `node deploy/backup-restore.integration.mjs` demande à Compose un PostgreSQL 17 et Redis 7 isolés, applique les migrations, crée des données synthétiques, appelle le vrai script de sauvegarde, vérifie le checksum, fait rejeter une archive tronquée par `pg_restore`, restaure une seconde base et vérifie les données et états.
- Le même scénario démarre les points d'entrée compilés de l'API et du bot contre un snapshot à epoch obsolète; ils doivent refuser avant écoute, jobs Redis ou login simulé. Une écriture du gate injectée en échec prouve le rollback transactionnel; le redémarrage reste bloqué. Après quarantaine réussie, l'API devient disponible et le bot n'atteint qu'un faux `Client.login` qui arrête le test. Le dispatcher de production n'émet ensuite qu'une nouvelle demande créée après restauration. Aucun appel Discord réel ni identifiant Discord réel n'est utilisé.
- CI vérifiée sur le SHA `28357a440d6bcb152d9dc088af1d720334cd3c2f`, run [#62](https://github.com/nzolevrai/veyrobot/actions/runs/38870760733) : jobs Windows et Ubuntu réussis. Ubuntu 24.04, Node 24.21.0, PostgreSQL 17.11 et Redis 7.4.11; migrations, concordance du schéma, typecheck, build, lint et suite complète réussis. Les tests PowerShell avec Docker simulé passent sur Windows et Linux; l'intégration réelle PostgreSQL 17/Redis 7 passe dans Compose isolé.
- Mesure de ce jeu synthétique CI : sauvegarde 2 050,9 ms, restauration 161,6 ms, archive 21 989 octets. Ces durées ne sont ni des objectifs ni des garanties RPO/RTO. L'intégration réelle n'a pas pu être exécutée localement : Docker Desktop était indisponible et le démarrage du service a été refusé par Windows (`Cannot open com.docker.service`); la preuve vient du runner CI.
- La CI a révélé que `FileShare.None` seul ne protégeait pas le nettoyage concurrent sur Linux; le verrouillage explicite de plage `FileStream.Lock(0, 1)` a été ajouté. Le test API de panne de grant simule maintenant l'indisponibilité de la table `SessionGrant` tout en laissant le gate de reprise joignable, et restaure la table dans `finally`.

Une archive sur le même hôte n'est pas une sauvegarde externe. Aucun stockage distant, basculement de machine, chiffrement fournisseur ni restauration à la taille réelle de production n'est validé ici.
