import { test } from '@playwright/test';
import { runHeaderChatOpenedRedesignScenario } from './header-chat-opened-redesign.scenario.mjs';

test.describe('project header (chat opened) redesign', () => {
  test('breadcrumb, branch menu, inline rename, and tab-strip chrome', async () => {
    await runHeaderChatOpenedRedesignScenario();
  });
});
