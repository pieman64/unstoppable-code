import {
  symlinkSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';

const CURSOR_LOGIN_URL =
  'https://cursor.com/canopy-login-fixture?state=complete';

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

// Managed Cursor runtime setup through Settings > Labs. These scenarios
// cover download, verification, sign-in, cancellation, retry, and private
// environment isolation with a local deterministic archive; no chat is involved.
const live = Boolean(process.env.CURSOR_CHAT_LIVE_BINARY);

test('Cursor managed setup is offered without an executable path', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await expect(
      window.getByRole('button', { name: 'Connect Cursor', exact: true }),
    ).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

for (const [enabled, released] of [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
]) {
  test(`Cursor release discovery: master=${enabled}, release=${released}`, async () => {
    const launched = await launchCanopy({
      userDataDir: seedWelcomeChecklist({ pendingEntry: 'agent-connections' }),
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-desktop-cursor-harness': enabled,
          'canopy-desktop-cursor-harness-released': released,
        }),
      },
    });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await window.getByTestId('sidebar-create-task').click();
      const onboarding = window.getByTestId(
        'home-onboarding-agent-connections',
      );
      await expect(onboarding).toBeVisible();
      const connectCursor = onboarding.getByTestId(
        'home-onboarding-suggestion-connect-cursor',
      );
      await expect(connectCursor).toHaveCount(enabled && released ? 1 : 0);
      if (enabled && released) {
        await connectCursor.click();
        await expect(window.getByTestId('settings-tab-account')).toBeVisible();
        await driver.closeSettings();
      }
      await driver.openSettings();
      await driver.openSettingsSection('harnesses');
      await expect(window.getByTestId('harness-column-cursor')).toHaveCount(
        enabled && released ? 1 : 0,
      );
      await driver.openSettingsSection('account');
      await expect(window.getByTestId('cursor-connection')).toHaveCount(
        enabled && released ? 1 : 0,
      );
      await driver.openSettingsSection('experiments');
      await expect(window.getByTestId('cursor-connection')).toHaveCount(
        enabled && !released ? 1 : 0,
      );
      const diagnosticsAvailable = await window.evaluate(() =>
        window.api.cursorApprovalCheck.available(),
      );
      await expect(window.getByTestId('cursor-approval-check')).toHaveCount(
        diagnosticsAvailable && !released ? 1 : 0,
      );
      await driver.closeSettings();
      await window.getByTestId('sidebar-create-task').click();
      await window
        .getByTestId('page-home')
        .getByTestId('chat-model-picker')
        .click();
      // A released Cursor that is not connected ends All with a connect row.
      // The unreleased master flag lists Cursor only once it is connected.
      await window.getByTestId('chat-model-harness-tab-all').click();
      await expect(
        window.getByTestId('chat-model-connect-row-cursor'),
      ).toHaveCount(enabled && released ? 1 : 0);
      const cursorTab = window.getByTestId('chat-model-harness-tab-cursor');
      await expect(cursorTab).toHaveCount(enabled && released ? 1 : 0);
      if (enabled && released) {
        await cursorTab.click();
        await window.getByTestId('chat-model-connect-harness').click();
        await expect(window.getByTestId('settings-tab-account')).toBeVisible();
        await expect(window.getByTestId('cursor-connect')).toBeVisible();
        await expect(window.getByTestId('cursor-connection')).not.toContainText(
          'Experimental',
        );

        const openHomePicker = async () => {
          await driver.closeSettings();
          await window.getByTestId('sidebar-create-task').click();
          await window
            .getByTestId('page-home')
            .getByTestId('chat-model-picker')
            .click();
        };
        await openHomePicker();
        await window.getByTestId('chat-model-harness-tab-all').click();
        await window.getByTestId('chat-model-connect-row-cursor').click();
        await expect(window.getByTestId('chat-model-menu')).toBeHidden();
        await expect(window.getByTestId('settings-tab-account')).toBeVisible();
        await expect(window.getByTestId('cursor-connect')).toBeVisible();

        // Search finds the harness by name, and the keyboard reaches it.
        await openHomePicker();
        const search = window.getByTestId('chat-model-search');
        await search.fill('cursor');
        const connectRow = window.getByTestId('chat-model-connect-row-cursor');
        await expect(connectRow).toBeVisible();
        await expect(window.getByTestId('chat-model-search-empty')).toHaveCount(
          0,
        );
        await search.press('ArrowDown');
        await expect(connectRow).toBeFocused();
        await connectRow.press('Enter');
        await expect(window.getByTestId('settings-tab-account')).toBeVisible();
      }
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
  });
}

