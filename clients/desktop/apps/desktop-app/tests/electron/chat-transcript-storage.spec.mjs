// Direct v1 upgrade, chat isolation, paging, human sticky state, lossless
// deferred output, archive continuity, and relaunch. No provider or network.
// pnpm run test:electron:built chat-transcript-storage.spec.mjs --reporter=line
import {
  readFileSync,
  mkdtempSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { seedStressTranscript } from './stress-transcript-fixture.mjs';
import {
  openStressEntry,
  openStressChat,
  inspectStressHistory,
} from './stress-transcript-driver.mjs';
import { seedWorkspace } from '../performance/scenarios.mjs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  captureDaemonDryRunEvidence,
  closeCanopy,
  launchCanopy,
} from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  injectChatEvent,
  publishTurnLifecycle,
  seedWorktreeChat,
} from './seeders/index.mjs';
import {
  seedTranscriptStorage,
  seedTranscriptRecovery,
  seedTranscriptSearch,
  transcriptScope,
  fullToolOutput,
} from './transcript-storage-fixture.mjs';
import {
  CHAT_EFFORT_TRIGGER_TEST_ID,
  closeEffortPanel,
  openEffortSlider,
  stepEffortAway,
} from './effortPanel.mjs';

test('recovers the chat scope after a delta journal sync failure from adding a tab', async () => {
  test.skip(process.platform === 'win32', 'Directory fsync is POSIX-only');
  const { userDataDir } = seedTranscriptStorage();
  let launched = await launchCanopy({ userDataDir });
  try {
    let window = await launched.electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();
    const directory = join(
      userDataDir,
      'workspaces',
      transcriptScope.projectId,
      'chat-storage-v2',
      transcriptScope.worktreeId,
    );
    await electronAppInjectJournalFailure(launched.electronApp, directory);
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    await expect
      .poll(() =>
        launched.electronApp.evaluate(
          () => globalThis.__journalSyncFailureInjected,
        ),
      )
      .toBe(true);
    await launched.electronApp.evaluate(() =>
      globalThis.__restoreJournalSync(),
    );
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({ userDataDir });
    window = await launched.electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    const state = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      transcriptScope,
    );
    expect(state.tabsFile.tabs).toHaveLength(3);
    await window.getByTestId('panel-tab-panel-chat-lean').click();
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();
    expect(
      JSON.parse(
        readFileSync(
          join(
            userDataDir,
            'workspaces',
            transcriptScope.projectId,
            'chat-storage-manifests',
            `${transcriptScope.worktreeId}.json`,
          ),
          'utf8',
        ),
      ).version,
    ).toBe(3);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

async function electronAppInjectJournalFailure(electronApp, directory) {
  await electronApp.evaluate(async (_, directory) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const path = process.getBuiltinModule('node:path');
    const journal = path.join(directory, 'delta-journal.log');
    const identity = await fs.stat(journal);
    // The writer already holds an open handle. Target its inode so the test
    // intercepts the next sync on that handle as well as newly opened ones.
    const probe = await fs.open(journal, 'r');
    const prototype = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    await probe.close();
    globalThis.__journalSyncFailureInjected = false;
    prototype.sync = async function () {
      const current = await this.stat();
      if (
        !globalThis.__journalSyncFailureInjected &&
        current.ino === identity.ino &&
        current.dev === identity.dev
      ) {
        globalThis.__journalSyncFailureInjected = true;
        throw new Error('Injected delta journal sync failure');
      }
      await originalSync.call(this);
    };
    globalThis.__restoreJournalSync = () => {
      prototype.sync = originalSync;
    };
  }, directory);
}

test('syncs the workspace namespace before retiring legacy history on first open', async () => {
  test.skip(process.platform === 'win32', 'Directory fsync is POSIX-only');
  const { userDataDir } = seedTranscriptStorage();
  const root = join(userDataDir, 'workspaces', transcriptScope.projectId);
  const legacy = join(root, 'chats', `${transcriptScope.worktreeId}.json`);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    expect(
      existsSync(legacy),
      'fixture must remain legacy until the overview or chat opens',
    ).toBe(true);
    await electronApp.evaluate(
      (_, { root, legacy }) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const syncFs = process.getBuiltinModule('node:fs');
        const originalOpen = fs.open;
        globalThis.__namespaceSyncedBeforeCleanup = false;
        fs.open = async (...args) => {
          const handle = await originalOpen(...args);
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            if (String(args[0]) === root && syncFs.existsSync(legacy))
              globalThis.__namespaceSyncedBeforeCleanup = true;
          };
          return handle;
        };
        process.getBuiltinModule('node:module').syncBuiltinESMExports();
      },
      { root, legacy },
    );
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();
    expect(existsSync(legacy)).toBe(false);
    expect(
      await electronApp.evaluate(
        () => globalThis.__namespaceSyncedBeforeCleanup,
      ),
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('recovers missing committed locators when reopening deferred tool output', async () => {
  const { userDataDir } = await seedTranscriptRecovery({
    missingLocators: true,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('panel-tab-panel-chat-long').click();
    await window
      .getByRole('button', { name: /^Agent steps:/ })
      .last()
      .click();
    await window
      .locator('[data-tool-name="Read"]')
      .getByRole('button')
      .first()
      .click();
    await window.getByTestId('chat-tool-output-open').click();
    await expect(window.getByTestId('chat-tool-output-text')).toContainText(
      'FIRST OUTPUT PAGE',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('reclaims superseded deferred tool output after a settled turn and keeps the final output through archive and reload', async () => {
  test.setTimeout(180000);
  const { userDataDir } = await seedTranscriptRecovery();
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStateV2Repository } = tsRequire(
    '../../src/main/services/chat-state-v2-repository.ts',
    import.meta.url,
  );
  // Loading a scope lazily `import()`s the delegation recovery module. From
  // this in-process harness that import reaches Node's native ESM loader, which
  // compiles an uncached CommonJS file itself and cannot parse its TypeScript.
  // Node reuses a module that is already in the CommonJS cache, so require it
  // once under its real filename with tsx's hook registered only for the call.
  const { register: registerTsxCjs } = await import('tsx/cjs/api');
  const unregisterTsxCjs = registerTsxCjs();
  try {
    createRequire(import.meta.url)(
      '../../src/main/agents/delegation/recovery.ts',
    );
  } finally {
    unregisterTsxCjs();
  }
  const root = join(userDataDir, 'workspaces', transcriptScope.projectId);
  const paths = {
    tabs: join(root, 'chats', `${transcriptScope.worktreeId}.json`),
    archives: join(root, 'chat-archives', `${transcriptScope.worktreeId}.json`),
    journal: join(root, 'chat-journals', `${transcriptScope.worktreeId}.jsonl`),
  };
  const repository = new ChatStateV2Repository({
    resolvePaths: () => paths,
  });
  const oldOutput = `OBSOLETE OUTPUT PAGE\n${'old tool output\n'.repeat(7000)}`;
  const finalOutput = `FINAL OUTPUT PAGE\n${'retained tool output\n'.repeat(7000)}`;
  const artifactName = (output) =>
    `sha256-v1-${createHash('sha256').update(output).digest('hex')}.txt`;
  const toolMessage = (output) => ({
    id: 'lean-superseded-output',
    role: 'assistant',
    timestamp: 1788000005000,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'lean-call',
        toolName: 'Read',
        output,
        isError: false,
      },
    ],
  });
  const artifactDirectory = join(
    root,
    'chat-storage-v2',
    transcriptScope.worktreeId,
    'transcripts',
    'tool-output',
    'lean',
  );
  await repository.transact(
    transcriptScope,
    [
      {
        type: 'runtime.patched',
        chatId: 'lean',
        runtime: { status: 'streaming', queuedMessageIds: [] },
      },
      {
        type: 'message.upserted',
        chatId: 'lean',
        message: {
          id: 'lean-tool-call',
          role: 'assistant',
          timestamp: 1788000004900,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'lean-call',
              toolName: 'Read',
              input: '{"file_path":"large-output.txt"}',
            },
          ],
        },
      },
      {
        type: 'message.upserted',
        chatId: 'lean',
        message: toolMessage(oldOutput),
      },
    ],
    { source: 'provider' },
  );
  await repository.transact(
    transcriptScope,
    [
      {
        type: 'message.upserted',
        chatId: 'lean',
        message: toolMessage(finalOutput),
      },
    ],
    { source: 'provider' },
  );
  expect(readdirSync(artifactDirectory).sort()).toEqual(
    [artifactName(oldOutput), artifactName(finalOutput)].sort(),
  );
  await repository.transact(
    transcriptScope,
    [
      {
        type: 'runtime.patched',
        chatId: 'lean',
        runtime: { status: 'completed', queuedMessageIds: [] },
      },
    ],
    { source: 'provider' },
  );
  await repository.drainAll();

  let launched = await launchCanopy({ userDataDir });
  try {
    let window = await launched.electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.'),
    ).toBeVisible();
    await window
      .locator('[data-tool-name="Read"]')
      .getByRole('button')
      .first()
      .click();
    await window.getByTestId('chat-tool-output-open').last().click();
    await expect(window.getByTestId('chat-tool-output-text')).toContainText(
      'FINAL OUTPUT PAGE',
    );
    await expect
      .poll(() => readdirSync(artifactDirectory).sort())
      .toEqual([artifactName(finalOutput)]);
    await window.getByTestId('chat-tool-output-close').click();
    await window.getByTestId('panel-tab-panel-chat-lean').hover();
    await window.getByTestId('panel-tab-close-panel-chat-lean').click();
    await window.getByTestId('chat-tab-archive').click();
    await window
      .getByTestId('archived-chats-modal-row')
      .filter({ hasText: 'Lean sibling' })
      .click();
    const archive = window.getByTestId('archived-chat-transcript-modal');
    await archive
      .locator('[data-tool-name="Read"]')
      .getByRole('button')
      .first()
      .click();
    await archive.getByTestId('chat-tool-output-open').last().click();
    await expect(archive.getByTestId('chat-tool-output-text')).toContainText(
      'FINAL OUTPUT PAGE',
    );
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({ userDataDir });
    window = await launched.electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('chat-tab-archive').click();
    await window
      .getByTestId('archived-chats-modal-row')
      .filter({ hasText: 'Lean sibling' })
      .click();
    const restoredArchive = window.getByTestId(
      'archived-chat-transcript-modal',
    );
    await restoredArchive
      .locator('[data-tool-name="Read"]')
      .getByRole('button')
      .first()
      .click();
    await restoredArchive.getByTestId('chat-tool-output-open').last().click();
    await expect(
      restoredArchive.getByTestId('chat-tool-output-text'),
    ).toContainText('FINAL OUTPUT PAGE');
    expect(readdirSync(artifactDirectory)).toEqual([artifactName(finalOutput)]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

async function dispatchAdvisorAction(electronApp, action, originWorktreeId) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, { requestAction, worktreeId }) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor history')),
          15_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== 'paged-history-e2e') return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, {
          kind: 'dispatch_action',
          requestId: 'paged-history-e2e',
          originWorktreeId: worktreeId,
          action: requestAction,
        });
      });
    },
    { requestAction: action, worktreeId: originWorktreeId },
  );
}

