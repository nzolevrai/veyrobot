param(
  [string]$ComposeFile = 'deploy/compose.production.yaml',
  [string]$ComposeEnvFile = '.env.production',
  [string]$ComposeProjectName = '',
  [switch]$CleanupStaleTemporaries,
  [ValidateRange(1, 8760)][int]$StaleAfterHours = 24,
  [ValidateRange(1, 100)][int]$MaxCleanupItems = 20
)

$ErrorActionPreference = 'Stop'

if (-not $env:VEYROBOT_BACKUP_DIR) {
  throw 'Set VEYROBOT_BACKUP_DIR to a private backup directory on encrypted storage.'
}

$backupDirectory = [System.IO.Path]::GetFullPath($env:VEYROBOT_BACKUP_DIR)

function Assert-NoReparsePath([string]$Path) {
  $cursor = [System.IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Backup paths and their existing parents must not be symbolic links or reparse points.'
      }
    }
    $parent = [System.IO.Directory]::GetParent($cursor)
    if (-not $parent) { break }
    $cursor = $parent.FullName
  }
}

$windowsBackup = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$backupParent = [System.IO.Directory]::GetParent($backupDirectory)
if (-not $backupParent -or -not (Test-Path -LiteralPath $backupParent.FullName -PathType Container)) {
  throw 'The backup directory parent must already exist and be controlled by the backup operator.'
}
Assert-NoReparsePath $backupDirectory

function Assert-PrivatePermissions([string]$Path, [bool]$Directory) {
  if ($windowsBackup) {
    $acl = Get-Acl -LiteralPath $Path
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544') # backup account, LocalSystem, local Administrators
    $seen = @{}
    if ($Directory -and -not $acl.AreAccessRulesProtected) { throw 'The backup directory DACL must be protected from inherited ACEs.' }
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowedSids) { throw 'Backup path owner must be the backup account, LocalSystem or local Administrators.' }
    foreach ($rule in $rules) {
      $sid = $rule.IdentityReference.Value
      if ($sid -notin $allowedSids -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
          ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        throw 'Backup ACL contains an identity or permission outside the allowlist.'
      }
      if ($Directory -and ($rule.InheritanceFlags -band ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)) -ne
          ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)) {
        throw 'Backup directory ACL must propagate only the allowlisted identities to child files.'
      }
      $seen[$sid] = $true
    }
    foreach ($sid in $allowedSids) { if (-not $seen.ContainsKey($sid)) { throw 'Backup ACL is missing an explicitly allowed operator/system identity.' } }
  } else {
    $stat = @(& stat -c '%a %u' -- $Path 2>$null)
    if ($LASTEXITCODE -ne 0 -or $stat.Count -eq 0) { throw 'Could not inspect backup path permissions.' }
    $parts = $stat[0].Trim() -split '\s+'
    $expectedOwner = (@(& id -u 2>$null) | Select-Object -First 1).Trim()
    if ($LASTEXITCODE -ne 0 -or $parts.Count -ne 2 -or $parts[1] -ne $expectedOwner) { throw 'Backup path must be owned by the current operator.' }
    $mode = [Convert]::ToInt32($parts[0], 8)
    if (($mode -band 0x3F) -ne 0) { throw 'Backup paths must grant no group or other permissions.' }
    if ($Directory -and (($mode -band 0x1C0) -ne 0x1C0)) { throw 'Backup directory must grant owner read/write/execute.' }
    if (-not $Directory -and (($mode -band 0x180) -ne 0x180)) { throw 'Backup files must grant owner read/write.' }
  }
}

function New-PrivateWindowsDirectory([string]$Path) {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security.SetOwner($currentSid)
  foreach ($sidText in @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
      [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
  [void][System.IO.Directory]::CreateDirectory($Path, $security)
}

function New-PrivateFile([string]$Path) {
  if ($windowsBackup) {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $stream.Dispose()
  } else {
    & sh -c 'umask 077 && (set -C; : > "$1")' sh $Path 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create a private temporary file.' }
  }
}

function New-PrivateUnixDirectory([string]$Path) {
  & sh -c 'umask 077 && mkdir -m 700 -- "$1"' sh $Path 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create a private temporary directory.' }
}

if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
  if ($windowsBackup) {
    New-PrivateWindowsDirectory $backupDirectory
  } else {
    New-PrivateUnixDirectory $backupDirectory
  }
}
Assert-NoReparsePath $backupDirectory
Assert-PrivatePermissions $backupDirectory $true

function Invoke-DockerChecked([string[]]$Arguments, [string]$FailureMessage) {
  $global:LASTEXITCODE = 0
  $output = @(& docker @Arguments 2>$null)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw $FailureMessage }
  return ($output -join [System.Environment]::NewLine)
}

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

if ($CleanupStaleTemporaries) {
  $cutoff = [DateTime]::UtcNow.AddHours(-$StaleAfterHours)
  $cleaned = 0
  foreach ($candidate in Get-ChildItem -LiteralPath $backupDirectory -Directory -Force | Where-Object { $_.Name -match '^\.veyrobot-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{32}\.work$' -and $_.LastWriteTimeUtc -lt $cutoff } | Select-Object -First $MaxCleanupItems) {
    $match = [regex]::Match($candidate.Name, '-([a-f0-9]{32})\.work$')
    if (-not $match.Success) { continue }
    $lease = $null
    try {
      $leasePath = Join-Path $candidate.FullName '.active'
      if (Test-Path -LiteralPath $leasePath -PathType Leaf) {
        try { $lease = [System.IO.File]::Open($leasePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
        catch [System.IO.IOException] { continue }
      }
      $remoteStaleDirectory = '/tmp/.veyrobot-backup-' + $match.Groups[1].Value
      $cleanupCommand = 'rm -rf -- "' + $remoteStaleDirectory + '"'
      Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $cleanupCommand)) 'Could not clean a stale temporary backup.' | Out-Null
      if ($lease) { $lease.Dispose(); $lease = $null }
      Remove-Item -LiteralPath $candidate.FullName -Recurse -Force
      $cleaned++
    } finally { if ($lease) { $lease.Dispose() } }
  }
  Write-Output "Stale temporary backup work directories cleaned: $cleaned"
  return
}

