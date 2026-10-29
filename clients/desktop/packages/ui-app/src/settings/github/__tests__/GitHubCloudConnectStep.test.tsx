/**
 * @jest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WEB_BRANDS } from '@canopy/brand/web';
import type { SettingsBrand } from '../../host';
import { GitHubTestHost } from './helpers/github-test-host';
import type {
  GitHubCloudConnectionDto,
  GitHubCloudTargetDto,
} from '@canopy/protocol/settings/account-github';
import { GITHUB_CLOUD_ERROR_COPY } from '@canopy/protocol/settings/github-cloud-errors';
import { GitHubCloudConnectStep } from '../GitHubCloudConnectStep';
import {
  isGitHubCloudReady,
  type GitHubCloudSelectedAccount,
} from '../github-cloud-readiness';
import type {
  GitHubCloudConnectionController,
  GitHubCloudControllerError,
} from '../use-github-cloud-connection';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const canopyBrand: SettingsBrand = ((): SettingsBrand => {
  const brand = WEB_BRANDS.find((entry) => entry.id === 'canopy');
  if (!brand) {
    throw new Error(
      'WEB_BRANDS does not include the default canopy brand - has the brand cache been prepared?',
    );
  }
  return {
    id: brand.id,
    displayName: brand.displayName,
    internalName: brand.internalName,
  };
})();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The controller's own copy for the owner-approval notice (a view never
// imports the hook module, so the string is restated here).
const GITHUB_CLOUD_REQUESTED_COPY =
  'Your request to install the GitHub app was sent. An owner of that GitHub organization needs to approve it.';

const PERSONAL_ID = '1001';
const ACME_ID = '2002';
const BETA_ID = '3003';

function target(
  overrides: Partial<GitHubCloudTargetDto> = {},
): GitHubCloudTargetDto {
  return {
    id: '6f1c2c1e-0000-4000-8000-000000000001',
    installationId: PERSONAL_ID,
    accountLogin: 'octocat',
    accountType: 'User',
    repositorySelection: 'all',
    state: 'ACTIVE',
    ...overrides,
  };
}

function acme(
  state: GitHubCloudTargetDto['state'] = 'ACTIVE',
): GitHubCloudTargetDto {
  return target({
    id: '6f1c2c1e-0000-4000-8000-000000000002',
    installationId: ACME_ID,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
    state,
  });
}

function beta(
  state: GitHubCloudTargetDto['state'] = 'ACTIVE',
): GitHubCloudTargetDto {
  return target({
    id: '6f1c2c1e-0000-4000-8000-000000000003',
    installationId: BETA_ID,
    accountLogin: 'beta-labs',
    accountType: 'Organization',
    state,
  });
}

/**
 * A second installation row for the same login: a removed installation stays
 * listed as REMOVED beside a newer reinstall (the store only re-stamps unseen
 * rows), and the server sorts them by installation id ascending, so the older
 * row comes first.
 */
function acmeAgain(
  state: GitHubCloudTargetDto['state'] = 'ACTIVE',
): GitHubCloudTargetDto {
  return target({
    id: '6f1c2c1e-0000-4000-8000-000000000004',
    installationId: '9009',
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
    state,
  });
}

function connection(
  overrides: Partial<GitHubCloudConnectionDto> = {},
): GitHubCloudConnectionDto {
  return {
    state: 'ACTIVE',
    githubLogin: 'octocat',
    verifiedAt: '2026-10-05T10:00:00.000Z',
    readyForProjects: true,
    targets: [target()],
    ...overrides,
  };
}

const DISCONNECTED = connection({
  state: 'DISCONNECTED',
  githubLogin: null,
  verifiedAt: null,
  readyForProjects: false,
  targets: [],
});
const NEEDS_REAUTH = connection({
  state: 'NEEDS_REAUTH',
  readyForProjects: false,
});
const NEEDS_INSTALL = connection({
  state: 'NEEDS_INSTALL',
  readyForProjects: false,
  targets: [],
});
const PENDING = connection({
  readyForProjects: false,
  targets: [target({ state: 'PENDING_ADOPTION' })],
});

function needsInstallWith(
  ...targets: GitHubCloudTargetDto[]
): GitHubCloudConnectionDto {
  return connection({
    state: 'NEEDS_INSTALL',
    readyForProjects: false,
    targets,
  });
}

function controllerError(
  overrides: Partial<GitHubCloudControllerError> = {},
): GitHubCloudControllerError {
  return {
    source: 'verify',
    code: null,
    message: "Couldn't check your GitHub connection. Try again.",
    ...overrides,
  };
}

function makeController(
  overrides: Partial<GitHubCloudConnectionController> = {},
): GitHubCloudConnectionController {
  return {
    connection: null,
    loading: false,
    checking: false,
    verified: false,
    stale: false,
    busy: null,
    error: null,
    notice: null,
    connect: jest.fn(() => Promise.resolve()),
    verify: jest.fn(() => Promise.resolve()),
    disconnect: jest.fn(() => Promise.resolve(true)),
    reload: jest.fn(),
    dismissNotice: jest.fn(),
    clearError: jest.fn(),
    ...overrides,
  };
}

