import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultGuildConfig, guildSettingsSchema, moduleEnabled, moduleForAction, rejectPendingAfterDisable } from './guild-config.js';

test('all action modules are disabled without a guild config', () => {
  assert.equal(defaultGuildConfig.warningsEnabled, false);
  for (const id of ['warnings', 'member-actions', 'channel-actions'] as const) assert.equal(moduleEnabled(null, id), false);
});
test('a guild can enable one module without enabling another', () => {
  const row = { warningsEnabled: true, memberActionsEnabled: false, channelActionsEnabled: false };
  assert.equal(moduleEnabled(row, 'warnings'), true);
  assert.equal(moduleEnabled(row, moduleForAction('BAN')), false);
  assert.equal(moduleEnabled(row, moduleForAction('PURGE_MESSAGES')), false);
});
test('server settings accept supported languages, IANA zones and six-digit colors', () => {
  assert.equal(guildSettingsSchema.parse({ language: 'en', timeZone: 'Europe/Paris', embedColor: '#A1B2C3' }).language, 'en');
  for (const settings of [{ language: 'de', timeZone: 'UTC', embedColor: '#123456' }, { language: 'fr', timeZone: 'Mars/Base', embedColor: '#123456' }, { language: 'fr', timeZone: 'UTC', embedColor: 'blue' }]) assert.equal(guildSettingsSchema.safeParse(settings).success, false);
});
test('accepted requests survive a later disable; stale clients cannot enqueue after disable', () => {
  const disabledAt = new Date('2026-10-13T10:00:00Z');
  const config = { warningsEnabled: false, memberActionsEnabled: false, channelActionsEnabled: false, updatedAt: disabledAt };
  assert.equal(rejectPendingAfterDisable(config, 'TEMPBAN', new Date('2026-10-13T09:59:59Z')), false);
  assert.equal(rejectPendingAfterDisable(config, 'BAN', new Date('2026-10-13T10:00:01Z')), true);
  assert.equal(rejectPendingAfterDisable(null, 'BAN', new Date('2026-10-13T09:59:59Z')), false);
});
