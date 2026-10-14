import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleCategories, moduleRegistry, searchModules } from './module-registry';
test('module search ignores accents and case and only matches local registry fields', () => {
  assert.deepEqual(searchModules('AVERTISSEMENTS').map(item => item.id), ['warnings']);
  assert.deepEqual(searchModules('depart').map(item => item.id), ['welcome']);
  assert.deepEqual(searchModules('PuRgE').map(item => item.id), ['channel-actions']);
  assert.deepEqual(searchModules('introuvable'), []);
});
test('categories retain a stable order and unavailable examples have no destination', () => {
  assert.deepEqual(moduleCategories, ['Accueil des membres', 'Modération des membres', 'Modération des salons', 'Suivi']);
  assert.ok(moduleRegistry.every(item => moduleCategories.includes(item.category)));
  assert.ok(moduleRegistry.filter(item => !item.implemented).every(item => !item.destination && !item.enabledKey));
});
