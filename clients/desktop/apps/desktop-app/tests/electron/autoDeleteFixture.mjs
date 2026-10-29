import { expect } from '@playwright/test';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';

export function useBundledAutoDeleteTestRuntime() {
  for (const key of Object.keys(process.env)) {
    if (/^CANOPY_[A-Z0-9]+_BINARY_PATH$/.test(key)) delete process.env[key];
  }
}

/** A real composer/provider turn proves the restored original chat remains usable. */
export async function continueRestoredAutoDeleteChat(page, marker) {
  const reply = `Restored conversation continued ${marker}`;
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });
  const dismiss = page
    .getByTestId('toast-card')
    .getByRole('button', { name: 'Dismiss', exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  const panel = page.getByTestId('panel-content-chat');
  const composer = panel.getByRole('textbox').first();
  await composer.fill(`[${marker}] Continue this original conversation.`);
  await panel
    .getByRole('button', { name: 'Send message', exact: true })
    .click();
  await expect(panel.getByText(reply).first()).toBeVisible({ timeout: 90_000 });
  await expect(
    panel.getByRole('button', { name: 'Stop generation', exact: true }),
  ).toHaveCount(0);
}
