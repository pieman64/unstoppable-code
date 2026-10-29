import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';
import {
  FAKE_PROXY_MANAGEMENT_KEY,
  defaultFakeProxyState,
  startFakeAccountProxy,
} from './fixtures/fake-account-proxy.mjs';

/**
 * Ultra fast through the account proxy (CAN-4302).
 *
 * With Codex routed through the proxy, the Codex default speed picker offers
 * Ultra fast only when both the runtime `model/list` catalog and the proxy's
 * own Codex catalog (`GET /v1/models?client_version=`) advertise it. The
 * runtime catalog offers it throughout; the proxy offers it only after it
 * changes, and "Check again" picks that up.
 */

const SCENARIO_KEY = 'account-proxy-codex-speed';
const FAST = { id: 'priority', name: 'Fast', description: 'Fast' };
const ULTRA = { id: 'ultrafast', name: 'Ultra fast', description: 'Ultra' };

test('the Codex default offers Ultra fast through the proxy only when the proxy offers it', async () => {
  test.setTimeout(240_000);
  await registerScenario(DEFAULT_MOCK_BASE_URL, SCENARIO_KEY, {
    codexAccountModels: [
      {
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        serviceTiers: [FAST, ULTRA],
      },
    ],
  });
  const state = defaultFakeProxyState();
  state.codexModels = [{ slug: 'gpt-6-astra', service_tiers: [FAST] }];
  const proxy = await startFakeAccountProxy({ state });
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_MOCK_API_KEY: SCENARIO_KEY },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({ accountProxyEnabled: true }),
    );
    const connected = await window.evaluate(
      ({ url, key }) =>
        window.api.accountProxy.connect({ url, managementKey: key }),
      { url: proxy.url, key: FAKE_PROXY_MANAGEMENT_KEY },
    );
    expect(connected.ok).toBe(true);

    await app.openSettings();
    await app.openSettingsSection('codex');
    const picker = window.getByTestId('settings-codex-fast-mode-default');
    const ultra = window.getByTestId('settings-codex-speed-default-ultrafast');
    await expect(ultra).toBeDisabled({ timeout: 30_000 });
    await expect(picker).toContainText('Not offered on this Codex connection');
    await expect(
      window.getByTestId('settings-codex-speed-default-fast'),
    ).toBeEnabled();

    state.codexModels = [{ slug: 'gpt-6-astra', service_tiers: [FAST, ULTRA] }];
    const refresh = window.getByTestId('settings-codex-speed-refresh');
    await refresh.click();
    await expect(ultra).toBeEnabled({ timeout: 30_000 });
    await expect(picker).not.toContainText(
      'Not offered on this Codex connection',
    );

    expect(proxy.codexCatalogRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of proxy.codexCatalogRequests) {
      expect(request.authorized).toBe(true);
      expect(request.clientVersion).toMatch(/\S/);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await proxy.close();
  }
});
