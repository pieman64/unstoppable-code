import type { OrgProjectSetupProgress } from '@canopy/protocol/org-projects';
import { settleGitHubLogin } from '@/lib/githubConnection';
import {
  abandonGitHubConnectOffer,
  settleGitHubConnectOffer,
} from '@/lib/githubConnectOffer';
import { getOrgProjectAddStore } from '@/lib/orgProjectCatalogAdd';
import { startOrgProjectSetupWithGitHubOffer } from '@/lib/orgProjectConnectOffer';
import type {
  HomeLinkPlan,
  HomeLinkTargetState,
} from '@/components/home/homeLinkTarget';
import {
  useGitHubConnectOfferStore,
  type GitHubConnectContinuation,
  type HomeLinkAddProjectContinuation,
} from '@/stores/githubConnectOfferStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';

jest.mock('@/lib/githubConnection', () => ({
  settleGitHubLogin: jest.fn(),
}));
jest.mock('@/lib/orgProjectConnectOffer', () => ({
  startOrgProjectSetupWithGitHubOffer: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/orgProjectCatalogAdd', () => ({
  getOrgProjectAddStore: jest.fn(),
}));
jest.mock('@/stores/githubStore', () => {
  const state = {
    addToast: jest.fn(),
    continueAfterGitHubConnect: jest.fn(() => Promise.resolve()),
    gitActionOperationIds: {},
  };
  return {
    useGitHubStore: {
      getState: (): typeof state => state,
      subscribe: (): (() => void) => (): void => {},
    },
    worktreeKey: (projectId: string, worktreeId: string): string =>
      `${projectId}/${worktreeId}`,
  };
});
jest.mock('@/stores/homeComposerStore', () => {
  const linkTarget: HomeLinkTargetState = {
    status: 'ready',
    key: 'github.com/acme/new',
    fingerprint: 'github.com/acme/new',
    plan: {
      kind: 'create-project',
      repository: {
        owner: 'acme',
        repo: 'new',
        repositoryKey: 'acme/new',
        cloneUrl: 'https://github.com/acme/new.git',
        isArchived: false,
      },
      pending: { kind: 'default-branch' },
    },
  };
  const state = {
    linkTarget,
    isSending: false,
    mode: 'chat',
    text: 'start on https://github.com/acme/new',
    retryLinkTarget: jest.fn(),
    requestGitHubConnectResume: jest.fn(),
  };
  const listeners = new Set<() => void>();
  return {
    useHomeComposerStore: {
      getState: (): typeof state => state,
      setState: jest.fn(),
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
      /** Test helper: updates the link target and notifies subscribers. */
      setLinkTargetForTest: (linkTarget: typeof state.linkTarget): void => {
        state.linkTarget = linkTarget;
        Array.from(listeners).forEach((listener: () => void): void => {
          listener();
        });
      },
      listenerCountForTest: (): number => listeners.size,
    },
  };
});

const settle = jest.mocked(settleGitHubLogin);
const startSetup = jest.mocked(startOrgProjectSetupWithGitHubOffer);
const getStore = jest.mocked(getOrgProjectAddStore);
const github = useGitHubStore.getState();
const composer = useHomeComposerStore.getState();
const setComposer = jest.mocked(useHomeComposerStore.setState);
const composerTestApi = jest.requireMock<{
  useHomeComposerStore: {
    setLinkTargetForTest(linkTarget: HomeLinkTargetState): void;
    listenerCountForTest(): number;
  };
}>('@/stores/homeComposerStore').useHomeComposerStore;

const FAILURE = 'Couldn’t add acme/new: fatal: could not read Username';
const DRAFT = 'start on https://github.com/acme/new';
const HOME_LINK_KEY = 'github.com/acme/new';
const HOME_LINK_FINGERPRINT = 'github.com/acme/new';

function homeLinkPlan(repo: string): HomeLinkPlan {
  return {
    kind: 'create-project',
    repository: {
      owner: 'acme',
      repo,
      repositoryKey: `acme/${repo}`,
      cloneUrl: `https://github.com/acme/${repo}.git`,
      isArchived: false,
    },
    pending: { kind: 'default-branch' },
  };
}

function readyLinkTarget(
  key: string = HOME_LINK_KEY,
  repo = 'new',
): HomeLinkTargetState {
  return {
    status: 'ready',
    key,
    fingerprint: HOME_LINK_FINGERPRINT,
    plan: homeLinkPlan(repo),
  };
}

