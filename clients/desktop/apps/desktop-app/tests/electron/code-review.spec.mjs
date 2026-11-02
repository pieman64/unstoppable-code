import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedCodeReviewState,
  writeJson,
} from './seeders/index.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getActiveGroupId, getLayout } from './panelHarness.mjs';

// The takeover's resize/search/chat controls were retired. Its surviving
// annotation, comment, refresh and label contracts are exercised in file and
// Change Diagram panels here, through real Git/IPC and the local mock provider.
const scope = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
const marker = 'CANOPY review panel selected addition';
const conversation = 'Canopy-CREVIEWPANELS';

function fixture() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-review-panels-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0].worktreePath;
  const filePath = path.join(worktreePath, 'README.md');
  const original = readFileSync(filePath, 'utf8');
  writeFileSync(
    filePath,
    original.replace(/^.*\n/, '# Updated heading\n') + `\n${marker}\n`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: scope.projectId,
    worktreeId: scope.worktreeId,
    activeTabId: 'regular-chat',
    tabs: [
      {
        id: 'regular-chat',
        title: 'Implementation',
        providerType: 'claude',
        messages: [],
      },
    ],
  });
  return { userDataDir, worktreePath, filePath, original };
}
async function selectWorktree(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(scope.worktreeId);
  const changed = window.getByTestId('changed-files-section');
  await expect(changed).toContainText('README.md', { timeout: 20_000 });
  return { window, changed };
}
async function selectDiffLine(window, pane, text) {
  const line = pane.locator('.view-line').filter({ hasText: text }).first();
  await expect(async () => {
    const box = await line.boundingBox();
    expect(box).toBeTruthy();
    await window.mouse.move(box.x + 8, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(
      box.x + Math.min(box.width - 4, 180),
      box.y + box.height / 2,
      { steps: 8 },
    );
    await window.mouse.up();
    await expect(window.getByTestId('file-selection-menu')).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 15_000 });
  await window.getByTestId('file-selection-comment').click();
}

test('file drawer combines both origins while gutters remain view-specific and submission uses ordinary chat', async () => {
  const { userDataDir, filePath, original } = fixture();
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      scope.projectId,
      'worktree-data',
      scope.worktreeId,
      'file-annotations.json',
    ),
    {
      version: 1,
      files: [
        {
          filePath,
          annotations: [],
          commentThreads: [
            {
              id: 'raw-thread',
              status: 'open',
              createdAt: '2026-09-17',
              anchorState: 'matched',
              anchor: { source: 'code', filePath, quote: '', unanchored: true },
              comments: [
                {
                  id: 'raw-comment',
                  author: 'user',
                  body: 'Only in file view',
                  createdAt: '2026-09-17',
                  staged: false,
                },
              ],
            },
          ],
        },
      ],
    },
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, conversation, {
    llm: {
      steps: [
        {
          text: 'I will review the selected comparison.',
          stopReason: 'end_turn',
        },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    await changed
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'README.md' })
      .click();
    const panel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    const diff = panel.getByTestId('file-panel-diff');
    await expect(diff).toContainText(marker, { timeout: 20_000 });
    await expect(panel.getByTestId('file-comments-drawer')).toContainText(
      'Only in file view',
    );
    const toggle = panel.locator(
      '[data-testid="file-viewer-view-diff"]:visible',
    );
    await expect(
      toggle.getByLabel('1 open comments in file view'),
    ).toBeVisible();
    await selectDiffLine(window, diff.locator('.modified'), marker);
    await window
      .getByTestId('review-comment-composer')
      .locator('textarea')
      .fill(`[${conversation}] Explain the new lines.`);
    await window.getByTestId('review-comment-submit-draft').click();
    await expect(panel.getByTestId('file-comments-drawer')).toContainText(
      'Explain the new lines.',
    );
    await diff.getByRole('button', { name: 'Split', exact: true }).click();
    await selectDiffLine(
      window,
      diff.locator('.original'),
      original.split('\n')[0],
    );
    await window
      .getByTestId('review-comment-composer')
      .locator('textarea')
      .fill(`[${conversation}] Keep the old heading.`);
    await window.getByTestId('review-comment-submit-draft').click();
    await expect(panel.getByTestId('file-comments-submit')).toHaveText(
      'Submit 2 comments',
    );
    // Drafts render optimistically; wait for the asynchronous save before
    // asserting the persisted side-aware anchors.
    await expect(async () => {
      const document = await window.evaluate(
        (args) => window.api.fileAnnotations.get(args),
        { ...scope, filePath },
      );
      const diffThreads = document.commentThreads.filter(
        (thread) => thread.anchor.view === 'diff',
      );
      expect(diffThreads.map((thread) => thread.anchor.side).sort()).toEqual([
        'new',
        'old',
      ]);
      expect(
        diffThreads.every(
          (thread) => thread.anchor.diff?.snapshotId.length === 64,
        ),
      ).toBe(true);
    }).toPass({ timeout: 10_000 });
    await toggle.click();
    await expect(panel.getByTestId('file-comments-drawer')).toContainText(
      'Only in file view',
    );
    await expect(panel.getByTestId('file-comments-drawer')).toContainText(
      'Explain the new lines.',
    );
    await expect(
      toggle.getByLabel('2 open comments in diff view'),
    ).toBeVisible();
    const diffBadges = panel.getByTestId('file-comment-diff-badge');
    await expect(diffBadges).toHaveCount(2);
    await expect(diffBadges.first().locator('svg')).toBeVisible();
    await expect(diffBadges.first()).toHaveText('');
    await diffBadges.first().hover();
    await expect(
      window.getByRole('tooltip', { name: 'Comment from diff view' }),
    ).toBeVisible();
    await diffBadges.first().focus();
    await expect(diffBadges.first()).toBeFocused();
    await panel
      .locator('[data-testid^="file-comment-thread-"]')
      .filter({ hasText: 'Explain the new lines.' })
      .getByRole('button', { name: /Reveal .* in diff/ })
      .click();
    await expect(diff).toBeVisible();
    await expect(panel.getByTestId('file-comments-submit')).toHaveText(
      'Submit 2 comments',
    );
    await panel.getByTestId('file-comments-submit').click();
    const chat = window.locator('[data-testid="panel-content-chat"]:visible');
    await expect(chat).toContainText('Diff comment thread', {
      timeout: 20_000,
    });
    await expect(chat).toContainText('side old');
    await expect(chat).toContainText('uncommitted');
    await expect(window.getByTestId('code-review-modal')).toHaveCount(0);
    expect(
      existsSync(
        path.join(
          userDataDir,
          'app-workspaces',
          'code-review-chat',
          'chats',
          'registry.json',
        ),
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Change Diagram opens from Changed Files, deduplicates, and acknowledges a fresh no-op refresh', async () => {
  const { userDataDir } = fixture();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    await window.getByTestId('panel-add-tab-group-chat').click();
    await expect(
      window
        .getByTestId('panel-add-menu-item-change-diagram')
        .locator('svg[data-glyph="network"]'),
    ).toHaveCount(1);
    await window.keyboard.press('Escape');
    const { fingerprint } = await window.evaluate(
      (scope) => window.api.codeReview.get(scope),
      scope,
    );
    seedCodeReviewState({
      userDataDir,
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      armed: true,
      derivedFromFingerprint: fingerprint,
      annotations: [],
      diagrams: {
        logicDiff: {
          data: {
            schemaVersion: 1,
            current: { nodes: [{ id: 'read', label: 'Read file' }], edges: [] },
            planned: { nodes: [{ id: 'read', label: 'Read file' }], edges: [] },
            changes: [],
          },
          derivedFromFingerprint: fingerprint,
          status: 'ready',
        },
        dataModelDiff: {
          data: {
            schemaVersion: 1,
            current: { entities: [], relationships: [] },
            planned: {
              entities: [{ id: 'user', name: 'User', fields: [] }],
              relationships: [],
            },
            changes: [],
          },
          derivedFromFingerprint: fingerprint,
          status: 'ready',
        },
      },
    });
    await expect(
      changed
        .getByTestId('view-change-diagram-button')
        .locator('svg[data-glyph="network"]'),
    ).toHaveCount(1);
    await changed.getByTestId('view-change-diagram-button').click();
    const diagram = window.getByTestId('change-diagram-panel');
    await expect(diagram).toBeVisible();
    // Searched through the shared find bar (CAN-4367), not an inline field.
    await expect(
      diagram.getByRole('textbox', { name: 'Search diagram' }),
    ).toHaveCount(0);
    await diagram.getByText('Read file', { exact: true }).first().click();
    await window.keyboard.press('ControlOrMeta+f');
    const findBar = window.getByTestId('surface-find-bar');
    const findInput = findBar.getByRole('textbox');
    await expect(findBar).toHaveAttribute('data-find-mode', 'diagram');
    await expect(findInput).toHaveAttribute(
      'placeholder',
      'Search the diagram.',
    );
    await findInput.fill('Read');
    await expect(findBar).toContainText('1 of 1');
    // Another diagram re-runs the open query against it.
    await diagram.getByRole('tab', { name: 'Data model', exact: true }).click();
    await expect(findBar).toContainText('0 of 0');
    await findInput.press('Escape');
    await expect(findBar).toHaveCount(0);
    await expect(
      window
        .locator('[data-testid^="panel-tab-"]')
        .filter({ hasText: 'Change Diagram' })
        .locator('svg[data-glyph="network"]'),
    ).toHaveCount(1);
    await diagram.getByTestId('change-diagram-refresh').click();
    await expect(diagram.getByRole('status')).toHaveText(
      'Review is up to date.',
    );
    await expect(diagram.getByRole('status')).toHaveCount(0, {
      timeout: 3_000,
    });
    await expect(diagram.getByTestId('change-diagram-refresh')).toBeEnabled();
    await changed.getByTestId('view-change-diagram-button').click();
    await expect(window.getByTestId('change-diagram-panel')).toHaveCount(1);

    // Reopening the diagram while another group is maximized exits that
    // maximize and activates the diagram instead of selecting it out of view.
    const diagramGroupId = collectLeaves((await getLayout(window)).root).find(
      (leaf) => leaf.panels.some((panel) => panel.kind === 'change-diagram'),
    )?.groupId;
    const changedFilesGroupId = await changed.evaluate(
      (element) =>
        element.closest('[data-group-id]')?.getAttribute('data-group-id') ??
        null,
    );
    expect(diagramGroupId).toBeTruthy();
    expect(changedFilesGroupId).toBeTruthy();
    expect(changedFilesGroupId).not.toBe(diagramGroupId);
    await window.getByTestId(`panel-group-menu-${changedFilesGroupId}`).click();
    await window
      .getByTestId(`panel-group-maximize-${changedFilesGroupId}`)
      .click();
    const restoreChangedFilesGroup = window.getByTestId(
      `panel-group-restore-${changedFilesGroupId}`,
    );
    await expect(restoreChangedFilesGroup).toBeVisible();
    await expect(window.getByTestId('change-diagram-panel')).toBeHidden();
    await changed.getByTestId('view-change-diagram-button').click();
    await expect(restoreChangedFilesGroup).toHaveCount(0);
    await expect(window.getByTestId('change-diagram-panel')).toBeVisible();
    await expect(
      window.locator('[role="tab"][data-panel-kind="change-diagram"]'),
    ).toHaveAttribute('data-active', 'true');
    await expect.poll(() => getActiveGroupId(window)).toBe(diagramGroupId);
    expect(
      collectLeaves((await getLayout(window)).root).some(
        (leaf) => leaf.maximized,
      ),
    ).toBe(false);

    await window.getByTestId('panel-add-tab-group-chat').click();
    await expect(
      window.getByTestId('panel-add-menu-item-change-diagram'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('code-review-modal')).toHaveCount(0);
    expect(
      existsSync(
        path.join(
          userDataDir,
          'app-workspaces',
          'code-review-chat',
          'chats',
          'registry.json',
        ),
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('changed-file tree search and navigation preserve unrelated hidden labels', async () => {
  const { userDataDir, worktreePath } = fixture();
  mkdirSync(path.join(worktreePath, '.github/workflows'), { recursive: true });
  writeFileSync(
    path.join(worktreePath, '.github/workflows/ci.yml'),
    'name: CI\n',
  );
  writeFileSync(path.join(worktreePath, 'tooling.yml'), 'enabled: true\n');
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { changedFilesHiddenLabelIds: ['configuration'] },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    await changed
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'ci.yml' })
      .click();
    const tree = window.locator('[data-testid="file-tab-diff-tree"]:visible');
    // The tab opens in the raw view and switches to the diff moments later,
    // hiding the raw header's toggle; wait so the click finds the diff's.
    await expect(
      window.locator('[data-testid="file-panel-diff"]:visible'),
    ).toContainText('name: CI');
    await window
      .locator('[data-testid="file-tab-tree-toggle"]:visible')
      .click();
    await expect(tree).toBeVisible();
    await tree
      .getByRole('button', { name: 'Search files', exact: true })
      .click();
    await expect(
      tree
        .locator('[data-testid^="diff-file-tree-row-"]')
        .filter({ hasText: 'tooling.yml' }),
    ).toHaveCount(0);
    await tree
      .getByRole('textbox', { name: 'Search changed files' })
      .fill('ci.yml');
    await tree
      .locator('[data-testid^="diff-file-tree-row-"]')
      .filter({ hasText: 'ci.yml' })
      .click();
    await expect(
      window.locator('[data-testid="file-panel-diff"]:visible'),
    ).toContainText('name: CI');
    const preferences = await window.evaluate(() =>
      window.api.loadPreferences(),
    );
    expect(preferences.changedFilesHiddenLabelIds).toEqual(['configuration']);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('overlapping generated annotations and diagram node comments survive in workspace panels', async () => {
  const { userDataDir } = fixture();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    const { fingerprint } = await window.evaluate(
      (scope) => window.api.codeReview.get(scope),
      scope,
    );
    seedCodeReviewState({
      userDataDir,
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      armed: false,
      derivedFromFingerprint: fingerprint,
      annotations: ['First explanation', 'Second explanation'].map(
        (title, index) => ({
          id: `annotation-${index}`,
          repoId: 'default',
          filePath: 'README.md',
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          kind: 'explanation',
          title,
          body: `${title} details`,
        }),
      ),
      diagrams: {
        logicDiff: {
          status: 'ready',
          derivedFromFingerprint: fingerprint,
          data: {
            schemaVersion: 1,
            current: { nodes: [{ id: 'read', label: 'Read file' }], edges: [] },
            planned: {
              nodes: [
                { id: 'read', label: 'Read file' },
                { id: 'compare', label: 'Compare changes' },
              ],
              edges: [{ from: 'read', to: 'compare' }],
            },
            changes: [
              {
                nodeId: 'compare',
                type: 'added',
                note: 'Compare immutable snapshots',
              },
            ],
          },
        },
      },
    });
    await changed
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'README.md' })
      .click();
    const diff = window.locator('[data-testid="file-panel-diff"]:visible');
    await diff
      .getByRole('combobox', { name: 'Diff source' })
      .selectOption('combined');
    const glyph = diff
      .locator('.modified .canopy-file-annotation-glyph')
      .first();
    await expect(glyph).toBeVisible();
    await glyph.click();
    const popover = window.getByTestId('review-line-popover');
    await expect(popover).toContainText('2 annotations on this line');
    await expect(popover).toContainText('First explanation');
    await expect(popover).toContainText('Second explanation');
    await window.keyboard.press('Escape');
    await changed.getByTestId('view-change-diagram-button').click();
    const diagram = window.getByTestId('change-diagram-panel');
    await diagram
      .getByTestId('logic-diff-view-toggle')
      .getByRole('button', { name: 'After', exact: true })
      .click();
    await diagram
      .locator('.react-flow__node')
      .filter({ hasText: 'Compare changes' })
      .click();
    await diagram.getByTestId('plan-node-add-comment').click();
    await diagram
      .getByTestId('plan-node-comment-input')
      .fill('Explain this diagram change.');
    await diagram.getByTestId('plan-node-comment-save').click();
    await expect(diagram.getByTestId('file-comments-drawer')).toContainText(
      'Explain this diagram change.',
    );
    await expect(
      diagram.getByRole('button', {
        name: 'Reveal Diagram · Compare changes in diagram',
      }),
    ).toBeVisible();
    const review = await window.evaluate(
      (scope) => window.api.codeReview.get(scope),
      scope,
    );
    expect(review.review.commentThreads[0].anchor).toMatchObject({
      source: 'diagram',
      nodeId: 'compare',
      diagramFingerprint: fingerprint,
    });
    expect(review.review.commentThreads[0].anchor.filePath).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('retained diff comments without a comparison do not expose a dead Reveal action', async () => {
  const { userDataDir, worktreePath } = fixture();
  const filePath = path.join(worktreePath, 'package.json');
  seedWorktreeChat({
    userDataDir,
    workspaceId: scope.projectId,
    worktreeId: scope.worktreeId,
    activeTabId: 'retained-diff-file',
    tabs: [
      {
        id: 'retained-diff-file',
        title: 'README.md',
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
        messages: [],
      },
    ],
  });
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      scope.projectId,
      'worktree-data',
      scope.worktreeId,
      'file-annotations.json',
    ),
    {
      version: 1,
      files: [
        {
          filePath,
          annotations: [],
          commentThreads: [
            {
              id: 'retained-diff-thread',
              status: 'open',
              createdAt: '2026-09-17',
              anchorState: 'matched',
              anchor: {
                source: 'code',
                view: 'diff',
                filePath,
                side: 'new',
                lineStart: 1,
                lineEnd: 1,
                quote: '{',
                diff: {
                  source: 'uncommitted',
                  snapshotId: 'retained-snapshot',
                },
              },
              comments: [
                {
                  id: 'retained-diff-comment',
                  author: 'user',
                  body: 'Retained diff comment.',
                  createdAt: '2026-09-17',
                  staged: false,
                },
              ],
            },
          ],
        },
      ],
    },
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(scope.worktreeId);
    const panel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    const drawer = panel.getByTestId('file-comments-drawer');
    await drawer.getByTestId('file-comments-archived-toggle').click();
    await expect(drawer).toContainText('Retained diff comment.');
    await expect(
      panel.getByRole('button', { name: /Reveal .* in diff/ }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('direct diff opens with a collapsed tree and independent consistent tree controls', async () => {
  const { userDataDir, worktreePath } = fixture();
  mkdirSync(path.join(worktreePath, 'nested/deep'), { recursive: true });
  writeFileSync(
    path.join(worktreePath, 'nested/deep/change.ts'),
    'export const changed = true;\n',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    await changed
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'README.md' })
      .click();
    const panel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await expect(panel.getByTestId('file-panel-diff')).toContainText(marker);
    await expect(panel.getByTestId('file-tab-tree')).toHaveCount(0);
    await panel.locator('[data-testid="file-tab-tree-toggle"]:visible').click();
    const tree = panel.getByTestId('file-tab-tree');
    const mode = tree.getByRole('button', {
      name: 'Show changed files',
      exact: true,
    });
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(
      tree.getByRole('button', { name: 'Collapse file tree', exact: true }),
    ).toHaveCount(0);
    await expect(
      tree.getByRole('button', { name: 'View diagram' }),
    ).toHaveCount(0);
    await tree
      .getByRole('button', { name: 'Search files', exact: true })
      .click();
    await tree
      .getByRole('textbox', { name: 'Search changed files' })
      .fill('nested');
    await expect(tree).toContainText('change.ts');
    const listToggle = tree.getByRole('button', {
      name: 'List view',
      exact: true,
    });
    await expect(listToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(
      tree.getByRole('button', { name: /nested/ }).first(),
    ).toBeVisible();
    await listToggle.click();
    await expect(listToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(
      tree.getByText('nested/deep/change.ts', { exact: true }),
    ).toBeVisible();
    await expect(tree.getByText('deep', { exact: true })).toHaveCount(0);
    await listToggle.click();
    await expect(tree.getByText('change.ts', { exact: true })).toBeVisible();
    await tree.getByRole('button', { name: 'File tree actions' }).click();
    await expect(
      window.getByRole('menuitem', { name: 'New file…', exact: true }),
    ).toHaveCount(0);
    await window
      .getByRole('menuitem', { name: 'Collapse all', exact: true })
      .click();
    await expect(tree.getByText('change.ts', { exact: true })).toHaveCount(0);
    await tree
      .getByRole('textbox', { name: 'Search changed files' })
      .fill('change.ts');
    await expect(tree.getByText('change.ts', { exact: true })).toBeVisible();
    await tree
      .getByRole('button', { name: 'Jump to file', exact: true })
      .click();
    await expect(tree).toContainText('README.md');
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(panel.getByTestId('file-panel-diff')).toBeVisible();
    await tree.getByRole('button', { name: 'File tree actions' }).click();
    await expect(
      window.getByRole('menuitem', { name: 'New file…', exact: true }),
    ).toBeVisible();
    await expect(
      window.getByRole('menuitem', { name: 'New folder…', exact: true }),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await mode.click();
    await panel
      .locator('[data-testid="file-viewer-view-diff"]:visible')
      .click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByTestId('file-panel-diff')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('diff comment gutter markers are painted and clickable in unified and split layouts', async () => {
  const { userDataDir } = fixture();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    await changed
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'README.md' })
      .click();
    const diff = window.getByTestId('file-panel-diff');
    await selectDiffLine(window, diff.locator('.modified'), marker);
    await window
      .getByTestId('review-comment-composer')
      .locator('textarea')
      .fill('Visible gutter thread');
    await window.getByTestId('review-comment-submit-draft').click();
    const glyph = diff.locator('.modified .canopy-file-comment-glyph').first();
    await expect(glyph).toBeVisible();
    await expect
      .poll(() =>
        glyph.evaluate((el) => getComputedStyle(el, '::before').content),
      )
      .toBe('""');
    await glyph.click();
    await expect(window.getByTestId('review-line-popover')).toContainText(
      'Visible gutter thread',
    );
    await window.keyboard.press('Escape');
    await diff.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(glyph).toBeVisible();
    await expect
      .poll(() =>
        glyph.evaluate((el) => getComputedStyle(el, '::before').content),
      )
      .toBe('""');
    const toolbar = diff.getByTestId('file-diff-toolbar');
    await expect(toolbar.getByLabel('Diff source')).toBeVisible();
    await expect(
      toolbar.getByRole('button', { name: 'Unified', exact: true }),
    ).toBeVisible();
    await expect(
      toolbar.getByRole('button', { name: 'Refresh diff', exact: true }),
    ).toBeVisible();
    await expect(
      diff.getByText('Comment on deleted lines in split view'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('file diff source options reflect only that file', async () => {
  const { userDataDir, worktreePath } = fixture();
  const both = 'both-sources.txt';
  const committed = 'only-committed.txt';
  const uncommitted = 'only-uncommitted.txt';
  writeFileSync(path.join(worktreePath, committed), 'Committed change\n');
  writeFileSync(path.join(worktreePath, both), 'Committed version\n');
  execFileSync('git', ['add', committed, both], { cwd: worktreePath });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'Seed committed change',
    ],
    { cwd: worktreePath },
  );
  writeFileSync(path.join(worktreePath, uncommitted), 'Uncommitted change\n');
  writeFileSync(path.join(worktreePath, both), 'Uncommitted version\n');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    for (const [name, expected, absent] of [
      [uncommitted, 'uncommitted', 'committed'],
      [committed, 'committed', 'uncommitted'],
    ]) {
      await changed
        .getByTestId('activity-changed-file')
        .filter({ hasText: name })
        .click();
      const panel = window.locator(
        '[data-testid="panel-content-file-diff"]:visible',
      );
      const source = panel.getByLabel('Diff source', { exact: true });
      await expect(source).toHaveValue(expected);
      await expect(source.locator(`option[value="${absent}"]`)).toHaveCount(0);
      await expect(source.locator(`option[value="${expected}"]`)).toHaveCount(
        1,
      );
    }
    await changed
      .getByTestId('activity-changed-file')
      .filter({ hasText: both })
      .first()
      .click();
    const source = window
      .locator('[data-testid="panel-content-file-diff"]:visible')
      .getByLabel('Diff source', { exact: true });
    await expect(source.locator('option[value="committed"]')).toHaveCount(1);
    await expect(source.locator('option[value="uncommitted"]')).toHaveCount(1);
    await source.selectOption('committed');
    await expect(source).toHaveValue('committed');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('comment counters match active drawer threads and exclude resolved or outdated pending comments', async () => {
  const { userDataDir, filePath } = fixture();
  const thread = (id, view, status) => ({
    id,
    status,
    createdAt: '2026-09-18',
    anchorState: 'matched',
    anchor: {
      source: 'code',
      filePath,
      view,
      quote: '',
      unanchored: true,
      ...(view === 'diff'
        ? { diff: { source: 'uncommitted', snapshotId: 'retained-snapshot' } }
        : {}),
    },
    comments: [
      {
        id: `${id}-comment`,
        author: 'user',
        body: id,
        createdAt: '2026-09-18',
        staged: false,
      },
    ],
  });
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      scope.projectId,
      'worktree-data',
      scope.worktreeId,
      'file-annotations.json',
    ),
    {
      version: 1,
      files: [
        {
          filePath,
          annotations: [],
          commentThreads: [
            thread('open-file-note', 'file', 'open'),
            thread('resolved-file-note', 'file', 'resolved'),
            {
              ...thread('open-diff-note', 'diff', 'open'),
              comments: [
                {
                  ...thread('open-diff-note', 'diff', 'open').comments[0],
                  staged: true,
                },
              ],
            },
            thread('resolved-diff-note', 'diff', 'resolved'),
          ],
        },
      ],
    },
  );
  seedCodeReviewState({
    userDataDir,
    workspaceId: scope.projectId,
    worktreeId: scope.worktreeId,
    armed: false,
    commentThreads: [
      thread('open-legacy-note', undefined, 'open'),
      thread('resolved-legacy-note', undefined, 'resolved'),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, changed } = await selectWorktree(electronApp);
    await changed
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'README.md' })
      .click();
    const panel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    const toggle = panel.locator(
      '[data-testid="file-viewer-view-diff"]:visible',
    );
    await expect(
      toggle.getByLabel('1 open comments in file view'),
    ).toBeVisible();
    await panel
      .getByTestId('file-comment-thread-open-file-note')
      .getByRole('button', { name: 'Resolve', exact: true })
      .click();
    await expect(toggle.locator('[aria-label*="open comments"]')).toHaveCount(
      0,
    );
    await selectDiffLine(
      window,
      panel.getByTestId('file-panel-diff').locator('.modified'),
      marker,
    );
    await window
      .getByTestId('review-comment-composer')
      .locator('textarea')
      .fill('Visible pending comment');
    await window.getByTestId('review-comment-submit-draft').click();
    await toggle.click();
    await expect(
      toggle.getByLabel('1 open comments in diff view'),
    ).toBeVisible();
    await panel
      .locator('[data-testid^="file-comment-thread-"]')
      .filter({ hasText: 'Visible pending comment' })
      .getByRole('button', { name: 'Resolve', exact: true })
      .click();
    await expect(toggle.locator('[aria-label*="open comments"]')).toHaveCount(
      0,
    );
    await panel.getByTestId('file-comments-archived-toggle').click();
    await panel
      .getByTestId('file-comment-thread-open-diff-note')
      .getByRole('button', { name: 'Resolve', exact: true })
      .click();
    await expect(toggle.locator('[aria-label*="open comments"]')).toHaveCount(
      0,
    );
    await panel
      .getByTestId('file-comment-thread-open-legacy-note')
      .getByRole('button', { name: 'Resolve', exact: true })
      .click();
    await expect(toggle.locator('[aria-label*="open comments"]')).toHaveCount(
      0,
    );
    await expect
      .poll(async () => {
        const document = await window.evaluate(
          (args) => window.api.fileAnnotations.get(args),
          { ...scope, filePath },
        );
        return document.commentThreads.filter(
          (thread) => thread.status === 'open',
        ).length;
      })
      .toBe(0);
    await toggle.click();
    await expect(toggle.locator('[aria-label*="open comments"]')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const diagramCount of [0, 1, 2]) {
  test(`diagram toolbar condenses ${diagramCount} generated diagram types`, async () => {
    const { userDataDir } = fixture();
    const logic = {
      schemaVersion: 1,
      current: { nodes: [{ id: 'read', label: 'Read file' }], edges: [] },
      planned: { nodes: [{ id: 'read', label: 'Read file' }], edges: [] },
      changes: [],
    };
    const model = {
      schemaVersion: 1,
      current: { entities: [], relationships: [] },
      planned: {
        entities: [{ id: 'user', name: 'User', fields: [] }],
        relationships: [],
      },
      changes: [],
    };
    seedCodeReviewState({
      userDataDir,
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      armed: true,
      diagrams: {
        logicDiff: {
          status: 'ready',
          derivedFromFingerprint: 'fixture',
          data: diagramCount ? logic : null,
        },
        ...(diagramCount === 2
          ? {
              dataModelDiff: {
                status: 'ready',
                derivedFromFingerprint: 'fixture',
                data: model,
              },
            }
          : {}),
      },
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const { window, changed } = await selectWorktree(electronApp);
      await changed.getByTestId('view-change-diagram-button').click();
      const panel = window.getByTestId('change-diagram-panel');
      await expect(panel).toBeVisible();
      await expect(
        panel.getByText('Change Diagram', { exact: true }),
      ).toHaveCount(0);
      const refresh = panel.getByTestId('change-diagram-refresh');
      if (!diagramCount) {
        await expect(panel).toContainText('No diagram content available.');
        await expect(refresh).toHaveCount(0);
        await expect(
          panel.getByRole('tab', { name: 'Logic', exact: true }),
        ).toHaveCount(0);
      } else {
        await expect(refresh).toHaveText('');
        await expect(refresh).toHaveAttribute('aria-label', 'Refresh diagram');
        await expect(refresh.locator('svg')).toBeVisible();
        const row = panel.getByTestId(
          diagramCount === 2 ? 'change-diagram-type-row' : 'logic-diff-toolbar',
        );
        await expect(row.getByTestId('change-diagram-refresh')).toHaveCount(1);
        const [rowBox, buttonBox] = await Promise.all([
          row.boundingBox(),
          refresh.boundingBox(),
        ]);
        expect(
          rowBox.x + rowBox.width - buttonBox.x - buttonBox.width,
        ).toBeLessThan(16);
        await expect(
          panel.getByRole('tab', { name: 'Logic', exact: true }),
        ).toHaveCount(diagramCount === 2 ? 1 : 0);
        await panel
          .getByRole('button', { name: 'Before', exact: true })
          .click();
        await expect(refresh).toBeVisible();
        if (diagramCount === 2) {
          await panel.getByTestId('code-review-data-model-tab').click();
          await expect(
            panel.getByTestId('plan-data-model-diff-diagram'),
          ).toBeVisible();
          await expect(row.getByTestId('change-diagram-refresh')).toHaveCount(
            1,
          );
        }
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