test('Cursor release moves setup live and supports connection from Accounts', async () => {
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await expect(window.getByTestId('cursor-connect')).toBeVisible();
    const setReleased = async (released) => {
      await launched.electronApp.evaluate((_, value) => {
        const flags = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
        flags['canopy-desktop-cursor-harness-released'] = value;
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
      }, released);
      await window.evaluate(() => window.api.featureFlags.refreshContext());
    };
    await setReleased(true);
    await expect(window.getByTestId('cursor-connection')).toHaveCount(0);
    await driver.openSettingsSection('account');
    // The tile shares the Claude / Codex composition: logo and status dot in
    // the header, and the account action pinned top-right as the tile's only
    // connected-state control (disconnecting is an App Advisor operation).
    const tile = window.getByTestId('cursor-connection');
    await expect(tile.getByTestId('cursor-connection-logo')).toBeVisible();
    await expect(tile.getByTestId('cursor-connection-status-dot')).toHaveClass(
      /bg-destructive/,
    );
    await window.getByTestId('cursor-connect').click();
    await expect(tile.getByTestId('cursor-connection-status-dot')).toHaveClass(
      /bg-success/,
    );
    // As on the peer rows, the signed-in line is the tile's only status line
    // once connected: the dot already says the runtime is connected.
    await expect(tile.getByTestId('cursor-connection-account')).toBeVisible();
    await expect(tile.getByTestId('cursor-connection-status')).toHaveCount(0);
    await expect(tile).not.toContainText('Cursor connected');
    await expect(tile.getByTestId('cursor-change-account')).toHaveText(
      'Change account',
    );
    // The header action is the tile's only control once connected.
    await expect(tile.getByTestId('cursor-connect')).toHaveCount(0);
    await driver.closeSettings();
    await window.getByTestId('sidebar-create-task').click();
    await window
      .getByTestId('page-home')
      .getByTestId('chat-model-picker')
      .click();
    await expect(
      window.getByTestId('chat-model-option-cursor-default'),
    ).toBeVisible();
    await expect(
      window.getByTestId('chat-model-experimental-cursor'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await driver.openSettings();
    await driver.openSettingsSection('account');
    await setReleased(false);
    await expect(window.getByTestId('cursor-connection')).toHaveCount(0);
    await driver.openSettingsSection('experiments');
    await expectCursorConnected(window);
    // The tile offers no Disconnect; the runtime is disabled through the same
    // IPC the App Advisor `disconnect` operation uses, and the remounted panel
    // reads the disabled state back.
    await window.evaluate(() => window.api.cursorConnection.disconnect());
    await driver.openSettingsSection('display');
    await driver.openSettingsSection('experiments');
    await expect(window.getByTestId('cursor-connect')).toHaveText(
      'Connect Cursor',
    );
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
  }
});

test('Cursor flag hides all setup UX and rejects direct operations', async () => {
  const launched = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-cursor-harness': false,
      }),
    },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await expect(window.getByTestId('cursor-connection')).toHaveCount(0);
    await expect(window.getByTestId('cursor-approval-check')).toHaveCount(0);
    expect(
      await window.evaluate(() => window.api.cursorApprovalCheck.available()),
    ).toBe(false);
    for (const operation of [
      'status',
      'listModels',
      'connect',
      'changeAccount',
      'account',
    ]) {
      const result = await window.evaluate(async (operation) => {
        try {
          await window.api.cursorConnection[operation]();
          return 'allowed';
        } catch (error) {
          return String(error);
        }
      }, operation);
      expect(result).toContain(
        'This Cursor model is unavailable. Choose another Cursor model and try again.',
      );
    }
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