function resolvingLinkTarget(): HomeLinkTargetState {
  return {
    status: 'resolving',
    key: HOME_LINK_KEY,
    fingerprint: HOME_LINK_FINGERPRINT,
  };
}

function blockedLinkTarget(): HomeLinkTargetState {
  return {
    status: 'blocked',
    key: HOME_LINK_KEY,
    fingerprint: HOME_LINK_FINGERPRINT,
    message: 'GitHub access is required',
    actions: [],
  };
}

function progress(): OrgProjectSetupProgress {
  return {
    projectId: 'project-a',
    instanceId: null,
    state: 'failed',
    errorCode: 'github-not-authenticated',
    message: 'GitHub access is needed to clone this repository',
    percent: null,
    updatedAt: '2026-10-19T10:00:00.000Z',
  };
}

function orgStore(
  overrides: { accountEpoch?: number; hasProgress?: boolean } = {},
): ReturnType<typeof getOrgProjectAddStore> {
  const setupProgress: Readonly<Record<string, OrgProjectSetupProgress>> =
    overrides.hasProgress === false ? {} : { 'project-a': progress() };
  const state = {
    accountEpoch: overrides.accountEpoch ?? 3,
    setupProgress,
    startSetup: jest.fn(),
    setPreference: jest.fn(),
    requestSetup: jest.fn(),
  };
  return { getState: () => state, subscribe: () => () => {} };
}

const orgContinuation: GitHubConnectContinuation = {
  operationId: 'op-org',
  kind: 'org-project-setup',
  projectId: 'project-a',
  destinationRoot: '/repos',
  accountEpoch: 3,
};

function homeContinuation(
  resume: HomeLinkAddProjectContinuation['resume'],
): HomeLinkAddProjectContinuation {
  return {
    operationId: 'op-home',
    kind: 'home-link-add-project',
    resume,
    ...(resume === 'send'
      ? {
          linkKey: 'github.com/acme/new',
          draftText: DRAFT,
          failureMessage: FAILURE,
        }
      : {}),
  };
}

async function settleWith(
  continuation: GitHubConnectContinuation,
  connection: Awaited<ReturnType<typeof settleGitHubLogin>>,
): Promise<void> {
  useGitHubConnectOfferStore.getState().requestOffer(continuation);
  settle.mockResolvedValue(connection);
  await settleGitHubConnectOffer();
}