test('keeps a new composer and its draft selected when an older tab activation arrives', async () => {
  const { userDataDir } = seedTranscriptStorage();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();
    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      transcriptScope,
    );
    // Hold canonical creation while delivering the already-committed older
    // activation. No provider, sleeps, or timing-dependent background load.
    await electronApp.evaluate(({ ipcMain }, revision) => {
      ipcMain.removeHandler('chat:command');
      ipcMain.handle('chat:command', (_event, envelope) => {
        if (envelope.command.type === 'chat.create_tab')
          return new Promise(() => {});
        return { commandId: envelope.commandId, revision, outcome: 'applied' };
      });
    }, snapshot.revision);
    const tabs = window.locator('[role="tab"][data-panel-kind="chat"]');
    const before = await tabs.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    await expect(tabs).toHaveCount(before.length + 1);
    const id = (
      await tabs.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-testid')),
      )
    ).find((id) => !before.includes(id));
    const newTab = window.getByTestId(id);
    await expect(newTab).toHaveAttribute('aria-selected', 'true');
    const composer = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .getByRole('textbox')
      .first();
    const draft = 'Keep typing in this new chat.';
    await composer.pressSequentially(draft);
    await electronApp.evaluate(
      ({ BrowserWindow }, event) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send('chat:state-changed', event);
      },
      {
        ...transcriptScope,
        schemaVersion: 1,
        eventId: 'delayed-previous-activation',
        occurredAt: new Date().toISOString(),
        baseRevision: snapshot.revision,
        revision: snapshot.revision + 1,
        changes: [{ type: 'tab.active_changed', activeTabId: 'lean' }],
      },
    );
    await expect(newTab).toHaveAttribute('aria-selected', 'true');
    await composer.pressSequentially(' Still here.');
    await expect(composer).toContainText(draft + ' Still here.');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps lean chats independent and pages a lossless continuous transcript through archive and reload', async () => {
  test.setTimeout(180000);
  const { userDataDir, messages } = seedTranscriptStorage();
  let launched = await launchCanopy({ userDataDir });
  try {
    let window = await launched.electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();
    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      transcriptScope,
    );
    const long = snapshot.tabsFile.tabs.find((tab) => tab.id === 'long');
    expect({
      count: long.messages.length,
      loaded: long.transcriptLoaded,
    }).toEqual({ count: 0, loaded: false });
    await window.getByTestId('panel-tab-panel-chat-long').click();
    await expect(
      window.getByTestId('chat-transcript-load-earlier'),
    ).toHaveCount(0);
    await expect(
      window.locator('[data-sticky-user-message-id="real-human"]').first(),
    ).toBeVisible();
    await expect(
      window.locator('[data-sticky-user-message-id="restart"]'),
    ).toHaveCount(0);
    await window
      .getByRole('button', { name: /^Agent steps:/ })
      .last()
      .click();
    await window
      .locator('[data-tool-name="Read"]')
      .getByRole('button')
      .first()
      .click();
    await window.getByTestId('chat-tool-output-open').click();
    await expect(window.getByTestId('chat-tool-output-text')).toContainText(
      'FIRST OUTPUT PAGE',
    );
    await window.getByTestId('chat-tool-output-close').click();
    await expect(window.getByTestId('chat-tool-output-open')).toBeVisible();
    await window.getByTestId('chat-tool-output-open').click();
    await expect(window.getByTestId('chat-tool-output-text')).toContainText(
      'FIRST OUTPUT PAGE',
    );
    await window.getByTestId('chat-tool-output-next').click();
    await expect(window.getByTestId('chat-tool-output-text')).toContainText(
      'LAST OUTPUT PAGE',
    );
    await window.getByTestId('chat-tool-output-close').click();
    await expect(window.getByTestId('chat-tool-output-text')).toContainText(
      '[Full output stored separately]',
    );
    await expect(
      window.getByTestId('chat-transcript-load-earlier'),
    ).toHaveCount(0);
    const logPath = join(
      userDataDir,
      'workspaces',
      transcriptScope.projectId,
      'chat-storage-v2',
      transcriptScope.worktreeId,
      'transcripts',
      'long.jsonl',
    );
    const beforeArchive = readFileSync(logPath, 'utf8');
    expect(beforeArchive.trim().split('\n')).toHaveLength(messages.length);
    expect(beforeArchive).not.toContain(fullToolOutput);
    await window.getByTestId('panel-tab-panel-chat-long').hover();
    await window.getByTestId('panel-tab-close-panel-chat-long').click();
    await window.getByTestId('chat-tab-archive').click();
    await window
      .getByTestId('archived-chats-modal-row')
      .filter({ hasText: 'Long continuous transcript' })
      .click();
    const archive = window.getByTestId('archived-chat-transcript-modal');
    await expect(
      archive.getByTestId('chat-transcript-load-earlier'),
    ).toHaveCount(0);
    await archive
      .getByRole('button', { name: /^Agent steps:/ })
      .last()
      .click();
    await archive
      .locator('[data-tool-name="Read"]')
      .getByRole('button')
      .first()
      .click();
    await archive.getByTestId('chat-tool-output-open').click();
    await expect(archive.getByTestId('chat-tool-output-text')).toContainText(
      'FIRST OUTPUT PAGE',
    );
    await archive.getByTestId('chat-tool-output-next').click();
    await expect(archive.getByTestId('chat-tool-output-text')).toContainText(
      'LAST OUTPUT PAGE',
    );
    expect(readFileSync(logPath, 'utf8')).toBe(beforeArchive);
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
    launched = await launchCanopy({ userDataDir });
    window = await launched.electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();
    await window.getByTestId('chat-tab-archive').click();
    await window
      .getByTestId('archived-chats-modal-row')
      .filter({ hasText: 'Long continuous transcript' })
      .click();
    const restoredArchive = window.getByTestId(
      'archived-chat-transcript-modal',
    );
    await restoredArchive
      .getByRole('button', { name: /^Agent steps:/ })
      .last()
      .click();
    await restoredArchive
      .locator('[data-tool-name="Read"]')
      .getByRole('button')
      .first()
      .click();
    await restoredArchive.getByTestId('chat-tool-output-open').click();
    await restoredArchive.getByTestId('chat-tool-output-next').click();
    await expect(
      restoredArchive.getByTestId('chat-tool-output-text'),
    ).toContainText('LAST OUTPUT PAGE');
    expect(readFileSync(logPath, 'utf8')).toBe(beforeArchive);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

