import assert from 'node:assert/strict';
import { test } from 'node:test';
import { casesForGuildQuery } from './index.js';

test('moderation dossier queries are always scoped to one guild', () => {
  assert.deepEqual(casesForGuildQuery('11111111111111111'), { guildId: '11111111111111111' });
  assert.deepEqual(casesForGuildQuery('11111111111111111', '22222222222222222'), { guildId: '11111111111111111', targetId: '22222222222222222' });
  assert.notDeepEqual(casesForGuildQuery('11111111111111111'), casesForGuildQuery('33333333333333333'));
});
