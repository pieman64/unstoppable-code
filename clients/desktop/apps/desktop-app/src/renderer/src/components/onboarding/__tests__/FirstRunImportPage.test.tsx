/**
 * @jest-environment jsdom
 */
import { act, StrictMode } from 'react';
import type * as CursorRulesOffer from '@/lib/cursorRulesOffer';
import { createRoot, type Root } from 'react-dom/client';

import type {
  ExternalProjectCandidate,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportItemResult,
  ExternalProjectImportResponse,
} from '@canopy/desktop-shared/types';
import type {
  WorkspaceContext,
  WorkspaceContextState,
} from '@canopy/protocol/workspace-context';

const startOperation = jest.fn<void, unknown[]>();
const succeedOperation = jest.fn<void, unknown[]>();
const failOperation = jest.fn<void, unknown[]>();
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  ...jest.requireActual<object>('@canopy/desktop-instrumentation/client'),
  startClientOperation: (...args: unknown[]): void => {
    startOperation(...args);
  },
  succeedClientOperation: (...args: unknown[]): void => {
    succeedOperation(...args);
  },
  failClientOperation: (...args: unknown[]): void => {
    failOperation(...args);
  },
}));

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
  navigateAfterRepositoryWorkspaceCreated: (
    workspaceId: string,
    reason?: string,
  ): void => {
    if (reason) navigateAfterRepositoryWorkspaceCreated(workspaceId, reason);
    else navigateAfterRepositoryWorkspaceCreated(workspaceId);
  },
}));

const offerCursorRulesReview = jest.fn<
  ReturnType<typeof CursorRulesOffer.offerCursorRulesReview>,
  Parameters<typeof CursorRulesOffer.offerCursorRulesReview>
