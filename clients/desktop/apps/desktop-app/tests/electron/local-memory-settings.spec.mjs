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

// Row actions live in a hover-revealed tray, so hover the row first.
async function clickMemoryAction(row, action) {
  await row.hover();
  await row.getByTestId(`memory-item-${action}`).click();
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
      await expect(window.getByTestId('local-memory-model')).toHaveValue(
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

test('loaded hoisted memory titles normalize closing hashes without changing editable headings', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-heading-titles-'),
  );
  const memoryDir = path.join(userDataDir, 'memory');
  mkdirSync(path.join(memoryDir, 'topics'), { recursive: true });
  const cases = [
    ['MEMORY.md', '# Personal preferences ##', 'Personal preferences'],
    ['topics/empty.md', '# #', 'empty.md'],
    ['topics/hashes.md', '# C# and issue #3005', 'C# and issue #3005'],
    ['topics/literal-hashes.md', '# Title ##\u00a0', 'Title ##'],
    ['topics/literal-hash.md', '# \u00a0#', '#'],
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
    const explorer = window.getByTestId('memory-explorer-user');
    for (const [fileKey, heading, title] of cases) {
      const row = explorer.locator(
        `[data-testid="memory-file"][data-file-key="${fileKey}"]`,
      );
      const section = row.locator('..');
      if (!(await section.evaluate((element) => element.open)))
        await row.click();
      await expect(row.getByTestId('memory-item-edit')).toHaveAttribute(
        'aria-label',
        'Edit title',
      );
      await expect(row.getByTestId('memory-row-title')).toHaveText(title);
      await expect(section.getByTestId('memory-heading')).toHaveCount(1);
      await expect(section).toContainText('Keep this child memory.');
      await clickMemoryAction(row, 'edit');
      await expect(explorer.getByTestId('memory-item-draft')).toHaveValue(
        heading,
      );
      await explorer.getByTestId('memory-item-cancel').click();
      expect(readFileSync(path.join(memoryDir, fileKey), 'utf8')).toContain(
        heading,
      );
    }
    const row = explorer.locator(
      '[data-testid="memory-file"][data-file-key="MEMORY.md"]',
    );
    for (const [heading, title] of [
      ['# Updated C# preferences ##', 'Updated C# preferences'],
      ['# Updated ##\u00a0', 'Updated ##'],
      ['# #', 'MEMORY.md'],
    ]) {
      await clickMemoryAction(row, 'edit');
      await explorer.getByTestId('memory-item-draft').fill(heading);
      await explorer.getByTestId('memory-item-save').click();
      await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
      await expect(row.getByTestId('memory-row-title')).toHaveText(title);
      expect(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(
        `${heading}\n\n## Writing\n\nKeep this child memory.\n`,
      );
    }
    await window.reload();
    await openLocalMemorySettings(electronApp);
    await expect(
      explorer
        .locator('[data-file-key="MEMORY.md"]')
        .getByTestId('memory-row-title'),
    ).toHaveText('MEMORY.md');
    await expect(explorer.getByTestId('memory-items')).toContainText(
      'Keep this child memory.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('user memories show parsed items and preserve other notes through edit, delete, and conflicts', async () => {
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
  writeFileSync(
    path.join(memoryDir, 'topics', 'travel.md'),
    '# Travel\n\nPrefer a window seat.\n',
  );
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
    const explorer = window.getByTestId('memory-explorer-user');
    await expect(explorer).toBeVisible();
    await expect(explorer.getByTestId('memory-file')).toHaveCount(2);
    await expect(
      explorer.locator('summary').filter({ hasText: /^Writing$/ }),
    ).toBeVisible();
    await expect(explorer).not.toContainText('Secret project knowledge');
    const originalUrl = window.url();
    await explorer.getByRole('link', { name: 'Travel preferences' }).click();
    await expect(explorer.getByTestId('memory-items')).toContainText(
      'Prefer a window seat.',
    );
    expect(window.url()).toBe(originalUrl);
    // Row titles live in their own span: the summary's action tray swaps to
    // an inline delete confirm, so match the title rather than the row text.
    const summaryTitled = (title) =>
      explorer.locator('summary').filter({
        has: window.getByTestId('memory-row-title').filter({ hasText: title }),
      });
    const writing = summaryTitled(/^Writing$/);
    const writingSection = writing.locator('..');
    const personal = summaryTitled(/^Personal preferences$/);
    for (const mode of ['edit', 'delete']) {
      if (await writingSection.evaluate((element) => element.open))
        await writing.click();
      await clickMemoryAction(writing, mode);
      await expect(explorer.getByTestId('memory-item-editor')).toBeVisible();
      await writing.click();
      await expect(explorer.getByTestId('memory-item-editor')).toBeVisible();
      await personal.click();
      await expect(explorer.getByTestId('memory-item-editor')).toBeVisible();
      await explorer.getByTestId('memory-item-cancel').click();
      await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
      await expect(explorer.getByTestId('memory-file').first()).toBeEnabled();
    }
    // Expanded-first: row actions sit inside <summary>, and Chromium does not
    // toggle the <details> when the click target is a button inside it, so an
    // open heading (or the hoisted file row) must stay open through
    // edit/delete. This is the native behaviour the outline relies on.
    if (!(await writingSection.evaluate((element) => element.open)))
      await writing.click();
    const personalSection = personal.locator('..');
    for (const mode of ['edit', 'delete']) {
      await expect(writingSection).toHaveJSProperty('open', true);
      await clickMemoryAction(writing, mode);
      await expect(explorer.getByTestId('memory-item-editor')).toBeVisible();
      await expect(writingSection).toHaveJSProperty('open', true);
      await explorer.getByTestId('memory-item-cancel').click();
      await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
      await expect(writingSection).toHaveJSProperty('open', true);
    }
    await expect(personalSection).toHaveJSProperty('open', true);
    await personal.hover();
    await personal.getByRole('button', { name: 'Edit title' }).click();
    await expect(explorer.getByTestId('memory-item-editor')).toBeVisible();
    await expect(explorer.getByTestId('memory-item-draft')).toHaveValue(
      '# Personal preferences',
    );
    await expect(personalSection).toHaveJSProperty('open', true);
    await explorer.getByTestId('memory-item-cancel').click();
    await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
    await expect(personalSection).toHaveJSProperty('open', true);
    const note = explorer
      .getByTestId('memory-item')
      .filter({ hasText: 'Prefer short replies.' });
    await clickMemoryAction(note, 'edit');
    await explorer
      .getByTestId('memory-item-draft')
      .fill(
        '- Prefer concise replies.\n  - Keep technical detail when needed.',
      );
    await explorer.getByTestId('memory-item-save').click();
    await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
    await expect(explorer).toContainText('Prefer concise replies.');
    expect(readFileSync(file, 'utf8')).toContain('- Use plain words.');
    expect(readFileSync(file, 'utf8')).toContain(
      '  - Keep technical detail when needed.',
    );
    await clickMemoryAction(
      explorer
        .getByTestId('memory-item')
        .filter({ hasText: 'Use plain words.' }),
      'delete',
    );
    await explorer.getByTestId('memory-item-save').click();
    await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).not.toContain('Use plain words.');
    expect(readFileSync(file, 'utf8')).toContain(
      '```sh\nprintf preserved\n```',
    );
    expect(readFileSync(file, 'utf8')).toContain('Use TypeScript.');
    await clickMemoryAction(
      explorer
        .getByTestId('memory-item')
        .filter({ hasText: 'Use TypeScript.' }),
      'edit',
    );
    await explorer.getByTestId('memory-item-draft').fill('Use Rust.');
    writeFileSync(
      file,
      readFileSync(file, 'utf8') + '\nAn agent added this note.\n',
    );
    await explorer.getByTestId('memory-item-save').click();
    await expect(explorer.getByRole('alert')).toContainText(
      "Couldn't save this memory because the file changed.",
    );
    await expect(explorer.getByTestId('memory-item-draft')).toHaveValue(
      'Use Rust.',
    );
    expect(readFileSync(file, 'utf8')).toContain('An agent added this note.');
    expect(readFileSync(file, 'utf8')).toContain('Use TypeScript.');
    await explorer.getByTestId('memory-item-cancel').click();
    await explorer.getByTestId('memory-refresh').click();
    await expect(explorer).toContainText('An agent added this note.');
    await explorer.getByTestId('memory-search').fill('TypeScript');
    await expect(explorer.getByTestId('memory-items')).toContainText(
      'Use TypeScript.',
    );
    await expect(explorer.getByTestId('memory-items')).not.toContainText(
      'Prefer concise replies.',
    );
    const app = new CanopyAppDriver(window);
    await app.openSettingsSection('experiments');
    await expect(window.getByTestId('local-memory-settings')).toHaveCount(0);
    await expect(window.getByTestId('org-memory-settings')).toHaveCount(0);
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
        '[data-file-key="inbox/2026-09-10T10-00-00-000Z-window-seat.md"]',
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
  const source = `---\ntype: inbox\n---\n\n[${marker}] Prefer a window seat and preserve the dietary preference.\n`;
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

    await explorer.getByTestId('memory-rebuild').click();
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
    await expect(explorer.getByTestId('memory-rebuild')).toBeEnabled();
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
  const pendingNote = '---\ntype: inbox\n---\n\nPrefer a window seat.\n';
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

    await explorer.getByTestId('memory-rebuild').click();
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
    const source = `---\ntype: inbox\n---\n\n[${marker}] Prefer a window seat.\n`;
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

test('editing and deleting a memory list item preserves adjacent thematic breaks and paragraphs', async () => {
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
    const explorer = window.getByTestId('memory-explorer-user');
    for (const [index, separator] of separators.entries()) {
      const fileRow = explorer.locator(
        `[data-file-key="topics/separator-${index}.md"]`,
      );
      if (!(await fileRow.locator('..').evaluate((element) => element.open)))
        await fileRow.click();
      await clickMemoryAction(
        explorer
          .getByTestId('memory-item')
          .filter({ hasText: 'Preference to change' }),
        'edit',
      );
      await explorer
        .getByTestId('memory-item-draft')
        .fill('- Updated preference');
      await explorer.getByTestId('memory-item-save').click();
      await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
      const file = path.join(memoryDir, `separator-${index}.md`);
      expect(readFileSync(file, 'utf8')).toBe(
        `- Updated preference\n${separator}\nKeep this separate paragraph.\n`,
      );
      await clickMemoryAction(
        explorer
          .getByTestId('memory-item')
          .filter({ hasText: 'Updated preference' }),
        'delete',
      );
      await explorer.getByTestId('memory-item-save').click();
      await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
      expect(readFileSync(file, 'utf8')).toBe(
        `\n${separator}\nKeep this separate paragraph.\n`,
      );
      await expect(explorer.getByTestId('memory-items')).toContainText(
        'Keep this separate paragraph.',
      );
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
    await electronApp.evaluate(async () => {
      const { createHook } = process.getBuiltinModule('node:async_hooks');
      const observed = { started: 0, progressed: 0, active: new Set() };
      const hook = createHook({
        init(id, type) {
          if (type === 'WORKER') {
            observed.started += 1;
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
    });
    await openLocalMemorySettings(electronApp);
    const window = await electronApp.firstWindow();
    const explorer = window.getByTestId('memory-explorer-user');
    const item = explorer
      .getByTestId('memory-item')
      .filter({ hasText: 'Original preference' });
    await expect(item).toBeVisible();
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.memoryWorkerObservation.observed.started,
        ),
      )
      .toBeGreaterThan(0);
    await clickMemoryAction(item, 'edit');
    await explorer
      .getByTestId('memory-item-draft')
      .fill('- Updated preference');
    await explorer.getByTestId('memory-item-save').click();
    await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
    expect(readFileSync(file, 'utf8')).toContain('- Updated preference');
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.memoryWorkerObservation.observed.started,
        ),
      )
      .toBeGreaterThanOrEqual(3);
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
    ).toBeGreaterThanOrEqual(3);
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
  test(`saving unchanged memory preserves Markdown indentation and hard breaks (${label})`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'memory-whitespace-e2e-'),
    );
    const memoryDir = path.join(userDataDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const file = path.join(memoryDir, 'MEMORY.md');
    const content =
      '    const x = 1;\n    const y = 2;  \n\nFirst line  \nSecond line  \n\n- Keep this memory\n'.replace(
        /\n/g,
        newline,
      );
    writeFileSync(file, content);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await openLocalMemorySettings(electronApp);
      const window = await electronApp.firstWindow();
      const explorer = window.getByTestId('memory-explorer-user');
      for (const text of ['const x = 1;', 'First line']) {
        const item = explorer
          .getByTestId('memory-item')
          .filter({ hasText: text });
        await clickMemoryAction(item, 'edit');
        const draft = explorer.getByTestId('memory-item-draft');
        if (text === 'const x = 1;') {
          await expect(draft).toHaveValue(
            '    const x = 1;\n    const y = 2;  ',
          );
        } else {
          await expect(draft).toHaveValue('First line  \nSecond line  ');
        }
        await explorer.getByTestId('memory-item-save').click();
        await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
        expect(readFileSync(file, 'utf8')).toBe(content);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const [operation, prefix, newline] of [
  ['edit', '\uFEFF---\r\ncreated: today\r\n---\r\n', '\r\n'],
  ['delete', '\uFEFF', '\n'],
]) {
  test(`memory ${operation} preserves BOM and adjacent content`, async () => {
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
      const explorer = window.getByTestId('memory-explorer-user');
      const item = explorer
        .getByTestId('memory-item')
        .filter({ hasText: 'First memor' })
        .last();
      await clickMemoryAction(item, operation);
      if (operation === 'edit')
        await explorer
          .getByTestId('memory-item-draft')
          .fill('- Updated memory');
      await explorer.getByTestId('memory-item-save').click();
      await expect(explorer.getByTestId('memory-item-editor')).toHaveCount(0);
      expect(readFileSync(file, 'utf8')).toBe(
        content.replace(
          '- First memory',
          operation === 'edit' ? '- Updated memory' : '',
        ),
      );
      await expect(explorer.getByTestId('memory-items')).toContainText(
        'Keep memory',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
