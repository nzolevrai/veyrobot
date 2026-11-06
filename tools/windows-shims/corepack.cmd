@echo off
if not defined VEYROBOT_NODE_EXE (
  echo Use tools\pnpm.ps1 to run VeyroBot commands with its pinned Node runtime. 1>&2
  exit /b 1
)
if not defined VEYROBOT_COREPACK_CLI (
  echo VeyroBot Corepack CLI path is not configured. 1>&2
  exit /b 1
)
"%VEYROBOT_NODE_EXE%" "%VEYROBOT_COREPACK_CLI%" %*
exit /b %ERRORLEVEL%
