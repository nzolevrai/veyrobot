$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scriptUnderTest = Join-Path $PSScriptRoot 'backup-postgres.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('veyrobot-backup-tests-' + [guid]::NewGuid().ToString('N'))
$backupDirectory = Join-Path $testRoot 'backups'
$composeFile = Join-Path $testRoot 'compose.test.yaml'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
Set-Content -LiteralPath $composeFile -Value 'services: {}' -Encoding ASCII
$env:VEYROBOT_BACKUP_DIR = $backupDirectory
$global:FakeDockerMode = 'success'
$global:FakeRemoteFiles = @{}
$global:FakeBackupDirectory = $backupDirectory
$global:FakeDockerCalls = 0

function docker {
  $global:FakeDockerCalls++
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
    if ($global:FakeDockerMode -eq 'publish-failure' -and $joined -match '/(veyrobot-[A-Za-z0-9TZ-]+)\.validation\.tmp') {
      $stem = $Matches[1]
      Set-Content -LiteralPath (Join-Path $global:FakeBackupDirectory "$stem.backup.sha256") -Value 'pre-existing checksum marker' -Encoding ASCII
    }
    return
  }
  if ($argv[0] -eq 'compose' -and $joined -match 'rm -rf') { return }
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
function Invoke-FakeBackup([string]$Mode, [switch]$CleanupStaleTemporaries, [int]$StaleAfterHours = 24, [int]$MaxCleanupItems = 20) {
  $global:FakeDockerMode = $Mode
  & $scriptUnderTest -ComposeFile $composeFile -ComposeEnvFile '' -ComposeProjectName 'fake-test' -CleanupStaleTemporaries:$CleanupStaleTemporaries -StaleAfterHours $StaleAfterHours -MaxCleanupItems $MaxCleanupItems
}