for (const failure of ['corrupt', 'slow', 'navigate', 'quit']) {
  test(`Cursor setup ${failure}: stays disabled and can retry`, async () => {
    const managed = await cursorRuntimeFixture();
    managed.state.mode = failure === 'corrupt' ? 'corrupt' : 'slow';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-install-retry-'),
    );
    let launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      let window = await launched.electronApp.firstWindow();
      let driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      expect(managed.state.requests).toBe(0);
      expect(existsSync(path.join(userDataDir, 'cursor-runtime'))).toBe(false);
      await window.getByTestId('cursor-connect').click();
      await expect.poll(() => managed.state.requests).toBe(1);
      if (failure === 'slow')
        await window.getByTestId('cursor-connect-cancel').click();
      if (failure === 'navigate') {
        await driver.openSettingsSection('display');
        await driver.openSettingsSection('experiments');
      }
      if (failure === 'quit') {
        const child = launched.electronApp.process();
        await launched.electronApp.evaluate(({ app }) => app.quit());
        await expect.poll(() => child.exitCode !== null).toBe(true);
        launched = await launchCanopy({ userDataDir, env: managed.env });
        window = await launched.electronApp.firstWindow();
        driver = new CanopyAppDriver(window);
        await driver.waitForShell();
        await driver.openSettings();
        await driver.openSettingsSection('experiments');
      }
      await expect(window.getByTestId('cursor-connect')).toBeEnabled();
      await expect
        .poll(
          async () =>
            (await window.evaluate(() => window.api.loadPreferences()))
              .cursorEnabled,
        )
        .not.toBe(true);
      await expect
        .poll(() => readdirSync(path.join(userDataDir, 'cursor-runtime')))
        .toEqual([]);
      managed.state.mode = 'normal';
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      const config = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'cursor-runtime-state/config/cli-config.json'),
          'utf8',
        ),
      );
      expect(config.channel).toBe('static');
      // Disconnect through the IPC (the tile offers no button) and remount.
      await window.evaluate(() => window.api.cursorConnection.disconnect());
      await driver.openSettingsSection('display');
      await driver.openSettingsSection('experiments');
      await expect(window.getByTestId('cursor-connect')).toHaveText(
        'Connect Cursor',
      );
      const downloads = managed.state.requests;
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      expect(managed.state.requests).toBe(downloads);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
    }
  });
}

test('Grok hint under Cursor sends a Grok plan to unify accounts', async () => {
  const managed = await cursorRuntimeFixture();
  const externalOpen = await startExternalOpenCapture();
  const launched = await launchCanopy({
    env: {
      ...managed.env,
      ...externalOpen.env,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-cursor-harness': true,
        'canopy-desktop-cursor-harness-released': true,
      }),
    },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('account');
    // Cursor's own sign-in takes no Grok account, so the Cursor row carries a
    // collapsed hint for a Grok-only account instead of a Grok row of its own.
    const cursor = window.getByTestId('cursor-connection');
    await expect(window.getByTestId('grok-account')).toHaveCount(0);
    const toggle = cursor.getByTestId('grok-unify-toggle');
    await expect(toggle).toHaveText('Only have a Grok account?');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(cursor.getByTestId('grok-unify-logo')).toBeVisible();
    await expect(cursor.getByTestId('grok-unify-accounts')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(cursor.getByTestId('grok-unify-body')).toContainText(
      "To use your Grok plan here, unify your accounts, then sign in with Cursor. Once they're unified, your plan shows next to your Cursor sign-in.",
    );
    await cursor.getByTestId('grok-unify-accounts').click();
    await expect
      .poll(() => externalOpen.opened)
      .toEqual(['https://cursor.com/unify']);
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    // Signed in, the hint stays available but asks nothing of the account.
    // Leaving the section remounts it, so a fresh visit starts collapsed.
    await driver.openSettingsSection('display');
    await driver.openSettingsSection('account');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(cursor.getByTestId('grok-unify-accounts')).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
    await externalOpen.close();
  }
});

