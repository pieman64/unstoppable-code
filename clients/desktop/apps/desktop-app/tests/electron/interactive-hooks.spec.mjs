// interactive-hooks: settings/activity/PTY regression coverage for interactive
// command hook actions.
// All state is local and deterministic; the test walks Activity → confirmation
// → terminal input → monitored completion.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, revealRowActions } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  HOOK_PAUSE_KEYS,
  readHookPauseKeys,
  seedHookPauseWorkspace,
} from './seeders/seedHookPauseWorkspace.mjs';
import {
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ORGANIZATIONS,
  connectMockCloudAccount,
  registerScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  seedStoredPipeline,
  buildPrStatusData,
  buildPrStatusEvent,
  buildSplitPrStatusData,
  injectGithubPrStatus,
  seedWorktreeLastKnownPrStatus,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

const WORKSPACE_ID = 'demo-multi-repo-fullstack';
const WORKSPACE_NAME = 'Multi Repo Fullstack';
const WORKTREE_ID = 'demo-main';
const COMMAND = `printf 'Name: '; read name; printf '\\nreceived:%s\\n' "$name"`;
const FOLLOW_UP_COMMAND = `printf 'second-action-running\\n'; sleep 3`;

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedHookSnapshot(
  userDataDir,
  {
    workspaceId = WORKSPACE_ID,
    worktreeId = WORKTREE_ID,
    repoStorageKey = 'web',
  } = {},
) {
  const snapshotDir = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    worktreeId,
    'github-pr',
    repoStorageKey,
  );
  mkdirSync(snapshotDir, { recursive: true });
  writeJson(path.join(snapshotDir, 'current.json'), {
    version: 1,
    provider: 'github',
    capturedAt: '2026-08-10T12:00:00.000Z',
    includesComments: true,
    includesReviews: true,
    includesReviewComments: true,
    repository: { owner: 'acme', name: 'web', fullName: 'acme/web' },
    branch: {
      currentName: 'feature/interactive-hooks',
      headRefName: 'feature/interactive-hooks',
      baseRefName: 'main',
      headSha: 'head-sha',
      baseSha: 'base-sha',
    },
    pr: {
      id: 2401,
      number: 2401,
      nodeId: 'PR_interactive_hooks',
      htmlUrl: 'https://github.com/acme/web/pull/2401',
      apiUrl: 'https://api.github.com/repos/acme/web/pulls/2401',
      state: 'open',
      isDraft: false,
      title: 'Interactive hooks',
      body: '',
      author: null,
      createdAt: '2026-08-10T12:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      isCrossRepository: false,
      labels: [],
      assignees: [],
      requestedReviewers: [],
    },
    issueComments: [],
    reviews: [],
    reviewComments: [],
  });
}

