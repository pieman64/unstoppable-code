// CAN-3224: real filesystem names must retain their identity through the
// user's file-opening routes and durable tabs. No fs/platform mocks, no
// checked-in case-pair fixture, and no live provider or network dependencies.
// Run after the coordinated E2E build:
// pnpm run test:electron:built file-tabs.spec.mjs --reporter=line
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
import { chatPanelLocator } from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'filename-identity-chat';
const FIXTURE_DIRECTORY = 'identity-fixtures';
const SCOPE = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };

/** Probe the very directory that will contain A.ts/a.ts, not the host label. */
function isCaseSensitive(directory) {
  const upper = path.join(directory, 'Sensitivity.probe');
  const lower = path.join(directory, 'sensitivity.probe');
  try {
    writeFileSync(upper, 'upper', { flag: 'wx' });
    if (existsSync(lower)) return false;
    writeFileSync(lower, 'lower', { flag: 'wx' });
    return (
      readFileSync(upper, 'utf8') === 'upper' &&
      readFileSync(lower, 'utf8') === 'lower'
    );
  } finally {
    rmSync(upper, { force: true });
    rmSync(lower, { force: true });
  }
}

function seedIdentityFiles(names, casePair) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-identity-'),
  );
  let demoSeed;
  try {
    demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const root = demoSeed.workspaces[0].worktreePath;
    const directory = path.join(root, FIXTURE_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    if (casePair) {
      const sensitive = isCaseSensitive(directory);
      // The curated Ubuntu lane must exercise this, never silently skip it.
      if (process.platform === 'linux') expect(sensitive).toBe(true);
      test.skip(
        !sensitive,
        'The actual fixture filesystem is case-insensitive',
      );
    }
    const files = names.map((name, index) => {
      const relativePath = `${FIXTURE_DIRECTORY}/${name}`;
      const absolutePath = path.join(root, FIXTURE_DIRECTORY, name);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      const marker = `can3224_exact_file_${index}`;
      writeFileSync(absolutePath, `export const marker = '${marker}';\n`, {
        flag: 'wx',
      });
      return { name, relativePath, absolutePath, marker };
    });
    // Git sees real files; intent-to-add exposes additions to the actual diff
    // reader without making fixture commits or replacing any backend methods.
    execFileSync(
      'git',
      [
        'add',
        '--intent-to-add',
        '--',
        ...files.map((file) => file.relativePath),
      ],
      { cwd: root, stdio: 'pipe' },
    );
    if (casePair) {
      const entries = readdirSync(directory);
      expect(entries).toContain('A.ts');
      expect(entries).toContain('a.ts');
    }
    const markdown = files
      .flatMap((file, index) => [
        // Agent prose supports absolute workspace paths. Keep the initial
        // slash and encode segments; do not broaden the renderer's URL-scheme
        // policy to make file: links actionable in this filename golden.
        `[absolute-${index}](${file.absolutePath.split(path.sep).map(encodeURIComponent).join('/')})`,
        // Encode EACH segment: %5C denotes a literal POSIX backslash, not a
        // separator. The slash-neighbor fixture below detects accidental aliases.
        `[relative-${index}](./${file.relativePath.split('/').map(encodeURIComponent).join('/')})`,
      ])
      .join('\n\n');
    seedWorktreeChat({
      userDataDir,
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: CHAT_ID,
          title: 'Exact filename links',
          blocks: [{ type: 'text', text: markdown }],
        },
        {
          id: 'filename-identity-picker',
          title: 'Open file',
          kind: 'file',
          filePath: '',
        },
      ],
      activeTabId: 'filename-identity-picker',
      lastActiveEditableChatId: CHAT_ID,
    });
    const worktreeData = path.join(
      userDataDir,
      'workspaces',
      PROJECT_ID,
      'worktree-data',
      WORKTREE_ID,
    );
    mkdirSync(worktreeData, { recursive: true });
    writeFileSync(
      path.join(worktreeData, 'panel-layout-mode.json'),
      JSON.stringify({ version: 1, mode: 'advanced' }),
    );
    return { userDataDir, demoSeed, files };
  } catch (error) {
    cleanupDemoWorkspaces(demoSeed);
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function selectWorktree(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID, { expandDefaultActivityRail: false });
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
  return window;
}

/** Escape for the selector only; never normalize, fold or rewrite the path. */
async function exactPathRow(window, testId, relativePath, parent = window) {
  const escaped = await window.evaluate(
    (value) => CSS.escape(value),
    relativePath,
  );
  return parent
    .getByTestId(testId)
    .and(window.locator(`[data-path="${escaped}"]`));
}

