$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scriptUnderTest = Join-Path $PSScriptRoot 'backup-postgres.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('veyrobot-backup-tests-' + [guid]::NewGuid().ToString('N'))
$backupDirectory = Join-Path $testRoot 'backups'
$composeFile = Join-Path $testRoot 'compose.test.yaml'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
Set-Content -LiteralPath $composeFile -Value 'services: {}' -Encoding ASCII
$env:VEYROBOT_BACKUP_DIR = $backupDirectory
$global:FakeDockerMode = 'success'
$global:FakeRemoteFiles = @{}
$global:FakeBackupDirectory = $backupDirectory

function docker {
  $argv = @($args)
  $joined = $argv -join ' '
  $global:LASTEXITCODE = 0

  if ($argv[0] -eq 'compose' -and $joined -match 'ps -q postgres') { return 'fake-container' }
  if ($argv[0] -eq 'compose' -and $joined -match 'pg_dump') {
    if ($global:FakeDockerMode -eq 'dump-failure') { $global:LASTEXITCODE = 17; return }
    if ($joined -match '(-f\s+")(/tmp/[^" ]+)') { $global:FakeRemoteFiles[$Matches[2]] = [byte[]][Text.Encoding]::ASCII.GetBytes('FAKE-VALID-ARCHIVE') }
    return
  }
  if ($argv[0] -eq 'compose' -and $joined -match 'pg_restore --list') {
    if ($global:FakeDockerMode -eq 'validation-failure' -or $global:FakeDockerMode -eq 'truncated-archive') { $global:LASTEXITCODE = 18; return }
    if ($global:FakeDockerMode -eq 'publish-failure' -and $joined -match '/tmp/(veyrobot-[A-Za-z0-9TZ-]+)\.validation\.tmp') {
      $stem = $Matches[1]
      Set-Content -LiteralPath (Join-Path $global:FakeBackupDirectory "$stem.backup.sha256") -Value 'pre-existing checksum marker' -Encoding ASCII
    }
    return
  }
  if ($argv[0] -eq 'compose' -and $joined -match 'rm -f') { return }
  if ($argv[0] -eq 'cp' -and $argv[1] -like 'fake-container:*') {
    $remote = $argv[1].Substring('fake-container:'.Length)
    if ($global:FakeDockerMode -eq 'copy-failure') {
      [System.IO.File]::WriteAllBytes($argv[2], [Text.Encoding]::ASCII.GetBytes('partial'))
      $global:LASTEXITCODE = 19
      return
    }
    [System.IO.File]::WriteAllBytes($argv[2], $global:FakeRemoteFiles[$remote])
    return
  }
  if ($argv[0] -eq 'cp') {
    if ($global:FakeDockerMode -eq 'validation-copy-failure') { $global:LASTEXITCODE = 20; return }
    $remote = ($argv[2] -split ':', 2)[1]
    $global:FakeRemoteFiles[$remote] = [System.IO.File]::ReadAllBytes($argv[1])
    return
  }
  throw "Unexpected fake docker invocation: $joined"
}

function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "Assertion failed: $Message" } }
function Invoke-FakeBackup([string]$Mode) {
  $global:FakeDockerMode = $Mode
  & $scriptUnderTest -ComposeFile $composeFile -ComposeEnvFile '' -ComposeProjectName 'fake-test'
}