async function verifyInheritedHookTransition(transition) {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-org-hook-repair-'),
  );
  const apiKey = 'csk_org_hook_repair';
  const workspaceId = 'demo-ts-pnpm-vite';
  const worktreeId = 'demo-main';
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const workspace = seeded.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error('Missing hook workspace fixture');
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.owner = {
    type: 'organization',
    organizationId: ORG_CONTEXT_A,
    projectId: '33333333-3333-4333-8333-333333333333',
    instanceId: '44444444-4444-4444-8444-444444444444',
    bindingGeneration: 1,
  };
  delete config.hooks;
  writeJson(configPath, config);
  const marker = path.join(userDataDir, 'org-hook-completed.txt');
  seedStoredPipeline({
    userDataDir,
    id: 'org-hook-review',
    name: 'Organization hook review',
    yaml: `name: Organization hook review
on: dispatch
jobs:
  check:
    steps:
      - run: 'echo success >> "${marker}"'
`,
  });
  const manifest = {
    version: 1,
    hooks: {
      'pr:create': [
        { type: 'pipeline', source: 'local', id: 'org-hook-review' },
      ],
    },
  };
  for (const repo of [workspace.repoPath, workspace.worktreePath])
    writeJson(path.join(repo, 'canopy.json'), manifest);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  let electronApp;
  try {
    for (let launch = 0; launch < 2; launch += 1) {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ORG_CONTEXT_ENV,
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (launch === 0) await connectMockCloudAccount(window, apiKey);
      await selectWorkspaceContext(
        window,
        launch === 1 && transition === 'personal-owner'
          ? 'personal'
          : ORG_CONTEXT_A,
      );
      await app.openMainPage();
      await app.selectWorktree(worktreeId);
      const section = await hooksSection(window);
      const row = section
        .getByTestId('activity-hooks-entry')
        .filter({ hasText: 'PR Created' });
      await expect(row).toBeVisible();
      const run = row.getByTestId('activity-hooks-run');
      await expect
        .poll(async () => {
          await injectGithubPrStatus(
            electronApp,
            buildPrStatusEvent({
              projectId: workspaceId,
              worktreeId,
              prNumber: 2401,
            }),
          );
          return run.isEnabled().catch(() => false);
        })
        .toBe(true);
      seedHookSnapshot(userDataDir, {
        workspaceId,
        worktreeId,
        repoStorageKey: 'project-root',
      });
      const runsDir = path.join(
        userDataDir,
        'workspaces',
        workspaceId,
        'worktree-data',
        worktreeId,
        'hook-invocations',
      );
      // Only this launch's invocation counts; earlier runs are already terminal.
      const priorRunIds = new Set(
        existsSync(runsDir) ? readdirSync(runsDir) : [],
      );
      await run.click();
      await section.getByRole('button', { name: 'Confirm' }).click();
      const latestRun = () => {
        if (!existsSync(runsDir)) return undefined;
        return readdirSync(runsDir)
          .filter((id) => !priorRunIds.has(id))
          .flatMap((id) => {
            try {
              const dir = path.join(runsDir, id);
              const meta = JSON.parse(
                readFileSync(path.join(dir, 'meta.json'), 'utf8'),
              );
              return [
                {
                  meta,
                  output: readFileSync(path.join(dir, 'output.log'), 'utf8'),
                },
              ];
            } catch {
              return [];
            }
          })
          .filter((run) => run.meta.hook.triggerName === 'pr:create')
          .sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt))[0];
      };
      await expect
        .poll(
          () =>
            ['success', 'failed', 'cancelled'].includes(
              latestRun()?.meta.status,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      const result = latestRun();
      expect(result).toBeDefined();
      await test.info().attach('pr-created-hook-result', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
      expect(result.meta.hook.actions[0].executionContext).toBe(
        launch === 1 && transition === 'personal-owner'
          ? undefined
          : `org:${ORG_CONTEXT_A}`,
      );
      expect(result.output).not.toContain(
        'different Personal or organization context',
      );
      await expect
        .poll(
          () =>
            existsSync(marker)
              ? readFileSync(marker, 'utf8').trim().split('\n').length
              : 0,
          { timeout: 30_000 },
        )
        .toBe(launch + 1);
      const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(persisted.hooks['pr:create']).toEqual([
        {
          type: 'pipeline',
          source: 'local',
          id: 'org-hook-review',
          executionContext: `org:${ORG_CONTEXT_A}`,
          localExecutionContextOverlay: true,
        },
      ]);
      expect(
        JSON.parse(
          readFileSync(path.join(workspace.repoPath, 'canopy.json'), 'utf8'),
        ),
      ).toEqual(manifest);
      await expect(
        window.getByText(/different Personal or organization context/),
      ).toHaveCount(0);
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: launch === 0,
      });
      electronApp = undefined;
      if (launch === 0 && transition === 'personal-owner') {
        const personalConfig = JSON.parse(readFileSync(configPath, 'utf8'));
        delete personalConfig.owner;
        writeJson(configPath, personalConfig);
      }
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
}

for (const transition of ['unchanged', 'personal-owner']) {
  test(`inherited PR Created hook respects ${transition} after restart`, async () => {
    await verifyInheritedHookTransition(transition);
  });
}

function seedInteractiveHook(userDataDir) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    checkRuntimes: false,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const webRepo = config.repos.find((repo) => repo.id === 'web');
  if (!webRepo) throw new Error('Missing web repo in seeded project');
  webRepo.hooks = {
    'pr:create': [
      { type: 'command', command: COMMAND, interactive: true },
      { type: 'command', command: FOLLOW_UP_COMMAND },
    ],
  };
  writeJson(configPath, config);

  const status = buildSplitPrStatusData({
    prNumber: 2401,
    additions: 4,
    deletions: 1,
  });
  seedWorktreeLastKnownPrStatus({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    lastKnownPrStatus: {
      repos: [{ repoId: 'web', repoName: 'Web App', status }],
      lastCheckedAt: '2026-08-10T12:00:00.000Z',
    },
  });
  seedHookSnapshot(userDataDir);
}

