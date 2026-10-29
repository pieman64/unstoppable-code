import { selectModelOption } from './model-selection-fixture.mjs';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  markWorkspaceOrganizationOwned,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-2349 — durable Electron coverage for the account-state recovery matrix.
// Every state is deterministic: the provider auth probe is driven by a named
// mock scenario, cloud coverage comes from fixed csk_ fixtures, and the chat is
// seeded on disk. No live provider, account, or network request is involved.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CURRENT_MODEL = 'opus[1m]';
const TARGET_MODEL = 'sonnet';
const CONTACT_ADMIN_KEY = 'csk_model_recovery_contact_admin_e2e';
const COVERED_KEY = 'csk_model_recovery_covered_e2e';
// The contact-admin key's organization. CAN-3463: only the org that owns the
// chat is probed, so the contact-admin case runs in a workspace it owns.
const CONTACT_ADMIN_ORG_ID = '77777777-7777-4777-8777-777777777777';

// CAN-4028 plan §8: the real picker, browser handoff, fresh main-process
// entitlements, and normal model mutation. Payment itself stays in the web.
for (const completion of ['deep-link', 'polling']) {
  test(`purchase unlock applies the pending model once through ${completion}`, async () => {
    test.setTimeout(120_000);
    const key = `csk_model_library_${completion.replace('-', '_')}_e2e`;
    const opened = [];
    const capture = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      opened.push(JSON.parse(body).url);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
    const address = capture.address();
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can-4028-purchase-return-'),
    );
    let electronApp;
    try {
      const entitlements = {
        plan: { key: 'free', displayName: 'Free' },
        source: 'none',
        trial: null,
        capabilities: [],
        coveringOrgs: [],
        billingManageableOrg: null,
      };
      const registerAccess = async (access) =>
        registerScenario(DEFAULT_MOCK_BASE_URL, key, {
          authUsage: { scenario: 'unauthenticated' },
          cloud: {
            entitlements: {
              ...entitlements,
              modelLibrary: access,
              workModelLibrary: { owner: { kind: 'personal' }, access },
            },
          },
        });
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      const chatId = `can-4028-${completion}`;
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        tabs: [
          { id: chatId, title: 'Model purchase return', model: CURRENT_MODEL },
        ],
      });
      await registerAccess('needs_purchase');
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_MOCK_API_KEY: key,
          CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: `http://127.0.0.1:${address.port}/capture`,
        },
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const save = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        key,
      );
      expect(save.status.authenticated).toBe(true);
      await window.evaluate(() =>
        window.dispatchEvent(new Event('canopy:cloud-account-changed')),
      );
      if (completion === 'deep-link') {
        // Delay the three-second unlock poll past this test. A successful
        // selection must come from the return event, independently of polling.
        await window.evaluate(() => {
          const schedule = window.setTimeout.bind(window);
          window.setTimeout = (callback, delay, ...args) =>
            schedule(callback, delay === 3000 ? 600_000 : delay, ...args);
        });
      }
      const picker = await openPicker(window);
      const row = window.getByTestId(`chat-model-option-${TARGET_MODEL}`);
      await expect(row).toContainText('Unlock with AI Credit purchase');
      await row.click();
      await expect(window.getByTestId('model-recovery-unlock')).toBeVisible();
      await window.getByTestId('model-recovery-unlock-purchase').click();
      await expect.poll(() => opened.length).toBe(1);
      // The browser receives an opaque auth-link consume URL. The mint
      // request, recorded by the existing fixture, carries the billing intent.
      const activity = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
      const minted = Object.keys(activity.activity).find((name) =>
        name.startsWith('authLinkMint:'),
      );
      expect(minted).toBeTruthy();
      const checkout = new URL(
        minted.slice('authLinkMint:'.length),
        DEFAULT_MOCK_BASE_URL,
      );
      expect(checkout.searchParams.get('reason')).toBe('unlock_models');
      const requestId = checkout.searchParams.get('requestId');
      expect(requestId).toBeTruthy();
      await expect(
        window.getByTestId('model-recovery-unlock-waiting'),
      ).toBeVisible();
      await registerAccess('unlocked');
      const returned = new URL('canopy://billing/unlocked');
      returned.searchParams.set('requestId', requestId);
      returned.searchParams.set('modelId', TARGET_MODEL);
      returned.searchParams.set('chatId', chatId);
      if (completion === 'deep-link') {
        await electronApp.evaluate(({ app: nativeApp }, url) => {
          nativeApp.emit('open-url', { preventDefault() {} }, url);
        }, returned.toString());
      }
      await expect(picker).toContainText('Sonnet', { timeout: 30_000 });
      expect(opened).toHaveLength(1);
      await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
      await picker.click();
      await selectModelOption(window, 'haiku');
      await expect(picker).toContainText('Haiku');
      const beforeReplay =
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity
          .entitlementsRead ?? 0;
      await electronApp.evaluate(({ app: nativeApp }, url) => {
        nativeApp.emit('open-url', { preventDefault() {} }, url);
      }, returned.toString());
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity
              .entitlementsRead ?? 0,
        )
        .toBeGreaterThan(beforeReplay);
      await expect(picker).toContainText('Haiku');
      expect(opened).toHaveLength(1);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, key);
      await new Promise((resolve) => capture.close(resolve));
    }
  });
}

