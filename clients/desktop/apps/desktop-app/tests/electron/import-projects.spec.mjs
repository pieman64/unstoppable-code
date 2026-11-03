import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  overridePickedFolder,
  seedPickedParentFixture,
} from './seeders/seedPickedParentFixture.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';
import {
  IMPORT_FIXTURE_FOLDER_PROJECT as FOLDER_PROJECT,
  IMPORT_FIXTURE_FOLDER_SESSION_ID as FOLDER_SESSION_ID,
  IMPORT_FIXTURE_GIT_PROJECT as GIT_PROJECT,
  externalProjectCandidateIdFor,
  seedExternalProjectImportFixture,
  writeImportFixtureTranscript,
} from './seeders/seedExternalProjectImportFixture.mjs';
import { memoryRowSelector } from './memoryRows.mjs';

// CAN-2439: bulk-import local Claude and Codex projects.
// CAN-3076: recognizable project and chat titles throughout.
//
// `seedExternalProjectImportFixture` seeds a Claude Code store under the
// harness's isolated CLAUDE_CONFIG_DIR (`<userDataDir>/provider-state/claude`)
// and a Claude Desktop data root under the OS temp dir: a `.claude.json`
// project registry, one transcript per project, and one folder-less Cowork
// session whose working directory is a per-session `outputs` scratch folder.
// Production discovery excludes the OS temp dir on purpose; the E2E build
// lifts that rule through CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT so fixtures
// stay self-contained.
//
// Flow under test: Settings → General → "Import from Claude and Codex" →
// three candidates listed (git root as a Code project, plain folder as a
// Cowork project, the scratch folder under its session title rather than
// "outputs", each with its chat titles) → import → results → all three in
// the sidebar, the Cowork Work Entries named from their chats → a second
// scan reports all three as already imported (idempotency).
//
// CAN-3079: a scan also summarizes the chat titles it found into the user's
// memory profile, whether or not anything is imported, and a rescan with new
// titles refreshes that profile in place.
//
// Determinism: no live agents, no network, no native folder picker. The
// profile summarizer runs against the shared mock LLM, which answers with the
// scenario registered under the marker embedded in a chat title.

const SCRATCH_SESSION_ID = '99999999-8888-4777-8666-555555555555';
const SCRATCH_TITLE = 'Car wash transportation';
const CODE_CHAT_DESTINATION_WARNING =
  'Chats from Code projects open in a new worktree, so commit and push your work before you import.';

function readImportedCoworkChats(userDataDir, workspaceId) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
  const manifestsDir = path.join(workspaceRoot, 'chat-storage-manifests');
  if (!existsSync(manifestsDir)) return [];
  return readdirSync(manifestsDir)
    .filter((name) => name.endsWith('.json'))
    .flatMap(
      (name) => readChatStorageTabs(workspaceRoot, name.slice(0, -5)).tabs,
    );
}

