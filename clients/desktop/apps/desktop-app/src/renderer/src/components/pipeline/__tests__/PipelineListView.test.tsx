/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { PipelineListView } from '../PipelineListView';
import type { SharedCloudListState } from '../../../hooks/usePipelineList';
import { brandText } from '@/lib/brand';
import { useNavigationStore } from '@/stores/navigationStore';
import { setNativeInputValue } from '@/test-utils/dom';

import type { CuratedPipelinesController } from '../../../hooks/useCuratedPipelines';
import type { CuratedPipelineSummary } from '@canopy/protocol/pipeline-catalog';
const mockCurated: CuratedPipelinesController = {
  rows: [],
  query: {},
  onQueryChange: jest.fn(),
  loading: false,
  error: null,
  onRefresh: jest.fn(),
  onLoadMore: jest.fn(),
  onSelect: jest.fn(),
  onSelectKey: jest.fn(),
  onBack: jest.fn(),
  onImport: jest.fn(),
};
jest.mock('../../../hooks/useCuratedPipelines', () => ({
  useCuratedPipelines: (): CuratedPipelinesController => mockCurated,
}));
const curatedSummary: CuratedPipelineSummary = {
  key: 'pipeline-1',
  name: 'Curated review',
  shortDescription: 'Review library',
  icon: '',
  version: '1',
  triggerTypes: ['dispatch'],
  scopes: ['directory'],
  jobCount: 1,
  stepCount: 1,
  contentHash: 'a'.repeat(64),
  contentSizeBytes: 200,
  categories: ['development'],
  popular: false,
  sortOrder: 1,
  revision: 1,
  createdAt: '2026-09-10',
  updatedAt: '2026-09-10',
  authorName: null,
  authorUrl: null,
  docsUrl: null,
};

const resolveSharedPipelineUrl = jest.fn<
  Promise<string | null>,
  [sharePath: string]
>(
  (): Promise<string | null> =>
    Promise.resolve('https://cloud.example.test/share/pipelines/public-1'),
);
jest.mock('@/lib/share-links', () => ({
  resolveSharedPipelineUrl: (sharePath: string): Promise<string | null> =>
    resolveSharedPipelineUrl(sharePath),
}));

const copyTextToClipboard = jest.fn<Promise<boolean>, [value: string]>(
  (): Promise<boolean> => Promise.resolve(true),
);
jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (value: string): Promise<boolean> =>
    copyTextToClipboard(value),
}));

function makePipelineInfo(overrides: Partial<PipelineInfo> = {}): PipelineInfo {
  return {
    id: 'pipeline-1',
    name: 'Pipeline 1',
    filename: 'pipeline-1.yaml',
    description: '',
    icon: '',
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    source: 'user',
    readonly: false,
    ...overrides,
  };
}

function makeSharedState(): SharedCloudListState {
  return {
    cloudLoading: false,
    cloudAccount: {
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
    },
    loaded: false,
    loading: false,
    loadingMore: false,
    rows: [],
    nextCursor: null,
    error: null,
  };
}

/** Opens a shared dropdown and picks the option with this value. */
async function chooseOption(
  trigger: HTMLButtonElement,
  value: string,
): Promise<void> {
  await act(async () => {
    trigger.click();
    await Promise.resolve();
  });
  const option = document.querySelector<HTMLElement>(
    `[role="option"][data-value="${value}"]`,
  );
  if (!option) throw new Error(`Missing option ${value}`);
  await act(async () => {
    option.click();
    await Promise.resolve();
  });
}

