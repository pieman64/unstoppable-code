/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HomeLinkTargetChip } from '../HomeLinkTargetChip';
import type { HomeLinkAction, HomeLinkTargetState } from '../homeLinkTarget';
import { openIntegrationSettings } from '@/lib/navigation/settings-destinations';
import { useGitHubConnectOfferStore } from '@/stores/githubConnectOfferStore';

const mockComposer: {
  mode: 'chat';
  linkTarget: HomeLinkTargetState;
  retryLinkTarget: jest.Mock;
} = {
  mode: 'chat',
  linkTarget: { status: 'idle' },
  retryLinkTarget: jest.fn(),
};
jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: Object.assign(
    <T,>(selector: (state: typeof mockComposer) => T): T =>
      selector(mockComposer),
    { getState: (): typeof mockComposer => mockComposer },
  ),
}));
jest.mock('../homeSend', () => ({ cancelHomeLinkSubmission: jest.fn() }));
jest.mock('../homeLinkTargetHost', () => ({
  currentHomeLinkResolveContext: jest.fn(),
  createHomeLinkResolveDeps: jest.fn(),
}));
jest.mock('../homeLinkTargetSync', () => ({
  currentHomeLinkFingerprint: jest.fn(),
  syncHomeLinkTarget: jest.fn(),
}));
jest.mock('@/lib/contextScope', () => ({
  switchContextForWorkspace: jest.fn(),
}));
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openIntegrationSettings: jest.fn(),
}));

describe('HomeLinkTargetChip GitHub actions (CAN-4466)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    useGitHubConnectOfferStore.setState({ offer: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderBlocked(actions: HomeLinkAction[]): void {
    mockComposer.linkTarget = {
      status: 'blocked',
      key: 'github.com/acme/new',
      fingerprint: 'f',
      message: 'Connect GitHub to add this repository as a project.',
      actions,
    };
    act(() =>
      root.render(
        createElement(HomeLinkTargetChip, { onChooseProject: jest.fn() }),
      ),
    );
  }

  function click(id: string): void {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="home-link-target-action-${id}"]`,
    );
    if (!button) throw new Error(`Missing action ${id}`);
    act(() => button.click());
  }

  it('offers the GitHub sign-in that re-resolves the link', () => {
    renderBlocked([{ kind: 'sign-in-github' }, { kind: 'retry' }]);
    expect(
      container.querySelector(
        '[data-testid="home-link-target-action-sign-in-github"]',
      )?.textContent,
    ).toBe('Connect GitHub');
    click('sign-in-github');
    const continuation =
      useGitHubConnectOfferStore.getState().offer?.continuation;
    expect(typeof continuation?.operationId).toBe('string');
    expect(continuation).toEqual({
      operationId: continuation?.operationId,
      kind: 'home-link-add-project',
      resume: 'resolve',
    });
    expect(openIntegrationSettings).not.toHaveBeenCalled();
    expect(mockComposer.retryLinkTarget).not.toHaveBeenCalled();
  });

  it('re-checks the link instead when another offer is pending', () => {
    useGitHubConnectOfferStore.getState().requestOffer({
      operationId: 'op-push',
      kind: 'push',
      projectId: 'p',
      worktreeId: 'w',
      expectedHeadBranch: 'main',
    });
    renderBlocked([{ kind: 'sign-in-github' }]);
    click('sign-in-github');
    expect(mockComposer.retryLinkTarget).toHaveBeenCalledTimes(1);
    expect(
      useGitHubConnectOfferStore.getState().offer?.continuation.operationId,
    ).toBe('op-push');
  });

  it('still opens Settings for connect-github', () => {
    renderBlocked([{ kind: 'connect-github' }]);
    click('connect-github');
    expect(openIntegrationSettings).toHaveBeenCalledTimes(1);
    expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
  });
});
