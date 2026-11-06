$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeVersion = (Get-Content -LiteralPath (Join-Path $repoRoot '.node-version') -ErrorAction Stop | Select-Object -First 1).Trim()
if ($nodeVersion -ne '24.22.2') { throw "Unexpected VeyroBot Node pin: $nodeVersion" }

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) { throw "Unsupported Windows architecture for the pinned Node runtime: $architecture" }
$runtimeDirectory = Join-Path $env:LOCALAPPDATA "VeyroBot\runtime\node-v$nodeVersion-win-$architecture"
$nodeExecutable = Join-Path $runtimeDirectory 'node.exe'

if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
  $sha256 = @{
    x64 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
    arm64 = 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468'
  }[$architecture]
  $runtimeParent = Split-Path -Parent $runtimeDirectory
  New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
  $archive = Join-Path $runtimeParent "node-v$nodeVersion-win-$architecture.zip"
  $staging = Join-Path $runtimeParent "node-v$nodeVersion-staging-$([guid]::NewGuid().ToString('N'))"
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-$architecture.zip" -OutFile $archive
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $sha256) { throw 'Downloaded Node archive checksum does not match the official release checksum.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    $extractedRuntime = Join-Path $staging "node-v$nodeVersion-win-$architecture"
    if (-not (Test-Path -LiteralPath (Join-Path $extractedRuntime 'node.exe') -PathType Leaf)) {
      throw 'The verified Node archive does not contain the expected runtime.'
    }
    if (Test-Path -LiteralPath $runtimeDirectory) { throw "Pinned runtime destination already exists but is incomplete: $runtimeDirectory" }
    Move-Item -LiteralPath $extractedRuntime -Destination $runtimeDirectory
  }
  finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  }
}

$versionOutput = (& $nodeExecutable --version).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -ne "v$nodeVersion") {
  throw "Pinned VeyroBot Node runtime mismatch: expected v$nodeVersion, got $versionOutput"
}

$corepackCli = $null
foreach ($command in (Get-Command corepack.cmd, corepack -All -ErrorAction SilentlyContinue)) {
  $commandPath = $command.Source
  if (-not $commandPath -and $command.Path) { $commandPath = $command.Path }
  if (-not $commandPath) { continue }
  $candidate = Join-Path (Split-Path -Parent $commandPath) 'node_modules\corepack\dist\corepack.js'
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $corepackCli = $candidate; break }
}
if (-not $corepackCli) { throw 'Corepack CLI was not found beside the installed Corepack command. Install Node.js with Corepack enabled, then rerun this project-local launcher.' }

$oldPath = $env:PATH
$oldNode = $env:VEYROBOT_NODE_EXE
$oldCorepack = $env:VEYROBOT_COREPACK_CLI
try {
  $env:VEYROBOT_NODE_EXE = $nodeExecutable
  $env:VEYROBOT_COREPACK_CLI = $corepackCli
  $env:PATH = "$(Join-Path $repoRoot 'tools\windows-shims');$runtimeDirectory;$oldPath"
  Write-Output "VeyroBot Node: $versionOutput"
  & $nodeExecutable $corepackCli pnpm @args
  exit $LASTEXITCODE
}
finally {
  $env:PATH = $oldPath
  $env:VEYROBOT_NODE_EXE = $oldNode
  $env:VEYROBOT_COREPACK_CLI = $oldCorepack
}
