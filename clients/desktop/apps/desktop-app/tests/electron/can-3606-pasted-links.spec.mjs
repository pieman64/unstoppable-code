// CAN-3606: headless Home send guards, real renderer/store/preload paths.
// No live GitHub or Linear calls: the demo has no origin, so repository
// evidence is unknown and the link must block. These assertions count actual
// persisted resources and do not substitute a preview for worktree creation.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

async function openChats(userDataDir) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: false,
  });
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await window.getByTestId('sidebar-create-task').click();
  const home = window.getByTestId('page-home');
  await expect(home.getByTestId('home-workspace-clear')).toBeVisible();
  await home.getByTestId('home-workspace-clear').click();
  return { ...launched, window, home };
}

async function box(locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('Expected a rendered element');
  return rect;
}

// The destination hangs centered under the composer box, never inside the
// project/worktree/branch picker overhang above it.
async function expectBelowComposer(home, chip) {
  await expect(
    home
      .getByTestId('home-composer-context-overhang')
      .getByTestId('home-link-target'),
  ).toHaveCount(0);
  const composer = await box(home.getByTestId('home-composer'));
  const destination = await box(chip);
  expect(destination.y).toBeGreaterThanOrEqual(composer.y + composer.height);
  expect(destination.x + destination.width / 2).toBeCloseTo(
    composer.x + composer.width / 2,
    0,
  );
}

function worktreeCount(userDataDir) {
  const file = path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktrees.json',
  );
  if (!existsSync(file)) return 0;
  return JSON.parse(readFileSync(file, 'utf8')).worktrees.length;
}

