/**
 * @jest-environment jsdom
 */
import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitHubConnectOfferHost } from '../GitHubConnectOfferHost';
import {
  abandonGitHubConnectOffer,
  settleGitHubConnectOffer,
} from '@/lib/githubConnectOffer';
import {
  useGitHubConnectOfferStore,
  type GitHubConnectContinuation,
} from '@/stores/githubConnectOfferStore';

const mockCapabilities = { githubConnection: true };
jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): typeof mockCapabilities => mockCapabilities,
}));

jest.mock('@/lib/githubConnectOffer', () => ({
  settleGitHubConnectOffer: jest.fn(() => Promise.resolve()),
  abandonGitHubConnectOffer: jest.fn(),
}));
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (props: {
    provider: string;
    intro?: string;
    introTestId?: string;
    onClose: () => void;
    onCancel?: () => void;
  }): JSX.Element =>
    createElement(
      'div',
      { 'data-testid': 'auth-login-modal', 'data-provider': props.provider },
      createElement('p', { 'data-testid': props.introTestId }, props.intro),
      createElement('button', {
        'data-testid': 'close',
        onClick: props.onClose,
      }),
      createElement('button', {
        'data-testid': 'cancel',
        onClick: props.onCancel,
      }),
    ),
}));

describe('GitHubConnectOfferHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockCapabilities.githubConnection = true;
    useGitHubConnectOfferStore.setState({ offer: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function offer(kind: 'push' | 'pr'): void {
    useGitHubConnectOfferStore.getState().requestOffer({
      operationId: `op-${kind}`,
      kind,
      projectId: 'project-a',
      worktreeId: 'wt-1',
      repoIds: ['repo-1'],
      expectedHeadBranch: 'main',
    });
  }

  it('renders nothing without an offer', () => {
    act(() => root.render(createElement(GitHubConnectOfferHost)));
    expect(container.innerHTML).toBe('');
  });

  it('requires an explicit interactive GitHub connection capability', () => {
    offer('pr');
    mockCapabilities.githubConnection = false;
    act(() => root.render(createElement(GitHubConnectOfferHost)));
    expect(container.innerHTML).toBe('');
  });

  it.each([
    ['push', 'Connect GitHub to continue pushing this branch.'],
    ['pr', 'Connect GitHub to continue opening this pull request.'],
  ] as const)('offers GitHub sign-in for a %s', (kind, copy) => {
    offer(kind);
    act(() => root.render(createElement(GitHubConnectOfferHost)));
    const intro = container.querySelector(
      `[data-testid="github-connect-offer-${kind}"]`,
    );
    expect(intro?.textContent).toBe(copy);
    expect(
      container
        .querySelector('[data-testid="auth-login-modal"]')
        ?.getAttribute('data-provider'),
    ).toBe('github');
  });

  it.each([
    [
      {
        operationId: 'op-org',
        kind: 'org-project-setup',
        projectId: 'project-a',
        destinationRoot: '/repos',
        accountEpoch: 1,
      },
      'Connect GitHub to continue setting up this project.',
    ],
    [
      {
        operationId: 'op-home',
        kind: 'home-link-add-project',
        resume: 'resolve',
      },
      'Connect GitHub to continue adding this project.',
    ],
  ] satisfies [GitHubConnectContinuation, string][])(
    'offers GitHub sign-in to add a project: %o',
    (continuation, copy) => {
      useGitHubConnectOfferStore.getState().requestOffer(continuation);
      act(() => root.render(createElement(GitHubConnectOfferHost)));
      expect(
        container.querySelector(
          `[data-testid="github-connect-offer-${continuation.kind}"]`,
        )?.textContent,
      ).toBe(copy);
    },
  );

  it('settles the offer when the sign-in closes and hides while settling', () => {
    offer('push');
    act(() => root.render(createElement(GitHubConnectOfferHost)));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="close"]')
        ?.click(),
    );
    expect(settleGitHubConnectOffer).toHaveBeenCalledTimes(1);
    act(() => {
      useGitHubConnectOfferStore.getState().beginSettle('op-push');
    });
    expect(
      container.querySelector('[data-testid="auth-login-modal"]'),
    ).toBeNull();
  });

  it('explicit cancellation clears the offer without settling or retrying', () => {
    offer('push');
    act(() => root.render(createElement(GitHubConnectOfferHost)));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="cancel"]')
        ?.click(),
    );
    expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    expect(settleGitHubConnectOffer).not.toHaveBeenCalled();
    expect(abandonGitHubConnectOffer).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op-push', kind: 'push' }),
    );
  });

  it('cancelling a Home send offer hands its continuation to abandon', () => {
    const continuation: GitHubConnectContinuation = {
      operationId: 'op-home',
      kind: 'home-link-add-project',
      resume: 'send',
      failureMessage: 'Couldn’t add acme/new: fatal: auth',
    };
    useGitHubConnectOfferStore.getState().requestOffer(continuation);
    act(() => root.render(createElement(GitHubConnectOfferHost)));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="cancel"]')
        ?.click(),
    );
    expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
    expect(abandonGitHubConnectOffer).toHaveBeenCalledWith(continuation);
  });
});
