/**
 * @jest-environment jsdom
 */
import type * as UiSharedComponents from '@canopy/ui-shared/components';
jest.mock('@canopy/ui-shared/components', () => ({
  Button: jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  ).Button,
  SegmentedControl: jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  ).SegmentedControl,
  ActionTooltip: ({
    children,
  }: {
    children: React.ReactNode;
  }): React.ReactNode => children,
  DialogModal: ({
    children,
    title,
    headerActions,
  }: {
    children: React.ReactNode;
    title: string;
    headerActions?: React.ReactNode;
  }): JSX.Element => (
    <div role="dialog" aria-label={title}>
      {headerActions}
      {children}
    </div>
  ),
  LoadingSpinner: (): JSX.Element => <span data-testid="loading-spinner" />,
  // Render the trigger bare; positioning/portaling is irrelevant to these tests.
  RichHoverTooltip: ({
    children,
  }: {
    children: React.ReactNode;
  }): React.ReactNode => children,
  Tooltip: ({ children }: { children: React.ReactNode }): React.ReactNode =>
    children,
}));

jest.mock('@canopy/ui-shared/icons', () => ({
  TriggerIcon: (): JSX.Element => <span data-testid="trigger-icon" />,
  WatcherEyeIcon: (): JSX.Element => <span data-testid="watcher-eye-icon" />,
  AppAdvisorIcon: (): JSX.Element => <span data-testid="app-advisor-icon" />,
  ChatIcon: (): JSX.Element => <span data-testid="chat-icon" />,
  ChevronIcon: (): JSX.Element => <span data-testid="chevron-icon" />,
  AssignmentIcon: (): JSX.Element => <span data-testid="assignment-icon" />,
  AssignmentAddIcon: (): JSX.Element => (
    <span data-testid="assignment-add-icon" />
  ),
}));

const mockSharedListState: Record<string, unknown> = {
  cloudAccount: null,
  cloudLoading: false,
  rows: [],
  loading: false,
  loadingMore: false,
  nextCursor: null,
  error: null,
  loaded: false,
  refreshShared: jest.fn(),
  loadMoreShared: jest.fn(),
  setFilters: jest.fn(),
  removeSharedRow: jest.fn(),
};

jest.mock('@/hooks/useSharedPipelineList', () => ({
  useSharedPipelineList: (): Record<string, unknown> => mockSharedListState,
}));

jest.mock('@/hooks/useSkillList', () => ({
  useSkillList: (): { skills: never[]; refresh: jest.Mock } => ({
    skills: [],
    refresh: jest.fn(),
  }),
}));

jest.mock('@/hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): { cache: null; refresh: jest.Mock } => ({
    cache: null,
    refresh: jest.fn(),
  }),
}));

jest.mock('@/hooks/useCollectionList', () => ({
  useCollectionList: (): { collections: never[]; refresh: jest.Mock } => ({
    collections: [],
    refresh: jest.fn(),
  }),
}));

jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: (
    selector: (state: { openSettings: jest.Mock }) => unknown,
  ): unknown => selector({ openSettings: jest.fn() }),
}));

jest.mock('../PipelinePluginCollectionsSection', () => ({
  PipelinePluginCollectionsSection: ({
    onPreferencesChange,
  }: {
    onPreferencesChange: (collectionId: string, next: unknown) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-toggle-plugin-selection"
      onClick={(): void =>
        onPreferencesChange('default_plugins', {
          disabledDefaultKeys: ['some-default'],
          extraSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        })
      }
    />
  ),
}));

// Render the model-alias base picker as a plain button (the real ModelPicker
// portals an anchored menu that is irrelevant to these tests).
jest.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: ({
    currentModel,
    onModelChange,
  }: {
    currentModel: string;
    onModelChange: (model: string) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-model-picker"
      data-current={currentModel}
      onClick={(): void => onModelChange('claude-sonnet-4-6')}
    />
  ),
}));

import { act, type ComponentProps, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelineData,
  PipelineExecutionScope,
  PipelineInfo,
  ResolvePluginCollectionsResponse,
} from '@canopy/desktop-shared/types/pipeline';
import {
  initAgentModels,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import { PipelineTriggerModal } from '../PipelineTriggerModal';
import { stableStringify } from '../pipelineTriggerModalUtils';
import type { PipelineModelAlias } from '@canopy/desktop-shared/types/pipeline';
import { useAgentsStore } from '@/stores/agentsStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error('Expected deferred handlers to be initialized');
  }
  return { promise, resolve, reject };
}

function pipelineInfo(id = 'collection-pipeline'): PipelineInfo {
  return {
    id,
    name: 'Collection pipeline',
    filename: `${id}.yml`,
    description: 'Uses plugin collections',
    icon: '',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    triggerTypes: ['dispatch'],
    source: 'user',
    readonly: false,
  };
}

function pipelineData(info = pipelineInfo()): PipelineData {
  return {
    info,
    content: {
      name: info.name,
      description: info.description,
      icon: info.icon,
      on: 'dispatch',
      plugin_collections: [
        {
          id: 'default_plugins',
          name: 'Default plugins',
          defaults: [],
        },
      ],
      jobs: {
        test: {
          steps: [],
        },
      },
    },
  };
}

function renderModal(): { container: HTMLDivElement; cleanup: () => void } {
  return renderModalWithProps({});
}

function renderModalWithProps(
  props: Partial<ComponentProps<typeof PipelineTriggerModal>>,
): { container: HTMLDivElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <PipelineTriggerModal
        triggerType="dispatch"
        labels={{
          title: 'Dispatch pipeline',
          selectSubtitle: 'Select a pipeline with dispatch trigger',
          emptyMessage: 'No pipelines with dispatch trigger found',
        }}
        onClose={jest.fn()}
        onRun={jest.fn()}
        {...props}
      />,
    );
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getRunButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(
    '[data-testid="pipeline-trigger-modal-run"]',
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Expected run control to be an HTMLButtonElement');
  }
  return button;
}

function getPipelineRowButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(
    '[data-testid="pipeline-trigger-modal-selector"] button',
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Expected pipeline row control to be an HTMLButtonElement');
  }
  return button;
}

function querySaveDefaultsButton(
  container: HTMLElement,
): HTMLButtonElement | null {
  const button = container.querySelector(
    '[data-testid="pipeline-trigger-modal-save-defaults"]',
  );
  return button instanceof HTMLButtonElement ? button : null;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

function getButtonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

describe('PipelineTriggerModal', () => {
  const data = pipelineData();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockSharedListState, {
      cloudAccount: null,
      cloudLoading: false,
      rows: [],
      loading: false,
      loadingMore: false,
      nextCursor: null,
      error: null,
      loaded: false,
      refreshShared: jest.fn(),
      loadMoreShared: jest.fn(),
      setFilters: jest.fn(),
      removeSharedRow: jest.fn(),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({}),
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        list: jest.fn().mockResolvedValue({ success: true, data: [data.info] }),
        discoverProject: jest
          .fn()
          .mockResolvedValue({ success: true, data: [] }),
        get: jest.fn().mockResolvedValue({ success: true, data }),
        resolvePluginCollections: jest.fn(),
        savePluginCollectionPreferences: jest.fn(),
      },
    });
  });

  it.each(['dispatch', 'task_ready', 'plan_ready'] as const)(
    'lists undownloaded curated %s metadata and fetches only the selected definition',
    async (triggerType) => {
      const curated = pipelineData();
      curated.info = {
        ...curated.info,
        id: 'curated:review',
        name: 'Curated workflow',
        source: 'curated',
        readonly: true,
        triggerTypes: [triggerType],
        scopes: ['directory'],
      };
      curated.content = {
        name: 'Curated workflow',
        on: triggerType,
        jobs: { review: { steps: [{ run: 'echo reviewed' }] } },
      };
      window.pipelines.list = jest
        .fn()
        .mockResolvedValue({ success: true, data: [curated.info] });
      const get = jest.fn().mockResolvedValue({ success: true, data: curated });
      window.pipelines.get = get;
      const { container, cleanup } = renderModalWithProps({
        triggerType,
        executionScope: 'worktree',
      });
      try {
        await flushAsync();
        expect(container.textContent).toContain('Curated workflow');
        expect(get).not.toHaveBeenCalled();
        const row = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent?.includes('Curated workflow'),
        );
        if (!row) throw new Error('Missing curated row');
        await click(row);
        await flushAsync();
        expect(get).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledWith({
          source: 'curated',
          id: 'curated:review',
        });
        expect(getRunButton(container).disabled).toBe(false);
      } finally {
        cleanup();
      }
    },
  );

  it('hydrates only an explicitly preselected curated pipeline without running it', async () => {
    const curated = pipelineData();
    curated.info = {
      ...curated.info,
      id: 'curated:review',
      source: 'curated',
      readonly: true,
      triggerTypes: ['dispatch'],
    };
    curated.content = {
      name: 'Curated workflow',
      on: 'dispatch',
      jobs: { review: { steps: [{ run: 'echo reviewed' }] } },
    };
    window.pipelines.list = jest.fn().mockResolvedValue({
      success: true,
      data: [curated.info, { ...curated.info, id: 'curated:other' }],
    });
    const get = jest.fn().mockResolvedValue({ success: true, data: curated });
    window.pipelines.get = get;
    const onRun = jest.fn();
    const { container, cleanup } = renderModalWithProps({
      initialPipelineId: 'curated:review',
      onRun,
    });
    try {
      await flushAsync();
      expect(get).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith({
        source: 'curated',
        id: 'curated:review',
      });
      expect(getRunButton(container).disabled).toBe(false);
      expect(onRun).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('keeps a newer local selection when an earlier curated download finishes', async () => {
    const local = pipelineData();
    local.info = { ...local.info, id: 'local-review', name: 'Local review' };
    local.content = {
      name: 'Local review',
      on: 'dispatch',
      jobs: { review: { steps: [{ run: 'echo local' }] } },
    };
    const curated = {
      ...local,
      info: {
        ...local.info,
        id: 'curated:review',
        name: 'Curated workflow',
        source: 'curated' as const,
        readonly: true,
        triggerTypes: ['dispatch' as const],
      },
    };
    let finish:
      | ((value: { success: true; data: PipelineData }) => void)
      | undefined;
    window.pipelines.list = jest
      .fn()
      .mockResolvedValue({ success: true, data: [local.info, curated.info] });
    window.pipelines.get = jest.fn((lookup) =>
      typeof lookup === 'object' &&
      'source' in lookup &&
      lookup.source === 'curated'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ success: true, data: local }),
    );
    const onRun = jest.fn().mockResolvedValue(undefined);
    const { container, cleanup } = renderModalWithProps({ onRun });
    try {
      await flushAsync();
      const buttons = Array.from(container.querySelectorAll('button'));
      const curatedRow = buttons.find((button) =>
        button.textContent?.includes('Curated workflow'),
      );
      const localRow = buttons.find((button) =>
        button.textContent?.includes('Local review'),
      );
      if (!curatedRow || !localRow)
        throw new Error('Expected curated and local rows');
      await click(curatedRow);
      await click(localRow);
      await act(async () => {
        finish?.({ success: true, data: curated });
        await Promise.resolve();
      });
      await flushAsync();
      await click(getRunButton(container));
      expect(onRun).toHaveBeenCalledWith(
        'local-review',
        local,
        undefined,
        undefined,
        expect.anything(),
      );
    } finally {
      cleanup();
    }
  });

  it('preselects initialPipelineId once the list loads without auto-advancing', async () => {
    window.pipelines.resolvePluginCollections = jest.fn().mockResolvedValue({
      success: true,
      data: {
        previewItems: [],
        effectivePreferences: {},
        validation: { hasBlockingErrors: false, messages: [] },
      },
    });
    const onRun = jest.fn();
    const rendered = renderModalWithProps({
      initialPipelineId: 'collection-pipeline',
      onRun,
    });
    await flushAsync();

    // Preselect only: the row is highlighted, the select step is still
    // showing, and nothing has run (Continue auto-runs input-less pipelines,
    // so auto-advancing would violate the never-auto-executes contract).
    expect(getPipelineRowButton(rendered.container).className).toContain(
      'ring-line-accent',
    );
    expect(onRun).not.toHaveBeenCalled();
    rendered.cleanup();
  });

  it('ignores an initialPipelineId that is not in the loaded list', async () => {
    const rendered = renderModalWithProps({
      initialPipelineId: 'not-a-listed-pipeline',
    });
    await flushAsync();

    expect(getPipelineRowButton(rendered.container).className).not.toContain(
      'ring-line-accent',
    );
    rendered.cleanup();
  });

  it('loads and gates readiness for a shared packaged pipeline', async () => {
    const sharedInfo: PipelineInfo = {
      ...pipelineInfo('shared:canopy-cloud:remote-ready'),
      id: 'shared:canopy-cloud:remote-ready',
      name: 'Shared package',
      source: 'shared',
      readonly: true,
      remoteId: 'remote-ready',
      serverId: 'canopy-cloud',
      scopes: ['directory'],
    };
    Object.assign(mockSharedListState, {
      cloudAccount: {
        hasApiKey: true,
        account: { id: 'account-1', email: 'user@example.com' },
      },
      rows: [sharedInfo],
      loaded: true,
    });
    window.pipelines.list = jest
      .fn()
      .mockResolvedValue({ success: true, data: [] });
    window.pipelines.getShared = jest.fn().mockResolvedValue({
      success: true,
      data: {
        id: 'remote-ready',
        name: 'Shared package',
        description: '',
        icon: '',
        version: '1.0.0',
        triggerTypes: ['dispatch'],
        scopes: ['directory'],
        createdBy: { id: 'user-1', name: 'Alice' },
        createdAt: '2026-08-30T12:00:00.000Z',
        updatedAt: '2026-08-30T12:00:00.000Z',
        canUpdate: false,
        canDelete: false,
        rawPipeline: 'name: Shared package\non: dispatch\njobs: {}\n',
        distributionMode: 'package',
      },
    });
    const getPackageReadiness = jest.fn().mockResolvedValue({
      success: true,
      data: {
        status: 'setup_required',
        requirements: [
          {
            id: 'github',
            kind: 'connector',
            displayName: 'GitHub',
            required: true,
            affectedSteps: [],
            setupHint: 'Connect GitHub.',
            status: 'missing',
            detail: 'GitHub is not connected.',
          },
        ],
      },
    });
    window.pipelines.getPackageReadiness = getPackageReadiness;

    const rendered = renderModal();
    await flushAsync();
    await click(getButtonByText(rendered.container, 'Shared'));
    const sharedRow = rendered.container.querySelector(
      '[data-testid="pipeline-trigger-modal-shared-selector"] button',
    );
    if (!(sharedRow instanceof HTMLButtonElement)) {
      throw new Error('Expected shared pipeline row');
    }
    await click(sharedRow);
    await flushAsync();

    expect(getPackageReadiness).toHaveBeenCalledWith({
      pipeline: { source: 'shared', remoteId: 'remote-ready' },
    });
    expect(getRunButton(rendered.container).textContent).toContain('Continue');
    await click(getRunButton(rendered.container));
    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-trigger-modal-package-readiness"]',
      ),
    ).not.toBeNull();
    expect(getRunButton(rendered.container).disabled).toBe(true);
    rendered.cleanup();
  });

  it('does not gate a definition-only shared pipeline on package readiness', async () => {
    // Main reports `invalid` readiness for every non-package share, and
    // `runPipeline` deliberately skips the gate for them (CAN-3021). The modal
    // must agree, or a plain shared pipeline can never be run.
    const sharedInfo: PipelineInfo = {
      ...pipelineInfo('shared:canopy-cloud:remote-definition'),
      id: 'shared:canopy-cloud:remote-definition',
      name: 'Shared definition',
      source: 'shared',
      readonly: true,
      remoteId: 'remote-definition',
      serverId: 'canopy-cloud',
      scopes: ['directory'],
    };
    Object.assign(mockSharedListState, {
      cloudAccount: {
        hasApiKey: true,
        account: { id: 'account-1', email: 'user@example.com' },
      },
      rows: [sharedInfo],
      loaded: true,
    });
    window.pipelines.list = jest
      .fn()
      .mockResolvedValue({ success: true, data: [] });
    window.pipelines.getShared = jest.fn().mockResolvedValue({
      success: true,
      data: {
        id: 'remote-definition',
        name: 'Shared definition',
        description: '',
        icon: '',
        version: '1.0.0',
        triggerTypes: ['dispatch'],
        scopes: ['directory'],
        createdBy: { id: 'user-1', name: 'Alice' },
        createdAt: '2026-08-30T12:00:00.000Z',
        updatedAt: '2026-08-30T12:00:00.000Z',
        canUpdate: true,
        canDelete: true,
        rawPipeline: 'name: Shared definition\non: dispatch\njobs: {}\n',
        distributionMode: 'definition_only',
      },
    });
    const getPackageReadiness = jest.fn().mockResolvedValue({
      success: true,
      data: {
        status: 'invalid',
        distributionMode: 'definition_only',
        requirements: [],
      },
    });
    window.pipelines.getPackageReadiness = getPackageReadiness;

    const rendered = renderModal();
    await flushAsync();
    await click(getButtonByText(rendered.container, 'Shared'));
    const sharedRow = rendered.container.querySelector(
      '[data-testid="pipeline-trigger-modal-shared-selector"] button',
    );
    if (!(sharedRow instanceof HTMLButtonElement)) {
      throw new Error('Expected shared pipeline row');
    }
    await click(sharedRow);
    await flushAsync();

    expect(getPackageReadiness).not.toHaveBeenCalled();
    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-trigger-modal-setup-blocking"]',
      ),
    ).toBeNull();
    await click(getRunButton(rendered.container));
    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-trigger-modal-setup-blocking"]',
      ),
    ).toBeNull();
    expect(getRunButton(rendered.container).disabled).toBe(false);
    rendered.cleanup();
  });

  it('shows missing packaged content and blocks a local definition-only install', async () => {
    window.pipelines.getPackageReadiness = jest.fn().mockResolvedValue({
      success: true,
      data: {
        status: 'invalid',
        distributionMode: 'definition_only',
        requirements: [],
      },
    });

    const rendered = renderModal();
    await flushAsync();
    await click(getPipelineRowButton(rendered.container));
    await flushAsync();
    await click(getRunButton(rendered.container));

    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-trigger-modal-definition-only-note"]',
      ),
    ).not.toBeNull();
    expect(getRunButton(rendered.container).disabled).toBe(true);
    rendered.cleanup();
  });

  it('offers the project root alongside child repo working directories', async () => {
    const rendered = renderModalWithProps({
      repoChoices: [
        {
          repoId: WORKSPACE_ROOT_REPO_ID,
          repoName: WORKSPACE_ROOT_REPO_NAME,
        },
        { repoId: 'app', repoName: 'App' },
        { repoId: 'api', repoName: 'API' },
      ],
    });

    await flushAsync();

    const select = rendered.container.querySelector<HTMLSelectElement>(
      '#pipeline-trigger-modal-repo',
    );
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect(
      Array.from(select?.querySelectorAll('option') ?? []).map((option) => ({
        value: option.value,
        label: option.textContent,
      })),
    ).toEqual([
      {
        value: WORKSPACE_ROOT_REPO_ID,
        label: WORKSPACE_ROOT_REPO_NAME,
      },
      { value: 'app', label: 'App' },
      { value: 'api', label: 'API' },
    ]);
    expect(select?.value).toBe(WORKSPACE_ROOT_REPO_ID);

    rendered.cleanup();
  });

  it('reports the initial and changed working directory', async () => {
    const onRepoChange = jest.fn();
    const rendered = renderModalWithProps({
      repoChoices: [
        { repoId: 'app', repoName: 'App' },
        { repoId: 'api', repoName: 'API' },
      ],
      onRepoChange,
    });

    await flushAsync();
    expect(onRepoChange).toHaveBeenLastCalledWith('app');

    const select = rendered.container.querySelector<HTMLSelectElement>(
      '#pipeline-trigger-modal-repo',
    );
    if (!select) throw new Error('No working directory select');
    act(() => {
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onRepoChange).toHaveBeenLastCalledWith('api');

    rendered.cleanup();
  });

  it('enables Continue when plugin collection preferences finish loading', async () => {
    const deferred = createDeferred<{
      success: true;
      data: ResolvePluginCollectionsResponse;
    }>();
    window.pipelines.resolvePluginCollections = jest
      .fn()
      .mockReturnValue(deferred.promise);
    const rendered = renderModal();

    await flushAsync();
    await click(getPipelineRowButton(rendered.container));
    expect(getRunButton(rendered.container).disabled).toBe(true);

    await act(async () => {
      deferred.resolve({
        success: true,
        data: {
          previewItems: [],
          effectivePreferences: {},
          validation: { hasBlockingErrors: false, messages: [] },
        },
      });
      await deferred.promise;
    });

    expect(getRunButton(rendered.container).disabled).toBe(false);
    rendered.cleanup();
  });

  it('does not leave Continue permanently disabled when collection preference loading fails', async () => {
    const deferred = createDeferred<{ success: false; error: string }>();
    window.pipelines.resolvePluginCollections = jest
      .fn()
      .mockReturnValue(deferred.promise);
    const rendered = renderModal();

    await flushAsync();
    await click(getPipelineRowButton(rendered.container));
    expect(getRunButton(rendered.container).disabled).toBe(true);

    await act(async () => {
      deferred.resolve({
        success: false,
        error: 'Preference store unavailable',
      });
      await deferred.promise;
    });

    const continueButton = getRunButton(rendered.container);
    expect(continueButton.disabled).toBe(false);
    await click(continueButton);
    expect(rendered.container.textContent).toContain(
      'Preference store unavailable',
    );
    // The Save-as-defaults affordance is not offered while collection
    // preferences failed to load — there are no valid defaults to persist.
    expect(querySaveDefaultsButton(rendered.container)).toBeNull();
    rendered.cleanup();
  });

  it('shows the Save plugin selections control disabled until selections change', async () => {
    const initial = createDeferred<{ success: false; error: string }>();
    const recovered = createDeferred<{
      success: true;
      data: ResolvePluginCollectionsResponse;
    }>();
    const resolvePluginCollections = jest
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(recovered.promise);
    window.pipelines.resolvePluginCollections = resolvePluginCollections;
    const rendered = renderModal();

    await flushAsync();
    await click(getPipelineRowButton(rendered.container));

    await act(async () => {
      initial.resolve({
        success: false,
        error: 'Preference store unavailable',
      });
      await initial.promise;
    });
    await flushAsync();

    expect(resolvePluginCollections).toHaveBeenCalledTimes(2);
    // While preferences failed to load there is nothing valid to persist.
    expect(querySaveDefaultsButton(rendered.container)).toBeNull();

    await act(async () => {
      recovered.resolve({
        success: true,
        data: {
          previewItems: [],
          effectivePreferences: {},
          validation: { hasBlockingErrors: false, messages: [] },
        },
      });
      await recovered.promise;
    });
    await click(getRunButton(rendered.container));

    expect(rendered.container.textContent).not.toContain(
      'Preference store unavailable',
    );
    // After recovery the control is shown under the Plugin Collections section,
    // but disabled because selections still match the loaded defaults — it only
    // enables once the user actually changes a plugin selection.
    const saveButton = querySaveDefaultsButton(rendered.container);
    expect(saveButton).not.toBeNull();
    expect(saveButton?.disabled).toBe(true);
    expect(saveButton?.textContent).toContain(
      'Save plugin selections as defaults',
    );
    rendered.cleanup();
  });

  it('enables the Save plugin selections control after a selection changes', async () => {
    window.pipelines.resolvePluginCollections = jest.fn().mockResolvedValue({
      success: true,
      data: {
        previewItems: [],
        effectivePreferences: {},
        validation: { hasBlockingErrors: false, messages: [] },
      },
    });
    const rendered = renderModal();

    await flushAsync();
    await click(getPipelineRowButton(rendered.container));
    await flushAsync();
    // Continue into the configure step where the control is rendered.
    await click(getRunButton(rendered.container));
    await flushAsync();

    expect(querySaveDefaultsButton(rendered.container)?.disabled).toBe(true);

    const toggle = rendered.container.querySelector(
      '[data-testid="mock-toggle-plugin-selection"]',
    );
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error('Expected mock plugin selection toggle');
    }
    await click(toggle);
    await flushAsync();

    expect(querySaveDefaultsButton(rendered.container)?.disabled).toBe(false);
    rendered.cleanup();
  });

  it('keeps null and undefined distinct when comparing preference drafts', () => {
    expect(stableStringify(undefined)).not.toBe(stableStringify(null));
    expect(stableStringify({ value: undefined })).not.toBe(
      stableStringify({ value: null }),
    );
    expect(stableStringify({ b: 2, a: 1 })).toBe(
      stableStringify({ a: 1, b: 2 }),
    );
  });

  it('defaults the watcher recipient to the active chat in the relevant worktree', async () => {
    const onWatcherSelectionChange = jest.fn();
    const rendered = renderModalWithProps({
      onWatcherSelectionChange,
      watcherRecipientGroups: [
        {
          key: 'app-advisor',
          label: 'App Advisor',
          options: [
            {
              label: 'Advisor One',
              destination: {
                projectId: 'app-advisor',
                worktreeId: 'app-advisor',
                chatId: 'advisor-1',
              },
            },
          ],
        },
        {
          key: 'worktree',
          label: 'This worktree',
          options: [
            {
              label: 'First chat',
              destination: {
                projectId: 'project-1',
                worktreeId: 'worktree-1',
                chatId: 'wt-chat-1',
              },
            },
            {
              label: 'Active chat',
              preferredDefault: true,
              destination: {
                projectId: 'project-1',
                worktreeId: 'worktree-1',
                chatId: 'wt-chat-active',
              },
            },
          ],
        },
      ],
    });

    await flushAsync();

    const toggle = rendered.container.querySelector(
      '[data-testid="pipeline-trigger-modal-watcher-toggle"]',
    );
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error('Expected watcher toggle button');
    }
    await click(toggle);

    expect(onWatcherSelectionChange).toHaveBeenLastCalledWith({
      destination: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'wt-chat-active',
      },
    });
    rendered.cleanup();
  });

  it('shows context-specific empty copy when shared rows are hidden by execution scope', async () => {
    Object.assign(mockSharedListState, {
      cloudAccount: {
        hasApiKey: true,
        account: { id: 'account-1', email: 'user@example.com' },
      },
      rows: [
        {
          ...pipelineInfo('shared-worktree-only'),
          id: 'shared:remote-1',
          remoteId: 'remote-1',
          source: 'shared',
          scopes: ['worktree'],
        },
      ],
      loaded: true,
    });
    window.pipelines.list = jest
      .fn()
      .mockResolvedValue({ success: true, data: [] });
    const rendered = renderModalWithProps({ executionScope: 'directory' });

    await flushAsync();
    await click(getButtonByText(rendered.container, 'Shared'));

    expect(rendered.container.textContent).toContain(
      'No workflows available for this context.',
    );
    expect(rendered.container.textContent).not.toContain(
      'No shared workflows found.',
    );
    rendered.cleanup();
  });

  it('keeps the all-view shared list mounted while later shared pages may match scope', async () => {
    Object.assign(mockSharedListState, {
      cloudAccount: {
        hasApiKey: true,
        account: { id: 'account-1', email: 'user@example.com' },
      },
      rows: [
        {
          ...pipelineInfo('shared-worktree-only'),
          id: 'shared:remote-1',
          remoteId: 'remote-1',
          source: 'shared',
          scopes: ['worktree'],
        },
      ],
      loaded: true,
      nextCursor: 'next-page',
    });
    window.pipelines.list = jest
      .fn()
      .mockResolvedValue({ success: true, data: [] });
    const rendered = renderModalWithProps({ executionScope: 'directory' });

    await flushAsync();

    expect(rendered.container.textContent).toContain(
      'Loading shared workflows…',
    );
    expect(rendered.container.textContent).not.toContain(
      'No workflows available for this context.',
    );
    rendered.cleanup();
  });

  it('loads another shared page when current rows are hidden by execution scope', async () => {
    const loadMoreShared = jest.fn();
    Object.assign(mockSharedListState, {
      cloudAccount: {
        hasApiKey: true,
        account: { id: 'account-1', email: 'user@example.com' },
      },
      rows: [
        {
          ...pipelineInfo('shared-worktree-only'),
          id: 'shared:remote-1',
          remoteId: 'remote-1',
          source: 'shared',
          scopes: ['worktree'],
        },
      ],
      loaded: true,
      nextCursor: 'next-page',
      loadMoreShared,
    });
    window.pipelines.list = jest
      .fn()
      .mockResolvedValue({ success: true, data: [] });
    const rendered = renderModalWithProps({ executionScope: 'directory' });

    await flushAsync();
    expect(loadMoreShared).toHaveBeenCalledTimes(1);
    loadMoreShared.mockClear();
    await click(getButtonByText(rendered.container, 'Shared'));
    await flushAsync();

    expect(loadMoreShared).toHaveBeenCalledTimes(1);
    expect(rendered.container.textContent).toContain(
      'Loading shared workflows…',
    );
    expect(rendered.container.textContent).not.toContain(
      'No workflows available for this context.',
    );
    rendered.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Model alias section coverage.
// ---------------------------------------------------------------------------

function aliasPipelineData(aliases: PipelineModelAlias[]): PipelineData {
  const info = pipelineInfo('alias-pipeline');
  return {
    info: { ...info, name: 'Alias pipeline' },
    content: {
      name: 'Alias pipeline',
      description: 'Uses model aliases',
      icon: '',
      on: 'dispatch',
      model_aliases: aliases,
      jobs: { test: { steps: [] } },
    },
  };
}

interface RunContext {
  preferences: Record<string, unknown>;
  modelAliasPreferences?: Record<string, unknown>;
}

/** Read the run-context argument (5th) from a mocked onRun call. */
function runContextArg(mock: jest.Mock): RunContext {
  const calls = mock.mock.calls as unknown[][];
  return calls[0][4] as RunContext;
}

/** Read the first argument from a mocked save call. */
function firstCallArg(mock: jest.Mock): {
  preferences: Record<string, unknown>;
} {
  const calls = mock.mock.calls as unknown[][];
  return calls[0][0] as { preferences: Record<string, unknown> };
}

describe('PipelineTriggerModal — model aliases', () => {
  let onRun: jest.Mock;
  let loadModelAliasPreferences: jest.Mock;
  let saveModelAliasPreferences: jest.Mock;

  function setupPipeline(
    pd: PipelineData,
    storedPreferences: Record<string, unknown> = {},
  ): void {
    loadModelAliasPreferences = jest.fn().mockResolvedValue({
      success: true,
      data: { preferences: storedPreferences },
    });
    saveModelAliasPreferences = jest
      .fn()
      .mockResolvedValue({ success: true, data: { ok: true } });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        list: jest.fn().mockResolvedValue({ success: true, data: [pd.info] }),
        discoverProject: jest
          .fn()
          .mockResolvedValue({ success: true, data: [] }),
        get: jest.fn().mockResolvedValue({ success: true, data: pd }),
        resolvePluginCollections: jest.fn(),
        savePluginCollectionPreferences: jest.fn(),
        loadModelAliasPreferences,
        saveModelAliasPreferences,
      },
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    onRun = jest.fn().mockResolvedValue(undefined);
    Object.assign(mockSharedListState, {
      cloudAccount: null,
      cloudLoading: false,
      rows: [],
      loaded: false,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadPreferences: jest.fn().mockResolvedValue({}) },
    });
    Object.defineProperty(window, 'agents', {
      configurable: true,
      value: { list: jest.fn().mockResolvedValue({ agents: [] }) },
    });
    // Pre-seed the agents store so the modal's load effect is skipped.
    act(() => {
      useAgentsStore.setState({ agents: [], loaded: true });
      initAgentModels([]);
    });
  });

  async function openConfigureStep(
    props: Partial<ComponentProps<typeof PipelineTriggerModal>> = {},
  ): Promise<{ container: HTMLDivElement; cleanup: () => void }> {
    const rendered = renderModalWithProps({ onRun, ...props });
    await flushAsync();
    await click(getPipelineRowButton(rendered.container));
    await flushAsync();
    // Advance from select → configure (Continue).
    await click(getRunButton(rendered.container));
    await flushAsync();
    return rendered;
  }

  it('does not render the model aliases section when the pipeline has none', async () => {
    setupPipeline(pipelineData());
    window.pipelines.resolvePluginCollections = jest.fn().mockResolvedValue({
      success: true,
      data: {
        previewItems: [],
        effectivePreferences: {},
        validation: { hasBlockingErrors: false, messages: [] },
      },
    });
    const rendered = await openConfigureStep();
    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-model-aliases-section"]',
      ),
    ).toBeNull();
    expect(loadModelAliasPreferences).not.toHaveBeenCalled();
    rendered.cleanup();
  });

  it('renders a required badge for an alias with no defaults and blocks Run', async () => {
    setupPipeline(aliasPipelineData([{ id: 'writer', name: 'Writer' }]));
    const rendered = await openConfigureStep();

    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-model-aliases-section"]',
      ),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-model-alias-writer-required"]',
      ),
    ).not.toBeNull();
    // A required, unconfigured alias blocks the run.
    expect(getRunButton(rendered.container).disabled).toBe(true);
    rendered.cleanup();
  });

  it('blocks Run when an Agent alias points at an unavailable Agent', async () => {
    const agentId = 'agent_model_unavailable_reviewer';
    act(() => {
      useAgentsStore.setState({
        agents: [
          {
            id: agentId,
            name: 'Unavailable Reviewer',
            baseModel: 'missing-base-model',
            instructions: 'Review code.',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
            },
            createdAt: '2026-07-07T00:00:00.000Z',
            updatedAt: '2026-07-07T00:00:00.000Z',
          },
        ],
        loaded: true,
      });
      initAgentModels([
        {
          id: agentId,
          name: 'Unavailable Reviewer',
          baseModel: 'missing-base-model',
          instructions: 'Review code.',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z',
          available: false,
          unavailableReason: 'base_model_unavailable',
        },
      ]);
    });
    setupPipeline(
      aliasPipelineData([
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: { agent_id: agentId },
        },
      ]),
    );
    const rendered = await openConfigureStep();

    expect(getRunButton(rendered.container).disabled).toBe(true);

    const header = rendered.container.querySelector(
      '[data-testid="pipeline-model-alias-reviewer"] button',
    );
    if (!header) throw new Error('missing alias header');
    await click(header);
    await flushAsync();

    expect(rendered.container.textContent).toContain(
      'Unavailable Reviewer (agent_model_unavailable_reviewer) - unavailable',
    );
    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-model-alias-reviewer-error"]',
      )?.textContent,
    ).toBe('Agent is not available locally.');
    rendered.cleanup();
  });

  it('includes modelAliasPreferences in the dispatch context', async () => {
    setupPipeline(
      aliasPipelineData([
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: { base: 'default-model' },
        },
      ]),
    );
    const rendered = await openConfigureStep();

    // Alias has valid defaults → Run is enabled.
    const runButton = getRunButton(rendered.container);
    expect(runButton.disabled).toBe(false);
    await click(runButton);
    await flushAsync();

    expect(onRun).toHaveBeenCalledTimes(1);
    const context = runContextArg(onRun);
    expect(context.modelAliasPreferences).toEqual({});
    rendered.cleanup();
  });

  it('reset overrides a stored preference and sends { mode: "reset" }', async () => {
    setupPipeline(
      aliasPipelineData([
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: { base: 'default-model' },
        },
      ]),
      { reviewer: { mode: 'inline', base: 'stored-model' } },
    );
    const rendered = await openConfigureStep();

    // The stored preference is loaded and surfaced as customized.
    expect(
      rendered.container.querySelector(
        '[data-testid="pipeline-model-alias-reviewer-customized"]',
      ),
    ).not.toBeNull();

    // Expand the alias editor and reset to defaults.
    const header = rendered.container.querySelector(
      '[data-testid="pipeline-model-alias-reviewer"] button',
    );
    if (!header) throw new Error('missing alias header');
    await click(header);
    const resetButton = rendered.container.querySelector(
      '[data-testid="pipeline-model-alias-reviewer-reset"]',
    );
    if (!resetButton) throw new Error('missing reset button');
    await click(resetButton);
    await flushAsync();

    await click(getRunButton(rendered.container));
    await flushAsync();

    const context = runContextArg(onRun);
    // The reset marker is sent (NOT a key deletion), forcing the pipeline
    // default over the stored preference for this run.
    expect(context.modelAliasPreferences).toEqual({
      reviewer: { mode: 'reset' },
    });
    expect(saveModelAliasPreferences).toHaveBeenCalledWith({
      pipelinePreferenceLocator: {
        type: 'stored',
        source: 'user',
        value: 'alias-pipeline',
      },
      preferences: {
        reviewer: { mode: 'reset' },
      },
      aliasIds: ['reviewer'],
    });
    rendered.cleanup();
  });

  it('saving after a reset persists the reset marker (deletes the stored default)', async () => {
    setupPipeline(
      aliasPipelineData([
        {
          id: 'reviewer',
          name: 'Reviewer',
          defaults: { base: 'default-model' },
        },
      ]),
      { reviewer: { mode: 'inline', base: 'stored-model' } },
    );
    const rendered = await openConfigureStep();

    const header = rendered.container.querySelector(
      '[data-testid="pipeline-model-alias-reviewer"] button',
    );
    if (!header) throw new Error('missing alias header');
    await click(header);
    const resetButton = rendered.container.querySelector(
      '[data-testid="pipeline-model-alias-reviewer-reset"]',
    );
    if (!resetButton) throw new Error('missing reset button');
    await click(resetButton);
    await flushAsync();

    const saveButton = querySaveDefaultsButton(rendered.container);
    expect(saveButton).not.toBeNull();
    expect(saveButton?.disabled).toBe(false);
    await click(saveButton as HTMLButtonElement);
    await flushAsync();

    expect(saveModelAliasPreferences).toHaveBeenCalledTimes(1);
    expect(firstCallArg(saveModelAliasPreferences).preferences).toEqual({
      reviewer: { mode: 'reset' },
    });
    rendered.cleanup();
  });
});