for (const decision of ['complete', 'cancel']) {
  test(`Cursor browser sign-in: ${decision}`, async () => {
    const managed = await cursorRuntimeFixture();
    const externalOpen = await startExternalOpenCapture();
    const launched = await launchCanopy({
      env: {
        ...managed.env,
        ...externalOpen.env,
        CANOPY_E2E_CURSOR_LOGIN: '1',
      },
    });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      // The fixture keeps its sign-in where the pinned CLI keeps its
      // credential file, resolved against the shared managed profile:
      // `%APPDATA%\Cursor` on Windows and `$XDG_CONFIG_HOME/cursor`
      // elsewhere. No separate account directory is set here on purpose.
      const credentials = path.join(
        launched.userDataDir,
        'cursor-runtime-state/home',
        ...(process.platform === 'win32'
          ? ['AppData', 'Roaming', 'Cursor']
          : ['.config', 'cursor']),
      );
      await window.getByTestId('cursor-connect').click();
      await expect.poll(() => externalOpen.opened).toEqual([CURSOR_LOGIN_URL]);
      if (decision === 'complete') {
        mkdirSync(credentials, { recursive: true });
        writeFileSync(path.join(credentials, 'fixture-login-complete'), 'yes');
        await expectCursorConnected(window);
        // Discovery runs right after Connect against the same managed
        // profile, so the catalog must load from the sign-in Connect just
        // completed. This is the picker the Windows sign-in regression
        // emptied: discovery used to rebuild a private profile and report
        // signed out.
        const labels = await window.evaluate(() =>
          window.api.cursorConnection
            .listModels()
            .then((entries) => entries.map((entry) => entry.label)),
        );
        expect(labels).toContain('GPT-5.6 Luna');
      } else {
        await expect(window.getByTestId('cursor-connection-status')).toHaveText(
          'Finish signing in in your browser',
        );
        await expect
          .poll(() => existsSync(path.join(credentials, 'fixture-login-pid')))
          .toBe(true);
        await window.getByTestId('cursor-connect-cancel').click();
        await expect(window.getByTestId('cursor-connect')).toBeEnabled();
        expect(
          (await window.evaluate(() => window.api.loadPreferences()))
            .cursorEnabled,
        ).not.toBe(true);
      }
      const pid = Number(
        readFileSync(path.join(credentials, 'fixture-login-pid'), 'utf8'),
      );
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      await externalOpen.close();
    }
  });
}

for (const directory of ['', 'config', 'compile-cache', 'data']) {
  test(`Cursor Connect refuses a redirected private ${directory || 'root'} directory`, async () => {
    test.skip(live, 'Deterministic managed-runtime regression');
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-private-directory-'),
    );
    const outside = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-outside-directory-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const state = path.join(userDataDir, 'cursor-runtime-state');
    const redirect = path.join(state, directory);
    mkdirSync(path.dirname(redirect), { recursive: true });
    symlinkSync(outside, redirect);
    const original = '{"channel":"prod","model":"external-marker"}';
    writeFileSync(path.join(outside, 'cli-config.json'), original);
    const managed = await cursorRuntimeFixture();
    const launched = await launchCanopy({ userDataDir, env: managed.env });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('cursor-connect').click();
      await expect(
        window.getByText('Cursor private environment is invalid.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        (await window.evaluate(() => window.api.loadPreferences()))
          .cursorEnabled,
      ).not.toBe(true);
      expect(readFileSync(path.join(outside, 'cli-config.json'), 'utf8')).toBe(
        original,
      );
      expect(readdirSync(outside)).toEqual(['cli-config.json']);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

for (const kind of ['global-file', 'key-value-overrides']) {
  test(`Cursor Connect removes inherited Git ${kind} configuration`, async () => {
    test.skip(live, 'Deterministic managed-runtime regression');
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'cursor-private-git-'),
    );
    const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const config = path.join(userDataDir, 'external.gitconfig');
    writeFileSync(config, '[core]\n\thooksPath = /external-hook-marker\n');
    const injected =
      kind === 'global-file'
        ? { GIT_CONFIG_GLOBAL: config }
        : {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.hooksPath',
            GIT_CONFIG_VALUE_0: '/external-hook-marker',
          };
    const managed = await cursorRuntimeFixture();
    const launched = await launchCanopy({
      userDataDir,
      env: { ...managed.env, ...injected },
    });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      await window.getByTestId('cursor-connect').click();
      await expectCursorConnected(window);
      const childEnvironment = JSON.parse(
        readFileSync(
          path.join(
            userDataDir,
            'cursor-runtime-state/config/fixture-git-environment.json',
          ),
          'utf8',
        ),
      );
      for (const key of Object.keys(injected))
        expect(childEnvironment[key]).toBeUndefined();
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      cleanupDemoWorkspaces(seeded);
    }
  });
}

// Experiments always carries the faster window opening section, so gating
// off Cursor and Code Graph removes only their sections, not the page.
test('Experiments hides the Cursor and Code Graph sections when both are gated off', async () => {
  const launched = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-cursor-harness': false,
        'canopy-desktop-workspace-code-graph': false,
      }),
    },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await expect(window.getByTestId('settings-nav-experiments')).toBeVisible();
    await driver.openSettingsSection('experiments');
    await expect(
      window.getByTestId('settings-renderer-code-cache'),
    ).toBeVisible();
    await expect(window.getByTestId('cursor-connection')).toHaveCount(0);
    await expect(window.getByTestId('code-graph-mode-enabled')).toHaveCount(0);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

