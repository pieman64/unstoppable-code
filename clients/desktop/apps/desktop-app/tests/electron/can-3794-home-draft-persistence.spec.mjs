import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedWelcomeChecklist } from './seeders/seedWelcomeChecklist.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  PERSONAL_CONTEXT_WORKSPACE,
  seedCoworkWorkspace,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  publisherSkills,
  startPublisherSkillsFixture,
} from './publisherSkillsFixture.mjs';

async function logicalText(editor) {
  return editor.evaluate((element) =>
    Array.from(element.children)
      .filter((node) => node.getAttribute('data-slate-node') === 'element')
      .map((node) => {
        const line = node.cloneNode(true);
        line
          .querySelectorAll('[data-slate-placeholder]')
          .forEach((p) => p.remove());
        return (line.textContent ?? '').replace(/[\u200b\ufeff]/g, '');
      })
      .join('\n'),
  );
}

async function selectAllDraft(editor) {
  // Restoration and native focus can settle after the first keyboard action.
  // Retry the real selection action, then wait through Slate's selection
  // throttle before issuing Backspace or replacing the selected text.
  await expect(async () => {
    await editor.press('ControlOrMeta+A');
    await editor.page().waitForTimeout(200);
    expect(
      await editor.evaluate(() => document.getSelection()?.isCollapsed),
    ).toBe(false);
  }).toPass();
}

async function expectCanonicalEmpty(window, home) {
  // Chat permits an empty task. Pipeline Send reads the same canonical store
  // and requires text, so this pins the cleared store without a test-only seam.
  await home.getByTestId('home-composer-plus-button').click();
  await window
    .getByTestId('home-composer-plus-menu')
    .getByTestId('home-pipeline-mode-button')
    .click();
  await expect(home.getByTestId('home-send-button')).toBeDisabled();
}

async function typeLines(editor, lines) {
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) await editor.press('Shift+Enter');
    if (line) await editor.pressSequentially(line);
  }
}

