import { opencodeRuntimeFixture } from './fixtures/opencode-runtime.mjs';
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
import { BILLING_TOP_UP_MIN_USD } from '../../../../packages/protocol/src/billing/top-up-intent.ts';

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
// CAN-5027: each completion also confirms the unlock above the composer.
// CAN-5160: the 3.2 free credits read before checkout opened make the title
// name the increase, like every other purchase path.
const UNLOCK_CONFIRMED_WITH_MODEL =
  /^1,196\.8 AI Credits added\. Balance: 1,200 credits\. Sonnet.* is selected for this chat\.$/;
const UNLOCK_CONFIRMED_WITHOUT_MODEL =
  '1,196.8 AI Credits added. Balance: 1,200 credits. Advanced models are unlocked.';
const RETENTION_MARKER = 'Canopy-CUNLOCKRETENTION';
for (const completion of [
  'deep-link',
  'polling',
  'focus',
  'opencode-deep-link',
]) {
  test(`purchase unlock applies the pending model once through ${completion}`, async () => {
    test.setTimeout(120_000);
    const useOpenCode = completion === 'opencode-deep-link';
    const runtime = useOpenCode ? await opencodeRuntimeFixture() : undefined;
    const key = `csk_model_library_${completion.replaceAll('-', '_')}_e2e`;
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
      // CAN-5026: access and the wallet change together, as one complete
      // scenario; `holdBalance` parks every balance read on a barrier.
      const registerAccess = async (access, credits, holdBalance) =>
        registerScenario(DEFAULT_MOCK_BASE_URL, key, {
          authUsage: { scenario: 'unauthenticated' },
          cloud: {
            entitlements: {
              ...entitlements,
              modelLibrary: access,
              workModelLibrary: { owner: { kind: 'personal' }, access },
            },
            aiCreditsBalance: { credits, eligible: true },
            ...(holdBalance
              ? { aiCreditsBalanceWaitFor: BALANCE_BARRIER }
              : {}),
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
          {
            id: `${chatId}-other`,
            title: 'Another chat',
            model: CURRENT_MODEL,
          },
        ],
      });
      await registerAccess('needs_purchase', 3.2);
      if (completion === 'deep-link') {
        await registerScenario(DEFAULT_MOCK_BASE_URL, RETENTION_MARKER, {
          llm: {
            steps: [{ text: 'Keeping the confirmation.', streamMs: 60_000 }],
          },
        });
      }
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...runtime?.env,
          CANOPY_MOCK_API_KEY: key,
          CANOPY_MOCK_LLM_BASE_URL: DEFAULT_MOCK_BASE_URL,
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
      if (useOpenCode) {
        await app.openSettings();
        await app.openSettingsSection('experiments');
        await window.getByTestId('opencode-connect').click();
        await expect(
          window.getByTestId('opencode-connection-status'),
        ).toHaveText('OpenCode connected');
        await app.closeSettings();
      }
      if (completion !== 'polling') {
        // Delay the three-second unlock poll past this test. A successful
        // selection must come from the return event, independently of polling.
        await window.evaluate(() => {
          const schedule = window.setTimeout.bind(window);
          window.setTimeout = (callback, delay, ...args) =>
            schedule(callback, delay === 3000 ? 600_000 : delay, ...args);
        });
      }
      const composer = window.getByRole('textbox').first();
      const draft = 'Keep this draft while unlocking Sonnet';
      await composer.fill(draft);
      const meter = window.getByTestId('usage-indicator').filter({
        visible: true,
      });
      // CAN-5028: before the first purchase the balance reads as free credits.
      await expectComposerBalance(window, meter, '3.2', 'Free AI Credits');
      const picker = await openPicker(window);
      if (useOpenCode)
        await window.getByTestId('chat-model-harness-tab-opencode').click();
      const row = window
        .getByTestId(`chat-model-option-${TARGET_MODEL}`)
        .filter({ visible: true });
      await expect(row).toContainText('Unlock with AI Credit purchase');
      await row.click();
      await expect(window.getByTestId('model-recovery-unlock')).toBeVisible();
      // Named for the clicked Sonnet row (the composer is on another model),
      // with the free-credit reason, the checkout minimum, and the scope in
      // the body. The catalog's version suffix moves, so it is not pinned.
      const unlockTitle = window
        .getByTestId('model-recovery-modal')
        .getByRole('heading', { name: /^Unlock Sonnet(?: \d+(?:\.\d+)*)?$/ });
      await expect(unlockTitle).toBeVisible();
      await expect(picker).toContainText('Opus');
      await expect(composer).toHaveText(draft);
      await expect(window.getByTestId('model-recovery-unlock')).toHaveText(
        `Free daily credits don't unlock advanced models. Purchase some AI Credits (minimum $${BILLING_TOP_UP_MIN_USD}) to unlock Sonnet, Opus, Fable and more. We'll switch to your selected model once the purchase is complete.`,
      );
      await window
        .getByTestId('model-recovery-modal')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
      await expect(picker).toContainText('Opus');
      await expect(composer).toHaveText(draft);
      expect(opened).toHaveLength(0);
      await picker.click();
      if (useOpenCode)
        await window.getByTestId('chat-model-harness-tab-opencode').click();
      await row.click();
      await window.getByTestId('model-recovery-unlock-purchase').click();
      await expect.poll(() => opened.length).toBe(1);
      // The browser receives an opaque auth-link consume URL. The mint
      // request, recorded by the existing fixture, carries the billing intent.
      // Opening Settings to connect OpenCode also mints the hosted settings
      // session link to `/`; only the purchase mints the checkout.
      const activity = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
      const minted = Object.keys(activity.activity).filter(
        (name) =>
          name.startsWith('authLinkMint:') &&
          !(useOpenCode && name === 'authLinkMint:/'),
      );
      expect(minted).toHaveLength(1);
      const checkout = new URL(
        minted[0].slice('authLinkMint:'.length),
        DEFAULT_MOCK_BASE_URL,
      );
      expect(checkout.searchParams.get('reason')).toBe('unlock_models');
      const requestId = checkout.searchParams.get('requestId');
      expect(requestId).toBeTruthy();
      await expect(
        window.getByTestId('model-recovery-unlock-waiting'),
      ).toBeVisible();
      await expect(unlockTitle).toBeVisible();
      await expect(picker).toContainText('Opus');
      await expect(composer).toHaveText(draft);
      if (completion === 'polling') {
        // The journey closes "Finish in your browser"; only the poll confirms.
        await window
          .getByTestId('model-recovery-modal')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
        // Click after dialog dismissal so focus restoration cannot consume
        // the key used to open the numeric popover through invalidation.
        await meter.click();
        await expect(
          window.getByTestId('usage-indicator-account-credit-balance'),
        ).toHaveText('3.2');
      }
      // The width of the last figure the trigger showed. CAN-5028: the unlock
      // drops "Free" from the label (`3.2 AI Credits`) before the balance is
      // withdrawn, so the capsule legitimately narrows by that word; the
      // pending skeleton then holds the width of that last figure (CAN-5026).
      if (completion === 'polling') {
        await meter.evaluate((element) => {
          const record = () => {
            const figure = element.querySelector(
              '[data-testid="usage-indicator-credit-balance"]',
            );
            if (figure && figure.getAttribute('data-pending') !== 'true') {
              window.__lastBalanceFigureWidth =
                figure.getBoundingClientRect().width;
            }
          };
          record();
          window.__lastBalanceFigureObserver = new MutationObserver(record);
          window.__lastBalanceFigureObserver.observe(element, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
        });
      }
      await registerAccess('unlocked', 1200, completion === 'polling');
      const returned = new URL('canopy://billing/unlocked');
      returned.searchParams.set('requestId', requestId);
      returned.searchParams.set('modelId', TARGET_MODEL);
      returned.searchParams.set('chatId', chatId);
      if (completion === 'focus') {
        await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      } else if (completion !== 'polling') {
        await electronApp.evaluate(({ app: nativeApp }, url) => {
          nativeApp.emit('open-url', { preventDefault() {} }, url);
        }, returned.toString());
      }
      // The toast is unchanged, and asserted before its own timeout.
      await expect(
        window
          .getByTestId('toast-card')
          .filter({ hasText: 'Advanced models are unlocked.' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(picker).toContainText('Sonnet', { timeout: 30_000 });
      await expect(composer).toHaveText(draft);
      const saved = await window.evaluate(
        (target) => window.api.chat.loadTabs(target),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
      expect(saved.tabs.find((tab) => tab.id === chatId)?.model).toBe(
        TARGET_MODEL,
      );
      await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
      if (completion === 'polling') {
        // The confirmation withdrew 3.2; its re-read is parked on the barrier.
        await expect(meter).toHaveAttribute('aria-busy', 'true');
        await expect(meter).toHaveAccessibleName('Usage indicator');
        await expect(
          meter.getByTestId('usage-indicator-credit-balance'),
        ).toHaveAttribute('data-pending', 'true');
        await expect(meter).not.toContainText('3.2');
        const lastFigureWidth = await window.evaluate(() => {
          window.__lastBalanceFigureObserver?.disconnect();
          return window.__lastBalanceFigureWidth;
        });
        expect(lastFigureWidth).toBeGreaterThan(0);
        const skeletonWidth = (
          await meter
            .getByTestId('usage-indicator-credit-balance')
            .boundingBox()
        ).width;
        expect(Math.abs(skeletonWidth - lastFigureWidth)).toBeLessThanOrEqual(
          1,
        );
        const account = window.getByTestId('usage-indicator-account');
        await expect(account).toHaveAttribute('aria-busy', 'true');
        await expect(account).not.toContainText('3.2');
        await releaseBalanceBarrier(key);
        await expect(
          account.getByTestId('usage-indicator-account-credit-balance'),
        ).toHaveText('1,200');
        await window.keyboard.press('Escape');
      }
      await expectComposerBalance(window, meter, '1,200', 'AI Credits');
      // The transcript proves no user message was committed. These request
      // counters also prove neither fixture execution path started a turn:
      // Claude routes via this scenario key; OpenCode records every ACP RPC.
      const requestEvidence = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/requests?key=${encodeURIComponent(key)}`,
      );
      expect(requestEvidence.ok).toBe(true);
      expect((await requestEvidence.json()).requests).toEqual([]);
      if (runtime) {
        expect(
          (await runtime.readDiagnostics()).filter(
            (entry) => entry.method === 'session/prompt',
          ),
        ).toEqual([]);
      }
      const transcript = await window.evaluate(
        (target) => window.api.chat.getTranscriptPage(target),
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId },
      );
      expect(transcript.messages).toEqual([]);
      const confirmation = window.getByTestId('model-unlock-confirmed-notice');
      await expect(confirmation).toHaveText(UNLOCK_CONFIRMED_WITH_MODEL);
      await expect(confirmation).toHaveAttribute('role', 'status');
      if (useOpenCode) {
        await expect
          .poll(async () => {
            const state = await window.evaluate(
              (target) => window.api.chat.loadTabs(target),
              { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
            );
            return state.tabs.find((tab) => tab.id === chatId);
          })
          .toMatchObject({
            model: TARGET_MODEL,
            providerType: 'opencode',
            executionHarness: 'opencode',
          });
      }
      expect(opened).toHaveLength(1);
      await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
      await picker.click();
      await selectModelOption(window, 'haiku');
      await expect(picker).toContainText('Haiku');
      // The model sentence follows the chat's actual selection.
      await expect(confirmation).toHaveText(UNLOCK_CONFIRMED_WITHOUT_MODEL);
      // Navigation keeps the confirmation.
      await app.openSettings();
      await app.closeSettings();
      await expect(confirmation).toHaveText(UNLOCK_CONFIRMED_WITHOUT_MODEL);
      await window.getByTestId(`panel-tab-panel-chat-${chatId}-other`).click();
      await expect(confirmation).toHaveCount(0);
      await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
      await expect(confirmation).toHaveText(UNLOCK_CONFIRMED_WITHOUT_MODEL);
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
      await expect(confirmation).toHaveCount(1);
      if (completion === 'deep-link') {
        const composer = window
          .locator(
            '[data-chat-composer-root]:not([data-testid="queued-message-editor"]) [data-chat-textarea][contenteditable="true"]',
          )
          .last();
        await composer.fill(`[${RETENTION_MARKER}] Keep the confirmation`);
        await composer.press('Enter');
        await expect(window.getByTestId('chat-stop-generation')).toBeVisible();
        await expect(confirmation).toHaveText(UNLOCK_CONFIRMED_WITHOUT_MODEL);
        await composer.fill('A queued follow-up');
        await composer.press('Enter');
        const queued = window.getByTestId('queued-message-bubble');
        await expect(queued).toHaveCount(1);
        await queued.getByTestId('queued-message-preview').dblclick();
        const editor = window.getByTestId('queued-message-editor');
        await expect(editor).toBeVisible();
        await expect(
          editor.getByTestId('model-unlock-confirmed-notice'),
        ).toHaveCount(0);
        await editor.getByTestId('queued-message-edit-cancel').click();
        await expect(confirmation).toHaveText(UNLOCK_CONFIRMED_WITHOUT_MODEL);
        await window.getByTestId('chat-stop-generation').click();
      }
      await window.getByTestId('model-unlock-confirmed-notice-dismiss').click();
      await expect(confirmation).toHaveCount(0);
      // A replayed return for the same request cannot bring it back.
      await electronApp.evaluate(({ app: nativeApp }, url) => {
        nativeApp.emit('open-url', { preventDefault() {} }, url);
      }, returned.toString());
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(picker).toContainText('Haiku');
      await expect(confirmation).toHaveCount(0);
      expect(opened).toHaveLength(1);
    } finally {
      if (completion === 'polling') await releaseBalanceBarrier(key);
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await runtime?.close();
      await clearScenario(DEFAULT_MOCK_BASE_URL, key);
      if (completion === 'deep-link') {
        await clearScenario(DEFAULT_MOCK_BASE_URL, RETENTION_MARKER);
      }
      await new Promise((resolve) => capture.close(resolve));
    }
  });
}

// CAN-5030 — Close never cancels or forgets a purchase finishing in the
// browser. The composer keeps the cue, a locked row resumes the same purchase
// instead of minting another checkout, and a timeout offers only explicit,
// accurately described recovery.
async function launchPendingPurchase(name) {
  const key = `csk_model_library_${name.replaceAll('-', '_')}_e2e`;
  const opened = [];
  const capture = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    opened.push(JSON.parse(body).url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `can-5030-${name}-`));
  const registerAccess = async (access) =>
    registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      authUsage: { scenario: 'unauthenticated' },
      cloud: {
        entitlements: {
          plan: { key: 'free', displayName: 'Free' },
          source: 'none',
          trial: null,
          capabilities: [],
          coveringOrgs: [],
          billingManageableOrg: null,
          modelLibrary: access,
          workModelLibrary: { owner: { kind: 'personal' }, access },
        },
      },
    });
  const fixture = {
    key,
    opened,
    userDataDir,
    registerAccess,
    electronApp: undefined,
    window: undefined,
    async close() {
      try {
        if (fixture.window) {
          await fixture.window
            .evaluate(() => {
              if (window.__can5030RealNow) Date.now = window.__can5030RealNow;
            })
            .catch(() => undefined);
        }
        if (fixture.electronApp)
          await closeCanopy(fixture.electronApp, userDataDir);
      } finally {
        await clearScenario(DEFAULT_MOCK_BASE_URL, key).catch(() => undefined);
        await new Promise((resolve) => capture.close(resolve));
      }
    },
  };
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: `can-5030-${name}`,
        title: 'Pending purchase',
        model: CURRENT_MODEL,
      },
    ],
  });
  await registerAccess('needs_purchase');
  ({ electronApp: fixture.electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_MOCK_API_KEY: key,
      CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: `http://127.0.0.1:${capture.address().port}/capture`,
    },
  }));
  const window = await fixture.electronApp.firstWindow();
  fixture.window = window;
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
  return fixture;
}

/** Checkout mints recorded by the mock, one per distinct request. */
async function checkoutMints(key) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
  return Object.keys(activity).filter((name) =>
    name.startsWith('authLinkMint:'),
  );
}

function requestIdOf(mint) {
  return new URL(
    mint.slice('authLinkMint:'.length),
    DEFAULT_MOCK_BASE_URL,
  ).searchParams.get('requestId');
}

async function clickLockedRow(window, model) {
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  if ((await window.getByTestId(`chat-model-option-${model}`).count()) === 0)
    await picker.click();
  await window
    .getByTestId(`chat-model-option-${model}`)
    .filter({ visible: true })
    .click();
}

/** Another visible purchase-locked row, opening the picker if needed. */
async function otherLockedRow(window) {
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  if (
    (await window.getByTestId(`chat-model-option-${TARGET_MODEL}`).count()) ===
    0
  )
    await picker.click();
  const ids = await window
    .locator('[data-testid^="chat-model-option-"][data-locked="true"]:visible')
    .evaluateAll((rows) =>
      rows.map((row) =>
        row.getAttribute('data-testid').slice('chat-model-option-'.length),
      ),
    );
  const other = ids.find((id) => id !== TARGET_MODEL);
  expect(other, 'a second purchase-locked row').toBeTruthy();
  return other;
}

async function advanceToTimeout(window) {
  await window.evaluate(() => {
    // A controlled clock: the poll loop times out on `Date.now()` alone, so
    // moving it forward reaches the timeout on the next real poll tick. The
    // fixture's close restores the real clock.
    if (!window.__can5030RealNow) {
      const realNow = Date.now.bind(Date);
      window.__can5030RealNow = realNow;
      window.__can5030ClockOffset = 0;
      Date.now = () => realNow() + window.__can5030ClockOffset;
    }
    window.__can5030ClockOffset += 11 * 60_000;
  });
  // Bounded: the next poll tick is three seconds out, longer after a failed
  // read's backoff.
  await expect(
    window.getByTestId('model-unlock-pending-notice'),
  ).toHaveAttribute('data-phase', 'timed-out', { timeout: 45_000 });
}

test('Close keeps the purchase in the composer, and locked rows resume it', async () => {
  test.setTimeout(180_000);
  const fixture = await launchPendingPurchase('close-resume');
  try {
    const { window, opened, key } = fixture;
    const picker = await openPicker(window);
    const row = window
      .getByTestId(`chat-model-option-${TARGET_MODEL}`)
      .filter({ visible: true });
    await expect(row).toContainText('Unlock with AI Credit purchase');
    await row.click();
    await window.getByTestId('model-recovery-unlock-purchase').click();
    await expect.poll(() => opened.length).toBe(1);
    expect(await checkoutMints(key)).toHaveLength(1);
    const waiting = window.getByTestId('model-recovery-unlock-waiting');
    await expect(waiting).toContainText(
      "Closing this dialog won't cancel your purchase.",
    );
    await expect(
      window.getByTestId('model-recovery-unlock-check-now'),
    ).toHaveText('Check again');

    // Close: the dialog goes, the composer keeps the purchase.
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
    const notice = window.getByTestId('model-unlock-pending-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-phase', 'waiting');
    await expect(notice).toContainText('Sonnet');
    // The shared checkout step (CAN-5160): neutral with a clock, no spinner.
    await expect(notice).toContainText('Finish checkout in your browser');
    await expect(notice).toHaveAttribute('data-notice-intent', 'neutral');
    await expect(
      window.getByTestId('model-unlock-pending-dismiss'),
    ).toHaveCount(0);

    // The same row, then another locked row, resume the same purchase.
    await clickLockedRow(window, TARGET_MODEL);
    await expect(waiting).toContainText('Sonnet');
    await expect(
      window.getByTestId('model-recovery-unlock-purchase'),
    ).toHaveCount(0);
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const other = await otherLockedRow(window);
    await clickLockedRow(window, other);
    await expect(waiting).toContainText('Sonnet');
    await expect(
      window.getByTestId('model-recovery-unlock-purchase'),
    ).toHaveCount(0);
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
    expect(opened).toHaveLength(1);
    expect(await checkoutMints(key)).toHaveLength(1);

    await advanceToTimeout(window);
    await expect(notice).toContainText('Automatic payment checks have stopped');
    await expect(
      window.getByTestId('model-unlock-pending-spinner'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('model-unlock-pending-check-now'),
    ).toBeVisible();
    await expect(
      window.getByTestId('model-unlock-pending-dismiss'),
    ).toBeVisible();

    // Paid: Check now applies the original model in the original chat.
    await fixture.registerAccess('unlocked');
    await window.getByTestId('model-unlock-pending-check-now').click();
    await expect(picker).toContainText('Sonnet', { timeout: 30_000 });
    await expect(notice).toHaveCount(0);
    // Re-registering the scenario resets its activity, so the browser
    // capture is the checkout count from here.
    expect(opened).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test('the originating composer keeps its purchase notice while editing a queued message', async () => {
  test.setTimeout(180_000);
  const fixture = await launchPendingPurchase('queued-edit');
  const marker = 'Canopy-C5030QUEUE';
  try {
    const { window, opened } = fixture;
    await openPicker(window);
    await clickLockedRow(window, TARGET_MODEL);
    await window.getByTestId('model-recovery-unlock-purchase').click();
    await expect.poll(() => opened.length).toBe(1);
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [{ text: 'A deterministic active turn', streamMs: 90_000 }],
      },
    });
    const send = (id, text) =>
      window.evaluate(
        async ({ id, text, projectId, worktreeId }) => {
          await window.api.chat.sendMessage({
            projectId,
            worktreeId,
            chatId: 'can-5030-queued-edit',
            userMessageId: id,
            text,
            providerType: 'claude',
          });
        },
        { id, text, projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
    await send('can-5030-active', `[${marker}] Keep this turn active`);
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await send('can-5030-queued', 'Edit this queued message');
    const bubble = window.getByTestId('queued-message-bubble');
    await expect(bubble).toBeVisible();
    await bubble.hover();
    await bubble.getByTestId('queued-message-preview').dblclick();
    const editor = window.getByTestId('queued-message-editor');
    await expect(editor).toBeVisible();
    const composer = window.locator(
      '[data-chat-composer-root]:not([data-testid="queued-message-editor"])',
    );
    // Editing hides the normal composer and puts ChatInput in the queued
    // editor. The visible editor must retain the purchase cue as well.
    await expect(
      editor.getByTestId('model-unlock-pending-notice'),
    ).toBeVisible();
    await expect(
      editor.getByTestId('model-unlock-pending-check-now'),
    ).toHaveText('Check again');
    await editor.getByTestId('queued-message-edit-cancel').click();
    await expect(
      composer.getByTestId('model-unlock-pending-notice'),
    ).toBeVisible();
    expect(opened).toHaveLength(1);
  } finally {
    await fixture.close();
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
  }
});

test('after a timeout, a new purchase is explicit and Dismiss forgets only the notice', async () => {
  test.setTimeout(180_000);
  const fixture = await launchPendingPurchase('timeout-recovery');
  try {
    const { window, opened, key } = fixture;
    await openPicker(window);
    const row = window
      .getByTestId(`chat-model-option-${TARGET_MODEL}`)
      .filter({ visible: true });
    await expect(row).toContainText('Unlock with AI Credit purchase');
    await row.click();
    await window.getByTestId('model-recovery-unlock-purchase').click();
    await expect.poll(() => opened.length).toBe(1);
    const [firstMint] = await checkoutMints(key);
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await advanceToTimeout(window);

    // An explicit new purchase mints exactly one more checkout and follows it.
    await clickLockedRow(window, TARGET_MODEL);
    await expect(
      window.getByTestId('model-recovery-unlock-timed-out'),
    ).toContainText("Starting a new purchase won't cancel the previous one.");
    await window.getByTestId('model-recovery-unlock-new-purchase').click();
    await expect.poll(() => opened.length).toBe(2);
    const mints = await checkoutMints(key);
    expect(mints).toHaveLength(2);
    const second = mints.find((mint) => mint !== firstMint);
    expect(requestIdOf(second)).not.toBe(requestIdOf(firstMint));
    await expect(
      window.getByTestId('model-recovery-unlock-waiting'),
    ).toBeVisible();
    await window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const notice = window.getByTestId('model-unlock-pending-notice');
    await expect(notice).toHaveAttribute('data-phase', 'waiting');

    // Dismissing a timed-out notice stops tracking; the row offers a fresh
    // purchase again, which is the user's explicit choice to make.
    await advanceToTimeout(window);
    await window.getByTestId('model-unlock-pending-dismiss').click();
    await expect(notice).toHaveCount(0);
    await clickLockedRow(window, TARGET_MODEL);
    await expect(
      window.getByTestId('model-recovery-unlock-purchase'),
    ).toBeVisible();
    expect(opened).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

const BALANCE_BARRIER = 'ai-credits-balance';

async function releaseBalanceBarrier(key) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: BALANCE_BARRIER }),
  });
  expect(response.ok).toBe(true);
}

/**
 * The composer's balance in its trigger, accessible name, and popover. The
 * `label` is `Free AI Credits` until the wallet's first purchase unlocks the
 * model library, then `AI Credits` (CAN-5028).
 */
async function expectComposerBalance(window, meter, count, label) {
  const text = `${count} ${label}`;
  await expect(meter).toHaveAccessibleName(`Usage indicator, ${text}`, {
    timeout: 30_000,
  });
  await expect(meter.getByTestId('usage-indicator-credit-balance')).toHaveText(
    text,
  );
  await expect(meter).not.toHaveAttribute('aria-busy', 'true');
  await meter.press('Enter');
  const account = window.getByTestId('usage-indicator-account');
  await expect(account).toHaveAccessibleName(`${label} balance`);
  await expect(
    account.getByTestId('usage-indicator-account-credit-balance'),
  ).toHaveText(count);
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('usage-indicator-popover')).toHaveCount(0);
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
    await fixture.window
      .getByTestId('model-recovery-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
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