function visibleViewer(window) {
  return window.getByTestId('file-viewer').filter({ visible: true });
}

async function expectFileContent(window, file, files) {
  const viewer = visibleViewer(window);
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText(file.marker);
  for (const other of files) {
    if (other !== file) await expect(viewer).not.toContainText(other.marker);
  }
}

async function openTree(window) {
  const tree = window.getByTestId('file-tab-tree').filter({ visible: true });
  const toggle = window
    .getByTestId('file-tab-tree-toggle')
    .filter({ visible: true });
  // The empty picker defaults to an OPEN tree. Before its panel has mounted,
  // isVisible() returns false immediately; clicking the eventually-mounted
  // toggle then closes that default tree. Wait for the controlling button and
  // read its rendered state, rather than treating "not mounted" as "closed".
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) === 'false') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(tree).toBeVisible();
  return tree;
}

async function canonicalFileTabs(window) {
  return window.evaluate(async (scope) => {
    const state = await window.api.chat.loadTabs(scope);
    return state.tabs.filter((tab) => tab.kind === 'file');
  }, SCOPE);
}

async function expectDurableIdentities(window, files) {
  const expected = files.map((file) => file.absolutePath).sort();
  await expect
    .poll(async () => {
      const tabs = await canonicalFileTabs(window);
      return tabs
        .map((tab) => tab.filePath)
        .filter(Boolean)
        .sort();
    })
    .toEqual(expected);
  const tabs = await canonicalFileTabs(window);
  // Distinct case neighbors must retain distinct durable tab ids, not merely
  // two labels referring to the same persisted identity.
  expect(
    new Set(tabs.filter((tab) => tab.filePath).map((tab) => tab.id)).size,
  ).toBe(files.length);
  for (const file of files) {
    expect(tabs.find((tab) => tab.filePath === file.absolutePath)?.title).toBe(
      path.basename(file.absolutePath),
    );
  }
}