for (const completion of [
  'new draft',
  'overlapping success',
  'overlapping failure',
]) {
  const title =
    completion === 'new draft'
      ? 'a send completed under the previous account cannot clear the new draft'
      : `the previous account ${completion} cannot unlock a new pending send`;
  test(title, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can3794-send-owner-'),
    );
    seedCoworkWorkspace({ userDataDir });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await electronApp.evaluate(({ ipcMain }) => {
        globalThis.__can3794SendCount = 0;
        ipcMain.removeHandler('automations:create');
        ipcMain.handle(
          'automations:create',
          (_event, request) =>
            new Promise((resolve) => {
              const index = globalThis.__can3794SendCount++;
              const finish = (fail = false) =>
                resolve(
                  fail
                    ? { ok: false, error: 'previous account failed' }
                    : {
                        ok: true,
                        activity: {
                          ...request,
                          version: 1,
                          id: `account-scheduled-send-${index}`,
                          enabled: true,
                          createdAt: new Date().toISOString(),
                          updatedAt: new Date().toISOString(),
                        },
                      },
                );
              if (index === 0) globalThis.__can3794CompleteOldSend = finish;
              else globalThis.__can3794CompleteNewSend = finish;
            }),
        );
      });
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      const editor = home.getByTestId('home-composer-editor');
      await typeLines(editor, ['old account submission']);
      const scheduleAndSend = async () => {
        await home.getByTestId('home-composer-plus-button').click();
        await window
          .getByTestId('home-composer-plus-menu')
          .getByTestId('home-schedule-button')
          .click();
        const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const pad = (value) => String(value).padStart(2, '0');
        await window
          .getByTestId('schedule-message-date')
          .fill(
            `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`,
          );
        await window
          .getByTestId('schedule-message-time')
          .fill(`${pad(future.getHours())}:${pad(future.getMinutes())}`);
        await window.getByTestId('schedule-message-save').click();
        await home.getByTestId('home-send-button').click();
      };
      await scheduleAndSend();
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => typeof globalThis.__can3794CompleteOldSend,
          ),
        )
        .toBe('function');
      // Account rotation starts an async preference read to seed its workspace.
      // Hold that real IPC reply so the new account can edit before seeding ends.
      if (completion === 'new draft') {
        const preferences = await window.evaluate(() =>
          window.api.loadPreferences(),
        );
        await electronApp.evaluate(({ ipcMain }, snapshot) => {
          globalThis.__can3794CompletePreferenceReads = [];
          ipcMain.removeHandler('preferences:load');
          ipcMain.handle(
            'preferences:load',
            () =>
              new Promise((resolve) => {
                globalThis.__can3794CompletePreferenceReads.push(() =>
                  resolve(snapshot),
                );
              }),
          );
        }, preferences);
      }
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send(
          'workspace-context:changed',
          {
            context: { kind: 'personal' },
            revision: 0,
            organizations: [],
            reason: 'account-change',
          },
        );
      });
      await expect.poll(() => logicalText(editor)).toBe('');
      if (completion === 'new draft') {
        await expect(home.getByTestId('home-workspace-select')).toContainText(
          'Choose project',
        );
      } else {
        await expect(home.getByTestId('home-workspace-select')).toContainText(
          'Seeded Cowork',
        );
      }
      await typeLines(editor, ['new account draft']);
      if (completion !== 'new draft') {
        await scheduleAndSend();
        await expect
          .poll(() =>
            electronApp.evaluate(
              () => typeof globalThis.__can3794CompleteNewSend,
            ),
          )
          .toBe('function');
        await expect(home.getByTestId('home-send-button')).toBeDisabled();
      }
      await electronApp.evaluate(
        (_electron, fail) => globalThis.__can3794CompleteOldSend(fail),
        completion === 'overlapping failure',
      );
      if (completion !== 'overlapping failure') {
        await expect(
          window.getByText('Scheduled task automation created', {
            exact: true,
          }),
        ).toBeVisible();
      }
      await window.evaluate(() => window.api.voice.isSupported());
      await window.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await expect.poll(() => logicalText(editor)).toBe('new account draft');
      if (completion !== 'new draft') {
        await expect(home.getByTestId('home-send-button')).toBeDisabled();
        await expect(editor).toHaveAttribute('contenteditable', 'true');
        await editor.press('Enter');
        await window.evaluate(() => window.api.voice.isSupported());
        expect(
          await electronApp.evaluate(() => globalThis.__can3794SendCount),
        ).toBe(2);
        const newerDraft = await logicalText(editor);
        await electronApp.evaluate(() => globalThis.__can3794CompleteNewSend());
        await expect(home.getByTestId('home-send-button')).toBeEnabled();
        await expect.poll(() => logicalText(editor)).toBe(newerDraft);
        return;
      }
      await app.openMainPage();
      await window.getByTestId('sidebar-create-task').click();
      await expect.poll(() => logicalText(editor)).toBe('new account draft');
    } finally {
      await electronApp.evaluate(() => {
        globalThis.__can3794CompleteOldSend?.();
        globalThis.__can3794CompleteNewSend?.();
      });
      await electronApp.evaluate(() => {
        for (const finish of globalThis.__can3794CompletePreferenceReads ?? [])
          finish();
      });
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const transition of [
  'account rotation',
  'organization context rotation',
  'hidden embedded Home',
]) {
  test(`${transition} rejects a delayed transcript from the previous draft owner`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3794-voice-'));
    seedCoworkWorkspace({ userDataDir });
    const { electronApp } = await launchCanopy({
      userDataDir,
      ...(transition === 'organization context rotation'
        ? { env: ORG_CONTEXT_ENV }
        : {}),
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      // Exercise the real preload, provider, hook, and editor. Only the OS audio
      // source and existing native voice handlers are replaced in this test app.
      await electronApp.evaluate(({ ipcMain }) => {
        for (const channel of [
          'voice:is-supported',
          'voice:request-system-access',
          'voice:start',
          'voice:cancel',
        ]) {
          ipcMain.removeHandler(channel);
        }
        ipcMain.handle('voice:is-supported', () => ({ supported: true }));
        ipcMain.handle('voice:request-system-access', () => ({
          microphone: 'granted',
          speechRecognition: 'granted',
        }));
        ipcMain.handle('voice:start', (_event, request) => {
          globalThis.__can3794VoiceSessionId = request.sessionId;
          return { sessionId: request.sessionId };
        });
        // Keep the old provider subscribed while cancellation is in flight.
        ipcMain.handle(
          'voice:cancel',
          () =>
            new Promise((resolve) => {
              globalThis.__can3794CompleteVoiceCancellation = resolve;
            }),
        );
      });
      await window.evaluate(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
          },
        });
        window.AudioContext = class {
          audioWorklet = { addModule: async () => {} };
          createMediaStreamSource() {
            return { connect() {}, disconnect() {} };
          }
          async close() {}
        };
        window.AudioWorkletNode = class {
          port = { onmessage: null };
          disconnect() {}
        };
      });
      if (transition !== 'hidden embedded Home') {
        await window.getByTestId('sidebar-create-task').click();
      } else {
        await app.openMainPage();
      }
      // Controls may have probed native support before the fixture installed
      // its mock. Refresh them through the real account boundary before
      // starting dictation, regardless of which composer was already mounted.
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send(
          'workspace-context:changed',
          {
            context: { kind: 'personal' },
            revision: 0,
            organizations: [],
            reason: 'account-change',
          },
        );
      });
      const home =
        transition !== 'hidden embedded Home'
          ? window.getByTestId('page-home')
          : window.locator(
              '[data-testid="home-surface"][data-variant="embedded"]',
            );
      const editor = home.getByTestId('home-composer-editor');
      await typeLines(editor, ['previous account draft']);
      await home.getByTestId('voice-input-button').click();
      await expect(home.getByTestId('voice-recording-row')).toBeVisible();
      if (transition !== 'hidden embedded Home') {
        const broadcast =
          transition === 'account rotation'
            ? {
                context: { kind: 'personal' },
                revision: 0,
                organizations: [],
                reason: 'account-change',
              }
            : {
                context: {
                  kind: 'organization',
                  organizationId: ORG_CONTEXT_A,
                },
                revision: 1,
                organizations: ORG_CONTEXT_ORGANIZATIONS,
                reason: 'switch',
              };
        await electronApp.evaluate(({ BrowserWindow }, state) => {
          BrowserWindow.getAllWindows()[0].webContents.send(
            'workspace-context:changed',
            state,
          );
        }, broadcast);
        await expect.poll(() => logicalText(editor)).toBe('');
      } else {
        await window.getByTestId('sidebar-create-task').click();
        await expect(home).toBeHidden();
        const visibleEditor = window
          .getByTestId('page-home')
          .getByTestId('home-composer-editor');
        await visibleEditor.click();
        await selectAllDraft(visibleEditor);
        await window.keyboard.type('newer visible draft');
        await expect
          .poll(() => logicalText(visibleEditor))
          .toBe('newer visible draft');
      }
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('voice:event', {
          sessionId: globalThis.__can3794VoiceSessionId,
          type: 'final',
          text: 'late previous account transcript',
        });
      });
      // Wait for an IPC round trip after the event, then check the editor and
      // canonical Send state. An immediately satisfied empty poll can miss it.
      await window.evaluate(() => window.api.voice.isSupported());
      if (transition !== 'hidden embedded Home') {
        await expect.poll(() => logicalText(editor)).toBe('');
        await expectCanonicalEmpty(window, home);
        await app.openMainPage();
        await window.getByTestId('sidebar-create-task').click();
        await expect.poll(() => logicalText(editor)).toBe('');
      } else {
        // The still-mounted hidden editor actually consumed the old event;
        // its callbacks must not publish that content over the newer draft.
        await expect
          .poll(() => logicalText(editor))
          .toContain('late previous account transcript');
        await expect
          .poll(() =>
            logicalText(
              window
                .getByTestId('page-home')
                .getByTestId('home-composer-editor'),
            ),
          )
          .toBe('newer visible draft');
        await app.openMainPage();
        await expect
          .poll(() => logicalText(editor))
          .toBe('newer visible draft');
      }
    } finally {
      await electronApp.evaluate(() => {
        globalThis.__can3794CompleteVoiceCancellation?.();
      });
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('New Task keeps multiline text, latest edits, and an intentional clear across navigation', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const worktreeId = await window
      .getByTestId('worktree-row')
      .first()
      .getAttribute('data-worktree-id');
    expect(worktreeId).toBeTruthy();
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    const editor = home.getByTestId('home-composer-editor');
    await typeLines(editor, ['first line', '', 'last line']);
    await expect
      .poll(() => logicalText(editor))
      .toBe('first line\n\nlast line');
    await app.selectWorktree(worktreeId);
    await expect(home).toBeHidden();
    await window.getByTestId('sidebar-create-task').click();
    await expect
      .poll(() => logicalText(editor))
      .toBe('first line\n\nlast line');
    await editor.press('ControlOrMeta+End');
    await editor.pressSequentially(' edited');
    await app.selectWorktree(worktreeId);
    await app.openSettings();
    await app.closeSettings();
    await window.getByTestId('sidebar-create-task').click();
    await expect
      .poll(() => logicalText(editor))
      .toBe('first line\n\nlast line edited');
    await editor.click();
    await selectAllDraft(editor);
    await window.keyboard.press('Backspace');
    await expect.poll(() => logicalText(editor)).toBe('');
    await app.selectWorktree(worktreeId);
    await window.getByTestId('sidebar-create-task').click();
    await expect.poll(() => logicalText(editor)).toBe('');
    await expect(editor.getByTestId('file-reference-pill')).toHaveCount(0);
    await expectCanonicalEmpty(window, home);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const embeddedPage of ['main', 'kanban']) {
  test(`a previously mounted embedded composer on ${embeddedPage} receives the latest canonical draft when shown`, async () => {
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy();
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      async function openEmbeddedPage() {
        if (embeddedPage === 'main') {
          await app.openMainPage();
        } else {
          // With no projects, Kanban shows the embedded Home instead of a board.
          await window.getByTestId('sidebar-nav-kanban').click();
        }
      }
      await openEmbeddedPage();
      const embedded = window.locator(
        '[data-testid="home-surface"][data-variant="embedded"]',
      );
      const editor = embedded.getByTestId('home-composer-editor');
      await typeLines(editor, ['embedded draft']);
      await window.getByTestId('sidebar-create-task').click();
      await expect(embedded).toBeHidden();
      const pageEditor = window
        .getByTestId('page-home')
        .getByTestId('home-composer-editor');
      await expect.poll(() => logicalText(pageEditor)).toBe('embedded draft');
      await pageEditor.click();
      await expect(pageEditor).toHaveAttribute('contenteditable', 'true');
      await selectAllDraft(pageEditor);
      await window.keyboard.type('latest draft');
      await openEmbeddedPage();
      await expect(embedded).toBeVisible();
      await expect.poll(() => logicalText(editor)).toBe('latest draft');
      await editor.click();
      await selectAllDraft(editor);
      await window.keyboard.press('Backspace');
      await expect.poll(() => logicalText(editor)).toBe('');
      await window.getByTestId('sidebar-create-task').click();
      await expect.poll(() => logicalText(pageEditor)).toBe('');
      await expectCanonicalEmpty(window, window.getByTestId('page-home'));
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Send uses the restored visible multiline draft and a successful send clears it', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    const editor = home.getByTestId('home-composer-editor');
    await typeLines(editor, ['visible draft', '', 'sent exactly']);
    await app.selectWorktree('demo-main');
    await window.getByTestId('sidebar-create-task').click();
    await expect
      .poll(() => logicalText(editor))
      .toBe('visible draft\n\nsent exactly');
    await home.getByTestId('home-branch-picker-button').click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    await expect
      .poll(() => window.locator('[data-role="user"]').last().innerText())
      .toBe('visible draft\n\nsent exactly');
    await window.getByTestId('sidebar-create-task').click();
    await expect.poll(() => logicalText(editor)).toBe('');
    await expect(editor.getByTestId('file-reference-pill')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3933: a sent cowork task is purged from New Task after landing in the chat', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3933-cowork-'));
  seedCoworkWorkspace({ userDataDir });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    const editor = home.getByTestId('home-composer-editor');
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Seeded Cowork',
    );
    await typeLines(editor, ['sent cowork task']);
    await expect.poll(() => logicalText(editor)).toBe('sent cowork task');
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    await expect
      .poll(() => window.locator('[data-role="user"]').last().innerText())
      .toBe('sent cowork task');
    await window.getByTestId('sidebar-create-task').click();
    await expect(editor).toBeVisible();
    await expect.poll(() => logicalText(editor)).toBe('');
    await expect(editor.getByTestId('file-reference-pill')).toHaveCount(0);
    await expectCanonicalEmpty(window, home);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-3933: a task sent to the default new worktree is purged from New Task', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    const editor = home.getByTestId('home-composer-editor');
    // The branch picker stays on its default "New worktree" target.
    await typeLines(editor, ['sent new worktree task']);
    await expect.poll(() => logicalText(editor)).toBe('sent new worktree task');
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    await expect
      .poll(() => window.locator('[data-role="user"]').last().innerText(), {
        timeout: 60_000,
      })
      .toBe('sent new worktree task');
    await window.getByTestId('sidebar-create-task').click();
    await expect(editor).toBeVisible();
    await expect.poll(() => logicalText(editor)).toBe('');
    await expect(editor.getByTestId('file-reference-pill')).toHaveCount(0);
    await expectCanonicalEmpty(window, home);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The Getting started CTA that first exercised this retired with CAN-4010;
// a Marketplace skill's Try now stages its starter prompt the same way
// (`requestHomeComposerText`) when no worktree is selected.
test('a staged starter prompt replaces a retained draft before Home restores it', async () => {
  test.setTimeout(180_000);
  const fixture = await startPublisherSkillsFixture();
  const skill = publisherSkills[0];
  try {
    const { electronApp, userDataDir } = await launchCanopy({
      userDataDir: seedWelcomeChecklist({ roles: ['other'] }),
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
      env: { CANOPY_E2E_CLOUD_BASE_URL: fixture.baseUrl },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.getByTestId('sidebar-create-task').click();
      const editor = window
        .getByTestId('page-home')
        .getByTestId('home-composer-editor');
      await typeLines(editor, ['old retained draft']);
      await app.openPluginsPage();
      await window.getByTestId('plugins-type-tab-skill').click();
      await window.getByTestId('plugins-search').fill(skill.name);
      await window
        .getByTestId(`plugins-entry-add-public-share:skill:${skill.externalId}`)
        .click();
      const review = window.getByTestId('deep-link-share-landing');
      await review.getByTestId('deep-link-share-install').click();
      await expect(review).toHaveCount(0);
      await expect(window.getByText('Skill installed.').last()).toBeVisible();
      // Install lands on the installed skill; Try now is on its Marketplace row.
      await app.openPluginsPage();
      await window.getByTestId('plugins-type-tab-skill').click();
      await window.getByTestId('plugins-search').fill(skill.name);
      await window
        .getByTestId(`customize-row-public-share:skill:${skill.externalId}`)
        .click();
      await window
        .getByTestId('plugins-entry-detail')
        .getByTestId('deep-link-share-try')
        .click();
      await expect(editor).toBeVisible();
      await expect(editor).toContainText(
        `Using the ${skill.name} skill, run one quick, real example`,
      );
      const replacement = await logicalText(editor);
      expect(replacement).not.toContain('old retained draft');
      await app.selectWorktree('demo-main');
      await window.getByTestId('sidebar-create-task').click();
      await expect.poll(() => logicalText(editor)).toBe(replacement);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  } finally {
    await fixture.close();
  }
});

test('Personal to organization rebind clears the draft before it can be restored', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3794_context_draft';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3794-context-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, apiKey);
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await home.getByTestId('home-workspace-select').click();
    await window
      .getByTestId(`home-workspace-option-${PERSONAL_CONTEXT_WORKSPACE}`)
      .click();
    const editor = home.getByTestId('home-composer-editor');
    await typeLines(editor, ['private Personal draft']);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-create-task').click();
    await expect(home.getByTestId('home-workspace-select')).not.toContainText(
      'Personal repository',
    );
    await expect.poll(() => logicalText(editor)).toBe('');
    await app.openMainPage();
    await window.getByTestId('sidebar-create-task').click();
    await expect.poll(() => logicalText(editor)).toBe('');
    await expectCanonicalEmpty(window, home);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
