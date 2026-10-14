import { spawn } from 'node:child_process';

// Root .env is loaded by the parent Node process. Next's own workers must not
// inherit --env-file through NODE_OPTIONS, so start Next with a clean argv.
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', '3000'], {
  cwd: new URL('../', import.meta.url),
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