try {
  Invoke-FakeBackup 'success' | Out-Null # first run creates a directory with the production DACL
  $seedArchive = @(Get-ChildItem -LiteralPath $backupDirectory -Filter 'veyrobot-*.backup' -File)[0]
  $priorArchive = Join-Path $backupDirectory 'prior.backup'
  $priorChecksum = "$priorArchive.sha256"
  Move-Item -LiteralPath $seedArchive.FullName -Destination $priorArchive
  Move-Item -LiteralPath "$($seedArchive.FullName).sha256" -Destination $priorChecksum
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
    Assert-True $directoryAcl.AreAccessRulesProtected 'backup directory must block inherited access'
    $allowed = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
    foreach ($path in @($completed[0].FullName, $publishedChecksum)) {
      $fileAcl = Get-Acl -LiteralPath $path
      $rules = @($fileAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
      Assert-True (@($rules | Where-Object { $_.IdentityReference.Value -notin $allowed -or $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow }).Count -eq 0) "only the backup account, SYSTEM and Administrators may access $path"
      Assert-True (@($rules | Where-Object { $_.IdentityReference.Value -eq $currentSid }).Count -gt 0) "backup account retains access to $path"
    }
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

  $interruptSignal = Join-Path $testRoot 'interrupt-reached-validation.signal'
  $interruptHarness = Join-Path $testRoot 'interrupt-backup.ps1'
  @'
param($BackupScript,$Directory,$Compose,$Signal)
$ErrorActionPreference = 'Stop'
$env:VEYROBOT_BACKUP_DIR = $Directory
function docker {
  $argv=@($args); $joined=$argv -join ' '; $global:LASTEXITCODE=0
  if($argv[0] -eq 'compose' -and $joined -match 'ps -q postgres'){return 'fake-container'}
  if($argv[0] -eq 'compose' -and $joined -match 'pg_dump'){return}
  if($argv[0] -eq 'cp' -and $argv[1] -like 'fake-container:*'){[System.IO.File]::WriteAllBytes($argv[2],[Text.Encoding]::ASCII.GetBytes('INTERRUPTED-PRIVATE-ARCHIVE'));return}
  if($argv[0] -eq 'cp'){return}
  if($argv[0] -eq 'compose' -and $joined -match 'pg_restore --list'){[System.IO.File]::WriteAllText($Signal,'ready');while($true){Start-Sleep -Seconds 1}}
  if($argv[0] -eq 'compose' -and $joined -match 'rm -rf'){return}
  throw "Unexpected interrupt docker call: $joined"
}
& $BackupScript -ComposeFile $Compose -ComposeEnvFile '' -ComposeProjectName 'interrupt-test'
'@ | Set-Content -LiteralPath $interruptHarness -Encoding ASCII
  $powerShellExe = (Get-Process -Id $PID).Path
  $startArguments = @{ FilePath = $powerShellExe; ArgumentList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$interruptHarness,$scriptUnderTest,$backupDirectory,$composeFile,$interruptSignal); PassThru = $true }
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) { $startArguments.WindowStyle = 'Hidden' }
  $interruptProcess = Start-Process @startArguments
  try {
    $waitUntil = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $interruptSignal) -and [DateTime]::UtcNow -lt $waitUntil) { Start-Sleep -Milliseconds 50 }
    Assert-True (Test-Path -LiteralPath $interruptSignal) 'child backup reaches the controlled post-copy validation barrier'
    $interruptedWork = @(Get-ChildItem -LiteralPath $backupDirectory -Directory -Force | Where-Object Name -Match '^\.veyrobot-.*\.work$' | Select-Object -First 1)[0]
    Assert-True ($null -ne $interruptedWork) 'forcibly interrupted process leaves only a private work directory'
    $interruptedTemp = @(Get-ChildItem -LiteralPath $interruptedWork.FullName -Filter '*.backup.tmp' -File)[0]
    Assert-True ($null -ne $interruptedTemp) 'archive temporary exists before validation completes'
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
      $allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
      foreach ($path in @($interruptedWork.FullName, $interruptedTemp.FullName, (Join-Path $interruptedWork.FullName '.active'))) {
        $acl = Get-Acl -LiteralPath $path
        $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
        Assert-True (@($rules | Where-Object { $_.IdentityReference.Value -notin $allowed -or $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow }).Count -eq 0) "interrupted temporary ACL allows only the deployment identities: $path"
      }
    } else {
      $workMode = (& stat -c '%a' -- $interruptedWork.FullName).Trim()
      $archiveMode = (& stat -c '%a' -- $interruptedTemp.FullName).Trim()
      $leaseMode = (& stat -c '%a' -- (Join-Path $interruptedWork.FullName '.active')).Trim()
      Assert-True ($workMode -eq '700' -and $archiveMode -eq '600' -and $leaseMode -eq '600') 'interrupted Linux temporaries are private from their creation'
    }
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $backupDirectory ($interruptedTemp.Name -replace '\.tmp$','')))) 'temporary archive is not published as a completed backup'
    [System.IO.Directory]::SetLastWriteTimeUtc($interruptedWork.FullName, [DateTime]::UtcNow.AddHours(-2))
    Invoke-FakeBackup 'cleanup-active' -CleanupStaleTemporaries -StaleAfterHours 1 | Out-Null
    Assert-True (Test-Path -LiteralPath $interruptedWork.FullName) 'cleanup skips a directory whose exclusive lease is held by another process'
  } finally {
    if (-not $interruptProcess.HasExited) { Stop-Process -Id $interruptProcess.Id -Force; Wait-Process -Id $interruptProcess.Id -ErrorAction SilentlyContinue }
  }
  Invoke-FakeBackup 'cleanup-stale' -CleanupStaleTemporaries -StaleAfterHours 1 | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $interruptedWork.FullName)) 'bounded cleanup removes the abandoned temporary only after its lease is released'

  $otherStaleId = [guid]::NewGuid().ToString('N')
  $otherStaleName = '.veyrobot-' + [DateTime]::UtcNow.AddHours(-3).ToString("yyyyMMdd'T'HHmmssfff'Z'") + '-' + $otherStaleId + '.work'
  $otherStalePath = Join-Path $backupDirectory $otherStaleName
  [void][System.IO.Directory]::CreateDirectory($otherStalePath)
  [System.IO.File]::WriteAllText((Join-Path $otherStalePath 'private.tmp'), 'other run')
  [System.IO.Directory]::SetLastWriteTimeUtc($otherStalePath, [DateTime]::UtcNow.AddHours(-2))
  $secondStalePath = Join-Path $backupDirectory ('.veyrobot-' + [DateTime]::UtcNow.AddHours(-4).ToString("yyyyMMdd'T'HHmmssfff'Z'") + '-' + [guid]::NewGuid().ToString('N') + '.work')
  [void][System.IO.Directory]::CreateDirectory($secondStalePath)
  [System.IO.File]::WriteAllText((Join-Path $secondStalePath 'private.tmp'), 'another run')
  [System.IO.Directory]::SetLastWriteTimeUtc($secondStalePath, [DateTime]::UtcNow.AddHours(-3))
  Invoke-FakeBackup 'cleanup-stale' -CleanupStaleTemporaries -StaleAfterHours 1 -MaxCleanupItems 1 | Out-Null
  Assert-True ((Test-Path -LiteralPath $otherStalePath) -or (Test-Path -LiteralPath $secondStalePath)) 'cleanup batch limit leaves excess stale work for a later run'

  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $insecureDirectory = Join-Path $testRoot 'explicit-other-sid'
    $insecureAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $insecureAcl.SetAccessRuleProtection($true, $false)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $insecureAcl.SetOwner($currentSid)
    foreach ($sidText in @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
      $insecureAcl.AddAccessRule($rule)
    }
    $otherSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545') # BUILTIN\Users
    $otherRule = [System.Security.AccessControl.FileSystemAccessRule]::new($otherSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
      [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $insecureAcl.AddAccessRule($otherRule)
    [void][System.IO.Directory]::CreateDirectory($insecureDirectory, $insecureAcl)
    $env:VEYROBOT_BACKUP_DIR = $insecureDirectory
    $beforeDockerCalls = $global:FakeDockerCalls
    $rejectedAcl = $false
    try { & $scriptUnderTest -ComposeFile $composeFile -ComposeEnvFile '' -ComposeProjectName 'insecure-acl-test' | Out-Null } catch { $rejectedAcl = $_.Exception.Message -match 'ACL contains' }
    $remainingOtherRule = @((Get-Acl -LiteralPath $insecureDirectory).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object IdentityReference -eq $otherSid)
    Assert-True $rejectedAcl 'a pre-existing explicit BUILTIN\Users ACE is refused'
    Assert-True ($global:FakeDockerCalls -eq $beforeDockerCalls) 'ACL refusal occurs before any database bytes are copied'
    Assert-True ($remainingOtherRule.Count -eq 1) 'the script refuses without editing the user-supplied ACL'
  }

  Write-Output 'Backup-script mocked-Docker tests passed: dump/copy/validation/publication failures, stale temp, checksum, prior archive preservation and concurrent unique names.'
} finally {
  Remove-Item Env:VEYROBOT_BACKUP_DIR -ErrorAction SilentlyContinue
  Remove-Variable FakeDockerMode,FakeRemoteFiles,FakeBackupDirectory,FakeDockerCalls -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