function plainPipeline(
  id: string,
  scopes: PipelineInfo['scopes'],
  extra: Partial<PipelineData> = {},
): PipelineData {
  const info: PipelineInfo = {
    ...pipelineInfo(id),
    name: `Pipeline ${id}`,
    scopes,
  };
  return {
    info,
    content: {
      name: info.name,
      on: 'dispatch',
      jobs: { main: { steps: [{ run: 'echo run' }] } },
    },
    ...extra,
  };
}

const DIRECTORY_SCOPES: readonly PipelineExecutionScope[] = [
  'global',
  'directory',
];
const WORKTREE_SCOPES: readonly PipelineExecutionScope[] = [
  'global',
  'worktree',
];

describe('PipelineTriggerModal — run context (CAN-4542)', () => {
  function serve(pipelines: PipelineData[]): {
    list: jest.Mock;
    discoverProject: jest.Mock;
  } {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadPreferences: jest.fn().mockResolvedValue({}) },
    });
    const list = jest.fn().mockResolvedValue({
      success: true,
      data: pipelines.map((pipeline) => pipeline.info),
    });
    const discoverProject = jest
      .fn()
      .mockResolvedValue({ success: true, data: [] });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        list,
        discoverProject,
        get: jest.fn((id: string) =>
          Promise.resolve({
            success: true,
            data: pipelines.find((pipeline) => pipeline.info.id === id),
          }),
        ),
        resolvePluginCollections: jest.fn(),
        savePluginCollectionPreferences: jest.fn(),
      },
    });
    return { list, discoverProject };
  }

  function rowNames(container: HTMLElement): string[] {
    return Array.from(
      container.querySelectorAll(
        '[data-testid="pipeline-trigger-modal-selector"] button',
      ),
    ).map((row) => row.querySelector('.truncate')?.textContent ?? '');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockSharedListState, { rows: [], loaded: false });
  });

  it("loads the list once, after the task's folder resolves", async () => {
    const api = serve([plainPipeline('global-only', ['global'])]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const render = (props: {
      cwd?: string;
      contextPending: boolean;
      scopes: readonly PipelineExecutionScope[];
    }): void => {
      act(() => {
        root.render(
          <PipelineTriggerModal
            triggerType="dispatch"
            labels={{
              title: 'Run pipeline',
              selectSubtitle: 'Select a pipeline',
              emptyMessage: 'No pipelines',
            }}
            onClose={jest.fn()}
            onRun={jest.fn()}
            {...(props.cwd !== undefined ? { cwd: props.cwd } : {})}
            contextPending={props.contextPending}
            executionScopes={props.scopes}
          />,
        );
      });
    };
    try {
      render({ contextPending: true, scopes: DIRECTORY_SCOPES });
      await flushAsync();
      expect(api.list).not.toHaveBeenCalled();

      render({ cwd: '/w', contextPending: false, scopes: WORKTREE_SCOPES });
      await flushAsync();
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(api.discoverProject).toHaveBeenCalledWith('/w');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('lists what runs with no project, plus what the current task can run', async () => {
    serve([
      plainPipeline('global-only', ['global']),
      plainPipeline('task-only', ['directory']),
    ]);
    const noTask = renderModalWithProps({ executionScopes: ['global'] });
    try {
      await flushAsync();
      expect(rowNames(noTask.container)).toEqual(['Pipeline global-only']);
    } finally {
      noTask.cleanup();
    }

    const withTask = renderModalWithProps({
      executionScopes: ['global', 'worktree'],
    });
    try {
      await flushAsync();
      expect(rowNames(withTask.container).sort()).toEqual([
        'Pipeline global-only',
        'Pipeline task-only',
      ]);
    } finally {
      withTask.cleanup();
    }
  });

  it("doesn't list a project file through the no-project scope", async () => {
    const projectGlobal = plainPipeline('project-global', ['global']);
    projectGlobal.info = { ...projectGlobal.info, source: 'project' };
    serve([projectGlobal, plainPipeline('global-only', ['global'])]);
    const withTask = renderModalWithProps({
      executionScopes: ['global', 'worktree'],
    });
    try {
      await flushAsync();
      // A project file only runs in its checkout, never with no project.
      expect(rowNames(withTask.container)).toEqual(['Pipeline global-only']);
    } finally {
      withTask.cleanup();
    }
  });

  it('opens the owner choice for an input-less pipeline instead of running it', async () => {
    serve([plainPipeline('global-only', ['global'])]);
    const onRun = jest.fn().mockResolvedValue(undefined);
    const { container, cleanup } = renderModalWithProps({
      executionScopes: ['global'],
      onRun,
      runContextReview: () => ({
        fields: <div data-testid="owner-choice">Owner</div>,
        needsReview: true,
        runBlocked: true,
        targeted: false,
      }),
    });
    try {
      await flushAsync();
      await click(getPipelineRowButton(container));
      expect(getRunButton(container).textContent).toBe('Continue');
      await click(getRunButton(container));
      await flushAsync();

      expect(onRun).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="owner-choice"]'),
      ).not.toBeNull();
      // No owner is chosen yet, so Run stays off.
      expect(getRunButton(container).disabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('shows a saved owner before running an input-less pipeline', async () => {
    serve([
      plainPipeline('owned', ['global'], {
        localRunOwner: 'org:11111111-1111-4111-8111-111111111111',
      }),
    ]);
    const onRun = jest.fn().mockResolvedValue(undefined);
    const { container, cleanup } = renderModalWithProps({
      executionScopes: ['global'],
      onRun,
      runContextReview: (pipeline) => ({
        fields: <p data-testid="owner-fixed">{pipeline.localRunOwner ?? ''}</p>,
        needsReview: true,
        runBlocked: false,
        targeted: false,
      }),
    });
    try {
      await flushAsync();
      await click(getPipelineRowButton(container));
      await click(getRunButton(container));
      await flushAsync();
      expect(onRun).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="owner-fixed"]')?.textContent,
      ).toBe('org:11111111-1111-4111-8111-111111111111');

      await click(getRunButton(container));
      await flushAsync();
      expect(onRun).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('turns off the immediate Run and says why when the pipeline cannot run here', async () => {
    serve([plainPipeline('task-only', ['worktree'])]);
    const onRun = jest.fn().mockResolvedValue(undefined);
    const { container, cleanup } = renderModalWithProps({
      initialPipelineId: 'task-only',
      onRun,
      runContextReview: () => ({
        fields: null,
        needsReview: false,
        runBlocked: true,
        blockedReason: 'Open a compatible task to run this pipeline there.',
        targeted: true,
      }),
    });
    try {
      await flushAsync();
      const run = getRunButton(container);
      expect(run.textContent).toBe('Run');
      expect(run.disabled).toBe(true);
      expect(
        container.querySelector(
          '[data-testid="pipeline-trigger-modal-run-blocked"]',
        )?.textContent,
      ).toBe('Open a compatible task to run this pipeline there.');
      await click(run);
      await flushAsync();
      expect(onRun).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('keeps the immediate Run of an input-less pipeline opened from a task', async () => {
    serve([plainPipeline('task-only', ['directory'])]);
    const onRun = jest.fn().mockResolvedValue(undefined);
    const { container, cleanup } = renderModalWithProps({
      executionScope: 'worktree',
      onRun,
    });
    try {
      await flushAsync();
      await click(getPipelineRowButton(container));
      expect(getRunButton(container).textContent).toBe('Run');
      await click(getRunButton(container));
      await flushAsync();
      expect(onRun).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
