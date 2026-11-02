/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { createRoot, type Root } from 'react-dom/client';
import type {
  IPCResult,
  Pipeline,
  PipelineInfo,
  SharedPipelineDetail,
  SharedPipelineWriteRequest,
} from '@canopy/desktop-shared/types/pipeline';

jest.mock('@canopy/desktop-shared/constants/canopy-cloud', () => ({
  CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT: 'canopy-cloud-account-changed',
}));

jest.mock('@/lib/brand', () => ({
  brandText: { appName: 'Canopy' },
}));

const mockPostShareToast = jest.fn();
jest.mock('@/lib/share-toast', () => ({
  postShareToast: (toast: unknown): void => {
    mockPostShareToast(toast);
  },
}));

import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageAnalyzeRequest,
  PipelinePackageCreateSharedRequest,
} from '@canopy/desktop-shared/types/pipeline';

import { SharePipelineModal } from '../SharePipelineModal';
import { ResourceContextProvider } from '@canopy/ui-app/capability';

/**
 * Analysis fixture mirroring the motivating case: a step invoking a private
 * `/open-pr` command that transitively pulls in a private support file.
 */
function makeAnalysis(
  overrides: Partial<PipelinePackageAnalysisSummary> = {},
): PipelinePackageAnalysisSummary {
  return {
    analysisId: 'analysis-1',
    state: 'ready',
    pipelineContentHash: 'b'.repeat(64),
    blockers: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
    manifest: {
      version: 1,
      pipelineContentHash: 'b'.repeat(64),
      resources: [
        {
          id: 'ud-git.open-pr',
          kind: 'plugin_command',
          displayName: '/open-pr',
          sourceLabel: 'ud-git',
          sourceVisibility: 'private',
          invocationKeys: ['/open-pr'],
          dependencyResourceIds: ['ud-git.pr-template'],
          trees: [
            {
              provider: 'claude',
              runtimeKind: 'plugin_fragment',
              rootName: 'ud-git',
              entries: [
                {
                  path: 'commands/open-pr.md',
                  sha256: 'c'.repeat(64),
                  size: 1024,
                  mode: 'read',
                },
              ],
            },
          ],
        },
        {
          id: 'ud-git.pr-template',
          kind: 'plugin_skill',
          displayName: 'pr-template',
          sourceLabel: 'ud-git',
          sourceVisibility: 'private',
          invocationKeys: ['ud-git:pr-template'],
          dependencyResourceIds: [],
          trees: [
            {
              provider: 'claude',
              runtimeKind: 'plugin_fragment',
              rootName: 'ud-git',
              entries: [
                {
                  path: 'skills/pr-template/SKILL.md',
                  sha256: 'd'.repeat(64),
                  size: 2048,
                  mode: 'read',
                },
              ],
            },
          ],
        },
      ],
      bindings: [
        { jobId: 'ship', stepId: 'open_pr', resourceIds: ['ud-git.open-pr'] },
      ],
      environmentRequirements: [
        {
          id: 'github',
          kind: 'connector',
          displayName: 'GitHub authentication',
          required: true,
          affectedSteps: [{ jobId: 'ship', stepId: 'open_pr' }],
          setupHint: 'Connect GitHub in Settings.',
        },
      ],
      totalFiles: 2,
      totalBytes: 3072,
    },
    ...overrides,
  };
}

/**
 * The peer's screenshot, faithfully: a wall of unresolved-invocation blockers
 * and NO manifest key at all. Built by deleting the key rather than setting it
 * to `undefined`, because `{ manifest: undefined }` spread over `makeAnalysis`
 * still satisfies `'manifest' in summary`.
 */
function makeBlockedAnalysis(
  blockers: PipelinePackageAnalysisSummary['blockers'],
  overrides: Partial<PipelinePackageAnalysisSummary> = {},
): PipelinePackageAnalysisSummary {
  const analysis: PipelinePackageAnalysisSummary = {
    ...makeAnalysis({ state: 'blocked', blockers }),
    ...overrides,
  };
  delete analysis.manifest;
  return analysis;
}

function unresolvedBlocker(
  subject: string,
  occurrences: Array<{ jobId: string; stepId: string }>,
  provider: 'claude' | 'codex' = 'claude',
): PipelinePackageAnalysisSummary['blockers'][number] {
  return {
    code: 'UNRESOLVED_INVOCATION',
    subject,
    origin: 'direct',
    message: `Required invocation ${subject} could not be resolved.`,
    jobId: occurrences[0]?.jobId ?? 'ship',
    stepId: occurrences[0]?.stepId ?? 'open_pr',
    occurrences,
    dismissal: { provider, token: subject },
  };
}

const pipeline: Pipeline = {
  name: 'Review Pipeline',
  description: 'Reviews a change',
  on: 'dispatch',
  jobs: {},
};

const sharedDetail: SharedPipelineDetail = {
  id: 'shared-pipeline-1',
  name: pipeline.name,
  description: pipeline.description ?? '',
  icon: '',
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  version: '1',
  triggerTypes: ['dispatch'],
  createdBy: { id: 'user-1', name: 'Alice' },
  canUpdate: true,
  canDelete: true,
  shareScope: 'private',
  rawPipeline: '',
};

function makePipelineInfo(source: PipelineInfo['source']): PipelineInfo {
  return {
    id: source === 'curated' ? 'curated:release' : `${source}-pipeline`,
    name: pipeline.name,
    filename: `${source}-pipeline.yaml`,
    description: pipeline.description ?? '',
    icon: '',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    source,
    readonly: source !== 'user',
    ...(source === 'project'
      ? { filePath: '/repo/.canopy/pipelines/project-pipeline.yaml' }
      : {}),
  };
}