/** A fresh live check that found a usable, adopted account. */
function readyController(
  overrides: Partial<GitHubCloudConnectionController> = {},
): GitHubCloudConnectionController {
  return makeController({
    connection: connection(),
    verified: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

type StepOptions = {
  readonly onReady?: jest.Mock;
  readonly brand?: SettingsBrand;
  readonly strict?: boolean;
} & GitHubCloudSelectedAccount;

/** The selection part of the options, typed as the step's own union. */
function selectionOf(options: StepOptions): GitHubCloudSelectedAccount {
  return options;
}

function render(
  controller: GitHubCloudConnectionController,
  options: StepOptions = {},
): jest.Mock {
  const onReady = options.onReady ?? jest.fn();
  const tree = (
    <GitHubTestHost brand={options.brand ?? canopyBrand}>
      <GitHubCloudConnectStep
        controller={controller}
        onReady={onReady}
        {...selectionOf(options)}
      />
    </GitHubTestHost>
  );
  act(() => {
    root.render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  return onReady;
}

function find(testId: string, scope: ParentNode = container): HTMLElement {
  const element = scope.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`missing [data-testid="${testId}"]`);
  return element;
}

function findAll(testId: string, scope: ParentNode = container): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  );
}

function maybe(testId: string, scope: ParentNode = container): boolean {
  return scope.querySelector(`[data-testid="${testId}"]`) !== null;
}

function text(testId: string): string {
  return find(testId).textContent ?? '';
}

function stepText(): string {
  return container.textContent ?? '';
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

function actionLabels(): (string | null)[] {
  return Array.from(
    find('github-cloud-actions').querySelectorAll('button'),
  ).map((button) => button.textContent);
}

function rowLogins(): (string | null)[] {
  return findAll('github-cloud-target-login').map((el) => el.textContent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubCloudConnectStep', () => {
  describe('chrome', () => {
    it('is one labelled group, a pure view with no card chrome', () => {
      render(makeController({ connection: DISCONNECTED }));

      const step = find('github-cloud-connect-step');
      expect(step.getAttribute('role')).toBe('group');
      expect(step.getAttribute('aria-label')).toBe('GitHub connection');
      expect(findAll('github-cloud-connect-step')).toHaveLength(1);
      expect(maybe('github-cloud-card')).toBe(false);
      expect(maybe('github-cloud-disconnect')).toBe(false);
      expect(maybe('github-cloud-add-account')).toBe(false);
      expect(maybe('github-cloud-identity')).toBe(false);
    });

    it('takes the product name from the active brand, never a hard-coded one', () => {
      const brand: SettingsBrand = {
        ...canopyBrand,
        displayName: 'Acme Studio',
      };
      render(makeController({ connection: NEEDS_INSTALL }), { brand });

      expect(stepText()).toContain('Acme Studio');
      expect(stepText()).not.toContain('Canopy');
    });
  });

  describe('loading and first-read failure', () => {
    it('shows a centered spinner, no loading copy and no actions yet', () => {
      const onReady = render(makeController({ loading: true }));

      const spinner = find(
        'centered-loading-spinner',
        find('github-cloud-loading'),
      );
      expect(spinner.getAttribute('role')).toBe('status');
      expect(find('github-cloud-status').textContent).toBe('');
      expect(container.textContent).not.toContain('Loading GitHub');
      expect(container.querySelectorAll('button')).toHaveLength(0);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('shows only the safe error and a retry that reloads, never an action to guess from', () => {
      const controller = makeController({
        error: controllerError({
          source: 'load',
          message: "Couldn't load your GitHub connection. Try again.",
        }),
      });
      const onReady = render(controller);

      const alert = find('github-cloud-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain(
        "Couldn't load your GitHub connection. Try again.",
      );
      expect(maybe('github-cloud-status')).toBe(false);
      expect(maybe('github-cloud-actions')).toBe(false);
      click(find('github-cloud-retry'));
      expect(controller.reload).toHaveBeenCalledTimes(1);
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe('disconnected', () => {
    it('invites Connect GitHub and calls the controller without an intent', () => {
      const controller = makeController({ connection: DISCONNECTED });
      const onReady = render(controller);

      expect(text('github-cloud-status')).toContain('Not connected');
      expect(text('github-cloud-status')).toContain(
        `choose where to install the ${canopyBrand.displayName} GitHub app`,
      );
      expect(actionLabels()).toEqual(['Connect GitHub']);
      const connect = find('github-cloud-connect');
      expect(connect.className).toContain('bg-accent');

      click(connect);
      expect(controller.connect).toHaveBeenCalledTimes(1);
      expect(controller.connect).toHaveBeenCalledWith();
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe('reauth', () => {
    it('asks to reconnect with the connect intent and hides the unverified account rows', () => {
      const controller = makeController({
        connection: NEEDS_REAUTH,
        verified: true,
      });
      const onReady = render(controller);

      expect(text('github-cloud-status')).toContain('Sign in again');
      expect(actionLabels()).toEqual(['Reconnect GitHub']);
      expect(maybe('github-cloud-target')).toBe(false);

      click(find('github-cloud-connect'));
      expect(controller.connect).toHaveBeenCalledWith();
      expect(onReady).not.toHaveBeenCalled();
    });

    it('wins over any installation state the stale projection still lists', () => {
      render(
        makeController({
          connection: connection({
            state: 'NEEDS_REAUTH',
            readyForProjects: false,
            targets: [acme('SUSPENDED'), beta('NEEDS_APPROVAL'), target()],
          }),
        }),
        { selectedInstallationId: ACME_ID },
      );

      expect(text('github-cloud-status')).toContain('Sign in again');
      expect(actionLabels()).toEqual(['Reconnect GitHub']);
      expect(maybe('github-cloud-target')).toBe(false);
      expect(stepText()).not.toContain('Install');
      expect(stepText()).not.toContain('Suspended');
    });
  });

  describe('reauth answered as an error', () => {
    const code = 'github-cloud-needs-reauth';
    const reauthError = (
      source: GitHubCloudControllerError['source'],
    ): GitHubCloudControllerError =>
      controllerError({ source, code, message: GITHUB_CLOUD_ERROR_COPY[code] });

    it('offers Reconnect GitHub when a live check asks to sign in again over a stored ACTIVE state', () => {
      const controller = makeController({
        connection: connection(),
        verified: false,
        stale: true,
        error: reauthError('verify'),
      });
      const onReady = render(controller);

      expect(text('github-cloud-error')).toContain(
        'Reconnect GitHub to continue.',
      );
      expect(actionLabels()).toEqual(['Reconnect GitHub', 'Check again']);
      const reconnect = find('github-cloud-connect');
      expect(reconnect.className).toContain('bg-accent');
      expect(find('github-cloud-check-again').className).not.toContain(
        'bg-accent',
      );

      click(reconnect);
      expect(controller.connect).toHaveBeenCalledTimes(1);
      expect(controller.connect).toHaveBeenCalledWith();
      expect(onReady).not.toHaveBeenCalled();
    });

    it('offers Reconnect GitHub ahead of the install step when the callback asked to sign in again', () => {
      const controller = makeController({
        connection: NEEDS_INSTALL,
        error: reauthError('setup'),
      });
      render(controller);

      expect(actionLabels()).toEqual([
        'Reconnect GitHub',
        'Install GitHub app',
        'Check again',
      ]);
      expect(find('github-cloud-connect').className).toContain('bg-accent');
      expect(find('github-cloud-install').className).not.toContain('bg-accent');
      click(find('github-cloud-connect'));
      expect(controller.connect).toHaveBeenCalledWith();
    });

    it('never doubles the Reconnect action of a stored NEEDS_REAUTH state', () => {
      render(
        makeController({
          connection: NEEDS_REAUTH,
          error: reauthError('verify'),
        }),
      );

      expect(actionLabels()).toEqual(['Reconnect GitHub']);
    });

    it('offers no Reconnect for any other failure', () => {
      render(
        makeController({
          connection: connection(),
          stale: true,
          error: controllerError({
            code: 'github-unavailable',
            message: GITHUB_CLOUD_ERROR_COPY['github-unavailable'],
          }),
        }),
      );

      expect(maybe('github-cloud-connect')).toBe(false);
    });
  });

  describe('install needed', () => {
    it('offers the install step with the install intent, and Check again beside it', () => {
      const controller = makeController({ connection: NEEDS_INSTALL });
      const onReady = render(controller);

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(text('github-cloud-status')).toContain(
        `Install the ${canopyBrand.displayName} GitHub app on the account or organization that owns your repositories`,
      );
      expect(actionLabels()).toEqual(['Install GitHub app', 'Check again']);
      const install = find('github-cloud-install');
      expect(install.className).toContain('bg-accent');
      expect(find('github-cloud-check-again').className).not.toContain(
        'bg-accent',
      );

      click(install);
      expect(controller.connect).toHaveBeenCalledWith({ intent: 'install' });
      click(find('github-cloud-check-again'));
      expect(controller.verify).toHaveBeenCalledTimes(1);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('treats only removed accounts as no installation: install stays the way out', () => {
      render(
        makeController({
          connection: needsInstallWith(acme('REMOVED'), beta('REMOVED')),
        }),
      );

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(find('github-cloud-install').className).toContain('bg-accent');
      expect(rowLogins()).toEqual(['acme', 'beta-labs']);
      expect(stepText()).toContain(
        'The app is no longer available for this account. Install it again to use its repositories.',
      );
    });
  });

  describe('owner approval', () => {
    it('names the organization owner step and makes Check again the way out, not a reinstall', () => {
      const controller = makeController({
        connection: needsInstallWith(acme('NEEDS_APPROVAL')),
      });
      const onReady = render(controller);

      expect(text('github-cloud-status')).toContain(
        'GitHub app needs attention',
      );
      const row = find('github-cloud-target');
      expect(row.getAttribute('data-target-state')).toBe('NEEDS_APPROVAL');
      expect(row.textContent).toContain('Permissions needed');
      expect(row.textContent).toContain(
        "An owner of this organization needs to approve the app's permissions on GitHub, then check again.",
      );
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(find('github-cloud-install').className).not.toContain('bg-accent');
      expect(actionLabels()).toEqual(['Install GitHub app', 'Check again']);

      click(find('github-cloud-check-again'));
      expect(controller.verify).toHaveBeenCalledTimes(1);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('shows the "request sent" notice from the controller and dismisses it', () => {
      const controller = makeController({
        connection: needsInstallWith(),
        notice: { kind: 'requested', message: GITHUB_CLOUD_REQUESTED_COPY },
      });
      render(controller);

      const notice = find('github-cloud-notice');
      expect(notice.getAttribute('role')).toBe('status');
      expect(notice.textContent).toContain(
        'An owner of that GitHub organization needs to approve it.',
      );
      const dismiss = notice.querySelector<HTMLElement>(
        'button[aria-label="Dismiss"]',
      );
      if (!dismiss) throw new Error('missing dismiss');
      click(dismiss);
      expect(controller.dismissNotice).toHaveBeenCalledTimes(1);
    });
  });

  describe('target suspension', () => {
    it('explains the suspension and keeps Check again primary', () => {
      const onReady = render(
        makeController({ connection: needsInstallWith(acme('SUSPENDED')) }),
      );

      expect(text('github-cloud-status')).toContain(
        'GitHub app needs attention',
      );
      const row = find('github-cloud-target');
      expect(row.getAttribute('data-target-state')).toBe('SUSPENDED');
      expect(row.textContent).toContain('Suspended');
      expect(row.textContent).toContain(
        'Unsuspend the app on GitHub, then check again.',
      );
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(onReady).not.toHaveBeenCalled();
    });

    it('lists blocked and removed accounts together and never tells the user to reinstall first', () => {
      render(
        makeController({
          connection: needsInstallWith(
            acme('SUSPENDED'),
            beta('REMOVED'),
            target({ state: 'NEEDS_APPROVAL' }),
          ),
        }),
      );

      expect(text('github-cloud-status')).toContain(
        'GitHub app needs attention',
      );
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(rowLogins()).toEqual(['acme', 'beta-labs', 'octocat']);
    });
  });

  describe('Core adoption pending or unavailable', () => {
    it('shows Finishing setup with Check again, never an install invitation, and no readiness', () => {
      const controller = makeController({
        connection: PENDING,
        verified: true,
      });
      const onReady = render(controller);

      expect(text('github-cloud-status')).toContain('Finishing setup');
      expect(stepText()).not.toMatch(/reinstall/i);
      expect(maybe('github-cloud-install')).toBe(false);
      expect(actionLabels()).toEqual(['Check again']);
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      const row = find('github-cloud-target');
      expect(row.getAttribute('data-target-state')).toBe('PENDING_ADOPTION');
      expect(row.textContent).toContain(
        "Cloud projects can't use it yet. Check again in a moment.",
      );

      click(find('github-cloud-check-again'));
      expect(controller.verify).toHaveBeenCalledTimes(1);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('is not ready even after a Connect that answered done with adoption pending', () => {
      // `next: "done"` collects fresh evidence (verified) but Core has not
      // adopted the target: readiness comes from readyForProjects, not next.
      const onReady = render(
        makeController({ connection: PENDING, verified: true }),
      );
      render(makeController({ connection: PENDING, verified: true }), {
        onReady,
      });

      expect(onReady).not.toHaveBeenCalled();
    });

    it('shows the adoption-pending service copy for its typed error beside Check again', () => {
      const code = 'github-cloud-adoption-pending';
      render(
        makeController({
          connection: PENDING,
          error: controllerError({
            source: 'connect',
            code,
            message: GITHUB_CLOUD_ERROR_COPY[code],
          }),
        }),
      );

      expect(text('github-cloud-error')).toContain(
        'GitHub setup is still finishing. Check again in a moment.',
      );
      expect(maybe('github-cloud-check-again')).toBe(true);
      expect(maybe('github-cloud-install')).toBe(false);
    });
  });

  describe('ready', () => {
    it('says GitHub is connected and offers no further action', () => {
      const onReady = render(readyController());

      expect(text('github-cloud-status')).toBe('GitHub connected');
      expect(maybe('github-cloud-actions')).toBe(false);
      expect(maybe('github-cloud-target')).toBe(false);
      expect(container.querySelectorAll('button')).toHaveLength(0);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('is not ready for a stored snapshot nobody checked: asks to check again', () => {
      const controller = makeController({
        connection: connection(),
        verified: false,
      });
      const onReady = render(controller);

      expect(text('github-cloud-status')).toContain('Not confirmed');
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe('mixed targets', () => {
    it('is ready when any account is active, and does not repeat the others the picker will explain', () => {
      const onReady = render(
        readyController({
          connection: connection({
            targets: [target(), acme('SUSPENDED'), beta('PENDING_ADOPTION')],
          }),
        }),
      );

      expect(text('github-cloud-status')).toBe('GitHub connected');
      expect(maybe('github-cloud-target')).toBe(false);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('lists every account when none is usable yet, each with its own reason', () => {
      const onReady = render(
        makeController({
          connection: connection({
            readyForProjects: false,
            targets: [
              target({ state: 'PENDING_ADOPTION' }),
              acme('SUSPENDED'),
              beta('REMOVED'),
            ],
          }),
          verified: true,
        }),
      );

      expect(text('github-cloud-status')).toContain('Finishing setup');
      const rows = findAll('github-cloud-target');
      expect(rows.map((row) => row.getAttribute('data-target-state'))).toEqual([
        'PENDING_ADOPTION',
        'SUSPENDED',
        'REMOVED',
      ]);
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe('selected target', () => {
    it('is ready when the selected account is active, whatever the others are', () => {
      const onReady = render(
        readyController({
          connection: connection({
            targets: [target({ state: 'SUSPENDED' }), acme(), beta('REMOVED')],
          }),
        }),
        { selectedInstallationId: ACME_ID },
      );

      expect(text('github-cloud-status')).toBe('GitHub connected');
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('is not ready when the selected account is suspended, though another account is usable', () => {
      const controller = readyController({
        connection: connection({ targets: [target(), acme('SUSPENDED')] }),
      });
      const onReady = render(controller, { selectedInstallationId: ACME_ID });

      expect(text('github-cloud-status')).toContain(
        'GitHub app needs attention',
      );
      expect(text('github-cloud-status')).toContain(
        'installed on the account you selected',
      );
      // Only the selected account explains why: the usable one is not listed.
      expect(rowLogins()).toEqual(['acme']);
      expect(find('github-cloud-target').textContent).toContain(
        'Unsuspend the app on GitHub, then check again.',
      );
      expect(actionLabels()).toEqual(['Check again']);
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(onReady).not.toHaveBeenCalled();
    });

    it('is not ready when the selected organization still needs its owner to approve', () => {
      const onReady = render(
        readyController({
          connection: connection({
            targets: [target(), acme('NEEDS_APPROVAL')],
          }),
        }),
        { selectedInstallationId: ACME_ID },
      );

      expect(find('github-cloud-target').textContent).toContain(
        "An owner of this organization needs to approve the app's permissions",
      );
      expect(onReady).not.toHaveBeenCalled();
    });

    it('is not ready while only the selected account awaits Core adoption', () => {
      const controller = readyController({
        connection: connection({
          targets: [target(), acme('PENDING_ADOPTION')],
        }),
      });
      const onReady = render(controller, { selectedInstallationId: ACME_ID });

      expect(text('github-cloud-status')).toContain('Finishing setup');
      expect(text('github-cloud-status')).toContain('the account you selected');
      expect(rowLogins()).toEqual(['acme']);
      expect(actionLabels()).toEqual(['Check again']);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('asks to install the app for an account that is not installed, though another one is usable', () => {
      const controller = readyController();
      const onReady = render(controller, { selectedInstallationId: ACME_ID });

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(text('github-cloud-status')).toContain(
        `Install the ${canopyBrand.displayName} GitHub app on the account or organization you selected, then check again.`,
      );
      expect(maybe('github-cloud-target')).toBe(false);
      expect(actionLabels()).toEqual(['Install GitHub app', 'Check again']);
      expect(find('github-cloud-install').className).toContain('bg-accent');

      click(find('github-cloud-install'));
      expect(controller.connect).toHaveBeenCalledWith({ intent: 'install' });
      expect(onReady).not.toHaveBeenCalled();
    });

    it('treats a removed selected account as not installed and lists its row', () => {
      const onReady = render(
        readyController({
          connection: connection({ targets: [target(), acme('REMOVED')] }),
        }),
        { selectedInstallationId: ACME_ID },
      );

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(rowLogins()).toEqual(['acme']);
      expect(find('github-cloud-install').className).toContain('bg-accent');
      expect(onReady).not.toHaveBeenCalled();
    });

    it('keeps install primary for a missing selection even while another account is blocked', () => {
      render(
        makeController({
          connection: needsInstallWith(beta('SUSPENDED')),
        }),
        { selectedInstallationId: ACME_ID },
      );

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(find('github-cloud-install').className).toContain('bg-accent');
      expect(maybe('github-cloud-target')).toBe(false);
    });

    it('makes Check again primary for a blocked selection, not the install it already has', () => {
      render(
        makeController({ connection: needsInstallWith(acme('SUSPENDED')) }),
        { selectedInstallationId: ACME_ID },
      );

      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(find('github-cloud-install').className).not.toContain('bg-accent');
      expect(rowLogins()).toEqual(['acme']);
    });

    it('matches the GitHub installation id exactly, never a login or a prefix', () => {
      const onReady = render(
        readyController({ connection: connection({ targets: [acme()] }) }),
        { selectedInstallationId: '200' },
      );

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe('selected owner login', () => {
    it('is not ready for an owner with no installation, though another organization is usable', () => {
      const controller = readyController({
        connection: connection({ targets: [target(), beta()] }),
      });
      const onReady = render(controller, { selectedAccountLogin: 'acme' });

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(text('github-cloud-status')).toContain(
        `Install the ${canopyBrand.displayName} GitHub app on the account or organization you selected, then check again.`,
      );
      // The usable accounts are not listed: they say nothing about the owner.
      expect(maybe('github-cloud-target')).toBe(false);
      expect(actionLabels()).toEqual(['Install GitHub app', 'Check again']);
      expect(find('github-cloud-install').className).toContain('bg-accent');
      expect(maybe('github-cloud-connect-step')).toBe(true);

      click(find('github-cloud-install'));
      expect(controller.connect).toHaveBeenCalledWith({ intent: 'install' });
      expect(onReady).not.toHaveBeenCalled();
    });

    it('is ready when the login matches an active account, whatever its case', () => {
      const onReady = render(
        readyController({
          connection: connection({
            targets: [target({ state: 'SUSPENDED' }), acme(), beta('REMOVED')],
          }),
        }),
        { selectedAccountLogin: 'ACME' },
      );

      expect(text('github-cloud-status')).toBe('GitHub connected');
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('trims the login before matching', () => {
      const onReady = render(readyController(), {
        selectedAccountLogin: '  Octocat ',
      });

      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('is not ready for a suspended owner, matched whatever the case, and lists only that account', () => {
      const onReady = render(
        readyController({
          connection: connection({ targets: [target(), acme('SUSPENDED')] }),
        }),
        { selectedAccountLogin: 'Acme' },
      );

      expect(text('github-cloud-status')).toContain(
        'GitHub app needs attention',
      );
      expect(rowLogins()).toEqual(['acme']);
      expect(actionLabels()).toEqual(['Check again']);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('waits for Core adoption of the owner the login names', () => {
      const onReady = render(
        readyController({
          connection: connection({
            targets: [target(), acme('PENDING_ADOPTION')],
          }),
        }),
        { selectedAccountLogin: 'acme' },
      );

      expect(text('github-cloud-status')).toContain('Finishing setup');
      expect(rowLogins()).toEqual(['acme']);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('treats a removed owner as not installed and lists its row', () => {
      const onReady = render(
        readyController({
          connection: connection({ targets: [target(), acme('REMOVED')] }),
        }),
        { selectedAccountLogin: 'acme' },
      );

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(rowLogins()).toEqual(['acme']);
      expect(find('github-cloud-install').className).toContain('bg-accent');
      expect(onReady).not.toHaveBeenCalled();
    });

    describe('a login that names several installation rows', () => {
      // ids 2002 (older) < 9009 (newer): the server lists the older row first.
      it('is ready for the reinstall, though an older removed row for the same login is listed first', () => {
        const onReady = render(
          readyController({
            connection: connection({
              targets: [target(), acme('REMOVED'), acmeAgain('ACTIVE')],
            }),
          }),
          { selectedAccountLogin: 'acme' },
        );

        expect(text('github-cloud-status')).toBe('GitHub connected');
        expect(maybe('github-cloud-target')).toBe(false);
        expect(onReady).toHaveBeenCalledTimes(1);
      });

      it('is ready whatever order the rows come in', () => {
        const onReady = render(
          readyController({
            connection: connection({
              targets: [acmeAgain('ACTIVE'), acme('REMOVED'), target()],
            }),
          }),
          { selectedAccountLogin: 'ACME' },
        );

        expect(onReady).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['older row first', [acme('PENDING_ADOPTION'), acmeAgain('ACTIVE')]],
        ['newer row first', [acmeAgain('ACTIVE'), acme('PENDING_ADOPTION')]],
      ])(
        'is ready when the same login is still awaiting adoption on another row (%s)',
        (_order, rows) => {
          const onReady = render(
            readyController({
              connection: connection({ targets: [target(), ...rows] }),
            }),
            { selectedAccountLogin: 'acme' },
          );

          expect(text('github-cloud-status')).toBe('GitHub connected');
          expect(onReady).toHaveBeenCalledTimes(1);
        },
      );

      it('is ready when the same login is also suspended on another row', () => {
        const onReady = render(
          readyController({
            connection: connection({
              targets: [acme('SUSPENDED'), acmeAgain('ACTIVE')],
            }),
          }),
          { selectedAccountLogin: 'acme' },
        );

        expect(text('github-cloud-status')).toBe('GitHub connected');
        expect(onReady).toHaveBeenCalledTimes(1);
      });

      it('is not installed while only the removed row exists, and lists that row', () => {
        const onReady = render(
          readyController({
            connection: connection({ targets: [target(), acme('REMOVED')] }),
          }),
          { selectedAccountLogin: 'acme' },
        );

        expect(text('github-cloud-status')).toContain('GitHub app needed');
        expect(rowLogins()).toEqual(['acme']);
        expect(
          find('github-cloud-target').getAttribute('data-target-state'),
        ).toBe('REMOVED');
        expect(find('github-cloud-install').className).toContain('bg-accent');
        expect(onReady).not.toHaveBeenCalled();
      });

      it('ranks the rows Active, then Finishing setup, then blocked, then Removed', () => {
        const cases: ReadonlyArray<
          readonly [
            GitHubCloudTargetDto['state'],
            GitHubCloudTargetDto['state'],
            string,
            string,
          ]
        > = [
          [
            'REMOVED',
            'PENDING_ADOPTION',
            'Finishing setup',
            'PENDING_ADOPTION',
          ],
          ['REMOVED', 'SUSPENDED', 'GitHub app needs attention', 'SUSPENDED'],
          [
            'REMOVED',
            'NEEDS_APPROVAL',
            'GitHub app needs attention',
            'NEEDS_APPROVAL',
          ],
          [
            'SUSPENDED',
            'PENDING_ADOPTION',
            'Finishing setup',
            'PENDING_ADOPTION',
          ],
          [
            'NEEDS_APPROVAL',
            'REMOVED',
            'GitHub app needs attention',
            'NEEDS_APPROVAL',
          ],
        ];

        for (const [older, newer, status, listed] of cases) {
          for (const targets of [
            [acme(older), acmeAgain(newer)],
            [acmeAgain(newer), acme(older)],
          ]) {
            const onReady = render(
              readyController({
                connection: connection({ targets: [target(), ...targets] }),
              }),
              { selectedAccountLogin: 'acme' },
            );
            expect(text('github-cloud-status')).toContain(status);
            const rows = findAll('github-cloud-target');
            expect(rows).toHaveLength(1);
            expect(rows[0].getAttribute('data-target-state')).toBe(listed);
            expect(onReady).not.toHaveBeenCalled();
          }
        }
      });

      it('notifies once the user reinstalls and the live check lists the new row', () => {
        const onReady = render(
          readyController({
            connection: connection({ targets: [target(), acme('REMOVED')] }),
          }),
          { selectedAccountLogin: 'acme' },
        );
        expect(onReady).not.toHaveBeenCalled();

        render(
          readyController({
            connection: connection({
              targets: [target(), acme('REMOVED'), acmeAgain('ACTIVE')],
            }),
          }),
          { selectedAccountLogin: 'acme', onReady },
        );
        expect(onReady).toHaveBeenCalledTimes(1);
      });
    });

    it('keeps install primary for a missing owner while another account is blocked', () => {
      render(
        makeController({ connection: needsInstallWith(beta('SUSPENDED')) }),
        { selectedAccountLogin: 'acme' },
      );

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(find('github-cloud-install').className).toContain('bg-accent');
      expect(maybe('github-cloud-target')).toBe(false);
    });

    it('matches the whole login only, never a prefix or part of one', () => {
      const controller = readyController({
        connection: connection({ targets: [target(), acme()] }),
      });
      for (const login of ['acm', 'acme-labs', 'cme', 'acme/repo']) {
        const onReady = render(controller, { selectedAccountLogin: login });
        expect(text('github-cloud-status')).toContain('GitHub app needed');
        expect(onReady).not.toHaveBeenCalled();
      }
    });

    it('never reads a login as an installation id, or an installation id as a login', () => {
      const controller = readyController({
        connection: connection({ targets: [target(), acme()] }),
      });

      const byLogin = render(controller, { selectedAccountLogin: ACME_ID });
      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(byLogin).not.toHaveBeenCalled();

      const byId = render(controller, { selectedInstallationId: 'acme' });
      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(byId).not.toHaveBeenCalled();
    });

    it('never offers readiness for reauth or disconnect, whatever the login', () => {
      for (const fixture of [NEEDS_REAUTH, DISCONNECTED]) {
        const onReady = render(
          makeController({ connection: fixture, verified: true }),
          { selectedAccountLogin: 'octocat' },
        );
        expect(onReady).not.toHaveBeenCalled();
      }
      render(makeController({ connection: NEEDS_REAUTH }), {
        selectedAccountLogin: 'acme',
      });
      expect(text('github-cloud-status')).toContain('Sign in again');
      expect(actionLabels()).toEqual(['Reconnect GitHub']);
    });

    it('notifies once the owner becomes active, after the app was installed', () => {
      const onReady = render(readyController(), {
        selectedAccountLogin: 'acme',
      });
      expect(onReady).not.toHaveBeenCalled();

      render(
        readyController({
          connection: connection({ targets: [target(), acme()] }),
        }),
        { selectedAccountLogin: 'acme', onReady },
      );
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an empty installation id', { selectedInstallationId: '' }],
      ['a blank installation id', { selectedInstallationId: '  ' }],
      ['an empty login', { selectedAccountLogin: '' }],
      ['a blank login', { selectedAccountLogin: '   ' }],
    ] satisfies ReadonlyArray<readonly [string, GitHubCloudSelectedAccount]>)(
      'reads %s as no selection: any usable account will do',
      (_label, selected) => {
        const onReady = render(
          readyController({
            connection: connection({ targets: [acme('SUSPENDED'), beta()] }),
          }),
          selected,
        );

        expect(text('github-cloud-status')).toBe('GitHub connected');
        expect(onReady).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('error priority', () => {
    it('ranks reauth, then install, then blocked, then pending, then ready', () => {
      // Each case keeps the targets that would give a lower-ranked answer.
      const targets = [target(), acme('SUSPENDED'), beta('PENDING_ADOPTION')];
      const cases: ReadonlyArray<
        readonly [GitHubCloudConnectionDto, string, readonly string[]]
      > = [
        [
          connection({
            state: 'NEEDS_REAUTH',
            readyForProjects: false,
            targets,
          }),
          'Sign in again',
          ['Reconnect GitHub'],
        ],
        [
          connection({
            state: 'NEEDS_INSTALL',
            readyForProjects: false,
            targets: [acme('SUSPENDED')],
          }),
          'GitHub app needs attention',
          ['Install GitHub app', 'Check again'],
        ],
        [
          connection({
            state: 'NEEDS_INSTALL',
            readyForProjects: false,
            targets: [],
          }),
          'GitHub app needed',
          ['Install GitHub app', 'Check again'],
        ],
        [
          connection({
            readyForProjects: false,
            targets: [target({ state: 'PENDING_ADOPTION' }), acme('SUSPENDED')],
          }),
          'Finishing setup',
          ['Check again'],
        ],
        [connection({ targets }), 'GitHub connected', []],
      ];

      for (const [fixture, status, labels] of cases) {
        render(makeController({ connection: fixture, verified: true }));
        expect(text('github-cloud-status')).toContain(status);
        expect(maybe('github-cloud-actions') ? actionLabels() : []).toEqual(
          labels,
        );
      }
    });

    it('puts the selected account ahead of the usable ones', () => {
      render(
        readyController({
          connection: connection({
            readyForProjects: true,
            targets: [target(), acme('SUSPENDED'), beta('PENDING_ADOPTION')],
          }),
        }),
        { selectedInstallationId: BETA_ID },
      );

      expect(text('github-cloud-status')).toContain('Finishing setup');
      expect(rowLogins()).toEqual(['beta-labs']);
    });

    it('shows a failed live check beside the last known state and stays unready', () => {
      const controller = makeController({
        connection: connection(),
        verified: false,
        stale: true,
        error: controllerError({ source: 'verify' }),
      });
      const onReady = render(controller);

      const alert = find('github-cloud-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain(
        "Couldn't check your GitHub connection. Try again.",
      );
      expect(alert.textContent).toContain('Showing the last known status.');
      expect(maybe('github-cloud-status')).toBe(false);
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(onReady).not.toHaveBeenCalled();
    });

    it('shows the rate limit as a calm attention notice, with the state and Check again intact', () => {
      const code = 'github-rate-limited';
      render(
        makeController({
          connection: needsInstallWith(),
          error: controllerError({
            source: 'verify',
            code,
            message: GITHUB_CLOUD_ERROR_COPY[code],
          }),
        }),
      );

      const notice = find('github-cloud-rate-limit');
      expect(notice.getAttribute('role')).toBe('status');
      expect(notice.getAttribute('data-notice-intent')).toBe('attention');
      expect(maybe('github-cloud-error')).toBe(false);
      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(maybe('github-cloud-check-again')).toBe(true);
    });

    it('lists the status first, then the notice, then the failure, then accounts and actions', () => {
      render(
        makeController({
          connection: needsInstallWith(acme('NEEDS_APPROVAL')),
          notice: { kind: 'requested', message: GITHUB_CLOUD_REQUESTED_COPY },
          error: controllerError({ source: 'connect', message: 'Failed.' }),
        }),
      );

      const order = [
        'github-cloud-status',
        'github-cloud-notice',
        'github-cloud-error',
        'github-cloud-targets',
        'github-cloud-actions',
      ].map((testId) => find(testId));
      for (let index = 1; index < order.length; index += 1) {
        const position = order[index - 1].compareDocumentPosition(order[index]);
        expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it('keeps the rollout notice for good when there is no connection to show', () => {
      render(
        makeController({
          notice: {
            kind: 'unavailable',
            message:
              "GitHub for cloud work isn't available for your account yet.",
          },
        }),
      );

      const notice = find('github-cloud-notice');
      expect(notice.textContent).toContain("isn't available for your account");
      expect(notice.querySelector('button')).toBeNull();
    });

    it('clears a dismissed failure through the controller', () => {
      const controller = makeController({
        connection: DISCONNECTED,
        error: controllerError({ source: 'connect', message: 'Failed.' }),
      });
      render(controller);

      const dismiss = find('github-cloud-error').querySelector<HTMLElement>(
        'button[aria-label="Dismiss"]',
      );
      if (!dismiss) throw new Error('missing dismiss');
      click(dismiss);
      expect(controller.clearError).toHaveBeenCalledTimes(1);
    });
  });

  describe('busy states', () => {
    it('shows Connecting…, stays focusable and ignores a second press', () => {
      const controller = makeController({
        connection: DISCONNECTED,
        busy: 'connect',
      });
      render(controller);

      expect(text('github-cloud-status')).toContain('Connecting to GitHub…');
      const connect = find('github-cloud-connect');
      expect(connect.textContent).toBe('Connecting…');
      expect(connect.getAttribute('aria-busy')).toBe('true');
      expect(connect.getAttribute('aria-disabled')).toBe('true');
      expect(connect.hasAttribute('disabled')).toBe(false);
      connect.focus();
      expect(document.activeElement).toBe(connect);

      click(connect);
      expect(controller.connect).not.toHaveBeenCalled();
    });

    it('shows Checking… while the live check runs and blocks the other action', () => {
      const controller = makeController({
        connection: NEEDS_INSTALL,
        checking: true,
      });
      render(controller);

      expect(text('github-cloud-status')).toContain('Checking with GitHub…');
      expect(find('github-cloud-check-again').textContent).toBe('Checking…');
      expect(find('github-cloud-install').getAttribute('aria-disabled')).toBe(
        'true',
      );
      click(find('github-cloud-install'));
      click(find('github-cloud-check-again'));
      expect(controller.connect).not.toHaveBeenCalled();
      expect(controller.verify).not.toHaveBeenCalled();
    });

    it('keeps a ready step ready while Check again re-verifies, and never notifies twice', () => {
      const onReady = render(readyController());
      render(readyController({ checking: true, busy: 'verify' }), { onReady });

      expect(text('github-cloud-status')).toContain('Checking with GitHub…');
      render(readyController(), { onReady });
      expect(onReady).toHaveBeenCalledTimes(1);
    });
  });

  describe('onReady', () => {
    it('is called once for a transition to ready, however often the step renders', () => {
      const controller = readyController();
      const onReady = render(controller);
      render(controller, { onReady });
      render(readyController(), { onReady });

      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('is called once under Strict Mode too', () => {
      const onReady = render(readyController(), { strict: true });

      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('is called only after the live check lands, never for the stored snapshot', () => {
      const stored = makeController({
        connection: connection(),
        checking: true,
        verified: false,
      });
      const onReady = render(stored);
      expect(onReady).not.toHaveBeenCalled();

      render(readyController(), { onReady });
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'a stored snapshot nobody verified',
        makeController({ connection: connection() }),
      ],
      [
        'a verified answer that is already stale',
        readyController({ stale: true }),
      ],
      [
        'a failed live check',
        makeController({
          connection: connection(),
          stale: true,
          error: controllerError(),
        }),
      ],
      [
        'a disconnected connection',
        makeController({ connection: DISCONNECTED, verified: true }),
      ],
      [
        'a connection that needs reauth',
        makeController({ connection: NEEDS_REAUTH, verified: true }),
      ],
      [
        'a connection that needs the app installed',
        makeController({ connection: NEEDS_INSTALL, verified: true }),
      ],
      [
        'a target awaiting Core adoption',
        makeController({ connection: PENDING, verified: true }),
      ],
      [
        'an ACTIVE connection that is not ready for projects',
        makeController({
          connection: connection({ readyForProjects: false }),
          verified: true,
        }),
      ],
      ['no connection yet', makeController({ loading: true, verified: true })],
    ])('is never called for %s', (_label, controller) => {
      const onReady = render(controller);
      render(controller, { onReady });

      expect(onReady).not.toHaveBeenCalled();
    });

    it('is called again after a failed check and a recovery', () => {
      const onReady = render(readyController());
      expect(onReady).toHaveBeenCalledTimes(1);

      // The live check fails: stale snapshot, nothing verified.
      render(
        makeController({
          connection: connection(),
          verified: false,
          stale: true,
          error: controllerError(),
        }),
        { onReady },
      );
      expect(onReady).toHaveBeenCalledTimes(1);

      // Check again succeeds: a new transition to ready.
      render(readyController(), { onReady });
      expect(onReady).toHaveBeenCalledTimes(2);

      // Still ready: nothing more.
      render(readyController(), { onReady });
      expect(onReady).toHaveBeenCalledTimes(2);
    });

    it('is called again after the connection stops and resumes being usable', () => {
      const onReady = render(readyController());
      render(makeController({ connection: NEEDS_REAUTH, verified: true }), {
        onReady,
      });
      render(readyController(), { onReady });

      expect(onReady).toHaveBeenCalledTimes(2);
    });

    it('is called again when the selected account becomes unavailable and then active', () => {
      const onReady = render(
        readyController({
          connection: connection({ targets: [target(), acme()] }),
        }),
        { selectedInstallationId: ACME_ID },
      );
      expect(onReady).toHaveBeenCalledTimes(1);

      render(
        readyController({
          connection: connection({ targets: [target(), acme('SUSPENDED')] }),
        }),
        { selectedInstallationId: ACME_ID, onReady },
      );
      expect(onReady).toHaveBeenCalledTimes(1);

      render(
        readyController({
          connection: connection({ targets: [target(), acme()] }),
        }),
        { selectedInstallationId: ACME_ID, onReady },
      );
      expect(onReady).toHaveBeenCalledTimes(2);
    });

    it('does not announce again when the selection moves between two active accounts', () => {
      const controller = readyController({
        connection: connection({ targets: [target(), acme()] }),
      });
      const onReady = render(controller, {
        selectedInstallationId: PERSONAL_ID,
      });
      render(controller, { selectedInstallationId: ACME_ID, onReady });

      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('calls the latest callback, not the one from the first render', () => {
      const first = jest.fn();
      const second = jest.fn();
      render(makeController({ connection: connection() }), { onReady: first });
      render(makeController({ connection: connection() }), { onReady: second });
      render(readyController(), { onReady: second });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('is called again for a step mounted anew over a still-ready controller', () => {
      const controller = readyController();
      const onReady = render(controller);
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      render(controller, { onReady });

      expect(onReady).toHaveBeenCalledTimes(2);
    });
  });

  describe('readiness formula', () => {
    it('is true only for a verified ACTIVE connection that is ready for projects', () => {
      expect(isGitHubCloudReady(readyController())).toBe(true);
      expect(
        isGitHubCloudReady(makeController({ connection: connection() })),
      ).toBe(false);
      expect(
        isGitHubCloudReady(
          makeController({ connection: PENDING, verified: true }),
        ),
      ).toBe(false);
      expect(isGitHubCloudReady(readyController({ stale: true }))).toBe(false);
    });

    it('also needs the selected account to be active when one is given', () => {
      const controller = readyController({
        connection: connection({ targets: [target(), acme('SUSPENDED')] }),
      });

      expect(isGitHubCloudReady(controller)).toBe(true);
      expect(
        isGitHubCloudReady(controller, { selectedInstallationId: PERSONAL_ID }),
      ).toBe(true);
      expect(
        isGitHubCloudReady(controller, { selectedInstallationId: ACME_ID }),
      ).toBe(false);
      expect(
        isGitHubCloudReady(controller, { selectedInstallationId: BETA_ID }),
      ).toBe(false);
    });

    it('also accepts the selected account by login, ignoring case', () => {
      const controller = readyController({
        connection: connection({ targets: [target(), acme('SUSPENDED')] }),
      });

      expect(
        isGitHubCloudReady(controller, { selectedAccountLogin: 'OctoCat' }),
      ).toBe(true);
      expect(
        isGitHubCloudReady(controller, { selectedAccountLogin: 'acme' }),
      ).toBe(false);
      // Not installed at all: another usable account must not mask it.
      expect(
        isGitHubCloudReady(controller, { selectedAccountLogin: 'beta-labs' }),
      ).toBe(false);
    });

    it('picks the best-ranked row when a login names several installations', () => {
      const ready = (...targets: GitHubCloudTargetDto[]): boolean =>
        isGitHubCloudReady(
          readyController({ connection: connection({ targets }) }),
          { selectedAccountLogin: 'acme' },
        );

      expect(ready(acme('REMOVED'), acmeAgain('ACTIVE'))).toBe(true);
      expect(ready(acmeAgain('ACTIVE'), acme('REMOVED'))).toBe(true);
      expect(ready(acme('SUSPENDED'), acmeAgain('ACTIVE'))).toBe(true);
      expect(ready(target(), acme('REMOVED'))).toBe(false);
      expect(
        ready(target(), acme('REMOVED'), acmeAgain('PENDING_ADOPTION')),
      ).toBe(false);
    });

    it.each([
      ['an empty installation id', { selectedInstallationId: '' }],
      ['a blank installation id', { selectedInstallationId: '   ' }],
      ['an empty login', { selectedAccountLogin: '' }],
      ['a blank login', { selectedAccountLogin: '  ' }],
    ] satisfies ReadonlyArray<readonly [string, GitHubCloudSelectedAccount]>)(
      'reads %s as no selection',
      (_label, selected) => {
        const controller = readyController({
          connection: connection({ targets: [acme('SUSPENDED'), beta()] }),
        });

        expect(isGitHubCloudReady(controller, selected)).toBe(true);
        expect(isGitHubCloudReady(controller, {})).toBe(true);
      },
    );
  });

  describe('keyboard focus', () => {
    it('hands focus to the step when the focused action disappears into the ready state', () => {
      const controller = makeController({ connection: NEEDS_INSTALL });
      render(controller);
      const check = find('github-cloud-check-again');
      check.focus();
      click(check);
      expect(controller.verify).toHaveBeenCalledTimes(1);

      render(readyController());

      expect(check.isConnected).toBe(false);
      const step = find('github-cloud-connect-step');
      expect(step.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(step);
    });

    it('lets onReady move focus first: the step never takes focus a moment before the consumer', () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      const controller = makeController({ connection: NEEDS_INSTALL });
      render(controller);
      const stepFocused = jest.fn();
      find('github-cloud-connect-step').addEventListener('focus', stepFocused);
      const check = find('github-cloud-check-again');
      check.focus();
      click(check);

      render(readyController(), {
        onReady: jest.fn(() => {
          outside.focus();
        }),
      });

      expect(document.activeElement).toBe(outside);
      expect(stepFocused).not.toHaveBeenCalled();
      outside.remove();
    });

    it('hands focus to the step when a dismissed failure takes its button along', () => {
      const controller = makeController({
        connection: DISCONNECTED,
        error: controllerError({ source: 'connect', message: 'Failed.' }),
      });
      render(controller);
      const dismiss = find('github-cloud-error').querySelector<HTMLElement>(
        'button[aria-label="Dismiss"]',
      );
      if (!dismiss) throw new Error('missing dismiss');
      dismiss.focus();
      click(dismiss);

      render(makeController({ connection: DISCONNECTED }));

      expect(document.activeElement).toBe(find('github-cloud-connect-step'));
    });

    it('uses real buttons with visible names for every action', () => {
      render(makeController({ connection: NEEDS_INSTALL }));

      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Install GitHub app',
        'Check again',
      ]);
      for (const button of buttons) {
        expect(button.getAttribute('type')).toBe('button');
      }
    });
  });
});
