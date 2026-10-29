import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// A low-cost automatic refresh may already be parsing a worktree when the user
// explicitly requests a verified build. This spec exercises the production
// scheduler, build service, runner, utility worker, SQLite graph, IPC status
// broadcast, and visible sidebar badge. The manual request must cause a second,
// stronger build instead of sharing the weaker in-flight promise.
//
// Determinism: a local generated TypeScript corpus keeps the first worker live;
// the performance-scheduler seam only selects the production background path.
// No live agents or network services are used.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';

function seedLargeTypeScriptCorpus(worktreePath, fileCount = 1_200) {
  const sourceDir = path.join(worktreePath, 'generated-graph-corpus');
  mkdirSync(sourceDir, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    const previous = index === 0 ? fileCount - 1 : index - 1;
    writeFileSync(
      path.join(sourceDir, `module-${index}.ts`),
      [
        `import { value${previous} } from './module-${previous}';`,
        `export const value${index} = value${previous} + ${index};`,
        `export function transform${index}(input: number): number {`,
        `  return input + value${index};`,
        '}',
        `export class Service${index} {`,
        `  run(input: number): number { return transform${index}(input); }`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

test('an explicit verified build follows an in-flight background build', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-code-graph-build-upgrade-'),
  );
  const seeded = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = seeded.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const launched = await launchCanopy({
    userDataDir,
    env: { CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1' },
  });

  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const initialResult = await window.evaluate(() =>
      window.api.codeGraphBuildWorktree({
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    expect(initialResult).toMatchObject({ enabled: true, state: 'ready' });
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const queue = await window.api.codeGraphGetGenerationQueue();
            return queue.entries.length;
          }),
        { timeout: 30_000 },
      )
      .toBe(0);

    // Make the subsequent weak refresh do enough real parsing that the manual
    // request deterministically reaches a worker which has already started.
    seedLargeTypeScriptCorpus(worktreePath);

    await window.evaluate(() => {
      window.__CODE_GRAPH_BUILD_UPGRADE__ = {
        events: [],
        backgroundResult: null,
      };
      window.api.onCodeGraphBuildStatusChanged((event) => {
        if (
          event.projectId === 'demo-ts-pnpm-vite' &&
          event.worktreeId === 'demo-main'
        ) {
          window.__CODE_GRAPH_BUILD_UPGRADE__.events.push(event.status);
        }
      });
      window.api
        .codeGraphSchedulePerformanceBuild({
          workspaceId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        })
        .then((result) => {
          window.__CODE_GRAPH_BUILD_UPGRADE__.backgroundResult = result;
        });
    });

    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const queue = await window.api.codeGraphGetGenerationQueue();
            return queue.entries.some(
              (entry) =>
                entry.status === 'running' && entry.worktreeId === 'demo-main',
            );
          }),
        { timeout: 60_000 },
      )
      .toBe(true);

    await expect(window.getByTestId('worktree-row-graph-badge')).toBeVisible({
      timeout: 10_000,
    });

    const manualResult = await window.evaluate(() =>
      window.api.codeGraphBuildWorktree({
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    expect(manualResult).toMatchObject({ enabled: true, state: 'ready' });

    await expect
      .poll(
        () =>
          window.evaluate(
            () => window.__CODE_GRAPH_BUILD_UPGRADE__.backgroundResult,
          ),
        { timeout: 30_000 },
      )
      .toEqual({ ok: true });
    await expect
      .poll(
        () =>
          window.evaluate(
            () =>
              window.__CODE_GRAPH_BUILD_UPGRADE__.events.filter(
                (status) => status === 'building',
              ).length,
          ),
        { timeout: 30_000 },
      )
      .toBe(2);
    await expect(window.getByTestId('worktree-row-graph-badge')).toHaveCount(
      0,
      {
        timeout: 10_000,
      },
    );
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
    cleanupDemoWorkspaces(seeded);
  }
});