function seedTree(userDataDir, id) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  markWorkspaceOrganizationOwned(
    userDataDir,
    WORKSPACE_ID,
    CONTACT_ADMIN_ORG_ID,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id, title: 'Model recovery', model: CURRENT_MODEL }],
  });
}

async function launchSignedOutChat(prefix, authKey) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedTree(userDataDir, authKey);
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_API_KEY: authKey },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  return { electronApp, userDataDir, window, authKey };
}

async function closeFixture(fixture) {
  try {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, fixture.authKey).catch(
      () => undefined,
    );
  }
}

async function openPicker(window) {
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(picker).toContainText('Opus');
  await picker.click();
  return picker;
}

test('case A is indistinguishable until click and cancel never commits', async () => {
  const fixture = await launchSignedOutChat(
    'canopy-model-recovery-cancel-',
    'can-2349-cancel-unauthenticated',
  );
  try {
    const picker = await openPicker(fixture.window);
    const row = fixture.window.getByTestId(`chat-model-option-${TARGET_MODEL}`);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-disabled', 'true');
    await expect(
      row.getByTestId('chat-model-option-locked-claude'),
    ).toHaveCount(0);

    await row.click();
    const modal = fixture.window.getByTestId('model-recovery-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Sonnet');
    await fixture.window.getByTestId('model-recovery-cancel').click();
    await expect(modal).toHaveCount(0);
    await expect(picker).toContainText('Opus');
  } finally {
    await closeFixture(fixture);
  }
});

test('contact-admin rows stay selectable and recover with Try again, not purchase', async () => {
  const fixture = await launchSignedOutChat(
    'canopy-model-recovery-admin-',
    'can-2349-admin-unauthenticated',
  );
  try {
    const save = await fixture.window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      CONTACT_ADMIN_KEY,
    );
    expect(save.status.authenticated).toBe(true);

    await openPicker(fixture.window);
    const row = fixture.window.getByTestId(`chat-model-option-${TARGET_MODEL}`);
    await expect(row).not.toHaveAttribute('aria-disabled', 'true');
    await row.click();

    const modal = fixture.window.getByTestId('model-recovery-modal');
    await expect(modal).toBeVisible();
    await expect(
      fixture.window.getByTestId('model-recovery-contact-admin'),
    ).toContainText('Contact your org admin to increase your spend quota.');
    await expect(
      fixture.window.getByTestId('model-recovery-try-again'),
    ).toBeVisible();
    await expect(
      fixture.window.getByTestId('model-recovery-get-credits'),
    ).toHaveCount(0);
  } finally {
    await closeFixture(fixture);
  }
});

test('guest connect through the cloud gate commits the clicked model', async () => {
  const fixture = await launchSignedOutChat(
    'canopy-model-recovery-purchase-',
    'can-2349-purchase-unauthenticated',
  );
  try {
    const picker = await openPicker(fixture.window);
    await selectModelOption(fixture.window, `${TARGET_MODEL}`);
    await expect(
      fixture.window.getByTestId('model-recovery-guest'),
    ).toBeVisible();

    // Click FIRST, while still a guest, so the CTA genuinely runs through
    // `requestConnect` and the shared cloud gate opens. Connecting beforehand
    // short-circuits that gate, which is exactly how a regression in this path
    // (the recovery modal unmounting under the gate and orphaning the CTA's
    // post-connect commit) stayed invisible to this spec.
    await fixture.window.getByTestId('model-recovery-get-credits').click();
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toBeVisible();

    // The recovery modal must still be MOUNTED underneath — hidden, not
    // unmounted — or the callback the gate is about to invoke is an orphan.
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(1);

    // Deterministically stand in for completing sign-in in the browser.
    const save = await fixture.window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      COVERED_KEY,
    );
    expect(save.status.authenticated).toBe(true);
    await fixture.window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    // The account-change event emitted by the real account section is
    // sufficient: the auth hook's recovery effect observes the now-connected
    // account, closes the gate, and invokes `proceed`, which re-reads coverage
    // and commits — no second click and no billing page for credits they
    // already have.
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toHaveCount(0);

    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(0);
    await expect(picker).toContainText('Sonnet');
  } finally {
    await closeFixture(fixture);
  }
});