for (const decision of ['complete', 'cancel']) {
  test(`Cursor account: shows the signed-in account and changes it (${decision})`, async () => {
    test.skip(live, 'Deterministic managed-runtime regression');
    const managed = await cursorRuntimeFixture();
    // This scenario asserts the model catalog follows the account, so the
    // sign-in markers live in one directory of their own that every spawn
    // (Connect, account reads, and model discovery) reads the same way.
    const accountDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-account-'));
    const externalOpen = await startExternalOpenCapture();
    const launched = await launchCanopy({
      env: {
        ...managed.env,
        ...externalOpen.env,
        CANOPY_E2E_CURSOR_LOGIN: '1',
        CANOPY_E2E_CURSOR_ACCOUNT_DIR: accountDir,
      },
    });
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      // Connect: the browser sign-in completes as the first account.
      await window.getByTestId('cursor-connect').click();
      await expect.poll(() => externalOpen.opened).toEqual([CURSOR_LOGIN_URL]);
      writeFileSync(
        path.join(accountDir, 'fixture-login-complete'),
        'first@example.test',
      );
      await expectCursorConnected(window);
      await expect(window.getByTestId('cursor-connection-account')).toHaveText(
        'Signed in as first@example.test',
      );
      const modelLabels = async () =>
        (
          await window.evaluate(() => window.api.cursorConnection.listModels())
        ).map((entry) => entry.label);
      expect(await modelLabels()).not.toContain('Second Account Model');
      // Change account: signs the CLI out, then runs the same browser flow.
      // Hold the sign-out open so the phase it reports is observable; it must
      // name the sign-out only while one is actually running.
      writeFileSync(path.join(accountDir, 'fixture-logout-hold'), 'yes');
      await window.getByTestId('cursor-change-account').click();
      await expect(window.getByTestId('cursor-connection-status')).toHaveText(
        'Signing out of Cursor…',
      );
      rmSync(path.join(accountDir, 'fixture-logout-hold'));
      await expect(window.getByTestId('cursor-connection-status')).toHaveText(
        'Finish signing in in your browser',
      );
      await expect
        .poll(() => existsSync(path.join(accountDir, 'fixture-logout')))
        .toBe(true);
      await expect
        .poll(() => externalOpen.opened)
        .toEqual([CURSOR_LOGIN_URL, CURSOR_LOGIN_URL]);
      if (decision === 'complete') {
        writeFileSync(
          path.join(accountDir, 'fixture-login-complete'),
          'second@example.test',
        );
        await expectCursorConnected(window);
        await expect(
          window.getByTestId('cursor-connection-account'),
        ).toHaveText('Signed in as second@example.test');
        // The catalog belongs to the account: the previous one's models must
        // not survive the change.
        expect(await modelLabels()).toContain('Second Account Model');
        await expect(window.getByTestId('cursor-change-account')).toHaveText(
          'Change account',
        );
      } else {
        // Make the next read fail rather than report a sign-out. The panel
        // must not offer Sign in here: that button signs the shared
        // credential store out, and nothing has established there is a
        // session to sign out.
        writeFileSync(path.join(accountDir, 'fixture-status-fail'), 'yes');
        await window.getByTestId('cursor-connect-cancel').click();
        await expect(
          window.getByTestId('cursor-connection-account'),
        ).toHaveText('Could not check the Cursor sign-in');
        await expect(window.getByTestId('cursor-change-account')).toHaveCount(
          0,
        );
        // The failed read is recoverable without leaving the panel.
        rmSync(path.join(accountDir, 'fixture-status-fail'));
        await window.getByTestId('cursor-account-retry').click();
        // Cancelling after sign-out leaves the runtime connected but signed
        // out, so the panel offers sign-in instead of a change.
        await expectCursorConnected(window);
        await expect(
          window.getByTestId('cursor-connection-account'),
        ).toHaveText('Sign in to use your Cursor account');
        await expect(window.getByTestId('cursor-change-account')).toHaveText(
          'Sign in',
        );
        await expect(window.getByTestId('cursor-change-account')).toBeEnabled();
      }
      expect(
        (await window.evaluate(() => window.api.loadPreferences()))
          .cursorEnabled,
      ).toBe(true);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await managed.close();
      await externalOpen.close();
    }
  });
}
