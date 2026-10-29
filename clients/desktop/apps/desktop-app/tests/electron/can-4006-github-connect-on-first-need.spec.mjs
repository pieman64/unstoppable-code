import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { buildPrStatusData, injectGithubPrStatus } from './seeders/index.mjs';

// Real controls, offer host, terminal modal and store continuation. Only network
// operations and the credential/PTY boundary are deterministic IPC fixtures.
for (const scenario of [
  { kind: 'pr', connected: true },
  { kind: 'pr', connected: true, review: true },
  { kind: 'push', connected: true },
  { kind: 'push', connected: true, unprepared: true },
  { kind: 'push', connected: false },
  { kind: 'push', connected: true, retryFails: true },
  { kind: 'push', connected: true, cancel: true },
]) {
  test(`CAN-4006 ${JSON.stringify(scenario)}`, async () => {
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4006-'));
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = seed.workspaces.find(
      (entry) => entry.id === 'demo-ts-pnpm-vite',
    );
    expect(workspace).toBeTruthy();
    const origin = path.join(userDataDir, 'origin.git');
    const git = (args) => execFileSync('git', args, { stdio: 'ignore' });
    git(['init', '--bare', origin]);
    git(['-C', workspace.repoPath, 'remote', 'add', 'origin', origin]);
    git(['-C', workspace.worktreePath, 'push', '-u', 'origin', 'HEAD']);
    writeFileSync(
      path.join(workspace.worktreePath, 'can-4006.txt'),
      'Pending work\n',
    );
    if (scenario.kind === 'push' && !scenario.unprepared) {
      git(['-C', workspace.worktreePath, 'add', 'can-4006.txt']);
      git([
        '-C',
        workspace.worktreePath,
        '-c',
        'user.name=E2E',
        '-c',
        'user.email=e2e@example.test',
        'commit',
        '-m',
        'Pending push',
      ]);
    }
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await electronApp.evaluate(({ ipcMain }, scenario) => {
        const fixture = { connected: false, calls: [], refreshes: 0 };
        globalThis.__can4006 = fixture;
        const replace = (channel, handler) => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, handler);
        };
        // Deterministic GitHub metadata, rather than treating any origin as GitHub.
        replace('github:get-repo-slug', () => ({ owner: 'acme', repo: 'app' }));
        replace('settings:load-github-pat', () => '');
        replace('settings:github-cli-status', () => ({
          installed: true,
          authenticated: fixture.connected,
        }));
        replace('settings:refresh-github-credentials', () => {
          fixture.refreshes++;
        });
        replace('auth-terminal:start', () => ({ sessionId: 'can4006-login' }));
        replace('auth-terminal:stop', () => {});
        replace('auth-terminal:resize', () => {});
        replace('auth-terminal:write', () => {});
        if (scenario.review || scenario.unprepared) {
          const load = ipcMain._invokeHandlers.get('preferences:load');
          replace('preferences:load', async (event, request) => ({
            ...(await load(event, request)),
            reviewCommitMessage: !scenario.unprepared,
          }));
          replace('github:generate-commit-messages', () => ({
            repos: [
              {
                repoId: '__single_repo__',
                repoName: 'app',
                message: 'Reviewed change',
              },
            ],
            skippedRepos: [],
            failedRepos: [],
          }));
          replace('github:commit-and-push', (_event, request) => {
            if (scenario.unprepared) fixture.calls.push(request);
            if (scenario.unprepared && !fixture.connected)
              return {
                repos: [],
                skippedRepos: [],
                agentResolutionRepos: [],
                failedRepos: [
                  {
                    repoId: '__single_repo__',
                    repoName: 'app',
                    status: 'failed',
                    error: 'Authentication failed',
                    failureCode: 'github_not_authenticated',
                    commitPrepared: false,
                  },
                ],
              };
            fixture.reviewedCommit = request;
            return {
              repos: [
                {
                  repoId: '__single_repo__',
                  repoName: 'app',
                  operation: 'push',
                  status: 'success',
                },
              ],
              skippedRepos: [],
              failedRepos: [],
              agentResolutionRepos: [],
            };
          });
        }
        const failure = {
          repoId: '__single_repo__',
          repoName: 'app',
          status: 'failed',
          error: 'Authentication failed',
          failureCode: 'github_not_authenticated',
        };
        replace('github:push-only', (_event, request) => {
          fixture.calls.push(request);
          return {
            repos: [],
            skippedRepos: [],
            failedRepos:
              fixture.calls.length === 1 || scenario.retryFails
                ? [failure]
                : [],
          };
        });
        replace('github:create-pr', (_event, request) => {
          fixture.calls.push(request);
          return { repos: [], skippedRepos: [], localOnlyCommittedRepos: [] };
        });
      }, scenario);
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      if (scenario.kind === 'push') {
        // Selection queues live PR refreshes, and one landing after the
        // injection below replaces the open PR with the real "Create PR"
        // state, which drops the Push action before it is clicked. Pin the
        // fixture first: a suspended key's poll results never reach the
        // renderer, leaving the injected status authoritative.
        await electronApp.evaluate(({ ipcMain }) => {
          const invoked = ipcMain.emit(
            'github:e2e-suspend-pr-status-tracking',
            {},
            { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
          );
          if (invoked !== true) {
            throw new Error('Failed to suspend PR-status tracking');
          }
        });
        await injectGithubPrStatus(electronApp, {
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          status: {
            lastCheckedAt: new Date().toISOString(),
            repos: [
              {
                repoId: '__single_repo__',
                repoName: 'app',
                prLookupAvailable: true,
                status: buildPrStatusData({
                  prNumber: 4006,
                  headBranch: 'demo-main',
                }),
              },
            ],
          },
        });
      }
      const syncAction = window.getByTestId('pr-status-bar-branch-sync');
      const syncLabel = scenario.unprepared ? /^Commit & push$/ : /^Push$/;
      const action =
        scenario.kind === 'pr'
          ? window.getByTestId('pr-status-bar-primary-action')
          : syncAction.filter({ hasText: syncLabel });
      await expect(action).toBeVisible();
      await action.click();
      const branchWarning = window.getByRole('button', {
        name: 'Continue anyway',
      });
      if (await branchWarning.isVisible()) await branchWarning.click();
      await expect(
        window.getByTestId(`github-connect-offer-${scenario.kind}`),
      ).toBeVisible();
      expect(
        await electronApp.evaluate(() => globalThis.__can4006.calls.length),
      ).toBe(scenario.kind === 'pr' ? 0 : 1);
      await electronApp.evaluate((_electron, connected) => {
        globalThis.__can4006.connected = connected;
      }, scenario.connected);
      if (scenario.cancel) {
        await window.getByTestId('github-connect-cancel').click();
      } else {
        await window
          .getByRole('dialog')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
      }
      await expect(window.getByTestId('auth-login-modal')).toHaveCount(0);
      if (scenario.review || scenario.unprepared) {
        const review = window.getByRole('dialog', {
          name: 'Review commit messages',
        });
        await expect(review).toBeVisible();
        expect(
          await electronApp.evaluate(() => globalThis.__can4006.calls.length),
        ).toBe(scenario.unprepared ? 1 : 0);
        await review
          .getByRole('button', {
            name: scenario.unprepared
              ? 'Commit & push'
              : 'Commit, push & create PR',
            exact: true,
          })
          .click();
      }
      const expectedCalls =
        scenario.kind === 'pr'
          ? 1
          : scenario.connected && !scenario.cancel
            ? 2
            : 1;
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__can4006.calls.length),
        )
        .toBe(expectedCalls);
      if (scenario.review) {
        expect(
          await electronApp.evaluate(() => ({
            reviewed:
              globalThis.__can4006.reviewedCommit.requireReviewedMessages,
            skipCommit: globalThis.__can4006.calls[0].skipCommit,
            skipPush: globalThis.__can4006.calls[0].skipPush,
          })),
        ).toEqual({ reviewed: true, skipCommit: true, skipPush: true });
      }
      if (scenario.unprepared) {
        expect(
          await electronApp.evaluate(() => globalThis.__can4006.reviewedCommit),
        ).toMatchObject({
          requireReviewedMessages: true,
          repoIds: ['__single_repo__'],
          expectedHeadBranch: 'demo-main',
        });
      }
      // A repeated close/refresh can never recreate an offer or another retry.
      await window.evaluate(() => window.api.refreshGitHubCredentials());
      await expect(
        window.getByTestId(`github-connect-offer-${scenario.kind}`),
      ).toHaveCount(0);
      expect(
        await electronApp.evaluate(() => globalThis.__can4006.calls.length),
      ).toBe(expectedCalls);
      if (scenario.retryFails)
        await expect(
          window.getByText(/Push failed for 1 repo/).first(),
        ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
