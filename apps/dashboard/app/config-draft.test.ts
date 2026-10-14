import assert from 'node:assert/strict';
import test from 'node:test';
import { changedConfig, hasConfigChanges, rebaseConfig } from './config-draft';
import type { GuildConfig } from './dashboard-types';

const saved: GuildConfig = { guildId: '1', version: 4, warningsEnabled: false, memberActionsEnabled: false, channelActionsEnabled: false, language: 'fr', timeZone: 'UTC', embedColor: '#7775F5' };
test('draft ne modifie que les champs changés du serveur', () => {
  assert.deepEqual(changedConfig(saved, { ...saved, warningsEnabled: true, language: 'en' }), { warningsEnabled: true, language: 'en' });
  assert.equal(hasConfigChanges(saved, { ...saved }), false);
  assert.equal(hasConfigChanges(saved, { ...saved, version: 5 }), false);
});
test('conflit conserve seulement les modifications locales', () => {
  const result = rebaseConfig(saved, { ...saved, warningsEnabled: true }, { ...saved, version: 5, language: 'en' });
  assert.equal(result.warningsEnabled, true);
  assert.equal(result.language, 'en');
  assert.equal(result.version, 5);
});