async function exerciseFileRoutes(window, files) {
  for (const file of files) {
    await test.step(`tree, selection, reveal and diff: ${file.name}`, async () => {
      const tree = await openTree(window);
      if (!(await tree.getByTestId('files-tree-search-input').isVisible())) {
        await tree.getByTestId('files-tree-search-toggle').click();
      }
      await tree.getByTestId('files-tree-search-input').fill(file.name);
      const row = await exactPathRow(
        window,
        'files-tree-row',
        file.relativePath,
        tree,
      );
      await expect(row).toBeVisible();
      await row.click();
      const openedTree = await openTree(window);
      await expect(
        await exactPathRow(
          window,
          'files-tree-row',
          file.relativePath,
          openedTree,
        ),
      ).toHaveAttribute('data-current-file', 'true');
      await expectFileContent(window, file, files);

      const currentTree = await openTree(window);
      // Remove the filter and collapse the tree, so jump-to-file must really
      // expand/reveal the current exact file rather than reuse a visible row.
      if (
        await currentTree.getByTestId('files-tree-search-close').isVisible()
      ) {
        await currentTree.getByTestId('files-tree-search-close').click();
      }
      const revealed = await exactPathRow(
        window,
        'files-tree-row',
        file.relativePath,
        currentTree,
      );
      const jumpToFile = currentTree.getByTestId('files-tree-jump-to-file');
      await jumpToFile.click();
      await expect(revealed).toBeVisible();
      // Embedded trees put Collapse all in a portalled overflow menu, not
      // inline inside the tree. Reveal first also guarantees an expanded
      // ancestor, so this action is enabled rather than already collapsed.
      await currentTree
        .getByRole('button', { name: 'File tree actions', exact: true })
        .click();
      const collapseAll = window.getByTestId('files-tree-collapse-all');
      await expect(collapseAll).toBeEnabled();
      await collapseAll.click();
      await expect(revealed).not.toBeVisible();
      await jumpToFile.click();
      await expect(revealed).toBeVisible();
      await expect(revealed).toHaveAttribute('data-current-file', 'true');
      // Embedded trees deliberately clear ordinary selection after opening
      // a file (noteFileOpened). Use the real modifier-selection gesture to
      // select this exact row without triggering that open/reset path.
      await expect(revealed).toHaveAttribute('aria-selected', 'false');
      await revealed.click({ modifiers: ['ControlOrMeta'] });
      await expect(revealed).toHaveAttribute('aria-selected', 'true');
      const selectedRows = currentTree
        .getByTestId('files-tree-row')
        .and(window.locator('[aria-selected="true"]'));
      await expect(selectedRows).toHaveCount(1);
      await expect(selectedRows).toHaveAttribute(
        'data-path',
        file.relativePath,
      );
      // FileViewer keeps its raw body (and raw header) hidden while diff
      // renders a separate alternate header outside data-testid=file-viewer.
      // Select the visible control itself in BOTH modes, not the raw body.
      const diffToggle = window
        .getByTestId('file-viewer-view-diff')
        .filter({ visible: true });
      await expect(diffToggle).toHaveAttribute('aria-pressed', 'false');
      await diffToggle.click();
      await expect(diffToggle).toHaveAttribute('aria-pressed', 'true');
      const diff = window
        .getByTestId('file-panel-diff')
        .filter({ visible: true });
      await expect(diff).toContainText(file.marker);
      for (const other of files) {
        if (other !== file) await expect(diff).not.toContainText(other.marker);
      }
      await diffToggle.click();
      await expect(diffToggle).toHaveAttribute('aria-pressed', 'false');
      await expectFileContent(window, file, files);
    });
  }

  for (const [index, file] of files.entries()) {
    await test.step(`real transcript links and file search: ${file.name}`, async () => {
      for (const kind of ['absolute', 'relative']) {
        await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
        const link = window.getByTestId('chat-local-file-link').and(
          window.getByRole('button', {
            name: `${kind}-${index}`,
            exact: true,
          }),
        );
        await expect(link).toBeVisible();
        await link.click();
        await expectFileContent(window, file, files);
        // Desktop ChatMarkdownLink exposes disabled=opening, not the shared
        // TranscriptFileLinks state attribute. Return to the source chat so
        // even an already-open target must complete without a resolver error.
        await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
        await expect(link).toBeEnabled();
        await expect(
          chatPanelLocator(window, CHAT_ID)
            .getByRole('status')
            .filter({ hasText: "Couldn't open file" }),
        ).toHaveCount(0);
      }
      await window.keyboard.press('ControlOrMeta+p');
      await window.getByTestId('file-search-palette-input').fill(file.name);
      const result = await exactPathRow(
        window,
        'file-search-palette-result',
        file.relativePath,
      );
      await expect(result).toBeVisible();
      await result.click();
      await expect(
        window.getByTestId('file-search-palette-input'),
      ).not.toBeVisible();
      await expectFileContent(window, file, files);
    });
  }
  await expectDurableIdentities(window, files);
}

async function runIdentityFlow(names, casePair) {
  const { userDataDir, demoSeed, files } = seedIdentityFiles(names, casePair);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await selectWorktree(electronApp);
    await exerciseFileRoutes(window, files);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    // A new process, not only a store read or renderer reload: history and
    // all opened tabs must survive the durable serialization boundary.
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await selectWorktree(electronApp);
    await expectDurableIdentities(window, files);
    const tabs = await canonicalFileTabs(window);
    for (const file of files) {
      const tab = tabs.find(
        (candidate) => candidate.filePath === file.absolutePath,
      );
      await window.getByTestId(`panel-tab-panel-file-${tab.id}`).click();
      await expectFileContent(window, file, files);
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    else rmSync(userDataDir, { recursive: true, force: true });
    cleanupDemoWorkspaces(demoSeed);
  }
}

test.describe('file tabs', () => {
  // Each case drives several opening routes and a complete process relaunch.
  test.setTimeout(180_000);

  test('preserves case-sensitive file identity across tree, reveal, diff, links, search and restart', async () => {
    await runIdentityFlow(['A.ts', 'a.ts'], true);
  });

  test('preserves POSIX filename identity across tree, reveal, diff, links, search and restart', async () => {
    // Windows cannot create these POSIX names. Do not reinterpret them as
    // Windows paths or mock the platform; Linux/macOS create the real entries.
    test.skip(
      process.platform === 'win32',
      'Literal backslash/colon names require a POSIX filesystem',
    );
    await runIdentityFlow(
      [
        "space's name.ts",
        // Stable under NFC/NFD so HFSX's mandatory decomposition does not
        // change the spelling; Linux still exercises real Unicode names.
        '資料-雪.ts',
        'literal\\name.ts',
        'literal/name.ts',
        'report:12.ts',
      ],
      false,
    );
  });
});
