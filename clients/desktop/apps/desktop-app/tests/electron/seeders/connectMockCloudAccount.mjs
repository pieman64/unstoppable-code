import { expect } from '@playwright/test';

const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

/**
 * Connects a mock cloud account through the real preload API, announces the
 * account change that direct IPC callers otherwise skip, and verifies the
 * renderer can immediately read the expected authenticated identity.
 */
export async function connectMockCloudAccount(
  page,
  apiKey,
  { expectedAccount = {}, expectedStatus = {} } = {},
) {
  const result = await page.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  expect(
    result.status,
    result.status?.error ?? `Mock account ${apiKey} did not connect`,
  ).toMatchObject({ authenticated: true, ...expectedStatus });
  expect(result.account).toMatchObject({
    hasApiKey: true,
    ...expectedAccount,
  });

  await page.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, CLOUD_ACCOUNT_CHANGED_EVENT);
  const loadedAccount = await page.evaluate(() =>
    window.api.loadCanopyCloudAccount(),
  );
  expect(loadedAccount).toMatchObject({
    hasApiKey: true,
    ...expectedAccount,
  });
  return result;
}
