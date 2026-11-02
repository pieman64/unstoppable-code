import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { openProjectSettingsPage } from './projectSettingsDriver.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedWorkspace(userDataDir) {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-apply-'));
  const sourceRepoPath = path.join(fixtureDir, 'source');
  const workspaceId = 'apply-workspace';
  const worktreeId = 'wt-1';
  const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
  const worktreePath = path.join(workspaceDir, 'worktrees', worktreeId);

  mkdirSync(sourceRepoPath, { recursive: true });
  git(sourceRepoPath, ['init']);
  git(sourceRepoPath, ['config', 'user.email', 'test@example.com']);
  git(sourceRepoPath, ['config', 'user.name', 'Canopy Test']);
  writeJson(path.join(sourceRepoPath, 'canopy.json'), {
    version: 1,
    scripts: {},
    repos: [],
  });
  git(sourceRepoPath, ['add', 'canopy.json']);
  git(sourceRepoPath, ['commit', '-m', 'initial']);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(sourceRepoPath, ['worktree', 'add', '-b', worktreeId, worktreePath]);

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        name: 'Apply Project',
        type: 'multi-repo',
        color: '#38bdf8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [],
    sourceRepoPath,
    alwaysShow: true,
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: worktreeId,
        branchName: worktreeId,
        createdAt: '2026-05-14T00:00:00.000Z',
      },
    ],
  });

  return { fixtureDir, workspaceId, worktreeId, worktreePath, sourceRepoPath };
}

function seedProject(userDataDir) {
  const fixtureDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-project-apply-'),
  );
  const repoPath = path.join(fixtureDir, 'repo');
  const projectId = 'apply-project';
  const worktreeId = 'wt-1';
  const projectDir = path.join(userDataDir, 'workspaces', projectId);
  const worktreePath = path.join(projectDir, 'worktrees', worktreeId);

  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Canopy Test']);
  writeJson(path.join(repoPath, 'canopy.json'), {
    version: 1,
    scripts: {},
  });
  git(repoPath, ['add', 'canopy.json']);
  git(repoPath, ['commit', '-m', 'initial']);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repoPath, ['worktree', 'add', '-b', worktreeId, worktreePath]);

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: projectId,
        name: 'Apply Project',
        type: 'single-repo',
        color: '#38bdf8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(path.join(projectDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(projectDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: worktreeId,
        branchName: worktreeId,
        createdAt: '2026-05-14T00:00:00.000Z',
      },
    ],
  });

  return { fixtureDir, projectId, worktreeId, worktreePath, repoPath };
}

for (const mode of ['Update', 'Replace']) {
  test(`conversion surfaces instruction resolver permission failure (${mode})`, async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'agents-permission-convert-'),
    );
    const fixture = seedProject(userDataDir);
    git(fixture.repoPath, ['worktree', 'remove', fixture.worktreePath]);
    const projectDir = path.join(userDataDir, 'workspaces', fixture.projectId);
    writeJson(path.join(projectDir, 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    const agentsPath = path.join(fixture.repoPath, 'AGENTS.md');
    const claudePath = path.join(fixture.repoPath, 'CLAUDE.md');
    const original = '# Original project guidance\n';
    writeFileSync(agentsPath, original);
    writeFileSync(claudePath, original);
    const { electronApp } = await launchCanopy({ userDataDir });
    const window = await electronApp.firstWindow();
    try {
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.workspaceHeaderLabel('Apply Project').hover();
      await app.workspaceSettingsButton('Apply Project').click();
      const dialog = window.getByRole('dialog', { name: 'Apply Project' });
      // Converting is a row of General; its choices open in a small dialog.
      await dialog
        .getByRole('button', { name: 'Convert…', exact: true })
        .click();
      const convert = window.getByTestId('project-settings-convert-dialog');
      chmodSync(claudePath, 0o000);
      expect(() => readFileSync(claudePath)).toThrow(/EACCES/);
      await convert.getByRole('button', { name: mode, exact: true }).click();
      await expect(
        window.getByText(/EACCES.*permission denied/).first(),
      ).toBeVisible();
      await expect(dialog).toBeVisible();
      expect(
        JSON.parse(
          readFileSync(path.join(projectDir, 'workspace.json'), 'utf8'),
        ).type,
      ).toBe('single-repo');
      expect(readFileSync(agentsPath, 'utf8')).toBe(original);
    } catch (error) {
      await testInfo.attach('conversion-permission-state.json', {
        body: JSON.stringify({
          body: await window.locator('body').innerText(),
          workspace: JSON.parse(
            readFileSync(path.join(projectDir, 'workspace.json'), 'utf8'),
          ),
          agents: readFileSync(agentsPath, 'utf8'),
        }),
        contentType: 'application/json',
      });
      throw error;
    } finally {
      chmodSync(claudePath, 0o644);
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });
}

