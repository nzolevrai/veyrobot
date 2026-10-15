param(
  [string]$ComposeFile = 'deploy/compose.production.yaml',
  [string]$ComposeEnvFile = '.env.production',
  [string]$ComposeProjectName = ''
)

$ErrorActionPreference = 'Stop'

if (-not $env:VEYROBOT_BACKUP_DIR) {
  throw 'Set VEYROBOT_BACKUP_DIR to a private backup directory on encrypted storage.'
}

$backupDirectory = [System.IO.Path]::GetFullPath($env:VEYROBOT_BACKUP_DIR)
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null

function Set-PrivatePermissions([string]$Path, [bool]$Directory) {
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $grant = if ($Directory) { "*$($identity.User.Value):(OI)(CI)F" } else { "*$($identity.User.Value):F" }
    & icacls.exe $Path /inheritance:r /grant:r $grant 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict backup path permissions.' }
  } else {
    $mode = if ($Directory) { '700' } else { '600' }
    & chmod $mode -- $Path 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict backup file permissions.' }
  }
}

function Invoke-DockerChecked([string[]]$Arguments, [string]$FailureMessage) {
  $global:LASTEXITCODE = 0
  $output = @(& docker @Arguments 2>$null)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw $FailureMessage }
  return ($output -join [System.Environment]::NewLine)
}

Set-PrivatePermissions $backupDirectory $true

$composePrefix = @('compose')
if ($ComposeProjectName) { $composePrefix += @('--project-name', $ComposeProjectName) }
if ($ComposeEnvFile) {
  $resolvedEnvFile = [System.IO.Path]::GetFullPath($ComposeEnvFile)
  if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) { throw 'The configured Compose environment file is unavailable.' }
  $composePrefix += @('--env-file', $resolvedEnvFile)
}
$resolvedComposeFile = [System.IO.Path]::GetFullPath($ComposeFile)
if (-not (Test-Path -LiteralPath $resolvedComposeFile -PathType Leaf)) { throw 'The configured Compose file is unavailable.' }
$composePrefix += @('-f', $resolvedComposeFile)

$service = 'postgres'
$containerId = (Invoke-DockerChecked ($composePrefix + @('ps', '-q', $service)) 'PostgreSQL Compose service is not available.').Trim()
if (-not $containerId) { throw 'PostgreSQL Compose service is not available.' }

$runId = [guid]::NewGuid().ToString('N')
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$backupStem = "veyrobot-$stamp-$runId"
$remoteDump = "/tmp/$backupStem.backup.tmp"
$remoteValidation = "/tmp/$backupStem.validation.tmp"
$localTemp = Join-Path $backupDirectory ".$backupStem.backup.tmp"
$checksumTemp = Join-Path $backupDirectory ".$backupStem.sha256.tmp"
$localArchive = Join-Path $backupDirectory "$backupStem.backup"
$checksumFile = "$localArchive.sha256"
$archivePublished = $false
$checksumPublished = $false
$remoteCleaned = $false

try {
  $dumpCommand = 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "' + $remoteDump + '"'
  Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $dumpCommand)) 'pg_dump failed; no backup was published.' | Out-Null

  Invoke-DockerChecked @('cp', "${containerId}:$remoteDump", $localTemp) 'Copying the temporary backup from PostgreSQL failed.' | Out-Null
  if (-not (Test-Path -LiteralPath $localTemp -PathType Leaf) -or (Get-Item -LiteralPath $localTemp).Length -le 0) {
    throw 'The temporary backup is empty or missing.'
  }
  Set-PrivatePermissions $localTemp $false

  Invoke-DockerChecked @('cp', $localTemp, "${containerId}:$remoteValidation") 'Uploading the local archive for validation failed.' | Out-Null
  $validateCommand = 'pg_restore --list "' + $remoteValidation + '" >/dev/null'
  Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $validateCommand)) 'pg_restore rejected the copied archive; no backup was published.' | Out-Null

  $remoteCleanup = 'rm -f "' + $remoteDump + '" "' + $remoteValidation + '"'
  Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $remoteCleanup)) 'Could not remove temporary archive data from PostgreSQL; no backup was published.' | Out-Null
  $remoteCleaned = $true

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localTemp).Hash.ToLowerInvariant()
  $checksumContents = "$hash *$([System.IO.Path]::GetFileName($localArchive))`n"
  $checksumStream = [System.IO.File]::Open($checksumTemp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $checksumBytes = [System.Text.Encoding]::ASCII.GetBytes($checksumContents)
    $checksumStream.Write($checksumBytes, 0, $checksumBytes.Length)
    $checksumStream.Flush($true)
  } finally { $checksumStream.Dispose() }
  Set-PrivatePermissions $checksumTemp $false

  # File.Move within one directory is atomic and refuses to overwrite an existing destination.
  [System.IO.File]::Move($localTemp, $localArchive)
  $archivePublished = $true
  [System.IO.File]::Move($checksumTemp, $checksumFile)
  $checksumPublished = $true

  Write-Output "Backup complete: $localArchive (SHA-256 $hash; completion sidecar: $checksumFile)"
} catch {
  if ($archivePublished -and -not $checksumPublished) {
    Remove-Item -LiteralPath $localArchive -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  Remove-Item -LiteralPath $localTemp, $checksumTemp -Force -ErrorAction SilentlyContinue
  if (-not $remoteCleaned) {
    $remoteCleanup = 'rm -f "' + $remoteDump + '" "' + $remoteValidation + '"'
    try { Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $remoteCleanup)) 'Backup cleanup failed.' | Out-Null }
    catch { Write-Warning 'Temporary archive cleanup failed; no credential-bearing text was logged. Inspect the PostgreSQL temporary directory.' }
  }
}
