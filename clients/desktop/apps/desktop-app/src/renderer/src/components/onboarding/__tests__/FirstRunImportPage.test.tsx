/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExternalProjectCandidate,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportItemResult,
  ExternalProjectImportResponse,
} from '@canopy/desktop-shared/types';

const loadProjects = jest.fn(() => Promise.resolve());
const toggleCollapsed = jest.fn(() => Promise.resolve());
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): {
      loadProjects: () => Promise<void>;
      toggleCollapsed: () => Promise<void>;
      projects: { id: string; collapsed: boolean }[];
    } => ({ loadProjects, toggleCollapsed, projects: [] }),
  },
}));
const navigateAfterRepositoryWorkspaceCreated = jest.fn();
jest.mock('@/lib/postWorkspaceCreateNavigation', () => ({
  navigateAfterRepositoryWorkspaceCreated: (workspaceId: string): void => {
    navigateAfterRepositoryWorkspaceCreated(workspaceId);
  },
}));
const completeOnboardingSuggestionDurably = jest.fn();
jest.mock('@/components/home/onboarding-suggestions/completionWriter', () => ({
  completeOnboardingSuggestionDurably: (...args: unknown[]): void => {
    completeOnboardingSuggestionDurably(...args);
  },
}));
const offerCursorRulesReview = jest.fn(() => Promise.resolve());
jest.mock('@/lib/cursorRulesOffer', () => ({
  offerCursorRulesReview: (...args: unknown[]): Promise<void> =>
    offerCursorRulesReview(...args),
}));
const providerPanelProps: Record<string, unknown>[] = [];
jest.mock('@/components/auth/ProviderAuthPanel', () => ({
  ProviderAuthPanel: (props: Record<string, unknown>): null => {
    providerPanelProps.push(props);
    return null;
  },
}));
type MockAuthStatus = { authenticated: boolean } | null;
const SIGNED_OUT: MockAuthStatus = { authenticated: false };
let mockClaudeStatus: MockAuthStatus = SIGNED_OUT;
let mockCodexStatus: MockAuthStatus = SIGNED_OUT;
jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  useClaudeAuthStatus: (): MockAuthStatus => mockClaudeStatus,
}));
jest.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: (): MockAuthStatus => mockCodexStatus,
}));
jest.mock('@/lib/ai-credits-refresh', () => ({
  refreshAiCreditsAfterDripChange: (): Promise<unknown> =>
    Promise.resolve({ eligible: true, loading: false, inconclusive: false }),
}));

import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CloudDailyCreditDripState } from '@canopy/desktop-shared/types';
import { FirstRunImportPage } from '../FirstRunImportPage';
import { resetDailyCreditDripOptInCacheForTests } from '@/hooks/useDailyCreditDripOptIn';
import { brandText } from '@/lib/brand';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function candidate(
  id: string,
  overrides: Partial<ExternalProjectCandidate> = {},
): ExternalProjectCandidate {
  return {
    id,
    providers: ['claude'],
    surfaces: ['claude-code'],
    displayName: id,
    rootPath: `/Users/me/${id}`,
    kind: 'git',
    status: 'available',
    linkedWorktreePaths: [],
    lastActivityAt: RECENT,
    sessions: [],
    sessionCount: 0,
    importableSessionCount: 0,
    ...overrides,
  };
}

function scan(
  candidates: ExternalProjectCandidate[],
): ExternalProjectDiscoverResponse {
  return {
    scanId: 'scan-1',
    scannedAt: RECENT,
    candidates,
    diagnostics: [],
    providersDetected: { claude: true, codex: false },
    detectedPlugins: [],
  };
}

function result(
  candidateId: string,
  overrides: Partial<ExternalProjectImportItemResult> = {},
): ExternalProjectImportItemResult {
  return {
    candidateId,
    displayName: candidateId,
    rootPath: `/Users/me/${candidateId}`,
    status: 'imported',
    workspaceId: `ws-${candidateId}`,
    chatsImported: 0,
    chatsReadOnly: 0,
    chatsSkipped: 0,
    retryable: false,
    ...overrides,
  };
}