test('filters hidden persisted rows from a paged transcript', async () => {
  const { userDataDir } = seedTranscriptStorage();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();
    await window.getByTestId('panel-tab-panel-chat-long').click();
    await expect(
      window.getByText('Retained reply 509', { exact: true }),
    ).toBeVisible();

    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      transcriptScope,
    );
    const tab = snapshot.tabsFile.tabs.find(
      (candidate) => candidate.id === 'long',
    );
    const page = await window.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      {
        ...transcriptScope,
        chatId: tab.id,
        transcriptRevision: tab.transcript.transcriptRevision,
      },
    );
    const hiddenCommand = {
      id: 'hidden-local-command-output',
      role: 'user',
      timestamp: 1788000000000,
      blocks: [
        {
          type: 'text',
          text: '<local-command-stdout>private output</local-command-stdout>',
        },
        { type: 'text', text: 'HIDDEN PAGED OUTPUT' },
      ],
    };
    await electronApp.evaluate(
      ({ BrowserWindow, ipcMain }, fixture) => {
        ipcMain.removeHandler('chat:get-transcript-page');
        ipcMain.handle('chat:get-transcript-page', () => fixture.page);
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.webContents.getURL().includes('surface=app-advisor'),
        );
        if (!mainWindow) throw new Error('Main window not found');
        mainWindow.webContents.send('chat:state-changed', fixture.event);
      },
      {
        page: {
          ...page,
          messages: [
            ...page.messages,
            hiddenCommand,
            {
              id: 'hidden-synthetic-response',
              role: 'assistant',
              timestamp: 1788000000000,
              blocks: [{ type: 'text', text: 'No response requested.' }],
            },
            {
              id: 'hidden-empty-assistant',
              role: 'assistant',
              timestamp: 1788000000000,
              blocks: [],
            },
          ],
        },
        event: {
          ...transcriptScope,
          schemaVersion: 1,
          eventId: 'reload-hidden-transcript-page',
          occurredAt: new Date().toISOString(),
          baseRevision: snapshot.revision,
          revision: snapshot.revision + 1,
          changes: [
            {
              type: 'transcript.updated',
              chatId: tab.id,
              transcript: tab.transcript,
              reset: true,
            },
          ],
        },
      },
    );
    await expect(
      window.getByText('Retained reply 509', { exact: true }),
    ).toBeVisible();
    await window.keyboard.press('ControlOrMeta+f');
    const searchBar = window.getByTestId('content-search-bar');
    await expect(searchBar).toBeVisible();
    await searchBar.getByRole('textbox').fill('HIDDEN PAGED OUTPUT');
    await expect(searchBar.getByText('0 of 0', { exact: true })).toBeVisible();
    await searchBar.getByRole('textbox').fill('Retained reply 509');
    await expect(searchBar.getByText('1 of 1', { exact: true })).toBeVisible();
    await expect(window.getByText('HIDDEN PAGED OUTPUT')).toHaveCount(0);
    await expect(
      window.getByText('No response requested.', { exact: true }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('retries the failed live transcript cursor without replacing the message window', async () => {
  const { userDataDir } = seedTranscriptStorage({ oversizedTurns: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await expect(
      window.getByText('Lean sibling remains independent.', { exact: true }),
    ).toBeVisible();

    await window.getByTestId('panel-tab-panel-chat-oversized-turns').click();

    await expect(
      window.getByText(/^Final report for oversized turn 2\./).first(),
    ).toBeVisible();
    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      transcriptScope,
    );
    const tab = snapshot.tabsFile.tabs.find(
      (candidate) => candidate.id === 'oversized-turns',
    );
    const gap = tab?.transcriptWindow?.turns?.find(
      (turn) => turn.id === 'large-prompt-2',
    );
    if (gap?.before === undefined)
      throw new Error('Missing older transcript cursor');
    const before = gap.before;
    const olderPage = await window.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      {
        ...transcriptScope,
        chatId: tab.id,
        before,
        view: 'turns',
        turnId: gap.id,
        transcriptRevision: tab.transcript.transcriptRevision,
      },
    );

    await electronApp.evaluate(
      ({ ipcMain }, expected) => {
        let calls = 0;
        ipcMain.removeHandler('chat:get-transcript-page');
        ipcMain.handle('chat:get-transcript-page', (_event, request) => {
          calls += 1;
          if (calls === 1) throw new Error('private transcript storage detail');
          if (request.before !== expected.before)
            throw new Error('transcript retry dropped its cursor');
          return expected.page;
        });
      },
      { before, page: olderPage },
    );

    await window
      .locator('[data-chat-turn-group="large-prompt-2"]')
      .getByRole('button', { name: /^Agent steps:/ })
      .click();
    await expect(
      window.getByText("Couldn't load messages.", { exact: true }).last(),
    ).toBeVisible();
    await expect(
      window.getByText(/private transcript storage detail/),
    ).toHaveCount(0);
    await window.getByTestId('chat-transcript-retry').last().click();
    await expect(
      window.getByText('Progress 2/0: retained history evidence', {
        exact: true,
      }),
    ).toBeAttached();
    await expect(
      window.getByText(/^Final report for oversized turn 2\./).first(),
    ).toBeAttached();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('uses canonical retry copy for archived transcript page failures', async () => {
  const { userDataDir } = seedTranscriptStorage({ oversizedTurns: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('panel-tab-panel-chat-oversized-turns').click();
    await expect(
      window.getByTestId('chat-transcript-load-earlier'),
    ).toHaveCount(0);
    await window.getByTestId('panel-tab-panel-chat-oversized-turns').hover();
    await window
      .getByTestId('panel-tab-close-panel-chat-oversized-turns')
      .click();
    await expect(window.getByTestId('chat-tab-archive')).toBeVisible();

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:get-transcript-page');
      ipcMain.handle('chat:get-transcript-page', () => {
        throw new Error('private transcript storage detail');
      });
    });

    await window.getByTestId('chat-tab-archive').click();
    await window
      .getByTestId('archived-chats-modal-row')
      .filter({ hasText: 'Oversized turns' })
      .click();
    const archive = window.getByTestId('archived-chat-transcript-modal');
    await archive
      .locator('[data-chat-turn-group="large-prompt-2"]')
      .getByRole('button', { name: /^Agent steps:/ })
      .click();
    await expect(
      archive.getByText("Couldn't load messages.", { exact: true }).last(),
    ).toBeVisible();
    await expect(
      archive.getByText(/private transcript storage detail/),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor searches messages older than the hydrated transcript page', async () => {
  const { userDataDir, messages } = seedTranscriptStorage();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);

    const response = await dispatchAdvisorAction(
      electronApp,
      {
        type: 'worktree-chat.read_history',
        ...transcriptScope,
        chatId: 'long',
        query: 'EARLIEST RETAINED REPLY',
        limit: 1,
      },
      transcriptScope.worktreeId,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        totalMessages: messages.length,
        matchedMessages: 1,
        returnedMessages: 1,
      },
    });
    expect(JSON.stringify(response)).toContain('EARLIEST RETAINED REPLY');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('preserves the visible message position when older virtualized turns are prepended', async () => {
  test.setTimeout(120000);
  const { userDataDir } = seedTranscriptStorage({ pagedTurns: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('panel-tab-panel-chat-paged-turns').click();
    const scroller = window
      .getByTestId('chat-message-list-scroll')
      .filter({ visible: true });
    await expect(
      window.getByTestId('chat-transcript-load-earlier'),
    ).toHaveCount(0);
    await scroller.evaluate((el) => {
      el.scrollTop = 1400;
    });
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(500);
    let anchor;
    await expect
      .poll(async () => {
        anchor = await scroller.evaluate((el) => {
          const viewport = el.getBoundingClientRect();
          const item = Array.from(el.querySelectorAll('p')).find(
            (node) =>
              /^Historical answer \d+$/.test(node.textContent ?? '') &&
              node.getBoundingClientRect().top > viewport.top + 100 &&
              node.getBoundingClientRect().bottom < viewport.bottom,
          );
          return item
            ? { text: item.textContent, top: item.getBoundingClientRect().top }
            : null;
        });
        return anchor !== null;
      })
      .toBe(true);
    const snapshot = await window.evaluate(
      (scope) => window.api.chat.getState(scope),
      transcriptScope,
    );
    const tab = snapshot.tabsFile.tabs.find((tab) => tab.id === 'paged-turns');
    const page = await window.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      {
        ...transcriptScope,
        chatId: tab.id,
        view: 'turns',
        before: tab.transcriptWindow.before,
        transcriptRevision: tab.transcript.transcriptRevision,
      },
    );
    // A metadata commit can publish an equivalent descriptor while the disk
    // page is in flight. Deliver it first so this race is deterministic.
    await electronApp.evaluate(
      ({ ipcMain }, { page, event }) => {
        ipcMain.removeHandler('chat:get-transcript-page');
        ipcMain.handle('chat:get-transcript-page', (request) => {
          request.sender.send('chat:state-changed', event);
          return new Promise((resolve) => {
            globalThis.__releaseTranscriptPage = () => resolve(page);
          });
        });
      },
      {
        page,
        event: {
          ...transcriptScope,
          schemaVersion: 1,
          eventId: 'metadata-during-paging',
          occurredAt: new Date().toISOString(),
          baseRevision: snapshot.revision,
          revision: snapshot.revision + 1,
          changes: [
            {
              type: 'tab.metadata_patched',
              tabId: tab.id,
              patch: { title: 'Updated while paging' },
              removedKeys: [],
            },
            {
              type: 'transcript.updated',
              chatId: tab.id,
              transcript: tab.transcript,
              reset: false,
            },
          ],
        },
      },
    );
    await scroller.hover();
    await window.mouse.wheel(0, -1200);
    await expect(
      window.getByTestId('panel-tab-panel-chat-paged-turns'),
    ).toContainText('Updated while paging');
    anchor = await scroller.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      const item = Array.from(el.querySelectorAll('p')).find(
        (node) =>
          /^Historical answer \d+$/.test(node.textContent ?? '') &&
          node.getBoundingClientRect().top > viewport.top + 100 &&
          node.getBoundingClientRect().bottom < viewport.bottom,
      );
      return item
        ? { text: item.textContent, top: item.getBoundingClientRect().top }
        : null;
    });
    expect(anchor).not.toBeNull();
    await electronApp.evaluate(() => globalThis.__releaseTranscriptPage());
    await expect(
      window.getByTestId('chat-transcript-loading-spinner'),
    ).toHaveCount(0);
    await expect(
      window.getByText("Couldn't load the transcript; try again.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        const box = await window
          .getByText(anchor.text, { exact: true })
          .boundingBox({ timeout: 500 })
          .catch(() => null);
        return box ? Math.abs(box.y - anchor.top) : 10000;
      })
      .toBeLessThan(4);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pins the latest oversized turn on first load and loads its gap by scrolling', async () => {
  const { userDataDir } = seedTranscriptStorage({ oversizedTurns: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetHeight',
      );
      window.__stressStickyHeightReads = 0;
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        ...descriptor,
        get() {
          if (
            this.dataset.testid === 'sticky-user-message' ||
            (this.dataset.testid === 'user-message-content' &&
              this.closest('[data-testid="sticky-user-message"]'))
          )
            window.__stressStickyHeightReads += 1;
          return descriptor.get.call(this);
        },
      });
    });
    await window.getByTestId('panel-tab-panel-chat-oversized-turns').click();
    const sticky = window.locator(
      '[data-sticky-user-message-id="large-prompt-2"]',
    );
    await expect(sticky).toBeVisible();
    await window.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(await window.evaluate(() => window.__stressStickyHeightReads)).toBe(
      0,
    );

    const viewport = window.getByTestId('chat-message-list-scroll').last();
    await expect(sticky).toHaveCSS('position', 'sticky');
    await expect(
      window.getByTestId('chat-transcript-load-earlier'),
    ).toHaveCount(0);
    const turn = window.locator('[data-chat-turn-group="large-prompt-2"]');
    await turn.getByRole('button', { name: /^Agent steps:/ }).click();
    await viewport.hover();
    await window.mouse.wheel(0, -20000);
    await expect(
      window.getByText('Progress 2/0: retained history evidence', {
        exact: true,
      }),
    ).toBeAttached();
    await expect(sticky).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('shows cached completed turns with full counters and loads hidden history on expansion', async () => {
  const { userDataDir } = seedTranscriptStorage({ oversizedTurns: true });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('panel-tab-panel-chat-oversized-turns').click();
    const viewport = window.getByTestId('chat-message-list-scroll').last();
    await viewport.hover();
    await window.mouse.wheel(0, -20000);
    const turn = window.locator('[data-chat-turn-group="large-prompt-0"]');
    await expect(turn).toBeAttached();
    await expect(
      turn.getByRole('button', { name: /^Agent steps:/ }),
    ).toHaveAttribute('aria-label', /1000/);
    await expect(
      window.getByText('Progress 0/0: retained history evidence', {
        exact: true,
      }),
    ).toHaveCount(0);
    await turn.getByRole('button', { name: /^Agent steps:/ }).click();
    await expect
      .poll(
        async () => {
          await viewport.hover();
          await window.mouse.wheel(0, -20000);
          return window
            .getByText('Progress 0/0: retained history evidence', {
              exact: true,
            })
            .count();
        },
        { timeout: 15000 },
      )
      .toBe(1);
    await expect(
      turn.getByRole('button', { name: /^Agent steps:/ }),
    ).toHaveAttribute('aria-label', /1000/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('opens the 25-turn cowork stress transcript, inspects older tool history, and preserves typing', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'stress-transcript-ui-'));
  seedWorkspace(userDataDir);
  await seedStressTranscript(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await openStressEntry(window);
    await openStressChat(window);
    // Large final reports must be windowed even with fewer than 80 turns.
    expect(
      await window.locator('[data-chat-sticky-section]').count(),
    ).toBeLessThan(12);
    await expect(
      window.getByTestId('chat-transcript-virtual-window'),
    ).toBeVisible();
    await inspectStressHistory(window);
    const composer = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .getByRole('textbox')
      .first();
    await composer.fill('Preserve this draft while inspecting history.');
    await window.getByTestId('panel-tab-panel-chat-stress-lean').click();
    await window.getByTestId('panel-tab-panel-chat-stress-chat').click();
    await expect(
      window.locator('[data-sticky-user-message-id="stress-0-prompt"]'),
    ).toBeVisible();
    await expect(composer).toHaveText(
      'Preserve this draft while inspecting history.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Cmd+F counts unloaded transcript matches and loads their turn when navigating', async () => {
  const { userDataDir } = await seedTranscriptSearch({
    hiddenCanonicalRows: true,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('panel-tab-panel-chat-long').click();
    await expect(
      window.getByText('buriedmatch first buriedmatch second', { exact: true }),
    ).toHaveCount(0);
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
    );
    const search = window.getByTestId('content-search-bar');
    await search.locator('input').fill('buriedmatch');
    await expect(search).toContainText('1 of 4');
    await expect(
      window.getByText('buriedmatch first buriedmatch second', { exact: true }),
    ).toBeVisible();
    await search.getByRole('button', { name: 'Next match' }).click();
    await expect(search).toContainText('2 of 4');
    await search.getByRole('button', { name: 'Next match' }).click();
    await expect(search).toContainText('3 of 4');
    await expect(
      window.getByText('buriedmatch fourth in another turn', { exact: true }),
    ).toHaveCount(0);
    await expect(
      window.getByText('buriedmatch third', { exact: true }),
    ).toBeVisible();
    await search.getByRole('button', { name: 'Next match' }).click();
    await expect(search).toContainText('4 of 4');
    await expect(
      window.getByText('buriedmatch fourth in another turn', { exact: true }),
    ).toBeInViewport();
    await search.getByRole('button', { name: 'Next match' }).click();
    await expect(search).toContainText('1 of 4');
    await expect(
      window.getByText('buriedmatch first buriedmatch second', { exact: true }),
    ).toBeInViewport();
    await expect
      .poll(() =>
        window.evaluate(() =>
          Array.from(CSS.highlights.get('search-match-active') ?? [])
            .map((range) => range.toString())
            .join(''),
        ),
      )
      .toBe('buriedmatch');
    await search.locator('input').fill('Finish the retained');
    await expect(search).toContainText('1 of 1');
    await expect(
      window.getByText('Finish the retained work before the final answer.', {
        exact: true,
      }),
    ).toBeInViewport();
    await search.locator('input').fill('toolpreviewneedle');
    await expect(search).toContainText('1 of 1');
    await expect
      .poll(() =>
        window.evaluate(() =>
          Array.from(CSS.highlights.get('search-match-active') ?? [])
            .map((range) => range.toString())
            .join(''),
        ),
      )
      .toBe('toolpreviewneedle');
    await search.locator('input').fill('canonicalhiddenneedle');
    await expect(search).toContainText('0 of 0');
    await expect(window.getByText('canonicalhiddenneedle')).toHaveCount(0);
    const hiddenResult = await window.evaluate(
      (scope) =>
        window.api.chat.searchTranscript({
          ...scope,
          chatId: 'long',
          query: 'canonicalhiddenneedle',
          requestId: 'hidden-canonical-search',
        }),
      transcriptScope,
    );
    expect(hiddenResult).toEqual({ matches: [], totalCount: 0 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Cmd+F keeps a loaded match in view on a slow renderer', async () => {
  const { userDataDir } = await seedTranscriptSearch({
    hiddenCanonicalRows: true,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('panel-tab-panel-chat-long').click();
    // A slow runner settles virtual row heights after the search has already
    // scrolled; the active match must survive those late corrections.
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
    );
    const search = window.getByTestId('content-search-bar');
    await search.locator('input').fill('buriedmatch');
    await expect(search).toContainText('1 of 4', { timeout: 30000 });
    for (const position of [2, 3, 4]) {
      await search.getByRole('button', { name: 'Next match' }).click();
      await expect(search).toContainText(`${position} of 4`, {
        timeout: 30000,
      });
    }
    await expect(
      window.getByText('buriedmatch fourth in another turn', { exact: true }),
    ).toBeInViewport({ timeout: 30000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('changing thinking effort preserves search without scanning unchanged history', async () => {
  const { userDataDir } = await seedTranscriptSearch();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.getByTestId('panel-tab-panel-chat-long').click();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
    );
    await window.getByTestId('command-palette-input').fill('toolpreviewneedle');
    const result = window
      .locator(
        '[data-palette-section="transcripts"] [data-testid="command-palette-result"]',
      )
      .filter({ hasText: 'Long continuous transcript' });
    await expect(result).toHaveCount(1, { timeout: 30_000 });
    await window.keyboard.press('Escape');
    await electronApp.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs');
      const createReadStream = fs.createReadStream;
      globalThis.__transcriptFullReads = 0;
      fs.createReadStream = (file, options, ...rest) => {
        if (
          String(file)
            .replaceAll('\\', '/')
            .endsWith('/transcripts/long.jsonl') &&
          (options?.start ?? 0) === 0
        )
          globalThis.__transcriptFullReads++;
        return createReadStream(file, options, ...rest);
      };
      globalThis.__restoreTranscriptReadProbe = () => {
        fs.createReadStream = createReadStream;
        process.getBuiltinModule('node:module').syncBuiltinESMExports();
      };
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    });
    await window.evaluate(() => {
      window.__searchUpdated = false;
      window.__stopSearchObserver = window.api.chatSearch.onUpdated(() => {
        window.__searchUpdated = true;
      });
    });
    const thinking = window
      .locator(`[data-testid="${CHAT_EFFORT_TRIGGER_TEST_ID}"]:visible`)
      .first();
    const prior = await thinking.getAttribute('data-thinking-level');
    await stepEffortAway(await openEffortSlider(window, thinking));
    await closeEffortPanel(window);
    await expect(thinking).not.toHaveAttribute('data-thinking-level', prior);
    await expect
      .poll(() => window.evaluate(() => window.__searchUpdated))
      .toBe(true);
    expect(
      await electronApp.evaluate(() => globalThis.__transcriptFullReads),
    ).toBe(0);
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
    );
    await window.getByTestId('command-palette-input').fill('toolpreviewneedle');
    await expect(result).toHaveCount(1);
    await window.evaluate(() => window.__stopSearchObserver?.());
  } finally {
    await electronApp.evaluate(() =>
      globalThis.__restoreTranscriptReadProbe?.(),
    );
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Cmd+K indexes unloaded canonical history and bounded deferred-output previews', async () => {
  const { userDataDir } = await seedTranscriptSearch();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
    );
    const input = window.getByTestId('command-palette-input');
    await input.fill('buriedmatch');
    const results = window.locator(
      '[data-palette-section="transcripts"] [data-testid="command-palette-result"]',
    );
    await expect(
      results.filter({ hasText: 'Long continuous transcript' }),
    ).toHaveCount(1, { timeout: 30000 });
    await input.fill('toolpreviewneedle');
    await expect(
      results.filter({ hasText: 'Long continuous transcript' }),
    ).toHaveCount(1, { timeout: 30000 });
    await input.fill('artifactmiddleneedle');
    await expect(
      results.filter({ hasText: 'Long continuous transcript' }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Force-quit mid-turn with default journal storage: every event acknowledged
// before the kill is in the transcript after relaunch, nothing else is, and
// the scope keeps its journal format. Events go through canonical E2E ingress.
test('recovers a force-quit tool-heavy turn through its last acknowledged event with default delta journal storage', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'transcript-force-quit-'));
  const chatId = 'force-quit-chat';
  const turnId = 'force-quit-turn';
  const startedAt = Date.parse('2026-10-01T12:00:00.000Z');
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: transcriptScope.projectId,
    worktreeId: transcriptScope.worktreeId,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [{ id: chatId, title: 'Force-quit turn' }],
  });
  // A saved opt-out from an older build cannot disable the cutover.
  writeFileSync(
    join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { chatDeltaJournalEnabled: false },
    }),
  );
  const scopeRoot = join(userDataDir, 'workspaces', transcriptScope.projectId);
  const manifestVersion = () =>
    JSON.parse(
      readFileSync(
        join(
          scopeRoot,
          'chat-storage-manifests',
          `${transcriptScope.worktreeId}.json`,
        ),
        'utf8',
      ),
    ).version;
  const toolResults = (electronApp) =>
    electronApp.evaluate(
      async (_electron, { scope, chat }) => {
        const service =
          globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__.getChatStateService();
        const file = await service.getCompatibilityTabs(scope, {
          chatIds: [chat],
          fullTranscript: true,
        });
        return (file.tabs.find((tab) => tab.id === chat)?.messages ?? [])
          .flatMap((message) => message.blocks)
          .filter((block) => block.type === 'tool_result')
          .map((block) => block.toolUseId);
      },
      { scope: transcriptScope, chat: chatId },
    );
  let launched = await launchCanopy({ userDataDir });
  let acknowledged = [];
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible();
    const inject = (data) =>
      injectChatEvent(launched.electronApp, {
        ...transcriptScope,
        chatId,
        providerType: 'claude',
        turnUserMessageId: turnId,
        data: { ...data, canopy_turn_user_message_id: turnId },
      });
    await injectChatEvent(launched.electronApp, {
      ...transcriptScope,
      chatId,
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
        messages: [
          {
            id: turnId,
            role: 'user',
            timestamp: startedAt,
            blocks: [{ type: 'text', text: 'Run thirty tools in a row.' }],
          },
        ],
      },
    });
    await publishTurnLifecycle(launched.electronApp, {
      ...transcriptScope,
      chatId,
      turnUserMessageId: turnId,
      phase: 'start',
      atMs: startedAt,
    });
    await expect(panel.getByText('Run thirty tools in a row.')).toBeVisible({
      timeout: 30000,
    });
    // A long, tool-heavy turn; every tenth output is externalized.
    for (let step = 0; step < 30; step += 1) {
      const toolUseId = `force-quit-tool-${step}`;
      await inject({
        type: 'assistant',
        message: {
          id: `${toolUseId}-message`,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'Bash',
              input: {
                command: `echo step ${step}`,
                description: `Run step ${step}`,
              },
            },
          ],
        },
      });
      await inject({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content:
                step % 10 === 9
                  ? `step ${step} large output\n`.repeat(4000)
                  : `step ${step} output`,
            },
          ],
        },
      });
    }
    acknowledged = await toolResults(launched.electronApp);
    expect(acknowledged).toEqual(
      Array.from({ length: 30 }, (_, step) => `force-quit-tool-${step}`),
    );
    expect(manifestVersion()).toBe(3);
    // The streamed rows are journal records no checkpoint holds yet.
    expect(
      statSync(
        join(
          scopeRoot,
          'chat-storage-v2',
          transcriptScope.worktreeId,
          'delta-journal.log',
        ),
      ).size,
    ).toBeGreaterThan(4096);
    // Kill only this fixture's Electron main process: no drain, so with
    // default journal storage the turn's records are still only in the journal.
    await captureDaemonDryRunEvidence(launched.electronApp);
    const mainPid = await launched.electronApp.evaluate(() => process.pid);
    process.kill(mainPid, 'SIGKILL');
  } finally {
    await closeCanopy(launched.electronApp, userDataDir, {
      keepUserData: true,
    });
  }
  launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openMainPage();
    await app.selectWorktree(transcriptScope.worktreeId);
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByText('Run thirty tools in a row.')).toBeVisible({
      timeout: 30000,
    });
    // The turn's tool calls render as one collapsed group of all thirty.
    await expect(
      panel
        .getByTestId('turn-work-header')
        .locator('[data-turn-step-count="30"]'),
    ).toBeVisible({
      timeout: 30000,
    });
    expect(await toolResults(launched.electronApp)).toEqual(acknowledged);
    expect(manifestVersion()).toBe(3);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
