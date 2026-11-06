import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch { /* try next installed browser */ }
}
if (!executable) throw new Error('No installed Chromium browser found; set CHROME_PATH to run this browser check.');
const profile = await mkdtemp(join(tmpdir(), 'veyrobot-csp-'));
const url = process.argv[2] ?? 'http://127.0.0.1:3101/';
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`);
  const policy = response.headers.get('content-security-policy') ?? '';
  if (!policy.includes('script-src') || /script-src[^;]*'unsafe-inline'/.test(policy)) throw new Error('Production script-src is missing or still allows unsafe-inline.');
  const html = await response.text();
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  if (!nonce || !html.includes(`nonce="${nonce}"`)) throw new Error('Rendered HTML does not carry the request CSP nonce on framework scripts.');
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--enable-logging=stderr', '--virtual-time-budget=5000', '--dump-dom', url];
  const result = await new Promise((resolve, reject) => {
    const browser = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    browser.stdout.setEncoding('utf8'); browser.stderr.setEncoding('utf8');
    browser.stdout.on('data', chunk => { stdout += chunk; });
    browser.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => browser.kill(), 15_000);
    browser.once('error', reject);
    browser.once('exit', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
  if (result.code !== 0) throw new Error(`Browser exited with ${result.code}: ${result.stderr.slice(-1000)}`);
  if (/Refused to execute inline script|violates the following Content Security Policy directive|blocked by CSP/i.test(result.stderr)) throw new Error(`Browser reported CSP violations: ${result.stderr.slice(-2000)}`);
  if (!result.stdout.includes('<html') || !result.stdout.includes('__next')) throw new Error('Browser did not render the Next.js page as expected.');
  console.log(JSON.stringify({ browser: executable.split(/[\\/]/).at(-1), status: response.status, scriptUnsafeInline: false, nonceOnFrameworkScripts: true, cspConsoleViolations: false, renderedNextDocument: true }));
} finally {
  await rm(profile, { recursive: true, force: true });
}
