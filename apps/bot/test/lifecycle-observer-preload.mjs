import { Client, Events } from 'discord.js';

// Make discord.js's initial heartbeat jitter immediate; the simulated Gateway
// advertises a production-scale interval so test timing cannot create zombies.
Math.random = () => 0;

const originalLogin = Client.prototype.login;
const originalDestroy = Client.prototype.destroy;
const activeIntervals = new Set();
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
globalThis.setInterval = function observedSetInterval(callback, delay, ...args) {
  const handle = nativeSetInterval(callback, delay, ...args);
  activeIntervals.add(handle);
  return handle;
};
globalThis.clearInterval = function observedClearInterval(handle) {
  activeIntervals.delete(handle);
  return nativeClearInterval(handle);
};

globalThis.__veyrobotClient = undefined;
let readyEvents = 0;
let reconnectEvents = 0;
let resumeEvents = 0;
let holdDestroyCompletion = false;
let observeLifecycleEvents = true;
let releaseDestroyCompletion;
const destroyCompletionGate = new Promise(resolve => { releaseDestroyCompletion = resolve; });
Client.prototype.login = async function observedLogin(...args) {
  globalThis.__veyrobotClient = this;
  if (process.env.BOT_LIFECYCLE_REST_URL) this.rest.options.api = `${process.env.BOT_LIFECYCLE_REST_URL}/api`;
  this.on(Events.ClientReady, () => { readyEvents++; if (observeLifecycleEvents) process.send?.({ lifecycleEvent: 'ready', count: readyEvents }); });
  this.on(Events.ShardReconnecting, () => { reconnectEvents++; if (observeLifecycleEvents) process.send?.({ lifecycleEvent: 'reconnecting', count: reconnectEvents }); });
  this.on(Events.ShardResume, () => { resumeEvents++; if (observeLifecycleEvents) process.send?.({ lifecycleEvent: 'resumed', count: resumeEvents }); });
  return originalLogin.apply(this, args);
};
Client.prototype.destroy = async function observedDestroy(...args) {
  await originalDestroy.apply(this, args);
  if (holdDestroyCompletion) {
    process.send?.({ gatewayDestroyCompleted: true });
    await destroyCompletionGate;
  }
};

process.on('message', async message => {
  if (message?.type === 'hold-client-destroy-completion') {
    holdDestroyCompletion = true;
    process.send?.({ lifecycleEvent: 'destroy-hold-ready', count: 1 });
    return;
  }
  if (message?.type === 'release-client-destroy-completion') {
    observeLifecycleEvents = false;
    releaseDestroyCompletion();
    process.channel?.unref();
    process.send?.({ lifecycleEvent: 'destroy-release-ack', count: 1 });
    return;
  }
  if (message?.type === 'request-graceful-shutdown') {
    process.emit('SIGTERM');
    return;
  }
  if (message?.type !== 'bot-lifecycle-snapshot') return;
  const [{ readBotCacheCounts }, db] = await Promise.all([
    import('../dist/resource-snapshot.js'),
    import('@veyrobot/db'),
  ]);
  const memory = process.memoryUsage();
  const activeClient = globalThis.__veyrobotClient;
  const clientEvents = activeClient?.eventNames().map(event => [String(event), activeClient.listenerCount(event)]) ?? [];
  const shardListeners = activeClient?.ws.shards.map(shard => Object.fromEntries(shard.eventNames().map(event => [String(event), shard.listenerCount(event)]))) ?? [];
  process.send?.({
    lifecycleSnapshot: {
      pid: process.pid,
      readyEvents,
      reconnectEvents,
      resumeEvents,
      intervals: activeIntervals.size,
      activeResources: process.getActiveResourcesInfo().reduce((counts, type) => ({ ...counts, [type]: (counts[type] ?? 0) + 1 }), {}),
      clientEvents,
      shardListeners,
      shardCount: activeClient?.ws.shards.size ?? 0,
      clientReady: activeClient?.isReady() ?? false,
      cacheCounts: activeClient ? readBotCacheCounts(activeClient) : null,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      postgresPool: { total: db.postgresPool.totalCount, idle: db.postgresPool.idleCount, waiting: db.postgresPool.waitingCount },
    },
  });
});

process.on('uncaughtExceptionMonitor', (error, origin) => {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  const frame = typeof error?.stack === 'string' ? error.stack.split('\n')[1]?.trim().slice(0, 240) : undefined;
  process.send?.({ lifecycleDiagnostic: { event: 'uncaught_exception_monitor', name: error?.name === 'Error' ? 'Error' : 'OtherError', code, origin, frame } });
});