describe('GitHub connect offer for adding a project', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGitHubConnectOfferStore.setState({ offer: null });
    composer.linkTarget = readyLinkTarget();
    composer.isSending = false;
    composer.mode = 'chat';
    composer.text = DRAFT;
    getStore.mockReturnValue(orgStore());
  });

  describe('org project setup', () => {
    it('continues the setup once with the consented destination', async () => {
      const store = orgStore();
      getStore.mockReturnValue(store);
      await settleWith(orgContinuation, 'connected');
      expect(startSetup).toHaveBeenCalledTimes(1);
      expect(startSetup).toHaveBeenCalledWith(store, 'project-a', '/repos', {
        continuation: true,
      });
      expect(useGitHubConnectOfferStore.getState().offer).toBeNull();
      await settleGitHubConnectOffer();
      expect(startSetup).toHaveBeenCalledTimes(1);
      expect(github.continueAfterGitHubConnect).not.toHaveBeenCalled();
    });

    it.each([
      ['another account', { accountEpoch: 4 }],
      ['a row that is gone', { hasProgress: false }],
    ])('does not continue for %s', async (_label, overrides) => {
      getStore.mockReturnValue(orgStore(overrides));
      await settleWith(orgContinuation, 'connected');
      expect(startSetup).not.toHaveBeenCalled();
    });

    it('swallows a continuation that rejects', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      startSetup.mockRejectedValueOnce(new Error('claim refused'));
      await expect(
        settleWith(orgContinuation, 'connected'),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('GitHub connect continuation failed'),
      );
      error.mockRestore();
    });

    it('toasts without a worktree when GitHub is still not connected', async () => {
      await settleWith(orgContinuation, 'disconnected');
      expect(startSetup).not.toHaveBeenCalled();
      expect(github.addToast).toHaveBeenCalledWith(
        'GitHub is not connected. Connect and try again.',
        'info',
        undefined,
        { category: 'GitHub' },
      );
    });
  });

  describe('Home link', () => {
    it('re-resolves the link for a resolve offer', async () => {
      await settleWith(homeContinuation('resolve'), 'connected');
      expect(composer.retryLinkTarget).toHaveBeenCalledTimes(1);
      expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
    });

    it('resends once when the same link is ready', async () => {
      await settleWith(homeContinuation('send'), 'connected');
      expect(composer.requestGitHubConnectResume).toHaveBeenCalledTimes(1);
      expect(setComposer).not.toHaveBeenCalled();
    });

    // Connecting re-resolves the link, and the send gate stops a link that is
    // still resolving, so the resend waits for the check to finish.
    it('waits for a re-resolving link before resending once', async () => {
      composer.linkTarget = resolvingLinkTarget();
      const settled = settleWith(homeContinuation('send'), 'connected');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
      composerTestApi.setLinkTargetForTest(readyLinkTarget());
      await settled;
      expect(composer.requestGitHubConnectResume).toHaveBeenCalledTimes(1);
      expect(setComposer).not.toHaveBeenCalled();
      expect(composerTestApi.listenerCountForTest()).toBe(0);
    });

    it('restores the failure when the re-resolved link is blocked', async () => {
      composer.linkTarget = resolvingLinkTarget();
      const settled = settleWith(homeContinuation('send'), 'connected');
      await Promise.resolve();
      composerTestApi.setLinkTargetForTest(blockedLinkTarget());
      await settled;
      expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
      expect(setComposer).toHaveBeenCalledWith({
        sendError: FAILURE,
        sendErrorRetryable: true,
      });
    });

    it('restores the failure when the link never finishes resolving', async () => {
      jest.useFakeTimers();
      try {
        composer.linkTarget = resolvingLinkTarget();
        const settled = settleWith(homeContinuation('send'), 'connected');
        await jest.advanceTimersByTimeAsync(15_000);
        await settled;
        expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
        expect(setComposer).toHaveBeenCalledWith({
          sendError: FAILURE,
          sendErrorRetryable: true,
        });
        expect(composerTestApi.listenerCountForTest()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    const targetCases: ReadonlyArray<[string, HomeLinkTargetState, boolean]> = [
      ['the link is blocked', blockedLinkTarget(), false],
      ['a send is already running', readyLinkTarget(), true],
    ];
    it.each(targetCases)(
      'restores the failure instead of resending when %s',
      async (_label, linkTarget, isSending) => {
        composer.linkTarget = linkTarget;
        composer.isSending = isSending;
        await settleWith(homeContinuation('send'), 'connected');
        expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
        expect(setComposer).toHaveBeenCalledWith({
          sendError: FAILURE,
          sendErrorRetryable: true,
        });
      },
    );

    it.each([
      ['the draft was edited', { text: 'start on acme/new, then deploy' }],
      ['the composer left chat mode', { mode: 'pipeline' }],
    ])(
      'restores the failure instead of resending when %s',
      async (_label, change) => {
        Object.assign(composer, change);
        await settleWith(homeContinuation('send'), 'connected');
        expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
        expect(setComposer).toHaveBeenCalledWith({
          sendError: FAILURE,
          sendErrorRetryable: true,
        });
      },
    );

    // The failure belongs to its link; another link's draft keeps its state.
    it('neither resends nor restores when the draft targets another link', async () => {
      composer.linkTarget = readyLinkTarget('github.com/acme/other', 'other');
      await settleWith(homeContinuation('send'), 'connected');
      expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
      expect(setComposer).not.toHaveBeenCalled();
      abandonGitHubConnectOffer(homeContinuation('send'));
      expect(setComposer).not.toHaveBeenCalled();
    });

    it('restores the failure when GitHub is still not connected', async () => {
      await settleWith(homeContinuation('send'), 'disconnected');
      expect(composer.requestGitHubConnectResume).not.toHaveBeenCalled();
      expect(setComposer).toHaveBeenCalledWith({
        sendError: FAILURE,
        sendErrorRetryable: true,
      });
    });

    it('abandoning a send restores the failure; a resolve has nothing to restore', () => {
      abandonGitHubConnectOffer(homeContinuation('resolve'));
      expect(setComposer).not.toHaveBeenCalled();
      abandonGitHubConnectOffer(homeContinuation('send'));
      expect(setComposer).toHaveBeenCalledWith({
        sendError: FAILURE,
        sendErrorRetryable: true,
      });
    });
  });
});