$runId = [guid]::NewGuid().ToString('N')
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$backupStem = "veyrobot-$stamp-$runId"
$localWorkDirectory = Join-Path $backupDirectory ".$backupStem.work"
$remoteWorkDirectory = "/tmp/.veyrobot-backup-$runId"
$remoteDump = "$remoteWorkDirectory/$backupStem.backup.tmp"
$remoteValidation = "$remoteWorkDirectory/$backupStem.validation.tmp"
$localTemp = Join-Path $localWorkDirectory "$backupStem.backup.tmp"
$checksumTemp = Join-Path $localWorkDirectory "$backupStem.sha256.tmp"
$localArchive = Join-Path $backupDirectory "$backupStem.backup"
$checksumFile = "$localArchive.sha256"
$archivePublished = $false
$checksumPublished = $false
$remoteCleaned = $false
$localLease = $null

try {
  if ($windowsBackup) { New-PrivateWindowsDirectory $localWorkDirectory }
  else { New-PrivateUnixDirectory $localWorkDirectory }
  $leasePath = Join-Path $localWorkDirectory '.active'
  New-PrivateFile $leasePath
  $localLease = [System.IO.File]::Open($leasePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  Assert-NoReparsePath $localWorkDirectory
  Assert-PrivatePermissions $localWorkDirectory $true
  Assert-PrivatePermissions (Join-Path $localWorkDirectory '.active') $false

  $dumpCommand = 'umask 077 && mkdir -m 700 "' + $remoteWorkDirectory + '" && pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "' + $remoteDump + '"'
  Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $dumpCommand)) 'pg_dump failed; no backup was published.' | Out-Null

  New-PrivateFile $localTemp
  Assert-PrivatePermissions $localTemp $false
  Invoke-DockerChecked @('cp', "${containerId}:$remoteDump", $localTemp) 'Copying the temporary backup from PostgreSQL failed.' | Out-Null
  if (-not (Test-Path -LiteralPath $localTemp -PathType Leaf) -or (Get-Item -LiteralPath $localTemp).Length -le 0) {
    throw 'The temporary backup is empty or missing.'
  }
  Assert-NoReparsePath $localTemp
  Assert-PrivatePermissions $localTemp $false

  Invoke-DockerChecked @('cp', $localTemp, "${containerId}:$remoteValidation") 'Uploading the local archive for validation failed.' | Out-Null
  $validateCommand = 'chmod 600 "' + $remoteValidation + '" && pg_restore --list "' + $remoteValidation + '" >/dev/null'
  Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $validateCommand)) 'pg_restore rejected the copied archive; no backup was published.' | Out-Null

  $remoteCleanup = 'rm -rf -- "' + $remoteWorkDirectory + '"'
  Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $remoteCleanup)) 'Could not remove temporary archive data from PostgreSQL; no backup was published.' | Out-Null
  $remoteCleaned = $true

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localTemp).Hash.ToLowerInvariant()
  $checksumContents = "$hash *$([System.IO.Path]::GetFileName($localArchive))`n"
  New-PrivateFile $checksumTemp
  $checksumStream = [System.IO.File]::Open($checksumTemp, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $checksumBytes = [System.Text.Encoding]::ASCII.GetBytes($checksumContents)
    $checksumStream.Write($checksumBytes, 0, $checksumBytes.Length)
    $checksumStream.Flush($true)
  } finally { $checksumStream.Dispose() }
  Assert-NoReparsePath $checksumTemp
  Assert-PrivatePermissions $checksumTemp $false

  # File.Move within one directory is atomic and refuses to overwrite an existing destination.
  [System.IO.File]::Move($localTemp, $localArchive)
  $archivePublished = $true
  [System.IO.File]::Move($checksumTemp, $checksumFile)
  $checksumPublished = $true

  Assert-PrivatePermissions $localArchive $false
  Assert-PrivatePermissions $checksumFile $false
  Write-Output "Backup complete: $localArchive (SHA-256 $hash; completion sidecar: $checksumFile)"
} catch {
  if ($archivePublished -and -not $checksumPublished) {
    Remove-Item -LiteralPath $localArchive -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  if (-not $remoteCleaned) {
    $remoteCleanup = 'rm -rf -- "' + $remoteWorkDirectory + '"'
    try { Invoke-DockerChecked ($composePrefix + @('exec', '-T', $service, 'sh', '-c', $remoteCleanup)) 'Backup cleanup failed.' | Out-Null; $remoteCleaned = $true }
    catch { Write-Warning 'Temporary archive cleanup failed; no credential-bearing text was logged. Inspect the PostgreSQL temporary directory.' }
  }
  if ($localLease) { $localLease.Dispose() }
  if ($remoteCleaned) { Remove-Item -LiteralPath $localWorkDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