test.describe('import projects from Claude and Codex', () => {
  test('CAN-5487 Settings defaults repositories, preserves parent choice on rescan and enforces exclusivity', async () => {
    const fixture = seedPickedParentFixture();
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'can5487-settings-'),
    );
    const claudeDir = path.join(userDataDir, 'provider-state', 'claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      path.join(claudeDir, '.claude.json'),
      JSON.stringify({ projects: { [fixture.parent]: {} } }),
    );
    let launch;
    let restoreDialog;
    try {
      launch = await launchCanopy({ userDataDir, env: fixture.env });
      restoreDialog = await overridePickedFolder(
        launch.electronApp,
        fixture.parent,
      );
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.openSettingsSection('canopy');
      await window.getByTestId('settings-canopy-import-projects-open').click();
      const modal = window.getByTestId('import-projects-modal');
      const box = (id) =>
        modal.getByTestId(`import-projects-row-checkbox-${id}`);
      // Provider discovery initially selects the plain folder. Picking it
      // must replace that automatic selection with its repository defaults.
      await expect(box(fixture.parentId)).toBeChecked();
      await modal.getByTestId('import-projects-pick-folder').click();
      await expect(box(fixture.parentId)).not.toBeChecked();
      await expect(box(fixture.parentId)).toBeEnabled();
      await expect(
        modal.getByTestId(`import-projects-row-${fixture.parentId}`),
      ).toContainText('Contains 3 code repositories');
      for (const { id } of fixture.repositories)
        await expect(box(id)).toBeChecked();
      await box(fixture.parentId).check();
      for (const { id } of fixture.repositories)
        await expect(box(id)).not.toBeChecked();
      await modal.getByTestId('import-projects-rescan').click();
      await expect(modal.getByTestId('import-projects-choose')).toBeVisible();
      await expect(box(fixture.parentId)).toBeChecked();
      await box(fixture.repositories[0].id).check();
      await expect(box(fixture.parentId)).not.toBeChecked();
      await box(fixture.parentId).check();
      await modal.getByTestId('import-projects-select-all').check();
      await expect(box(fixture.parentId)).not.toBeChecked();
      for (const { id } of fixture.repositories)
        await expect(box(id)).toBeChecked();
    } finally {
      try {
        if (restoreDialog) await restoreDialog();
      } finally {
        try {
          if (launch) await closeCanopy(launch.electronApp, launch.userDataDir);
        } finally {
          fixture.cleanup();
        }
      }
    }
  });
  test('imports a git root, a plain folder, and a scratch Cowork session under recognizable names, then reports them as imported', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-import-e2e-'),
    );
    const fixture = seedExternalProjectImportFixture({
      userDataDir,
      scratchSessions: [
        {
          id: SCRATCH_SESSION_ID,
          title: SCRATCH_TITLE,
          prompt: 'I need to wash my car. Should I walk there?',
          lastActivityAt: '2026-09-15T09:00:00.000Z',
        },
      ],
    });
    const { gitApp, notes } = fixture;
    const [scratch] = fixture.scratch;
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await app.openSettings();
      await app.openSettingsSection('canopy');
      const importRow = window.getByTestId('settings-canopy-import-projects');
      await expect(importRow).toBeVisible();
      await expect(importRow).toContainText(CODE_CHAT_DESTINATION_WARNING);
      await window.getByTestId('settings-canopy-import-projects-open').click();

      const modal = window.getByTestId('import-projects-modal');
      await expect(modal).toBeVisible();
      const list = modal.getByTestId('import-projects-list');
      await expect(list).toBeVisible({ timeout: 30_000 });
      await expect(list).toHaveAttribute('data-row-count', '3');
      const chooseNote = modal.getByTestId('import-projects-choose-note');
      await expect(chooseNote).toContainText(CODE_CHAT_DESTINATION_WARNING);
      await expect(chooseNote).toContainText(
        'Your folders stay put and nothing changes until you say so.',
      );

      const gitId = externalProjectCandidateIdFor(gitApp);
      const notesId = externalProjectCandidateIdFor(notes);
      const scratchId = externalProjectCandidateIdFor(scratch.cwd);
      const gitRow = list.getByTestId(`import-projects-row-${gitId}`);
      const folderRow = list.getByTestId(`import-projects-row-${notesId}`);
      const scratchRow = list.getByTestId(`import-projects-row-${scratchId}`);
      await expect(gitRow).toHaveAttribute('data-status', 'available');
      await expect(folderRow).toHaveAttribute('data-status', 'available');
      await expect(scratchRow).toHaveAttribute('data-status', 'available');
      await expect(gitRow).toContainText(GIT_PROJECT);
      await expect(gitRow).toContainText(gitApp);
      await expect(
        gitRow.getByTestId('import-projects-provider-claude'),
      ).toBeVisible();
      await expect(gitRow).toContainText('Code project');
      await expect(gitRow).toContainText('1 chat');
      // Each row lists its newest chat titles, so similar folders can be
      // told apart before importing (CAN-3076).
      await expect(
        gitRow.getByTestId(`import-projects-row-chat-titles-${gitId}`),
      ).toHaveText('Login bug');
      await expect(folderRow).toContainText('Cowork project');
      await expect(
        folderRow.getByTestId(`import-projects-row-chat-titles-${notesId}`),
      ).toHaveText('Meeting notes');
      await expect(
        folderRow.locator('[data-testid^="import-projects-row-chats-"]'),
      ).toBeChecked();
      // The folder-less Cowork session's scratch folder is named after the
      // session, not its repeated `outputs` directory name (CAN-3076).
      await expect(
        scratchRow.getByTestId(`import-projects-row-name-${scratchId}`),
      ).toHaveText(SCRATCH_TITLE);
      await expect(scratchRow).toContainText(
        scratch.cwd.replace(/^\/private/, ''),
      );
      await expect(scratchRow).toContainText('Cowork project');

      // Every eligible candidate is preselected; the CTA counts them.
      await expect(
        modal.getByTestId('import-projects-select-all'),
      ).toBeChecked();
      const submit = modal.getByTestId('import-projects-submit');
      await expect(submit).toHaveText('Import 3 projects');
      await submit.click();

      const results = modal.getByTestId('import-projects-results');
      await expect(results).toBeVisible({ timeout: 120_000 });
      await expect(results.locator('[data-status="imported"]')).toHaveCount(3);
      await expect(results).toContainText('3 projects are ready');
      await expect(
        results.getByTestId(`import-projects-result-${scratchId}`),
      ).toContainText(SCRATCH_TITLE);
      await modal.getByTestId('import-projects-done').click();
      await expect(modal).toHaveCount(0);
      await app.closeSettings();

      // The projects are in the sidebar and survive a fresh read of the index.
      await app.openMainPage();
      // The imported git root is a Code project section (with the worktree
      // that received its chat) and the folder is a Cowork project row whose
      // Work Entry holds the imported chat.
      // The always-mounted (hidden) Code page also renders these names, so
      // scope to the visible copies in the sidebar.
      await expect(
        window.locator(`span[title="${GIT_PROJECT}"]:visible`).first(),
      ).toBeVisible({ timeout: 30_000 });
      // The Cowork project's Work Entry is named from the chat it holds,
      // never a repeated "Imported from Claude" (CAN-3076).
      await expect(
        window.locator('text="Meeting notes"').locator('visible=true').first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(window.locator('text="Imported from Claude"')).toHaveCount(
        0,
      );
      await app.openChatPage();
      await expect(
        window.getByTestId(`sidebar-cowork-project-${FOLDER_PROJECT}`),
      ).toBeVisible({ timeout: 30_000 });
      // The scratch session became a Cowork project under its session
      // title, with a Work Entry of the same name.
      await expect(
        window
          .locator(`text="${SCRATCH_TITLE}"`)
          .locator('visible=true')
          .first(),
      ).toBeVisible({ timeout: 30_000 });

      const indexFile = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'workspaces', 'index.json'),
          'utf8',
        ),
      );
      const ids = indexFile.workspaces.map((entry) => entry.id);
      expect(ids).toEqual(
        expect.arrayContaining([GIT_PROJECT, FOLDER_PROJECT]),
      );
      const scratchWorkspace = indexFile.workspaces.find(
        (entry) => entry.name === SCRATCH_TITLE,
      );
      expect(scratchWorkspace?.type).toBe('cowork');
      expect(
        indexFile.workspaces.find((entry) => entry.id === FOLDER_PROJECT)?.type,
      ).toBe('cowork');
      // The Cowork project points at the original folder and no scaffolding
      // was written into it.
      const coworkConfig = JSON.parse(
        readFileSync(
          path.join(
            userDataDir,
            'workspaces',
            FOLDER_PROJECT,
            'workspace.json',
          ),
          'utf8',
        ),
      );
      // Projects store canonical paths (macOS temp dirs resolve under /private).
      expect(coworkConfig.externalPath).toBe(realpathSync(notes));
      expect(existsSync(path.join(gitApp, 'canopy.json'))).toBe(false);

      // The Cowork project received the Claude chat as a continuable tab.
      const tabs = readImportedCoworkChats(userDataDir, FOLDER_PROJECT);
      const imported = tabs.find((tab) => tab.title === 'Meeting notes');
      expect(imported).toBeTruthy();
      expect(imported.sdkSessionId).toBe(FOLDER_SESSION_ID);
      expect(imported.claudeForkSessionOnNextSend).toBe(true);
      expect(imported.readOnly).toBeUndefined();
      expect(imported.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      // The scratch session's chat carries the title Claude Desktop gave it,
      // even though its transcript has no title record of its own.
      const scratchTabs = readImportedCoworkChats(
        userDataDir,
        scratchWorkspace.id,
      );
      expect(scratchTabs.map((tab) => tab.title)).toEqual([SCRATCH_TITLE]);
      expect(scratchTabs[0].sdkSessionId).toBe(SCRATCH_SESSION_ID);

      // The ledger recorded every project and the imported sessions.

      const ledger = JSON.parse(
        readFileSync(
          path.join(userDataDir, 'external-project-imports.json'),
          'utf8',
        ),
      );
      expect(ledger.version).toBe(1);
      expect(Object.keys(ledger.imports)).toHaveLength(3);
      expect(
        Object.values(ledger.imports).some(
          (entry) => entry.sessions[FOLDER_SESSION_ID] !== undefined,
        ),
      ).toBe(true);

      // A second scan recognizes every project instead of duplicating them,
      // and the names it shows are the ones the user now knows them by.
      await app.openSettings();
      await app.openSettingsSection('canopy');
      await window.getByTestId('settings-canopy-import-projects-open').click();
      const secondModal = window.getByTestId('import-projects-modal');
      await expect(
        secondModal.getByTestId('import-projects-empty'),
      ).toBeVisible({ timeout: 30_000 });
      const secondList = secondModal.getByTestId('import-projects-list');
      await expect(secondList).toHaveAttribute('data-row-count', '3');
      await expect(
        secondList.locator('[data-status="already-imported"]'),
      ).toHaveCount(3);
      await expect(
        secondList.getByTestId(`import-projects-row-name-${scratchId}`),
      ).toHaveText(SCRATCH_TITLE);
      await expect(
        secondModal.getByTestId('import-projects-submit'),
      ).toHaveCount(0);
      await secondModal.getByTestId('import-projects-done').click();
      await expect(secondModal).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
      fixture.cleanup();
    }
  });

  test('summarizes the scanned chat titles into the user memory profile and refreshes it on a rescan', async () => {
    // Two scans, each followed by a queued helper run against the mock LLM.
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-import-profile-e2e-'),
    );
    const marker = 'Canopy-CCAN3079-PROFILE';
    const profileTitle = `Ryan: prep slides for the Unstoppable Domains all-hands [${marker}]`;
    // Every title id the two scans can produce is cited: Claude Code chats are
    // ordered by file mtime, so which title is T1 is not fixed, and a fact is
    // only kept when a cited title supports it. T5 exists after the rescan;
    // before it the unknown id is ignored.
    const titleIds = ['T1', 'T2', 'T3', 'T4', 'T5'];
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        helperStepsById: {
          'local-memory-chat-profile': {
            text: JSON.stringify({
              facts: [
                { category: 'name', text: 'Ryan', evidence: titleIds },
                {
                  category: 'company',
                  text: 'Unstoppable Domains',
                  evidence: titleIds,
                },
                {
                  category: 'frequent-task',
                  text: 'Prepares all-hands slides and meeting notes',
                  evidence: titleIds,
                },
                // Cites an entry that does not exist, so it is dropped.
                { category: 'tool', text: 'Kubernetes', evidence: ['T42'] },
              ],
            }),
            stopReason: 'end_turn',
          },
        },
      },
    });
    const fixture = seedExternalProjectImportFixture({
      userDataDir,
      scratchSessions: [
        {
          id: SCRATCH_SESSION_ID,
          title: profileTitle,
          prompt: 'Help me prep the all-hands slides',
          lastActivityAt: '2026-09-15T09:00:00.000Z',
        },
      ],
    });
    // A name or company is only kept when two chat titles write it.
    writeImportFixtureTranscript(
      fixture.claudeDir,
      fixture.notes,
      'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      "Ryan's weekly Unstoppable Domains status notes",
      'Draft my weekly status notes',
      '2026-09-02T10:00:00.000Z',
    );
    const memoryDir = path.join(userDataDir, 'memory');
    const topicPath = path.join(memoryDir, 'topics', 'chat-history-profile.md');
    const readTopic = () =>
      existsSync(topicPath) ? readFileSync(topicPath, 'utf8') : '';
    const profileIndexLines = () =>
      readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('topics/chat-history-profile.md'));
    const launch = await launchCanopy({ userDataDir, env: fixture.env });
    try {
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await app.openSettings();
      await app.openSettingsSection('canopy');
      await window.getByTestId('settings-canopy-import-projects-open').click();
      const modal = window.getByTestId('import-projects-modal');
      const list = modal.getByTestId('import-projects-list');
      await expect(list).toHaveAttribute('data-row-count', '3', {
        timeout: 30_000,
      });

      // The scan alone saves the profile: nothing has been imported.
      await expect
        .poll(readTopic, { timeout: 90_000 })
        .toContain('from 4 chats across 3 projects');
      const topic = readTopic();
      expect(topic).toContain('- Name: Ryan');
      expect(topic).toContain('- Company: Unstoppable Domains');
      expect(topic).toContain(
        '- Prepares all-hands slides and meeting notes (4 chats)',
      );
      expect(topic).not.toContain('Kubernetes');
      expect(profileIndexLines()).toHaveLength(1);
      expect(profileIndexLines()[0]).toContain(
        'Name: Ryan. Company: Unstoppable Domains.',
      );

      // A new chat, then Scan again: the profile is rewritten, not repeated.
      writeImportFixtureTranscript(
        fixture.claudeDir,
        fixture.gitApp,
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        'Login bug follow-up',
        'Check the login fix in staging',
        '2026-09-20T10:00:00.000Z',
      );
      await modal.getByTestId('import-projects-rescan').click();
      await expect(list).toHaveAttribute('data-row-count', '3', {
        timeout: 30_000,
      });
      await expect
        .poll(readTopic, { timeout: 90_000 })
        .toContain('from 5 chats across 3 projects');
      expect(readTopic()).toContain('- Name: Ryan');
      expect(readTopic()).toContain('- Company: Unstoppable Domains');
      expect(profileIndexLines()).toHaveLength(1);

      await modal.getByTestId('import-projects-skip').click();
      await expect(modal).toHaveCount(0);

      // The profile shows up with the rest of the user's memory.
      await app.openSettingsSection('memory');
      const memories = window.getByTestId('memory-explorer-user');
      await memories
        .locator(memoryRowSelector('topics/chat-history-profile.md'))
        .getByTestId('memory-row-open')
        .click({ timeout: 30_000 });
      await expect(memories.getByTestId('memory-detail-body')).toContainText(
        'Unstoppable Domains',
      );

      const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
      const workspaceIds = existsSync(indexPath)
        ? JSON.parse(readFileSync(indexPath, 'utf8')).workspaces.map(
            (entry) => entry.id,
          )
        : [];
      expect(workspaceIds).not.toContain(GIT_PROJECT);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
      fixture.cleanup();
    }
  });

  test('offers a folder picker and a way out when no provider store exists', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-import-empty-e2e-'),
    );
    const launch = await launchCanopy({ userDataDir });
    try {
      const window = await launch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('canopy');
      await window.getByTestId('settings-canopy-import-projects-open').click();
      const modal = window.getByTestId('import-projects-modal');
      await expect(modal.getByTestId('import-projects-empty')).toBeVisible({
        timeout: 30_000,
      });
      await expect(modal.getByTestId('import-projects-empty')).toContainText(
        /No Claude or Codex (?:data|projects) found/,
      );
      await expect(
        modal.getByTestId('import-projects-pick-folder'),
      ).toBeVisible();
      await modal.getByTestId('import-projects-skip').click();
      await expect(modal).toHaveCount(0);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });
});