async function hooksSection(window) {
  const title = window.getByRole('heading', { name: 'Hooks', exact: true });
  await expect(title).toBeVisible({ timeout: 45_000 });
  const section = title.locator('xpath=ancestor::section[1]');
  const expand = section.getByRole('button', {
    name: 'Expand section',
    exact: true,
  });
  if (await expand.count()) await expand.first().click();
  return section;
}

test('multi-repo hook pause and resume survive stale sidebar saves', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-hook-pause-'));
  seedHookPauseWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const section = await hooksSection(window);
    const unpausedSnapshot = await window.evaluate(
      async () => (await window.api.loadProjects()).items,
    );
    await section
      .getByRole('button', { name: 'Pause all hooks', exact: true })
      .click();
    await expect.poll(() => readHookPauseKeys(window)).toEqual(HOOK_PAUSE_KEYS);
    const pausedSnapshot = await window.evaluate(
      async () => (await window.api.loadProjects()).items,
    );
    // A pending sidebar save can carry the worktree state from before pause.
    await window.evaluate(
      (items) => window.api.saveProjects(items),
      unpausedSnapshot,
    );
    await expect.poll(() => readHookPauseKeys(window)).toEqual(HOOK_PAUSE_KEYS);
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const reloadedSection = await hooksSection(window);
    await reloadedSection
      .getByRole('button', { name: 'Resume all hooks', exact: true })
      .click();
    await expect.poll(() => readHookPauseKeys(window)).toEqual([]);
    await window.evaluate(
      (items) => window.api.saveProjects(items),
      pausedSnapshot,
    );
    await expect.poll(() => readHookPauseKeys(window)).toEqual([]);
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      (await hooksSection(window)).getByRole('button', {
        name: 'Pause all hooks',
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('interactive hook settings, activity affordance, and terminal execution', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-interactive-hooks-'),
  );
  seedInteractiveHook(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  const injectActivePr = async () => {
    await injectGithubPrStatus(
      electronApp,
      buildPrStatusEvent({
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        kind: 'open-pr',
        prNumber: 2401,
        repos: [
          {
            repoId: 'web',
            repoName: 'Web App',
            status: buildPrStatusData({ prNumber: 2401, state: 'open' }),
          },
        ],
      }),
    );
  };

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await injectActivePr();

    const section = await hooksSection(window);
    const row = section
      .getByText('Web App — PR Created', { exact: true })
      .locator('xpath=ancestor::div[@data-testid="activity-hooks-entry"][1]');
    await expect(row).toBeVisible();
    const run = row.getByTestId('activity-hooks-run');
    await expect(run).toHaveCSS('height', '24px');
    await expect(run).toHaveClass(/bg-quaternary/);
    await expect
      .poll(async () => {
        await injectActivePr();
        return run.isEnabled().catch(() => false);
      })
      .toBe(true);
    await expect(
      run.getByTestId('interactive-hook-command-icon'),
    ).toBeVisible();
    await expect(run).toHaveAttribute(
      'aria-label',
      'Run Web App — PR Created in terminal',
    );

    await row.getByRole('button', { name: /^Source info for/ }).click();
    const infoDialog = window.getByRole('dialog', { name: /PR Created/ });
    await expect(infoDialog).toBeVisible();
    await expect(infoDialog).toContainText('Interactive terminal');
    await infoDialog.getByRole('button', { name: 'Close' }).click();

    // The project settings control moves to the section header when this is
    // the only visible project. Hover the visible header to reveal its controls.
    const settingsButton = app.workspaceSettingsButton(WORKSPACE_NAME).or(
      window.getByRole('button', {
        name: `Project settings for ${WORKSPACE_NAME}`,
        exact: true,
      }),
    );
    await (await revealRowActions(window, settingsButton)).click();
    const settings = window.getByRole('dialog', { name: WORKSPACE_NAME });
    await expect(settings).toBeVisible();
    await settings.getByRole('tab', { name: 'Hooks' }).click();
    const commandIndex = await settings
      .locator('textarea')
      .evaluateAll(
        (nodes, command) => nodes.findIndex((node) => node.value === command),
        COMMAND,
      );
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    const editor = settings
      .locator('textarea')
      .nth(commandIndex)
      .locator(
        'xpath=ancestor::div[contains(@class,"rounded-lg") and contains(@class,"bg-card")][1]',
      );
    const runtimeMode = editor.getByTestId('hook-command-runtime-mode');
    await expect(runtimeMode).toBeVisible();
    await expect(
      runtimeMode.getByTestId('hook-command-runtime-mode-interactive'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      runtimeMode.getByTestId('hook-command-runtime-mode-background'),
    ).toHaveAttribute('aria-checked', 'false');
    await settings.getByRole('button', { name: 'Close' }).click();

    // The background PR poller may clear the seeded on-disk snapshot while
    // network access is disabled; restore it immediately before manual run.
    seedHookSnapshot(userDataDir);
    await expect
      .poll(async () => {
        await injectActivePr();
        return run.isEnabled().catch(() => false);
      })
      .toBe(true);
    await run.click();
    await section.getByRole('button', { name: 'Confirm' }).click();
    // Diagnostic state is intentionally surfaced if terminal creation stalls.
    const hookStateAfterConfirm = await section.innerText();
    await expect
      .poll(
        () =>
          window.evaluate(
            async () =>
              (await window.api.terminal.list()).filter(
                (session) => session.kind === 'script',
              ).length,
          ),
        { timeout: 20_000, message: hookStateAfterConfirm },
      )
      .toBe(1);
    const terminal = window.getByTestId('terminal-pane');
    await expect(terminal).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => terminal.innerText(), { timeout: 20_000 })
      .toContain('Name:');
    await terminal.click();
    await window.keyboard.type('Ada');
    await window.keyboard.press('Enter');
    await expect
      .poll(() => terminal.innerText(), { timeout: 20_000 })
      .toContain('received:Ada');
    await expect(
      section.getByText('second-action-running', { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(section.getByText(/Running in terminal/)).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: 'Enlarge output' }),
    ).toBeVisible();
    await expect(section.getByText(/Completed \(1\)/)).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('PR Created pipeline hook authorizes a bundled plugin collection under strict policy', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-hook-context-'),
  );
  seedInteractiveHook(userDataDir);
  const marker = path.join(userDataDir, 'hook-completed.txt');
  seedStoredPipeline({
    userDataDir,
    id: 'local-security-review',
    name: 'Local security review',
    yaml: `name: Local security review
on: dispatch
plugin_collections:
  - id: security
    name: Security
    defaults:
      - type: plugin
        marketplace:
          type: builtin
          id: app
        plugin_name: builtin-security
        required: true
jobs:
  check:
    steps:
      - run: 'echo success > "${marker}"'
`,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.repos.find((repo) => repo.id === 'web').hooks = {
    'pr:create': [
      {
        type: 'pipeline',
        source: 'local',
        id: 'local-security-review',
      },
    ],
  };
  writeJson(configPath, config);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const section = await hooksSection(window);
    const row = section
      .getByText('Web App — PR Created', { exact: true })
      .locator('xpath=ancestor::div[@data-testid="activity-hooks-entry"][1]');
    const run = row.getByTestId('activity-hooks-run');
    await expect(row, await section.innerText()).toBeVisible();
    await expect
      .poll(async () => {
        await injectGithubPrStatus(
          electronApp,
          buildPrStatusEvent({
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            kind: 'open-pr',
            prNumber: 2401,
            repos: [
              {
                repoId: 'web',
                repoName: 'Web App',
                status: buildPrStatusData({ prNumber: 2401, state: 'open' }),
              },
            ],
          }),
        );
        return run.isEnabled().catch(() => false);
      })
      .toBe(true);
    seedHookSnapshot(userDataDir);
    await run.click();
    await section.getByRole('button', { name: 'Confirm' }).click();
    await expect
      .poll(
        () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''),
        { timeout: 30_000 },
      )
      .toBe('success');
    await expect(
      window.getByText(/Couldn't confirm where something this uses came from/),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