interface Api {
  discover: jest.Mock<Promise<ExternalProjectDiscoverResponse>, [unknown]>;
  importProjects: jest.Mock<Promise<ExternalProjectImportResponse>, [unknown]>;
  pickFolder: jest.Mock<Promise<string | null>, []>;
  savePreferences: jest.Mock<Promise<void>, [unknown]>;
  loadCloudDailyCreditDrip: jest.Mock<Promise<CloudDailyCreditDripState>, []>;
  saveCloudDailyCreditDrip: jest.Mock<
    Promise<Record<string, unknown>>,
    [{ enabled: boolean }]
  >;
}

function dripState(
  overrides: Partial<CloudDailyCreditDripState> = {},
  preference: { enabled: boolean; decidedAt: string | null } = {
    enabled: false,
    decidedAt: null,
  },
): CloudDailyCreditDripState {
  return {
    available: true,
    resolved: true,
    preference: { ...preference, capCredits: 10 },
    ...overrides,
  };
}

function installApi(first: ExternalProjectDiscoverResponse): Api {
  const api: Api = {
    discover: jest.fn(() => Promise.resolve(first)),
    importProjects: jest.fn(() => Promise.resolve({ results: [] })),
    pickFolder: jest.fn(() => Promise.resolve(null)),
    savePreferences: jest.fn(() => Promise.resolve()),
    loadCloudDailyCreditDrip: jest.fn(() => Promise.resolve(dripState())),
    saveCloudDailyCreditDrip: jest.fn(({ enabled }: { enabled: boolean }) =>
      Promise.resolve({
        enabled,
        decidedAt: RECENT,
        capCredits: 10,
        balanceCredits: null,
        granted: 0,
      }),
    ),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      externalProjects: {
        discover: api.discover,
        importProjects: api.importProjects,
        pickFolder: api.pickFolder,
      },
      loadPreferences: jest.fn(() =>
        Promise.resolve({ onboardingCompleted: [] }),
      ),
      savePreferences: api.savePreferences,
      loadCloudDailyCreditDrip: api.loadCloudDailyCreditDrip,
      saveCloudDailyCreditDrip: api.saveCloudDailyCreditDrip,
    },
  });
  return api;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('FirstRunImportPage', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onDone: jest.Mock;

  const byTestId = (id: string): HTMLElement => {
    const node = container.querySelector(`[data-testid="${id}"]`);
    if (!(node instanceof HTMLElement)) throw new Error(`missing ${id}`);
    return node;
  };
  const queryTestId = (id: string): Element | null =>
    container.querySelector(`[data-testid="${id}"]`);
  const creditsSwitch = (): HTMLElement =>
    byTestId('first-run-daily-credits-toggle');
  const click = async (node: HTMLElement): Promise<void> => {
    await act(async () => {
      node.click();
      await Promise.resolve();
    });
    await flush();
  };

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onDone = jest.fn();
    loadProjects.mockClear();
    navigateAfterRepositoryWorkspaceCreated.mockClear();
    completeOnboardingSuggestionDurably.mockClear();
    offerCursorRulesReview.mockClear();
    providerPanelProps.length = 0;
    mockClaudeStatus = SIGNED_OUT;
    mockCodexStatus = SIGNED_OUT;
    resetDailyCreditDripOptInCacheForTests();
    useWorkspaceContextStore.setState({
      hydrated: true,
      accountEpoch: 1,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<FirstRunImportPage onDone={onDone} />);
      await Promise.resolve();
    });
    await flush();
  }

  it('keeps the project-only description without the chat destination warning', async () => {
    const api = installApi(scan([candidate('alpha')]));
    await render();

    expect(container.textContent).toContain(
      'Import your work. Source folders stay where they are, and nothing runs until you start it.',
    );
    expect(container.textContent).not.toContain('Uncommitted or unpushed');
    expect(container.textContent).not.toContain('default branch');

    await click(byTestId('first-run-import-submit'));
    expect(api.importProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [{ candidateId: 'alpha', importChats: false }],
      }),
    );
  });

  it('stays on the page with an error when no project imports', async () => {
    const api = installApi(scan([candidate('alpha')]));
    api.importProjects.mockResolvedValue({
      results: [
        result('alpha', {
          status: 'failed',
          workspaceId: undefined,
          error: 'Folder is gone',
        }),
      ],
    });
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(onDone).not.toHaveBeenCalled();
    expect(api.savePreferences).not.toHaveBeenCalled();
    expect(completeOnboardingSuggestionDurably).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't import alpha.");
    expect(byTestId('first-run-import-submit').textContent).toBe(
      'Import 1 project',
    );
  });

  it('selects only the picked folder after Choose a folder', async () => {
    const api = installApi(scan([]));
    api.pickFolder.mockResolvedValue('/Users/me/picked-repo/src');
    api.discover.mockResolvedValueOnce(scan([])).mockResolvedValueOnce(
      scan([
        // Discovery canonicalizes the pick (realpath, git top level), so the
        // candidate's root differs from the path the member chose.
        candidate('picked', {
          rootPath: '/private/Users/me/picked-repo',
          surfaces: ['custom-folder'],
          providers: [],
          lastActivityAt: null,
        }),
        candidate('scratch', {
          rootPath:
            '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions/s1',
        }),
        candidate('elsewhere', { rootPath: '/Users/me/elsewhere' }),
      ]),
    );
    await render();

    const choose = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Choose a folder',
    );
    if (!choose) throw new Error('missing Choose a folder');
    await click(choose);

    expect(byTestId('first-run-import-submit').textContent).toBe(
      'Import 1 project',
    );
  });

  it('offers the Cursor rules review for the imported projects (CAN-2053)', async () => {
    const api = installApi(scan([candidate('alpha'), candidate('beta')]));
    api.importProjects.mockResolvedValue({
      results: [
        result('alpha'),
        result('beta', { status: 'failed', workspaceId: undefined }),
      ],
    });
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(offerCursorRulesReview).toHaveBeenCalledWith(
      [{ workspaceId: 'ws-alpha', displayName: 'alpha' }],
      'first-run-import',
    );
  });

  it('offers nothing when the page is skipped', async () => {
    installApi(scan([candidate('alpha')]));
    await render();
    await click(byTestId('first-run-import-skip'));
    expect(onDone).toHaveBeenCalled();
    expect(offerCursorRulesReview).not.toHaveBeenCalled();
  });

  it('finishes an import even when the sidebar refresh fails', async () => {
    const api = installApi(scan([candidate('alpha')]));
    api.importProjects.mockResolvedValue({ results: [result('alpha')] });
    loadProjects.mockRejectedValueOnce(new Error('refresh failed'));
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(onDone).toHaveBeenCalled();
    expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
      'ws-alpha',
    );
  });

  it('opens an organization user’s import in Personal', async () => {
    const api = installApi(scan([candidate('alpha')]));
    api.importProjects.mockResolvedValue({ results: [result('alpha')] });
    const setContext = jest.fn(() => Promise.resolve());
    useWorkspaceContextStore.setState({
      hydrated: true,
      accountEpoch: 1,
      state: {
        context: { kind: 'organization', organizationId: ORG_A },
        revision: 1,
        organizations: [{ id: ORG_A, name: 'Org A', role: 'MEMBER' }],
      },
      setContext,
    });
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(setContext).toHaveBeenCalledWith({ kind: 'personal' });
    expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
      'ws-alpha',
    );
    expect(onDone).toHaveBeenCalled();
  });

  describe('without Claude or Codex', () => {
    it('shows the provider rows in the neutral tone under the shared intro', async () => {
      installApi(scan([]));
      await render();
      expect(container.textContent).toContain(
        `Bring your own subscription or use your ${brandText.appName} account.`,
      );
      const tones = providerPanelProps.map((props) => [
        props.provider,
        props.unauthenticatedTone,
      ]);
      expect(tones).toContainEqual(['claude', 'neutral']);
      expect(tones).toContainEqual(['codex', 'neutral']);
    });

    it('offers the daily AI Credits, off until turned on', async () => {
      installApi(scan([]));
      await render();
      expect(byTestId('first-run-daily-credits').textContent).toContain(
        '10 free AI Credits every day',
      );
      expect(byTestId('first-run-daily-credits').textContent).toContain(
        brandText.appName,
      );
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('false');
    });

    it('saves the opt-in when the switch is turned on', async () => {
      const api = installApi(scan([]));
      await render();
      await click(creditsSwitch());
      expect(api.saveCloudDailyCreditDrip).toHaveBeenCalledWith({
        enabled: true,
      });
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('true');
    });

    it('rolls the switch back and explains a failed save', async () => {
      const api = installApi(scan([]));
      api.saveCloudDailyCreditDrip.mockRejectedValueOnce(new Error('offline'));
      await render();
      await click(creditsSwitch());
      expect(byTestId('first-run-daily-credits-error').textContent).toContain(
        "Couldn't save. Try again.",
      );
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('false');

      let settle: (value: Record<string, unknown>) => void = () => undefined;
      api.saveCloudDailyCreditDrip.mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      await click(creditsSwitch());
      expect(queryTestId('first-run-daily-credits-error')).toBeNull();
      await act(async () => {
        settle({
          enabled: true,
          decidedAt: RECENT,
          capCredits: 10,
          balanceCredits: null,
          granted: 0,
        });
        await Promise.resolve();
      });
      await flush();
      expect(queryTestId('first-run-daily-credits-error')).toBeNull();
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('true');
    });

    it('shows the row switched on for a user who already opted in', async () => {
      const api = installApi(scan([]));
      api.loadCloudDailyCreditDrip.mockResolvedValue(
        dripState({}, { enabled: true, decidedAt: RECENT }),
      );
      await render();
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('true');
    });

    it('does not offer the credits to a Claude subscriber', async () => {
      mockClaudeStatus = { authenticated: true };
      installApi(scan([]));
      await render();
      expect(queryTestId('first-run-daily-credits')).toBeNull();
    });

    it.each([
      ['Claude', 'claude'],
      ['Codex', 'codex'],
    ])(
      'does not offer the credits while the %s check is running',
      async (_name, provider) => {
        if (provider === 'claude') mockClaudeStatus = null;
        else mockCodexStatus = null;
        installApi(scan([]));
        await render();
        expect(queryTestId('first-run-daily-credits')).toBeNull();
      },
    );

    it('does not offer the credits without a cloud account', async () => {
      const api = installApi(scan([]));
      api.loadCloudDailyCreditDrip.mockResolvedValue(
        dripState({ available: false }),
      );
      await render();
      expect(queryTestId('first-run-daily-credits')).toBeNull();
    });

    it('keeps the row once shown when Claude connects', async () => {
      installApi(scan([]));
      await render();
      expect(queryTestId('first-run-daily-credits')).not.toBeNull();
      mockClaudeStatus = { authenticated: true };
      await render();
      expect(queryTestId('first-run-daily-credits')).not.toBeNull();
    });

    it('hides the row once the cloud account goes away', async () => {
      const api = installApi(scan([]));
      await render();
      expect(queryTestId('first-run-daily-credits')).not.toBeNull();
      api.loadCloudDailyCreditDrip.mockResolvedValue(
        dripState({ available: false }),
      );
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await flush();
      expect(queryTestId('first-run-daily-credits')).toBeNull();
    });

    it('lets the user choose a folder with no provider', async () => {
      const api = installApi(scan([]));
      api.pickFolder.mockResolvedValue('/Users/me/picked');
      await render();
      const choose = byTestId('first-run-import-choose-folder');
      expect(choose.hasAttribute('disabled')).toBe(false);
      await click(choose);
      expect(api.pickFolder).toHaveBeenCalled();
      expect(api.discover).toHaveBeenLastCalledWith({
        customRoots: ['/Users/me/picked'],
      });
    });

    it('labels the empty projects row without a trailing period', async () => {
      installApi(scan([]));
      await render();
      const empty = byTestId('first-run-import-empty');
      expect(empty.textContent).toContain(
        'No Claude or Codex projects found on this computer',
      );
      expect(empty.textContent).not.toContain('on this computer.');
      expect(empty.textContent).toContain(
        'Add any folder on this computer as a project.',
      );
      expect(empty.textContent).toContain('Choose a folder');
    });
  });

  describe('forward action', () => {
    it('reads Continue as the primary action when nothing is importable', async () => {
      installApi(scan([]));
      await render();
      const skip = byTestId('first-run-import-skip');
      expect(skip.textContent).toBe('Continue');
      expect(skip.className).toContain('bg-accent');
    });

    it('reads Skip for now beside an import', async () => {
      installApi(scan([candidate('alpha')]));
      await render();
      const skip = byTestId('first-run-import-skip');
      expect(skip.textContent).toBe('Skip for now');
      expect(skip.className).not.toContain('bg-accent');
    });

    it('reads Skip for now while the scan runs', async () => {
      const api = installApi(scan([]));
      api.discover.mockReturnValue(new Promise(() => undefined));
      await render();
      expect(byTestId('first-run-import-skip').textContent).toBe(
        'Skip for now',
      );
    });
  });
});