>(() => Promise.resolve());
jest.mock('@/lib/cursorRulesOffer', () => ({
  offerCursorRulesReview: (
    ...args: Parameters<typeof CursorRulesOffer.offerCursorRulesReview>
  ): ReturnType<typeof CursorRulesOffer.offerCursorRulesReview> =>
    offerCursorRulesReview(...args),
}));
const providerPanelProps: Record<string, unknown>[] = [];
jest.mock('@/components/auth/ProviderAuthPanel', () => ({
  ProviderAuthPanel: (props: Record<string, unknown>): null => {
    providerPanelProps.push(props);
    return null;
  },
}));
type MockAuthStatus = {
  authenticated: boolean;
  error?: string;
  probeFailed?: boolean;
} | null;
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
import { LOADING_PLACEHOLDER_DELAY_MS } from '@canopy/ui-shared/lib';
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
    discover: jest.fn<Promise<ExternalProjectDiscoverResponse>, [unknown]>(() =>
      Promise.resolve(first),
    ),
    importProjects: jest.fn<Promise<ExternalProjectImportResponse>, [unknown]>(
      () => Promise.resolve({ results: [] }),
    ),
    pickFolder: jest.fn(() => Promise.resolve(null)),
    savePreferences: jest.fn<Promise<void>, [unknown]>(() => Promise.resolve()),
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

    offerCursorRulesReview.mockClear();
    startOperation.mockClear();
    succeedOperation.mockClear();
    failOperation.mockClear();
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
          message: 'Folder is gone',
        }),
      ],
    });
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(onDone).not.toHaveBeenCalled();
    expect(api.savePreferences).not.toHaveBeenCalled();

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

  describe('a picked folder holding repositories (CAN-5487)', () => {
    const PARENT = '/Users/me/AndroidStudioProjects';
    const parent = (
      overrides: Partial<ExternalProjectCandidate> = {},
    ): ExternalProjectCandidate =>
      candidate('parent', {
        displayName: 'AndroidStudioProjects',
        rootPath: PARENT,
        kind: 'folder',
        surfaces: ['custom-folder'],
        providers: [],
        lastActivityAt: null,
        nestedRepositories: { count: 3, complete: true },
        ...overrides,
      });
    const nested = (
      name: string,
      overrides: Partial<ExternalProjectCandidate> = {},
    ): ExternalProjectCandidate =>
      candidate(name, {
        rootPath: `${PARENT}/${name}`,
        surfaces: ['nested-repository'],
        providers: [],
        lastActivityAt: null,
        parentCandidateIds: ['parent'],
        ...overrides,
      });
    const ticketPick = (): ExternalProjectDiscoverResponse =>
      scan([
        candidate('older', { lastActivityAt: '2020-01-01T00:00:00.000Z' }),
        nested('wear-timer'),
        parent(),
        nested('pantry-android'),
        nested('compose-playground'),
      ]);
    const rowIds = (): string[] =>
      Array.from(
        container.querySelectorAll('[data-testid^="first-run-import-row-"]'),
      ).map((row) =>
        (row.getAttribute('data-testid') ?? '').replace(
          'first-run-import-row-',
          '',
        ),
      );
    const box = (id: string): HTMLInputElement => {
      const node = container.querySelector(`#first-run-${id}`);
      if (!(node instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
      return node;
    };
    const pick = async (
      api: Api,
      response: ExternalProjectDiscoverResponse,
    ): Promise<void> => {
      api.pickFolder.mockResolvedValue(PARENT);
      api.discover
        .mockResolvedValueOnce(scan([]))
        .mockResolvedValueOnce(response);
      await render();
      const choose = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Choose a folder',
      );
      if (!choose) throw new Error('missing Choose a folder');
      await click(choose);
    };

    it('lists its repositories A–Z, unticked, above a plain-folder option', async () => {
      const api = installApi(scan([]));
      await pick(api, ticketPick());

      // Picked rows show even with no activity and nothing selected.
      expect(rowIds().slice(0, 4)).toEqual([
        'compose-playground',
        'pantry-android',
        'wear-timer',
        'parent',
      ]);
      for (const id of rowIds()) expect(box(id).checked).toBe(false);
      expect(byTestId('first-run-import-projects').textContent).toContain(
        'Found 3 repositories in AndroidStudioProjects',
      );
      const parentRow = byTestId('first-run-import-row-parent');
      expect(parentRow.textContent).toContain(
        'Add AndroidStudioProjects as a plain folder',
      );
      expect(parentRow.textContent).toContain('Plain folder');
      expect(parentRow.textContent).not.toContain('not a code repository');
      expect(box('parent').disabled).toBe(false);
      const repoRow = byTestId('first-run-import-row-pantry-android');
      expect(repoRow.textContent).toContain('Code repository');
      expect(repoRow.textContent).not.toContain('No chat history');
      const submit = byTestId('first-run-import-submit');
      expect(submit.textContent).toBe('Select a project to import');
      expect(submit).toHaveProperty('disabled', true);
    });

    it('imports only the one repository chosen', async () => {
      const api = installApi(scan([]));
      await pick(api, ticketPick());

      await click(box('pantry-android'));
      await click(byTestId('first-run-import-submit'));

      expect(api.importProjects).toHaveBeenCalledWith(
        expect.objectContaining({
          selections: [{ candidateId: 'pantry-android', importChats: false }],
        }),
      );
    });

    it('keeps the folder and its repositories exclusive, including Select all', async () => {
      const api = installApi(scan([]));
      await pick(api, ticketPick());

      await click(box('wear-timer'));
      await click(box('parent'));
      expect(box('parent').checked).toBe(true);
      expect(box('wear-timer').checked).toBe(false);

      await click(box('pantry-android'));
      expect(box('parent').checked).toBe(false);
      expect(box('pantry-android').checked).toBe(true);

      await click(box('parent'));
      await click(box('select-all'));
      expect(box('parent').checked).toBe(false);
      for (const id of ['compose-playground', 'pantry-android', 'wear-timer'])
        expect(box(id).checked).toBe(true);
    });

    it('still pre-selects a picked folder whose complete scan found nothing', async () => {
      const api = installApi(scan([]));
      await pick(
        api,
        scan([parent({ nestedRepositories: { count: 0, complete: true } })]),
      );

      expect(box('parent').checked).toBe(true);
      expect(byTestId('first-run-import-projects').textContent).toContain(
        'You chose 1 folder',
      );
    });

    it('leaves an uncertain or unscanned folder unticked', async () => {
      const api = installApi(scan([]));
      await pick(
        api,
        scan([parent({ nestedRepositories: { count: 0, complete: false } })]),
      );
      expect(box('parent').checked).toBe(false);
      // One run of sentences, not a line per fact.
      expect(byTestId('first-run-import-picked-summary').textContent).toBe(
        'You chose 1 folder. Could not finish checking for repositories.',
      );
    });

    it('leaves a folder without scan metadata unticked', async () => {
      const api = installApi(scan([]));
      await pick(api, scan([parent({ nestedRepositories: undefined })]));
      expect(box('parent').checked).toBe(false);
      expect(byTestId('first-run-import-projects').textContent).toContain(
        'Could not finish checking for repositories',
      );
    });

    it('bulk selects only rendered rows while older results are collapsed', async () => {
      const api = installApi(scan([]));
      const response = ticketPick();
      response.candidates.push(candidate('recent'));
      await pick(api, response);
      expect(rowIds()).not.toContain('older');
      await click(box('select-all'));
      expect(rowIds()).not.toContain('older');
      expect(byTestId('first-run-import-submit').textContent).toBe(
        'Import 4 projects',
      );
    });

    it('honors a direct pick that also has nested provenance', async () => {
      const api = installApi(scan([]));
      await pick(
        api,
        scan([
          parent(),
          nested('pantry-android', {
            surfaces: ['custom-folder', 'nested-repository'],
          }),
        ]),
      );
      expect(box('pantry-android').checked).toBe(true);
      expect(box('parent').checked).toBe(false);
      expect(rowIds().filter((id) => id === 'pantry-android')).toHaveLength(1);
    });

    it('keeps independently discovered related rows visible so capped summaries count rendered results', async () => {
      const api = installApi(scan([]));
      await pick(
        api,
        scan([
          parent({ nestedRepositories: { count: 37, complete: true } }),
          nested('pantry-android'),
          candidate('independent', {
            lastActivityAt: '2020-01-01T00:00:00.000Z',
            parentCandidateIds: ['parent'],
          }),
        ]),
      );
      expect(rowIds()).toContain('independent');
      expect(byTestId('first-run-import-projects').textContent).toContain(
        'Showing 2 of 37 repositories',
      );
    });

    it('keeps the summary and available repositories when the folder is unavailable', async () => {
      const api = installApi(scan([]));
      await pick(
        api,
        scan([
          parent({ status: 'unavailable', statusReason: 'Holds a project' }),
          nested('pantry-android'),
          nested('wear-timer'),
          nested('compose-playground', { status: 'already-tracked' }),
        ]),
      );

      expect(rowIds()).toEqual(['pantry-android', 'wear-timer']);
      expect(byTestId('first-run-import-projects').textContent).toContain(
        'Found 3 repositories in AndroidStudioProjects · 1 already added',
      );
    });

    it('shows picked types instead of No chat history even with provider evidence', async () => {
      const api = installApi(scan([]));
      await pick(
        api,
        scan([
          parent({ nestedRepositories: { count: 1, complete: true } }),
          nested('pantry-android', { providers: ['claude'] }),
        ]),
      );
      const row = byTestId('first-run-import-row-pantry-android');
      expect(row.textContent).toContain('Code repository');
      expect(row.textContent).not.toContain('No chat history');
    });

    it('ignores an earlier pick that resolves after a newer one', async () => {
      const api = installApi(scan([]));
      let resolveFirst: (value: ExternalProjectDiscoverResponse) => void = () =>
        undefined;
      api.pickFolder.mockResolvedValue(PARENT);
      api.discover
        .mockResolvedValueOnce(scan([]))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce(ticketPick());
      await render();
      const choose = (): HTMLElement => {
        const button = Array.from(container.querySelectorAll('button')).find(
          (node) => node.textContent === 'Choose a folder',
        );
        if (!button) throw new Error('missing Choose a folder');
        return button;
      };
      await click(choose());
      await click(choose());
      expect(rowIds()).toContain('pantry-android');

      await act(async () => {
        resolveFirst(
          scan([candidate('stale', { surfaces: ['custom-folder'] })]),
        );
        await Promise.resolve();
      });
      await flush();
      expect(rowIds()).not.toContain('stale');
      expect(rowIds()).toContain('pantry-android');
    });
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

  it('lands on the most recent of several imports (CAN-4674)', async () => {
    const OLDER = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const api = installApi(
      scan([
        candidate('payments-service', { lastActivityAt: OLDER }),
        candidate('side-quest'),
      ]),
    );
    api.importProjects.mockResolvedValue({
      results: [result('payments-service'), result('side-quest')],
    });
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
      'ws-side-quest',
    );
  });

  it('lands on the only successful import (CAN-4674)', async () => {
    const api = installApi(scan([candidate('alpha'), candidate('beta')]));
    api.importProjects.mockResolvedValue({
      results: [
        result('alpha'),
        result('beta', { status: 'failed', workspaceId: undefined }),
      ],
    });
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(navigateAfterRepositoryWorkspaceCreated).toHaveBeenCalledWith(
      'ws-alpha',
    );
  });

  it('opens nothing when the context changed during import (CAN-4674)', async () => {
    const api = installApi(scan([candidate('alpha'), candidate('beta')]));
    api.importProjects.mockImplementation(() => {
      useWorkspaceContextStore.setState({ accountEpoch: 2 });
      return Promise.resolve({ results: [result('alpha'), result('beta')] });
    });
    await render();

    await click(byTestId('first-run-import-submit'));

    expect(onDone).toHaveBeenCalled();
    expect(navigateAfterRepositoryWorkspaceCreated).not.toHaveBeenCalled();
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
    const setContext = jest.fn<
      Promise<WorkspaceContextState>,
      [WorkspaceContext]
    >(() =>
      Promise.resolve({
        context: { kind: 'personal' },
        revision: 2,
        organizations: [{ id: ORG_A, name: 'Org A', role: 'MEMBER' }],
      }),
    );
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
    it('shows the provider rows in the neutral tone under the credits intro', async () => {
      installApi(scan([]));
      await render();
      expect(container.textContent).toContain(
        'Use free AI Credits, or connect a subscription you already have.',
      );
      expect(container.textContent).not.toContain(
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
      const row = byTestId('first-run-daily-credits');
      expect(
        byTestId('first-run-daily-credits-description').dataset.state,
      ).toBe('offer');
      expect(row.querySelector('label')?.textContent?.trim()).toBe(
        'Free daily AI Credits',
      );
      expect(creditsSwitch().getAttribute('aria-label')).toBe(
        'Free daily AI Credits',
      );
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('false');
      expect(queryTestId('first-run-daily-credits-confirmation')).toBeNull();
    });

    it('names the switch with its label and describes it with the offer', async () => {
      installApi(scan([]));
      await render();
      const label = byTestId('first-run-daily-credits').querySelector('label');
      expect(label?.htmlFor).toBe(creditsSwitch().id);
      const describedBy = creditsSwitch().getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
        'No card needed · 10 AI Credits every day',
      );
    });

    it('reads the offer cap from the server', async () => {
      const api = installApi(scan([]));
      api.loadCloudDailyCreditDrip.mockResolvedValue({
        available: true,
        resolved: true,
        preference: { enabled: false, decidedAt: null, capCredits: 25 },
      });
      await render();
      expect(
        byTestId('first-run-daily-credits-description').textContent,
      ).toContain('No card needed · 25 AI Credits every day');
    });

    it('turns the switch on from its label', async () => {
      const api = installApi(scan([]));
      await render();
      const label = byTestId('first-run-daily-credits').querySelector('label');
      if (!(label instanceof HTMLElement)) throw new Error('missing label');
      await click(label);
      expect(api.saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
      expect(api.saveCloudDailyCreditDrip).toHaveBeenCalledWith({
        enabled: true,
      });
    });

    function saveResult(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        enabled: true,
        decidedAt: RECENT,
        capCredits: 10,
        balanceCredits: 7,
        granted: 7,
        ...overrides,
      };
    }

    it('confirms the actual grant, not the cap, once the save settles', async () => {
      const api = installApi(scan([]));
      api.saveCloudDailyCreditDrip.mockResolvedValueOnce(saveResult());
      await render();
      await click(creditsSwitch());
      const confirmation = byTestId('first-run-daily-credits-confirmation');
      expect(confirmation.textContent).toBe(
        '7 free AI Credits added · refills daily',
      );
      expect(confirmation.closest('[role="status"]')).not.toBeNull();
      expect(
        byTestId('first-run-daily-credits-description').dataset.state,
      ).toBe('granted');
      const describedBy = creditsSwitch().getAttribute('aria-describedby');
      expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
        '7 free AI Credits added · refills daily',
      );
    });

    it('acknowledges a zero grant without claiming credits were added', async () => {
      const api = installApi(scan([]));
      api.saveCloudDailyCreditDrip.mockResolvedValueOnce(
        saveResult({ granted: 0, balanceCredits: 0 }),
      );
      await render();
      await click(creditsSwitch());
      expect(byTestId('first-run-daily-credits-confirmation').textContent).toBe(
        'Free daily AI Credits enabled.',
      );
      expect(
        byTestId('first-run-daily-credits-description').dataset.state,
      ).toBe('enabled');
      const status = byTestId(
        'first-run-daily-credits-description',
      ).querySelector('[role="status"]');
      expect(status?.textContent).not.toMatch(/added|tomorrow/);
    });

    it.each(['network_limit', 'network_unidentified'])(
      'keeps the offer when the grant is blocked (%s), even with a grant',
      async (blockedReason) => {
        const api = installApi(scan([]));
        api.saveCloudDailyCreditDrip.mockResolvedValueOnce(
          saveResult({ blockedReason, granted: 5 }),
        );
        await render();
        await click(creditsSwitch());
        expect(creditsSwitch().getAttribute('aria-checked')).toBe('true');
        expect(queryTestId('first-run-daily-credits-confirmation')).toBeNull();
        expect(
          byTestId('first-run-daily-credits-description').dataset.state,
        ).toBe('offer');
      },
    );

    it('keeps the offer and ignores repeat clicks while saving', async () => {
      const api = installApi(scan([]));
      let settle: (value: Record<string, unknown>) => void = () => undefined;
      api.saveCloudDailyCreditDrip.mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      await render();
      await click(creditsSwitch());
      await click(creditsSwitch());
      expect(api.saveCloudDailyCreditDrip).toHaveBeenCalledTimes(1);
      expect(
        byTestId('first-run-daily-credits-description').dataset.state,
      ).toBe('offer');
      expect(queryTestId('first-run-daily-credits-confirmation')).toBeNull();
      await act(async () => {
        settle(saveResult());
        await Promise.resolve();
      });
      await flush();
      expect(
        byTestId('first-run-daily-credits-confirmation').textContent,
      ).toContain('7 free AI Credits added');
    });

    it('withdraws the confirmation when the user turns the credits off', async () => {
      const api = installApi(scan([]));
      api.saveCloudDailyCreditDrip.mockResolvedValueOnce(saveResult());
      await render();
      await click(creditsSwitch());
      expect(
        queryTestId('first-run-daily-credits-confirmation'),
      ).not.toBeNull();
      await click(creditsSwitch());
      expect(api.saveCloudDailyCreditDrip).toHaveBeenLastCalledWith({
        enabled: false,
      });
      expect(queryTestId('first-run-daily-credits-confirmation')).toBeNull();
      expect(
        byTestId('first-run-daily-credits-description').textContent,
      ).toContain('No card needed · 10 AI Credits every day');
    });

    it('clears the confirmation when a retry fails', async () => {
      const api = installApi(scan([]));
      api.saveCloudDailyCreditDrip
        .mockResolvedValueOnce(saveResult())
        .mockResolvedValueOnce(saveResult({ enabled: false, granted: 0 }))
        .mockRejectedValueOnce(new Error('offline'));
      await render();
      await click(creditsSwitch());
      await click(creditsSwitch());
      await click(creditsSwitch());
      expect(byTestId('first-run-daily-credits-error')).not.toBeNull();
      expect(queryTestId('first-run-daily-credits-confirmation')).toBeNull();
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
      // Already on, with no save from this page: no grant is claimed.
      expect(queryTestId('first-run-daily-credits-confirmation')).toBeNull();
      expect(
        byTestId('first-run-daily-credits-description').textContent,
      ).toContain('No card needed · 10 AI Credits every day');
    });

    it('does not offer the credits to a Claude subscriber', async () => {
      mockClaudeStatus = { authenticated: true };
      installApi(scan([]));
      await render();
      expect(container.textContent).toContain(
        `Bring your own subscription or use your ${brandText.appName} account.`,
      );
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

    it('uses the replacement account choice while old and new saves settle', async () => {
      const api = installApi(scan([]));
      let settleOld: (value: Record<string, unknown>) => void = () => undefined;
      let settleNew: (value: Record<string, unknown>) => void = () => undefined;
      api.saveCloudDailyCreditDrip
        .mockReturnValueOnce(
          new Promise((resolve) => {
            settleOld = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            settleNew = resolve;
          }),
        );
      await render();
      await click(creditsSwitch());
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('true');

      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await flush();
      expect(creditsSwitch().hasAttribute('disabled')).toBe(false);
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('false');

      await click(creditsSwitch());
      expect(api.saveCloudDailyCreditDrip).toHaveBeenNthCalledWith(2, {
        enabled: true,
      });
      await act(async () => {
        settleOld(saveResult());
        await Promise.resolve();
      });
      await flush();
      expect(creditsSwitch().hasAttribute('disabled')).toBe(true);
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('true');
      expect(queryTestId('first-run-daily-credits-confirmation')).toBeNull();

      await act(async () => {
        settleNew(saveResult({ granted: 3 }));
        await Promise.resolve();
      });
      await flush();
      expect(creditsSwitch().hasAttribute('disabled')).toBe(false);
      expect(creditsSwitch().getAttribute('aria-checked')).toBe('true');
      expect(byTestId('first-run-daily-credits-confirmation').textContent).toBe(
        '3 free AI Credits added · refills daily',
      );
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
  });

  // CAN-5290: every empty scan asks for a folder rather than explaining
  // what the scan missed.
  describe('empty projects row (CAN-5290)', () => {
    const noProviders: ExternalProjectDiscoverResponse = {
      ...scan([]),
      providersDetected: { claude: false, codex: false },
    };
    const onlyAdded = scan([
      candidate('tracked', { status: 'already-tracked' }),
      candidate('imported', { status: 'already-imported' }),
    ]);

    it.each([
      ['no provider data', noProviders],
      ['an empty provider store', scan([])],
      ['only projects already added', onlyAdded],
    ])('asks for a folder with %s', async (_name, response) => {
      installApi(response);
      await render();
      expect(queryTestId('first-run-import-submit')).toBeNull();
      const empty = byTestId('first-run-import-empty');
      expect(empty.textContent).toBe(
        'Add a projectAdd the folder you want to work inChoose a folder',
      );
      expect(container.textContent).not.toMatch(
        /No Claude or Codex|Everything found|Add any folder/,
      );
      const choose = byTestId('first-run-import-choose-folder');
      expect(choose.className).toContain('bg-accent');
      const skip = byTestId('first-run-import-skip');
      expect(skip.textContent).toBe('Continue without a project');
      expect(skip.className).toContain('bg-transparent');
      expect(skip.className).not.toContain('bg-accent');
    });

    it('stays on the empty state when the folder pick is canceled', async () => {
      const api = installApi(scan([]));
      await render();
      await click(byTestId('first-run-import-choose-folder'));
      expect(api.pickFolder).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();
      expect(api.savePreferences).not.toHaveBeenCalled();
      expect(queryTestId('first-run-import-empty')).not.toBeNull();
      expect(byTestId('first-run-import-skip').textContent).toBe(
        'Continue without a project',
      );
    });

    it.each(['picker', 'rescan'] as const)(
      'keeps the empty state usable after a %s failure',
      async (failure) => {
        const api = installApi(scan([]));
        await render();
        if (failure === 'picker') {
          api.pickFolder.mockRejectedValueOnce(new Error('denied'));
        } else {
          api.pickFolder.mockResolvedValueOnce('/Users/me/picked');
          api.discover.mockRejectedValueOnce(new Error('unreadable'));
        }
        await click(byTestId('first-run-import-choose-folder'));

        expect(byTestId('first-run-import-actions').textContent).toContain(
          "Couldn't add that folder. Try again.",
        );
        expect(queryTestId('first-run-import-empty')).not.toBeNull();
        expect(onDone).not.toHaveBeenCalled();
        expect(api.savePreferences).not.toHaveBeenCalled();

        api.pickFolder.mockResolvedValueOnce('/Users/me/picked');
        api.discover.mockResolvedValueOnce(
          scan([
            candidate('picked', {
              surfaces: ['custom-folder'],
              providers: [],
              lastActivityAt: null,
            }),
          ]),
        );
        await click(byTestId('first-run-import-choose-folder'));

        expect(queryTestId('first-run-import-empty')).toBeNull();
        expect(byTestId('first-run-import-submit').textContent).toBe(
          'Import 1 project',
        );
        expect(onDone).not.toHaveBeenCalled();
        expect(api.savePreferences).not.toHaveBeenCalled();
      },
    );

    it('moves to the import flow once a folder is chosen', async () => {
      const api = installApi(scan([]));
      api.pickFolder.mockResolvedValue('/Users/me/picked');
      api.discover.mockResolvedValueOnce(scan([])).mockResolvedValueOnce(
        scan([
          candidate('picked', {
            surfaces: ['custom-folder'],
            providers: [],
            lastActivityAt: null,
          }),
        ]),
      );
      await render();
      await click(byTestId('first-run-import-choose-folder'));

      expect(onDone).not.toHaveBeenCalled();
      expect(api.savePreferences).not.toHaveBeenCalled();
      expect(queryTestId('first-run-import-empty')).toBeNull();
      expect(queryTestId('first-run-import-choose-folder')).toBeNull();
      expect(byTestId('first-run-import-submit').textContent).toBe(
        'Import 1 project',
      );
      expect(byTestId('first-run-import-skip').textContent).toBe(
        'Skip for now',
      );
    });

    it('keeps the import flow when every importable project is unchecked', async () => {
      installApi(
        scan([
          candidate('alpha'),
          candidate('tracked', { status: 'already-tracked' }),
        ]),
      );
      await render();
      const box = container.querySelector('#first-run-alpha');
      if (!(box instanceof HTMLInputElement)) throw new Error('missing alpha');
      expect(box.checked).toBe(true);
      await click(box);

      expect(box.checked).toBe(false);
      expect(queryTestId('first-run-import-empty')).toBeNull();
      expect(byTestId('first-run-import-submit').textContent).toBe(
        'Select a project to import',
      );
      expect(byTestId('first-run-import-skip').textContent).toBe(
        'Skip for now',
      );
    });
  });

  describe('found projects (CAN-4712)', () => {
    const NOW = Date.parse('2026-10-24T12:00:00.000Z');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const daysAgo = (days: number): string =>
      new Date(NOW - days * DAY_MS).toISOString();
    const allOlder = (): ExternalProjectCandidate[] => [
      candidate('invoice-api', { lastActivityAt: daysAgo(105) }),
      candidate('ops-scripts', { lastActivityAt: daysAgo(130) }),
      candidate('dotfiles', { lastActivityAt: daysAgo(150) }),
    ];
    const mixed = (): ExternalProjectCandidate[] => [
      candidate('fresh', { lastActivityAt: daysAgo(2) }),
      candidate('invoice-api', { lastActivityAt: daysAgo(105) }),
      candidate('ops-scripts', { lastActivityAt: daysAgo(130) }),
    ];

    const rowIds = (): string[] =>
      Array.from(
        container.querySelectorAll('[data-testid^="first-run-import-row-"]'),
      ).map((row) =>
        (row.getAttribute('data-testid') ?? '').replace(
          'first-run-import-row-',
          '',
        ),
      );
    const box = (id: string): HTMLInputElement => {
      const node = container.querySelector(`#first-run-${id}`);
      if (!(node instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
      return node;
    };
    const selectAll = (): HTMLInputElement => box('select-all');
    const submit = (): HTMLButtonElement => {
      const node = byTestId('first-run-import-submit');
      if (!(node instanceof HTMLButtonElement)) throw new Error('not a button');
      return node;
    };
    const projectsText = (): string =>
      byTestId('first-run-import-projects').textContent ?? '';

    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('lists every older project unchecked with a found count', async () => {
      installApi(scan(allOlder()));
      await render();

      expect(rowIds()).toEqual(['invoice-api', 'ops-scripts', 'dotfiles']);
      for (const id of rowIds()) expect(box(id).checked).toBe(false);
      expect(queryTestId('first-run-import-older')).toBeNull();
      expect(projectsText()).toContain(
        'Found 3 Claude projects · last used 3–5 months ago',
      );
      expect(projectsText()).not.toContain('A project is a folder you work in');
    });

    it('counts only importable projects and ignores recent excluded results', async () => {
      installApi(
        scan([
          ...allOlder(),
          candidate('missing', {
            status: 'unavailable',
            lastActivityAt: daysAgo(1),
          }),
          candidate('tracked', {
            status: 'already-tracked',
            lastActivityAt: daysAgo(1),
          }),
          candidate('imported', {
            status: 'already-imported',
            lastActivityAt: daysAgo(1),
          }),
          candidate('scratch', {
            rootPath: '/Users/me/local-agent-mode-sessions/scratch',
            lastActivityAt: daysAgo(1),
          }),
        ]),
      );
      await render();

      expect(rowIds()).toEqual(['invoice-api', 'ops-scripts', 'dotfiles']);
      expect(projectsText()).toContain(
        'Found 3 Claude projects · last used 3–5 months ago',
      );
    });

    it('prompts for a selection until a project is checked', async () => {
      const api = installApi(scan(allOlder()));
      await render();

      expect(submit().textContent).toBe('Select a project to import');
      expect(submit().disabled).toBe(true);

      await click(box('ops-scripts'));
      expect(submit().textContent).toBe('Import 1 project');
      expect(submit().disabled).toBe(false);

      await click(box('ops-scripts'));
      expect(submit().textContent).toBe('Select a project to import');
      expect(submit().disabled).toBe(true);

      await click(box('invoice-api'));
      await click(submit());
      expect(api.importProjects).toHaveBeenCalledWith(
        expect.objectContaining({
          selections: [{ candidateId: 'invoice-api', importChats: false }],
        }),
      );
    });

    it('selects all, shows a partial selection, and clears', async () => {
      installApi(scan(allOlder()));
      await render();

      expect(selectAll().checked).toBe(false);
      await click(selectAll());
      for (const id of rowIds()) expect(box(id).checked).toBe(true);
      expect(submit().textContent).toBe('Import 3 projects');

      await click(box('dotfiles'));
      expect(selectAll().checked).toBe(false);
      expect(submit().textContent).toBe('Import 2 projects');

      await click(selectAll());
      expect(selectAll().checked).toBe(true);
      await click(selectAll());
      for (const id of rowIds()) expect(box(id).checked).toBe(false);
      expect(submit().textContent).toBe('Select a project to import');
    });

    it('keeps a selection across a rerender', async () => {
      installApi(scan(allOlder()));
      await render();
      await click(box('dotfiles'));

      await render();

      expect(box('dotfiles').checked).toBe(true);
      expect(rowIds()).toHaveLength(3);
      expect(submit().textContent).toBe('Import 1 project');
    });

    it('uses singular copy and no Select all for one older project', async () => {
      installApi(
        scan([candidate('dotfiles', { lastActivityAt: daysAgo(150) })]),
      );
      await render();

      expect(rowIds()).toEqual(['dotfiles']);
      expect(queryTestId('first-run-import-select-all')).toBeNull();
      expect(projectsText()).toContain(
        'Found 1 Claude project · last used 5 months ago',
      );
    });

    it.each<[string, ExternalProjectCandidate[], string]>([
      [
        'Codex only',
        [
          candidate('a', {
            providers: ['codex'],
            lastActivityAt: daysAgo(100),
          }),
          candidate('b', {
            providers: ['codex'],
            lastActivityAt: daysAgo(100),
          }),
        ],
        'Found 2 Codex projects',
      ],
      [
        'Claude and Codex across projects',
        [
          candidate('a', { lastActivityAt: daysAgo(100) }),
          candidate('b', {
            providers: ['codex'],
            lastActivityAt: daysAgo(100),
          }),
        ],
        'Found 2 Claude and Codex projects',
      ],
      [
        'both on one project',
        [
          candidate('a', {
            providers: ['claude', 'codex'],
            lastActivityAt: daysAgo(100),
          }),
        ],
        'Found 1 Claude and Codex project',
      ],
      [
        'no provider',
        [candidate('a', { providers: [], lastActivityAt: daysAgo(100) })],
        'Found 1 project',
      ],
      [
        'a provider-less project among Claude ones',
        [
          candidate('a', { lastActivityAt: daysAgo(100) }),
          candidate('b', { providers: [], lastActivityAt: daysAgo(100) }),
        ],
        'Found 2 projects',
      ],
    ])('names the providers for %s', async (_name, candidates, expected) => {
      installApi(scan(candidates));
      await render();
      expect(projectsText()).toContain(`${expected} · last used 3 months ago`);
    });

    it.each<[string[]]>([[['cursor']], [['claude', 'cursor']]])(
      'uses neutral copy for unsupported provider metadata %j',
      async (providers) => {
        const project = candidate('a', { lastActivityAt: daysAgo(105) });
        // Simulate unrecognized metadata at the runtime boundary without
        // weakening the shared provider union or forcing a type cast.
        Object.defineProperty(project, 'providers', { value: providers });
        installApi(scan([project]));
        await render();

        expect(projectsText()).toContain(
          'Found 1 project · last used 3 months ago',
        );
      },
    );

    it.each<[string, (string | null)[], string]>([
      [
        'equal buckets',
        [daysAgo(95), daysAgo(110)],
        ' · last used 3 months ago',
      ],
      [
        'different units',
        [daysAgo(340), daysAgo(400)],
        ' · last used 11 months–1 year ago',
      ],
      ['plural years', [daysAgo(800)], ' · last used 2 years ago'],
      [
        'valid activity at the Unix epoch',
        ['1970-01-01T00:00:00.000Z'],
        ' · last used 56 years ago',
      ],
      [
        'valid activity before the Unix epoch',
        ['1960-01-01T00:00:00.000Z'],
        ' · last used 66 years ago',
      ],
      ['empty activity', ['', null], ''],
      [
        'partly known activity',
        [daysAgo(105), null, daysAgo(130)],
        ' · known activity 3–4 months ago',
      ],
      [
        'an invalid timestamp',
        [daysAgo(105), 'not-a-date'],
        ' · known activity 3 months ago',
      ],
      ['no activity', [null, 'not-a-date'], ''],
    ])('describes the age range for %s', async (_name, stamps, suffix) => {
      installApi(
        scan(
          stamps.map((lastActivityAt, i) =>
            candidate(`p${i}`, { lastActivityAt }),
          ),
        ),
      );
      await render();
      const count = stamps.length;
      const found = `Found ${count} Claude ${count === 1 ? 'project' : 'projects'}`;
      expect(projectsText()).toContain(`${found}${suffix}`);
      expect(projectsText()).not.toContain('NaN');
      expect(projectsText()).not.toContain('undefined');
      if (suffix === '') expect(projectsText()).not.toContain(' · ');
    });

    it('shows only the recent project, checked, when some are recent', async () => {
      installApi(scan(mixed()));
      await render();

      expect(rowIds()).toEqual(['fresh']);
      expect(box('fresh').checked).toBe(true);
      expect(queryTestId('first-run-import-select-all')).toBeNull();
      expect(projectsText()).toContain('A project is a folder you work in');
      expect(projectsText()).not.toContain('Found');
      expect(byTestId('first-run-import-older').textContent).toBe(
        'Show 2 older projects',
      );

      await click(byTestId('first-run-import-older'));
      expect(rowIds()).toEqual(['fresh', 'invoice-api', 'ops-scripts']);
      expect(queryTestId('first-run-import-select-all')).not.toBeNull();

      await click(box('ops-scripts'));
      await click(byTestId('first-run-import-older'));
      expect(rowIds()).toEqual(['fresh', 'ops-scripts']);
      expect(byTestId('first-run-import-older').textContent).toBe(
        'Show 1 older project',
      );
    });

    it('keeps the recent layout when every recent project is unchecked', async () => {
      installApi(scan(mixed()));
      await render();

      await click(box('fresh'));

      expect(submit().textContent).toBe('Select a project to import');
      expect(submit().disabled).toBe(true);
      expect(rowIds()).toEqual(['fresh']);
      expect(byTestId('first-run-import-older').textContent).toBe(
        'Show 2 older projects',
      );
      expect(projectsText()).not.toContain('Found');
    });

    it('removes the toggle when an expanded mixed result becomes all older', async () => {
      installApi(scan(mixed()));
      await render();
      await click(byTestId('first-run-import-older'));
      expect(rowIds()).toHaveLength(3);

      jest.spyOn(Date, 'now').mockReturnValue(NOW + 100 * DAY_MS);
      await render();

      expect(rowIds()).toEqual(['fresh', 'invoice-api', 'ops-scripts']);
      expect(queryTestId('first-run-import-older')).toBeNull();
      expect(projectsText()).toContain('Found 3 Claude projects');
      expect(box('fresh').checked).toBe(true);
    });

    it.each<[string, number, boolean]>([
      ['just under 90 days', 90 * DAY_MS - 1, true],
      ['exactly 90 days', 90 * DAY_MS, false],
      ['just over 90 days', 90 * DAY_MS + 1, false],
    ])('classifies a project %s old', async (_name, ageMs, recent) => {
      installApi(
        scan([
          candidate('edge', {
            lastActivityAt: new Date(NOW - ageMs).toISOString(),
          }),
          candidate('old', { lastActivityAt: daysAgo(150) }),
        ]),
      );
      await render();

      expect(box('edge').checked).toBe(recent);
      expect(queryTestId('first-run-import-older') !== null).toBe(recent);
      expect(rowIds()).toEqual(recent ? ['edge'] : ['edge', 'old']);
    });

    it('shows no found count or Select all when nothing is found', async () => {
      installApi(scan([]));
      await render();
      expect(container.textContent).not.toContain('Found 0');
      expect(queryTestId('first-run-import-select-all')).toBeNull();
      expect(queryTestId('first-run-import-submit')).toBeNull();
    });

    it('shows no found count while the scan runs', async () => {
      const api = installApi(scan([]));
      api.discover.mockReturnValue(new Promise(() => undefined));
      await render();
      expect(container.textContent).not.toContain('Found');
      expect(queryTestId('first-run-import-select-all')).toBeNull();
      expect(queryTestId('first-run-import-submit')).toBeNull();
    });

    it('prompts for a selection after the picked folder is unchecked', async () => {
      const api = installApi(scan([]));
      api.pickFolder.mockResolvedValue('/Users/me/picked');
      api.discover.mockResolvedValueOnce(scan([])).mockResolvedValueOnce(
        scan([
          candidate('picked', {
            surfaces: ['custom-folder'],
            providers: [],
            lastActivityAt: null,
          }),
        ]),
      );
      await render();
      await click(byTestId('first-run-import-choose-folder'));
      expect(submit().textContent).toBe('Import 1 project');

      await click(box('picked'));

      expect(submit().textContent).toBe('Select a project to import');
      expect(submit().disabled).toBe(true);
    });

    it('reads Importing… while the import runs', async () => {
      const api = installApi(scan(allOlder()));
      api.importProjects.mockReturnValue(new Promise(() => undefined));
      await render();
      await click(box('dotfiles'));

      await click(submit());

      expect(submit().textContent).toBe('Importing…');
      expect(submit().disabled).toBe(true);

      await click(box('dotfiles'));
      expect(submit().textContent).toBe('Importing…');
      expect(submit().disabled).toBe(true);
    });
  });

  describe('projects box (CAN-4679)', () => {
    const actions = (): HTMLElement => byTestId('first-run-import-actions');
    const actionIds = (): (string | null)[] =>
      Array.from(actions().querySelectorAll('button')).map((button) =>
        button.getAttribute('data-testid'),
      );

    it('holds the box and Skip while the scan runs, then fills the list', async () => {
      jest.useFakeTimers();
      try {
        const api = installApi(scan([]));
        let finishScan: (
          response: ExternalProjectDiscoverResponse,
        ) => void = () => undefined;
        api.discover.mockReturnValue(
          new Promise((resolve) => {
            finishScan = resolve;
          }),
        );
        await render();

        const box = byTestId('first-run-import-projects');
        const footer = actions();
        const skip = byTestId('first-run-import-skip');
        skip.focus();
        expect(document.activeElement).toBe(skip);
        expect(box.textContent).toContain('Projects');
        expect(actionIds()).toEqual(['first-run-import-skip']);
        expect(queryTestId('first-run-import-submit')).toBeNull();
        expect(container.textContent).not.toContain('Found');
        const placeholder = (): Element | null =>
          byTestId('first-run-import-list').querySelector(
            '[data-testid="delayed-loading-placeholder"]',
          );
        expect(placeholder()?.getAttribute('data-visible')).toBe('false');
        await act(async () => {
          jest.advanceTimersByTime(LOADING_PLACEHOLDER_DELAY_MS);
          await Promise.resolve();
        });
        expect(placeholder()?.getAttribute('data-visible')).toBe('true');

        await act(async () => {
          finishScan(scan([candidate('alpha'), candidate('beta')]));
          await Promise.resolve();
        });
        await flush();

        // The same box and footer stay mounted, so focus on Skip survives.
        expect(byTestId('first-run-import-projects')).toBe(box);
        expect(actions()).toBe(footer);
        expect(byTestId('first-run-import-skip')).toBe(skip);
        expect(document.activeElement).toBe(skip);
        expect(queryTestId('first-run-import-projects-loading')).toBeNull();
        const list = byTestId('first-run-import-list');
        expect(
          list.querySelector('[data-testid="first-run-import-select-all"]'),
        ).not.toBeNull();
        expect(
          list.querySelector('[data-testid="first-run-import-row-alpha"]'),
        ).not.toBeNull();
        expect(actionIds()).toEqual([
          'first-run-import-skip',
          'first-run-import-submit',
        ]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('lists the empty state and puts Continue without a project in the footer', async () => {
      installApi(scan([]));
      await render();
      const list = byTestId('first-run-import-list');
      expect(
        list.querySelector('[data-testid="first-run-import-empty"]'),
      ).not.toBeNull();
      expect(
        list.querySelector('[data-testid="first-run-import-choose-folder"]'),
      ).not.toBeNull();
      expect(actionIds()).toEqual(['first-run-import-skip']);
      expect(byTestId('first-run-import-skip').textContent).toBe(
        'Continue without a project',
      );
    });

    it('shows a failed import beside the actions and keeps the selection', async () => {
      const api = installApi(scan([candidate('alpha'), candidate('beta')]));
      api.importProjects
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ results: [result('alpha'), result('beta')] });
      await render();

      await click(byTestId('first-run-import-submit'));

      expect(actions().textContent).toContain(
        "Couldn't import projects. Try again.",
      );
      const submit = byTestId('first-run-import-submit');
      expect(submit.textContent).toBe('Import 2 projects');
      expect(submit.hasAttribute('disabled')).toBe(false);

      await click(submit);
      expect(api.importProjects).toHaveBeenCalledTimes(2);
      expect(onDone).toHaveBeenCalled();
    });

    it('shows a failed scan beside Skip, with no loading list', async () => {
      const api = installApi(scan([]));
      api.discover.mockRejectedValue(new Error('denied'));
      await render();

      expect(actions().textContent).toContain(
        "Couldn't look for Claude and Codex projects. Try again.",
      );
      expect(actionIds()).toEqual(['first-run-import-skip']);
      expect(byTestId('first-run-import-skip').textContent).toBe(
        'Skip for now',
      );
      expect(queryTestId('first-run-import-projects-loading')).toBeNull();
      expect(queryTestId('first-run-import-empty')).toBeNull();
    });
  });

  describe('forward action', () => {
    it('finishes from Continue without a project without opening the picker', async () => {
      const api = installApi(scan([]));
      await render();
      await click(byTestId('first-run-import-skip'));
      expect(api.pickFolder).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalled();
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

  describe('telemetry (CAN-4635)', () => {
    type Call = unknown[];
    type OperationMock = jest.Mock<void, unknown[]>;
    const calls = (mock: OperationMock, name: string): Call[] =>
      mock.mock.calls.filter((call: Call) => call[0] === name);
    const contextOf = (call: Call | undefined): unknown => {
      const options = call?.[call.length - 1];
      return options && typeof options === 'object' && 'context' in options
        ? options.context
        : undefined;
    };
    const keyOf = (call: Call | undefined): unknown => {
      const options = call?.[call.length - 1];
      return options && typeof options === 'object' && 'operationKey' in options
        ? options.operationKey
        : undefined;
    };
    const visitEnds = (): Call[] =>
      calls(succeedOperation, 'canopy.first_run_import');

    it('reports confirmed sign-outs in the view, submission and completion', async () => {
      mockClaudeStatus = {
        authenticated: false,
        error: 'Claude is not authenticated.',
      };
      mockCodexStatus = {
        authenticated: false,
        error: 'Codex is not authenticated.',
      };
      const api = installApi(scan([candidate('alpha')]));
      api.importProjects.mockResolvedValue({ results: [result('alpha')] });
      await render();
      await click(byTestId('first-run-import-submit'));
      for (const operation of [
        'canopy.first_run_import_view',
        'canopy.project_import',
        'canopy.first_run_import',
      ]) {
        const emitted = calls(succeedOperation, operation);
        expect(emitted).toHaveLength(1);
        expect(contextOf(emitted[0])).toMatchObject({
          claude_connection: 'not_connected',
          codex_connection: 'not_connected',
        });
      }
    });

    it('views once per visit through effect replay, with unresolved auth unknown', async () => {
      mockClaudeStatus = null;
      mockCodexStatus = { authenticated: true };
      installApi(scan([candidate('alpha')]));
      await act(async () => {
        root.render(
          <StrictMode>
            <FirstRunImportPage onDone={onDone} />
          </StrictMode>,
        );
        await Promise.resolve();
      });
      await flush();

      const views = calls(succeedOperation, 'canopy.first_run_import_view');
      expect(views).toHaveLength(1);
      expect(contextOf(views[0])).toEqual({
        claude_connection: 'unknown',
        codex_connection: 'connected',
      });
      expect(calls(startOperation, 'canopy.first_run_import')).toHaveLength(1);
    });

    it('starts a new visit on a real remount and completes nothing on unmount', async () => {
      installApi(scan([candidate('alpha')]));
      await render();
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      await render();

      const starts = calls(startOperation, 'canopy.first_run_import');
      expect(starts).toHaveLength(2);
      expect(keyOf(starts[0])).not.toBe(keyOf(starts[1]));
      expect(visitEnds()).toHaveLength(0);
    });

    it('reports a skip with found projects once', async () => {
      installApi(scan([candidate('alpha')]));
      await render();
      const skip = byTestId('first-run-import-skip');
      await click(skip);
      await click(skip);

      expect(visitEnds()).toHaveLength(1);
      expect(keyOf(visitEnds()[0])).toBe(
        keyOf(calls(startOperation, 'canopy.first_run_import')[0]),
      );
      expect(contextOf(visitEnds()[0])).toEqual({
        outcome: 'skipped',
        scan_outcome: 'found',
        claude_data_detected: true,
        codex_data_detected: false,
        claude_connection: 'not_connected',
        codex_connection: 'not_connected',
        found_count: 1,
        credits_offered: true,
        imported_count: 0,
        submission_count: 0,
        failed_submission_count: 0,
        picked_folder: false,
      });
    });

    it('reports continuing after an empty scan', async () => {
      installApi(scan([]));
      await render();
      await click(byTestId('first-run-import-skip'));
      expect(contextOf(visitEnds()[0])).toMatchObject({
        outcome: 'continued_empty',
        scan_outcome: 'empty',
        found_count: 0,
      });
    });

    it('completes with current provider facts and omits unresolved scan counts', async () => {
      mockClaudeStatus = null;
      const api = installApi(scan([]));
      api.discover.mockReturnValue(new Promise(() => undefined));
      await render();
      mockClaudeStatus = { authenticated: true };
      await render();
      await click(byTestId('first-run-import-skip'));
      expect(contextOf(visitEnds()[0])).toMatchObject({
        outcome: 'skipped',
        scan_outcome: 'unknown',
        claude_connection: 'connected',
      });
      expect(contextOf(visitEnds()[0])).not.toHaveProperty('found_count');
      expect(
        calls(succeedOperation, 'canopy.first_run_import_view'),
      ).toHaveLength(1);
    });

    it('reports a skip after a failed scan without scan facts', async () => {
      const api = installApi(scan([]));
      api.discover.mockRejectedValue(new Error('no access'));
      await render();
      await click(byTestId('first-run-import-skip'));
      const context = contextOf(visitEnds()[0]);
      expect(context).toMatchObject({
        outcome: 'skipped',
        scan_outcome: 'failed',
      });
      expect(context).not.toHaveProperty('found_count');
      expect(context).not.toHaveProperty('claude_data_detected');
    });

    it('records each submission and completes once after a retry imports', async () => {
      const api = installApi(scan([candidate('alpha'), candidate('beta')]));
      api.importProjects
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({
          results: [
            result('alpha', { status: 'failed', workspaceId: undefined }),
            result('beta', { status: 'failed', workspaceId: undefined }),
          ],
        })
        .mockResolvedValueOnce({
          results: [
            result('alpha'),
            result('beta', { status: 'failed', workspaceId: undefined }),
          ],
        });
      await render();
      const submit = (): HTMLElement => byTestId('first-run-import-submit');

      await click(submit());
      await click(submit());
      expect(onDone).not.toHaveBeenCalled();
      expect(visitEnds()).toHaveLength(0);
      await click(submit());
      expect(onDone).toHaveBeenCalledTimes(1);

      const failures = calls(failOperation, 'canopy.project_import');
      expect(failures.map((call) => contextOf(call))).toEqual([
        expect.objectContaining({
          source: 'first_run',
          outcome: 'request_failed',
          selected_count: 2,
          failed_count: 2,
        }),
        expect.objectContaining({ outcome: 'none_imported', failed_count: 2 }),
      ]);
      const successes = calls(succeedOperation, 'canopy.project_import');
      expect(successes).toHaveLength(1);
      expect(contextOf(successes[0])).toEqual({
        source: 'first_run',
        scan_outcome: 'found',
        claude_data_detected: true,
        codex_data_detected: false,
        found_count: 2,
        found_claude_count: 2,
        found_codex_count: 0,
        claude_connection: 'not_connected',
        codex_connection: 'not_connected',
        picked_folder: false,
        outcome: 'partial',
        selected_count: 2,
        imported_count: 1,
        imported_claude_count: 1,
        imported_codex_count: 0,
        failed_count: 1,
        chats_imported_count: 0,
      });
      const submissionKeys = calls(startOperation, 'canopy.project_import').map(
        keyOf,
      );
      expect(new Set(submissionKeys).size).toBe(3);

      expect(visitEnds()).toHaveLength(1);
      expect(contextOf(visitEnds()[0])).toMatchObject({
        outcome: 'imported',
        imported_count: 1,
        submission_count: 3,
        failed_submission_count: 2,
      });
      expect(JSON.stringify(succeedOperation.mock.calls)).not.toMatch(
        /alpha|beta|scan-1|\/Users/,
      );
    });

    it('records a picked folder but not a canceled pick', async () => {
      const api = installApi(scan([]));
      api.pickFolder.mockResolvedValueOnce(null);
      await render();
      const choose = byTestId('first-run-import-choose-folder');
      await click(choose);
      await click(byTestId('first-run-import-skip'));
      expect(contextOf(visitEnds()[0])).toMatchObject({ picked_folder: false });
    });

    it('records a picked folder', async () => {
      const api = installApi(scan([]));
      api.pickFolder.mockResolvedValueOnce('/Users/me/picked');
      await render();
      await click(byTestId('first-run-import-choose-folder'));
      await click(byTestId('first-run-import-skip'));
      expect(contextOf(visitEnds()[0])).toMatchObject({ picked_folder: true });
    });

    it.each(['imported', 'failed'] as const)(
      'records a %s submission after unmount without inventing completion',
      async (status) => {
        const api = installApi(scan([candidate('alpha')]));
        let resolveImport: (
          value: ExternalProjectImportResponse,
        ) => void = () => undefined;
        api.importProjects.mockReturnValue(
          new Promise((resolve) => {
            resolveImport = resolve;
          }),
        );
        await render();
        await click(byTestId('first-run-import-submit'));
        act(() => {
          root.unmount();
        });
        root = createRoot(container);
        await act(async () => {
          resolveImport({
            results: [
              result('alpha', {
                status,
                ...(status === 'failed' ? { workspaceId: undefined } : {}),
              }),
            ],
          });
          await Promise.resolve();
        });
        await flush();

        expect(
          calls(
            status === 'failed' ? failOperation : succeedOperation,
            'canopy.project_import',
          ),
        ).toHaveLength(1);
        expect(visitEnds()).toHaveLength(0);
      },
    );

    it('submits only once for clicks in the same batch, then permits a retry', async () => {
      const api = installApi(scan([candidate('alpha')]));
      let resolveImport: (value: ExternalProjectImportResponse) => void = () =>
        undefined;
      api.importProjects.mockReturnValue(
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
      );
      await render();
      const submit = byTestId('first-run-import-submit');
      act(() => {
        submit.click();
        submit.click();
      });
      expect(api.importProjects).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveImport({
          results: [
            result('alpha', { status: 'failed', workspaceId: undefined }),
          ],
        });
        await Promise.resolve();
      });
      await flush();
      await click(submit);
      expect(api.importProjects).toHaveBeenCalledTimes(2);
    });
  });
});
