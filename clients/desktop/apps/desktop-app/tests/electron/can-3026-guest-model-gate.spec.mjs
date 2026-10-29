import {
  revealModelRow,
  selectModelOption,
} from './model-selection-fixture.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-3026 — durable Electron coverage for the desktop guest model gate.
//
// A guest may only run the cheap allowlisted models (`GUEST_ALLOWED_MODELS`)
// where Canopy pays for the inference. Picking anything else raises the shared
// sign-in prompt instead of committing the model.
//
// Fully deterministic: the model registry is INJECTED over the renderer's
// `model-registry:updated` channel (same mechanism as
// `model-picker-gateway-catalog.spec.mjs`), the chat is seeded on disk, and the
// guest credential comes from the shared cloud mock's device-scoped guest-mint
// route. No live agent, no provider CLI, no network turn.
//
// The gated rows below are GATEWAY-ONLY on purpose. That branch of
// `resolveModelRowGate` refuses a guest BEFORE the credits probe runs, so the
// assertion does not depend on whatever balance the mock hands this guest —
// which is also the production property that matters, since every consented
// guest is funded by the daily drip.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'can-3026-guest-model-gate-chat';
const MODEL_REGISTRY_UPDATED_CHANNEL = 'model-registry:updated';

const CURRENT_MODEL = 'sonnet';
const CURRENT_MODEL_LABEL = 'Sonnet';
/** Expensive, gateway-only, NOT on the guest allowlist. */
const BLOCKED_MODEL = 'claude-zulu-gateway-only';
/** The shipped desktop AI-Credits lane default — first in the allowlist. */
const ALLOWED_DEFAULT_MODEL = 'deepseek-v4-pro';
/** The guest model on web and desktop, and cloud chat's own default. */
const ALLOWED_NATIVE_MODEL = 'gpt-6-luna';
/**
 * The allowlisted Claude model. Allowlisted by its GATEWAY id only: the
 * registry id `haiku` is not on the allowlist, so the row is admitted through
 * its resolved route.
 */
const ALLOWED_CLAUDE_MODEL = 'haiku';
/**
 * An expensive Claude model with NO gateway route — the guest's own
 * subscription lane. Canopy pays nothing for it, so the gate must not touch it
 * even though it is not on the allowlist.
 */
const NATIVE_SUBSCRIPTION_MODEL = 'claude-native-only-gate-test';

const GUEST_CONSENT = {
  acceptedAt: '2026-07-06T00:00:00.000Z',
  tosVersion: '2026-07-06',
};

const gatewayConfig = {
  contextWindow: 128_000,
  supportsPromptCaching: false,
  supportedThinkingLevels: [],
  toolSchemaProfile: 'standard',
};

function gatewayModel(id, label, family, familyLabel, vendor, harness) {
  return {
    id,
    label,
    family,
    familyLabel,
    vendor,
    recommendedHarness: harness,
    ...gatewayConfig,
  };
}

function gatewayRoute(id, gatewayId, family, harness) {
  return {
    modelId: id,
    gatewayId,
    family,
    recommendedHarness: harness,
    gatewayOnly: true,
    ...gatewayConfig,
  };
}

async function injectModelRegistry(electronApp) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, snapshot }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) {
        throw new Error('No BrowserWindow available for model registry update');
      }
      win.webContents.send(channel, snapshot);
    },
    {
      channel: MODEL_REGISTRY_UPDATED_CHANNEL,
      snapshot: {
        claude: [
          {
            id: CURRENT_MODEL,
            label: CURRENT_MODEL_LABEL,
            family: 'sonnet',
            familyLabel: 'Sonnet',
            vendor: 'anthropic',
            sortOrder: 30,
          },
          {
            id: ALLOWED_CLAUDE_MODEL,
            label: 'Haiku 5.5',
            family: 'haiku',
            familyLabel: 'Haiku',
            vendor: 'anthropic',
            sortOrder: 40,
          },
          // Deliberately absent from `gatewayRoutes` below: with no route,
          // AI Credits cannot carry it, so it is reachable only through the
          // guest's OWN Claude subscription.
          {
            id: NATIVE_SUBSCRIPTION_MODEL,
            label: 'Opus Native',
            family: 'opus',
            familyLabel: 'Opus',
            vendor: 'anthropic',
            sortOrder: 20,
          },
        ],
        codex: [
          {
            id: ALLOWED_NATIVE_MODEL,
            label: 'GPT 6 Luna',
            family: 'codex',
            familyLabel: 'Codex',
            vendor: 'openai',
            sortOrder: 70,
          },
        ],
        ollama: [],
        agents: [],
        aliases: {},
        aiGatewayModels: [
          gatewayModel(
            BLOCKED_MODEL,
            'Zulu Gateway',
            'anthropic',
            'Anthropic',
            'anthropic',
            'claude',
          ),
          gatewayModel(
            ALLOWED_DEFAULT_MODEL,
            'DeepSeek V4 Pro',
            'deepseek',
            'DeepSeek',
            'deepseek',
            'codex',
          ),
        ],
        gatewayRoutes: [
          gatewayRoute(
            BLOCKED_MODEL,
            'anthropic/zulu-gateway',
            'anthropic',
            'claude',
          ),
          gatewayRoute(
            ALLOWED_DEFAULT_MODEL,
            'deepseek/deepseek-v4-pro',
            'deepseek',
            'codex',
          ),
          // Luna is a NATIVE Codex model that still routes through credits for
          // a guest with no Codex login — the exact case gating gateway-only
          // rows alone would miss.
          {
            ...gatewayRoute(
              ALLOWED_NATIVE_MODEL,
              'openai/gpt-6-luna',
              'codex',
              'codex',
            ),
            gatewayOnly: false,
          },
          // The first guest model on the Claude harness: a native Claude row
          // that routes through credits under the allowlisted gateway id.
          {
            ...gatewayRoute(
              ALLOWED_CLAUDE_MODEL,
              'anthropic/claude-haiku-5.5',
              'haiku',
              'claude',
            ),
            gatewayOnly: false,
          },
        ],
      },
    },
  );
}

