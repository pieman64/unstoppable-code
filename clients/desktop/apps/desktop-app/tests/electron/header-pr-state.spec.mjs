import { test } from '@playwright/test';
import { runHeaderPrStateScenario } from './header-pr-state.scenario.mjs';

test.describe('worktree header PR/CI states', () => {
  test('verifies the open-PR, failing-CI, and no-PR header states', async () => {
    await runHeaderPrStateScenario();
  });
});