describe('SharePipelineModal', () => {
  let container: HTMLElement;
  let root: Root;
  const createShared = jest.fn<
    Promise<IPCResult<SharedPipelineDetail>>,
    [SharedPipelineWriteRequest]
  >();
  const createSharedPackaged = jest.fn<
    Promise<IPCResult<SharedPipelineDetail>>,
    [PipelinePackageCreateSharedRequest]
  >();
  const analyzePackage = jest.fn<
    Promise<IPCResult<PipelinePackageAnalysisSummary>>,
    [PipelinePackageAnalyzeRequest]
  >();
  const deletePipeline = jest.fn();
  const onShared = jest.fn();

  beforeEach(() => {
    mockPostShareToast.mockClear();
    createShared.mockReset();
    createShared.mockResolvedValue({ success: true, data: sharedDetail });
    createSharedPackaged.mockReset();
    createSharedPackaged.mockResolvedValue({
      success: true,
      data: sharedDetail,
    });
    analyzePackage.mockReset();
    const emptyAnalysis = makeAnalysis();
    if (!emptyAnalysis.manifest) throw new Error('Missing manifest fixture');
    analyzePackage.mockResolvedValue({
      success: true,
      data: {
        ...emptyAnalysis,
        manifest: {
          ...emptyAnalysis.manifest,
          resources: [],
          bindings: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
      },
    });
    deletePipeline.mockReset();
    deletePipeline.mockResolvedValue({ success: true });
    onShared.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(window, {
      api: {
        getCanopyCloudBaseUrl: jest
          .fn()
          .mockResolvedValue('https://cloud.example.test'),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          authMode: 'api_key',
          credentialSource: 'manual',
          capabilities: ['pipelines-crud-v1'],
          storageAvailable: true,
          account: {
            id: 'account-1',
            name: 'Test User',
            email: 'test@example.com',
            role: 'DEVELOPER',
          },
        }),
      },
      pipelines: {
        createShared,
        createSharedPackaged,
        analyzePackage,
        cancelPackageAnalysis: jest.fn().mockResolvedValue({ success: true }),
        onPackageProgress: jest.fn((): (() => void) => (): void => {}),
        delete: deletePipeline,
        publishPublicShare: jest.fn().mockResolvedValue({
          success: true,
          data: {
            externalId: 'public-pipeline-id',
            sharePath: '/portal/plugins/pipelines/shared/public-pipeline-id',
          },
        }),
        revokePublicShare: jest.fn().mockResolvedValue({ success: true }),
        listSharedOrganizations: jest.fn(),
        listSharedTeams: jest.fn(),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /**
   * Opt this test into the packaging surface. Absent `analyzePackage` (the
   * default) is the legacy/unwired build, where the modal must keep its
   * original one-button definition share.
   */
  function enablePackaging(
    analysis: PipelinePackageAnalysisSummary | null,
  ): void {
    analyzePackage.mockResolvedValue(
      analysis ? { success: true, data: analysis } : { success: false },
    );
    Object.assign(window.pipelines, {
      analyzePackage,
      createSharedPackaged,
      cancelPackageAnalysis: jest.fn().mockResolvedValue({ success: true }),
      onPackageProgress: jest.fn((): (() => void) => (): void => {}),
    });
  }

  function clickTestId(testId: string): void {
    document
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  async function renderModal(
    source: PipelineInfo['source'],
    worktree?: { projectId: string; worktreeId: string; repoId?: string },
    pipelineDocument: Pipeline = pipeline,
    infoOverrides: Partial<PipelineInfo> = {},
    resourceContext?: {
      readonly context: { kind: 'organization'; organizationId: string };
      readonly personalOrganizationId: string;
    },
  ): Promise<void> {
    const modal = (
      <SharePipelineModal
        pipeline={pipelineDocument}
        localPipelineInfo={{ ...makePipelineInfo(source), ...infoOverrides }}
        {...(worktree ? { worktree } : {})}
        onClose={() => {}}
        onOpenAccountSettings={() => {}}
        onShared={onShared}
      />
    );
    await act(async () => {
      root.render(
        resourceContext ? (
          <ResourceContextProvider {...resourceContext}>
            {modal}
          </ResourceContextProvider>
        ) : (
          modal
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      clickTestId('share-pipeline-scope-public');
      await Promise.resolve();
    });
  }

  /** The dependency review starts collapsed; its details are optional. */
  async function expandDependencies(): Promise<void> {
    await act(async () => {
      clickTestId('share-pipeline-dependencies-toggle');
      await Promise.resolve();
    });
  }

  /** Hovers the summary's help icon and returns its tooltip text. */
  function includedFilesHelp(): string {
    act(() => {
      document
        .querySelector('[data-testid="share-pipeline-dependencies-help"]')
        ?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
    });
    return (
      document.querySelector(
        '[data-testid="share-pipeline-dependencies-help-details"]',
      )?.textContent ?? ''
    );
  }

  async function clickShare(): Promise<void> {
    await act(async () => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Share',
      );
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('fails closed when a project source has no worktree locator', async (): Promise<void> => {
    const previous = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...previous,
        values: {
          ...previous.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    await renderModal('project');
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-submit"]',
      )?.disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain('Reopen');
    await clickShare();
    expect(createShared).not.toHaveBeenCalled();
    useFeatureFlagsStore.setState({ snapshot: previous });
  });

  it('removes the observed public link through the shared confirmation flow', async (): Promise<void> => {
    const publicShare = {
      externalId: 'public-pipeline-id',
      pinnedContentHash: 'public-hash',
      upToDate: true,
      sharePath: '/portal/plugins/pipelines/shared/public-pipeline-id',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const existingDetail: SharedPipelineDetail = {
      ...sharedDetail,
      contentHash: 'server-hash',
      publicShare,
    };
    const getShared = jest.fn().mockResolvedValue({
      success: true,
      data: existingDetail,
    });
    const updateShared = jest.fn();
    const publishPublicShare = jest.fn();
    const revokePublicShare = jest.fn().mockResolvedValue({ success: true });
    Object.assign(window.pipelines, {
      getShared,
      updateShared,
      publishPublicShare,
      revokePublicShare,
    });

    await renderModal('user', undefined, pipeline, {
      remote: {
        remoteId: existingDetail.id,
        contentHash: 'stale-local-hash',
        shareScope: 'private',
        sharedAt: existingDetail.updatedAt,
      },
    });
    const deadline = Date.now() + 4_000;
    while (
      !document.querySelector('[data-testid="share-pipeline-copy-link"]') &&
      Date.now() < deadline
    ) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(
      document
        .querySelector('[data-testid="share-pipeline-scope-public"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      document.querySelector('[data-testid="share-pipeline-scope-description"]')
        ?.textContent,
    ).toContain('Anyone can view this workflow');
    expect(
      document.querySelector('[data-testid="share-pipeline-copy-link"]'),
    ).not.toBeNull();
    await act(async () => {
      clickTestId('share-pipeline-remove-public-link');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "Anyone with the link will lose access, and it won't show up in shared lists anymore.",
    );
    await act(async () => {
      clickTestId('share-pipeline-remove-public-link-confirm-action');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(revokePublicShare).toHaveBeenCalledWith(existingDetail.id);
    expect(updateShared).not.toHaveBeenCalled();
    expect(publishPublicShare).not.toHaveBeenCalled();
  });

  // CAN-3844: under context policy, the same legacy organization share can't
  // move to the personal owner Public needs. It opens on its organization,
  // Public is disabled with a reason, and Remove public link stays.
  it('opens a legacy organization public link on its owner under context policy', async (): Promise<void> => {
    const publicShare = {
      externalId: 'public-pipeline-id',
      pinnedContentHash: 'public-hash',
      upToDate: false,
      sharePath: '/portal/plugins/pipelines/shared/public-pipeline-id',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const existingDetail: SharedPipelineDetail = {
      ...sharedDetail,
      contentHash: 'server-hash',
      shareScope: 'organization',
      owner: { type: 'organization', id: 'org-1', name: 'Acme' },
      publicShare,
    };
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        authMode: 'api_key',
        credentialSource: 'manual',
        capabilities: ['pipelines-crud-v1', 'organizations-v1'],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
      }),
    });
    Object.assign(window.pipelines, {
      getShared: jest
        .fn()
        .mockResolvedValue({ success: true, data: existingDetail }),
      listSharedOrganizations: jest.fn().mockResolvedValue({
        success: true,
        data: { data: [{ id: 'org-1', name: 'Acme' }] },
      }),
      revokePublicShare: jest.fn(),
    });

    await renderModal(
      'user',
      undefined,
      pipeline,
      {
        remote: {
          remoteId: existingDetail.id,
          contentHash: 'stale-local-hash',
          shareScope: 'organization',
          sharedAt: existingDetail.updatedAt,
        },
      },
      {
        context: { kind: 'organization', organizationId: 'org-1' },
        personalOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    );
    const deadline = Date.now() + 4_000;
    while (
      !document.querySelector(
        '[data-testid="share-pipeline-public-locked-hint"]',
      ) &&
      Date.now() < deadline
    ) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(
      document.querySelector(
        '[data-testid="share-pipeline-public-locked-hint"]',
      )?.textContent,
    ).toBe("Organization shares can't be made public yet.");
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-scope-public"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document
        .querySelector('[data-testid="share-pipeline-scope-organization"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      document.querySelector(
        '[data-testid="share-pipeline-public-link-stale"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="share-pipeline-remove-public-link"]',
      ),
    ).not.toBeNull();
  });

  // CAN-3009: an organization share that also has a public link reads as
  // Public. An explicit Update normalizes the canonical owner to Private.
  it('normalizes a legacy organization owner on explicit Public update', async (): Promise<void> => {
    const publicShare = {
      externalId: 'public-pipeline-id',
      pinnedContentHash: 'public-hash',
      upToDate: true,
      sharePath: '/portal/plugins/pipelines/shared/public-pipeline-id',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const existingDetail: SharedPipelineDetail = {
      ...sharedDetail,
      contentHash: 'server-hash',
      shareScope: 'organization',
      owner: { type: 'organization', id: 'org-1', name: 'Acme' },
      publicShare,
    };
    const createSharedPackaged = jest
      .fn()
      .mockResolvedValue({ success: true, data: existingDetail });
    const publishPublicShare = jest
      .fn()
      .mockResolvedValue({ success: true, data: publicShare });
    Object.assign(window.pipelines, {
      getShared: jest
        .fn()
        .mockResolvedValue({ success: true, data: existingDetail }),
      createSharedPackaged,
      publishPublicShare,
      revokePublicShare: jest.fn(),
    });

    await renderModal('user', undefined, pipeline, {
      remote: {
        remoteId: existingDetail.id,
        contentHash: 'stale-local-hash',
        shareScope: 'organization',
        sharedAt: existingDetail.updatedAt,
      },
    });
    const deadline = Date.now() + 4_000;
    while (
      !document.querySelector('[data-testid="share-pipeline-copy-link"]') &&
      Date.now() < deadline
    ) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
    // Reads as Public, so the public link can still be removed.
    expect(
      document.querySelector(
        '[data-testid="share-pipeline-remove-public-link"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      clickTestId('share-pipeline-submit');
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(createSharedPackaged).toHaveBeenCalledTimes(1);
    expect(createSharedPackaged).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: existingDetail.id,
        shareScope: 'private',
      }),
    );
    expect(createSharedPackaged).not.toHaveBeenCalledWith(
      expect.objectContaining({
        revokePublicShare: {
          externalId: publicShare.externalId,
          updatedAt: publicShare.updatedAt,
        },
      }),
    );
    expect(publishPublicShare).toHaveBeenCalledWith(existingDetail.id);
  });

  it.each(['missing file', 'changed worktree'])(
    'keeps a project share locator fail-closed: %s',
    async (scenario): Promise<void> => {
      const previous = useFeatureFlagsStore.getState().snapshot;
      act(() => {
        useFeatureFlagsStore.setState({
          snapshot: {
            ...previous,
            values: {
              ...previous.values,
              [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
            },
          },
        });
      });
      try {
        const worktree = { projectId: 'project-1', worktreeId: 'worktree-1' };
        await renderModal(
          'project',
          worktree,
          pipeline,
          scenario === 'missing file' ? { filePath: undefined } : {},
        );
        if (scenario === 'missing file') {
          expect(
            document.querySelector<HTMLButtonElement>(
              '[data-testid="share-pipeline-submit"]',
            )?.disabled,
          ).toBe(true);
          await clickShare();
          expect(createShared).not.toHaveBeenCalled();
        } else {
          await renderModal('project', {
            projectId: 'project-2',
            worktreeId: 'worktree-2',
          });
          await clickShare();
          expect(
            createSharedPackaged.mock.calls[0]?.[0].sourcePipeline,
          ).toMatchObject({
            projectId: 'project-2',
            worktreeId: 'worktree-2',
          });
        }
      } finally {
        act(() => {
          useFeatureFlagsStore.setState({ snapshot: previous });
        });
      }
    },
  );

  it('offers no delete-local or consent choice for user pipelines', async () => {
    await renderModal('user');

    expect(document.body.textContent).not.toContain('Delete local copy');
    expect(
      document.querySelector('[data-testid="share-pipeline-delete-local"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-pipeline-consent"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-pipeline-snapshot-note"]'),
    ).toBeNull();
  });

  it('shows the snapshot note instead of delete-local controls for bundled pipelines', async () => {
    await renderModal('bundled');

    expect(document.body.textContent).not.toContain(
      'Delete local copy after sharing',
    );
    expect(
      document.querySelector('[data-testid="share-pipeline-snapshot-note"]'),
    ).not.toBeNull();
  });

  it.each(['bundled', 'curated'])(
    'shares a %s row with an explicit source locator',
    async (kind): Promise<void> => {
      const source = kind === 'bundled' ? 'bundled' : 'curated';
      const previous = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...previous,
          values: {
            ...previous.values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
      try {
        await renderModal(source);
        await clickShare();
        expect(createSharedPackaged.mock.calls[0]?.[0].sourcePipeline).toEqual({
          kind: 'stored',
          source,
          id: source === 'curated' ? 'curated:release' : `${source}-pipeline`,
        });
        expect(onShared).toHaveBeenCalled();
      } finally {
        act(() => {
          useFeatureFlagsStore.setState({ snapshot: previous });
        });
      }
    },
  );

  it('passes the project source locator to both analysis and publication while context enforcement is enabled', async () => {
    const previous = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...previous,
        values: {
          ...previous.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    try {
      const analysis = makeAnalysis();
      if (!analysis.manifest) throw new Error('Missing manifest fixture');
      enablePackaging({
        ...analysis,
        manifest: {
          ...analysis.manifest,
          resources: [],
          bindings: [],
          environmentRequirements: [],
        },
      });
      await renderModal('project', {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      const source = {
        kind: 'project',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pipelineFilePath: '/repo/.canopy/pipelines/project-pipeline.yaml',
      };
      expect(analyzePackage.mock.calls[0]?.[0].sourcePipeline).toEqual(source);
      await clickShare();
      expect(createSharedPackaged.mock.calls[0]?.[0].sourcePipeline).toEqual(
        source,
      );
    } finally {
      act(() => {
        useFeatureFlagsStore.setState({ snapshot: previous });
      });
    }
  });

  it('refuses sharing when a project row has no locator', async () => {
    const previous = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...previous,
        values: {
          ...previous.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    try {
      await renderModal('project');
      await clickShare();
      expect(createShared).not.toHaveBeenCalled();
    } finally {
      act(() => {
        useFeatureFlagsStore.setState({ snapshot: previous });
      });
    }
  });

  it('scopes project analysis by pipeline and worktree identity', async () => {
    enablePackaging(makeAnalysis());
    await renderModal('project', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'repo-1',
    });

    expect(analyzePackage).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'project-pipeline',
        worktree: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          repoId: 'repo-1',
        },
      }),
    );
  });

  describe('Fix it with AI', () => {
    const blockedAnalysis = (): PipelinePackageAnalysisSummary =>
      makeAnalysis({
        state: 'blocked',
        blockers: [
          {
            code: 'UNRESOLVED_INVOCATION',
            subject: '/missing',
            message: 'No skill named /missing.',
            occurrences: [{ jobId: 'review', stepId: 'run' }],
          },
        ],
      });
    const fixButton = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-dependency-problems-fix-with-ai"]',
      );

    it('offers repair for a project pipeline once its checkout path resolves', async () => {
      enablePackaging(blockedAnalysis());
      Object.assign(window.api, {
        getWorktreePath: jest.fn().mockResolvedValue('/repo'),
      });
      await renderModal('project', {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(window.api.getWorktreePath).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      expect(fixButton()?.textContent).toBe('Fix it with AI');
    });

    it('offers no repair when the project file is outside its checkout', async () => {
      enablePackaging(blockedAnalysis());
      Object.assign(window.api, {
        getWorktreePath: jest.fn().mockResolvedValue('/elsewhere'),
      });
      await renderModal('project', {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        document.querySelector(
          '[data-testid="share-pipeline-dependency-problems"]',
        ),
      ).not.toBeNull();
      expect(fixButton()).toBeNull();
    });

    it('offers no repair for a bundled pipeline', async () => {
      enablePackaging(blockedAnalysis());
      await renderModal('bundled');
      expect(
        document.querySelector(
          '[data-testid="share-pipeline-dependency-problems"]',
        ),
      ).not.toBeNull();
      expect(fixButton()).toBeNull();
    });

    it('offers repair for a saved pipeline', async () => {
      enablePackaging(blockedAnalysis());
      await renderModal('user');
      expect(fixButton()).not.toBeNull();
    });
  });

  it('shares a bundled pipeline snapshot without deleting it', async () => {
    await renderModal('bundled');
    await clickShare();

    expect(createSharedPackaged).toHaveBeenCalledTimes(1);
    const request = createSharedPackaged.mock.calls[0]?.[0];
    expect(request?.shareScope).toBe('private');
    expect(request?.rawPipeline).toContain('pipeline:');
    expect(request?.rawPipeline).toContain('name: Review Pipeline');
    expect(deletePipeline).not.toHaveBeenCalled();
    expect(onShared).toHaveBeenCalledWith({
      ...sharedDetail,
      publicShare: {
        externalId: 'public-pipeline-id',
        sharePath: '/portal/plugins/pipelines/shared/public-pipeline-id',
      },
    });
  });

  it('analyzes again instead of sharing an analysis that expired while open', async () => {
    const expired = makeAnalysis({ expiresAt: '2000-01-01T00:00:00.000Z' });
    if (!expired.manifest) throw new Error('Missing manifest fixture');
    expired.manifest = {
      ...expired.manifest,
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    enablePackaging(expired);
    await renderModal('user');
    expect(analyzePackage).toHaveBeenCalledTimes(1);
    await clickShare();
    expect(createSharedPackaged).not.toHaveBeenCalled();
    expect(createShared).not.toHaveBeenCalled();
    expect(analyzePackage).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      'Review the updated dependencies, then share again.',
    );
  });

  it('drops the recheck message when the fresh analysis fails', async () => {
    const expired = makeAnalysis({ expiresAt: '2000-01-01T00:00:00.000Z' });
    if (!expired.manifest) throw new Error('Missing manifest fixture');
    expired.manifest = {
      ...expired.manifest,
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    enablePackaging(expired);
    analyzePackage
      .mockResolvedValueOnce({ success: true, data: expired })
      .mockResolvedValueOnce({ success: false });
    await renderModal('user');

    await clickShare();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(analyzePackage).toHaveBeenCalledTimes(2);
    expect(createSharedPackaged).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Couldn't check the included files. Try again.",
    );
    expect(document.body.textContent).not.toContain(
      'Review the updated dependencies, then share again.',
    );
  });

  it('analyzes again when main rejects a stale analysis at share time', async () => {
    const staleMessage =
      'Dependency files changed since analysis. Review the updated dependency list before sharing.';
    createSharedPackaged.mockResolvedValueOnce({
      success: false,
      error: staleMessage,
    });
    await renderModal('user');
    expect(analyzePackage).toHaveBeenCalledTimes(1);

    await clickShare();

    expect(createSharedPackaged).toHaveBeenCalledTimes(1);
    expect(createShared).not.toHaveBeenCalled();
    expect(analyzePackage).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(staleMessage);
  });

  it('offers only packaged sharing and header dismissal', async () => {
    await renderModal('user');
    expect(
      document.querySelector('[data-testid="share-pipeline-definition-only"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-pipeline-cancel"]'),
    ).toBeNull();
    await clickShare();
    expect(createShared).not.toHaveBeenCalled();
    expect(createSharedPackaged).toHaveBeenCalledTimes(1);
  });

  it('blocks sharing when dependency analysis fails without a fallback', async () => {
    enablePackaging(null);
    await renderModal('user');
    expect(
      document.querySelector('[data-testid="share-pipeline-definition-only"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-submit"]',
      )?.disabled,
    ).toBe(true);
    expect(createShared).not.toHaveBeenCalled();
    expect(createSharedPackaged).not.toHaveBeenCalled();
  });

  it('reviews the private member closure and locks required rows on', async () => {
    enablePackaging(makeAnalysis());
    await renderModal('user');

    // Everything is required, so there is no file choice to open; the help
    // icon after the summary names the closure instead.
    expect(
      document.querySelector(
        '[data-testid="share-pipeline-dependencies-toggle"]',
      ),
    ).toBeNull();
    const help = includedFilesHelp();
    expect(help).toContain('/open-pr');
    // The transitive private support file is included even though no step
    // names it directly.
    expect(help).toContain('pr-template');
    expect(help).toContain('From private sources:');
    // Credentials are disclosed separately and never packaged.
    expect(help).toContain('Recipients set up: GitHub authentication');
    expect(help).toContain(
      'Credentials, private configuration, and other local files are never included.',
    );
  });

  it('shares a package without another acknowledgment and sends package mode', async () => {
    enablePackaging(makeAnalysis());
    await renderModal('user');

    expect(
      document.querySelector('[data-testid="share-pipeline-consent"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-submit"]',
      )?.disabled,
    ).toBe(false);

    await act(async () => {
      clickTestId('share-pipeline-submit');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createShared).not.toHaveBeenCalled();
    expect(createSharedPackaged).toHaveBeenCalledTimes(1);
    const request = createSharedPackaged.mock.calls[0]?.[0];
    expect(request?.distributionMode).toBe('package');
    expect(request?.analysisId).toBe('analysis-1');
  });

  it('asks for no acknowledgment after the sharing scope changes', async () => {
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        authMode: 'api_key',
        credentialSource: 'manual',
        capabilities: ['pipelines-crud-v1', 'teams-v1'],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
      }),
    });
    Object.assign(window.pipelines, {
      listSharedTeams: jest.fn().mockResolvedValue({
        success: true,
        data: { data: [{ id: 'team-1', name: 'Platform' }] },
      }),
    });
    enablePackaging(makeAnalysis());
    await renderModal('user');

    await act(async () => {
      clickTestId('share-pipeline-scope-team');
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="share-pipeline-consent"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('I understand');
  });

  it('includes a private transitive child of a selected public optional resource', async () => {
    const optionalAnalysis = makeAnalysis();
    if (!optionalAnalysis.manifest) throw new Error('expected manifest');
    optionalAnalysis.manifest = {
      ...optionalAnalysis.manifest,
      resources: [
        {
          ...optionalAnalysis.manifest.resources[0],
          id: 'public-root',
          displayName: 'Public root',
          sourceVisibility: 'public',
          dependencyResourceIds: ['private-child'],
        },
        {
          ...optionalAnalysis.manifest.resources[1],
          id: 'private-child',
          displayName: 'Private child',
          dependencyResourceIds: [],
        },
      ],
      bindings: [],
    };
    enablePackaging(optionalAnalysis);
    await renderModal('user');
    await expandDependencies();

    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="share-pipeline-dependencies-item-public-root"] input',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // The child travels with the selected root, so it reads as required.
    expect(
      document
        .querySelector(
          '[data-testid="share-pipeline-dependencies-item-private-child"]',
        )
        ?.getAttribute('data-required'),
    ).toBe('true');
    expect(
      document.querySelector('[data-testid="share-pipeline-consent"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-submit"]',
      )?.disabled,
    ).toBe(false);
  });

  it('shares a package even when analysis finds no local dependencies', async () => {
    const empty = makeAnalysis();
    if (!empty.manifest) throw new Error('expected analysis manifest');
    empty.manifest = {
      ...empty.manifest,
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    enablePackaging(empty);
    await renderModal('user');

    expect(includedFilesHelp()).toContain(
      'Only the workflow definition is shared.',
    );
    await clickShare();

    expect(createSharedPackaged).toHaveBeenCalledWith(
      expect.objectContaining({
        distributionMode: 'package',
      }),
    );
    expect(createShared).not.toHaveBeenCalled();
  });

  it('mentions dependency files in the public helper only when the package includes some', async () => {
    const empty = makeAnalysis();
    if (!empty.manifest) throw new Error('expected analysis manifest');
    empty.manifest = {
      ...empty.manifest,
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    enablePackaging(empty);
    await renderModal('user');
    await act(async () => {
      clickTestId('share-pipeline-scope-public');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'Anyone can view this workflow. It may appear in public discovery and search.',
    );
    expect(document.body.textContent).not.toContain(
      'download its included dependency files',
    );

    act(() => root.unmount());
    root = createRoot(container);
    enablePackaging(makeAnalysis());
    await renderModal('user');
    await act(async () => {
      clickTestId('share-pipeline-scope-public');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'Anyone can view this workflow and download its included dependency files.',
    );
  });

  it('blocks the package share while a blocker is unresolved', async () => {
    enablePackaging(
      makeAnalysis({
        state: 'blocked',
        blockers: [
          {
            code: 'MISSING_DEPENDENCY_SOURCE',
            subject: '/open-pr',
            message: 'The source for /open-pr is unavailable.',
            jobId: 'ship',
            stepId: 'open_pr',
            occurrences: [{ jobId: 'ship', stepId: 'open_pr' }],
          },
        ],
      }),
    );
    await renderModal('user');

    expect(document.body.textContent).toContain(
      '/open-pr is no longer on this machine',
    );
    expect(document.body.textContent).not.toContain('problem blocks');
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-submit"]',
      )?.disabled,
    ).toBe(true);
  });

  it('needs only Share after the window regains focus on a fixed package', async () => {
    enablePackaging(
      makeAnalysis({
        state: 'blocked',
        blockers: [
          {
            code: 'MISSING_DEPENDENCY_SOURCE',
            subject: '/open-pr',
            message: 'The source for /open-pr is unavailable.',
            occurrences: [{ jobId: 'ship', stepId: 'open_pr' }],
          },
        ],
      }),
    );
    await renderModal('user');

    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-submit"]',
      )?.disabled,
    ).toBe(true);

    analyzePackage.mockResolvedValue({
      success: true,
      data: makeAnalysis({ analysisId: 'analysis-after-recheck' }),
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="share-pipeline-consent"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-pipeline-submit"]',
      )?.disabled,
    ).toBe(false);
  });

  it('never claims there are no dependencies while problems are listed', async () => {
    enablePackaging(
      makeBlockedAnalysis([
        unresolvedBlocker('/collect.py', [
          { jobId: 'build', stepId: 'collect' },
        ]),
      ]),
    );
    await renderModal('user');

    expect(
      document.querySelector(
        '[data-testid="share-pipeline-dependencies-empty"]',
      ),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      'This pipeline has no local dependencies to copy.',
    );
  });

  it('groups repeated occurrences of one token into a single problem row', async () => {
    enablePackaging(
      makeBlockedAnalysis([
        unresolvedBlocker('/collect.py', [
          { jobId: 'build', stepId: 'collect' },
          { jobId: 'build', stepId: 'recollect' },
          { jobId: 'report', stepId: 'summarize' },
        ]),
      ]),
    );
    await renderModal('user');

    const problems = document.querySelector(
      '[data-testid="share-pipeline-dependency-problems"]',
    );
    expect(problems?.getAttribute('data-problem-count')).toBe('1');
    expect(
      document.querySelectorAll(
        '[data-testid^="share-pipeline-dependency-problems-item-"]',
      ).length,
    ).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('Used in 3 steps');
  });

  it('keeps the dependency list and recipient setup on a blocked analysis', async () => {
    enablePackaging(
      makeAnalysis({
        state: 'blocked',
        blockers: [
          unresolvedBlocker('/collect.py', [
            { jobId: 'build', stepId: 'collect' },
          ]),
        ],
      }),
    );
    await renderModal('user');

    const section = document.querySelector(
      '[data-testid="share-pipeline-dependencies"]',
    );
    // Blocked, the help icon follows the heading and still names what
    // resolved and what recipients set up.
    const help = includedFilesHelp();
    expect(help).toContain('/open-pr');
    expect(help).toContain('Recipients set up: GitHub authentication');
    expect(
      section?.querySelector(
        '[data-testid="share-pipeline-dependency-problems"]',
      ),
    ).not.toBeNull();
  });

  it.each([
    'SUSPECTED_SECRET',
    'SYMLINK_BLOCKED',
    'SOURCE_PATH_ESCAPE',
    'EXPORT_DENIED_FILE',
    'NATIVE_EXECUTABLE_BLOCKED',
    'OPAQUE_EXECUTABLE_BLOCKED',
    'MISSING_DEPENDENCY_SOURCE',
    'AMBIGUOUS_INVOCATION',
    'PACKAGE_LIMIT_EXCEEDED',
    'INVALID_PACKAGE',
  ] as const)('offers no dismiss control for %s', async (code) => {
    enablePackaging(
      makeBlockedAnalysis([
        {
          code,
          subject: 'skills/deploy/SKILL.md',
          message: 'A dependency file may contain a credential.',
          occurrences: [{ jobId: 'ship', stepId: 'open_pr' }],
        },
      ]),
    );
    await renderModal('user');

    const row = document.querySelector('[data-code]');
    expect(row?.getAttribute('data-dismissible')).toBe('false');
    expect(
      document.querySelector(
        '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
      ),
    ).toBeNull();
  });

  it('marks a token as not a command and re-analyzes with the dismissal', async () => {
    enablePackaging(
      makeBlockedAnalysis([
        unresolvedBlocker('/collect.py', [
          { jobId: 'build', stepId: 'collect' },
        ]),
      ]),
    );
    await renderModal('user');

    expect(analyzePackage).toHaveBeenCalledTimes(1);
    expect(
      analyzePackage.mock.calls[0]?.[0]?.dismissedInvocations,
    ).toBeUndefined();

    analyzePackage.mockResolvedValue({
      success: true,
      data: makeAnalysis({
        dismissedInvocations: [{ provider: 'claude', token: '/collect.py' }],
      }),
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(analyzePackage).toHaveBeenCalledTimes(2);
    expect(analyzePackage.mock.calls[1]?.[0]?.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/collect.py' },
    ]);
    expect(document.body.textContent).toContain('Marked as not commands (1)');
  });

  it('re-analyzes with a dismissed child pipeline reference', async () => {
    const dismissal = {
      kind: 'child_pipeline_ref' as const,
      token: '${{ inputs.target }}',
    };
    enablePackaging(
      makeBlockedAnalysis([
        {
          code: 'UNRESOLVED_CHILD_PIPELINE_REF',
          subject: '${{ inputs.target }}',
          message:
            'Step "run" picks its child pipeline from ${{ inputs.target }}.',
          jobId: 'build',
          stepId: 'run',
          occurrences: [{ jobId: 'build', stepId: 'run' }],
          referenceDismissal: dismissal,
        },
      ]),
    );
    await renderModal('user');
    expect(
      analyzePackage.mock.calls[0]?.[0]?.dismissedReferences,
    ).toBeUndefined();

    analyzePackage.mockResolvedValue({
      success: true,
      data: makeAnalysis({ dismissedReferences: [dismissal] }),
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(analyzePackage).toHaveBeenCalledTimes(2);
    expect(analyzePackage.mock.calls[1]?.[0]?.dismissedReferences).toEqual([
      dismissal,
    ]);
  });

  it('keeps the dependency section after the last blocker is dismissed', async () => {
    // Regression: `packagingRelevant` used to ignore dismissals, so dismissing
    // the last blocker left zero resources, zero requirements, and zero
    // blockers — unmounting the section along with the "1 dismissed"
    // acknowledgement and its undo the instant the author acted.
    enablePackaging(
      makeBlockedAnalysis([
        unresolvedBlocker('/collect.py', [
          { jobId: 'build', stepId: 'collect' },
        ]),
      ]),
    );
    await renderModal('user');

    analyzePackage.mockResolvedValue({
      success: true,
      data: makeAnalysis({
        blockers: [],
        manifest: {
          version: 1,
          pipelineContentHash: 'b'.repeat(64),
          resources: [],
          bindings: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
        dismissedInvocations: [{ provider: 'claude', token: '/collect.py' }],
      }),
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Marked as not commands (1)');
    expect(
      document.querySelector('[data-testid="share-pipeline-definition-only"]'),
    ).toBeNull();
  });

  it('does not carry a draft dismissal into a changed document scope', async () => {
    const blocked = makeBlockedAnalysis([
      unresolvedBlocker('/collect.py', [{ jobId: 'build', stepId: 'collect' }]),
    ]);
    enablePackaging(blocked);
    await renderModal('bundled', undefined, {
      ...pipeline,
      description: 'Mention /collect.py before editing.',
    });

    analyzePackage.mockResolvedValue({
      success: true,
      data: makeAnalysis({
        dismissedInvocations: [{ provider: 'claude', token: '/collect.py' }],
      }),
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(analyzePackage.mock.calls[1]?.[0]?.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/collect.py' },
    ]);

    const firstChangedDocumentCall = analyzePackage.mock.calls.length;
    analyzePackage.mockResolvedValue({ success: true, data: blocked });
    await renderModal('bundled', undefined, {
      ...pipeline,
      description: 'Mention /collect.py after editing.',
    });

    expect(
      analyzePackage.mock.calls[firstChangedDocumentCall]?.[0]
        ?.dismissedInvocations,
    ).toBeUndefined();
  });

  it('stops re-sending a dismissal main pruned from its echo', async () => {
    enablePackaging(
      makeBlockedAnalysis([
        unresolvedBlocker('/collect.py', [
          { jobId: 'build', stepId: 'collect' },
        ]),
      ]),
    );
    await renderModal('user');
    expect(analyzePackage).toHaveBeenCalledTimes(1);

    // Main suppressed nothing for this token — it is no longer in the
    // document — so its echo is empty and is the authority.
    analyzePackage.mockResolvedValue({
      success: true,
      data: makeAnalysis({ dismissedInvocations: [] }),
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid^="share-pipeline-dependency-problems-dismiss-"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
    });

    expect(analyzePackage.mock.calls[1]?.[0]?.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/collect.py' },
    ]);
    // The pruned token is dropped from the outgoing list rather than queued
    // for every later analysis, where it would silently re-suppress itself.
    expect(analyzePackage).toHaveBeenCalledTimes(3);
    expect(analyzePackage.mock.calls[2]?.[0]?.dismissedInvocations).toEqual([]);
    expect(document.body.textContent).not.toContain('Marked as not commands');
  });

  it('offers Retry when analysis fails', async () => {
    enablePackaging(null);
    await renderModal('user');
    expect(document.body.textContent).toContain(
      "Couldn't check the included files. Try again.",
    );
    expect(
      document.querySelector('[data-testid="share-pipeline-definition-only"]'),
    ).toBeNull();
    expect(createShared).not.toHaveBeenCalled();
  });

  it('shows the reason main gave when dependency analysis fails', async () => {
    enablePackaging(null);
    analyzePackage.mockResolvedValue({
      success: false,
      error: 'modelId must be a non-empty model identifier without whitespace',
    });
    await renderModal('user');

    expect(document.body.textContent).toContain(
      "Couldn't check the included files. Try again.",
    );
    expect(
      document.querySelector(
        '[data-testid="share-pipeline-dependencies-error-reason"]',
      )?.textContent,
    ).toBe(
      'Details: modelId must be a non-empty model identifier without whitespace',
    );
  });

  it('shows only the generic failure when main gives no reason', async () => {
    enablePackaging(null);
    await renderModal('user');

    expect(document.body.textContent).toContain(
      "Couldn't check the included files. Try again.",
    );
    expect(
      document.querySelector(
        '[data-testid="share-pipeline-dependencies-error-reason"]',
      ),
    ).toBeNull();
  });

  it('keeps the local user pipeline after sharing it', async () => {
    await renderModal('user');
    await clickShare();

    expect(deletePipeline).not.toHaveBeenCalled();
    expect(onShared).toHaveBeenCalledWith({
      ...sharedDetail,
      publicShare: {
        externalId: 'public-pipeline-id',
        sharePath: '/portal/plugins/pipelines/shared/public-pipeline-id',
      },
    });
    // The dialog stays open on its success notice instead of toasting.
    expect(mockPostShareToast).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-pipeline-success"]'),
    ).not.toBeNull();
  });

  it('renders a copyable member-only link after sharing with an organization', async () => {
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        authMode: 'api_key',
        credentialSource: 'manual',
        capabilities: ['pipelines-crud-v1', 'organizations-v1'],
        storageAvailable: true,
        account: {
          id: 'account-1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
      }),
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue('https://cloud.example.test'),
    });
    Object.assign(window.pipelines, {
      listSharedOrganizations: jest.fn().mockResolvedValue({
        success: true,
        data: {
          data: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Acme',
            },
          ],
        },
      }),
    });

    await renderModal('user');
    await act(async () => {
      document
        .querySelector('[data-testid="share-pipeline-scope-organization"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="share-pipeline-organization-picker"] input[type="search"]',
        )
        ?.getAttribute('placeholder'),
    ).toBe('Search organizations…');
    await act(async () => {
      document
        .querySelector(
          '[data-testid="share-pipeline-organization-picker-option-22222222-2222-4222-8222-222222222222"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await clickShare();

    expect(createSharedPackaged).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'organization',
        organizationId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    expect(mockPostShareToast).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-pipeline-success"]')
        ?.textContent,
    ).toContain('Workflow shared with Acme');
    expect(
      document.querySelector('[data-testid="share-pipeline-link"]')
        ?.textContent,
    ).toBe(
      'https://cloud.example.test/portal/plugins/pipelines/shared/shared-pipeline-1',
    );
    expect(onShared).toHaveBeenCalledWith(sharedDetail);
  });
});
