import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';
import { memoryRowSelector } from './memoryRows.mjs';

function memoryRow(panel, fileKey) {
  return panel.locator(memoryRowSelector(fileKey));
}

/** Opens a memory's detail view from its row. */
async function openMemory(panel, fileKey) {
  await memoryRow(panel, fileKey).getByTestId('memory-row-open').click();
  await expect(panel.getByTestId('memory-detail')).toBeVisible();
}

/** Opens the editor of the memory whose detail view is showing. */
async function editMemory(panel) {
  await panel.getByTestId('memory-detail-edit').click();
  await expect(panel.getByTestId('memory-item-editor')).toBeVisible();
}

async function backToMemories(panel) {
  await panel.getByTestId('memory-detail-back').click();
  await expect(panel.getByTestId('memory-detail')).toHaveCount(0);
}

/** Runs an item of the panel's "…" menu. */
async function runPanelAction(window, panel, name) {
  await panel.getByTestId('memory-panel-menu').click();
  await window.getByRole('menuitem', { name }).click();
}

async function openLocalMemorySettings(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.openSettings();
  await expect(window.getByTestId('settings-nav-memory')).toBeVisible();
  await app.openSettingsSection('memory');
  return window.getByTestId('local-memory-enabled-toggle');
}

test('local memory defaults on and persists an explicit opt-out across relaunch', async () => {
  const first = await launchCanopy();
  const { userDataDir } = first;

  try {
    const toggle = await openLocalMemorySettings(first.electronApp);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(() => {
        const persisted = JSON.parse(
          readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
        );
        return persisted.preferences?.localMemoryEnabled;
      })
      .toBe(false);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const second = await launchCanopy({ userDataDir });
  try {
    const toggle = await openLocalMemorySettings(second.electronApp);
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

for (const [label, summaryModelSetByUser, expectedModel, expectedChosen] of [
  ['untouched', undefined, 'gpt-6.1-sol', false],
  ['explicitly chosen', true, 'opus[1m]', true],
]) {
  test(`upgrading an ${label} Haiku 5.5 seed preserves memory model intent`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'memory-haiku-upgrade-'),
    );
    const preferencesPath = path.join(userDataDir, 'preferences.json');
    writeFileSync(
      preferencesPath,
      `${JSON.stringify({
        version: 1,
        preferences: { summaryModel: 'haiku', summaryModelSetByUser },
      })}\n`,
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await openLocalMemorySettings(electronApp);
      const window = await electronApp.firstWindow();
      await expect(window.getByTestId('local-memory-model')).toHaveAttribute(
        'data-value',
        expectedModel,
      );
      const preferences = JSON.parse(
        readFileSync(preferencesPath, 'utf8'),
      ).preferences;
      expect(preferences.localMemoryModelSetByUser).toBe(expectedChosen);
      expect(preferences.summaryModelSetByUser).toBe(
        summaryModelSetByUser === true,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('memory titles normalize closing hashes and edit as heading text', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-heading-titles-'),
  );
  const memoryDir = path.join(userDataDir, 'memory');
  mkdirSync(path.join(memoryDir, 'topics'), { recursive: true });
  // [file, heading, row title, editor title]
  const cases = [
    [
      'MEMORY.md',
      '# Personal preferences ##',
      'Personal preferences',
      'Personal preferences',
    ],
    ['topics/empty.md', '# #', 'empty.md', ''],
    [
      'topics/hashes.md',
      '# C# and issue #3005',
      'C# and issue #3005',
      'C# and issue #3005',
    ],
    ['topics/literal-hashes.md', '# Title ## ', 'Title ##', 'Title ## '],
    ['topics/literal-hash.md', '#  #', '#', ' #'],
  ];
  for (const [fileKey, heading] of cases) {
    writeFileSync(
      path.join(memoryDir, fileKey),
      `${heading}\n\n## Writing\n\nKeep this child memory.\n`,
    );
  }
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const panel = window.getByTestId('memory-explorer-user');
    for (const [fileKey, heading, rowTitle, editorTitle] of cases) {
      await expect(
        memoryRow(panel, fileKey).getByTestId('memory-row-title'),
      ).toHaveText(rowTitle);
      await openMemory(panel, fileKey);
      await expect(panel.getByTestId('memory-detail-body')).toContainText(
        'Keep this child memory.',
      );
      await editMemory(panel);
      await expect(panel.getByTestId('memory-item-title')).toHaveValue(
        editorTitle,
      );
      await expect(panel.getByTestId('memory-item-draft')).toHaveValue(
        '## Writing\n\nKeep this child memory.',
      );
      await panel.getByTestId('memory-item-cancel').click();
      await backToMemories(panel);
      expect(readFileSync(path.join(memoryDir, fileKey), 'utf8')).toContain(
        heading,
      );
    }
    await openMemory(panel, 'MEMORY.md');
    await editMemory(panel);
    await panel.getByTestId('memory-item-title').fill('');
    await expect(panel.getByText('Add a title.')).toBeVisible();
    await expect(panel.getByTestId('memory-item-save')).toBeDisabled();
    await panel.getByTestId('memory-item-title').fill('Updated C# preferences');
    await panel.getByTestId('memory-item-save').click();
    await expect(panel.getByTestId('memory-item-editor')).toHaveCount(0);
    await expect(panel.getByTestId('memory-detail-title')).toHaveText(
      'Updated C# preferences',
    );
    expect(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(
      '# Updated C# preferences\n\n## Writing\n\nKeep this child memory.\n',
    );
    await backToMemories(panel);
    await expect(
      memoryRow(panel, 'MEMORY.md').getByTestId('memory-row-title'),
    ).toHaveText('Updated C# preferences');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('user memories open as details with links, save edits and keep a draft through conflicts', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-explorer-e2e-'),
  );
  const memoryDir = path.join(userDataDir, 'memory');
  mkdirSync(path.join(memoryDir, 'topics'), { recursive: true });
  const file = path.join(memoryDir, 'MEMORY.md');
  writeFileSync(
    file,
    '# Personal preferences\n\n## Writing\n\n- Prefer short replies.\n  - Keep technical detail when needed.\n- Use plain words.\n```sh\nprintf preserved\n```\n\n## Tools\n\nUse TypeScript.\n\n[Travel preferences](topics/travel.md)\n',
  );
  const travel = path.join(memoryDir, 'topics', 'travel.md');
  writeFileSync(travel, '# Travel\n\nPrefer a window seat.\n');
  const workspaceMemory = path.join(
    userDataDir,
    'workspaces',
    'other-project',
    'memory',
  );
  mkdirSync(workspaceMemory, { recursive: true });
  writeFileSync(
    path.join(workspaceMemory, 'MEMORY.md'),
    '# Secret project knowledge\n',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const panel = window.getByTestId('memory-explorer-user');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('memory-row')).toHaveCount(2);
    await expect(panel).not.toContainText('Secret project knowledge');
    await expect(
      memoryRow(panel, 'topics/travel.md').getByTestId('memory-row-meta'),
    ).toHaveText('Everywhere');

    // A link to another memory opens it in place.
    const originalUrl = window.url();
    await openMemory(panel, 'MEMORY.md');
    await expect(panel.getByTestId('memory-detail-body')).toContainText(
      'Use TypeScript.',
    );
    await expect(panel.getByTestId('memory-detail-facts')).toContainText(
      'Every project',
    );
    await expect(panel.getByTestId('memory-detail-facts')).toContainText(
      'Index',
    );
    await expect(panel.getByTestId('memory-detail-delete')).toHaveCount(0);
    await panel.getByRole('link', { name: 'Travel preferences' }).click();
    await expect(panel.getByTestId('memory-detail-title')).toHaveText('Travel');
    expect(window.url()).toBe(originalUrl);

    // Edit the title and body; the keyboard saves.
    await editMemory(panel);
    await expect(panel.getByTestId('memory-item-title')).toHaveValue('Travel');
    await expect(panel.getByTestId('memory-item-draft')).toHaveValue(
      'Prefer a window seat.',
    );
    await panel.getByTestId('memory-item-title').fill('Travel and seats');
    await panel
      .getByTestId('memory-item-draft')
      .fill('Prefer a window seat on long flights.');
    await panel
      .getByTestId('memory-item-draft')
      .press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(panel.getByTestId('memory-item-editor')).toHaveCount(0);
    await expect(panel.getByTestId('memory-detail-title')).toHaveText(
      'Travel and seats',
    );
    expect(readFileSync(travel, 'utf8')).toBe(
      '# Travel and seats\n\nPrefer a window seat on long flights.\n',
    );

    // A file changed on disk while editing keeps the draft and says why.
    await editMemory(panel);
    await panel.getByTestId('memory-item-draft').fill('Prefer an aisle.');
    writeFileSync(travel, `${readFileSync(travel, 'utf8')}\nAn agent note.\n`);
    await panel.getByTestId('memory-item-save').click();
    await expect(panel.getByRole('alert')).toContainText(
      "Couldn't save because this memory changed.",
    );
    await expect(panel.getByTestId('memory-item-draft')).toHaveValue(
      'Prefer an aisle.',
    );
    expect(readFileSync(travel, 'utf8')).toContain('An agent note.');
    await panel.getByTestId('memory-item-cancel').click();
    await expect(panel.getByTestId('memory-detail-body')).toContainText(
      'An agent note.',
    );
    await backToMemories(panel);

    // Search covers titles and the line under them.
    await panel.getByTestId('memory-search').fill('travel');
    await expect(panel.getByTestId('memory-row')).toHaveCount(1);
    await panel.getByTestId('memory-search').fill('nothing like this');
    // The search text stays out of the message, which session replay records.
    await expect(panel.getByTestId('memory-empty-search')).toContainText(
      'No memories match your search.',
    );
    await panel.getByRole('button', { name: 'Clear search' }).first().click();
    await expect(panel.getByTestId('memory-row')).toHaveCount(2);

    const app = new CanopyAppDriver(window);
    await app.openSettingsSection('experiments');
    await expect(window.getByTestId('local-memory-settings')).toHaveCount(0);
    await expect(window.getByTestId('org-memory-settings')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a deleted memory comes back with Undo and is deleted when Settings closes', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'memory-delete-e2e-'));
  const memoryDir = path.join(userDataDir, 'memory');
  mkdirSync(path.join(memoryDir, 'topics'), { recursive: true });
  const seat = path.join(memoryDir, 'topics', 'seat.md');
  writeFileSync(seat, '# Window seat\n\nPrefer a window seat.\n');
  writeFileSync(
    path.join(memoryDir, 'topics', 'units.md'),
    '# Units\n\nUse metric units.\n',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const panel = window.getByTestId('memory-explorer-user');
    const row = memoryRow(panel, 'topics/seat.md');
    await row.getByTestId('memory-row-menu').click();
    await window.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    await expect(
      window.getByTestId('toast-stack-host').getByText('Deleted “Window seat”'),
    ).toBeVisible();
    await window
      .getByTestId('toast-action')
      .filter({ hasText: 'Undo' })
      .click();
    await expect(row).toBeVisible();
    expect(existsSync(seat)).toBe(true);

    await openMemory(panel, 'topics/seat.md');
    await panel.getByTestId('memory-detail-delete').click();
    await expect(row).toHaveCount(0);
    expect(existsSync(seat)).toBe(true);
    await new CanopyAppDriver(window).closeSettings();
    await expect.poll(() => existsSync(seat)).toBe(false);
    expect(existsSync(path.join(memoryDir, 'topics', 'units.md'))).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the explorer picks up notes written on disk and consolidates them on demand', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-watch-consolidate-e2e-'),
  );
  const memoryDir = path.join(userDataDir, 'memory');
  const inboxDir = path.join(memoryDir, 'inbox');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    path.join(memoryDir, 'MEMORY.md'),
    '# Personal preferences\n\n- Keep replies concise.\n',
  );
  const marker = 'Canopy-CCAN2764-EMPHASIZED-INDEX';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      helperStepsById: {
        'local-memory-consolidation': {
          text: JSON.stringify({
            memoryMd:
              '# Personal preferences\n\nMock consolidated memory.\n\n- **Topics/travel.md**\n- *TOPICS/travel.md*\n',
            topicFiles: [
              {
                filename: 'travel.md',
                content: '# Travel\n\nPrefer a window seat on long flights.\n',
              },
            ],
          }),
          stopReason: 'end_turn',
        },
      },
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const explorer = window.getByTestId('memory-explorer-user');
    await expect(explorer).toContainText('Keep replies concise.');
    await expect(
      explorer.getByTestId('memory-consolidation-status'),
    ).toHaveCount(0);

    // An agent (or the user) drops a note straight into inbox/ on disk. The
    // main-process watcher must surface it without the Refresh button.
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      path.join(inboxDir, '2026-09-10T10-00-00-000Z-window-seat.md'),
      '---\nsource:\n  provider: "claude"\n  chatId: "chat-1"\ncreated: "2026-09-10T10:00:00.000Z"\nmodified: "2026-09-10T10:00:00.000Z"\ntype: inbox\n---\n\n# Window seat\n\nPrefer a window seat on long flights.\n\n[Canopy-CCAN2764-EMPHASIZED-INDEX]\n',
    );
    await expect(
      explorer.locator(
        memoryRowSelector('inbox/2026-09-10T10-00-00-000Z-window-seat.md'),
      ),
    ).toBeVisible();
    const status = explorer.getByTestId('memory-consolidation-status');
    await expect(status).toContainText('1 note waiting to be consolidated');
    await expect(status).toHaveAttribute('data-state', 'pending');

    await status.getByTestId('memory-consolidate').click();
    await expect
      .poll(
        () =>
          existsSync(path.join(memoryDir, 'consolidation-state.json'))
            ? JSON.parse(
                readFileSync(
                  path.join(memoryDir, 'consolidation-state.json'),
                  'utf8',
                ),
              )
            : null,
        { timeout: 15_000 },
      )
      .toMatchObject({ lastResult: 'success' });
    await expect(status).toHaveCount(0, { timeout: 60_000 });
    await expect(explorer).toContainText('Mock consolidated memory.');
    expect(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toContain(
      'Mock consolidated memory.',
    );
    expect(
      readdirSync(inboxDir).filter((name) => name.endsWith('.md')),
    ).toEqual([]);
    expect(readdirSync(path.join(inboxDir, '.consolidated'))).toEqual([
      '2026-09-10T10-00-00-000Z-window-seat.md',
    ]);
    const state = JSON.parse(
      readFileSync(path.join(memoryDir, 'consolidation-state.json'), 'utf8'),
    );
    const consolidatedIndex = readFileSync(
      path.join(memoryDir, 'MEMORY.md'),
      'utf8',
    );
    expect(consolidatedIndex).toContain('**topics/travel.md**');
    expect(consolidatedIndex).toContain('*topics/travel.md*');
    expect(
      readFileSync(path.join(memoryDir, 'topics', 'travel.md'), 'utf8'),
    ).toContain('Prefer a window seat on long flights.');
    expect(state.lastResult).toBe('success');
    expect(typeof state.lastConsolidatedAt).toBe('string');

    // A second note shows the last successful run alongside the count.
    writeFileSync(
      path.join(inboxDir, '2026-09-10T11-00-00-000Z-aisle.md'),
      '---\ntype: inbox\n---\n\nNever an aisle seat.\n',
    );
    await expect(status).toContainText(
      /1 note waiting to be consolidated · Consolidated \d+s ago/,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('partial consolidation saves valid topics and keeps existing memory and source notes for retry', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-partial-e2e-'),
  );
  const memoryDir = path.join(userDataDir, 'memory');
  const inboxDir = path.join(memoryDir, 'inbox');
  const topicDir = path.join(memoryDir, 'topics');
  const marker = 'Canopy-CCAN2764-PARTIAL';
  // Seeded with an ID, so the first write's identity backfill leaves the
  // note byte-for-byte as it was.
  const source = `---\nid: "01K5ZQ8Q4F6X9M3N5P7R1T2V31"\ntype: inbox\n---\n\n[${marker}] Prefer a window seat and preserve the dietary preference.\n`;
  const existingTopic = '# Dietary preferences\n\nAvoid peanuts.\n';
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(topicDir, { recursive: true });
  writeFileSync(
    path.join(memoryDir, 'MEMORY.md'),
    '# Preferences\n\n[Diet](topics/diet.md)\n',
  );
  writeFileSync(path.join(topicDir, 'diet.md'), existingTopic);
  writeFileSync(path.join(inboxDir, 'preferences.md'), source);
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      helperStepsById: {
        'local-memory-consolidation': {
          text: JSON.stringify({
            memoryMd:
              '# Preferences\n\n[Travel](topics/travel.md)\n[Invalid](topics/../invalid.md)\n',
            topicFiles: [
              {
                filename: 'travel.md',
                content: '# Travel\n\nPrefer a window seat.\n',
              },
              {
                filename: '../invalid.md',
                content: '# Diet\n\nAvoid peanuts.\n',
              },
            ],
          }),
          stopReason: 'end_turn',
        },
      },
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const explorer = window.getByTestId('memory-explorer-user');
    const status = explorer.getByTestId('memory-consolidation-status');
    await expect(status).toContainText('1 note waiting to be consolidated');
    await status.getByTestId('memory-consolidate').click();
    await expect
      .poll(() => readdirSync(topicDir), { timeout: 60_000 })
      .toContain('travel.md');
    await expect(status).toContainText('Partial consolidation');
    expect(readFileSync(path.join(topicDir, 'travel.md'), 'utf8')).toContain(
      'Prefer a window seat.',
    );
    expect(readFileSync(path.join(topicDir, 'diet.md'), 'utf8')).toBe(
      existingTopic,
    );
    expect(readFileSync(path.join(inboxDir, 'preferences.md'), 'utf8')).toBe(
      source,
    );
    const index = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(index).toContain('topics/diet.md');
    expect(index).toContain('topics/travel.md');
    expect(index).not.toContain('../invalid.md');
    const state = JSON.parse(
      readFileSync(path.join(memoryDir, 'consolidation-state.json'), 'utf8'),
    );
    expect(state.lastResult).toBe('failed');
    expect(state.lastReason).toContain('Partial consolidation');
    expect(state.lastConsolidatedAt).toBeUndefined();
    await expect(status.getByTestId('memory-consolidate')).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rebuilds memories from archived notes with the memory model after confirmation', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-rebuild-e2e-'),
  );
  const memoryDir = path.join(userDataDir, 'memory');
  const archiveDir = path.join(memoryDir, 'inbox', '.consolidated');
  const topicDir = path.join(memoryDir, 'topics');
  const marker = 'Canopy-CCAN3529-REBUILD';
  const archivedNote = '2026-09-10T10-00-00-000Z-window-seat.md';
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(topicDir, { recursive: true });
  writeFileSync(
    path.join(memoryDir, 'MEMORY.md'),
    '# Preferences\n\n- [Stale](topics/stale.md)\n',
  );
  writeFileSync(path.join(topicDir, 'stale.md'), '# Stale\n\nOld fact.\n');
  writeFileSync(
    path.join(archiveDir, archivedNote),
    `---\ntype: inbox\n---\n\n[${marker}] Prefer a window seat.\n`,
  );
  writeFileSync(
    path.join(archiveDir, 'topic-retired.md'),
    '# Retired\n\nPruned for disuse.\n',
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      helperStepsById: {
        'local-memory-consolidation': {
          text: JSON.stringify({
            memoryMd:
              '# Preferences\n\nRebuilt from notes.\n\n- [Travel](topics/travel.md)\n',
            topicFiles: [
              {
                filename: 'travel.md',
                content: '# Travel\n\nPrefer a window seat.\n',
              },
            ],
          }),
          stopReason: 'end_turn',
        },
      },
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    await expect(window.getByTestId('local-memory-model')).toBeEnabled();
    const explorer = window.getByTestId('memory-explorer-user');
    await expect(explorer).toContainText('Stale');

    await runPanelAction(window, explorer, 'Rebuild memories…');
    const dialog = window.getByTestId('memory-rebuild-dialog');
    await expect(dialog).toContainText('Your memories are rebuilt');
    await window.getByTestId('memory-rebuild-confirm').click();
    await expect(dialog).toHaveCount(0);

    await expect
      .poll(
        () =>
          existsSync(path.join(memoryDir, 'consolidation-state.json'))
            ? JSON.parse(
                readFileSync(
                  path.join(memoryDir, 'consolidation-state.json'),
                  'utf8',
                ),
              ).lastResult
            : null,
        { timeout: 60_000 },
      )
      .toBe('success');
    await expect(explorer).toContainText('Rebuilt from notes.');
    expect(readdirSync(topicDir)).toEqual(['travel.md']);
    expect(readdirSync(archiveDir).sort()).toEqual(
      [archivedNote, 'topic-retired.md'].sort(),
    );
    const snapshotsDir = path.join(memoryDir, '.snapshots');
    const snapshots = readdirSync(snapshotsDir);
    expect(snapshots).toHaveLength(1);
    expect(
      readFileSync(path.join(snapshotsDir, snapshots[0], 'MEMORY.md'), 'utf8'),
    ).toBe('# Preferences\n\n- [Stale](topics/stale.md)\n');
    expect(
      readFileSync(
        path.join(snapshotsDir, snapshots[0], 'topics', 'stale.md'),
        'utf8',
      ),
    ).toBe('# Stale\n\nOld fact.\n');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an unavailable chosen memory model skips consolidation and rebuild with a reason and keeps the choice', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-unavailable-model-e2e-'),
  );
  const memoryDir = path.join(userDataDir, 'memory');
  const inboxDir = path.join(memoryDir, 'inbox');
  const archiveDir = path.join(inboxDir, '.consolidated');
  const topicDir = path.join(memoryDir, 'topics');
  const index = '# Preferences\n\n- [Diet](topics/diet.md)\n';
  const pendingNote =
    '---\nid: "01K5ZQ8Q4F6X9M3N5P7R1T2V32"\ntype: inbox\n---\n\nPrefer a window seat.\n';
  const unavailableModel = 'ollama-offline-memory-model';
  const unavailableMessage =
    "Memory consolidation was skipped: your memory model isn't available. Choose another memory model in settings, or try again once it's available.";
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(topicDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), index);
  writeFileSync(path.join(topicDir, 'diet.md'), '# Diet\n\nAvoid peanuts.\n');
  writeFileSync(path.join(inboxDir, 'preferences.md'), pendingNote);
  writeFileSync(
    path.join(archiveDir, 'archived.md'),
    '---\ntype: inbox\n---\n\nUse metric units.\n',
  );
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  writeFileSync(
    preferencesPath,
    `${JSON.stringify({
      version: 1,
      preferences: {
        localMemoryEnabled: true,
        localMemoryModel: unavailableModel,
        localMemoryModelSetByUser: true,
      },
    })}\n`,
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const explorer = window.getByTestId('memory-explorer-user');
    const status = explorer.getByTestId('memory-consolidation-status');
    await expect(status).toContainText('1 note waiting to be consolidated');

    await status.getByTestId('memory-consolidate').click();
    await expect(status).toContainText(unavailableMessage);
    const state = JSON.parse(
      readFileSync(path.join(memoryDir, 'consolidation-state.json'), 'utf8'),
    );
    expect(state.lastResult).toBe('skipped');
    expect(state.lastReason).toBe(unavailableMessage);

    await runPanelAction(window, explorer, 'Rebuild memories…');
    await window.getByTestId('memory-rebuild-confirm').click();
    await expect(status).toContainText(unavailableMessage);

    // Nothing was consolidated, rebuilt, or snapshotted by another model.
    expect(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(index);
    expect(readdirSync(topicDir)).toEqual(['diet.md']);
    expect(readFileSync(path.join(inboxDir, 'preferences.md'), 'utf8')).toBe(
      pendingNote,
    );
    expect(readdirSync(archiveDir)).toEqual(['archived.md']);
    expect(existsSync(path.join(memoryDir, '.snapshots'))).toBe(false);
    const persisted = JSON.parse(readFileSync(preferencesPath, 'utf8'));
    expect(persisted.preferences.localMemoryModel).toBe(unavailableModel);
    expect(persisted.preferences.localMemoryModelSetByUser).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const scenario of [
  {
    id: 'ALLREJECTED',
    title: 'all rejected topics remain retryable',
    output: {
      memoryMd: '# Preferences\n\n- Keep useful memories.\n',
      topicFiles: [
        {
          filename: '../invalid.md',
          content: '# Travel\n\nPrefer a window seat.\n',
        },
      ],
    },
    message: 'Partial consolidation',
    reason: 'Partial consolidation',
  },
  {
    id: 'UNUSABLE',
    title: 'unusable output keeps a friendly error',
    output: { memoryMd: '', topicFiles: [] },
    message: 'the model returned unusable output',
    reason: 'invalid-output',
  },
]) {
  test(`consolidation retains source notes when ${scenario.title}`, async () => {
    test.setTimeout(90_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'memory-rejected-e2e-'),
    );
    const memoryDir = path.join(userDataDir, 'memory');
    const inboxDir = path.join(memoryDir, 'inbox');
    const marker = `Canopy-CCAN2764-${scenario.id}`;
    const source = `---\nid: "01K5ZQ8Q4F6X9M3N5P7R1T2V33"\ntype: inbox\n---\n\n[${marker}] Prefer a window seat.\n`;
    const originalIndex = '# Preferences\n\n- Keep this original fact.\n';
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(path.join(memoryDir, 'MEMORY.md'), originalIndex);
    writeFileSync(path.join(inboxDir, 'preferences.md'), source);
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        helperStepsById: {
          'local-memory-consolidation': {
            text: JSON.stringify(scenario.output),
            stopReason: 'end_turn',
          },
        },
      },
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await openLocalMemorySettings(electronApp);
      const window = await electronApp.firstWindow();
      const status = window
        .getByTestId('memory-explorer-user')
        .getByTestId('memory-consolidation-status');
      await expect(status).toContainText('1 note waiting to be consolidated');
      await status.getByTestId('memory-consolidate').click();
      await expect(status).toContainText(scenario.message);
      await expect(status.getByTestId('memory-consolidate')).toBeEnabled();
      expect(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(
        originalIndex,
      );
      expect(readFileSync(path.join(inboxDir, 'preferences.md'), 'utf8')).toBe(
        source,
      );
      const state = JSON.parse(
        readFileSync(path.join(memoryDir, 'consolidation-state.json'), 'utf8'),
      );
      expect(state.lastResult).toBe('failed');
      expect(state.lastReason).toContain(scenario.reason);
      expect(state.lastConsolidatedAt).toBeUndefined();
      expect(state.lastInputHash).toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('editing a memory body preserves thematic breaks and the paragraphs around them', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-block-boundaries-'),
  );
  const memoryDir = path.join(userDataDir, 'memory', 'topics');
  mkdirSync(memoryDir, { recursive: true });
  const separators = ['***', '---', '___'];
  for (const [index, separator] of separators.entries()) {
    writeFileSync(
      path.join(memoryDir, `separator-${index}.md`),
      `- Preference to change\n${separator}\nKeep this separate paragraph.\n`,
    );
  }
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const panel = window.getByTestId('memory-explorer-user');
    for (const [index, separator] of separators.entries()) {
      await openMemory(panel, `topics/separator-${index}.md`);
      await editMemory(panel);
      const draft = panel.getByTestId('memory-item-draft');
      await expect(draft).toHaveValue(
        `- Preference to change\n${separator}\nKeep this separate paragraph.`,
      );
      await draft.fill(
        `- Updated preference\n${separator}\nKeep this separate paragraph.`,
      );
      await panel.getByTestId('memory-item-save').click();
      await expect(panel.getByTestId('memory-item-editor')).toHaveCount(0);
      expect(
        readFileSync(path.join(memoryDir, `separator-${index}.md`), 'utf8'),
      ).toBe(
        `- Updated preference\n${separator}\nKeep this separate paragraph.\n`,
      );
      await expect(panel.getByTestId('memory-detail-body')).toContainText(
        'Keep this separate paragraph.',
      );
      await backToMemories(panel);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('memory reading and editing uses disposable background workers', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'memory-worker-e2e-'));
  const memoryDir = path.join(userDataDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, 'MEMORY.md');
  writeFileSync(
    file,
    '- Original preference\n\n```text\n' +
      'x'.repeat(512 * 1024 - 36) +
      '\n```\n',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(async (_electron, memoryFile) => {
      const { createHook } = process.getBuiltinModule('node:async_hooks');
      const { readFileSync: readNow } = process.getBuiltinModule('node:fs');
      const observed = {
        started: 0,
        // Workers started while the file still held the original text: the
        // save's parse runs before its write, the read after Save after it.
        startedBeforeWrite: 0,
        progressed: 0,
        active: new Set(),
      };
      const hook = createHook({
        init(id, type) {
          if (type === 'WORKER') {
            observed.started += 1;
            if (readNow(memoryFile, 'utf8').includes('- Original preference'))
              observed.startedBeforeWrite += 1;
            observed.active.add(id);
            setImmediate(() => {
              if (observed.active.has(id)) observed.progressed += 1;
            });
          }
        },
        destroy(id) {
          observed.active.delete(id);
        },
      });
      hook.enable();
      globalThis.memoryWorkerObservation = { observed, hook };
    }, file);
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const panel = window.getByTestId('memory-explorer-user');
    await openMemory(panel, 'MEMORY.md');
    await expect(panel.getByTestId('memory-detail-body')).toContainText(
      'Original preference',
    );
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.memoryWorkerObservation.observed.started,
        ),
      )
      .toBeGreaterThan(0);
    await editMemory(panel);
    const draft = panel.getByTestId('memory-item-draft');
    const original = await draft.inputValue();
    await draft.fill(
      original.replace('- Original preference', '- Updated preference'),
    );
    const beforeSave = await electronApp.evaluate(
      () => globalThis.memoryWorkerObservation.observed.startedBeforeWrite,
    );
    await panel.getByTestId('memory-item-save').click();
    await expect(panel.getByTestId('memory-item-editor')).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).toContain('- Updated preference');
    // The save parsed its new text in a worker before writing the file.
    expect(
      await electronApp.evaluate(
        () => globalThis.memoryWorkerObservation.observed.startedBeforeWrite,
      ),
    ).toBeGreaterThan(beforeSave);
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.memoryWorkerObservation.observed.active.size,
        ),
      )
      .toBe(0);
    expect(
      await electronApp.evaluate(
        () => globalThis.memoryWorkerObservation.observed.progressed,
      ),
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await electronApp.evaluate(() =>
      globalThis.memoryWorkerObservation?.hook.disable(),
    );
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const [label, newline] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]) {
  test(`editing memory preserves Markdown indentation and hard breaks (${label})`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'memory-whitespace-e2e-'),
    );
    const memoryDir = path.join(userDataDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, 'MEMORY.md');
    const body =
      '    const x = 1;\n    const y = 2;  \n\nFirst line  \nSecond line  \n\n- Keep this memory';
    const content = `${body}\n`.replace(/\n/g, newline);
    writeFileSync(file, content);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await openLocalMemorySettings(electronApp);
      const window = await electronApp.firstWindow();
      const panel = window.getByTestId('memory-explorer-user');
      await openMemory(panel, 'MEMORY.md');
      // Saving without a change leaves the file as it was.
      await editMemory(panel);
      const draft = panel.getByTestId('memory-item-draft');
      await expect(draft).toHaveValue(body);
      await panel.getByTestId('memory-item-save').click();
      await expect(panel.getByTestId('memory-item-editor')).toHaveCount(0);
      expect(readFileSync(file, 'utf8')).toBe(content);
      await editMemory(panel);
      await draft.fill(body.replace('Keep this memory', 'Keep this one'));
      await panel.getByTestId('memory-item-save').click();
      await expect(panel.getByTestId('memory-item-editor')).toHaveCount(0);
      expect(readFileSync(file, 'utf8')).toBe(
        content.replace('Keep this memory', 'Keep this one'),
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const [label, prefix, newline] of [
  ['front matter', '﻿---\r\ncreated: today\r\n---\r\n', '\r\n'],
  ['a byte order mark', '﻿', '\n'],
]) {
  test(`editing memory preserves ${label} and adjacent content`, async () => {
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'memory-bom-e2e-'));
    const memoryDir = path.join(userDataDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, 'MEMORY.md');
    const content =
      prefix + '- First memory' + newline + '- Keep memory' + newline;
    writeFileSync(file, content);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await openLocalMemorySettings(electronApp);
      const window = await electronApp.firstWindow();
      const panel = window.getByTestId('memory-explorer-user');
      await openMemory(panel, 'MEMORY.md');
      await editMemory(panel);
      await panel
        .getByTestId('memory-item-draft')
        .fill('- Updated memory\n- Keep memory');
      await panel.getByTestId('memory-item-save').click();
      await expect(panel.getByTestId('memory-item-editor')).toHaveCount(0);
      expect(readFileSync(file, 'utf8')).toBe(
        content.replace('- First memory', '- Updated memory'),
      );
      await expect(panel.getByTestId('memory-detail-body')).toContainText(
        'Keep memory',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
