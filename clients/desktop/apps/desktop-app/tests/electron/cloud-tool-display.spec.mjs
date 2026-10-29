import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  CLOUD_TOOL_CASES,
  openCloudToolDisplayFixture,
} from './cloud-tool-display-fixture.mjs';

test('cloud tool names render their operation, arguments, and original expandable payload', async () => {
  const { electronApp, userDataDir, panel } =
    await openCloudToolDisplayFixture();
  try {
    await expect(panel).toBeVisible();
    const cards = panel.getByTestId('chat-tool-call');
    await expect(cards).toHaveCount(CLOUD_TOOL_CASES.length);
    for (const [
      index,
      { name, input, label, family },
    ] of CLOUD_TOOL_CASES.entries()) {
      const card = cards.nth(index);
      await expect(card).toHaveAttribute('data-tool-name', name);
      await expect(card).toHaveAttribute('data-tool-status', 'success');
      const toggle = card.getByRole('button').first();
      await expect(toggle).toHaveText(label);
      await expect(toggle).toHaveAttribute('data-tool-family', family);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(card).toContainText(
        typeof input === 'string' ? input : JSON.stringify(input),
      );
      await expect(
        card.getByText(`Cloud result ${index}`, { exact: true }),
      ).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