test('Add to Worktree surfaces instruction resolver permission failure', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'agents-permission-apply-'),
  );
  const fixture = seedWorkspace(userDataDir);
  const original = '# Original worktree guidance\n';
  for (const directory of [fixture.sourceRepoPath, fixture.worktreePath]) {
    writeFileSync(path.join(directory, 'AGENTS.md'), original);
    writeFileSync(path.join(directory, 'CLAUDE.md'), original);
  }
  const agentsPath = path.join(fixture.worktreePath, 'AGENTS.md');
  const claudePath = path.join(fixture.worktreePath, 'CLAUDE.md');
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await dialog
      .getByRole('tab', { name: 'Instructions', exact: true })
      .click();
    await dialog.getByRole('button', { name: /Default branch/ }).click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /wt-1/ })
      .click();
    const editor = dialog.getByTestId('workspace-instructions-textarea');
    await expect(editor).toHaveValue(original);
    await editor.fill('# Requested replacement guidance\n');
    chmodSync(claudePath, 0o000);
    expect(() => readFileSync(claudePath)).toThrow(/EACCES/);
    await dialog
      .getByRole('button', { name: 'Add to worktree', exact: true })
      .click();
    await expect(
      window.getByText(/EACCES.*permission denied/).first(),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(editor).toHaveValue('# Requested replacement guidance\n');
    expect(readFileSync(agentsPath, 'utf8')).toBe(original);
  } catch (error) {
    await testInfo.attach('apply-permission-state.json', {
      body: JSON.stringify({
        body: await window.locator('body').innerText(),
        agents: readFileSync(agentsPath, 'utf8'),
      }),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    chmodSync(claudePath, 0o644);
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

for (const layout of ['indirect-alias', 'missing-instructions']) {
  test(`conversion handles ${layout} without losing effective guidance`, async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'agents-alias-conversion-'),
    );
    const fixture = seedProject(userDataDir);
    git(fixture.repoPath, ['worktree', 'remove', fixture.worktreePath]);
    writeJson(
      path.join(userDataDir, 'workspaces', fixture.projectId, 'worktrees.json'),
      { version: 1, worktrees: [] },
    );
    const localClaudePath = path.join(fixture.repoPath, 'CLAUDE.md');
    const externalClaudePath = path.join(
      fixture.fixtureDir,
      'outside',
      'CLAUDE.md',
    );
    if (layout === 'indirect-alias') {
      mkdirSync(path.join(fixture.fixtureDir, 'outside', 'nested'), {
        recursive: true,
      });
      writeFileSync(externalClaudePath, '# External fixture guidance\n');
      writeFileSync(localClaudePath, '# Independent local guidance\n');
      symlinkSync('../outside/nested', path.join(fixture.repoPath, 'escape'));
      symlinkSync(
        'escape/../CLAUDE.md',
        path.join(fixture.repoPath, 'AGENTS.md'),
      );
      expect(
        readFileSync(path.join(fixture.repoPath, 'AGENTS.md'), 'utf8'),
      ).toBe('# External fixture guidance\n');
    }
    const { electronApp } = await launchCanopy({ userDataDir });
    const window = await electronApp.firstWindow();
    try {
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.workspaceHeaderLabel('Apply Project').hover();
      await app.workspaceSettingsButton('Apply Project').click();
      const dialog = window.getByRole('dialog', { name: 'Apply Project' });
      // Converting is a row of General; its choices open in a small dialog.
      await dialog
        .getByRole('button', { name: 'Convert…', exact: true })
        .click();
      const convert = window.getByTestId('project-settings-convert-dialog');
      await convert
        .getByRole('button', { name: 'Update', exact: true })
        .click();
      await expect(dialog).toBeHidden();
      if (layout === 'indirect-alias') {
        expect(readFileSync(localClaudePath, 'utf8')).toBe(
          '# Independent local guidance\n',
        );
        expect(readFileSync(externalClaudePath, 'utf8')).toBe(
          '# External fixture guidance\n',
        );
        expect(readlinkSync(path.join(fixture.repoPath, 'AGENTS.md'))).toBe(
          'escape/../CLAUDE.md',
        );
      } else {
        const guidance = readFileSync(
          path.join(fixture.repoPath, 'AGENTS.md'),
          'utf8',
        );
        await testInfo.attach('generated-guidance.txt', {
          body: guidance,
          contentType: 'text/plain',
        });
        for (const paragraph of guidance.split('\n\n').slice(1, 4)) {
          expect(paragraph).toContain('AGENTS.md');
          expect(paragraph).toContain('CLAUDE.md');
        }
      }
    } catch (error) {
      await testInfo.attach('conversion-guidance-error.txt', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
      throw error;
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });
}

test('Initialize instructions includes AGENTS-only child repository guidance', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'agents-initialize-'));
  const fixture = seedWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await dialog
      .getByRole('tab', { name: 'Instructions', exact: true })
      .click();
    await dialog.getByRole('button', { name: /Default branch/ }).click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /wt-1/ })
      .click();
    await dialog
      .getByRole('button', { name: 'Initialize', exact: true })
      .click();
    const editor = dialog.getByTestId('workspace-instructions-textarea');
    await expect(editor).toHaveValue(/AGENTS\.md/);
    const guidance = await editor.inputValue();
    for (const paragraph of guidance.split('\n\n').slice(1, 4)) {
      expect(paragraph).toContain('AGENTS.md');
      expect(paragraph).toContain('CLAUDE.md');
    }
    await dialog
      .getByRole('button', { name: 'Add to worktree', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(
      readFileSync(path.join(fixture.worktreePath, 'AGENTS.md'), 'utf8'),
    ).toBe(guidance);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

for (const entryKind of ['directory', 'symlink']) {
  test(`conversion preserves unsupported instructions (${entryKind})`, async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'agents-conversion-'),
    );
    const fixture = seedProject(userDataDir);
    git(fixture.repoPath, ['worktree', 'remove', fixture.worktreePath]);
    const projectDir = path.join(userDataDir, 'workspaces', fixture.projectId);
    writeJson(path.join(projectDir, 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    const instructionsPath = path.join(fixture.repoPath, 'AGENTS.md');
    const contentPath =
      entryKind === 'directory'
        ? path.join(instructionsPath, 'rules.md')
        : path.join(fixture.repoPath, 'docs', 'AGENTS.md');
    mkdirSync(path.dirname(contentPath), { recursive: true });
    writeFileSync(contentPath, '# Preserve my existing rules\n');
    if (entryKind === 'symlink')
      symlinkSync('docs/AGENTS.md', instructionsPath);
    const { electronApp } = await launchCanopy({ userDataDir });
    const window = await electronApp.firstWindow();
    try {
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.workspaceHeaderLabel('Apply Project').hover();
      await app.workspaceSettingsButton('Apply Project').click();
      const dialog = window.getByRole('dialog', { name: 'Apply Project' });
      // Converting is a row of General; its choices open in a small dialog.
      await dialog
        .getByRole('button', { name: 'Convert…', exact: true })
        .click();
      const convert = window.getByTestId('project-settings-convert-dialog');
      await convert
        .getByRole('button', {
          name: entryKind === 'symlink' ? 'Leave unchanged' : 'Update',
          exact: true,
        })
        .click();
      await expect(dialog).toBeHidden();
      expect(
        JSON.parse(
          readFileSync(path.join(projectDir, 'workspace.json'), 'utf8'),
        ).type,
      ).toBe('multi-repo');
      expect(
        JSON.parse(
          readFileSync(path.join(fixture.repoPath, 'canopy.json'), 'utf8'),
        ).repos,
      ).toEqual([]);
      expect(readFileSync(contentPath, 'utf8')).toBe(
        '# Preserve my existing rules\n',
      );
      if (entryKind === 'symlink')
        expect(readlinkSync(instructionsPath)).toBe('docs/AGENTS.md');
      else expect(lstatSync(instructionsPath).isDirectory()).toBe(true);
    } catch (error) {
      await testInfo.attach('instruction-conversion-error.txt', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
      throw error;
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });

  test(`Add to Worktree preserves unsupported instructions (${entryKind})`, async ({}, testInfo) => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'agents-script-apply-'),
    );
    const fixture = seedWorkspace(userDataDir);
    writeFileSync(
      path.join(fixture.sourceRepoPath, 'AGENTS.md'),
      '# Source rules\n',
    );
    const instructionsPath = path.join(fixture.worktreePath, 'AGENTS.md');
    const contentPath =
      entryKind === 'directory'
        ? path.join(instructionsPath, 'rules.md')
        : path.join(fixture.worktreePath, 'docs', 'AGENTS.md');
    mkdirSync(path.dirname(contentPath), { recursive: true });
    writeFileSync(contentPath, '# Preserve worktree rules\n');
    if (entryKind === 'symlink')
      symlinkSync('docs/AGENTS.md', instructionsPath);
    const { electronApp } = await launchCanopy({ userDataDir });
    const window = await electronApp.firstWindow();
    try {
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.workspaceHeaderLabel('Apply Project').hover();
      await app.workspaceSettingsButton('Apply Project').click();
      const dialog = window.getByRole('dialog', { name: 'Apply Project' });
      await dialog.getByRole('tab', { name: 'Scripts' }).click();
      await dialog.getByRole('button', { name: 'Source controlled' }).click();
      await dialog.getByRole('button', { name: /Default branch/ }).click();
      await window
        .getByRole('listbox')
        .getByRole('option', { name: /wt-1/ })
        .click();
      await dialog
        .getByPlaceholder('workspace-check', { exact: true })
        .fill('verify-guidance');
      await dialog
        .getByPlaceholder(
          '# Triggered manually from the project root\nnpm run lint',
          { exact: true },
        )
        .fill('echo verified');
      await dialog
        .getByRole('button', { name: 'Add script', exact: true })
        .click();
      await dialog
        .getByRole('button', { name: 'Add to worktree', exact: true })
        .click();
      await expect(dialog).toBeHidden();
      expect(
        JSON.parse(
          readFileSync(path.join(fixture.worktreePath, 'canopy.json'), 'utf8'),
        ).scripts['verify-guidance'],
      ).toBe('echo verified');
      expect(readFileSync(contentPath, 'utf8')).toBe(
        '# Preserve worktree rules\n',
      );
      if (entryKind === 'symlink')
        expect(readlinkSync(instructionsPath)).toBe('docs/AGENTS.md');
      else expect(lstatSync(instructionsPath).isDirectory()).toBe(true);
    } catch (error) {
      await testInfo.attach('instruction-apply-error.txt', {
        body: await window.locator('body').innerText(),
        contentType: 'text/plain',
      });
      throw error;
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });
}

test('project settings opened from the sidebar render in the document-body browser-native overlay', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  const fixture = seedWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    // The always-mounted Home surface also renders the workspace name in its
    // picker. Scope the hover and action to the sidebar row so the hover-only
    // settings button is revealed on the intended workspace header.
    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await expect(dialog).toBeVisible();
    // Project model persistence is not available on this host yet.
    await expect(
      dialog.getByRole('combobox', { name: 'Default model' }),
    ).toHaveCount(0);

    const placement = await dialog.evaluate((node) => {
      const overlay = node.closest(
        '[data-canopy-browser-native-overlay="true"]',
      );
      const sidebar = document.querySelector('[data-testid="app-sidebar"]');
      const mainPage = document.querySelector('[data-testid="page-main"]');

      return {
        overlayParentIsBody: overlay?.parentElement === document.body,
        dialogInsideSidebar: sidebar?.contains(node) ?? false,
        overlayInsideMainPage: overlay ? mainPage?.contains(overlay) : false,
      };
    });

    expect(placement).toEqual({
      overlayParentIsBody: true,
      dialogInsideSidebar: false,
      overlayInsideMainPage: false,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('project instructions preserve and edit a standalone AGENTS.md', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'agents-editor-'));
  const fixture = seedWorkspace(userDataDir);
  const instructionsPath = path.join(fixture.sourceRepoPath, 'AGENTS.md');
  const original = '# Project guidance\nPreserve these established rules.\n';
  writeFileSync(instructionsPath, original);
  const worktreeInstructionsPath = path.join(fixture.worktreePath, 'AGENTS.md');
  writeFileSync(worktreeInstructionsPath, original);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await dialog
      .getByRole('tab', { name: /^(CLAUDE\.md|Instructions)$/ })
      .click();
    await dialog.getByRole('button', { name: /Default branch/ }).click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /wt-1/ })
      .click();
    const editor = dialog.getByTestId('workspace-instructions-textarea');
    await expect(editor).toHaveValue(original);
    await editor.fill(`${original}Use npm test.\n`);
    await dialog.getByRole('button', { name: 'Add to worktree' }).click();
    await expect
      .poll(() => readFileSync(worktreeInstructionsPath, 'utf8'))
      .toBe(`${original}Use npm test.\n`);
    expect(readFileSync(instructionsPath, 'utf8')).toBe(original);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('multi-repo project Add to Worktree closes promptly after source script write', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  const fixture = seedWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await expect(dialog).toBeVisible();
    // Project model persistence is not available on this host yet.
    await expect(
      dialog.getByRole('combobox', { name: 'Default model' }),
    ).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Scripts' }).click();
    await dialog.getByRole('button', { name: 'Source controlled' }).click();
    await expect(
      dialog.locator('input[placeholder="workspace-check"]'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: /Default branch/ }).click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /wt-1/ })
      .click();

    await dialog.locator('input[placeholder="workspace-check"]').fill('fake');
    await dialog
      .locator('textarea')
      .filter({ hasText: '' })
      .last()
      .fill('echo fake');
    await dialog.getByRole('button', { name: 'Add script' }).click();

    const clickAt = Date.now();
    await dialog.getByRole('button', { name: 'Add to worktree' }).click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
    const closeAt = Date.now();

    const manifest = JSON.parse(
      readFileSync(path.join(fixture.worktreePath, 'canopy.json'), 'utf8'),
    );
    expect(manifest.scripts.fake).toBe('echo fake');
    expect(closeAt - clickAt).toBeLessThan(3000);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('single-repo project Add to Worktree closes promptly after source script write', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  const fixture = seedProject(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await expect(dialog).toBeVisible();
    // Project model persistence is not available on this host yet.
    await expect(
      dialog.getByRole('combobox', { name: 'Default model' }),
    ).toHaveCount(0);
    // Scripts and hooks: canopy.json changes, read from the worktree.
    await openProjectSettingsPage(app, 'scripts');
    await dialog.getByTestId('project-settings-scope-source').click();
    await expect(dialog.getByText('Setup script')).toBeVisible();
    await dialog.getByRole('button', { name: /Default branch/ }).click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /wt-1/ })
      .click();

    await dialog.getByTestId('project-settings-script-edit-setup').click();
    await dialog.locator('textarea').first().fill('echo fake');
    const windowsShell = dialog.getByRole('combobox', {
      name: 'Setup script Windows shell',
    });
    const macShell = dialog.getByRole('combobox', {
      name: 'Setup script Mac shell',
    });
    const linuxShell = dialog.getByRole('combobox', {
      name: 'Setup script Linux shell',
    });
    await expect(linuxShell).toHaveAttribute('data-value', '');
    await expect(linuxShell).toHaveText('Default (Bash)');
    await chooseSettingsOption(windowsShell, 'bash');
    await chooseSettingsOption(macShell, 'zsh');
    await chooseSettingsOption(linuxShell, 'bash');
    await expect(linuxShell).toHaveAttribute('data-value', 'bash');
    await chooseSettingsOption(linuxShell, '');
    await expect(linuxShell).toHaveAttribute('data-value', '');
    await chooseSettingsOption(linuxShell, 'zsh');
    await expect(windowsShell).toHaveAttribute('data-value', 'bash');
    await expect(macShell).toHaveAttribute('data-value', 'zsh');
    await expect(linuxShell).toHaveAttribute('data-value', 'zsh');

    const clickAt = Date.now();
    await dialog.getByRole('button', { name: 'Add to worktree' }).click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
    const closeAt = Date.now();

    const manifest = JSON.parse(
      readFileSync(path.join(fixture.worktreePath, 'canopy.json'), 'utf8'),
    );
    expect(manifest.scripts.setup).toEqual({
      command: 'echo fake',
      shell: {
        windows: 'bash',
        mac: 'zsh',
        linux: 'zsh',
      },
    });
    expect(closeAt - clickAt).toBeLessThan(3000);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('project Add to new Worktree closes promptly after source script write', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-electron-'));
  const fixture = seedWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();

    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await expect(dialog).toBeVisible();
    // Project model persistence is not available on this host yet.
    await expect(
      dialog.getByRole('combobox', { name: 'Default model' }),
    ).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Scripts' }).click();
    await dialog.getByRole('button', { name: 'Source controlled' }).click();
    await expect(
      dialog.locator('input[placeholder="workspace-check"]'),
    ).toBeVisible();

    await dialog
      .locator('input[placeholder="workspace-check"]')
      .fill('fake-new');
    await dialog
      .locator('textarea')
      .filter({ hasText: '' })
      .last()
      .fill('echo fake-new');
    await dialog.getByRole('button', { name: 'Add script' }).click();

    const clickAt = Date.now();
    await dialog.getByRole('button', { name: 'Add to new worktree' }).click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
    const closeAt = Date.now();

    const worktrees = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          fixture.workspaceId,
          'worktrees.json',
        ),
        'utf8',
      ),
    );
    const newWorktree = worktrees.worktrees.find(
      (worktree) => worktree.id !== fixture.worktreeId,
    );
    expect(newWorktree).toBeTruthy();
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          fixture.workspaceId,
          'worktrees',
          newWorktree.id,
          'canopy.json',
        ),
        'utf8',
      ),
    );
    expect(manifest.scripts['fake-new']).toBe('echo fake-new');
    expect(closeAt - clickAt).toBeLessThan(3000);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

