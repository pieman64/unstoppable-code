import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  ORG_CONTEXT_WORKSPACE,
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

test.describe.configure({ retries: 0 });
const projectId = '33333333-3333-4333-8333-333333333333';
const instanceId = '44444444-4444-4444-8444-444444444444';
const project = {
  id: projectId,
  organizationId: ORG_CONTEXT_A,
  name: 'Acme repository',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: null,
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { use: true, administer: false, manageCloud: false },
  instance: { id: instanceId, state: 'READY' },
};

for (const outcome of [
  'ready',
  'unfinished',
  'non-member',
  'retry',
  'option-change',
  'hydration-supersession',
  'idle-revocation',
]) {
  test(`Personal existing organization folder: ${outcome}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can3648_${outcome}`;
    const organizations =
      outcome === 'non-member' ? [] : ORG_CONTEXT_ORGANIZATIONS;
    const cloud = {
      organizations,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: [
          {
            ...project,
            instance: {
              id: instanceId,
              state: outcome === 'unfinished' ? 'CLAIMED' : 'READY',
            },
          },
        ],
      },
    };
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, { cloud });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3648-'));
    seedOrgContextScoping(userDataDir);
    const repoPath = path.join(userDataDir, 'repos', ORG_CONTEXT_WORKSPACE);
    const configPath = path.join(
      userDataDir,
      'workspaces',
      ORG_CONTEXT_WORKSPACE,
      'workspace.json',
    );
    const readRegistry = () =>
      JSON.parse(
        readFileSync(
          path.join(userDataDir, 'workspaces', 'index.json'),
          'utf8',
        ),
      )
        .workspaces.map(({ id, type }) => ({ id, type }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
    const repoState = () => ({
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }),
      status: execFileSync(
        'git',
        ['status', '--porcelain', '--untracked-files=all'],
        { cwd: repoPath, encoding: 'utf8' },
      ),
      readme: readFileSync(path.join(repoPath, 'README.md'), 'utf8'),
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, apiKey);
      await app.openMainPage();
      if (outcome !== 'non-member') {
        // Scope navigation legitimately initializes organization Chats. Finish
        // that before measuring the conflict flow's no-creation guarantee.
        await selectWorkspaceContext(window, ORG_CONTEXT_A);
        await expect
          .poll(() =>
            readRegistry().some(
              ({ id }) => id === `cowork-org-${ORG_CONTEXT_A}`,
            ),
          )
          .toBe(true);
        await selectWorkspaceContext(window, 'personal');
      }
      const before = {
        registry: readRegistry(),
        owner: readConfig().owner,
        repo: repoState(),
      };
      const catalogIdentity = async () =>
        window.evaluate(async (organizationId) => {
          const snapshot = await window.api.orgProjects.list({
            context: { kind: 'organization', organizationId },
          });
          return snapshot.projects
            .map(({ id, instance }) => ({
              id,
              instanceId: instance?.id ?? null,
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
        }, ORG_CONTEXT_A);
      const beforeCatalog =
        outcome === 'non-member' ? null : await catalogIdentity();
      const activityBefore = (
        await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)
      ).activity;
      if (outcome === 'retry') {
        await electronApp.evaluate(({ ipcMain }) => {
          const original = ipcMain._invokeHandlers.get('workspace-context:set');
          ipcMain.removeHandler('workspace-context:set');
          ipcMain.handle('workspace-context:set', async (...args) => {
            ipcMain.removeHandler('workspace-context:set');
            ipcMain.handle('workspace-context:set', original);
            throw new Error('Temporary switch failure');
          });
        });
      }
      await electronApp.evaluate(
        ({ dialog }, { repoPath, delayed }) => {
          dialog.showOpenDialog = async () => {
            if (delayed)
              await new Promise((resolve) => setTimeout(resolve, 700));
            return { canceled: false, filePaths: [repoPath] };
          };
        },
        { repoPath, delayed: outcome === 'option-change' },
      );
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      const dialog = window.getByTestId('add-workspace-modal');
      await window.getByTestId('add-workspace-mode-existing').click();
      await window.getByTestId('add-workspace-choose-folder').click();
      const notice = window.getByTestId('add-workspace-org-conflict');
      if (outcome === 'option-change') {
        await window.getByTestId('add-workspace-mode-create').click();
        await expect(
          window.getByTestId('add-workspace-choose-folder'),
        ).toHaveCount(0);
        await expect
          .poll(async () =>
            window.evaluate(() =>
              document
                .querySelector('[data-testid="add-workspace-mode-create"]')
                ?.getAttribute('aria-pressed'),
            ),
          )
          .toBe('true');
        // Wait for the picker reply while staying on the new option.
        await window.waitForTimeout(1000);
        await window.getByTestId('add-workspace-mode-existing').click();
        await expect(notice).toHaveCount(0);
        await expect(
          window.getByTestId('add-workspace-choose-folder'),
        ).toBeEnabled();
      } else {
        await expect(notice).toHaveAttribute(
          'data-conflict-status',
          outcome === 'non-member'
            ? 'denied'
            : outcome === 'unfinished'
              ? 'unfinished'
              : 'ready',
        );
        if (outcome === 'idle-revocation') {
          const snapshot = await window.evaluate(
            async (organizationId) =>
              window.api.orgProjects.list({
                context: { kind: 'organization', organizationId },
              }),
            ORG_CONTEXT_A,
          );
          await electronApp.evaluate(({ BrowserWindow }, snapshot) => {
            for (const window of BrowserWindow.getAllWindows()) {
              window.webContents.send('org-projects:changed', {
                ...snapshot,
                projects: snapshot.projects.map((project) => ({
                  ...project,
                  capabilities: { ...project.capabilities, use: false },
                })),
              });
            }
          }, snapshot);
          await expect(notice).toHaveAttribute(
            'data-conflict-status',
            'denied',
          );
          await expect(notice).not.toContainText('Acme repository');
          await expect(
            window.getByTestId('add-workspace-org-conflict-open'),
          ).toHaveCount(0);
          await expect(
            window.getByTestId('add-workspace-org-conflict-cancel'),
          ).toHaveCount(0);
          await dialog.getByRole('button', { name: 'Close' }).click();
          await expect(dialog).toHaveCount(0);
        } else if (outcome === 'non-member') {
          await expect(notice).toContainText(
            "an organization you're not a member of",
          );
          await expect(notice).not.toContainText('Acme');
          await expect(
            window.getByTestId('add-workspace-org-conflict-open'),
          ).toHaveCount(0);
          await expect(
            window.getByTestId('add-workspace-org-conflict-cancel'),
          ).toHaveCount(0);
          await dialog.getByRole('button', { name: 'Close' }).click();
          await expect(dialog).toHaveCount(0);
        } else {
          const action = window.getByTestId('add-workspace-org-conflict-open');
          await expect(action).toHaveAccessibleName(
            outcome === 'unfinished' ? 'Show in Acme' : 'Open in Acme',
          );
          if (outcome === 'hydration-supersession') {
            await electronApp.evaluate(({ ipcMain }) => {
              const original = ipcMain._invokeHandlers.get(
                'workspace-context:get',
              );
              const pending = {
                started: false,
                finished: false,
                release: null,
              };
              globalThis.__can3648Hydration = pending;
              ipcMain.removeHandler('workspace-context:get');
              ipcMain.handle('workspace-context:get', async (...args) => {
                ipcMain.removeHandler('workspace-context:get');
                ipcMain.handle('workspace-context:get', original);
                pending.started = true;
                await new Promise((resolve) => {
                  pending.release = resolve;
                });
                const result = await original(...args);
                pending.finished = true;
                return result;
              });
              // Main broadcasts the switch before it answers. Widen that gap, as
              // a loaded machine does, so the remount sampler below would see
              // the dialog's cleared organization form if it painted.
              const set = ipcMain._invokeHandlers.get('workspace-context:set');
              ipcMain.removeHandler('workspace-context:set');
              ipcMain.handle('workspace-context:set', async (...args) => {
                ipcMain.removeHandler('workspace-context:set');
                ipcMain.handle('workspace-context:set', set);
                const result = await set(...args);
                await new Promise((resolve) => setTimeout(resolve, 300));
                return result;
              });
            });
          }
          await window.evaluate(() => {
            const frames = { remount: 0, running: true };
            window.__can3648Frames = frames;
            const sample = () => {
              if (
                document.querySelector(
                  '[data-testid="add-workspace-modal"] [data-testid="add-workspace-mode-catalog"]',
                )
              )
                frames.remount += 1;
              if (frames.running) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          if (outcome === 'retry') {
            await action.click();
            await expect(notice).toContainText(
              "Couldn't switch to Acme. Try again.",
            );
            await action.click();
          } else {
            await action.click();
          }
          if (outcome === 'hydration-supersession') {
            await expect(dialog).toHaveCount(0);
            await expect
              .poll(() =>
                electronApp.evaluate(
                  () => globalThis.__can3648Hydration.started,
                ),
              )
              .toBe(true);
            await selectWorkspaceContext(window, 'personal');
            await selectWorkspaceContext(window, ORG_CONTEXT_A);
            await electronApp.evaluate(() =>
              globalThis.__can3648Hydration.release(),
            );
            await expect
              .poll(() =>
                electronApp.evaluate(
                  () => globalThis.__can3648Hydration.finished,
                ),
              )
              .toBe(true);
            // Allow the released hydration and any stale catalog/open continuation
            // to finish before checking that the user's context switches won.
            await window.waitForTimeout(1000);
          }
          {
            await expectWorkspaceContext(window, ORG_CONTEXT_A);
            await expect(dialog).toHaveCount(0);
            const remountFrames = await window.evaluate(() => {
              window.__can3648Frames.running = false;
              return window.__can3648Frames.remount;
            });
            expect(remountFrames).toBe(0);
            await expect(
              window.locator(
                `[data-sidebar-workspace-id="${ORG_CONTEXT_WORKSPACE}"]`,
              ),
            ).toBeVisible();
            const selected = window
              .getByTestId('page-home')
              .getByTestId('home-workspace-select');
            if (
              outcome === 'unfinished' ||
              outcome === 'hydration-supersession'
            ) {
              await expect(
                window.locator(
                  `[data-sidebar-workspace-id="${ORG_CONTEXT_WORKSPACE}"][data-sidebar-selected-item]`,
                ),
              ).toHaveCount(0);
              await expect(window.getByTestId('page-home')).toHaveCount(0);
            } else await expect(selected).toContainText('Acme repository');
            await expect(
              window.getByTestId('org-project-setup-modal'),
            ).toHaveCount(0);
          }
        }
      }
      expect(readRegistry()).toEqual(before.registry);
      expect(readConfig().owner).toEqual(before.owner);
      if (beforeCatalog !== null)
        expect(await catalogIdentity()).toEqual(beforeCatalog);
      expect(repoState()).toEqual(before.repo);
      const activity = (
        await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)
      ).activity;
      for (const key of [
        `orgProjectClaim:${projectId}`,
        `orgProjectComplete:${projectId}`,
        `orgProjectDetach:${projectId}`,
        'orgMemberProjectCreate',
        'orgMemberMultiRepoCreate',
        'orgCoworkCreate',
        'orgCodeCreate',
      ]) {
        expect(activity[key] ?? 0).toBe(activityBefore[key] ?? 0);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}
