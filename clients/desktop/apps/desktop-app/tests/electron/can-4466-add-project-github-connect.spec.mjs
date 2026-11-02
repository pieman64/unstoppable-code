// CAN-4466: adding a project offers GitHub sign-in when the HTTPS github.com
// clone fails on credentials, then continues once. Real setup, Home send,
// offer host and continuation; only git's network, the GitHub listing and the
// credential/PTY boundary are deterministic fixtures.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  installGitHubConnectStubs,
  setGitHubConnected,
  writeGitHubCloneAuthShim,
} from './githubCloneAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startPostHogCapture } from './posthogCapture.mjs';
import {
  catalogProject,
  openSetup,
  PROJECT_ID,
  seedLocalRepository,
} from './orgProjectSetupFixture.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';

test.skip(process.platform === 'win32', 'The git shim is a POSIX script.');

const CREDENTIALS_COPY = 'GitHub access is needed to clone this repository';

async function closeOffer(window, cancel) {
  if (cancel) await window.getByTestId('github-connect-cancel').click();
  else
    await window
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
  await expect(window.getByTestId('auth-login-modal')).toHaveCount(0);
}

/** A repeated credential refresh can never recreate an offer. */
async function expectNoSecondOffer(window, testId) {
  await window.evaluate(() => window.api.refreshGitHubCredentials());
  await expect(window.getByTestId(testId)).toHaveCount(0);
  await expect(window.getByTestId('auth-login-modal')).toHaveCount(0);
}

