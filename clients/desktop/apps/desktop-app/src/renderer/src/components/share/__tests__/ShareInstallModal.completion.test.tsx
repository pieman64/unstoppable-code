/**
 * @jest-environment jsdom
 *
 * CAN-3651: an automation link opens straight into the install review. A
 * finished install or update closes the flow and reveals the exact local copy
 * on Automations → Triggered; dismissing the review closes the flow too.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DeepLinkShareOpenEvent,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type {
  AutomationProjectCreationRequest,
  InstallAutomationOutcome,
} from '@/components/automations/InstallSharedAutomationModal';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface CapturedWizardProps {
  subtitle?: ReactNode;
  onSubmittingChange?: (submitting: boolean) => void;
  onClose: () => void;
  onDone: (activityId?: string, outcome?: InstallAutomationOutcome) => void;
  onCreateProject?: (request: AutomationProjectCreationRequest) => void;
}

const mockCompleteInstallReview = jest.fn<void, [string]>();
const mockCloseInstallReview = jest.fn<void, []>();
let mockInstallReview: {
  entity: 'automation';
  externalId: string;
  staleActivity?: ScheduledActivity;
} | null = null;
let mockWizardProps: CapturedWizardProps | null = null;
let mockOpeningInstallReview = false;
let mockAuthorUsername: string | null = null;

jest.mock('../../shared', () => ({
  DialogModal: ({
    children,
    dataTestId,
    subtitle,
  }: {
    children: ReactNode;
    dataTestId?: string;
    subtitle?: ReactNode;
  }): JSX.Element => (
    <section data-testid={dataTestId}>
      {subtitle !== undefined && (
        <p data-testid="dialog-subtitle">{subtitle}</p>
      )}
      {children}
    </section>
  ),
  LoadingPlaceholder: ({ label }: { label: string }): JSX.Element => (
    <p data-testid="loading-placeholder">{label}</p>
  ),
}));
jest.mock('@canopy/ui-shared/components/ShareInstallDialog', () => ({
  ShareInstallDialog: ({
    dataTestId,
    publisher,
    loading,
    primary,
  }: {
    dataTestId?: string;
    publisher?: ReactNode;
    loading?: ReactNode;
    primary?: { label: string; testId?: string; disabled?: boolean };
  }): JSX.Element => (
    <section data-testid={dataTestId}>
      {publisher !== undefined && (
        <p data-testid="dialog-subtitle">{publisher}</p>
      )}
      {loading}
      {primary !== undefined && (
        <button
          type="button"
          data-testid={primary.testId}
          disabled={primary.disabled === true}
        >
          {primary.label}
        </button>
      )}
    </section>
  ),
}));
jest.mock('@/hooks/useAutomationScope', () => ({
  useAutomationScope: (): { projectsInContext: [] } => ({
    projectsInContext: [],
  }),
}));
const mockSnapshot = (): unknown => ({
  entity: 'automation',
  externalId: 'share-1',
  contentHash: 'a'.repeat(64),
  automation: {
    version: 1,
    name: 'Nightly digest',
    description: '',
    trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
    hasRunCondition: false,
  },
  authorUsername: mockAuthorUsername,
  updatedAt: '2026-09-19T00:00:00.000Z',
});
jest.mock('../usePublicShareLanding', () => ({
  usePublicShareLanding: (): unknown => ({
    state: { phase: 'ready', snapshot: mockSnapshot() },
    installed: null,
    installing: false,
    installError: '',
    installProgress: '',
    installStatus: '',
    detecting: false,
    verificationError: '',
    needsRefresh: false,
    refresh: jest.fn(),
    agentReadinessLoading: false,
    install: jest.fn(),
    snapshot: {
      entity: 'automation',
      externalId: 'share-1',
      contentHash: 'a'.repeat(64),
      automation: {
        version: 1,
        name: 'Nightly digest',
        description: '',
        trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
        hasRunCondition: false,
      },
      authorUsername: mockAuthorUsername,
      updatedAt: '2026-09-19T00:00:00.000Z',
    },
    installReview: mockInstallReview,
    openingInstallReview: mockOpeningInstallReview,
    closeInstallReview: mockCloseInstallReview,
    completeInstallReview: mockCompleteInstallReview,
  }),
}));
jest.mock('@/components/automations/InstallSharedAutomationModal', () => ({
  InstallSharedAutomationModal: (props: CapturedWizardProps): JSX.Element => {
    mockWizardProps = props;
    return <div data-testid="install-shared-automation-modal" />;
  },
}));

import { useNavigationStore } from '@/stores/navigationStore';
import {
  closeAutomationInstallContinuation,
  useAutomationInstallContinuationStore,
} from '@/stores/automationInstallContinuationStore';
import { outermostReplayBlock } from '@/test-utils/replay';
import { ShareInstallModalHost } from '../ShareInstallModal';

const LINK: DeepLinkShareOpenEvent = {
  entity: 'automation',
  externalId: 'share-1',
  intent: 'install',
};

let container: HTMLDivElement;
let root: Root;

function wizard(): CapturedWizardProps {
  if (mockWizardProps === null) throw new Error('wizard not rendered');
  return mockWizardProps;
}

function staleCopy(): ScheduledActivity {
  return {
    version: 1,
    id: 'copy-1',
    name: 'Nightly digest',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function renderHost(): void {
  act(() => {
    root.render(<ShareInstallModalHost />);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCompleteInstallReview.mockReset();
  mockWizardProps = null;
  mockOpeningInstallReview = false;
  mockAuthorUsername = null;
  mockInstallReview = { entity: 'automation', externalId: 'share-1' };
  useNavigationStore.setState({
    activePage: 'overview',
    pendingShareInstall: { link: { ...LINK }, origin: 'deep-link' },
    pendingAutomationReveal: undefined,
    workflowEdit: undefined,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  useNavigationStore.setState({
    pendingShareInstall: undefined,
    heldShareInstall: undefined,
    shareInstallBusy: false,
    pendingAutomationReveal: undefined,
  });
  useNavigationStore.getState().closeAddWorkspaceModal();
  closeAutomationInstallContinuation();
});

describe('ShareInstallModal automation completion handoff (CAN-3651)', () => {
  it('records completion, stages the reveal, then closes the landing', () => {
    renderHost();
    const order: string[] = [];
    mockCompleteInstallReview.mockImplementation(() => {
      order.push('complete');
      expect(useNavigationStore.getState().pendingAutomationReveal).toBe(
        undefined,
      );
    });
    const unsubscribe = useNavigationStore.subscribe((state, previous) => {
      if (state.pendingAutomationReveal !== previous.pendingAutomationReveal)
        order.push('reveal');
      if (
        state.pendingShareInstall === undefined &&
        previous.pendingShareInstall !== undefined
      )
        order.push('close');
    });

    act(() => {
      wizard().onDone('copy-new', 'installed');
      // The wizard always follows `onDone` with `onClose`.
      wizard().onClose();
    });
    unsubscribe();

    expect(order).toEqual(['complete', 'reveal', 'close']);
    expect(mockCompleteInstallReview).toHaveBeenCalledTimes(1);
    expect(mockCompleteInstallReview).toHaveBeenCalledWith('copy-new');
    expect(mockCloseInstallReview).not.toHaveBeenCalled();
    const state = useNavigationStore.getState();
    expect(state.activePage).toBe('workflows-library');
    expect(state.pendingAutomationReveal).toEqual({
      activityId: 'copy-new',
      outcome: 'installed',
    });
    expect(state.pendingShareInstall).toBeUndefined();
    expect(
      container.querySelector(
        '[data-testid="install-shared-automation-modal"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="deep-link-share-landing"]'),
    ).toBeNull();
  });

  it('passes an update outcome through for the same copy', () => {
    mockInstallReview = {
      entity: 'automation',
      externalId: 'share-1',
      staleActivity: staleCopy(),
    };
    renderHost();

    act(() => {
      wizard().onDone('copy-1', 'updated');
    });

    expect(useNavigationStore.getState().pendingAutomationReveal).toEqual({
      activityId: 'copy-1',
      outcome: 'updated',
    });
  });

  it('ignores repeated completion callbacks', () => {
    renderHost();
    const props = wizard();

    act(() => {
      props.onDone('copy-new', 'installed');
      props.onDone('copy-new', 'installed');
      props.onClose();
    });

    expect(mockCompleteInstallReview).toHaveBeenCalledTimes(1);
  });

  it('closing the review closes the whole flow without completing or navigating', () => {
    renderHost();

    act(() => {
      wizard().onClose();
    });

    expect(mockCloseInstallReview).toHaveBeenCalledTimes(1);
    expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    const state = useNavigationStore.getState();
    expect(state.pendingAutomationReveal).toBeUndefined();
    expect(state.activePage).toBe('overview');
    expect(state.pendingShareInstall).toBeUndefined();
    expect(
      container.querySelector('[data-testid="deep-link-share-landing"]'),
    ).toBeNull();
  });

  it('closes the flow when completion has no id', () => {
    renderHost();

    act(() => {
      wizard().onDone(undefined, 'installed');
    });

    expect(mockCloseInstallReview).toHaveBeenCalledTimes(1);
    expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().pendingAutomationReveal).toBe(
      undefined,
    );
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
  });

  it('shows a loading state instead of the landing while the review opens', () => {
    mockInstallReview = null;
    mockOpeningInstallReview = true;
    renderHost();

    expect(
      container.querySelector('[data-testid="deep-link-share-landing"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="loading-placeholder"]')
        ?.textContent,
    ).toBe('Loading shared automation…');
    // Nothing to click until the review is up.
    expect(
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="deep-link-share-install"]',
        )
        ?.hasAttribute('disabled') ?? true,
    ).toBe(true);
  });

  it('shows the install review when there is no wizard to open', () => {
    mockInstallReview = null;
    renderHost();

    expect(
      container.querySelector('[data-testid="deep-link-share-landing"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="deep-link-share-install"]')
        ?.textContent,
    ).toBe('Install');
  });

  /** The innermost element under `scope` whose whole text is `text`. */
  function textElement(scope: Element | null, text: string): Element {
    const match = Array.from(scope?.querySelectorAll('*') ?? [])
      .reverse()
      .find((element) => element.textContent === text);
    if (match === undefined) throw new Error(`Missing ${text}`);
    return match;
  }

  /** Asserts `subtitle` reads `Shared by morgan` with only the name blocked. */
  function expectBlockedAuthor(subtitle: Element | null): void {
    expect(subtitle?.textContent).toBe('Shared by morgan');
    expect(outermostReplayBlock(subtitle)).toBeNull();
    expect(
      outermostReplayBlock(textElement(subtitle, 'morgan'))?.textContent,
    ).toBe('morgan');
  }

  it('passes the author attribution to the review', () => {
    mockAuthorUsername = 'morgan';
    renderHost();

    const rendered = document.createElement('div');
    const wizardRoot = createRoot(rendered);
    act(() => {
      wizardRoot.render(<p>{wizard().subtitle}</p>);
    });
    expectBlockedAuthor(rendered.querySelector('p'));
    act(() => {
      wizardRoot.unmount();
    });
  });

  it("blocks the author's name on the landing, not the attribution", () => {
    mockAuthorUsername = 'morgan';
    mockInstallReview = null;
    renderHost();

    expectBlockedAuthor(
      container.querySelector('[data-testid="dialog-subtitle"]'),
    );
  });

  it('drops a late callback from a landing replaced by a newer link', () => {
    renderHost();
    const stale = wizard();
    const newer: DeepLinkShareOpenEvent = {
      entity: 'automation',
      externalId: 'share-2',
      intent: 'install',
    };
    act(() => {
      useNavigationStore.getState().openShareInstall(newer, 'deep-link');
    });

    act(() => {
      stale.onDone('copy-old', 'installed');
      stale.onClose();
    });

    expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().pendingAutomationReveal).toBe(
      undefined,
    );
    expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(newer);
  });

  it('holds a newer link while the automation install writes, then opens it', () => {
    renderHost();
    const writing = wizard();
    const newer: DeepLinkShareOpenEvent = {
      entity: 'automation',
      externalId: 'share-2',
      intent: 'install',
    };
    act(() => {
      writing.onSubmittingChange?.(true);
      useNavigationStore.getState().openShareInstall(newer, 'deep-link');
    });
    expect(useNavigationStore.getState().pendingShareInstall?.link).toEqual(
      LINK,
    );

    act(() => {
      writing.onDone('copy-new', 'installed');
      writing.onClose();
    });

    expect(mockCompleteInstallReview).toHaveBeenCalledWith('copy-new');
    const state = useNavigationStore.getState();
    expect(state.pendingAutomationReveal).toEqual({
      activityId: 'copy-new',
      outcome: 'installed',
    });
    expect(state.shareInstallBusy).toBe(false);
    expect(state.heldShareInstall).toBeUndefined();
    expect(state.pendingShareInstall?.link).toBe(newer);
  });

  it('closes when the link held during the automation install is a repeat', () => {
    renderHost();
    const writing = wizard();
    act(() => {
      writing.onSubmittingChange?.(true);
      useNavigationStore.getState().openShareInstall({ ...LINK }, 'deep-link');
    });

    act(() => {
      writing.onDone('copy-new', 'installed');
      writing.onClose();
    });

    const state = useNavigationStore.getState();
    expect(state.pendingAutomationReveal).toEqual({
      activityId: 'copy-new',
      outcome: 'installed',
    });
    expect(state.shareInstallBusy).toBe(false);
    expect(state.heldShareInstall).toBeUndefined();
    expect(state.pendingShareInstall).toBeUndefined();
  });

  it('applies a held link when the automation install fails', () => {
    renderHost();
    const writing = wizard();
    const newer: DeepLinkShareOpenEvent = {
      entity: 'automation',
      externalId: 'share-2',
      intent: 'install',
    };
    act(() => {
      writing.onSubmittingChange?.(true);
      useNavigationStore.getState().openShareInstall(newer, 'deep-link');
    });

    act(() => {
      writing.onSubmittingChange?.(false);
    });

    expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().shareInstallBusy).toBe(false);
    expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(newer);
  });

  it('drops a late callback after the landing was closed', () => {
    renderHost();
    const stale = wizard();
    act(() => {
      useNavigationStore.getState().consumeShareInstall();
    });

    act(() => {
      stale.onDone('copy-old', 'installed');
    });

    expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().pendingAutomationReveal).toBe(
      undefined,
    );
    expect(useNavigationStore.getState().activePage).toBe('overview');
  });

  it('ignores completion after the same review was closed', () => {
    renderHost();
    const abandoned = wizard();
    act(() => {
      abandoned.onClose();
      abandoned.onDone('copy-abandoned', 'installed');
    });
    expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    expect(
      useNavigationStore.getState().pendingAutomationReveal,
    ).toBeUndefined();
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
  });

  it('rejects callbacks from an older review on the same share', () => {
    renderHost();
    const abandoned = wizard();
    mockInstallReview = { entity: 'automation', externalId: 'share-1' };
    renderHost();
    act(() => {
      abandoned.onDone('copy-abandoned', 'installed');
      abandoned.onClose();
    });
    expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    expect(mockCloseInstallReview).not.toHaveBeenCalled();
    act(() => {
      wizard().onDone('copy-current', 'updated');
    });
    expect(useNavigationStore.getState().pendingAutomationReveal).toEqual({
      activityId: 'copy-current',
      outcome: 'updated',
    });
  });

  it('accepts a reopened same-share flow even before React tears down the old one', () => {
    renderHost();
    const original = wizard();
    act(() => {
      original.onDone('copy-first', 'installed');
      useNavigationStore.getState().openShareInstall({ ...LINK }, 'deep-link');
    });
    act(() => {
      wizard().onDone('copy-second', 'updated');
    });
    expect(mockCompleteInstallReview).toHaveBeenCalledTimes(2);
    expect(useNavigationStore.getState().pendingAutomationReveal).toEqual({
      activityId: 'copy-second',
      outcome: 'updated',
    });
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
  });

  describe('after a create-project detour (CAN-3980)', () => {
    /**
     * Walk the real wizard's create-project hand-off: it closes itself, then
     * hands the draft and its own `onDone` to the landing's
     * `onCreateProject`, which closes the landing and parks the draft in the
     * app-level continuation. Returns the parked request.
     */
    function detourThroughProjectCreation(): AutomationProjectCreationRequest {
      const props = wizard();
      const onCreateProject = props.onCreateProject;
      if (onCreateProject === undefined)
        throw new Error('wizard did not offer project creation');
      act(() => {
        props.onClose();
        onCreateProject({
          context: 'worktree',
          source: 'public',
          detail: {
            id: 'share-1',
            contentHash: 'a'.repeat(64),
            automation: {
              version: 1,
              name: 'Nightly digest',
              description: '',
              trigger: {
                kind: 'cron',
                expression: '0 2 * * *',
                timezone: 'local',
              },
              action: {
                type: 'app_advisor_prompt',
                prompt: 'Check the queue',
                plugins: [],
              },
              hasRunCondition: false,
            },
          },
          draft: {
            workspaceId: '',
            coworkWorkspaceId: '',
            existingBranch: '',
            inputs: {},
            chosenPipelineId: '',
          },
          onDone: props.onDone,
        });
      });
      const { state } = useAutomationInstallContinuationStore.getState();
      if (state.status === 'closed')
        throw new Error('project creation was not requested');
      return state.continuation.request;
    }

    /** What `AutomationInstallContinuationHost` does when the install lands. */
    function finishContinuation(
      request: AutomationProjectCreationRequest,
      activityId?: string,
      outcome?: InstallAutomationOutcome,
    ): void {
      act(() => {
        closeAutomationInstallContinuation();
        request.onDone(activityId, outcome);
      });
    }

    it('reveals the installed copy once the continued install finishes', () => {
      renderHost();
      const request = detourThroughProjectCreation();
      // The landing is gone while the user creates the project.
      expect(useNavigationStore.getState().pendingShareInstall?.link).toBe(
        undefined,
      );
      expect(useNavigationStore.getState().addWorkspaceModalOpen).toBe(true);

      finishContinuation(request, 'copy-new', 'installed');

      const state = useNavigationStore.getState();
      expect(state.activePage).toBe('workflows-library');
      expect(state.pendingAutomationReveal).toEqual({
        activityId: 'copy-new',
        outcome: 'installed',
      });
      expect(mockCompleteInstallReview).toHaveBeenCalledTimes(1);
      expect(mockCompleteInstallReview).toHaveBeenCalledWith('copy-new');
    });

    it('reveals a continued install once, even if completion repeats', () => {
      renderHost();
      const request = detourThroughProjectCreation();

      finishContinuation(request, 'copy-new', 'installed');
      act(() => {
        useNavigationStore.getState().consumeAutomationReveal();
        useNavigationStore.setState({ activePage: 'overview' });
      });
      finishContinuation(request, 'copy-new', 'installed');

      expect(
        useNavigationStore.getState().pendingAutomationReveal,
      ).toBeUndefined();
      expect(useNavigationStore.getState().activePage).toBe('overview');
      expect(mockCompleteInstallReview).toHaveBeenCalledTimes(1);
    });

    it('does not reveal when the continued install is cancelled', () => {
      renderHost();
      detourThroughProjectCreation();

      act(() => {
        // The continuation host's close, with no completion.
        closeAutomationInstallContinuation();
      });

      const state = useNavigationStore.getState();
      expect(state.pendingAutomationReveal).toBeUndefined();
      expect(state.activePage).toBe('overview');
      expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    });

    it('does not reveal when the continued install reports no copy', () => {
      renderHost();
      const request = detourThroughProjectCreation();

      finishContinuation(request, undefined, 'installed');

      const state = useNavigationStore.getState();
      expect(state.pendingAutomationReveal).toBeUndefined();
      expect(state.activePage).toBe('overview');
      expect(mockCompleteInstallReview).not.toHaveBeenCalled();
    });
  });
});
