$ErrorActionPreference = 'Stop'

if (-not $env:VEYROBOT_BACKUP_DIR) {
  throw 'Set VEYROBOT_BACKUP_DIR to an access-controlled backup directory on encrypted storage.'
}
$backupDirectory = [System.IO.Path]::GetFullPath($env:VEYROBOT_BACKUP_DIR)
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteFile = "/tmp/veyrobot-$stamp.backup"
$localFile = Join-Path $backupDirectory "veyrobot-$stamp.backup"
$composeArgs = @('--env-file', '.env.production', '-f', 'deploy/compose.production.yaml')
$containerId = (& docker compose @composeArgs ps -q postgres).Trim()
if ($LASTEXITCODE -ne 0 -or -not $containerId) { throw 'PostgreSQL Compose service is not available.' }

try {
  $dumpCommand = 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "' + $remoteFile + '"'
  & docker compose @composeArgs exec -T postgres sh -c $dumpCommand
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }
  & docker cp "${containerId}:$remoteFile" $localFile
  if ($LASTEXITCODE -ne 0) { throw 'Copying the completed backup failed.' }
  if ((Get-Item -LiteralPath $localFile).Length -eq 0) { throw 'The backup file is empty.' }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localFile).Hash
  Write-Output "Backup complete: $localFile (SHA-256 $hash)"
}
finally {
  & docker compose @composeArgs exec -T postgres rm -f $remoteFile 2>$null | Out-Null
}