try {
  $priorArchive = Join-Path $backupDirectory 'prior.backup'
  $priorChecksum = "$priorArchive.sha256"
  [System.IO.File]::WriteAllText($priorArchive, 'prior archive stays intact')
  [System.IO.File]::WriteAllText($priorChecksum, 'prior checksum stays intact')

  foreach ($failureMode in @('dump-failure', 'copy-failure', 'validation-copy-failure', 'validation-failure', 'truncated-archive', 'publish-failure')) {
    $failed = $false; $failureMessage = ''
    try { Invoke-FakeBackup $failureMode | Out-Null } catch { $failed = $true; $failureMessage = $_.Exception.Message + ' at ' + $_.ScriptStackTrace }
    Assert-True $failed "$failureMode must fail explicitly ($failureMessage)"
    Assert-True ([System.IO.File]::ReadAllText($priorArchive) -eq 'prior archive stays intact') "$failureMode changed the previous archive"
    Assert-True ([System.IO.File]::ReadAllText($priorChecksum) -eq 'prior checksum stays intact') "$failureMode changed the previous checksum"
    $remaining = @(Get-ChildItem -LiteralPath $backupDirectory -File | Where-Object { $_.Name -ne 'prior.backup' -and $_.Name -ne 'prior.backup.sha256' } | Select-Object -ExpandProperty Name)
    if ($failureMode -eq 'publish-failure') {
      $markerContents = if ($remaining.Count -eq 1) { [System.IO.File]::ReadAllText((Join-Path $backupDirectory $remaining[0])).Trim() } else { ($remaining -join ',') }
      Assert-True ($remaining.Count -eq 1 -and $markerContents -eq 'pre-existing checksum marker') "publication collision must preserve its pre-existing marker and remove the unpublished archive (remaining: $markerContents; failure: $failureMessage)"
      Remove-Item -LiteralPath (Join-Path $backupDirectory $remaining[0]) -Force
    } else {
      Assert-True ($remaining.Count -eq 0) "$failureMode left a visible or temporary partial file"
    }
  }

  $global:FakeDockerMode = 'success'
  Invoke-FakeBackup 'success' | Out-Null
  $completed = @(Get-ChildItem -LiteralPath $backupDirectory -Filter 'veyrobot-*.backup' -File)
  Assert-True ($completed.Count -eq 1) 'successful fake run publishes one archive'
  $publishedChecksum = "$($completed[0].FullName).sha256"
  Assert-True (Test-Path -LiteralPath $publishedChecksum) 'checksum sidecar is the completion marker'
  $hashLine = [System.IO.File]::ReadAllText($publishedChecksum).Trim()
  $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $completed[0].FullName).Hash.ToLowerInvariant()
  Assert-True ($hashLine.StartsWith($expectedHash)) 'published checksum must match final archive'
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $directoryAcl = Get-Acl -LiteralPath $backupDirectory
    $archiveAcl = Get-Acl -LiteralPath $completed[0].FullName
    $ownerRules = @($archiveAcl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $currentSid })
    Assert-True $directoryAcl.AreAccessRulesProtected 'backup directory must block inherited access'
    Assert-True $archiveAcl.AreAccessRulesProtected 'archive must block inherited access'
    Assert-True ($ownerRules.Count -gt 0) 'current owner retains archive access'
  }

  $staleTemp = Join-Path $backupDirectory '.interrupted.backup.tmp'
  [System.IO.File]::WriteAllText($staleTemp, 'simulated process interruption')
  Assert-True (-not (Test-Path -LiteralPath "$staleTemp.sha256")) 'a leftover temp file is not a complete backup without a checksum sidecar'
  Assert-True (@(Get-ChildItem -LiteralPath $backupDirectory -Filter '*.backup.sha256' -File).Count -eq 2) 'only the prior archive and successful fake archive are complete'

  $jobBlock = {
    param($BackupScript, $Directory, $Compose)
    $env:VEYROBOT_BACKUP_DIR = $Directory
    function docker {
      $argv = @($args); $global:LASTEXITCODE = 0
      if ($argv[0] -eq 'compose' -and ($argv -join ' ') -match 'ps -q postgres') { return 'fake-container' }
      if ($argv[0] -eq 'compose' -and ($argv -join ' ') -match 'pg_restore --list') { return }
      if ($argv[0] -eq 'compose') { return }
      if ($argv[0] -eq 'cp' -and $argv[1] -like 'fake-container:*') { [System.IO.File]::WriteAllBytes($argv[2], [Text.Encoding]::ASCII.GetBytes([guid]::NewGuid().ToString())); return }
      if ($argv[0] -eq 'cp') { return }
      throw 'Unexpected fake docker invocation'
    }
    & $BackupScript -ComposeFile $Compose -ComposeEnvFile '' -ComposeProjectName 'parallel-test' | Out-Null
    'ok'
  }
  $jobs = 1..2 | ForEach-Object { Start-Job -ScriptBlock $jobBlock -ArgumentList $scriptUnderTest, $backupDirectory, $composeFile }
  try {
    $jobResults = @($jobs | Wait-Job -Timeout 30 | Receive-Job -ErrorAction Stop)
    Assert-True ($jobResults.Count -eq 2) 'both concurrent backup runs complete'
    $allArchives = @(Get-ChildItem -LiteralPath $backupDirectory -Filter 'veyrobot-*.backup' -File)
    Assert-True ($allArchives.Count -eq 3) 'concurrent runs publish distinct final archive names'
    foreach ($archive in $allArchives) { Assert-True (Test-Path -LiteralPath "$($archive.FullName).sha256") 'each concurrent archive has its completion sidecar' }
  } finally { $jobs | Stop-Job -ErrorAction SilentlyContinue; $jobs | Remove-Job -Force -ErrorAction SilentlyContinue }

  Write-Output 'Backup-script mocked-Docker tests passed: dump/copy/validation/publication failures, stale temp, checksum, prior archive preservation and concurrent unique names.'
} finally {
  Remove-Item Env:VEYROBOT_BACKUP_DIR -ErrorAction SilentlyContinue
  Remove-Variable FakeDockerMode,FakeRemoteFiles,FakeBackupDirectory -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
