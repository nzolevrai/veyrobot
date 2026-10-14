import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistWarningCase } from './warning-case.js';

test('shared warning service writes the same completed guild-scoped dossier record', async () => {
  let stored: unknown;
  const result = await persistWarningCase({
    async create({ data }) { stored = data; return { id: 'case-1' }; },
  }, { guildId: 'guild-1', actorId: 'moderator-1', targetId: 'member-1', reason: 'Repeated spam' });

  assert.deepEqual(stored, {
    guildId: 'guild-1', actorId: 'moderator-1', targetId: 'member-1',
    reason: 'Repeated spam', action: 'WARN', status: 'completed',
  });
  assert.deepEqual(result, { id: 'case-1' });
});
