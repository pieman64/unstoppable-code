import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const firstWaveWorkspaceNames = [
  'TypeScript npm Next',
  'TypeScript pnpm Vite',
  'TypeScript Bun API',
  'TypeScript Yarn CLI',
  'TypeScript npm Nest Monorepo',
  'Python FastAPI uv',
  'Python FastAPI venv',
  'Go CLI',
  'Rust Tauri Lite',
  'Multi Repo Fullstack',
];

function getSeededAppPath(demoSeed, appId) {
  const app = demoSeed?.apps?.find((entry) => entry.id === appId);
  if (!app) {
    throw new Error(`Expected seeded demo app ${appId}`);
  }
  return app.path;
}

function readSeededCanopyManifest(demoSeed, appId) {
  const manifestPath = path.join(
    getSeededAppPath(demoSeed, appId),
    'canopy.json',
  );
  if (!existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

async function discoverProjectPipelines(window, cwd) {
  const result = await window.evaluate(
    async (projectPath) => window.pipelines.discoverProject(projectPath),
    cwd,
  );
  expect(result.success, result.error ?? 'pipeline discovery failed').toBe(
    true,
  );
  return result.data ?? [];
}

test('empty data dir launches without seeded demo projects', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    const pageText = await window.locator('body').innerText();
    for (const workspaceName of firstWaveWorkspaceNames) {
      expect(pageText).not.toContain(workspaceName);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('selected demo projects distinguish plain repos from scripts, hooks, and source repos', async () => {
  const { electronApp, userDataDir, demoSeed } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite', 'ts-npm-next', 'multi-repo-fullstack'],
  });

  try {
    expect(demoSeed.apps).toHaveLength(3);

    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await expect(
      app.workspaceHeaderLabel('TypeScript pnpm Vite'),
    ).toBeVisible();
    await expect(app.workspaceHeaderLabel('TypeScript npm Next')).toBeVisible();
    await expect(
      app.workspaceHeaderLabel('Multi Repo Fullstack'),
    ).toBeVisible();

    expect(readSeededCanopyManifest(demoSeed, 'ts-pnpm-vite')).toBeNull();

    const nextManifest = readSeededCanopyManifest(demoSeed, 'ts-npm-next');
    expect(nextManifest.scripts.setup).toBe('npm install');
    expect(nextManifest.scripts.launch).toMatchObject({
      command: 'npm run dev',
      devServerPattern: 'http://127.0.0.1:3101',
      timeoutSeconds: 120,
    });
    expect(nextManifest.scripts.teardown).toBe('rm -rf .next');
    expect(nextManifest.scripts).not.toHaveProperty('install');
    expect(nextManifest.scripts).not.toHaveProperty('dev');
    expect(nextManifest.hooks['worktree:precommit:failure']).toEqual([
      {
        type: 'command',
        command: 'npm test',
      },
    ]);

    const fullstackManifest = readSeededCanopyManifest(
      demoSeed,
      'multi-repo-fullstack',
    );
    expect(fullstackManifest.repos.map((repo) => repo.id).sort()).toEqual([
      'api',
      'web',
    ]);
    expect(
      fullstackManifest.repos.find((repo) => repo.id === 'web').scripts,
    ).toHaveProperty('launch');
    expect(
      fullstackManifest.repos.find((repo) => repo.id === 'api').scripts.lint,
    ).toContain('ruff check');
    expect(
      fullstackManifest.repos.find((repo) => repo.id === 'api').scripts,
    ).toHaveProperty('teardown');
    expect(fullstackManifest.hooks['worktree:precommit:failure']).toHaveLength(
      1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('selected demo projects surface project pipelines only where configured', async () => {
  const { electronApp, userDataDir, demoSeed } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [
      'ts-pnpm-vite',
      'ts-npm-nest-monorepo',
      'multi-repo-fullstack',
    ],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await expect(
      app.workspaceHeaderLabel('TypeScript pnpm Vite'),
    ).toBeVisible();
    await expect(
      app.workspaceHeaderLabel('TypeScript npm Nest Monorepo'),
    ).toBeVisible();
    await expect(
      app.workspaceHeaderLabel('Multi Repo Fullstack'),
    ).toBeVisible();

    const plainPipelines = await discoverProjectPipelines(
      window,
      getSeededAppPath(demoSeed, 'ts-pnpm-vite'),
    );
    expect(plainPipelines).toEqual([]);

    const nestPipelines = await discoverProjectPipelines(
      window,
      getSeededAppPath(demoSeed, 'ts-npm-nest-monorepo'),
    );
    expect(nestPipelines.map((pipeline) => pipeline.name)).toEqual([
      'Nest Monorepo Quality Check',
    ]);
    expect(nestPipelines[0]).toMatchObject({
      filename: 'quality-check.yml',
      source: 'project',
      readonly: true,
    });

    const fullstackPipelines = await discoverProjectPipelines(
      window,
      getSeededAppPath(demoSeed, 'multi-repo-fullstack'),
    );
    expect(fullstackPipelines.map((pipeline) => pipeline.name)).toEqual([
      'Fullstack Smoke',
    ]);
    expect(fullstackPipelines[0]).toMatchObject({
      filename: 'fullstack-smoke.yml',
      source: 'project',
      readonly: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('seeded first-wave demo projects appear in the sidebar', async () => {
  const { electronApp, userDataDir, demoSeed } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceSet: 'first-wave',
  });

  try {
    expect(demoSeed.workspaces).toHaveLength(firstWaveWorkspaceNames.length);

    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    for (const workspaceName of firstWaveWorkspaceNames) {
      await expect(app.workspaceHeaderLabel(workspaceName)).toBeVisible();
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