async function launchGuestChat(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Guest model gate', model: CURRENT_MODEL }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });

  // Device-scoped guest credential (`csk_guest_*`, saved as
  // `credentialSource: 'guest'`), then the broadcast `useIsGuestCredential`
  // listens on so the picker re-resolves its rows as a guest.
  const guestAccount = await window.evaluate(
    async (consent) => window.api.startCanopyGuestSession(consent),
    GUEST_CONSENT,
  );
  expect(guestAccount.credentialSource).toBe('guest');
  await window.evaluate(() => {
    window.dispatchEvent(new Event('canopy:cloud-account-changed'));
  });

  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await injectModelRegistry(electronApp);
  return { electronApp, userDataDir, window };
}

async function openPicker(window) {
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(picker).toContainText(CURRENT_MODEL_LABEL);
  await picker.click();
  return picker;
}

test('intercepts a guest picking a model Canopy pays for, and never commits', async () => {
  const fixture = await launchGuestChat('canopy-can3026-intercept-');
  try {
    const picker = await openPicker(fixture.window);

    // Library locks name the standing account requirement before activation.
    const row = fixture.window.getByTestId(
      `chat-model-option-${BLOCKED_MODEL}`,
    );
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-disabled', 'true');
    await expect(
      row.getByTestId(`chat-model-option-lock-label-${BLOCKED_MODEL}`),
    ).toHaveText('Sign in');
    await expect(row).toHaveAccessibleDescription('Unlock with sign-in');
    await expect(
      row.getByTestId(`chat-model-row-credits-${BLOCKED_MODEL}`),
    ).toHaveCount(0);

    await row.click();

    const body = fixture.window.getByTestId('model-recovery-needs-account');
    await expect(body).toBeVisible();
    await expect(body).toContainText('needs an account');
    // Never a purchase: the guest is already funded, so credits are not the
    // missing thing.
    await expect(
      fixture.window.getByTestId('model-recovery-get-credits'),
    ).toHaveCount(0);

    // `Not now` restores the original selection.
    await fixture.window.getByTestId('model-recovery-cancel').click();
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(0);
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);

    // ...and the caret, not just the model. `clearPendingRecovery` calls
    // `onRestoreFocus` precisely so a recovery dismissed from inside the modal
    // does not drop focus to `<body>` and strand a keyboard-only guest with
    // nowhere to type. Asserted as "not body" rather than against a specific
    // node so it pins the guarantee without freezing which composer element
    // currently owns the caret.
    await expect
      .poll(() =>
        fixture.window.evaluate(
          () => document.activeElement?.tagName.toLowerCase() ?? 'none',
        ),
      )
      .not.toBe('body');
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('CAN-4705 Home names sign-in locks before interaction and keyboard recovery preserves selection', async () => {
  const fixture = await launchGuestChat('canopy-can4705-home-');
  try {
    const app = new CanopyAppDriver(fixture.window);
    const home = await app.openHomeForProject(WORKSPACE_ID);
    const picker = home.getByTestId('chat-model-picker');
    const original = await picker.textContent();
    await picker.click();
    const allowed = await revealModelRow(fixture.window, ALLOWED_DEFAULT_MODEL);
    await expect(allowed).not.toHaveAttribute('data-locked', 'true');
    await expect(
      allowed.getByTestId(`chat-model-row-credits-${ALLOWED_DEFAULT_MODEL}`),
    ).toHaveText('AI credits');
    const row = await revealModelRow(fixture.window, BLOCKED_MODEL);
    await expect(
      row.getByTestId(`chat-model-option-lock-label-${BLOCKED_MODEL}`),
    ).toHaveText('Sign in');
    await expect(
      row.getByTestId(`chat-model-row-credits-${BLOCKED_MODEL}`),
    ).toHaveCount(0);
    await expect(row).toHaveAccessibleDescription('Unlock with sign-in');

    // Leave the pointer over another row while arrows move the highlight.
    await fixture.window.getByTestId('chat-model-search').click();
    await allowed.hover();
    for (let step = 0; step < 30; step += 1) {
      await fixture.window.keyboard.press('ArrowDown');
      if (await row.evaluate((node) => node === document.activeElement)) break;
    }
    await expect(row).toBeFocused();
    const card = fixture.window.getByTestId(
      `chat-model-option-detail-${BLOCKED_MODEL}`,
    );
    await expect(card).toBeVisible();
    await expect(card.locator('p').nth(1)).toHaveText('Unlock with sign-in');
    await expect(
      fixture.window.locator(
        '[data-testid^="chat-model-option-detail-"]:visible',
      ),
    ).toHaveCount(1);
    await allowed.hover();
    await expect(card).toBeHidden();
    await fixture.window.mouse.move(0, 0);
    await expect(card).toBeVisible();
    await fixture.window.keyboard.press('Enter');
    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toBeVisible();
    await fixture.window.getByTestId('model-recovery-cancel').click();
    await expect(picker).toHaveText(original ?? '');
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('never raises the account gate for an allowlisted model', async () => {
  // DECISION-0 REGRESSION TEST. `deepseek-v4-pro` is the AI-Credits lane
  // default in already-shipped desktop builds and `gpt-6-luna` is cloud
  // chat's. Gating either would prompt installed guest clients that never
  // chose anything. Haiku 5.5 is the allowlisted Claude option; it is checked
  // first, while the chat is still on its original Claude model.
  //
  // Asserted as "no account gate" rather than "commits silently" so the case
  // does not depend on whatever credit balance the cloud mock hands this
  // guest: an allowlisted row must reach its ORDINARY pre-CAN-3026 outcome,
  // whichever that is.
  const fixture = await launchGuestChat('canopy-can3026-allowlist-');
  try {
    await openPicker(fixture.window);

    for (const model of [
      ALLOWED_CLAUDE_MODEL,
      ALLOWED_DEFAULT_MODEL,
      ALLOWED_NATIVE_MODEL,
    ]) {
      const row = await revealModelRow(fixture.window, model);
      await expect(row).toBeVisible();
      await expect(row).not.toHaveAttribute('aria-disabled', 'true');
      await row.click();
      await expect(
        fixture.window.getByTestId('model-recovery-needs-account'),
      ).toHaveCount(0);

      // Reopen for the next row, dismissing whatever (if anything) opened.
      const modal = fixture.window.getByTestId('model-recovery-modal');
      if ((await modal.count()) > 0) {
        await fixture.window.getByTestId('model-recovery-cancel').click();
        await expect(modal).toHaveCount(0);
      }
      await openPicker(fixture.window).catch(async () => {
        await fixture.window
          .locator('[data-testid="chat-model-picker"]:visible')
          .first()
          .click();
      });
    }
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test("leaves a guest's own native subscription models alone", async () => {
  // The deliberate scope limit, and the reason this gate is NOT simply "a
  // guest may only pick allowlisted models". `claude-native-only-gate-test`
  // has no gateway route, so AI Credits cannot carry it and Canopy pays
  // nothing — it runs on the guest's own Claude subscription. Prompting here
  // would push a guest OFF a subscription they already pay for and ONTO the
  // hosted gateway, raising Canopy's cost for exactly the users the gate
  // targets.
  //
  // Asserted as "no account gate" rather than "commits", so the case does not
  // depend on whatever native-auth state the E2E environment reports: the
  // CAN-3026 claim is that this row reaches its ORDINARY pre-gate outcome,
  // whichever that is.
  const fixture = await launchGuestChat('canopy-can3026-native-');
  try {
    await openPicker(fixture.window);

    const row = await revealModelRow(fixture.window, NATIVE_SUBSCRIPTION_MODEL);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-disabled', 'true');
    await row.click();

    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('routes guest sign-in through the shared cloud gate without committing', async () => {
  const fixture = await launchGuestChat('canopy-can3026-signin-');
  try {
    const picker = await openPicker(fixture.window);
    await selectModelOption(fixture.window, `${BLOCKED_MODEL}`);
    await expect(
      fixture.window.getByTestId('model-recovery-needs-account'),
    ).toBeVisible();

    await fixture.window.getByTestId('model-recovery-account-sign-in').click();

    // The SHARED `CloudSyncModal`, not a bespoke sign-in surface.
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toBeVisible();
    // The recovery modal stays MOUNTED underneath (hidden, not unmounted) so
    // the gate-close re-read still has a live component to commit through.
    await expect(
      fixture.window.getByTestId('model-recovery-modal'),
    ).toHaveCount(1);
    // Nothing was committed on the way to the gate.
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);

    // Walking away from the gate WITHOUT connecting must leave the guest
    // exactly where they started. The gate-close effect re-reads the account,
    // finds the same guest, and the guard in `refreshAccountRead` holds — so
    // the one thing that must NOT happen is a commit landing on the way out.
    await fixture.window.keyboard.press('Escape');
    await expect(fixture.window.getByTestId('cloud-sync-modal')).toHaveCount(0);
    await expect(picker).toContainText(CURRENT_MODEL_LABEL);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

// ---------------------------------------------------------------------------
// Config surfaces (plan §4a). The five model-config editors — `ModelAliasesEditor`,
// `PipelineModelAliasEditor`, `HookActionEditor`, `AgentModelModal`,
// `AutomationsPage` — must stay at ZERO diff, because they write a CONFIG value
// rather than running a chat turn. A sign-in prompt that then commits a hook's
// model would gate the wrong thing entirely.
//
// The mechanism is `gatingEnabled`, which `ModelPicker` derives from whether the
// caller passed `providerAvailability` — only the two chat composers do. The
// unit matrix asserts the predicate directly; this spec proves the derivation
// actually reaches the gate through a real rendered config surface.
//
// `HookActionEditor` is the representative surface: it is the one with an
// established Electron path (`hook-action-model-alias.spec.mjs`). The other four
// share the identical `gatingEnabled` derivation and stay unit-covered.
// ---------------------------------------------------------------------------

const HOOK_WORKSPACE_ID = 'demo-multi-repo-fullstack';
const HOOK_WORKSPACE_NAME = 'Multi Repo Fullstack';
const HOOK_PROMPT = 'Review this PR for the guest model gate.';

function seedChatHook(userDataDir) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    checkRuntimes: false,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    HOOK_WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const webRepo = config.repos.find((repo) => repo.id === 'web');
  if (!webRepo) throw new Error('Missing web repo in seeded workspace');
  webRepo.hooks = {
    'pr:create': [{ type: 'chat', prompt: HOOK_PROMPT, model: CURRENT_MODEL }],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

test('leaves the model-config surfaces ungated for a guest', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3026-config-'),
  );
  seedChatHook(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const guestAccount = await window.evaluate(
      async (consent) => window.api.startCanopyGuestSession(consent),
      GUEST_CONSENT,
    );
    expect(guestAccount.credentialSource).toBe('guest');
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await injectModelRegistry(electronApp);

    const settings = window.getByRole('dialog', { name: HOOK_WORKSPACE_NAME });
    // Registry hydration can move the row after hover. Re-hover the visible
    // header rather than waiting on a settings icon whose hover was lost.
    await expect(async () => {
      if (await settings.isVisible()) return;
      await app.workspaceHeaderLabel(HOOK_WORKSPACE_NAME).hover();
      await app
        .workspaceSettingsButton(HOOK_WORKSPACE_NAME)
        .click({ timeout: 2_000 });
      await expect(settings).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await settings.getByRole('tab', { name: 'Hooks' }).click();

    // Scope to the chat-action editor card that owns the seeded prompt.
    const prompt = settings
      .locator('[data-testid^="hook-chat-"][contenteditable="true"]')
      .filter({ hasText: HOOK_PROMPT });
    await expect(prompt).toHaveCount(1);
    const editor = prompt.locator(
      'xpath=ancestor::div[contains(@class,"rounded-lg") and contains(@class,"bg-card")][1]',
    );

    const picker = editor.getByTestId('chat-model-picker');
    await expect(picker).toBeVisible();
    await picker.click();

    // The expensive, non-allowlisted row the CHAT composer intercepts for this
    // same guest. Here it must reach its ordinary pre-CAN-3026 outcome instead
    // — whatever `gatingEnabled: false` leaves it as — and must never raise the
    // account gate. If `gatingEnabled` ever stopped reaching `guestMustSignIn`,
    // this row would turn `recoverable` and the modal below would appear.
    const row = window.getByTestId(`chat-model-option-${BLOCKED_MODEL}`);
    await expect(row).toBeVisible();
    await row.click({ force: true });

    await expect(
      window.getByTestId('model-recovery-needs-account'),
    ).toHaveCount(0);
    await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