// CAN-1207: a non-ENOENT instructions read failure must not open as a blank,
// saveable editor — a save would overwrite the real file.
test('instructions read failure shows an error and blocks overwriting', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'instructions-load-error-'),
  );
  const fixture = seedWorkspace(userDataDir);
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    fixture.workspaceId,
  );
  // Local-only multi-repo workspace: instructions live in the workspace dir.
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [],
    alwaysShow: true,
  });
  const instructionsPath = path.join(workspaceDir, 'CLAUDE.md');
  const original = '# Local project guidance\n';
  writeFileSync(instructionsPath, original);
  chmodSync(instructionsPath, 0o000);
  expect(() => readFileSync(instructionsPath)).toThrow(/EACCES/);
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await dialog
      .getByRole('tab', { name: 'Instructions', exact: true })
      .click();

    const notice = dialog.getByTestId('workspace-instructions-load-error');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Couldn't load instructions");
    const editor = dialog.getByTestId('workspace-instructions-textarea');
    await expect(editor).toHaveAttribute('readonly', '');
    await expect(
      dialog.getByRole('button', { name: 'Initialize', exact: true }),
    ).toHaveCount(0);
    await editor.press('X');
    await expect(editor).toHaveValue('');
    await expect(
      dialog.getByRole('button', { name: 'Save local', exact: true }),
    ).toHaveCount(0);

    chmodSync(instructionsPath, 0o644);
    await dialog.getByTestId('workspace-instructions-load-retry').click();
    await expect(notice).toHaveCount(0);
    await expect(editor).toHaveValue(original);
    await expect(editor).not.toHaveAttribute('readonly', '');
    expect(readFileSync(instructionsPath, 'utf8')).toBe(original);
  } catch (error) {
    await testInfo.attach('instructions-load-error-state.json', {
      body: JSON.stringify({
        body: await window.locator('body').innerText(),
      }),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    chmodSync(instructionsPath, 0o644);
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('source apply leaves instructions untouched after their initial read fails', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'instructions-source-load-error-'),
  );
  const fixture = seedWorkspace(userDataDir);
  const sourceInstructionsPath = path.join(fixture.sourceRepoPath, 'CLAUDE.md');
  const worktreeInstructionsPath = path.join(fixture.worktreePath, 'CLAUDE.md');
  const original = '# Existing source guidance\n';
  writeFileSync(sourceInstructionsPath, original);
  writeFileSync(worktreeInstructionsPath, original);
  chmodSync(sourceInstructionsPath, 0o000);
  expect(() => readFileSync(sourceInstructionsPath)).toThrow(/EACCES/);
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.workspaceHeaderLabel('Apply Project').hover();
    await app.workspaceSettingsButton('Apply Project').click();
    const dialog = window.getByRole('dialog', { name: 'Apply Project' });
    await dialog
      .getByRole('tab', { name: 'Instructions', exact: true })
      .click();
    await expect(
      dialog.getByTestId('workspace-instructions-load-error'),
    ).toBeVisible();

    await dialog.getByRole('tab', { name: 'Scripts', exact: true }).click();
    await dialog
      .getByRole('button', { name: 'Source controlled', exact: true })
      .click();
    await dialog.getByRole('button', { name: /Default branch/ }).click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /wt-1/ })
      .click();
    await dialog
      .getByPlaceholder('workspace-check', { exact: true })
      .fill('preserve-guidance');
    await dialog
      .getByPlaceholder(
        '# Triggered manually from the project root\nnpm run lint',
        { exact: true },
      )
      .fill('echo preserved');
    await dialog
      .getByRole('button', { name: 'Add script', exact: true })
      .click();
    await dialog
      .getByRole('button', { name: 'Add to worktree', exact: true })
      .click();
    await expect(dialog).toBeHidden();

    expect(readFileSync(worktreeInstructionsPath, 'utf8')).toBe(original);
    expect(
      JSON.parse(
        readFileSync(path.join(fixture.worktreePath, 'canopy.json'), 'utf8'),
      ).scripts['preserve-guidance'],
    ).toBe('echo preserved');
  } catch (error) {
    await testInfo.attach('instructions-source-load-error-state.json', {
      body: JSON.stringify({
        body: await window.locator('body').innerText(),
      }),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    chmodSync(sourceInstructionsPath, 0o644);
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});
