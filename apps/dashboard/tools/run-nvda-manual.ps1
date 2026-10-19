$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
Push-Location $repoRoot
$containerName = "veyrobot-nvda-$([guid]::NewGuid().ToString('N').Substring(0, 10))"
$containerStarted = $false
$savedEnvironment = @{}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File exited with code $LASTEXITCODE" }
}

function Save-Environment([string]$Name, [string]$Value) {
  $savedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

try {
  $nodeVersionFile = Join-Path $repoRoot '.node-version'
  $pinnedNodeVersion = (Get-Content -LiteralPath $nodeVersionFile -ErrorAction Stop | Select-Object -First 1).Trim()
  $pinnedNodeDirectory = Join-Path $env:LOCALAPPDATA "VeyroBot\runtime\node-v$pinnedNodeVersion-win-x64"
  if (Test-Path -LiteralPath (Join-Path $pinnedNodeDirectory 'node.exe')) {
    Save-Environment 'PATH' "$pinnedNodeDirectory;$env:PATH"
  }
  $nodeVersion = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(24\.(1[7-9]|[2-9]\d)|2[5-9]\.)') {
    throw "Node >=24.17.0 requis; version détectée : $nodeVersion"
  }
  if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw 'Corepack est requis.' }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop/Engine est requis.' }
  & docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Le moteur Docker est indisponible.' }

  $playwrightCache = Join-Path $env:LOCALAPPDATA 'ms-playwright'
  $firefoxDirectory = Get-ChildItem -LiteralPath $playwrightCache -Directory -Filter 'firefox-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $firefoxDirectory) {
    $temporaryCaches = Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'veyrobot-playwright-firefox-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    foreach ($temporaryCache in $temporaryCaches) {
      $candidate = Get-ChildItem -LiteralPath $temporaryCache.FullName -Directory -Filter 'firefox-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
      if ($candidate) { $playwrightCache = $temporaryCache.FullName; $firefoxDirectory = $candidate; break }
    }
  }
  if (-not $firefoxDirectory) {
    throw 'Firefox Playwright absent. Installe-le dans le cache utilisateur avec : corepack pnpm --filter @veyrobot/dashboard exec playwright install firefox ; puis relance cette commande.'
  }
  Save-Environment 'PLAYWRIGHT_BROWSERS_PATH' $playwrightCache

  Invoke-Checked 'docker' @('run', '--detach', '--rm', '--name', $containerName, '--env', 'POSTGRES_USER=veyrobot_test', '--env', 'POSTGRES_PASSWORD=nvda_fixture_only', '--env', 'POSTGRES_DB=veyrobot_nvda_test', '--publish', '127.0.0.1::5432', 'postgres:17')
  $containerStarted = $true
  $mappedPort = (& docker port $containerName '5432/tcp' | Select-Object -First 1).Trim()
  if ($LASTEXITCODE -ne 0 -or $mappedPort -notmatch '^127\.0\.0\.1:(\d+)$') { throw 'Impossible de déterminer le port local PostgreSQL isolé.' }
  $port = $Matches[1]
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec $containerName pg_isready -U veyrobot_test -d veyrobot_nvda_test *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'PostgreSQL 17 isolé ne devient pas prêt.' }

  Save-Environment 'DATABASE_URL' "postgresql://veyrobot_test:nvda_fixture_only@127.0.0.1:$port/veyrobot_nvda_test?schema=public"
  Save-Environment 'RUN_POSTGRES_INTEGRATION' '1'
  Save-Environment 'RUN_DASHBOARD_ROUTE_INTEGRATION' '1'
  Save-Environment 'RUN_DASHBOARD_BROWSER_INTEGRATION' '1'
  Save-Environment 'DASHBOARD_BROWSER_ENGINE' 'firefox'
  Save-Environment 'DASHBOARD_NVDA_MANUAL' '1'

  Invoke-Checked 'corepack' @('pnpm', 'db:generate')
  Invoke-Checked 'corepack' @('pnpm', 'db:migrate')
  Invoke-Checked 'corepack' @('pnpm', 'build')
  Invoke-Checked 'corepack' @('pnpm', '--filter', '@veyrobot/api', 'exec', 'node', 'test/integration.mjs')
}
finally {
  foreach ($name in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
  if ($containerStarted) {
    & docker stop $containerName *> $null
  }
  Pop-Location
}