for (const scenario of [
  { name: 'connected' },
  { name: 'retryFails' },
  { name: 'cancel' },
  { name: 'ssh' },
  { name: 'notFound' },
]) {
  test(`CAN-4466 org project setup ${scenario.name}`, async () => {
    test.setTimeout(150_000);
    const apiKey = `csk_can4466_org_${scenario.name}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'can-4466-org-')),
    );
    const { cloneBase, destination } = seedLocalRepository(userDataDir);
    if (scenario.name === 'ssh') {
      const file = path.join(userDataDir, 'preferences.json');
      const seeded = JSON.parse(readFileSync(file, 'utf8'));
      seeded.preferences.orgProjectCloneProtocol = 'ssh';
      writeFileSync(file, JSON.stringify(seeded));
    }
    const remoteUrl =
      scenario.name === 'ssh'
        ? 'git@github.com:acme/setup-repo.git'
        : 'https://github.com/acme/setup-repo.git';
    const git = writeGitHubCloneAuthShim({
      userDataDir,
      remoteUrl,
      localBareRepo: path.join(cloneBase, 'acme', 'setup-repo.git'),
    });
    git.setFailure(scenario.name === 'notFound' ? 'notfound' : 'auth');
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
      },
    });
    let electronApp;
    try {
      // No CANOPY_E2E_ORG_PROJECT_CLONE_BASE: main clones the real github.com
      // URL and only the shim rewrites it.
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: { ...ORG_CONTEXT_ENV, ...git.env },
      }));
      await installGitHubConnectStubs(electronApp);
      const { window, row } = await openSetup(electronApp, apiKey, destination);
      const offer = window.getByTestId(
        'github-connect-offer-org-project-setup',
      );
      const retry = row.getByTestId(`sidebar-org-project-retry-${PROJECT_ID}`);

      if (scenario.name === 'ssh' || scenario.name === 'notFound') {
        await expect(retry).toBeVisible({ timeout: 30_000 });
        await expect(row.getByRole('status')).toContainText(CREDENTIALS_COPY);
        await expect(window.getByTestId('auth-login-modal')).toHaveCount(0);
        expect(git.arguments()).toEqual([remoteUrl]);
        return;
      }

      await expect(offer).toBeVisible({ timeout: 30_000 });
      expect(git.arguments()).toEqual([remoteUrl]);
      await setGitHubConnected(electronApp, true);
      if (scenario.name === 'connected') git.setFailure(null);
      await closeOffer(window, scenario.name === 'cancel');

      if (scenario.name === 'connected') {
        await expect(row).toHaveCount(0, { timeout: 30_000 });
        await expect(
          window.getByTestId('org-project-setup-dialog'),
        ).toHaveCount(0);
        const { workspaces } = JSON.parse(
          readFileSync(
            path.join(userDataDir, 'workspaces', 'index.json'),
            'utf8',
          ),
        );
        expect(
          workspaces.some((entry) => entry.id.startsWith('setup-repo')),
        ).toBe(true);
      } else {
        await expect(retry).toBeVisible({ timeout: 30_000 });
        await expect(row.getByRole('status')).toContainText(CREDENTIALS_COPY);
      }
      const expectedClones = scenario.name === 'cancel' ? 1 : 2;
      await expect.poll(() => git.arguments().length).toBe(expectedClones);
      await expectNoSecondOffer(
        window,
        'github-connect-offer-org-project-setup',
      );
      expect(git.arguments()).toHaveLength(expectedClones);
      await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(
        0,
      );
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

const REMOTE_URL = 'https://github.com/acme/brand-new.git';
const REPOSITORY = {
  fullName: 'acme/brand-new',
  ownerLogin: 'acme',
  name: 'brand-new',
  description: null,
  cloneUrl: REMOTE_URL,
  sshUrl: '',
  htmlUrl: 'https://github.com/acme/brand-new',
  isPrivate: false,
  isFork: false,
  isArchived: false,
  defaultBranch: 'main',
  updatedAt: null,
};

function workspaceNames(userDataDir) {
  const { workspaces } = JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  );
  return workspaces.map((entry) => entry.name ?? entry.id);
}

function seedBareRepository(userDataDir) {
  const source = path.join(userDataDir, 'brand-new-source');
  const bare = path.join(userDataDir, 'bare', 'brand-new.git');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'README.md'), 'Brand new\n');
  for (const args of [
    ['init', '--initial-branch=main'],
    ['add', 'README.md'],
    [
      '-c',
      'user.name=Canopy Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'initial',
    ],
    ['clone', '--bare', source, bare],
  ])
    execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  return bare;
}

for (const scenario of [
  { name: 'preClone' },
  { name: 'cloneAuth' },
  { name: 'cloneAuthPostHog' },
  { name: 'retryFails' },
  { name: 'cancel' },
  { name: 'notFound' },
]) {
  test(`CAN-4466 Home link ${scenario.name}`, async () => {
    test.setTimeout(150_000);
    const telemetry = scenario.name === 'cloneAuthPostHog';
    test.skip(
      telemetry && !process.env.CANOPY_POSTHOG_STUB_URL,
      'Requires the opt-in local PostHog build',
    );
    const collector = telemetry ? await startPostHogCapture() : null;
    const sends = () =>
      collector?.events.filter(
        (event) =>
          event.event === 'chat:message_send' &&
          event.properties?.chat_surface === 'home',
      ) ?? [];
    const cloneSucceeds = scenario.name === 'cloneAuth' || telemetry;
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4466-home-'));
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      createWorktrees: false,
    });
    const git = writeGitHubCloneAuthShim({
      userDataDir,
      remoteUrl: REMOTE_URL,
      localBareRepo: seedBareRepository(userDataDir),
    });
    if (scenario.name === 'notFound') git.setFailure('notfound');
    else if (scenario.name !== 'preClone') git.setFailure('auth');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...git.env,
        ...(telemetry
          ? {
              CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
                'canopy-desktop-posthog-capture-enabled': true,
              }),
            }
          : {}),
      },
      ...(telemetry
        ? { electronArgs: ['--disable-blink-features=AutomationControlled'] }
        : {}),
    });
    let closed = false;
    try {
      await installGitHubConnectStubs(electronApp, {
        repository: REPOSITORY,
        listRequiresConnection: scenario.name === 'preClone',
      });
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      const editor = home.getByTestId('home-composer-editor');
      const chip = home.getByTestId('home-link-target');
      const error = home.getByTestId('home-composer-error');
      const offer = window.getByTestId(
        'github-connect-offer-home-link-add-project',
      );
      // A retry after a failed clone lands in a de-duplicated folder, so the
      // project name may carry a suffix; match the name, not the path.
      const brandNew = window.getByTestId(
        /^sidebar-project-toggle-brand-new(-\d+)?$/,
      );
      const prompt = 'work on https://github.com/acme/brand-new';
      await editor.fill(prompt);

      if (scenario.name === 'preClone') {
        await expect(chip).toHaveAttribute('data-status', 'blocked');
        await expect(chip).toContainText(
          'Connect GitHub to add this repository as a project.',
        );
        await chip
          .getByTestId('home-link-target-action-sign-in-github')
          .click();
        await expect(offer).toBeVisible();
        await setGitHubConnected(electronApp, true);
        await closeOffer(window, false);
        // Ready without another click, and nothing was sent.
        await expect(chip).toHaveAttribute('data-status', 'ready');
        await expect(error).toHaveCount(0);
        await expect(editor).toContainText(prompt);
        await expect(brandNew).toHaveCount(0);
        expect(git.arguments()).toEqual([]);
        return;
      }

      await expect(chip).toHaveAttribute('data-status', 'ready');
      await home.getByTestId('home-send-button').click();

      if (scenario.name === 'notFound') {
        await expect(error).toContainText('Couldn’t add acme/brand-new:');
        await expect(window.getByTestId('auth-login-modal')).toHaveCount(0);
        expect(git.arguments()).toEqual([REMOTE_URL]);
        return;
      }

      await expect(offer).toBeVisible({ timeout: 30_000 });
      if (telemetry) await expect.poll(() => sends().length).toBe(1);
      await expect(error).toHaveCount(0);
      await expect(editor).toContainText(prompt);
      expect(git.arguments()).toEqual([REMOTE_URL]);
      await setGitHubConnected(electronApp, true);
      if (cloneSucceeds) git.setFailure(null);
      await closeOffer(window, scenario.name === 'cancel');

      if (cloneSucceeds) {
        // One automatic resend, without pressing Try again.
        await expect(brandNew).toBeVisible({ timeout: 30_000 });
        await expect(error).toHaveCount(0);
        expect(
          workspaceNames(userDataDir).filter((name) =>
            /^brand-new(-\d+)?$/.test(name),
          ),
        ).toHaveLength(1);
      } else {
        await expect(error).toContainText('Couldn’t add acme/brand-new:', {
          timeout: 30_000,
        });
        await expect(home.getByTestId('home-composer-retry')).toBeVisible();
        await expect(editor).toContainText(prompt);
        await expect(brandNew).toHaveCount(0);
      }
      const expectedClones = scenario.name === 'cancel' ? 1 : 2;
      await expect.poll(() => git.arguments().length).toBe(expectedClones);
      await expectNoSecondOffer(
        window,
        'github-connect-offer-home-link-add-project',
      );
      expect(git.arguments()).toHaveLength(expectedClones);
      if (collector) {
        // Closing the window flushes the SDK queue, including any event
        // incorrectly recorded by the automatic GitHub-connect resume.
        await closeCanopy(electronApp, userDataDir);
        closed = true;
        expect(sends()).toHaveLength(1);
      }
    } finally {
      if (!closed) await closeCanopy(electronApp, userDataDir);
      if (collector) await collector.shutdown();
    }
  });
}
