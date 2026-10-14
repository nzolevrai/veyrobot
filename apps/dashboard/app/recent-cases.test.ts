import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRefreshRecentCases } from './recent-cases';
test('changement rapide de module ne recharge pas les dossiers récents', () => {
  assert.equal(shouldRefreshRecentCases('/dashboard/123/warnings', 10_000, 20_000), false);
  assert.equal(shouldRefreshRecentCases('/dashboard/123/member-actions', 10_000, 20_000), false);
  assert.equal(shouldRefreshRecentCases('/dashboard/123/settings', 0, 40_000), false);
  assert.equal(shouldRefreshRecentCases('/dashboard/123/overview', 0, 40_000), true);
});