test('immediate paste and send from Chats cannot create a Cowork task for an unresolved PR', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-blocked-'),
  );
  const { electronApp, window, home } = await openChats(userDataDir);
  try {
    const editor = home.getByTestId('home-composer-editor');
    const prompt =
      'create a worktree based on this PR https://github.com/acme/app/pull/7';
    await editor.fill(prompt);
    // The assertion after Send does not depend on a new chip being present.
    await home.getByTestId('home-send-button').click();
    await expect(home).toBeVisible();
    await expect(editor).toContainText(prompt);
    await expect(home.getByTestId('home-link-target')).toHaveAttribute(
      'data-status',
      'blocked',
    );
    expect(worktreeCount(userDataDir)).toBe(0);
    const entriesFile = path.join(
      userDataDir,
      'workspaces',
      'cowork-default',
      'work-entries.json',
    );
    if (existsSync(entriesFile)) {
      const entries = JSON.parse(readFileSync(entriesFile, 'utf8'));
      expect(entries.entries ?? []).toHaveLength(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('all competing targets remain reachable and dismissal leaves ordinary chat available', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-choice-'),
  );
  const { electronApp, home } = await openChats(userDataDir);
  try {
    const editor = home.getByTestId('home-composer-editor');
    await editor.fill(
      'https://github.com/o/a https://github.com/o/b https://github.com/o/c https://github.com/o/d',
    );
    const chip = home.getByTestId('home-link-target');
    await expect(chip).toHaveAttribute('data-status', 'blocked');
    await expectBelowComposer(home, chip);
    await expect(
      chip.getByRole('button', { name: 'o/d', exact: true }),
    ).toBeVisible();
    const fourthChoice = chip.getByRole('button', { name: 'o/d', exact: true });
    await fourthChoice.focus();
    await expect(fourthChoice).toBeFocused();
    await fourthChoice.press('Enter');
    await expect(chip).toContainText('adding o/d might duplicate a project');
    await expect(chip).toHaveAttribute('data-status', 'blocked');
    await chip.getByTestId('home-link-target-dismiss').click();
    await expect(chip).toHaveCount(0);
    await expect(home.getByTestId('home-send-button')).toBeEnabled();
    await editor.fill('plain chat after removing the links');
    await expect(chip).toHaveCount(0);
    expect(worktreeCount(userDataDir)).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the link destination sits below the composer in every state without moving it', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-placement-'),
  );
  const { electronApp, home } = await openChats(userDataDir);
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('github:get-repo-slug');
      ipcMain.handle('github:get-repo-slug', async () => {
        if (globalThis.can3606HoldPlacement) {
          await new Promise((resolve) => {
            globalThis.can3606ReleasePlacement = resolve;
          });
        }
        return { owner: 'acme', repo: 'app' };
      });
      globalThis.can3606HoldPlacement = true;
    });
    const editor = home.getByTestId('home-composer-editor');
    const chip = home.getByTestId('home-link-target');
    const heading = home.getByTestId('home-heading');
    const composer = home.getByTestId('home-composer');
    await editor.fill('https://github.com/acme/app');
    await expect(chip).toHaveAttribute('data-status', 'resolving');
    await expectBelowComposer(home, chip);
    const shown = {
      heading: await box(heading),
      composer: await box(composer),
    };
    await electronApp.evaluate(() => {
      globalThis.can3606HoldPlacement = false;
      globalThis.can3606ReleasePlacement?.();
    });
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await expectBelowComposer(home, chip);
    await chip.getByTestId('home-link-target-dismiss').click();
    await expect(chip).toHaveCount(0);
    const hidden = {
      heading: await box(heading),
      composer: await box(composer),
    };
    expect(hidden.composer.y).toBeCloseTo(shown.composer.y, 0);
    expect(hidden.composer.height).toBeCloseTo(shown.composer.height, 0);
    expect(hidden.heading.y).toBeCloseTo(shown.heading.y, 0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the project picker previews the destination a link proposes', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-picker-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-bun-api'],
    createWorktrees: false,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const repoNames = Object.fromEntries(
      seed.workspaces.map((project) => [project.repoPath, project.id]),
    );
    await electronApp.evaluate(({ ipcMain }, names) => {
      ipcMain.removeHandler('github:get-repo-slug');
      ipcMain.handle('github:get-repo-slug', (_event, request) => ({
        owner: 'acme',
        repo: names[request.repoPath] ?? 'unknown',
      }));
      ipcMain.removeHandler('github:list-user-repos');
      ipcMain.handle('github:list-user-repos', () => [
        {
          fullName: 'acme/brand-new',
          ownerLogin: 'acme',
          name: 'brand-new',
          description: null,
          cloneUrl: 'https://github.com/acme/brand-new.git',
          sshUrl: '',
          htmlUrl: 'https://github.com/acme/brand-new',
          isPrivate: false,
          isFork: false,
          isArchived: false,
          defaultBranch: 'main',
          updatedAt: null,
        },
      ]);
    }, repoNames);
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    const picker = home.getByTestId('home-workspace-select');
    const branchControls = home
      .getByTestId('home-branch-picker-button')
      .or(home.getByTestId('home-branch-picker-see-more'));
    const editor = home.getByTestId('home-composer-editor');
    const chip = home.getByTestId('home-link-target');

    // The inherited selection: the link proposes the other project.
    await expect(branchControls).toHaveCount(1);
    const selectedName = ((await picker.textContent()) ?? '').trim();
    const other = seed.workspaces.find(
      (project) => !selectedName.includes(project.name),
    );
    if (!other) throw new Error('Expected a second project');

    await editor.fill(`work on https://github.com/acme/${other.id}`);
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await expect(picker).toContainText(other.name);
    // Its branch pickers would describe the still-selected project.
    await expect(branchControls).toHaveCount(0);

    await editor.fill('work on https://github.com/acme/brand-new');
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await expect(picker).toContainText('New project');
    await expect(picker).toHaveAttribute('data-pending-workspace', 'true');

    // Preview only: dismissing restores the real selection and its pickers.
    await chip.getByTestId('home-link-target-dismiss').click();
    await expect(picker).toContainText(selectedName);
    await expect(branchControls).toHaveCount(1);

    // An explicitly cleared selection is just Chats; the link still shows.
    await home.getByTestId('home-workspace-clear').click();
    await expect(picker).toContainText('Choose project');
    await editor.fill(`work on https://github.com/acme/${other.id}`);
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await expect(picker).toContainText(other.name);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('editing during materialization releases the old submission and resolves the replacement link', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-edit-'),
  );
  const { electronApp, home } = await openChats(userDataDir);
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('github:get-repo-slug');
      ipcMain.handle('github:get-repo-slug', async () => {
        if (globalThis.can3606HoldLookup) {
          globalThis.can3606LookupPending = true;
          await new Promise((resolve) => {
            globalThis.can3606ReleaseLookup = resolve;
          });
        }
        return { owner: 'acme', repo: 'app' };
      });
    });
    const editor = home.getByTestId('home-composer-editor');
    const chip = home.getByTestId('home-link-target');
    await editor.fill('https://github.com/acme/app');
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await electronApp.evaluate(() => {
      globalThis.can3606HoldLookup = true;
    });
    await home.getByTestId('home-send-button').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.can3606LookupPending))
      .toBe(true);
    await expect(chip).toHaveAttribute('data-status', 'submitting');
    await expectBelowComposer(home, chip);
    await editor.fill('Replacement https://github.com/acme/app');
    await electronApp.evaluate(() => {
      globalThis.can3606HoldLookup = false;
      globalThis.can3606ReleaseLookup();
    });
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await expect(editor).toContainText('Replacement');
    expect(worktreeCount(userDataDir)).toBe(0);
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    await expect.poll(() => worktreeCount(userDataDir)).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('accepting a different link project preserves the source of file mentions', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-mentions-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-bun-api'],
  });
  const source = seed.workspaces.find(
    (project) => project.id === 'demo-ts-pnpm-vite',
  );
  const target = seed.workspaces.find(
    (project) => project.id === 'demo-ts-bun-api',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await electronApp.evaluate(({ ipcMain }, targetPath) => {
      ipcMain.removeHandler('github:get-repo-slug');
      ipcMain.handle('github:get-repo-slug', (_event, request) => ({
        owner: 'acme',
        repo: request.repoPath === targetPath ? 'b' : 'a',
      }));
    }, target.repoPath);
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId(`home-workspace-option-${source.id}`).click();
    await home.getByTestId('home-branch-picker-button').click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    const editor = home.getByTestId('home-composer-editor');
    await editor.fill('Check @package');
    await window
      .getByTestId('home-composer-plus-menu')
      .getByRole('button', { name: /package\.json/ })
      .first()
      .click();
    await editor.press('End');
    await editor.press(' ');
    await editor.pressSequentially('https://github.com/acme/b');
    const chip = home.getByTestId('home-link-target');
    await expect(chip).toHaveAttribute('data-status', 'blocked');
    await chip
      .getByRole('button', { name: `Use ${target.name}`, exact: true })
      .click();
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      source.name,
    );
    await expect(home).toContainText(/Remove.*file mentions/);
    await expect(editor).toContainText('package.json');
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId(`home-workspace-option-${target.id}`).click();
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      source.name,
    );
    await expect(editor).toContainText('package.json');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const stage of ['registration', 'layout']) {
  test(`cancelling during ${stage} leaves the committed worktree without opening its chat`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-can3606-cancel-'),
    );
    const { electronApp, home } = await openChats(userDataDir);
    try {
      await electronApp.evaluate(({ ipcMain }, stage) => {
        ipcMain.removeHandler('github:get-repo-slug');
        ipcMain.handle('github:get-repo-slug', () => ({
          owner: 'acme',
          repo: 'app',
        }));
        if (stage === 'registration') {
          const original = ipcMain._invokeHandlers?.get('worktree:create');
          if (!original) throw new Error('Missing worktree:create handler');
          ipcMain.removeHandler('worktree:create');
          ipcMain.handle('worktree:create', async (event, request) => {
            globalThis.can3606CancellationPending = true;
            await new Promise((resolve) => {
              globalThis.can3606ReleaseCancellation = resolve;
            });
            return original(event, request);
          });
        } else {
          ipcMain.removeHandler('panel-layout:load');
          ipcMain.handle('panel-layout:load', () => {
            globalThis.can3606CancellationPending = true;
            return new Promise((resolve) => {
              globalThis.can3606ReleaseCancellation = () =>
                resolve({ layout: null });
            });
          });
        }
      }, stage);
      const editor = home.getByTestId('home-composer-editor');
      const chip = home.getByTestId('home-link-target');
      const prompt = 'https://github.com/acme/app';
      await editor.fill(prompt);
      await expect(chip).toHaveAttribute('data-status', 'ready');
      await home.getByTestId('home-send-button').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.can3606CancellationPending),
        )
        .toBe(true);
      await chip
        .getByRole('button', { name: 'Cancel creation', exact: true })
        .click();
      await electronApp.evaluate(() => globalThis.can3606ReleaseCancellation());
      await expect.poll(() => worktreeCount(userDataDir)).toBe(1);
      await expect(home).toBeVisible();
      await expect(home).toContainText('worktree remains available');
      await expect(editor).toContainText(prompt);
      await expect(home.getByTestId('home-send-button')).toBeEnabled();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('an oversized draft can dismiss link routing without losing the draft', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-limit-'),
  );
  const { electronApp, home } = await openChats(userDataDir);
  try {
    const editor = home.getByTestId('home-composer-editor');
    const text = 'ordinary prose '.repeat(8000);
    await editor.fill(text);
    const chip = home.getByTestId('home-link-target');
    await expect(chip).toHaveAttribute('data-status', 'blocked');
    await chip.getByTestId('home-link-target-dismiss').click();
    await expect(chip).toHaveCount(0);
    await expect(editor).toContainText(text.trim());
    await expect(home.getByTestId('home-send-button')).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a repository link with long benign decorations still creates its worktree', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-decorated-'),
  );
  const { electronApp, home } = await openChats(userDataDir);
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('github:get-repo-slug');
      ipcMain.handle('github:get-repo-slug', () => ({
        owner: 'acme',
        repo: 'app',
      }));
    });
    await home
      .getByTestId('home-composer-editor')
      .fill('https://github.com/acme/app?tracking=' + 'x'.repeat(3000));
    await expect(home.getByTestId('home-link-target')).toHaveAttribute(
      'data-status',
      'ready',
    );
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    await expect.poll(() => worktreeCount(userDataDir)).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a pending scheduled worktree task does not offer a cancellation it cannot honor', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-scheduling-'),
  );
  const { electronApp, window, home } = await openChats(userDataDir);
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('github:get-repo-slug');
      ipcMain.handle('github:get-repo-slug', () => ({
        owner: 'acme',
        repo: 'app',
      }));
      const original = ipcMain._invokeHandlers.get('automations:create');
      ipcMain.removeHandler('automations:create');
      ipcMain.handle('automations:create', async (...args) => {
        globalThis.can3606SchedulePending = true;
        await new Promise((resolve) => {
          globalThis.can3606ReleaseSchedule = resolve;
        });
        return original(...args);
      });
    });
    await home
      .getByTestId('home-composer-editor')
      .fill('https://github.com/acme/app');
    const chip = home.getByTestId('home-link-target');
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await home.getByTestId('home-composer-plus-button').click();
    await window
      .getByTestId('home-composer-plus-menu')
      .getByTestId('home-schedule-button')
      .click();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await window
      .getByTestId('schedule-message-date')
      .fill(future.toISOString().slice(0, 10));
    await window.getByTestId('schedule-message-time').fill('23:00');
    await window.getByTestId('schedule-message-save').click();
    await home.getByTestId('home-send-button').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.can3606SchedulePending))
      .toBe(true);
    await expect(
      chip.getByRole('button', { name: 'Cancel creation', exact: true }),
    ).toHaveCount(0);
    await electronApp.evaluate(() => globalThis.can3606ReleaseSchedule());
    await expect(home.getByTestId('home-composer-editor')).not.toContainText(
      'https://github.com/acme/app',
    );
    await expect(
      window.getByText('Scheduled task automation created', { exact: true }),
    ).toBeVisible();
    expect(worktreeCount(userDataDir)).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('accepting a different link project preserves saved prompt mentions', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3606-prompt-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-bun-api'],
  });
  const source = seed.workspaces.find(
    (project) => project.id === 'demo-ts-pnpm-vite',
  );
  const target = seed.workspaces.find(
    (project) => project.id === 'demo-ts-bun-api',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await electronApp.evaluate(({ ipcMain }, targetPath) => {
      ipcMain.removeHandler('github:get-repo-slug');
      ipcMain.handle('github:get-repo-slug', (_event, request) => ({
        owner: 'acme',
        repo: request.repoPath === targetPath ? 'b' : 'a',
      }));
    }, target.repoPath);
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId(`home-workspace-option-${source.id}`).click();
    await home.getByTestId('home-branch-picker-button').click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    const editor = home.getByTestId('home-composer-editor');
    await window.evaluate(
      async (projectId) =>
        window.api.workspaceItems.savePrompt({
          projectId,
          title: 'Link Review',
          content: 'Review the security assumptions.',
        }),
      source.id,
    );
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId(`home-workspace-option-${target.id}`).click();
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId(`home-workspace-option-${source.id}`).click();
    await editor.fill('Check @Link');
    await window
      .getByTestId('home-composer-plus-menu')
      .getByRole('button', { name: /Link Review/ })
      .first()
      .click();
    await editor.press('End');
    await editor.press(' ');
    await editor.pressSequentially('https://github.com/acme/b');
    const chip = home.getByTestId('home-link-target');
    await expect(chip).toHaveAttribute('data-status', 'blocked');
    await chip
      .getByRole('button', { name: `Use ${target.name}`, exact: true })
      .click();
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      source.name,
    );
    await expect(home).toContainText(/Remove.*saved prompt mentions/);
    await expect(editor).toContainText('Link Review');
    await home.getByTestId('home-workspace-select').click();
    await window.getByTestId(`home-workspace-option-${target.id}`).click();
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      source.name,
    );
    await expect(editor).toContainText('Link Review');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