describe('PipelineListView', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    mockCurated.rows = [];
    mockCurated.query = {};
    mockCurated.error = null;
    mockCurated.loading = false;
    mockCurated.stale = false;
    mockCurated.nextCursor = null;
    useNavigationStore.setState({
      pendingCuratedPipelinePreviewKey: undefined,
    });
    jest.clearAllMocks();
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

  it('treats missing triggerTypes as supporting trigger filters', async (): Promise<void> => {
    await act(async () => {
      root.render(
        <PipelineListView
          pipelines={[
            makePipelineInfo({
              id: 'implicit-triggers',
              name: 'Implicit triggers',
            }),
            makePipelineInfo({
              id: 'plan-only',
              name: 'Plan only',
              triggerTypes: ['plan_ready'],
            }),
          ]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    const triggerFilter = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-trigger-filter"]',
    );
    expect(triggerFilter).not.toBeNull();
    if (!triggerFilter) {
      throw new Error('Expected trigger filter select to render');
    }

    await chooseOption(triggerFilter, 'dispatch');

    expect(container.textContent).toContain('Implicit triggers');
    expect(container.textContent).not.toContain('Plan only');
  });

  it('starts the interview from the main action and builds manually from the chevron menu (CAN-3487)', async (): Promise<void> => {
    const onCreateNew = jest.fn();
    const onStartInterview = jest.fn();
    await act(async () => {
      root.render(
        <PipelineListView
          pipelines={[makePipelineInfo()]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={onCreateNew}
          onStartInterview={onStartInterview}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    const main = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-create-new"]',
    );
    expect(main?.textContent).toBe('New workflow');
    await act(async () => {
      main?.click();
      await Promise.resolve();
    });
    expect(onStartInterview).toHaveBeenCalledTimes(1);
    expect(onCreateNew).not.toHaveBeenCalled();

    const chevron = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-create-new-menu"]',
    );
    expect(chevron?.getAttribute('aria-expanded')).toBe('false');
    expect(
      document.querySelector('[data-testid="pipeline-create-new-manual"]'),
    ).toBeNull();
    await act(async () => {
      chevron?.click();
      await Promise.resolve();
    });
    expect(chevron?.getAttribute('aria-expanded')).toBe('true');
    const manual = document.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-create-new-manual"]',
    );
    expect(manual?.textContent).toBe('Build manually');
    await act(async () => {
      manual?.click();
      await Promise.resolve();
    });
    expect(onCreateNew).toHaveBeenCalledTimes(1);
    expect(onStartInterview).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="pipeline-create-new-manual"]'),
    ).toBeNull();
  });

  it('disables the split action while the chat is being created', async (): Promise<void> => {
    await act(async () => {
      root.render(
        <PipelineListView
          pipelines={[]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          interviewPending={true}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    for (const testId of ['pipeline-create-new', 'pipeline-empty-create-new']) {
      const main = container.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
      expect(main?.disabled).toBe(true);
      expect(
        container.querySelector<HTMLButtonElement>(
          `[data-testid="${testId}-menu"]`,
        )?.disabled,
      ).toBe(true);
    }
  });

  it('renders actionError in a notice and omits it when null', async (): Promise<void> => {
    const baseProps = {
      pipelines: [makePipelineInfo({ id: 'p-1', name: 'Row one' })],
      loading: false,
      error: null,
      onRefresh: jest.fn(() => Promise.resolve()),
      onCreateNew: jest.fn(),
      onStartInterview: jest.fn(),
      onEdit: jest.fn(),
      onDelete: jest.fn(() => Promise.resolve()),
      onDuplicate: jest.fn(() => Promise.resolve()),
      disabledPipelineIds: new Set<string>(),
      onToggleEnabled: jest.fn(() => Promise.resolve()),
      sharedState: makeSharedState(),
      onSharedActivate: jest.fn(),
      onSharedRefresh: jest.fn(() => Promise.resolve()),
      onLoadMoreShared: jest.fn(() => Promise.resolve()),
      onSharedFilterChange: jest.fn(),
      onSharedDelete: jest.fn(() => Promise.resolve()),
      onOpenAccountSettings: jest.fn(),
    };

    await act(async () => {
      root.render(<PipelineListView {...baseProps} actionError={null} />);
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="pipeline-list-action-error"]'),
    ).toBeNull();

    await act(async () => {
      root.render(
        <PipelineListView
          {...baseProps}
          actionError="This shared pipeline is missing its remote id"
        />,
      );
      await Promise.resolve();
    });

    const notice = container.querySelector(
      '[data-testid="pipeline-list-action-error"]',
    );
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(
      'This shared pipeline is missing its remote id',
    );
    // The rows must survive the error so the user can retry the action.
    expect(container.textContent).toContain('Row one');
  });

  it('consumes an App Advisor curated preview deep link after navigation', async () => {
    const sharedState = makeSharedState();
    sharedState.cloudAccount = {
      hasApiKey: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: [],
      storageAvailable: true,
      account: {
        id: 'account-1',
        name: 'Test User',
        email: 'test@example.com',
        role: 'DEVELOPER',
      },
    };
    useNavigationStore.getState().openCuratedPipelinePreview('review-code');

    await act(() => {
      root.render(
        <PipelineListView
          pipelines={[]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={sharedState}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      return Promise.resolve();
    });

    expect(mockCurated.onSelectKey).toHaveBeenCalledWith('review-code');
    expect(
      useNavigationStore.getState().pendingCuratedPipelinePreviewKey,
    ).toBeUndefined();
  });

  it('routes search and trigger filters to the shared pipeline list', async (): Promise<void> => {
    const onSharedFilterChange = jest.fn();
    await act(async () => {
      root.render(
        <PipelineListView
          pipelines={[makePipelineInfo()]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={onSharedFilterChange}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    const searchInput = container.querySelector<HTMLInputElement>(
      '[data-testid="pipeline-search"]',
    );
    const triggerFilter = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-trigger-filter"]',
    );
    expect(searchInput).not.toBeNull();
    expect(triggerFilter).not.toBeNull();
    if (!searchInput || !triggerFilter) {
      throw new Error('Expected pipeline filter controls to render');
    }

    await act(async () => {
      const valueDescriptor = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      );
      if (!valueDescriptor?.set) {
        throw new Error('Expected HTMLInputElement value setter');
      }
      valueDescriptor.set.call(searchInput, 'shared deploy');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await chooseOption(triggerFilter, 'plan_ready');

    expect(onSharedFilterChange).toHaveBeenLastCalledWith({
      q: 'shared deploy',
      triggerType: 'plan_ready',
    });
  });

  it('shows execution scopes in a dedicated column with directory as the legacy fallback', async (): Promise<void> => {
    await act(async () => {
      root.render(
        <PipelineListView
          pipelines={[
            makePipelineInfo({
              id: 'worktree-pipeline',
              name: 'Worktree pipeline',
              scopes: ['worktree'],
            }),
            makePipelineInfo({
              id: 'legacy-pipeline',
              name: 'Legacy pipeline',
            }),
          ]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    const headers = Array.from(container.querySelectorAll('th')).map((header) =>
      header.textContent?.trim(),
    );
    expect(headers.slice(1, 4)).toEqual(['Source', 'Scope', 'Triggers']);

    expect(
      container.querySelector(
        '[data-testid="pipeline-scope-worktree-pipeline"]',
      )?.textContent,
    ).toContain('Worktree');
    expect(
      container.querySelector('[data-testid="pipeline-scope-legacy-pipeline"]')
        ?.textContent,
    ).toContain('Directory');
  });

  it('uses trigger-style tooltip handling for execution scope chips', async (): Promise<void> => {
    await act(async () => {
      root.render(
        <PipelineListView
          pipelines={[
            makePipelineInfo({
              id: 'worktree-pipeline',
              name: 'Worktree pipeline',
              scopes: ['worktree'],
            }),
          ]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    const scopeCell = container.querySelector(
      '[data-testid="pipeline-scope-worktree-pipeline"]',
    );
    const scopeButton = scopeCell?.querySelector('button');
    // The shared tooltip renders into a portal once the badge is hovered.
    act(() => {
      scopeButton?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');

    expect(scopeButton?.className).not.toContain('cursor-help');
    expect(scopeButton?.getAttribute('aria-describedby')).toBe(
      tooltip?.getAttribute('id'),
    );
    expect(scopeButton?.getAttribute('aria-label')).toBe(
      `Worktree: Runs against a ${brandText.appName} project worktree.`,
    );
    expect(tooltip?.textContent).toContain(
      `Runs against a ${brandText.appName} project worktree.`,
    );
  });

  it('shows copy link only for rows with public share metadata', async () => {
    await act(async () => {
      root.render(
        <PipelineListView
          pipelines={[
            makePipelineInfo({ id: 'local', source: 'user' }),
            makePipelineInfo({
              id: 'shared',
              source: 'shared',
              readonly: true,
              publicShare: {
                externalId: 'public-1',
                pinnedContentHash: 'sha256:abc',
                upToDate: true,
                sharePath: '/share/pipelines/public-1',
                createdAt: '2026-06-18T00:00:00.000Z',
                updatedAt: '2026-06-18T00:00:00.000Z',
              },
            }),
          ]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={new Set()}
          onToggleEnabled={jest.fn(() => Promise.resolve())}
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="pipeline-copy-link-shared"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pipeline-copy-link-local"]'),
    ).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="pipeline-copy-link-shared"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'https://cloud.example.test/share/pipelines/public-1',
    );
  });
  it('keeps owned pipelines ahead of a compact template section even during a local refresh failure', async () => {
    mockCurated.rows = [curatedSummary];
    mockCurated.error = 'Later page unavailable';
    mockCurated.stale = true;
    mockCurated.nextCursor = 'next';
    const onEdit = jest.fn();
    const onDuplicate = jest.fn(() => Promise.resolve());
    const onToggleEnabled = jest.fn(() => Promise.resolve());
    const sharedState = makeSharedState();
    sharedState.rows = [
      makePipelineInfo({
        id: 'curated:pipeline-1',
        source: 'shared',
        name: 'Shared review',
        triggerTypes: ['plan_ready'],
        scopes: ['worktree'],
      }),
    ];
    await act(async () => {
      await Promise.resolve();
      root.render(
        <PipelineListView
          pipelines={[
            makePipelineInfo({ name: 'Local review', scopes: ['worktree'] }),
          ]}
          loading={true}
          error="Local refresh failed"
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={onEdit}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={onDuplicate}
          disabledPipelineIds={new Set()}
          onToggleEnabled={onToggleEnabled}
          sharedState={sharedState}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
    });
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.textContent).toContain('2 loaded workflows');
    expect(
      container.querySelector(
        '[data-testid="pipeline-row-curated:pipeline-1"]',
      ),
    ).toBeNull();
    const table = container.querySelector('[data-testid="pipelines-table"]');
    const templates = container.querySelector(
      '[data-testid="pipeline-templates-section"]',
    );
    expect(templates).not.toBeNull();
    expect(table?.compareDocumentPosition(templates ?? container)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      container.querySelector('[data-testid="curated-pipeline-search"]'),
    ).toBeNull();
    const useTemplate = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-template-use-pipeline-1"]',
    );
    act(() => {
      useTemplate?.click();
    });
    expect(mockCurated.onSelect).toHaveBeenCalledWith(curatedSummary);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onToggleEnabled).not.toHaveBeenCalled();
    expect(onDuplicate).not.toHaveBeenCalled();
  });

  function renderTemplates(
    overrides: Partial<{
      disabledPipelineIds: Set<string>;
      onToggleEnabled: (id: string, enabled: boolean) => Promise<void>;
    }> = {},
  ): void {
    act(() => {
      root.render(
        <PipelineListView
          pipelines={[makePipelineInfo({ name: 'Local review' })]}
          loading={false}
          error={null}
          onRefresh={jest.fn(() => Promise.resolve())}
          onCreateNew={jest.fn()}
          onStartInterview={jest.fn()}
          onEdit={jest.fn()}
          onDelete={jest.fn(() => Promise.resolve())}
          onDuplicate={jest.fn(() => Promise.resolve())}
          disabledPipelineIds={overrides.disabledPipelineIds ?? new Set()}
          onToggleEnabled={
            overrides.onToggleEnabled ?? jest.fn(() => Promise.resolve())
          }
          sharedState={makeSharedState()}
          onSharedActivate={jest.fn()}
          onSharedRefresh={jest.fn(() => Promise.resolve())}
          onLoadMoreShared={jest.fn(() => Promise.resolve())}
          onSharedFilterChange={jest.fn()}
          onSharedDelete={jest.fn(() => Promise.resolve())}
          onOpenAccountSettings={jest.fn()}
        />,
      );
    });
  }

  function catalogRowNames(): string[] {
    return Array.from(
      document.querySelectorAll('[data-testid="curated-pipeline-rows"] > li'),
    ).map((row) => row.textContent ?? '');
  }

  it('narrows the full loaded template catalog by its search, case-insensitively', () => {
    mockCurated.rows = [
      curatedSummary,
      {
        ...curatedSummary,
        key: 'deploy-service',
        name: 'Deploy service',
        shortDescription: 'Ship a release',
      },
      {
        ...curatedSummary,
        key: 'nightly-audit',
        name: 'Nightly',
        shortDescription: 'Check dependencies',
      },
    ];
    renderTemplates();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="pipeline-templates-view-all"]',
        )
        ?.click();
    });
    const rows = (): number =>
      document.querySelectorAll('[data-testid="curated-pipeline-rows"] > li')
        .length;
    // An empty search keeps every template in catalog order.
    expect(rows()).toBe(3);
    expect(catalogRowNames().join('|')).toMatch(
      /Curated review.*Deploy service.*Nightly/,
    );
    const search = (value: string): void => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="curated-pipeline-search"]',
      );
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    search('DEPLOY');
    expect(rows()).toBe(1);
    expect(
      document.querySelector('[data-testid="curated-pipeline-rows"]')
        ?.textContent,
    ).toContain('Deploy service');
    // The key matches as well as the name and description.
    search('nightly-audit');
    expect(rows()).toBe(1);
    search('release');
    expect(rows()).toBe(1);
  });

  it('keeps spaces typed one key at a time into the template search', () => {
    mockCurated.rows = [
      curatedSummary,
      {
        ...curatedSummary,
        key: 'deploy-service',
        name: 'Deploy service',
        shortDescription: 'Ship a release',
      },
    ];
    // The hook reports the trimmed query, as `useCuratedPipelines` does.
    mockCurated.query = { limit: 25 };
    renderTemplates();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="pipeline-templates-view-all"]',
        )
        ?.click();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="curated-pipeline-search"]',
    );
    if (!input) throw new Error('Missing template search');
    for (const character of 'deploy ser') {
      act(() => {
        setNativeInputValue(input, `${input.value}${character}`);
      });
    }
    expect(input.value).toBe('deploy ser');
    expect(
      document.querySelectorAll('[data-testid="curated-pipeline-rows"] > li'),
    ).toHaveLength(1);
  });

  it('re-enables a disabled template from its preview through the pipeline preference', async () => {
    const onToggleEnabled = jest.fn(() => Promise.resolve());
    mockCurated.rows = [curatedSummary];
    mockCurated.selectedKey = 'pipeline-1';
    try {
      renderTemplates({
        disabledPipelineIds: new Set(['curated:pipeline-1']),
        onToggleEnabled,
      });
      const availability = document.querySelector(
        '[data-testid="curated-pipeline-availability"]',
      );
      expect(availability?.textContent).toContain('Disabled');
      const toggle = document.querySelector<HTMLButtonElement>(
        '[data-testid="curated-pipeline-toggle-enabled"]',
      );
      expect(toggle?.textContent).toBe('Enable workflow');
      await act(() => Promise.resolve(toggle?.click()));
      expect(onToggleEnabled).toHaveBeenCalledWith('curated:pipeline-1', true);

      renderTemplates({ onToggleEnabled });
      const enabledToggle = document.querySelector<HTMLButtonElement>(
        '[data-testid="curated-pipeline-toggle-enabled"]',
      );
      expect(enabledToggle?.textContent).toBe('Disable workflow');
      await act(() => Promise.resolve(enabledToggle?.click()));
      expect(onToggleEnabled).toHaveBeenLastCalledWith(
        'curated:pipeline-1',
        false,
      );
    } finally {
      mockCurated.selectedKey = null;
    }
  });
});
