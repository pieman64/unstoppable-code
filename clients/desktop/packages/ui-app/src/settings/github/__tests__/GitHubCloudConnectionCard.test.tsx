/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WEB_BRANDS } from '@canopy/brand/web';
import type { SettingsBrand } from '../../host';
import { GitHubTestHost } from './helpers/github-test-host';
import type {
  GitHubCloudConnectionDto,
  GitHubCloudTargetDto,
} from '@canopy/protocol/settings/account-github';
import { GITHUB_CLOUD_ERROR_COPY } from '@canopy/protocol/settings/github-cloud-errors';
import { GitHubCloudConnectionCard } from '../GitHubCloudConnectionCard';
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

function target(
  overrides: Partial<GitHubCloudTargetDto> = {},
): GitHubCloudTargetDto {
  return {
    id: '6f1c2c1e-0000-4000-8000-000000000001',
    installationId: '1001',
    accountLogin: 'octocat',
    accountType: 'User',
    repositorySelection: 'all',
    state: 'ACTIVE',
    ...overrides,
  };
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

function render(
  controller: GitHubCloudConnectionController,
  brand: SettingsBrand = canopyBrand,
): void {
  act(() => {
    root.render(
      <GitHubTestHost brand={brand}>
        <GitHubCloudConnectionCard controller={controller} />
      </GitHubTestHost>,
    );
  });
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

function cardText(): string {
  return container.textContent ?? '';
}

function required(element: HTMLElement | null | undefined): HTMLElement {
  if (!element) throw new Error('missing element');
  return element;
}

/** The dialog is portalled to <body>, outside the card's container. */
function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    '[data-testid="github-cloud-disconnect-confirm"]',
  );
}

