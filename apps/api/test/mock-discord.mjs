import { appendFileSync } from 'node:fs';

const nativeFetch = globalThis.fetch;
let installationChecks = 0;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://discord.com/api/v10/')) return nativeFetch(input, init);
  const path = new URL(url).pathname.replace('/api/v10', '');
  if (path === '/oauth2/token') {
    if (process.env.MOCK_OAUTH_TOKEN_DELAY_MS) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Number(process.env.MOCK_OAUTH_TOKEN_DELAY_MS));
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    return Response.json({ access_token: 'local-test-oauth-token', token_type: 'Bearer', expires_in: 3600 });
  }
  if (path === '/users/@me') return Response.json({ id: process.env.TEST_USER_ID, username: 'TestMod', avatar: null });
  if (path === '/users/@me/guilds') {
    if (process.env.MOCK_GUILDS_COUNTER_FILE) appendFileSync(process.env.MOCK_GUILDS_COUNTER_FILE, 'request\n');
    const status = Number(process.env.MOCK_GUILDS_STATUS ?? 200);
    if (status !== 200) return Response.json({ message: 'Simulated Discord failure' }, { status, ...(status === 429 ? { headers: { 'retry-after': '2' } } : {}) });
    return Response.json([process.env.TEST_GUILD_A, process.env.TEST_GUILD_B, process.env.TEST_GUILD_C].map((id, index) => ({ id, name: `Test ${index + 1}`, icon: null, owner: false, permissions: '1099511627812' })));
  }
  if (path === `/guilds/${process.env.TEST_GUILD_B}`) {
    if (process.env.MOCK_INSTALLATION_CHECK_STATUS) {
      const status = Number(process.env.MOCK_INSTALLATION_CHECK_STATUS);
      return status === 200 ? Response.json({ id: process.env.TEST_GUILD_B }) : Response.json({ message: 'Unknown Guild' }, { status });
    }
    installationChecks++;
    return installationChecks === 1 ? Response.json({ message: 'Unknown Guild' }, { status: 404 }) : Response.json({ id: process.env.TEST_GUILD_B });
  }
  return Response.json({ message: 'Unexpected mock request' }, { status: 500 });
};