function openDialogElement(): HTMLElement {
  return required(dialog());
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

async function clickAsync(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubCloudConnectionCard', () => {
  describe('card chrome', () => {
    it('renders one Settings section with a text-only heading and the brand name', () => {
      render(makeController({ connection: DISCONNECTED }));

      expect(findAll('github-cloud-card')).toHaveLength(1);
      const card = find('github-cloud-card');
      expect(card.querySelector('h2')?.textContent).toBe(
        'GitHub for cloud work',
      );
      // No icon medallion beside the heading.
      expect(card.querySelector('.bg-accent-subtle')).toBeNull();
      expect(cardText()).toContain(
        `Connect GitHub so cloud projects in ${canopyBrand.displayName} can use your repositories.`,
      );
    });

    it('takes the product name from the active brand, never a hard-coded one', () => {
      const brand: SettingsBrand = {
        ...canopyBrand,
        displayName: 'Acme Studio',
      };
      render(makeController({ connection: NEEDS_INSTALL }), brand);

      expect(cardText()).toContain('Acme Studio');
      expect(cardText()).not.toContain('Canopy');
    });
  });

  describe('loading', () => {
    it('shows a centered spinner, no loading copy and no actions yet', () => {
      render(makeController({ loading: true }));

      const spinner = find(
        'centered-loading-spinner',
        find('github-cloud-loading'),
      );
      expect(spinner.getAttribute('role')).toBe('status');
      expect(find('github-cloud-status').textContent).toBe('');
      expect(container.textContent).not.toContain('Loading GitHub');
      expect(container.querySelectorAll('button')).toHaveLength(0);
    });
  });

  describe('load failure', () => {
    it('shows the safe error with a retry that reloads', () => {
      const controller = makeController({
        error: controllerError({
          source: 'load',
          message: "Couldn't load your GitHub connection. Try again.",
        }),
      });
      render(controller);

      const alert = find('github-cloud-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain(
        "Couldn't load your GitHub connection. Try again.",
      );
      expect(maybe('github-cloud-connect')).toBe(false);
      expect(maybe('github-cloud-disconnect')).toBe(false);

      click(find('github-cloud-retry'));
      expect(controller.reload).toHaveBeenCalledTimes(1);
    });

    it('hands focus to the card heading when Try again removes its own notice', () => {
      const failed = makeController({
        error: controllerError({
          source: 'load',
          message: "Couldn't load your GitHub connection. Try again.",
        }),
      });
      render(failed);
      const retry = find('github-cloud-retry');
      retry.focus();
      expect(document.activeElement).toBe(retry);
      click(retry);
      expect(failed.reload).toHaveBeenCalledTimes(1);

      // reload() clears the error and loads again: the notice and its button
      // are gone, and the card must not leave focus on <body>.
      render(makeController({ loading: true }));
      expect(maybe('github-cloud-retry')).toBe(false);
      render(makeController({ connection: DISCONNECTED }));

      expect(document.activeElement).toBe(container.querySelector('h2'));
    });

    it('does not steal focus the user moved elsewhere while Try again loads', () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      render(
        makeController({
          error: controllerError({ source: 'load', message: 'Failed.' }),
        }),
      );
      click(find('github-cloud-retry'));
      outside.focus();

      render(makeController({ connection: DISCONNECTED }));

      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });

  describe('disconnected', () => {
    it('invites Connect GitHub and calls the controller without an intent', () => {
      const controller = makeController({ connection: DISCONNECTED });
      render(controller);

      expect(text('github-cloud-status')).toContain('Not connected');
      expect(text('github-cloud-status')).toContain(
        `choose where to install the ${canopyBrand.displayName} GitHub app`,
      );
      const connect = find('github-cloud-connect');
      expect(connect.textContent).toBe('Connect GitHub');
      // The single highest-priority action takes the solid accent.
      expect(connect.className).toContain('bg-accent');
      expect(maybe('github-cloud-disconnect')).toBe(false);
      expect(maybe('github-cloud-check-again')).toBe(false);
      expect(maybe('github-cloud-identity')).toBe(false);

      click(connect);
      expect(controller.connect).toHaveBeenCalledTimes(1);
      expect(controller.connect).toHaveBeenCalledWith();
    });
  });

  describe('needs reauth', () => {
    it('asks to reconnect, keeps Disconnect, and hides the unverified account rows', () => {
      const controller = makeController({ connection: NEEDS_REAUTH });
      render(controller);

      expect(text('github-cloud-status')).toContain('Sign in again');
      expect(text('github-cloud-identity')).toContain('octocat');
      const reconnect = find('github-cloud-connect');
      expect(reconnect.textContent).toBe('Reconnect GitHub');
      expect(maybe('github-cloud-target')).toBe(false);
      expect(maybe('github-cloud-disconnect')).toBe(true);

      click(reconnect);
      expect(controller.connect).toHaveBeenCalledWith();
    });
  });

  describe('needs reauth answered as an error', () => {
    const code = 'github-cloud-needs-reauth';
    const reauthError = (
      source: GitHubCloudControllerError['source'],
    ): GitHubCloudControllerError =>
      controllerError({ source, code, message: GITHUB_CLOUD_ERROR_COPY[code] });

    it('offers Reconnect GitHub when a live check asks to sign in again over a stored ACTIVE state', () => {
      const controller = makeController({
        connection: connection(),
        stale: true,
        error: reauthError('verify'),
      });
      render(controller);

      expect(text('github-cloud-error')).toContain(
        'Reconnect GitHub to continue.',
      );
      const reconnect = find('github-cloud-connect');
      expect(reconnect.textContent).toBe('Reconnect GitHub');
      expect(reconnect.className).toContain('bg-accent');
      expect(find('github-cloud-check-again').className).not.toContain(
        'bg-accent',
      );
      expect(maybe('github-cloud-add-account')).toBe(true);
      expect(maybe('github-cloud-disconnect')).toBe(true);

      click(reconnect);
      expect(controller.connect).toHaveBeenCalledTimes(1);
      expect(controller.connect).toHaveBeenCalledWith();
    });

    it('offers Reconnect GitHub when the install callback asked to sign in again', () => {
      const controller = makeController({
        connection: NEEDS_INSTALL,
        error: reauthError('setup'),
      });
      render(controller);

      const reconnect = find('github-cloud-connect');
      expect(reconnect.textContent).toBe('Reconnect GitHub');
      expect(reconnect.className).toContain('bg-accent');
      expect(find('github-cloud-install').className).not.toContain('bg-accent');
      click(reconnect);
      expect(controller.connect).toHaveBeenCalledWith();
    });

    it('never doubles the Reconnect action of a stored NEEDS_REAUTH state', () => {
      render(
        makeController({
          connection: NEEDS_REAUTH,
          error: reauthError('verify'),
        }),
      );

      expect(findAll('github-cloud-connect')).toHaveLength(1);
      expect(find('github-cloud-connect').textContent).toBe('Reconnect GitHub');
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
    it('offers the install step with the install intent and a Check again', () => {
      const controller = makeController({ connection: NEEDS_INSTALL });
      render(controller);

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(text('github-cloud-status')).toContain(
        `Install the ${canopyBrand.displayName} GitHub app on the account or organization that owns your repositories`,
      );
      const install = find('github-cloud-install');
      expect(install.textContent).toBe('Install GitHub app');
      expect(install.className).toContain('bg-accent');

      click(install);
      expect(controller.connect).toHaveBeenCalledWith({ intent: 'install' });

      click(find('github-cloud-check-again'));
      expect(controller.verify).toHaveBeenCalledTimes(1);
    });
  });

  describe('connected', () => {
    it('shows the identity, the account row, and Add account, Check again and Disconnect', () => {
      const controller = makeController({
        connection: connection(),
        verified: true,
      });
      render(controller);

      expect(text('github-cloud-status')).toContain('Connected');
      expect(text('github-cloud-identity')).toContain('GitHub account');
      expect(text('github-cloud-identity')).toContain('octocat');
      const rows = findAll('github-cloud-target');
      expect(rows).toHaveLength(1);
      expect(rows[0].getAttribute('data-target-state')).toBe('ACTIVE');
      expect(rows[0].textContent).toContain('octocat');
      expect(rows[0].textContent).toContain(
        'Personal account, all repositories',
      );
      expect(rows[0].textContent).toContain('Active');
      // Nothing needs attention, so there is no solid accent action.
      expect(find('github-cloud-add-account').className).not.toContain(
        'bg-accent',
      );
      expect(find('github-cloud-check-again').className).not.toContain(
        'bg-accent',
      );

      click(find('github-cloud-add-account'));
      expect(controller.connect).toHaveBeenCalledWith({ intent: 'install' });
      click(find('github-cloud-check-again'));
      expect(controller.verify).toHaveBeenCalledTimes(1);
    });

    it('describes an organization installation with selected repositories', () => {
      render(
        makeController({
          connection: connection({
            targets: [
              target({
                accountLogin: 'acme',
                accountType: 'Organization',
                repositorySelection: 'selected',
              }),
            ],
          }),
        }),
      );

      expect(text('github-cloud-targets')).toContain(
        'Organization, selected repositories',
      );
    });
  });

  describe('pending adoption', () => {
    it('shows Finishing setup with Check again and never invites a reinstall', () => {
      const controller = makeController({
        connection: PENDING,
        verified: true,
      });
      render(controller);

      expect(text('github-cloud-status')).toContain('Finishing setup');
      const row = find('github-cloud-target');
      expect(row.getAttribute('data-target-state')).toBe('PENDING_ADOPTION');
      expect(row.textContent).toContain('Finishing setup');
      expect(row.textContent).toContain('Check again in a moment');
      // Check again is the one recommended action.
      const check = find('github-cloud-check-again');
      expect(check.className).toContain('bg-accent');
      expect(maybe('github-cloud-install')).toBe(false);
      expect(cardText()).not.toMatch(/reinstall/i);
      expect(cardText()).not.toMatch(/install the/i);

      click(check);
      expect(controller.verify).toHaveBeenCalledTimes(1);
    });
  });

  describe('partial targets', () => {
    const mixed = connection({
      readyForProjects: true,
      targets: [
        target({ id: 't-1', accountLogin: 'octocat', state: 'ACTIVE' }),
        target({
          id: 't-2',
          installationId: '1002',
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          state: 'NEEDS_APPROVAL',
        }),
        target({
          id: 't-3',
          installationId: '1003',
          accountLogin: 'beta-org',
          accountType: 'Organization',
          state: 'SUSPENDED',
        }),
        target({
          id: 't-4',
          installationId: '1004',
          accountLogin: 'gone-org',
          accountType: 'Organization',
          state: 'REMOVED',
        }),
        target({
          id: 't-5',
          installationId: '1005',
          accountLogin: 'warming-up',
          state: 'PENDING_ADOPTION',
        }),
      ],
    });

    it('shows each account in its own distinct state, in server order', () => {
      render(makeController({ connection: mixed }));

      const rows = findAll('github-cloud-target');
      expect(rows.map((row) => row.getAttribute('data-target-state'))).toEqual([
        'ACTIVE',
        'NEEDS_APPROVAL',
        'SUSPENDED',
        'REMOVED',
        'PENDING_ADOPTION',
      ]);
      const label = (index: number): string =>
        rows[index].querySelector('[data-testid="github-cloud-target-state"]')
          ?.textContent ?? '';
      expect(label(0)).toBe('Active');
      expect(label(1)).toBe('Permissions needed');
      expect(label(2)).toBe('Suspended');
      expect(label(3)).toBe('Removed');
      expect(label(4)).toBe('Finishing setup');
      // Never rely on color alone: every state carries its own text.
      expect(new Set([0, 1, 2, 3, 4].map(label)).size).toBe(5);
    });

    it('explains how to resolve each blocked account without blaming the user', () => {
      render(makeController({ connection: mixed }));

      const rows = findAll('github-cloud-target');
      expect(rows[1].textContent).toContain(
        "An owner of this organization needs to approve the app's permissions on GitHub, then check again.",
      );
      expect(rows[2].textContent).toContain(
        'Unsuspend the app on GitHub, then check again.',
      );
      expect(rows[3].textContent).toContain(
        'Install it again to use its repositories.',
      );
    });

    it('asks a personal account to approve permissions itself', () => {
      render(
        makeController({
          connection: connection({
            targets: [
              target({ state: 'ACTIVE' }),
              target({
                id: 't-6',
                installationId: '1006',
                accountLogin: 'solo',
                state: 'NEEDS_APPROVAL',
              }),
            ],
          }),
        }),
      );

      const personal = findAll('github-cloud-target')[1];
      expect(personal.textContent).toContain(
        "Approve the app's permissions on GitHub, then check again.",
      );
      expect(personal.textContent).not.toContain('owner');
    });

    it('keeps Connected while at least one account is ready, and still offers Add account', () => {
      render(makeController({ connection: mixed }));

      expect(text('github-cloud-status')).toContain('Connected');
      expect(maybe('github-cloud-add-account')).toBe(true);
    });

    it('never names a button that the state does not render', () => {
      // "Add account" exists only while ACTIVE; "Install GitHub app" only while
      // NEEDS_INSTALL. A row hint that named either would dangle in the other.
      for (const state of [
        'PENDING_ADOPTION',
        'NEEDS_APPROVAL',
        'SUSPENDED',
        'REMOVED',
      ] as const) {
        for (const connectionState of ['ACTIVE', 'NEEDS_INSTALL'] as const) {
          render(
            makeController({
              connection: connection({
                state: connectionState,
                readyForProjects: false,
                targets: [target({ state })],
              }),
            }),
          );
          const rowText = find('github-cloud-target').textContent ?? '';
          expect(rowText).not.toMatch(/Add account|Install GitHub app/);
        }
      }
    });
  });

  describe('install needed with listed accounts', () => {
    function needsInstall(
      ...states: GitHubCloudTargetDto['state'][]
    ): GitHubCloudConnectionDto {
      return connection({
        state: 'NEEDS_INSTALL',
        readyForProjects: false,
        targets: states.map((state, index) =>
          target({
            id: `t-${index}`,
            installationId: String(2000 + index),
            accountLogin: `account-${index}`,
            state,
          }),
        ),
      });
    }

    function buttonLabels(): (string | null)[] {
      return Array.from(container.querySelectorAll('button')).map(
        (button) => button.textContent,
      );
    }

    it('leads with Install GitHub app when the only account was removed', () => {
      const controller = makeController({
        connection: needsInstall('REMOVED'),
      });
      render(controller);

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(text('github-cloud-status')).not.toContain('needs attention');
      expect(findAll('github-cloud-target')).toHaveLength(1);
      expect(find('github-cloud-install').className).toContain('bg-accent');
      expect(find('github-cloud-check-again').className).not.toContain(
        'bg-accent',
      );
      expect(buttonLabels()).toEqual([
        'Install GitHub app',
        'Check again',
        'Disconnect',
      ]);
      // The row's hint points at the button that is actually rendered.
      expect(find('github-cloud-target').textContent).toContain(
        'Install it again to use its repositories.',
      );
      click(find('github-cloud-install'));
      expect(controller.connect).toHaveBeenCalledWith({ intent: 'install' });
    });

    it.each(['NEEDS_APPROVAL', 'SUSPENDED'] as const)(
      'leads with Check again when the only account is %s on GitHub',
      (state) => {
        const controller = makeController({
          connection: needsInstall(state),
        });
        render(controller);

        const status = text('github-cloud-status');
        expect(status).toContain('GitHub app needs attention');
        expect(status).toContain('check again');
        // Never an invitation to install what is already installed.
        expect(status).not.toContain('GitHub app needed');
        expect(status).not.toMatch(/Install the/);
        const check = find('github-cloud-check-again');
        expect(check.className).toContain('bg-accent');
        // Installing on another account stays available, as a secondary action.
        const install = find('github-cloud-install');
        expect(install.className).not.toContain('bg-accent');
        expect(buttonLabels()).toEqual([
          'Install GitHub app',
          'Check again',
          'Disconnect',
        ]);

        click(check);
        expect(controller.verify).toHaveBeenCalledTimes(1);
        click(install);
        expect(controller.connect).toHaveBeenCalledWith({ intent: 'install' });
      },
    );

    it('says what to do on GitHub for a suspended or unapproved account row', () => {
      render(
        makeController({
          connection: needsInstall('SUSPENDED', 'NEEDS_APPROVAL'),
        }),
      );

      const rows = findAll('github-cloud-target');
      expect(rows[0].textContent).toContain(
        'Unsuspend the app on GitHub, then check again.',
      );
      expect(rows[1].textContent).toContain(
        "Approve the app's permissions on GitHub, then check again.",
      );
    });

    it('treats a blocked account among removed ones as needing attention', () => {
      render(
        makeController({
          connection: needsInstall('REMOVED', 'SUSPENDED', 'REMOVED'),
        }),
      );

      expect(text('github-cloud-status')).toContain(
        'GitHub app needs attention',
      );
      expect(find('github-cloud-check-again').className).toContain('bg-accent');
      expect(find('github-cloud-install').className).not.toContain('bg-accent');
      expect(buttonLabels()).toEqual([
        'Install GitHub app',
        'Check again',
        'Disconnect',
      ]);
    });

    it('treats only removed accounts as needing the app again', () => {
      render(
        makeController({
          connection: needsInstall('REMOVED', 'REMOVED'),
        }),
      );

      expect(text('github-cloud-status')).toContain('GitHub app needed');
      expect(find('github-cloud-install').className).toContain('bg-accent');
    });

    it('only moves the emphasis when the state moves between attention and install', () => {
      render(makeController({ connection: needsInstall('SUSPENDED') }));
      const install = find('github-cloud-install');
      const check = find('github-cloud-check-again');
      check.focus();

      render(makeController({ connection: needsInstall('REMOVED') }));

      // Same elements in the same order: a focused Check again is not moved
      // (and so not blurred) by the result of its own press.
      expect(find('github-cloud-install')).toBe(install);
      expect(find('github-cloud-check-again')).toBe(check);
      expect(document.activeElement).toBe(check);
      expect(buttonLabels()).toEqual([
        'Install GitHub app',
        'Check again',
        'Disconnect',
      ]);
      expect(install.className).toContain('bg-accent');
      expect(check.className).not.toContain('bg-accent');
    });
  });

  describe('live check', () => {
    it('shows Checking with GitHub and a busy, still-focusable Check again while checking', () => {
      const controller = makeController({
        connection: connection(),
        checking: true,
      });
      render(controller);

      expect(text('github-cloud-status')).toBe('Checking with GitHub…');
      const check = find('github-cloud-check-again');
      expect(check.textContent).toBe('Checking…');
      expect(check.getAttribute('aria-busy')).toBe('true');
      expect(check.getAttribute('aria-disabled')).toBe('true');
      expect(check.hasAttribute('disabled')).toBe(false);
      // The last known accounts stay visible while the check runs.
      expect(maybe('github-cloud-target')).toBe(true);

      click(check);
      expect(controller.verify).not.toHaveBeenCalled();
    });

    it('keeps the focused Check again button focused while it verifies', () => {
      const controller = makeController({ connection: connection() });
      render(controller);
      const check = find('github-cloud-check-again');
      check.focus();
      expect(document.activeElement).toBe(check);

      render(
        makeController({
          connection: connection(),
          busy: 'verify',
          checking: true,
        }),
      );

      expect(document.activeElement).toBe(find('github-cloud-check-again'));
      expect(find('github-cloud-check-again').textContent).toBe('Checking…');
    });
  });

  describe('busy connect', () => {
    it('shows Connecting…, stays focusable, ignores clicks and keeps Disconnect available', () => {
      const controller = makeController({
        connection: NEEDS_REAUTH,
        busy: 'connect',
      });
      render(controller);

      expect(text('github-cloud-status')).toBe('Connecting to GitHub…');
      const connect = find('github-cloud-connect');
      expect(connect.textContent).toBe('Connecting…');
      expect(connect.getAttribute('aria-busy')).toBe('true');
      expect(connect.getAttribute('aria-disabled')).toBe('true');
      expect(connect.hasAttribute('disabled')).toBe(false);
      connect.focus();
      expect(document.activeElement).toBe(connect);

      click(connect);
      expect(controller.connect).not.toHaveBeenCalled();
      // Disconnect preempts a pending action, so it stays available.
      const disconnect = find('github-cloud-disconnect');
      expect(disconnect.getAttribute('aria-disabled')).toBeNull();
      expect(disconnect.hasAttribute('disabled')).toBe(false);
    });

    it('marks Add account busy while the install step opens, and blocks the other actions', () => {
      const controller = makeController({
        connection: connection(),
        busy: 'install',
      });
      render(controller);

      const add = find('github-cloud-add-account');
      expect(add.textContent).toBe('Connecting…');
      expect(add.getAttribute('aria-busy')).toBe('true');
      expect(
        find('github-cloud-check-again').getAttribute('aria-disabled'),
      ).toBe('true');
      click(find('github-cloud-check-again'));
      click(add);
      expect(controller.verify).not.toHaveBeenCalled();
      expect(controller.connect).not.toHaveBeenCalled();
    });

    it('labels the install step Connecting… even when Connect answered with install', () => {
      render(makeController({ connection: NEEDS_INSTALL, busy: 'connect' }));

      expect(find('github-cloud-install').textContent).toBe('Connecting…');
    });
  });

  describe('errors', () => {
    it('keeps the last known accounts and offers Check again when the live check failed', () => {
      const controller = makeController({
        connection: connection(),
        stale: true,
        error: controllerError(),
      });
      render(controller);

      const alert = find('github-cloud-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain(
        "Couldn't check your GitHub connection. Try again.",
      );
      expect(alert.textContent).toContain('Showing the last known status.');
      expect(maybe('github-cloud-target')).toBe(true);
      const check = find('github-cloud-check-again');
      expect(check.className).toContain('bg-accent');

      click(check);
      expect(controller.verify).toHaveBeenCalledTimes(1);
    });

    it('dismisses an error through the controller', () => {
      const controller = makeController({
        connection: connection(),
        error: controllerError({
          source: 'connect',
          message: "Couldn't connect GitHub. Try again.",
        }),
      });
      render(controller);

      const dismiss = required(
        find('github-cloud-error').querySelector('button'),
      );
      expect(dismiss.getAttribute('aria-label')).toBe('Dismiss');
      click(dismiss);
      expect(controller.clearError).toHaveBeenCalledTimes(1);
    });

    it('hands focus to the card heading when a dismissed error takes its button along', () => {
      render(
        makeController({
          connection: connection(),
          error: controllerError({
            source: 'connect',
            message: "Couldn't connect GitHub. Try again.",
          }),
        }),
      );
      const dismiss = required(
        find('github-cloud-error').querySelector('button'),
      );
      dismiss.focus();
      click(dismiss);

      render(makeController({ connection: connection() }));

      expect(maybe('github-cloud-error')).toBe(false);
      expect(document.activeElement).toBe(container.querySelector('h2'));
    });

    it.each(['link', 'setup', 'connect'] as const)(
      'shows a %s failure as safe controller copy next to the actions',
      (source) => {
        const message = `Copy for ${source}.`;
        render(
          makeController({
            connection: DISCONNECTED,
            error: controllerError({ source, message }),
          }),
        );

        expect(text('github-cloud-error')).toContain(message);
        expect(maybe('github-cloud-connect')).toBe(true);
      },
    );

    it('renders the rate limit distinctly: calm attention, retry later, not an alert', () => {
      const message = GITHUB_CLOUD_ERROR_COPY['github-rate-limited'];
      const controller = makeController({
        connection: connection(),
        stale: true,
        error: controllerError({ code: 'github-rate-limited', message }),
      });
      render(controller);

      expect(maybe('github-cloud-error')).toBe(false);
      const limited = find('github-cloud-rate-limit');
      expect(limited.textContent).toContain(message);
      expect(limited.getAttribute('data-notice-intent')).toBe('attention');
      expect(limited.getAttribute('role')).toBe('status');
      // The retry is the same Check again, offered as the recommended action.
      click(find('github-cloud-check-again'));
      expect(controller.verify).toHaveBeenCalledTimes(1);
    });

    it('never renders text it was not given by the controller', () => {
      render(
        makeController({
          connection: connection(),
          error: controllerError({
            code: 'github-unavailable',
            message: GITHUB_CLOUD_ERROR_COPY['github-unavailable'],
          }),
        }),
      );

      expect(text('github-cloud-error')).toContain(
        "Couldn't reach GitHub. Try again.",
      );
    });
  });

  describe('notices', () => {
    it('shows the owner-approval notice and dismisses it', () => {
      const controller = makeController({
        connection: DISCONNECTED,
        notice: {
          kind: 'requested',
          message:
            'Your request to install the GitHub app was sent. An owner of that GitHub organization needs to approve it.',
        },
      });
      render(controller);

      const notice = find('github-cloud-notice');
      expect(notice.getAttribute('role')).toBe('status');
      expect(notice.textContent).toContain(
        'An owner of that GitHub organization',
      );
      click(required(notice.querySelector('button')));
      expect(controller.dismissNotice).toHaveBeenCalledTimes(1);
    });

    it('hands focus to the card heading when a dismissed notice takes its button along', () => {
      render(
        makeController({
          connection: DISCONNECTED,
          notice: { kind: 'requested', message: 'Request sent.' },
        }),
      );
      const dismiss = required(
        find('github-cloud-notice').querySelector('button'),
      );
      dismiss.focus();
      click(dismiss);

      render(makeController({ connection: DISCONNECTED }));

      expect(maybe('github-cloud-notice')).toBe(false);
      expect(document.activeElement).toBe(container.querySelector('h2'));
    });
  });

  describe('disconnect', () => {
    function openDialog(
      controller: GitHubCloudConnectionController,
    ): HTMLElement {
      render(controller);
      click(find('github-cloud-disconnect'));
      const opened = dialog();
      if (!opened) throw new Error('dialog did not open');
      return opened;
    }

    it('confirms first, and explains that sign-in and running worktrees are preserved', () => {
      const controller = makeController({ connection: connection() });
      const opened = openDialog(controller);

      expect(controller.disconnect).not.toHaveBeenCalled();
      expect(opened.textContent).toContain('Disconnect GitHub?');
      expect(opened.textContent).toContain(
        "Signing in with GitHub isn't affected",
      );
      expect(opened.textContent).toContain(
        'Worktrees that are already running in the cloud keep working.',
      );
      const confirm = find('confirm-dialog-confirm', opened);
      expect(confirm.textContent).toBe('Disconnect');
      // Destructive confirmation never takes the accent role.
      expect(confirm.className).toContain('bg-destructive');
      // A reflexive Enter backs out: focus lands on Cancel.
      expect(document.activeElement).toBe(
        find('confirm-dialog-cancel', opened),
      );
    });

    it('cancelling closes the dialog without disconnecting and returns focus to the trigger', () => {
      const controller = makeController({ connection: connection() });
      render(controller);
      const trigger = find('github-cloud-disconnect');
      trigger.focus();
      click(trigger);

      click(find('confirm-dialog-cancel', openDialogElement()));

      expect(dialog()).toBeNull();
      expect(controller.disconnect).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
    });

    it('closes the dialog only after a successful disconnect', async () => {
      const controller = makeController({ connection: connection() });
      const opened = openDialog(controller);

      await clickAsync(find('confirm-dialog-confirm', opened));

      expect(controller.disconnect).toHaveBeenCalledTimes(1);
      expect(dialog()).toBeNull();
    });

    it('keeps the dialog open with the error and a retry when the disconnect fails', async () => {
      const failure = controllerError({
        source: 'disconnect',
        message: "Couldn't disconnect GitHub. Try again.",
      });
      const controller = makeController({
        connection: connection(),
        disconnect: jest.fn(() => {
          render(makeController({ connection: connection(), error: failure }));
          return Promise.resolve(false);
        }),
      });
      const opened = openDialog(controller);

      await clickAsync(find('confirm-dialog-confirm', opened));

      const still = openDialogElement();
      const inline = find('github-cloud-disconnect-error', still);
      expect(inline.getAttribute('role')).toBe('alert');
      expect(inline.textContent).toContain(
        "Couldn't disconnect GitHub. Try again.",
      );
      // The error lives in the dialog only, not duplicated in the card.
      expect(maybe('github-cloud-error')).toBe(false);
      // Still actionable: the confirm button is enabled again.
      const confirm = find('confirm-dialog-confirm', still);
      expect(confirm.hasAttribute('disabled')).toBe(false);
      expect(confirm.textContent).toBe('Disconnect');
    });

    it('clears a failed disconnect when the dialog is cancelled', () => {
      const failure = controllerError({
        source: 'disconnect',
        message: "Couldn't disconnect GitHub. Try again.",
      });
      const controller = makeController({ connection: connection() });
      render(controller);
      click(find('github-cloud-disconnect'));
      render(
        makeController({
          connection: connection(),
          error: failure,
          clearError: controller.clearError,
        }),
      );

      click(find('confirm-dialog-cancel', openDialogElement()));

      expect(dialog()).toBeNull();
      expect(controller.clearError).toHaveBeenCalledTimes(1);
    });

    it('blocks a second Disconnect while one runs', () => {
      render(makeController({ connection: connection(), busy: 'disconnect' }));

      const trigger = find('github-cloud-disconnect');
      expect(trigger.getAttribute('aria-disabled')).toBe('true');
      click(trigger);
      expect(dialog()).toBeNull();
    });

    it('shows Disconnecting… and blocks cancel and confirm while it runs', () => {
      render(makeController({ connection: connection() }));
      click(find('github-cloud-disconnect'));
      render(makeController({ connection: connection(), busy: 'disconnect' }));

      const opened = openDialogElement();
      const confirm = find('confirm-dialog-confirm', opened);
      expect(confirm.textContent).toBe('Disconnecting…');
      expect(confirm.hasAttribute('disabled')).toBe(true);
      expect(
        find('confirm-dialog-cancel', opened).hasAttribute('disabled'),
      ).toBe(true);
    });

    it('is not offered for a connection that is already disconnected', () => {
      render(makeController({ connection: DISCONNECTED }));

      expect(maybe('github-cloud-disconnect')).toBe(false);
    });
  });

  describe('long names on a narrow screen', () => {
    const LONG_USER = 'a'.repeat(39);
    const LONG_ORG = 'very-long-organization-name-with-dashes-39';

    it('truncates the identity on one line and keeps the full value in a title', () => {
      render(
        makeController({
          connection: connection({ githubLogin: LONG_USER }),
        }),
      );

      const identity = find('github-cloud-identity');
      const login = find('github-cloud-identity-login');
      expect(login.className).toContain('truncate');
      expect(login.getAttribute('title')).toBe(LONG_USER);
      expect(login.textContent).toBe(LONG_USER);
      // Every flex ancestor up to the identity block may shrink below its content.
      expect(login.parentElement?.className).toContain('min-w-0');
      expect(identity.className).toContain('min-w-0');
    });

    it('truncates account names, lets the row stack on narrow widths, and never overflows', () => {
      render(
        makeController({
          connection: connection({
            targets: [
              target({ accountLogin: LONG_ORG, accountType: 'Organization' }),
              target({
                id: 't-2',
                installationId: '1002',
                accountLogin: LONG_USER,
                state: 'NEEDS_APPROVAL',
              }),
            ],
          }),
        }),
      );

      const rows = findAll('github-cloud-target');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const name = row.querySelector<HTMLElement>(
          '[data-testid="github-cloud-target-login"]',
        );
        expect(name?.className).toContain('truncate');
        expect(name?.getAttribute('title')).toBe(name?.textContent);
        // The name may shrink below its content inside its grid cell, and the
        // row is one column until `sm`: the state label wraps under the name
        // instead of squeezing it.
        expect(name?.className).toContain('min-w-0');
        expect(row.className).toContain('grid');
        expect(row.className).toContain('sm:grid-cols-[minmax(0,1fr)_auto]');
        expect(row.className).not.toMatch(/(^|\s)grid-cols-/);
      }
      expect(
        rows[0]
          .querySelector('[data-testid="github-cloud-target-login"]')
          ?.getAttribute('title'),
      ).toBe(LONG_ORG);
      expect(find('github-cloud-targets').className).not.toMatch(/overflow-x/);
    });

    it('lets the action row wrap instead of overflowing', () => {
      render(makeController({ connection: connection() }));

      const actions = find('github-cloud-actions');
      expect(actions.className).toContain('flex-wrap');
    });
  });

  describe('keyboard focus and announcements', () => {
    it('exposes the status as a polite live region that stays mounted across states', () => {
      // The first read mounts the region empty; the spinner holds the place.
      render(makeController({ loading: true }));
      const status = find('github-cloud-status');
      expect(status.textContent).toBe('');

      render(makeController({ connection: connection(), checking: true }));
      expect(find('github-cloud-status')).toBe(status);
      render(makeController({ connection: connection(), verified: true }));
      expect(find('github-cloud-status')).toBe(status);
      expect(status.getAttribute('role')).toBe('status');
      expect(status.textContent).toContain('Connected');
    });

    it('uses real buttons with visible names for every action', () => {
      render(makeController({ connection: connection() }));

      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Add account',
        'Check again',
        'Disconnect',
      ]);
      for (const button of buttons) {
        expect(button.getAttribute('type')).toBe('button');
      }
    });

    it('moves focus to the card heading when the focused action disappears after an action', () => {
      const controller = makeController({ connection: DISCONNECTED });
      render(controller);
      const connect = find('github-cloud-connect');
      connect.focus();
      click(connect);
      expect(controller.connect).toHaveBeenCalledTimes(1);

      // The connection settles as connected; the Connect button is gone.
      render(makeController({ connection: connection(), verified: true }));

      expect(connect.isConnected).toBe(false);
      const heading = container.querySelector('h2');
      expect(document.activeElement).toBe(heading);
      expect(heading?.getAttribute('tabindex')).toBe('-1');
    });

    it('does not steal focus from another control the user moved to', () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      const controller = makeController({ connection: DISCONNECTED });
      render(controller);
      click(find('github-cloud-connect'));
      outside.focus();

      render(makeController({ connection: connection(), verified: true }));

      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });
});
