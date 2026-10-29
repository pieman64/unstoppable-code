import * as installContext from '../pipeline-install-context';
import * as pipelinePaths from '@canopy/desktop-shared/pipelines/config-paths';
import {
  saveStoredPipeline,
  deleteStoredPipeline,
  getStoredPipelinePath,
  listStoredPipelines,
} from '@canopy/desktop-shared/pipelines/store';
import { createResourceInstallReceiptsStore } from '../../lib/resource-install-receipts';
jest.mock('../../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemUninstall: jest.fn(),
}));
import { recordSharedItemInstall } from '../../canopy-cloud/shared-item-subscriptions';
let mockReceiptDataDir = '';
let mockInstallContextEnabled = false;
let mockInstallContextRevision = 'original';
jest.mock('../resource-lanes', () => ({
  assertPipelineContext: jest.fn(() => Promise.resolve()),
  pipelineResourceContextEnabled: jest.fn(() => mockInstallContextEnabled),
  pipelineContextSnapshot: jest.fn(() =>
    Promise.resolve(mockInstallContextRevision),
  ),
  assertPipelineContextSnapshot: jest.fn((snapshot: string) =>
    snapshot !== mockInstallContextRevision
      ? Promise.reject(new Error('Pipeline unavailable (context-mismatch)'))
      : Promise.resolve(),
  ),
}));
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as DesktopSharedNodeModule from '@canopy/desktop-shared/node';

jest.mock('../../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'user-a' } } }),
  ),
}));
jest.mock('@canopy/desktop-shared/node', () => {
  const actual = jest.requireActual<typeof DesktopSharedNodeModule>(
    '@canopy/desktop-shared/node',
  );
  return {
    ...actual,
    analyzeCapabilityPackage: jest.fn(actual.analyzeCapabilityPackage),
    analyzePipelinePackage: jest.fn(actual.analyzePipelinePackage),
    installPipelinePackageAtomically: jest.fn(),
    verifyCachedPipelinePackage: jest.fn(actual.verifyCachedPipelinePackage),
  };
});
jest.mock('../../canopy-cloud/public-share-client', () => ({
  getPublicPipelineShareSnapshot: jest.fn(),
}));
jest.mock('../canopy-server-client', () => ({
  PACKAGE_REQUEST_TIMEOUT_MS: 30_000,
  commitPipelinePackageUpload: jest.fn(),
  createSharedPipeline: jest.fn(),
  authorizeSharedPipelineCreate: jest.fn(),
  getPublicPipelinePackage: jest.fn(),
  getPublicPipelinePackageBlob: jest.fn(),
  getSharedPipeline: jest.fn(),
  getPipelinePackage: jest.fn(),
  getPipelinePackageBlob: jest.fn(),
  getAutomationPackage: jest.fn(),
  getAutomationPackageBlob: jest.fn(),
  getPublicAutomationPackage: jest.fn(),
  getPublicAutomationPackageBlob: jest.fn(),
  getCuratedAutomationPackage: jest.fn(),
  getCuratedAutomationPackageBlob: jest.fn(),
  preparePipelinePackageUpload: jest.fn(),
  updateSharedPipeline: jest.fn(),
  uploadPipelinePackageBlob: jest.fn(),
}));
jest.mock('../pipeline-service', () => ({
  deletePipeline: jest.fn(),
  getPipeline: jest.fn(),
  getPipelinePath: jest.fn(),
  getPipelineText: jest.fn(),
  listPipelines: jest.fn(),
  savePipeline: jest.fn(),
}));
jest.mock('../pipeline-package-install-store', () => ({
  findCapabilityPackageInstallByOwner: jest.fn(),
  findPipelinePackageInstall: jest.fn(),
  listPipelinePackageInstalls: jest.fn(),
  removePipelinePackageInstall: jest.fn(),
  upsertCapabilityPackageInstall: jest.fn(),
  upsertPipelinePackageInstall: jest.fn(),
}));
jest.mock('../pipeline-package-dismissal-store', () => ({
  listPipelinePackageDismissals: jest.fn(),
  replacePipelinePackageDismissals: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getDataDir: jest.fn(() => mockReceiptDataDir),
  getPipelinePackageDismissalStorePath: jest.fn(
    () => '/tmp/dismissal-store.json',
  ),
  getPipelinePackageInstallStorePath: jest.fn(() => '/tmp/install-store.json'),
  getPipelinePackagesDir: jest.fn(() => '/tmp/pipeline-packages'),
}));
jest.mock('../pipeline-local-metadata-store', () => ({
  deleteUserPipelineLocalMetadata: jest.fn(),
  readPipelineLocalMetadata: jest.fn(() => ({})),
  recordUserPipelineOwner: jest.fn(),
  setUserPipelineAgentAuthor: jest.fn(),
}));
jest.mock('../pipeline-owner-policy', () => ({
  getUserPipelineOwner: jest.fn(() => Promise.resolve('personal')),
  selectedOwnerContext: jest.fn(() => Promise.resolve('personal')),
}));
import {
  deleteUserPipelineLocalMetadata,
  recordUserPipelineOwner,
} from '../pipeline-local-metadata-store';
import { selectedOwnerContext } from '../pipeline-owner-policy';
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
jest.mock('../../agents/project-slash-command-discovery', () => ({
  discoverProjectInvocableSources: jest.fn(),
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  loadPipelinePackageInventorySources: jest.fn(),
}));
jest.mock('../../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: jest.fn(),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: jest.fn(),
  getCachedCodexAuthStatusObserved: jest.fn(),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  getAiCreditsRoutingContextWithStatus: jest.fn(),
}));
jest.mock('../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> => mockCursorAvailable(),
}));
const mockCursorAvailable = jest.fn<Promise<boolean>, []>(() =>
  Promise.resolve(false),
);

import type {
  Pipeline,
  PipelinePackageInvocationDismissal,
  PipelineShareSource,
  SharedPipelineDetail,
} from '@canopy/desktop-shared/types/pipeline';
import { initCodexModels } from '@canopy/desktop-shared/types';
import {
  buildPipelineCapabilityPackageSources,
  hashPipelinePackageYaml,
  analyzeCapabilityPackage,
  analyzePipelinePackage,
  computePipelinePackageDigestSync,
  installPipelinePackageAtomically,
  verifyCachedPipelinePackage,
} from '@canopy/desktop-shared/node';
import type { PipelinePackageEnvironmentRequirement } from '@canopy/protocol/pipelines';
import { getPublicPipelineShareSnapshot } from '../../canopy-cloud/public-share-client';
import {
  commitPipelinePackageUpload,
  createSharedPipeline,
  authorizeSharedPipelineCreate,
  getAutomationPackage,
  getCuratedAutomationPackage,
  getPublicPipelinePackage,
  getPipelinePackage,
  getSharedPipeline,
  preparePipelinePackageUpload,
  updateSharedPipeline,
} from '../canopy-server-client';
import * as localPipelineService from '../pipeline-service';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { shareFailureFromError } from '../../sharing/share-operation-result';
import {
  findCapabilityPackageInstallByOwner,
  findPipelinePackageInstall,
  listPipelinePackageInstalls,
  removePipelinePackageInstall,
  upsertCapabilityPackageInstall,
  upsertPipelinePackageInstall,
} from '../pipeline-package-install-store';
import {
  listPipelinePackageDismissals,
  replacePipelinePackageDismissals,
} from '../pipeline-package-dismissal-store';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import { discoverProjectInvocableSources } from '../../agents/project-slash-command-discovery';
import { loadPipelinePackageInventorySources } from '../../plugins/invocable-inventory-service';
import { resolveEffectivePluginSelectionRefs } from '../../plugins/plugin-resolver';
import {
  getCachedClaudeAuthStatusObserved,
  getCachedCodexAuthStatusObserved,
} from '../../auth/provider-auth-state';
import { getAiCreditsRoutingContextWithStatus } from '../../agents/ai-credits-routing';
import {
  copyPackageInstall,
  analyzeAutomationCapabilityPackage,
  analyzePackageRequest,
  analyzeSkillCapabilityPackage,
  analyzeSubjectCapabilityPackage,
  createPackagedAutomationCapabilityPackage,
  createPackagedSharedPipeline,
  evaluatePipelinePackageRequirements,
  getPackageReadiness,
  getAutomationCapabilityPackageReadiness,
  getSharedPipelineAutomationInstallPin,
  installAutomationCapabilityPackage,
  installPublicPackageShare,
  resolveInstalledAutomationPackageOverlay,
  resolveInstalledAutomationPipelinePackage,
  resolvePipelinePackageProviderByStep,
  selectPipelinePackageManifest,
  SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE,
  updateSharedPipelinePreservingPackage,
  verifySharedPipelineAutomationInstallPin,
} from '../pipeline-package-service';

/** Matches request options that carry a bounded per-request timeout. */
function withRequestTimeout(): unknown {
  const timeoutMs: unknown = expect.any(Number);
  return expect.objectContaining({ timeoutMs });
}

describe('pipeline package analysis requests', () => {
  const rawPipeline = [
    'name: Example',
    'on: dispatch',
    'jobs:',
    '  review:',
    '    steps:',
    '      - id: run',
    '        uses: builtin/agent-prompt',
    '        with:',
    '          prompt: Run /repair-diffs.',
    '',
  ].join('\n');

  const readyAnalysis = (
    analysisId: string,
    dismissedInvocations: PipelinePackageInvocationDismissal[],
  ): DesktopSharedNodeModule.PipelinePackageAnalysisInternal => {
    const pipelineContentHash = hashPipelinePackageYaml(rawPipeline);
    return {
      summary: {
        analysisId,
        state: 'ready' as const,
        pipelineContentHash,
        manifest: {
          version: 1 as const,
          pipelineContentHash,
          resources: [],
          bindings: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
        blockers: [],
        dismissedInvocations,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      optionalBindings: [],
      blobs: new Map<string, Uint8Array>(),
      sourceStats: [],
      sourceDirectories: [],
    };
  };

  afterEach((): void => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallContextEnabled = false;
    jest.mocked(authorizeSharedPipelineCreate).mockReset();
    jest.mocked(loadPipelinePackageInventorySources).mockResolvedValue({
      inventory: { version: 2, builtAt: new Date().toISOString(), entries: [] },
      sources: {},
    });
    jest.mocked(resolveWorktreeCwd).mockReturnValue('/tmp/project');
    jest.mocked(discoverProjectInvocableSources).mockResolvedValue({
      entries: [
        {
          name: 'repair-diffs',
          kind: 'command',
          absolutePath: '/tmp/project/.claude/commands/repair-diffs.md',
        },
      ],
      scannedDirectories: ['/tmp/project/.claude/commands'],
    });
    jest.mocked(listPipelinePackageDismissals).mockResolvedValue([]);
    jest.mocked(replacePipelinePackageDismissals).mockResolvedValue();
    jest
      .mocked(resolveEffectivePluginSelectionRefs)
      .mockImplementation((selections) =>
        Promise.resolve({
          skillRefs: selections.skillRefs,
          pluginRefs: selections.pluginRefs,
          mcpServerRefs: selections.mcpServerRefs ?? [],
          warnings: [],
        }),
      );
  });

  it('keeps agent recheck dismissals transient for skills and pipelines', async () => {
    const dismissedInvocations: PipelinePackageInvocationDismissal[] = [
      { provider: 'claude', token: '/ignored' },
    ];
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(
        readyAnalysis('transient-skill', dismissedInvocations),
      );
    jest
      .mocked(analyzePipelinePackage)
      .mockResolvedValueOnce(
        readyAnalysis('transient-pipeline', dismissedInvocations),
      );
    await analyzeSkillCapabilityPackage(
      {
        sourceId: 'custom:app',
        skillName: 'repair',
        rawSkill: 'Run /ignored',
        dismissedInvocations,
      },
      { persistDismissals: false },
    );
    await analyzePackageRequest(
      { rawPipeline, pipelineId: 'local-repair', dismissedInvocations },
      { persistDismissals: false },
    );
    expect(
      jest.mocked(analyzeCapabilityPackage).mock.calls.at(-1)?.[0]
        .dismissedInvocations,
    ).toEqual(dismissedInvocations);
    expect(
      jest.mocked(analyzePipelinePackage).mock.calls.at(-1)?.[0]
        .dismissedInvocations,
    ).toEqual(dismissedInvocations);
    expect(replacePipelinePackageDismissals).not.toHaveBeenCalled();
  });

  it('does not let a transient agent check supersede an in-flight dialog check', async () => {
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish: (
      analysis: DesktopSharedNodeModule.PipelinePackageAnalysisInternal,
    ) => void = () => undefined;
    const pending =
      new Promise<DesktopSharedNodeModule.PipelinePackageAnalysisInternal>(
        (resolve) => {
          finish = resolve;
        },
      );
    jest
      .mocked(analyzePipelinePackage)
      .mockImplementationOnce(() => {
        entered();
        return pending;
      })
      .mockResolvedValueOnce(readyAnalysis('agent', []));
    const dialog = analyzePackageRequest({
      rawPipeline,
      pipelineId: 'same-pipeline',
      dismissedInvocations: [],
    });
    await started;
    await analyzePackageRequest(
      { rawPipeline, pipelineId: 'same-pipeline', dismissedInvocations: [] },
      { persistDismissals: false },
    );
    finish(readyAnalysis('dialog', []));
    await dialog;
    // The dialog's input and its pruned result are both durably applied.
    expect(replacePipelinePackageDismissals).toHaveBeenCalledTimes(2);
  });

  it('packages a skill as a whole-share subject and scans its body', async () => {
    jest.mocked(loadPipelinePackageInventorySources).mockResolvedValue({
      inventory: {
        version: 2,
        builtAt: new Date().toISOString(),
        entries: [
          {
            id: 'entry-skill',
            provider: 'claude',
            kind: 'standalone_skill',
            invocationKey: '/campaign-brief',
            displayName: 'Campaign brief',
            sourceLabel: 'custom:app',
            enableRef: {
              kind: 'skill',
              sourceId: 'custom:app',
              skillName: 'campaign-brief',
            },
          },
        ],
      },
      sources: {},
    });
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(readyAnalysis('skill-analysis', []));

    const rawSkill = [
      '---',
      'name: campaign-brief',
      '---',
      '',
      'Run /repair-diffs, then call mcp__slack__send.',
      '',
    ].join('\n');

    await analyzeSkillCapabilityPackage({
      sourceId: 'custom:app',
      skillName: 'campaign-brief',
      rawSkill,
    });

    const request = jest.mocked(analyzeCapabilityPackage).mock.calls[0]?.[0];
    // The skill being shared is itself a packaged resource, bound to the whole
    // share rather than to a synthetic step.
    expect(request?.requests).toEqual([
      {
        key: 'skill:custom:app:campaign-brief',
        provider: 'claude',
        required: true,
        bindingKey: '\0subject',
      },
      {
        key: 'skill:custom:app:campaign-brief',
        provider: 'codex',
        required: true,
        bindingKey: '\0subject',
      },
    ]);
    expect(request?.capabilityInventoryEntryIdsByKey).toEqual({
      'skill:custom:app:campaign-brief': ['entry-skill'],
    });
    // The body is a prompt source, so an invoked sibling skill is packaged
    // transitively exactly as a pipeline step's prompt would package it.
    expect(request?.promptSources).toEqual([
      { target: 'subject', provider: 'claude', text: rawSkill },
    ]);
    // Extracted MCP/plugin names become requirements instead of being
    // display-only names on a web page.
    expect(request?.environmentRequirements).toEqual([
      {
        id: 'mcp-slack',
        kind: 'mcp',
        displayName: 'Slack',
        required: false,
        affectedSteps: [],
        setupHint: 'Connect the Slack MCP server in Settings.',
      },
    ]);
  });

  it('turns common analysis into a non-packaging reference review', async () => {
    const internal = readyAnalysis('reference-analysis', []);
    internal.summary.state = 'blocked';
    internal.summary.blockers = [
      {
        code: 'UNRESOLVED_INVOCATION',
        message: 'A local file could not be packaged.',
        occurrences: [],
      },
    ];
    const manifest = internal.summary.manifest;
    if (!manifest) throw new Error('Expected test manifest');
    manifest.environmentRequirements = [
      {
        id: 'github',
        kind: 'connector',
        displayName: 'GitHub',
        required: true,
        affectedSteps: [],
        setupHint: 'Connect GitHub.',
      },
    ];
    jest.mocked(analyzeCapabilityPackage).mockResolvedValueOnce(internal);

    await expect(
      analyzeSubjectCapabilityPackage({
        rawContent: '{}',
        scopeKey: 'plugin-reference:test',
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        mode: 'reference',
      }),
    ).resolves.toMatchObject({
      state: 'ready',
      blockers: [],
      manifest: {
        resources: [],
        bindings: [],
        environmentRequirements: [expect.objectContaining({ id: 'github' })],
        totalFiles: 0,
        totalBytes: 0,
      },
    });
  });

  it('expands collection selections before producing automation capability requests', async () => {
    jest.mocked(resolveEffectivePluginSelectionRefs).mockResolvedValueOnce({
      skillRefs: [{ sourceId: 'collection-source', skillName: 'review' }],
      pluginRefs: [
        { marketplaceId: 'collection-marketplace', pluginName: 'release' },
      ],
      mcpServerRefs: [{ serverId: 'server-1', configId: 'config-1' }],
      warnings: ['Collection "missing" was not found.'],
    });
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(readyAnalysis('automation-analysis', []));

    const result = await analyzeAutomationCapabilityPackage({
      rawContent: '{"version":1}',
      selections: {
        collectionIds: ['collection-1'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });

    expect(resolveEffectivePluginSelectionRefs).toHaveBeenCalledWith({
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });
    const request = jest.mocked(analyzeCapabilityPackage).mock.calls[0]?.[0];
    expect(request?.requests).toEqual([
      {
        key: 'skill:collection-source:review',
        provider: 'claude',
        required: true,
        bindingKey: 'automation\0action',
      },
      {
        key: 'skill:collection-source:review',
        provider: 'codex',
        required: true,
        bindingKey: 'automation\0action',
      },
      {
        key: 'plugin:collection-marketplace:release',
        provider: 'claude',
        required: true,
        bindingKey: 'automation\0action',
      },
      {
        key: 'plugin:collection-marketplace:release',
        provider: 'codex',
        required: true,
        bindingKey: 'automation\0action',
      },
    ]);
    expect(result.unpackageableSelectionLabels).toEqual([
      'server-1',
      'Collection "missing" was not found.',
    ]);
  });

  it('scans the automation prompt for invocations and forwards dismissals', async () => {
    jest.mocked(listPipelinePackageDismissals).mockResolvedValueOnce([
      {
        scopeKey: 'automation:activity-1',
        provider: 'claude',
        token: '/ignored',
        dismissedAt: '2026-09-17T12:00:00.000Z',
      },
    ]);
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(readyAnalysis('automation-prompt-analysis', []));

    await analyzeAutomationCapabilityPackage({
      rawContent: '{"version":1}',
      promptText: 'Say hello with /invalid-skill name',
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      dismissedInvocations: [{ provider: 'claude', token: '/ignored' }],
      activityId: 'activity-1',
    });

    const request = jest.mocked(analyzeCapabilityPackage).mock.calls[0]?.[0];
    expect(request?.promptSources).toEqual([
      {
        jobId: 'automation',
        stepId: 'action',
        provider: 'claude',
        text: 'Say hello with /invalid-skill name',
      },
    ]);
    expect(request?.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/ignored' },
    ]);
  });

  it('adds repo-local invocables and persists automation dismissals by worktree scope', async () => {
    const recordsByScope = new Map<
      string,
      Array<{ provider: 'claude' | 'codex'; token: string }>
    >();
    jest
      .mocked(replacePipelinePackageDismissals)
      .mockImplementation((_storePath, scopeKey, records) => {
        recordsByScope.set(scopeKey, records);
        return Promise.resolve();
      });
    jest
      .mocked(listPipelinePackageDismissals)
      .mockImplementation((_storePath, scopeKey) =>
        Promise.resolve(
          (recordsByScope.get(scopeKey) ?? []).map((record) => ({
            scopeKey,
            ...record,
            dismissedAt: '2026-09-17T12:00:00.000Z',
          })),
        ),
      );
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(
        readyAnalysis('automation-worktree', [
          { provider: 'claude', token: '/still-mentioned' },
        ]),
      );

    await analyzeAutomationCapabilityPackage({
      rawContent: '{"version":1}',
      activityId: 'activity-1',
      worktree: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
      },
      promptText: 'Run /repair-diffs and /still-mentioned.',
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      dismissedInvocations: [
        { provider: 'claude', token: '/still-mentioned' },
        { provider: 'claude', token: '/deleted-token' },
      ],
    });

    const request = jest.mocked(analyzeCapabilityPackage).mock.calls[0]?.[0];
    expect(resolveWorktreeCwd).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'repo-1',
    );
    expect(request?.repoLocalInvocables?.entries[0]?.invocationKey).toBe(
      '/repair-diffs',
    );
    expect(request?.dismissedInvocations).toEqual([
      { provider: 'claude', token: '/still-mentioned' },
      { provider: 'claude', token: '/deleted-token' },
    ]);
    expect(replacePipelinePackageDismissals).toHaveBeenLastCalledWith(
      '/tmp/dismissal-store.json',
      'worktree:project-1:worktree-1:repo-1:automation:activity-1',
      [{ provider: 'claude', token: '/still-mentioned' }],
    );
  });

  it('analyzes a bundled pipeline prompt under its real step binding', async () => {
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(readyAnalysis('automation-pipeline', []));

    await analyzeAutomationCapabilityPackage({
      rawContent: '{"version":1}',
      pipelineContent: rawPipeline,
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });

    const request = jest.mocked(analyzeCapabilityPackage).mock.calls[0]?.[0];
    expect(request?.rawContent).toBe(rawPipeline);
    expect(request?.promptSources).toContainEqual({
      jobId: 'review',
      stepId: 'run',
      provider: 'claude',
      text: 'Run /repair-diffs.',
    });
    expect(request?.promptSources).not.toContainEqual(
      expect.objectContaining({ jobId: 'automation', stepId: 'action' }),
    );
  });

  it('keeps bundled pipeline environment requirements', async () => {
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(readyAnalysis('automation-requirements', []));
    const pipelineWithDependencies = rawPipeline.replace(
      'jobs:',
      [
        'dependencies:',
        '  - id: linear',
        '    kind: mcp',
        '    server:',
        '      catalog_id: linear',
        '    required: true',
        '    steps: [run]',
        'jobs:',
      ].join('\n'),
    );

    await analyzeAutomationCapabilityPackage({
      rawContent: '{"version":1}',
      pipelineContent: pipelineWithDependencies,
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });

    expect(
      jest.mocked(analyzeCapabilityPackage).mock.calls[0]?.[0]
        .environmentRequirements,
    ).toEqual([
      expect.objectContaining({
        id: 'linear',
        kind: 'mcp',
        affectedSteps: [{ jobId: 'review', stepId: 'run' }],
      }),
    ]);
  });

  it('keeps a child pipeline step unconfirmed under the parent step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-child-model-'));
    try {
      await writeFile(
        join(root, 'child.yaml'),
        [
          'name: Child',
          'on: dispatch',
          'jobs:',
          '  child:',
          '    steps:',
          '      - id: review',
          '        uses: builtin/agent-prompt',
          '        with:',
          '          model: ${{ needs.pick.outputs.model }}',
          '          prompt: Run /campaign-brief.',
          '',
        ].join('\n'),
        'utf8',
      );
      jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
        success: true,
        data: join(root, 'parent.yaml'),
      });

      await analyzePackageRequest({
        pipelineId: 'parent',
        rawPipeline: [
          'name: Parent',
          'on: dispatch',
          'jobs:',
          '  run:',
          '    steps:',
          '      - id: child',
          '        uses: builtin/run-pipeline',
          '        with:',
          '          pipeline: child.yaml',
          '',
        ].join('\n'),
      });

      // The child's model can't be resolved, so its Codex prompt is analyzed
      // unconfirmed, as it would be on a step of the parent itself.
      expect(
        jest.mocked(analyzePipelinePackage).mock.calls[0]?.[0]
          .additionalPromptSources,
      ).toEqual([
        {
          jobId: 'run',
          stepId: 'child',
          provider: 'claude',
          text: 'Run /campaign-brief.',
        },
        {
          jobId: 'run',
          stepId: 'child',
          provider: 'codex',
          text: 'Run /campaign-brief.',
          unconfirmed: true,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('analyzes child pipeline requirements recursively under the parent step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-child-'));
    const childPath = join(root, 'child.yaml');
    try {
      await writeFile(
        childPath,
        [
          'name: Child',
          'on: dispatch',
          'dependencies:',
          '  - id: linear',
          '    kind: mcp',
          '    server:',
          '      catalog_id: linear',
          '    required: true',
          'jobs:',
          '  child:',
          '    steps:',
          '      - run: echo child',
          '',
        ].join('\n'),
        'utf8',
      );
      jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
        success: true,
        data: join(root, 'parent.yaml'),
      });
      const parent = [
        'name: Parent',
        'on: dispatch',
        'jobs:',
        '  run:',
        '    steps:',
        '      - id: child',
        '        uses: builtin/run-pipeline',
        '        with:',
        '          pipeline: child.yaml',
        '',
      ].join('\n');

      const result = await analyzePackageRequest({
        pipelineId: 'parent',
        rawPipeline: parent,
      });

      expect(result.manifest?.environmentRequirements).toContainEqual(
        expect.objectContaining({
          id: 'linear',
          kind: 'mcp',
          affectedSteps: [{ jobId: 'run', stepId: 'child' }],
        }),
      );
      expect(result.manifest?.resources).toContainEqual(
        expect.objectContaining({
          kind: 'child_pipeline',
          invocationKeys: ['child.yaml'],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('packages a repo-local automation command only with worktree context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canopy-automation-repo-'));
    const commandPath = join(root, '.claude', 'commands', 'repair-diffs.md');
    try {
      await mkdir(join(root, '.claude', 'commands'), { recursive: true });
      await writeFile(commandPath, '# Repair diffs\n', 'utf8');
      jest.mocked(resolveWorktreeCwd).mockReturnValue(root);
      jest.mocked(discoverProjectInvocableSources).mockResolvedValue({
        entries: [
          { name: 'repair-diffs', kind: 'command', absolutePath: commandPath },
        ],
        scannedDirectories: [join(root, '.claude', 'commands')],
      });

      const withContext = await analyzeAutomationCapabilityPackage({
        rawContent: '{"version":1}',
        worktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
        promptText: 'Run /repair-diffs.',
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      });
      expect(withContext.state).toBe('ready');
      expect(withContext.manifest.resources).toEqual([
        expect.objectContaining({ kind: 'plugin_command' }),
      ]);
      expect(withContext.manifest.bindings).toEqual([
        expect.objectContaining({ jobId: 'automation', stepId: 'action' }),
      ]);

      const withoutContext = await analyzeAutomationCapabilityPackage({
        rawContent: '{"version":1,"copy":2}',
        promptText: 'Run /repair-diffs.',
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      });
      expect(withoutContext.state).toBe('blocked');
      expect(withoutContext.blockers).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_INVOCATION',
          subject: '/repair-diffs',
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds repo-local commands from bundled pipeline steps to the real step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canopy-pipeline-repo-'));
    const commandPath = join(root, '.claude', 'commands', 'repair-diffs.md');
    try {
      await mkdir(join(root, '.claude', 'commands'), { recursive: true });
      await writeFile(commandPath, '# Repair diffs\n', 'utf8');
      jest.mocked(resolveWorktreeCwd).mockReturnValue(root);
      jest.mocked(discoverProjectInvocableSources).mockResolvedValue({
        entries: [
          { name: 'repair-diffs', kind: 'command', absolutePath: commandPath },
        ],
        scannedDirectories: [join(root, '.claude', 'commands')],
      });

      const result = await analyzeAutomationCapabilityPackage({
        rawContent: '{"version":1}',
        pipelineContent: rawPipeline,
        worktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      });

      expect(result.state).toBe('ready');
      expect(result.manifest.bindings).toEqual([
        expect.objectContaining({ jobId: 'review', stepId: 'run' }),
      ]);
      expect(result.manifest.bindings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ jobId: 'automation', stepId: 'action' }),
        ]),
      );

      const unresolved = await analyzeAutomationCapabilityPackage({
        rawContent: '{"version":1,"copy":2}',
        pipelineContent: rawPipeline,
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      });
      expect(unresolved.state).toBe('blocked');
      expect(unresolved.blockers).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_INVOCATION',
          subject: '/repair-diffs',
          jobId: 'review',
          stepId: 'run',
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sends no prompt source when the automation action has no prompt', async () => {
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(readyAnalysis('automation-no-prompt', []));

    await analyzeAutomationCapabilityPackage({
      rawContent: '{"version":1}',
      promptText: '   ',
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });

    expect(
      jest.mocked(analyzeCapabilityPackage).mock.calls[0]?.[0].promptSources,
    ).toEqual([]);
  });

  it.each(['stored', 'project', 'legacy', 'flag-off'] as const)(
    'preserves the %s locator for packaged publication',
    async (kind): Promise<void> => {
      mockInstallContextEnabled = kind !== 'flag-off';
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(readyAnalysis('share-source', []));
      jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
        uploadId: 'upload-1',
        expiresAt: '2099-01-01',
        missingBlobs: [],
      });
      jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
        uploadId: 'upload-1',
        digest: `pp:v1:${'A'.repeat(43)}`,
        package: {
          version: 1,
          digest: `pp:v1:${'A'.repeat(43)}`,
          resources: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
      });
      const sourcePipeline: PipelineShareSource =
        kind !== 'project'
          ? { kind: 'stored', id: 'local-a' }
          : {
              kind,
              projectId: 'project-a',
              worktreeId: 'worktree-a',
              pipelineFilePath: '/repo/.canopy/pipelines/release.yaml',
            };
      jest
        .spyOn(installContext, 'assertPipelineShareSourceContext')
        .mockResolvedValue();
      jest
        .spyOn(installContext, 'readPipelineShareSource')
        .mockResolvedValue(rawPipeline);
      await analyzePackageRequest({ rawPipeline, sourcePipeline });
      await createPackagedSharedPipeline({
        rawPipeline,
        ...(kind === 'legacy'
          ? { sourcePipelineId: 'local-a' }
          : { sourcePipeline }),
        analysisId: 'share-source',
        selectedOptionalResourceIds: [],
        distributionMode: 'package',
        shareScope: 'private',
      });
      if (kind === 'flag-off')
        expect(authorizeSharedPipelineCreate).not.toHaveBeenCalled();
      if (kind === 'flag-off') {
        expect(createSharedPipeline).toHaveBeenCalledWith(
          expect.objectContaining({ rawPipeline }),
        );
        expect(
          jest.mocked(createSharedPipeline).mock.calls[0]?.[0].sourcePipeline,
        ).toBeUndefined();
      } else {
        expect(createSharedPipeline).toHaveBeenCalledWith(
          expect.objectContaining({
            sourcePipeline,
            rawPipeline,
            ...(kind === 'legacy' ? { sourcePipelineId: 'local-a' } : {}),
          }),
          expect.any(Function),
        );
      }
    },
  );

  it('never retries resource publication after an uncertain response', async () => {
    jest
      .mocked(analyzePipelinePackage)
      .mockResolvedValueOnce(readyAnalysis('publish-once', []));
    jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-publish',
      expiresAt: '2099-01-01',
      missingBlobs: [],
    });
    jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-publish',
      digest: `pp:v1:${'A'.repeat(43)}`,
      package: {
        version: 1,
        digest: `pp:v1:${'A'.repeat(43)}`,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    });
    jest
      .mocked(createSharedPipeline)
      .mockRejectedValueOnce(
        new CanopyCloudClientError('network-error', 'socket hang up'),
      );

    await analyzePackageRequest({ rawPipeline });
    const error: unknown = await createPackagedSharedPipeline({
      rawPipeline,
      analysisId: 'publish-once',
      selectedOptionalResourceIds: [],
      distributionMode: 'package',
      shareScope: 'private',
    }).catch((caught: unknown) => caught);

    expect(createSharedPipeline).toHaveBeenCalledTimes(1);
    expect(
      shareFailureFromError(error, 'publish', { writeSent: false }),
    ).toMatchObject({
      kind: 'connection',
      stage: 'publish',
      commitState: 'unknown',
      retryable: false,
    });
  });

  it('updates a packaged pipeline in place with the reviewed upload', async () => {
    jest
      .mocked(analyzePipelinePackage)
      .mockResolvedValueOnce(readyAnalysis('update-share', []));
    jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-update',
      expiresAt: '2099-01-01',
      missingBlobs: [],
    });
    jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-update',
      digest: `pp:v1:${'A'.repeat(43)}`,
      package: {
        version: 1,
        digest: `pp:v1:${'A'.repeat(43)}`,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    });
    jest.mocked(updateSharedPipeline).mockResolvedValue({
      id: 'remote-1',
      contentHash: 'new-hash',
    } as SharedPipelineDetail);

    await analyzePackageRequest({ rawPipeline });
    await createPackagedSharedPipeline({
      remoteId: 'remote-1',
      expectedContentHash: 'old-hash',
      revokePublicShare: {
        externalId: '22222222-2222-4222-8222-222222222222',
        updatedAt: '2026-09-25T12:00:00.000Z',
      },
      rawPipeline,
      analysisId: 'update-share',
      selectedOptionalResourceIds: [],
      distributionMode: 'package',
      shareScope: 'organization',
      organizationId: 'org-1',
    });

    expect(updateSharedPipeline).toHaveBeenCalledWith('remote-1', rawPipeline, {
      expectedContentHash: 'old-hash',
      shareScope: 'organization',
      teamId: undefined,
      organizationId: 'org-1',
      distributionMode: 'package',
      committedPackageUploadId: 'upload-update',
      revokePublicShare: {
        externalId: '22222222-2222-4222-8222-222222222222',
        updatedAt: '2026-09-25T12:00:00.000Z',
      },
    });
    expect(createSharedPipeline).not.toHaveBeenCalled();
  });

  it('reauthorizes before committing an uploaded pipeline package', async (): Promise<void> => {
    mockInstallContextEnabled = true;
    jest
      .mocked(analyzePipelinePackage)
      .mockResolvedValueOnce(readyAnalysis('revoked-share', []));
    jest
      .spyOn(installContext, 'assertPipelineShareSourceContext')
      .mockResolvedValue();
    jest
      .spyOn(installContext, 'readPipelineShareSource')
      .mockResolvedValue(rawPipeline);
    await analyzePackageRequest({ rawPipeline, pipelineId: 'local-a' });
    jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-revoked',
      expiresAt: '2099-01-01',
      missingBlobs: [],
    });
    jest
      .mocked(authorizeSharedPipelineCreate)
      .mockResolvedValueOnce(rawPipeline)
      .mockRejectedValueOnce(
        new Error('Pipeline unavailable (access-removed)'),
      );
    await expect(
      createPackagedSharedPipeline({
        rawPipeline,
        sourcePipelineId: 'local-a',
        analysisId: 'revoked-share',
        selectedOptionalResourceIds: [],
        distributionMode: 'package',
        shareScope: 'private',
      }),
    ).rejects.toThrow('access-removed');
    expect(preparePipelinePackageUpload).toHaveBeenCalledTimes(1);
    expect(commitPipelinePackageUpload).not.toHaveBeenCalled();
    expect(createSharedPipeline).not.toHaveBeenCalled();
  });

  it.each(['source', 'destination', 'source-less'])(
    'rejects denied %s authorization before uploading a package',
    async (denied): Promise<void> => {
      mockInstallContextEnabled = true;
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(readyAnalysis('denied-share', []));
      jest
        .spyOn(installContext, 'assertPipelineShareSourceContext')
        .mockResolvedValue();
      jest
        .spyOn(installContext, 'readPipelineShareSource')
        .mockResolvedValue(rawPipeline);
      await analyzePackageRequest({
        rawPipeline,
        ...(denied === 'source-less' ? {} : { pipelineId: 'local-a' }),
      });
      jest
        .mocked(authorizeSharedPipelineCreate)
        .mockRejectedValueOnce(
          new Error('Pipeline unavailable (context-mismatch)'),
        );
      const request: Parameters<typeof createPackagedSharedPipeline>[0] = {
        rawPipeline,
        analysisId: 'denied-share',
        selectedOptionalResourceIds: [],
        distributionMode: 'package',
        shareScope: denied === 'destination' ? 'organization' : 'private',
        ...(denied === 'source-less' ? {} : { sourcePipelineId: 'local-a' }),
        ...(denied === 'destination' ? { organizationId: 'org-b' } : {}),
      };
      await expect(createPackagedSharedPipeline(request)).rejects.toThrow(
        'context-mismatch',
      );
      if (denied === 'source-less')
        expect(authorizeSharedPipelineCreate).toHaveBeenCalledWith(request);
      else
        expect(authorizeSharedPipelineCreate).toHaveBeenCalledWith(
          request,
          expect.any(Function),
        );
      expect(preparePipelinePackageUpload).not.toHaveBeenCalled();
      expect(commitPipelinePackageUpload).not.toHaveBeenCalled();
      expect(createSharedPipeline).not.toHaveBeenCalled();
    },
  );

  it('keeps an automation capability analysis available when publishing must be retried', async () => {
    jest
      .mocked(analyzeCapabilityPackage)
      .mockResolvedValueOnce(readyAnalysis('automation-retry-analysis', []));
    jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      missingBlobs: [],
    });
    jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-1',
      digest: `pp:v1:${'A'.repeat(43)}`,
      package: {
        digest: `pp:v1:${'A'.repeat(43)}`,
        version: 1,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    });

    await analyzeAutomationCapabilityPackage({
      rawContent: '{"version":1}',
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    const request = {
      analysisId: 'automation-retry-analysis',
      selectedOptionalResourceIds: [],
    };

    await expect(
      createPackagedAutomationCapabilityPackage(request),
    ).resolves.toMatchObject({ committedPackageUploadId: 'upload-1' });
    await expect(
      createPackagedAutomationCapabilityPackage(request),
    ).resolves.toMatchObject({ committedPackageUploadId: 'upload-1' });
    expect(commitPipelinePackageUpload).toHaveBeenCalledTimes(2);
  });

  it('re-uploads a verified installed automation package for re-sharing', async () => {
    const pipelineContentHash = 'a'.repeat(64);
    const manifest = {
      version: 1 as const,
      pipelineContentHash,
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    const digest = computePipelinePackageDigestSync(manifest);
    jest.mocked(findCapabilityPackageInstallByOwner).mockResolvedValue({
      owner: { kind: 'automation', localAutomationId: 'local-automation' },
      originExternalId: 'source-share',
      pipelineContentHash,
      packageDigest: digest,
      installedAt: '2026-09-18T12:00:00.000Z',
    });
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValue(manifest);
    jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-installed',
      expiresAt: '2099-01-01T00:00:00.000Z',
      missingBlobs: [],
    });
    jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-installed',
      digest,
      package: {
        digest,
        version: 1,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    });

    await expect(
      createPackagedAutomationCapabilityPackage({
        localAutomationId: 'local-automation',
        packageRef: { version: 1, digest },
      }),
    ).resolves.toEqual({
      capabilityPackage: { version: 1, digest },
      committedPackageUploadId: 'upload-installed',
    });
    expect(preparePipelinePackageUpload).toHaveBeenCalledWith(
      { manifest, expectedDigest: digest },
      withRequestTimeout(),
    );
  });

  describe('package request recovery', () => {
    const pipelineContentHash = 'a'.repeat(64);
    const manifest = {
      version: 1 as const,
      pipelineContentHash,
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    const digest = computePipelinePackageDigestSync(manifest);
    const committed = {
      uploadId: 'upload-installed',
      digest,
      package: {
        digest,
        version: 1,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    };
    const prepared = {
      uploadId: 'upload-installed',
      expiresAt: '2099-01-01T00:00:00.000Z',
      missingBlobs: [],
    };
    const lostResponse = (): CanopyCloudClientError =>
      new CanopyCloudClientError('network-error', 'socket hang up');
    const httpError = (
      status: number,
      retryAfterMs?: number,
    ): CanopyCloudClientError =>
      new CanopyCloudClientError(
        'http-error',
        'Refused',
        status,
        undefined,
        undefined,
        true,
        retryAfterMs,
      );
    const share = (): ReturnType<
      typeof createPackagedAutomationCapabilityPackage
    > =>
      createPackagedAutomationCapabilityPackage({
        localAutomationId: 'local-automation',
        packageRef: { version: 1, digest },
      });

    beforeEach(() => {
      jest.mocked(findCapabilityPackageInstallByOwner).mockResolvedValue({
        owner: { kind: 'automation', localAutomationId: 'local-automation' },
        originExternalId: 'source-share',
        pipelineContentHash,
        packageDigest: digest,
        installedAt: '2026-09-18T12:00:00.000Z',
      });
      jest.mocked(verifyCachedPipelinePackage).mockResolvedValue(manifest);
    });

    it('retries preparation once after a lost response', async () => {
      jest
        .mocked(preparePipelinePackageUpload)
        .mockRejectedValueOnce(lostResponse())
        .mockResolvedValueOnce(prepared);
      jest.mocked(commitPipelinePackageUpload).mockResolvedValue(committed);

      await expect(share()).resolves.toMatchObject({
        committedPackageUploadId: 'upload-installed',
      });
      expect(preparePipelinePackageUpload).toHaveBeenCalledTimes(2);
    });

    it('never retries a refused preparation', async () => {
      jest
        .mocked(preparePipelinePackageUpload)
        .mockRejectedValueOnce(httpError(403));

      const error: unknown = await share().catch((caught: unknown) => caught);

      expect(preparePipelinePackageUpload).toHaveBeenCalledTimes(1);
      expect(commitPipelinePackageUpload).not.toHaveBeenCalled();
      expect(
        shareFailureFromError(error, 'publish', { writeSent: false }),
      ).toMatchObject({
        kind: 'permission',
        stage: 'prepare',
      });
    });

    it('repeats the commit for the same upload after a lost response', async () => {
      jest.mocked(preparePipelinePackageUpload).mockResolvedValue(prepared);
      jest
        .mocked(commitPipelinePackageUpload)
        .mockRejectedValueOnce(httpError(503))
        .mockResolvedValueOnce(committed);

      await expect(share()).resolves.toMatchObject({
        committedPackageUploadId: 'upload-installed',
      });
      expect(commitPipelinePackageUpload).toHaveBeenCalledTimes(2);
      expect(
        jest
          .mocked(commitPipelinePackageUpload)
          .mock.calls.map(([uploadId]) => uploadId),
      ).toEqual(['upload-installed', 'upload-installed']);
      expect(preparePipelinePackageUpload).toHaveBeenCalledTimes(1);
    });

    it('stops after two commit attempts with a retryable commit failure', async () => {
      jest.mocked(preparePipelinePackageUpload).mockResolvedValue(prepared);
      jest
        .mocked(commitPipelinePackageUpload)
        .mockRejectedValueOnce(lostResponse())
        .mockRejectedValueOnce(lostResponse());

      const error: unknown = await share().catch((caught: unknown) => caught);

      expect(commitPipelinePackageUpload).toHaveBeenCalledTimes(2);
      expect(
        shareFailureFromError(error, 'publish', { writeSent: false }),
      ).toMatchObject({
        kind: 'connection',
        stage: 'commit',
        commitState: 'not-committed',
        retryable: true,
      });
    });

    it('keeps the server failure details when the deadline stops a retry', async () => {
      let now = Date.parse('2026-10-15T12:00:00.000Z');
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        jest.mocked(preparePipelinePackageUpload).mockImplementationOnce(() => {
          now += 10 * 60_000;
          return Promise.reject(httpError(503, 2_000));
        });

        const error: unknown = await share().catch((caught: unknown) => caught);

        expect(
          shareFailureFromError(error, 'publish', { writeSent: false }),
        ).toMatchObject({
          kind: 'connection',
          stage: 'prepare',
          retryable: true,
          httpStatus: 503,
          retryAfterMs: 2_000,
        });
      } finally {
        clock.mockRestore();
      }
    });

    it('stops when the package deadline has passed instead of retrying', async () => {
      let now = Date.parse('2026-10-15T12:00:00.000Z');
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        jest.mocked(preparePipelinePackageUpload).mockImplementationOnce(() => {
          // The request outlives the whole package allowance.
          now += 10 * 60_000;
          return Promise.reject(lostResponse());
        });

        const error: unknown = await share().catch((caught: unknown) => caught);

        expect(preparePipelinePackageUpload).toHaveBeenCalledTimes(1);
        expect(
          shareFailureFromError(error, 'publish', { writeSent: false }),
        ).toMatchObject({
          kind: 'connection',
          stage: 'prepare',
          retryable: true,
        });
      } finally {
        clock.mockRestore();
      }
    });
  });

  it.each([
    ['edited', 'b'.repeat(64)],
    ['missing', null],
  ])(
    'rejects an installed automation package when its package-driving content is %s',
    async (_state, expectedPackageContentHash) => {
      const pipelineContentHash = 'a'.repeat(64);
      const manifest = {
        version: 1 as const,
        pipelineContentHash,
        resources: [],
        bindings: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      };
      const digest = computePipelinePackageDigestSync(manifest);
      jest.mocked(findCapabilityPackageInstallByOwner).mockResolvedValue({
        owner: { kind: 'automation', localAutomationId: 'local-automation' },
        originExternalId: 'source-share',
        pipelineContentHash,
        packageDigest: digest,
        installedAt: '2026-09-18T12:00:00.000Z',
      });
      jest.mocked(verifyCachedPipelinePackage).mockResolvedValue(manifest);
      const request: Parameters<
        typeof createPackagedAutomationCapabilityPackage
      >[0] = {
        localAutomationId: 'local-automation',
        packageRef: { version: 1 as const, digest },
        expectedPackageContentHash,
      };

      const refusal = createPackagedAutomationCapabilityPackage(request);
      await expect(refusal).rejects.toThrow(
        'The automation changed since this capability package was installed.',
      );
      // Classified, so the share dialog shows this explanation verbatim.
      await expect(refusal).rejects.toMatchObject({ kind: 'unavailable' });
      expect(preparePipelinePackageUpload).not.toHaveBeenCalled();
    },
  );

  it('analyzes a pipeline whose step model is a run-time expression with whitespace', async () => {
    // Mirrors a real user pipeline: one `providers` choice input selects the
    // model of every agent step through a parseJson() lookup. The unevaluated
    // expression contains spaces, which the model-id validator rejects.
    const expressionPipeline = [
      'name: Provider choice',
      'on:',
      '  dispatch:',
      '    inputs:',
      '      providers:',
      '        type: choice',
      '        default: Claude only',
      '        options: [Claude only, Codex only, Claude + Codex]',
      'jobs:',
      '  build:',
      '    steps:',
      '      - id: implement',
      '        uses: builtin/agent-prompt',
      '        with:',
      `          model: \${{ parseJson('{"Claude only":"opus","Codex only":"$sol","Claude + Codex":"$sol"}')[inputs.providers] }}`,
      '          prompt: Implement the plan.',
      '',
    ].join('\n');

    initCodexModels([{ id: 'gpt-6.1-sol', label: 'Sol' }]);
    try {
      const summary = await analyzePackageRequest({
        rawPipeline: expressionPipeline,
      });
      expect(summary.state).toBe('ready');
    } finally {
      initCodexModels([]);
    }
    expect(
      jest.mocked(analyzePipelinePackage).mock.calls[0]?.[0]?.providerByStep,
    ).toEqual({
      'build.implement': [
        { provider: 'claude', inputs: { providers: 'Claude only' } },
        { provider: 'codex', inputs: { providers: 'Codex only' } },
        { provider: 'codex', inputs: { providers: 'Claude + Codex' } },
      ],
    });
  });

  it('fails closed when repo-local dependency discovery fails', async () => {
    jest
      .mocked(discoverProjectInvocableSources)
      .mockRejectedValueOnce(new Error('Project command scan failed'));

    await expect(
      analyzePackageRequest({
        rawPipeline,
        pipelineId: 'pipeline-1',
        worktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      }),
    ).rejects.toThrow('Project command scan failed');
    expect(analyzePipelinePackage).not.toHaveBeenCalled();
  });

  it('resolves worktree ids and self-prunes persisted dismissals', async () => {
    const pipelineContentHash = hashPipelinePackageYaml(rawPipeline);
    jest.mocked(listPipelinePackageDismissals).mockResolvedValueOnce([
      {
        scopeKey: 'pipeline-1',
        provider: 'codex',
        token: '/old-token',
        dismissedAt: '2026-09-17T12:00:00.000Z',
      },
    ]);
    jest.mocked(analyzePipelinePackage).mockResolvedValueOnce({
      summary: {
        analysisId: 'analysis-service-test',
        state: 'ready',
        pipelineContentHash,
        manifest: {
          version: 1,
          pipelineContentHash,
          resources: [],
          bindings: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
        blockers: [],
        dismissedInvocations: [{ provider: 'codex', token: '/old-token' }],
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      optionalBindings: [],
      blobs: new Map(),
      sourceStats: [],
      sourceDirectories: [],
    });

    await analyzePackageRequest({
      rawPipeline,
      pipelineId: 'pipeline-1',
      worktree: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
      },
      dismissedInvocations: [
        { provider: 'codex', token: '/old-token' },
        { provider: 'codex', token: '/deleted-token' },
      ],
    });

    expect(resolveWorktreeCwd).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'repo-1',
    );
    const analyzerInput = jest.mocked(analyzePipelinePackage).mock
      .calls[0]?.[0];
    expect(analyzerInput?.dismissedInvocations).toEqual([
      { provider: 'codex', token: '/old-token' },
    ]);
    expect(analyzerInput?.repoLocalInvocables?.entries[0]?.invocationKey).toBe(
      '/repair-diffs',
    );
    expect(replacePipelinePackageDismissals).toHaveBeenLastCalledWith(
      '/tmp/dismissal-store.json',
      'worktree:project-1:worktree-1:repo-1:pipeline-1',
      [{ provider: 'codex', token: '/old-token' }],
    );
  });

  it('rejects traversal in renderer-supplied worktree identifiers', async () => {
    await expect(
      analyzePackageRequest({
        rawPipeline,
        pipelineId: 'pipeline-1',
        worktree: {
          projectId: 'project-1',
          worktreeId: '..',
        },
      }),
    ).rejects.toThrow('Invalid worktreeId');

    expect(resolveWorktreeCwd).not.toHaveBeenCalled();
    expect(discoverProjectInvocableSources).not.toHaveBeenCalled();
  });

  it('isolates persisted dismissals between projects with the same pipeline id', async () => {
    const recordsByScope = new Map<
      string,
      Array<{ provider: 'claude' | 'codex'; token: string }>
    >();
    jest
      .mocked(replacePipelinePackageDismissals)
      .mockImplementation((_storePath, scopeKey, records) => {
        recordsByScope.set(scopeKey, records);
        return Promise.resolve();
      });
    jest
      .mocked(listPipelinePackageDismissals)
      .mockImplementation((_storePath, scopeKey) =>
        Promise.resolve(
          (recordsByScope.get(scopeKey) ?? []).map((record) => ({
            scopeKey,
            ...record,
            dismissedAt: '2026-09-17T12:00:00.000Z',
          })),
        ),
      );
    jest
      .mocked(analyzePipelinePackage)
      .mockImplementation((input) =>
        Promise.resolve(
          readyAnalysis(
            `analysis-${String(jest.mocked(analyzePipelinePackage).mock.calls.length)}`,
            input.dismissedInvocations ?? [],
          ),
        ),
      );

    await analyzePackageRequest({
      rawPipeline,
      pipelineId: 'project--.canopy/pipelines/build.yaml',
      worktree: { projectId: 'project-one', worktreeId: 'worktree-one' },
      dismissedInvocations: [{ provider: 'claude', token: '/mentioned-only' }],
    });
    await analyzePackageRequest({
      rawPipeline,
      pipelineId: 'project--.canopy/pipelines/build.yaml',
      worktree: { projectId: 'project-two', worktreeId: 'worktree-two' },
    });

    expect(
      jest.mocked(analyzePipelinePackage).mock.calls[1]?.[0]
        .dismissedInvocations,
    ).toEqual([]);
  });

  it('keeps an older analysis from restoring a dismissal after Undo', async () => {
    let resolveFirst!: (value: ReturnType<typeof readyAnalysis>) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstAnalysis = new Promise<ReturnType<typeof readyAnalysis>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    jest
      .mocked(listPipelinePackageDismissals)
      .mockResolvedValueOnce([
        {
          scopeKey: 'pipeline-1',
          provider: 'claude',
          token: '/old-token',
          dismissedAt: '2026-09-17T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);
    jest
      .mocked(analyzePipelinePackage)
      .mockImplementationOnce(async () => {
        markFirstStarted();
        return firstAnalysis;
      })
      .mockResolvedValueOnce(readyAnalysis('analysis-after-undo', []));

    const staleRequest = analyzePackageRequest({
      rawPipeline,
      pipelineId: 'pipeline-1',
      dismissedInvocations: [{ provider: 'claude', token: '/old-token' }],
    });
    await firstStarted;
    await analyzePackageRequest({
      rawPipeline,
      pipelineId: 'pipeline-1',
      dismissedInvocations: [],
    });
    resolveFirst(
      readyAnalysis('analysis-before-undo', [
        { provider: 'claude', token: '/old-token' },
      ]),
    );
    await staleRequest;

    expect(replacePipelinePackageDismissals).toHaveBeenLastCalledWith(
      '/tmp/dismissal-store.json',
      'pipeline-1',
      [],
    );
  });

  it('orders dismissal writes so a slow stale write cannot finish last', async () => {
    let markOldWriteStarted!: () => void;
    let releaseOldWrite!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => {
      markOldWriteStarted = resolve;
    });
    const oldWriteRelease = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    let persistedTokens: string[] = [];
    jest
      .mocked(replacePipelinePackageDismissals)
      .mockImplementationOnce(async (_storePath, _scopeKey, records) => {
        markOldWriteStarted();
        await oldWriteRelease;
        persistedTokens = records.map((record) => record.token);
      })
      .mockImplementation((_storePath, _scopeKey, records) => {
        persistedTokens = records.map((record) => record.token);
        return Promise.resolve();
      });
    jest
      .mocked(listPipelinePackageDismissals)
      .mockResolvedValueOnce([
        {
          scopeKey: 'pipeline-1',
          provider: 'claude',
          token: '/old-token',
          dismissedAt: '2026-09-17T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);
    jest
      .mocked(analyzePipelinePackage)
      .mockResolvedValueOnce(
        readyAnalysis('analysis-before-undo', [
          { provider: 'claude', token: '/old-token' },
        ]),
      )
      .mockResolvedValueOnce(readyAnalysis('analysis-after-undo', []));

    const staleRequest = analyzePackageRequest({
      rawPipeline,
      pipelineId: 'pipeline-1',
    });
    await oldWriteStarted;
    const currentRequest = analyzePackageRequest({
      rawPipeline,
      pipelineId: 'pipeline-1',
      dismissedInvocations: [],
    });
    setTimeout(releaseOldWrite, 25);
    await Promise.all([staleRequest, currentRequest]);

    expect(persistedTokens).toEqual([]);
  });

  it('uses a portable runtime identity for repo-local commands', async () => {
    jest.mocked(resolveWorktreeCwd).mockReturnValue('/tmp/My Project');
    jest.mocked(discoverProjectInvocableSources).mockResolvedValueOnce({
      entries: [
        {
          name: 'repair-diffs',
          kind: 'command',
          absolutePath: '/tmp/My Project/.claude/commands/repair-diffs.md',
        },
      ],
      scannedDirectories: ['/tmp/My Project/.claude/commands'],
    });
    jest
      .mocked(analyzePipelinePackage)
      .mockResolvedValueOnce(readyAnalysis('analysis-portable-root', []));

    await analyzePackageRequest({
      rawPipeline,
      pipelineId: 'pipeline-1',
      worktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });

    const analyzerInput = jest.mocked(analyzePipelinePackage).mock
      .calls[0]?.[0];
    const entry = analyzerInput?.repoLocalInvocables?.entries[0];
    const descriptor = entry
      ? analyzerInput?.sourceByRepoLocalEntryId?.[entry.id]
      : undefined;
    expect(entry?.sourceLabel).toBe('My Project');
    expect(descriptor?.rootName).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(descriptor?.rootName).not.toBe('My Project');
    expect(descriptor?.syntheticManifestName).toBe(descriptor?.rootName);
    expect(descriptor?.exportRoot).toBe('/tmp/My Project/.claude/commands');
  });

  it.each([undefined, 'different-pipeline'])(
    'rejects missing or mismatched trusted provenance (%s) before committing a packaged share',
    async (sourcePipelineId): Promise<void> => {
      mockInstallContextEnabled = true;
      jest
        .mocked(localPipelineService.getPipelineText)
        .mockReturnValue({ success: true, data: rawPipeline });
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(readyAnalysis('omitted-source', []));
      try {
        const summary = await analyzePackageRequest({
          rawPipeline,
          pipelineId: 'pipeline-a',
        });
        await expect(
          createPackagedSharedPipeline({
            rawPipeline,
            analysisId: summary.analysisId,
            sourcePipelineId,
            distributionMode: 'package',
            selectedOptionalResourceIds: [],
            shareScope: 'private',
          }),
        ).rejects.toThrow('Pipeline unavailable (unknown-provenance)');
        expect(preparePipelinePackageUpload).not.toHaveBeenCalled();
        expect(commitPipelinePackageUpload).not.toHaveBeenCalled();
        expect(createSharedPipeline).not.toHaveBeenCalled();
      } finally {
        mockInstallContextEnabled = false;
      }
    },
  );

  it('hashes and publishes the same trusted noncanonical YAML bytes', async () => {
    mockInstallContextEnabled = true;
    const callerYaml =
      'name: Example\non: dispatch\njobs: { review: { steps: [{ run: echo ok }] } }\n';
    const trustedYaml = '# retained formatting\n' + callerYaml;
    jest
      .mocked(localPipelineService.getPipelineText)
      .mockReturnValue({ success: true, data: trustedYaml });
    jest
      .mocked(analyzePipelinePackage)
      .mockImplementationOnce(
        jest.requireActual<typeof DesktopSharedNodeModule>(
          '@canopy/desktop-shared/node',
        ).analyzePipelinePackage,
      );
    const digest = `pp:v1:${'A'.repeat(43)}`;
    jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
      uploadId: 'trusted-upload',
      expiresAt: '2099-01-01T00:00:00Z',
      missingBlobs: [],
    });
    jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
      uploadId: 'trusted-upload',
      digest,
      package: {
        digest,
        version: 1,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    });
    try {
      const summary = await analyzePackageRequest({
        rawPipeline: callerYaml,
        pipelineId: 'pipeline-a',
      });
      expect(summary.pipelineContentHash).toBe(
        hashPipelinePackageYaml(trustedYaml),
      );
      jest
        .mocked(localPipelineService.getPipelineText)
        .mockReturnValue({ success: true, data: 'changed after analysis' });
      await createPackagedSharedPipeline({
        rawPipeline,
        sourcePipelineId: 'pipeline-a',
        analysisId: summary.analysisId,
        distributionMode: 'package',
        selectedOptionalResourceIds: [],
        shareScope: 'private',
      });
      expect(
        jest.mocked(preparePipelinePackageUpload).mock.calls.at(-1)?.[0]
          .manifest.pipelineContentHash,
      ).toBe(hashPipelinePackageYaml(trustedYaml));
      expect(createSharedPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ rawPipeline: trustedYaml }),
        expect.any(Function),
      );
      const load = jest.mocked(createSharedPipeline).mock.calls.at(-1)?.[1];
      expect(await load?.('pipeline-a')).toBe(trustedYaml);
      expect(authorizeSharedPipelineCreate).toHaveBeenCalledTimes(2);
      for (const [, loadAuthorizedSource] of jest.mocked(
        authorizeSharedPipelineCreate,
      ).mock.calls) {
        expect(loadAuthorizedSource).toEqual(expect.any(Function));
        expect(await loadAuthorizedSource?.('pipeline-a')).toBe(trustedYaml);
      }
      expect(localPipelineService.getPipelineText).toHaveBeenCalledTimes(1);
    } finally {
      mockInstallContextEnabled = false;
    }
  });

  it('refuses submission of a blocked analysis even when it has a manifest', async () => {
    const pipelineContentHash = hashPipelinePackageYaml(rawPipeline);
    jest.mocked(analyzePipelinePackage).mockResolvedValueOnce({
      summary: {
        analysisId: 'analysis-blocked-manifest',
        state: 'blocked',
        pipelineContentHash,
        manifest: {
          version: 1,
          pipelineContentHash,
          resources: [],
          bindings: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
        blockers: [
          {
            code: 'UNRESOLVED_INVOCATION',
            subject: '/missing',
            message: 'missing',
            occurrences: [],
          },
        ],
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      optionalBindings: [],
      blobs: new Map(),
      sourceStats: [],
      sourceDirectories: [],
    });
    await analyzePackageRequest({ rawPipeline, pipelineId: 'pipeline-1' });
    expect(discoverProjectInvocableSources).not.toHaveBeenCalled();

    await expect(
      createPackagedSharedPipeline({
        analysisId: 'analysis-blocked-manifest',
        rawPipeline,
        distributionMode: 'package',
        selectedOptionalResourceIds: [],
        shareScope: 'private',
      }),
    ).rejects.toThrow(
      'Dependencies are not ready to package. Resolve the listed problems first.',
    );
  });

  describe('in-place shared pipeline updates', () => {
    const packageDigest = `pp:v1:${'B'.repeat(43)}`;
    const sharedDetail = (
      distributionMode: 'package' | 'definition_only',
      previousResourceIds: string[] = [],
    ): Awaited<ReturnType<typeof getSharedPipeline>> => ({
      id: 'remote-shared',
      name: 'Example',
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
      rawPipeline: 'name: Example\non: dispatch\njobs: {}\n',
      distributionMode,
      ...(distributionMode === 'package'
        ? {
            package: {
              digest: packageDigest,
              version: 1 as const,
              resources: previousResourceIds.map((id) => ({
                id,
                displayName: id,
                kind: 'plugin_command' as const,
                sourceLabel: 'project',
                fileCount: 1,
                totalBytes: 10,
                affectedSteps: [{ jobId: 'review', stepId: 'run' }],
              })),
              environmentRequirements: [],
              totalFiles: previousResourceIds.length,
              totalBytes: previousResourceIds.length * 10,
            },
          }
        : {}),
    });
    const analysisWithLocalCommand = (
      analysisId: string,
    ): DesktopSharedNodeModule.PipelinePackageAnalysisInternal => {
      const base = readyAnalysis(analysisId, []);
      const manifest = base.summary.manifest;
      if (!manifest) throw new Error('Expected a ready manifest');
      return {
        ...base,
        summary: {
          ...base.summary,
          manifest: {
            ...manifest,
            resources: [
              {
                id: 'repair-diffs',
                kind: 'plugin_command',
                displayName: 'repair-diffs',
                sourceLabel: 'project',
                sourceVisibility: 'local',
                invocationKeys: ['command:repair-diffs'],
                dependencyResourceIds: [],
                trees: [],
              },
            ],
            bindings: [
              { jobId: 'review', stepId: 'run', resourceIds: ['repair-diffs'] },
            ],
          },
        },
      };
    };

    beforeEach(() => {
      jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
        uploadId: 'upload-edit',
        expiresAt: '2099-01-01',
        missingBlobs: [],
      });
      jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
        uploadId: '5f0c6f4e-7d1a-4c55-9a55-3f1f0f3c2a11',
        digest: packageDigest,
        package: {
          version: 1,
          digest: packageDigest,
          resources: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
      });
      jest
        .mocked(updateSharedPipeline)
        .mockImplementation((_remoteId, yaml) =>
          Promise.resolve({ ...sharedDetail('package'), rawPipeline: yaml }),
        );
    });

    it('saves a definition-only share without packaging it', async () => {
      jest
        .mocked(getSharedPipeline)
        .mockResolvedValue(sharedDetail('definition_only'));

      await updateSharedPipelinePreservingPackage('remote-shared', rawPipeline);

      expect(analyzePipelinePackage).not.toHaveBeenCalled();
      expect(updateSharedPipeline).toHaveBeenCalledWith(
        'remote-shared',
        rawPipeline,
      );
    });

    it('uses the supplied current detail without fetching it again', async () => {
      const current = sharedDetail('definition_only');

      await updateSharedPipelinePreservingPackage(
        'remote-shared',
        rawPipeline,
        current,
      );

      expect(getSharedPipeline).not.toHaveBeenCalled();
      expect(updateSharedPipeline).toHaveBeenCalledWith(
        'remote-shared',
        rawPipeline,
      );
    });

    it('re-packages a package share so the edit stays runnable', async () => {
      jest.mocked(getSharedPipeline).mockResolvedValue(sharedDetail('package'));
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(readyAnalysis('edit-ready', []));

      await updateSharedPipelinePreservingPackage('remote-shared', rawPipeline);

      expect(commitPipelinePackageUpload).toHaveBeenCalledWith(
        'upload-edit',
        withRequestTimeout(),
      );
      expect(updateSharedPipeline).toHaveBeenCalledWith(
        'remote-shared',
        rawPipeline,
        {
          distributionMode: 'package',
          committedPackageUploadId: '5f0c6f4e-7d1a-4c55-9a55-3f1f0f3c2a11',
        },
      );
    });

    it('refuses to commit the replacement package after the resource context changes', async () => {
      mockInstallContextEnabled = true;
      mockInstallContextRevision = 'before-edit';
      jest.mocked(getSharedPipeline).mockResolvedValue(sharedDetail('package'));
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(readyAnalysis('edit-context-switch', []));
      jest.mocked(preparePipelinePackageUpload).mockImplementationOnce(() => {
        mockInstallContextRevision = 'after-edit';
        return Promise.resolve({
          uploadId: 'upload-edit',
          expiresAt: '2099-01-01',
          missingBlobs: [],
        });
      });

      try {
        await expect(
          updateSharedPipelinePreservingPackage('remote-shared', rawPipeline),
        ).rejects.toThrow('Pipeline unavailable (context-mismatch)');
        expect(commitPipelinePackageUpload).not.toHaveBeenCalled();
        expect(updateSharedPipeline).not.toHaveBeenCalled();
      } finally {
        mockInstallContextEnabled = false;
        mockInstallContextRevision = 'original';
      }
    });

    it('keeps a local resource the previous package already carried', async () => {
      jest
        .mocked(getSharedPipeline)
        .mockResolvedValue(sharedDetail('package', ['repair-diffs']));
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(analysisWithLocalCommand('edit-same-local'));

      await updateSharedPipelinePreservingPackage('remote-shared', rawPipeline);

      expect(updateSharedPipeline).toHaveBeenCalledWith(
        'remote-shared',
        rawPipeline,
        expect.objectContaining({ distributionMode: 'package' }),
      );
    });

    it('refuses an edit when a packaged project action cannot be resolved', async () => {
      const current = sharedDetail('package', ['project/review']);
      const previousResource = current.package?.resources[0];
      if (!previousResource) throw new Error('Expected a packaged resource');
      previousResource.kind = 'pipeline_action';
      previousResource.displayName = 'project/review';
      jest.mocked(getSharedPipeline).mockResolvedValue(current);
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(
          readyAnalysis('edit-missing-project-action', []),
        );
      const editedPipeline = rawPipeline.replace(
        'uses: builtin/agent-prompt',
        'uses: project/review',
      );

      await expect(
        updateSharedPipelinePreservingPackage('remote-shared', editedPipeline),
      ).rejects.toThrow(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE);
      expect(preparePipelinePackageUpload).not.toHaveBeenCalled();
      expect(updateSharedPipeline).not.toHaveBeenCalled();
    });

    it('refuses an edit when a packaged child pipeline cannot be resolved', async () => {
      const current = sharedDetail('package', ['child.yaml']);
      const previousResource = current.package?.resources[0];
      if (!previousResource) throw new Error('Expected a packaged resource');
      previousResource.kind = 'child_pipeline';
      previousResource.displayName = 'child.yaml';
      jest.mocked(getSharedPipeline).mockResolvedValue(current);
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(readyAnalysis('edit-missing-child', []));
      const editedPipeline = rawPipeline
        .replace('uses: builtin/agent-prompt', 'uses: builtin/run-pipeline')
        .replace('prompt: Run /repair-diffs.', 'pipeline: child.yaml');

      await expect(
        updateSharedPipelinePreservingPackage('remote-shared', editedPipeline),
      ).rejects.toThrow(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE);
      expect(preparePipelinePackageUpload).not.toHaveBeenCalled();
      expect(updateSharedPipeline).not.toHaveBeenCalled();
    });

    it('keeps both provider twins when the summary lists only their lead', async () => {
      // The server's package summary collapses a skill packaged for Claude and
      // Codex into one row named by the Claude resource, so the Codex twin's id
      // never appears in `current.package.resources`.
      jest
        .mocked(getSharedPipeline)
        .mockResolvedValue(sharedDetail('package', ['skill-claude']));
      const base = readyAnalysis('edit-twins', []);
      const manifest = base.summary.manifest;
      if (!manifest) throw new Error('Expected a ready manifest');
      const twin = (
        id: string,
        provider: 'claude' | 'codex',
      ): (typeof manifest.resources)[number] => ({
        id,
        kind: 'standalone_skill',
        displayName: 'campaign-brief',
        sourceLabel: 'user',
        sourceVisibility: 'local',
        invocationKeys: [`${provider}:campaign-brief`],
        dependencyResourceIds: [],
        trees: [
          {
            provider,
            runtimeKind: 'standalone_skill',
            rootName: 'campaign-brief',
            entries: [],
          },
        ],
      });
      jest.mocked(analyzePipelinePackage).mockResolvedValueOnce({
        ...base,
        summary: {
          ...base.summary,
          manifest: {
            ...manifest,
            resources: [
              twin('skill-claude', 'claude'),
              twin('skill-codex', 'codex'),
            ],
            bindings: [],
          },
        },
        optionalBindings: [
          {
            jobId: 'review',
            stepId: 'run',
            resourceIds: ['skill-claude', 'skill-codex'],
          },
        ],
      });

      await updateSharedPipelinePreservingPackage('remote-shared', rawPipeline);

      expect(preparePipelinePackageUpload).toHaveBeenCalled();
      const [prepared] = jest.mocked(preparePipelinePackageUpload).mock
        .calls[0] ?? [undefined];
      expect(
        prepared?.manifest.resources.map((resource) => resource.id).sort(),
      ).toEqual(['skill-claude', 'skill-codex']);
      expect(updateSharedPipeline).toHaveBeenCalledWith(
        'remote-shared',
        rawPipeline,
        expect.objectContaining({ distributionMode: 'package' }),
      );
    });

    it('refuses to upload a local resource the author never consented to', async () => {
      jest.mocked(getSharedPipeline).mockResolvedValue(sharedDetail('package'));
      jest
        .mocked(analyzePipelinePackage)
        .mockResolvedValueOnce(analysisWithLocalCommand('edit-new-local'));

      await expect(
        updateSharedPipelinePreservingPackage('remote-shared', rawPipeline),
      ).rejects.toThrow(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE);
      expect(preparePipelinePackageUpload).not.toHaveBeenCalled();
      expect(updateSharedPipeline).not.toHaveBeenCalled();
    });

    it('refuses a blocked edit instead of demoting the share', async () => {
      jest.mocked(getSharedPipeline).mockResolvedValue(sharedDetail('package'));
      const blocked = readyAnalysis('edit-blocked', []);
      jest.mocked(analyzePipelinePackage).mockResolvedValueOnce({
        ...blocked,
        summary: {
          ...blocked.summary,
          state: 'blocked',
          blockers: [
            {
              code: 'UNRESOLVED_INVOCATION',
              subject: '/missing',
              message: 'missing',
              occurrences: [],
            },
          ],
        },
      });

      await expect(
        updateSharedPipelinePreservingPackage('remote-shared', rawPipeline),
      ).rejects.toThrow(SHARED_PACKAGE_REVIEW_REQUIRED_MESSAGE);
      expect(updateSharedPipeline).not.toHaveBeenCalled();
    });
  });
});

describe('pipeline package provider resolution', () => {
  beforeAll(() => {
    initCodexModels([
      { id: 'gpt-pipeline-package-test', label: 'Package test' },
    ]);
  });

  afterAll(() => {
    initCodexModels([]);
  });

  it('uses the configured model and model alias instead of prompt sigils', () => {
    const pipeline: Pipeline = {
      name: 'Provider resolution',
      on: 'dispatch',
      model_aliases: [
        {
          id: 'review-model',
          name: 'Review model',
          defaults: { base: 'gpt-pipeline-package-test' },
        },
      ],
      jobs: {
        review: {
          steps: [
            {
              id: 'codex',
              uses: 'builtin/agent-prompt',
              with: { model: 'review-model', prompt: 'Run /review-loop.' },
            },
            {
              id: 'claude',
              uses: 'builtin/agent-prompt',
              with: { model: 'opus[1m]', prompt: 'Mention $review-loop.' },
            },
          ],
        },
      },
    };

    expect(resolvePipelinePackageProviderByStep(pipeline)).toEqual({
      'review.codex': 'codex',
      'review.claude': 'claude',
    });
  });

  it('uses the executor canonical id for an unnamed step', () => {
    const unnamedPipeline: Pipeline = {
      name: 'Unnamed step',
      on: 'dispatch',
      jobs: {
        review: {
          steps: [
            {
              uses: 'builtin/agent-prompt',
              with: { model: 'gpt-pipeline-package-test', prompt: 'Review.' },
            },
          ],
        },
      },
    };

    expect(resolvePipelinePackageProviderByStep(unnamedPipeline)).toEqual({
      'review.__auto_step_0': 'codex',
    });
  });
});

describe('pipeline package provider resolution for expression models', () => {
  beforeAll(() => {
    initCodexModels([
      { id: 'gpt-6.1-sol', label: 'Sol' },
      { id: 'gpt-6-astra', label: 'Astra' },
    ]);
  });

  afterAll(() => {
    initCodexModels([]);
  });

  const PROVIDERS_INPUT = {
    type: 'choice' as const,
    default: 'Claude only',
    options: ['Claude only', 'Codex only', 'Claude + Codex'],
  };

  function agentStep(
    id: string,
    model: string,
  ): Pipeline['jobs'][string]['steps'][number] {
    return {
      id,
      uses: 'builtin/agent-prompt',
      with: { model, prompt: 'Do the work.' },
    };
  }

  it('resolves a choice-driven model to every provider its options select', () => {
    const pipeline: Pipeline = {
      name: 'Provider choice',
      // The same input is declared on two triggers, as in a plan-ready and
      // task-ready pipeline; both declare the same options.
      on: {
        plan_ready: { inputs: { providers: PROVIDERS_INPUT } },
        task_ready: { inputs: { providers: PROVIDERS_INPUT } },
      },
      jobs: {
        build: {
          steps: [
            agentStep(
              'claude_only',
              `\${{ parseJson('{"Claude only":"opus","Codex only":"opus","Claude + Codex":"opus"}')[inputs.providers] }}`,
            ),
            agentStep(
              'codex_only',
              `\${{ parseJson('{"Claude only":"$sol","Codex only":"$astra","Claude + Codex":"$sol"}')[inputs.providers] }}`,
            ),
            agentStep(
              'mixed',
              `\${{ parseJson('{"Claude only":"fable","Codex only":"$astra","Claude + Codex":"$astra"}')[inputs.providers] }}`,
            ),
          ],
        },
      },
    };

    expect(resolvePipelinePackageProviderByStep(pipeline)).toEqual({
      'build.claude_only': [
        { provider: 'claude', inputs: { providers: 'Claude only' } },
        { provider: 'claude', inputs: { providers: 'Codex only' } },
        { provider: 'claude', inputs: { providers: 'Claude + Codex' } },
      ],
      'build.codex_only': [
        { provider: 'codex', inputs: { providers: 'Claude only' } },
        { provider: 'codex', inputs: { providers: 'Codex only' } },
        { provider: 'codex', inputs: { providers: 'Claude + Codex' } },
      ],
      'build.mixed': [
        { provider: 'claude', inputs: { providers: 'Claude only' } },
        { provider: 'codex', inputs: { providers: 'Codex only' } },
        { provider: 'codex', inputs: { providers: 'Claude + Codex' } },
      ],
    });
  });

  it('enumerates boolean inputs and treats a free-form default as open', () => {
    const pipeline: Pipeline = {
      name: 'Inputs',
      on: {
        dispatch: {
          inputs: {
            use_codex: { type: 'boolean', default: false },
            model: { type: 'string', default: '$sol' },
          },
        },
      },
      jobs: {
        run: {
          steps: [
            agentStep(
              'toggle',
              `\${{ parseJson('{"true":"gpt-6.1-sol","false":"opus"}')[inputs.use_codex] }}`,
            ),
            agentStep('defaulted', '${{ inputs.model }}'),
          ],
        },
      },
    };

    expect(resolvePipelinePackageProviderByStep(pipeline)).toEqual({
      'run.toggle': [
        { provider: 'codex', inputs: { use_codex: true } },
        { provider: 'claude', inputs: { use_codex: false } },
      ],
      // A run can override a free-form input, so its default confirms Codex
      // and Claude stays possible but unconfirmed. The default is never
      // substituted into the prompt.
      'run.defaulted': [
        { provider: 'codex' },
        { provider: 'claude', unconfirmed: true },
      ],
    });
  });

  it('adds Codex, unconfirmed, when a model cannot be resolved instead of assuming Claude', () => {
    const pipeline: Pipeline = {
      name: 'Undeterminable',
      on: {
        dispatch: {
          inputs: {
            free_text: { type: 'string' },
            mode: { type: 'choice', options: ['x'], required: true },
          },
        },
      },
      jobs: {
        run: {
          steps: [
            // A prior step's output is only known at run time.
            agentStep('from_output', '${{ steps.pick.outputs.model }}'),
            // A string input without a default can be anything.
            agentStep('no_default', '${{ inputs.free_text }}'),
            // An undeclared input has no known values.
            agentStep('undeclared', '${{ inputs.missing }}'),
            // A selector that misses every key interpolates to nothing, which
            // runs on the default model.
            agentStep(
              'empty_result',
              `\${{ parseJson('{"a":"opus"}')[inputs.mode] }}`,
            ),
            // A selected value the model-id validator rejects.
            agentStep(
              'invalid_value',
              `\${{ parseJson('{"x":"not a model"}')[inputs.mode] }}`,
            ),
            // A literal the model-id validator rejects.
            agentStep('invalid_literal', 'not a model'),
            // Malformed expressions must not break the analysis either.
            agentStep('malformed', '${{ parseJson( }}'),
          ],
        },
      },
    };

    const unresolved = [
      { provider: 'claude' },
      { provider: 'codex', unconfirmed: true },
    ];
    expect(resolvePipelinePackageProviderByStep(pipeline)).toEqual({
      'run.from_output': unresolved,
      'run.no_default': unresolved,
      'run.undeclared': unresolved,
      'run.empty_result': [{ provider: 'claude', inputs: { mode: 'x' } }],
      'run.invalid_value': [
        { provider: 'claude', inputs: { mode: 'x' } },
        { provider: 'codex', inputs: { mode: 'x' }, unconfirmed: true },
      ],
      'run.invalid_literal': unresolved,
      'run.malformed': unresolved,
    });
  });

  it('adds the absent run when an input is not guaranteed to have a value', () => {
    const codexOnly = `\${{ parseJson('{"Codex only":"$sol"}')[inputs.providers] }}`;
    const pipeline: Pipeline = {
      name: 'Absent inputs',
      on: {
        // `plan_ready` runs without `providers`.
        dispatch: {
          inputs: {
            providers: {
              type: 'choice',
              default: 'Codex only',
              options: ['Codex only'],
            },
            optional_mode: { type: 'choice', options: ['Codex only'] },
          },
        },
        plan_ready: {
          inputs: {
            optional_mode: { type: 'choice', options: ['Codex only'] },
          },
        },
      },
      jobs: {
        run: {
          steps: [
            agentStep('undeclared_on_a_trigger', codexOnly),
            // Optional, no default: a run can leave it out.
            agentStep(
              'optional_without_default',
              `\${{ parseJson('{"Codex only":"$sol"}')[inputs.optional_mode] }}`,
            ),
          ],
        },
      },
    };

    // An absent input interpolates to nothing, which runs on the default
    // Claude model.
    expect(resolvePipelinePackageProviderByStep(pipeline)).toEqual({
      'run.undeclared_on_a_trigger': [
        { provider: 'codex', inputs: { providers: 'Codex only' } },
        { provider: 'claude', absentInputs: ['providers'] },
      ],
      'run.optional_without_default': [
        { provider: 'codex', inputs: { optional_mode: 'Codex only' } },
        { provider: 'claude', absentInputs: ['optional_mode'] },
      ],
    });
  });

  it('scans the absent run prompt as the run renders it, not every branch', () => {
    const pipeline: Pipeline = {
      name: 'Absent prompt',
      on: {
        dispatch: {
          inputs: {
            providers: {
              type: 'choice',
              default: 'Claude only',
              options: ['Claude only', 'Codex only'],
            },
          },
        },
        // `plan_ready` runs without `providers`.
        plan_ready: {},
      },
      jobs: {
        run: {
          steps: [
            {
              id: 'open_pr',
              uses: 'builtin/agent-prompt',
              with: {
                model: `\${{ parseJson('{"Claude only":"opus","Codex only":"$sol"}')[inputs.providers] }}`,
                prompt: `\${{ parseJson('{"Claude only":"Run /open-pr.","Codex only":"Run $ud-git:open-pr."}')[inputs.providers] }}`,
              },
            },
          ],
        },
      },
    };

    const sources = buildPipelineCapabilityPackageSources(
      pipeline,
      resolvePipelinePackageProviderByStep(pipeline),
    );

    // The absent run interpolates the prompt to nothing; no source carries a
    // command from a branch its provider never runs.
    expect(
      sources.promptSources.map(({ provider, text }) => ({ provider, text })),
    ).toEqual([
      { provider: 'claude', text: 'Run /open-pr.' },
      { provider: 'codex', text: 'Run $ud-git:open-pr.' },
      { provider: 'claude', text: '' },
    ]);
  });

  it('treats an alias without defaults as unresolved', () => {
    const pipeline: Pipeline = {
      name: 'Preference alias',
      on: 'dispatch',
      // The run's preference supplies this alias's model.
      model_aliases: [{ id: 'builder', name: 'Builder' }],
      jobs: { run: { steps: [agentStep('build', 'builder')] } },
    };

    expect(resolvePipelinePackageProviderByStep(pipeline)).toEqual({
      'run.build': [
        { provider: 'claude' },
        { provider: 'codex', unconfirmed: true },
      ],
    });
  });

  it('resolves a literal built-in model reference alias such as $sol', () => {
    const pipeline: Pipeline = {
      name: 'Literal alias',
      on: 'dispatch',
      jobs: { run: { steps: [agentStep('sol', '$sol')] } },
    };

    expect(resolvePipelinePackageProviderByStep(pipeline)).toEqual({
      'run.sol': 'codex',
    });
  });
});

describe('pipeline package selection', () => {
  it('binds a selected optional resource and its closure only to affected steps', () => {
    const manifest = {
      version: 1 as const,
      pipelineContentHash: 'a'.repeat(64),
      resources: [
        {
          id: 'optional-root',
          kind: 'standalone_skill' as const,
          displayName: 'Optional root',
          sourceLabel: 'local',
          sourceVisibility: 'local' as const,
          invocationKeys: ['$optional-root'],
          dependencyResourceIds: ['optional-child'],
          trees: [],
        },
        {
          id: 'optional-child',
          kind: 'standalone_skill' as const,
          displayName: 'Optional child',
          sourceLabel: 'local',
          sourceVisibility: 'local' as const,
          invocationKeys: ['$optional-child'],
          dependencyResourceIds: [],
          trees: [],
        },
      ],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };

    expect(
      selectPipelinePackageManifest(
        manifest,
        ['optional-root'],
        [
          {
            jobId: 'review',
            stepId: 'selected',
            resourceIds: ['optional-root'],
          },
        ],
      ),
    ).toMatchObject({
      resources: [{ id: 'optional-root' }, { id: 'optional-child' }],
      bindings: [
        {
          jobId: 'review',
          stepId: 'selected',
          resourceIds: ['optional-child', 'optional-root'],
        },
      ],
    });
  });

  it('omits a transitive publisher note when its optional source is not selected', () => {
    const manifest = {
      version: 1 as const,
      pipelineContentHash: 'a'.repeat(64),
      resources: [
        {
          id: 'optional-root',
          kind: 'standalone_skill' as const,
          displayName: 'Optional root',
          sourceLabel: 'local',
          sourceVisibility: 'local' as const,
          invocationKeys: ['$optional-root'],
          dependencyResourceIds: [],
          trees: [],
        },
      ],
      bindings: [],
      environmentRequirements: [],
      publisherNotes: [
        {
          id: 'not-a-command-private-token',
          kind: 'not_a_command' as const,
          label: '$private:token',
          affectedSteps: [{ jobId: 'review', stepId: 'optional' }],
        },
      ],
      totalFiles: 0,
      totalBytes: 0,
    };
    const noteSources = {
      'not-a-command-private-token': {
        direct: false,
        resourceIds: ['optional-root'],
      },
    };
    const optionalBindings = [
      {
        jobId: 'review',
        stepId: 'optional',
        resourceIds: ['optional-root'],
      },
    ];

    expect(
      selectPipelinePackageManifest(
        manifest,
        [],
        optionalBindings,
        noteSources,
      ),
    ).not.toHaveProperty('publisherNotes');
    expect(
      selectPipelinePackageManifest(
        manifest,
        ['optional-root'],
        optionalBindings,
        noteSources,
      ).publisherNotes,
    ).toEqual(manifest.publisherNotes);
  });
});

describe('pipeline package readiness', () => {
  it.each([true, false])(
    'rejects unauthorizable project readiness (locator=%s)',
    async (locator): Promise<void> => {
      jest.mocked(listPipelinePackageInstalls).mockResolvedValue([]);
      mockInstallContextEnabled = true;
      const authorize = jest
        .spyOn(installContext, 'authorizeProjectPipelineRequest')
        .mockRejectedValue(
          new Error('Pipeline unavailable (unknown-provenance)'),
        );
      try {
        await expect(
          getPackageReadiness({
            pipeline: locator
              ? {
                  id: 'project--child.yaml',
                  cwd: '/repo',
                  filePath: '/repo/child.yaml',
                }
              : 'project--child.yaml',
          }),
        ).rejects.toThrow('unknown-provenance');
      } finally {
        authorize.mockRestore();
        mockInstallContextEnabled = false;
      }
    },
  );

  const publisherNotes = [
    {
      id: 'not-a-command-collect-py',
      kind: 'not_a_command' as const,
      label: '/collect.py',
      affectedSteps: [{ jobId: 'review', stepId: 'run' }],
    },
  ];

  const requirement = (
    id: string,
    kind: PipelinePackageEnvironmentRequirement['kind'],
    required = true,
  ): PipelinePackageEnvironmentRequirement => ({
    id,
    kind,
    displayName: id,
    required,
    affectedSteps: [],
    setupHint: `Set up ${id}`,
  });

  it('reports setup required when a known required dependency is missing', async () => {
    const result = await evaluatePipelinePackageRequirements(
      [
        requirement('github', 'connector'),
        requirement('review-model', 'model'),
        requirement('linear', 'mcp', false),
      ],
      (item) =>
        Promise.resolve(
          item.id === 'github'
            ? { status: 'missing', detail: 'GitHub is not connected.' }
            : item.id === 'review-model'
              ? { status: 'available', detail: 'Model is configured.' }
              : {
                  status: 'unknown',
                  detail: 'Availability could not be verified automatically.',
                },
        ),
    );

    expect(result.status).toBe('setup_required');
    expect(result.requirements).toEqual([
      expect.objectContaining({ id: 'github', status: 'missing' }),
      expect.objectContaining({ id: 'review-model', status: 'available' }),
      expect.objectContaining({ id: 'linear', status: 'unknown' }),
    ]);
  });

  it('marks a shared definition-only pipeline as missing packaged content', async () => {
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-definition-only',
      name: 'Definition only',
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
      rawPipeline: 'name: Definition only\non: dispatch\njobs: {}\n',
      distributionMode: 'definition_only',
    });

    await expect(
      getPackageReadiness({
        pipeline: { source: 'shared', remoteId: 'remote-definition-only' },
      }),
    ).resolves.toEqual({
      status: 'invalid',
      distributionMode: 'definition_only',
      requirements: [],
    });
  });

  it('marks an installed local definition-only pipeline as missing packaged content', async () => {
    const rawPipeline = 'name: Definition only\non: dispatch\njobs: {}\n';
    jest.mocked(listPipelinePackageInstalls).mockResolvedValueOnce([
      {
        localPipelineId: 'local-definition-only',
        originExternalId: 'share-definition-only',
        pipelineContentHash: hashPipelinePackageYaml(rawPipeline),
        distributionMode: 'definition_only',
        installedAt: '2026-08-30T12:00:00.000Z',
      } as never,
    ]);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValueOnce({
      success: true,
      data: rawPipeline,
    });

    try {
      await expect(
        getPackageReadiness({ pipeline: 'local-definition-only' }),
      ).resolves.toEqual({
        status: 'invalid',
        distributionMode: 'definition_only',
        requirements: [],
      });
    } finally {
      jest.mocked(localPipelineService.getPipelineText).mockReset();
    }
  });

  it('refuses stored org-B readiness in Personal before reading or removing installs', async (): Promise<void> => {
    jest.clearAllMocks();
    mockInstallContextEnabled = true;
    const authorize = jest
      .spyOn(installContext, 'assertStoredPipelineContext')
      .mockRejectedValue(new Error('Pipeline unavailable (context-mismatch)'));
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'org-b-installed',
        originExternalId: 'org-b-remote',
        pipelineContentHash: 'stale',
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        distributionMode: 'package',
        installedAt: '2026-09-24T00:00:00Z',
      },
    ]);
    jest
      .mocked(localPipelineService.getPipelineText)
      .mockReturnValue({ success: true, data: 'changed' });
    try {
      await expect(
        getPackageReadiness({ pipeline: 'org-b-installed' }),
      ).rejects.toThrow('Pipeline unavailable (context-mismatch)');
      expect(listPipelinePackageInstalls).not.toHaveBeenCalled();
      expect(localPipelineService.getPipelineText).not.toHaveBeenCalled();
      expect(removePipelinePackageInstall).not.toHaveBeenCalled();
    } finally {
      mockInstallContextEnabled = false;
      authorize.mockRestore();
      jest.mocked(listPipelinePackageInstalls).mockReset();
      jest.mocked(localPipelineService.getPipelineText).mockReset();
    }
  });

  it('invalidates a packaged install whose exact pipeline bytes diverged', async () => {
    const reviewedRawPipeline = 'name: Packaged\non: dispatch\njobs: {}\n';
    jest.mocked(listPipelinePackageInstalls).mockResolvedValueOnce([
      {
        localPipelineId: 'local-package',
        originExternalId: 'share-package',
        pipelineContentHash: hashPipelinePackageYaml(reviewedRawPipeline),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        distributionMode: 'package',
        installedAt: '2026-08-30T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValueOnce({
      success: true,
      data: `# Recipient edit\n${reviewedRawPipeline}`,
    });

    try {
      await expect(
        getPackageReadiness({ pipeline: 'local-package' }),
      ).resolves.toEqual({ status: 'ready', requirements: [] });
      expect(removePipelinePackageInstall).toHaveBeenCalledWith(
        '/tmp/install-store.json',
        'local-package',
      );
      expect(verifyCachedPipelinePackage).not.toHaveBeenCalled();
    } finally {
      jest.mocked(localPipelineService.getPipelineText).mockReset();
    }
  });

  it('invalidates a cache whose manifest belongs to different pipeline bytes', async () => {
    const reviewedRawPipeline = 'name: Packaged\non: dispatch\njobs: {}\n';
    const pipelineContentHash = hashPipelinePackageYaml(reviewedRawPipeline);
    jest.mocked(listPipelinePackageInstalls).mockResolvedValueOnce([
      {
        localPipelineId: 'local-package',
        originExternalId: 'share-package',
        pipelineContentHash,
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        distributionMode: 'package',
        installedAt: '2026-08-30T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValueOnce({
      success: true,
      data: reviewedRawPipeline,
    });
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValueOnce({
      version: 1,
      pipelineContentHash: 'd'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    });

    try {
      await expect(
        getPackageReadiness({ pipeline: 'local-package' }),
      ).resolves.toEqual({ status: 'ready', requirements: [] });
      expect(removePipelinePackageInstall).toHaveBeenCalledWith(
        '/tmp/install-store.json',
        'local-package',
      );
    } finally {
      jest.mocked(localPipelineService.getPipelineText).mockReset();
    }
  });

  it('reports a required model missing when neither native auth nor AI Credits can run it', async () => {
    initCodexModels([
      { id: 'gpt-pipeline-package-test', label: 'Package test' },
    ]);
    jest.mocked(getCachedCodexAuthStatusObserved).mockResolvedValue({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    });
    jest.mocked(getAiCreditsRoutingContextWithStatus).mockResolvedValue({
      context: null,
      degraded: false,
    });
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-package',
      name: 'Packaged pipeline',
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
      rawPipeline: 'name: Packaged pipeline\non: dispatch\njobs: {}\n',
      distributionMode: 'package',
      package: {
        digest: `pp:v1:${'C'.repeat(43)}`,
        version: 1,
        resources: [],
        environmentRequirements: [
          requirement('gpt-pipeline-package-test', 'model'),
        ],
        publisherNotes,
        totalFiles: 0,
        totalBytes: 0,
      },
    });

    try {
      await expect(
        getPackageReadiness({
          pipeline: { source: 'shared', remoteId: 'remote-package' },
        }),
      ).resolves.toMatchObject({
        status: 'setup_required',
        requirements: [
          {
            id: 'gpt-pipeline-package-test',
            status: 'missing',
          },
        ],
        publisherNotes,
      });
      expect(getCachedCodexAuthStatusObserved).toHaveBeenCalled();
      expect(getCachedClaudeAuthStatusObserved).not.toHaveBeenCalled();
    } finally {
      initCodexModels([]);
    }
  });
  it('carries publisher notes from an installed package without changing readiness', async () => {
    const rawPipeline = 'name: Packaged\non: dispatch\njobs: {}\n';
    const pipelineContentHash = hashPipelinePackageYaml(rawPipeline);
    jest.mocked(listPipelinePackageInstalls).mockResolvedValueOnce([
      {
        localPipelineId: 'local-package-with-notes',
        originExternalId: 'share-package-with-notes',
        pipelineContentHash,
        packageDigest: `pp:v1:${'N'.repeat(43)}`,
        distributionMode: 'package',
        installedAt: '2026-09-17T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValueOnce({
      success: true,
      data: rawPipeline,
    });
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValueOnce({
      version: 1,
      pipelineContentHash,
      resources: [],
      bindings: [],
      environmentRequirements: [],
      publisherNotes,
      totalFiles: 0,
      totalBytes: 0,
    });

    try {
      await expect(
        getPackageReadiness({ pipeline: 'local-package-with-notes' }),
      ).resolves.toEqual({
        status: 'ready',
        distributionMode: 'package',
        requirements: [],
        publisherNotes,
      });
    } finally {
      jest.mocked(localPipelineService.getPipelineText).mockReset();
    }
  });
  it('reports a Cursor requirement missing until the runtime is connected', async () => {
    mockCursorAvailable.mockResolvedValue(false);
    jest.mocked(getCachedCodexAuthStatusObserved).mockClear();
    jest.mocked(getCachedClaudeAuthStatusObserved).mockClear();
    initCodexModels([
      { id: 'gpt-pipeline-package-test', label: 'Package test' },
    ]);
    jest.mocked(getCachedCodexAuthStatusObserved).mockResolvedValue({
      authenticated: true,
      accountLabel: null,
      detail: null,
      error: null,
    });
    jest.mocked(getAiCreditsRoutingContextWithStatus).mockResolvedValue({
      context: null,
      degraded: false,
    });
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-package',
      name: 'Packaged pipeline',
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
      rawPipeline: 'name: Packaged pipeline\non: dispatch\njobs: {}\n',
      distributionMode: 'package',
      package: {
        digest: `pp:v1:${'C'.repeat(43)}`,
        version: 1,
        resources: [],
        environmentRequirements: [requirement('cursor-default', 'model')],
        totalFiles: 0,
        totalBytes: 0,
      },
    });

    try {
      await expect(
        getPackageReadiness({
          pipeline: { source: 'shared', remoteId: 'remote-package' },
        }),
      ).resolves.toMatchObject({
        status: 'setup_required',
        requirements: [
          {
            id: 'cursor-default',
            status: 'missing',
          },
        ],
      });
      expect(getCachedCodexAuthStatusObserved).not.toHaveBeenCalled();
      expect(getCachedClaudeAuthStatusObserved).not.toHaveBeenCalled();
    } finally {
      initCodexModels([]);
    }
  });
  it('reports a Cursor requirement available when the managed runtime is connected', async () => {
    mockCursorAvailable.mockResolvedValue(true);
    jest.mocked(getCachedCodexAuthStatusObserved).mockClear();
    jest.mocked(getCachedClaudeAuthStatusObserved).mockClear();
    initCodexModels([
      { id: 'gpt-pipeline-package-test', label: 'Package test' },
    ]);
    jest.mocked(getCachedCodexAuthStatusObserved).mockResolvedValue({
      authenticated: true,
      accountLabel: null,
      detail: null,
      error: null,
    });
    jest.mocked(getAiCreditsRoutingContextWithStatus).mockResolvedValue({
      context: null,
      degraded: false,
    });
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-package',
      name: 'Packaged pipeline',
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
      rawPipeline: 'name: Packaged pipeline\non: dispatch\njobs: {}\n',
      distributionMode: 'package',
      package: {
        digest: `pp:v1:${'C'.repeat(43)}`,
        version: 1,
        resources: [],
        environmentRequirements: [requirement('cursor-default', 'model')],
        totalFiles: 0,
        totalBytes: 0,
      },
    });

    try {
      await expect(
        getPackageReadiness({
          pipeline: { source: 'shared', remoteId: 'remote-package' },
        }),
      ).resolves.toMatchObject({
        status: 'ready',
        requirements: [
          {
            id: 'cursor-default',
            status: 'available',
          },
        ],
      });
      expect(getCachedCodexAuthStatusObserved).not.toHaveBeenCalled();
      expect(getCachedClaudeAuthStatusObserved).not.toHaveBeenCalled();
    } finally {
      initCodexModels([]);
    }
  });
});

describe('automation capability package installation', () => {
  const digest = `pp:v1:${'A'.repeat(43)}`;
  const pipelineContentHash = 'a'.repeat(64);
  const manifest = {
    version: 1 as const,
    pipelineContentHash,
    resources: [
      {
        id: 'skill-1',
        kind: 'standalone_skill' as const,
        displayName: 'Review skill',
        sourceLabel: 'local',
        sourceVisibility: 'local' as const,
        invocationKeys: ['$review'],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'codex' as const,
            rootName: 'skills',
            entries: [],
          },
        ],
      },
    ],
    bindings: [
      {
        jobId: 'automation',
        stepId: 'action',
        resourceIds: ['skill-1'],
      },
    ],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallContextEnabled = false;
    jest.mocked(authorizeSharedPipelineCreate).mockReset();
  });

  it('materializes and records a package under its automation owner', async () => {
    jest.mocked(getAutomationPackage).mockResolvedValue({ digest, manifest });
    jest.mocked(installPipelinePackageAtomically).mockResolvedValue();
    const localContentHash = 'b'.repeat(64);

    await installAutomationCapabilityPackage({
      remoteId: 'remote-automation',
      localAutomationId: 'local-automation',
      packageRef: { version: 1, digest },
      localContentHash,
    });

    expect(installPipelinePackageAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        packagesRoot: '/tmp/pipeline-packages',
        digest,
        manifest,
      }),
    );
    expect(upsertCapabilityPackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        owner: {
          kind: 'automation',
          localAutomationId: 'local-automation',
        },
        originExternalId: 'remote-automation',
        localContentHash,
        pipelineContentHash,
        packageDigest: digest,
      }),
    );
  });

  it('downloads curated Automation packages from the catalog endpoint', async () => {
    jest
      .mocked(getCuratedAutomationPackage)
      .mockResolvedValue({ digest, manifest });
    jest.mocked(installPipelinePackageAtomically).mockResolvedValue();

    await installAutomationCapabilityPackage({
      remoteId: 'daily-review',
      localAutomationId: 'local-automation',
      packageRef: { version: 1, digest },
      source: 'curated',
    });

    expect(getCuratedAutomationPackage).toHaveBeenCalledWith(
      'daily-review',
      digest,
    );
    expect(getAutomationPackage).not.toHaveBeenCalled();
  });

  it('re-uploads an unchanged prompt package after rebinding it to a recipient workspace', async () => {
    const publisherContentHash = hashPipelinePackageYaml(
      JSON.stringify({
        name: 'Review prompt',
        action: {
          type: 'worktree_prompt',
          workspaceId: 'publisher-workspace',
          prompt: 'Run /review',
        },
      }),
    );
    const recipientContentHash = hashPipelinePackageYaml(
      JSON.stringify({
        name: 'Review prompt',
        action: {
          type: 'worktree_prompt',
          workspaceId: 'recipient-workspace',
          prompt: 'Run /review',
        },
      }),
    );
    const reboundManifest = {
      ...manifest,
      pipelineContentHash: publisherContentHash,
    };
    const reboundDigest = computePipelinePackageDigestSync(reboundManifest);
    let installedRecord: Awaited<
      ReturnType<typeof findCapabilityPackageInstallByOwner>
    > = null;
    jest
      .mocked(upsertCapabilityPackageInstall)
      .mockImplementation((_storePath, record) => {
        installedRecord = record;
        return Promise.resolve();
      });
    jest
      .mocked(findCapabilityPackageInstallByOwner)
      .mockImplementation(() => Promise.resolve(installedRecord));
    jest.mocked(getAutomationPackage).mockResolvedValue({
      digest: reboundDigest,
      manifest: reboundManifest,
    });
    jest.mocked(installPipelinePackageAtomically).mockResolvedValue();
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValue(reboundManifest);
    jest.mocked(preparePipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-installed',
      expiresAt: '2099-01-01T00:00:00.000Z',
      missingBlobs: [],
    });
    jest.mocked(commitPipelinePackageUpload).mockResolvedValue({
      uploadId: 'upload-installed',
      digest: reboundDigest,
      package: {
        digest: reboundDigest,
        version: 1,
        resources: reboundManifest.resources,
        environmentRequirements: reboundManifest.environmentRequirements,
        totalFiles: reboundManifest.totalFiles,
        totalBytes: reboundManifest.totalBytes,
      },
    });

    await installAutomationCapabilityPackage({
      remoteId: 'remote-automation',
      localAutomationId: 'local-automation',
      packageRef: { version: 1, digest: reboundDigest },
      localContentHash: recipientContentHash,
    });

    await expect(
      createPackagedAutomationCapabilityPackage({
        localAutomationId: 'local-automation',
        packageRef: { version: 1, digest: reboundDigest },
        expectedPackageContentHash: recipientContentHash,
      }),
    ).resolves.toEqual({
      capabilityPackage: { version: 1, digest: reboundDigest },
      committedPackageUploadId: 'upload-installed',
    });
    expect(publisherContentHash).not.toBe(recipientContentHash);
  });

  it('accepts an automation package bound to a bundled pipeline step', async () => {
    const pipelineBoundManifest = {
      ...manifest,
      bindings: [
        { jobId: 'different', stepId: 'step', resourceIds: ['skill-1'] },
      ],
    };
    jest.mocked(getAutomationPackage).mockResolvedValue({
      digest,
      manifest: pipelineBoundManifest,
    });
    jest.mocked(installPipelinePackageAtomically).mockResolvedValue();

    await expect(
      installAutomationCapabilityPackage({
        remoteId: 'remote-automation',
        localAutomationId: 'local-automation',
        packageRef: { version: 1, digest },
      }),
    ).resolves.toBeUndefined();
    expect(installPipelinePackageAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: pipelineBoundManifest }),
    );
  });

  it('names each packaged resource in automation install readiness', async () => {
    jest.mocked(getAutomationPackage).mockResolvedValue({ digest, manifest });

    await expect(
      getAutomationCapabilityPackageReadiness({
        remoteId: 'remote-automation',
        packageRef: { version: 1, digest },
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      includedResources: [
        {
          id: 'skill-1',
          displayName: 'Review skill',
          kind: 'standalone_skill',
        },
      ],
    });
  });

  it('marks an automation package with an unbound materialized resource invalid', async () => {
    jest.mocked(getAutomationPackage).mockResolvedValue({
      digest,
      manifest: { ...manifest, bindings: [] },
    });

    await expect(
      getAutomationCapabilityPackageReadiness({
        remoteId: 'remote-automation',
        packageRef: { version: 1, digest },
      }),
    ).resolves.toEqual({ status: 'invalid', requirements: [] });
  });

  it('resolves a pipeline-bound automation package for pipeline execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'automation-package-'));
    const rawPipeline =
      'pipeline:\n  name: Bundled review\n  on: dispatch\n  jobs: {}\n';
    const pipelineHash = hashPipelinePackageYaml(rawPipeline);
    const pipelineManifest = {
      ...manifest,
      pipelineContentHash: pipelineHash,
      bindings: [{ jobId: 'review', stepId: 'run', resourceIds: ['skill-1'] }],
    };
    const pipelinePath = join(directory, 'bundled.yaml');
    await writeFile(pipelinePath, rawPipeline, 'utf8');
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: pipelinePath,
    });
    jest.mocked(findCapabilityPackageInstallByOwner).mockResolvedValue({
      owner: { kind: 'automation', localAutomationId: 'local-automation' },
      originExternalId: 'remote-automation',
      pipelineContentHash: pipelineHash,
      packageDigest: digest,
      installedAt: '2026-09-18T12:00:00.000Z',
    });
    jest
      .mocked(verifyCachedPipelinePackage)
      .mockResolvedValue(pipelineManifest);

    try {
      await expect(
        resolveInstalledAutomationPipelinePackage(
          'local-automation',
          'bundled-pipeline',
          { version: 1, digest },
        ),
      ).resolves.toEqual({
        digest,
        rawPipeline,
        manifest: pipelineManifest,
        cachedPackagePath: join(
          '/tmp/pipeline-packages/packages',
          digest.slice('pp:v1:'.length),
        ),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed before materialization when the package digest changed', async () => {
    jest.mocked(getAutomationPackage).mockResolvedValue({
      digest: `pp:v1:${'B'.repeat(43)}`,
      manifest,
    });

    await expect(
      installAutomationCapabilityPackage({
        remoteId: 'remote-automation',
        localAutomationId: 'local-automation',
        packageRef: { version: 1, digest },
      }),
    ).rejects.toThrow('capability package changed');
    expect(installPipelinePackageAtomically).not.toHaveBeenCalled();
    expect(upsertCapabilityPackageInstall).not.toHaveBeenCalled();
  });

  it('ignores a stale automation package when the installed document no longer requires one', async () => {
    await expect(
      resolveInstalledAutomationPackageOverlay('local-automation'),
    ).resolves.toBeUndefined();
    expect(findCapabilityPackageInstallByOwner).not.toHaveBeenCalled();
  });

  it('builds an automation-scoped execution overlay from the verified cache', async () => {
    jest.mocked(findCapabilityPackageInstallByOwner).mockResolvedValue({
      owner: { kind: 'automation', localAutomationId: 'local-automation' },
      originExternalId: 'remote-automation',
      pipelineContentHash,
      packageDigest: digest,
      installedAt: '2026-09-18T12:00:00.000Z',
    });
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValue(manifest);

    await expect(
      resolveInstalledAutomationPackageOverlay('local-automation', {
        version: 1,
        digest,
      }),
    ).resolves.toMatchObject({
      packageDigest: digest,
      resources: [
        expect.objectContaining({ resourceId: 'skill-1', provider: 'codex' }),
      ],
    });
  });

  it('fails closed when a verified automation package has no action binding', async () => {
    jest.mocked(findCapabilityPackageInstallByOwner).mockResolvedValue({
      owner: { kind: 'automation', localAutomationId: 'local-automation' },
      originExternalId: 'remote-automation',
      pipelineContentHash,
      packageDigest: digest,
      installedAt: '2026-09-18T12:00:00.000Z',
    });
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValue({
      ...manifest,
      bindings: [],
    });

    await expect(
      resolveInstalledAutomationPackageOverlay('local-automation', {
        version: 1,
        digest,
      }),
    ).rejects.toThrow('automation action binding');
  });

  it('fails closed when a required automation package has no install record', async () => {
    jest.mocked(findCapabilityPackageInstallByOwner).mockResolvedValue(null);

    await expect(
      resolveInstalledAutomationPackageOverlay('local-automation', {
        version: 1,
        digest,
      }),
    ).rejects.toThrow('Reinstall the automation');
  });

  it('verifies a shared-pipeline install pin against the current detail', async () => {
    const rawPipeline = 'name: Shared\non: dispatch\njobs: {}\n';
    const installPin = {
      pipelineContentHash: hashPipelinePackageYaml(rawPipeline),
      distributionMode: 'definition_only' as const,
    };
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-pipeline',
      name: 'Shared',
      description: '',
      icon: '',
      version: '1.0.0',
      triggerTypes: ['dispatch'],
      scopes: ['directory'],
      createdBy: { id: 'user-1', name: 'Alice' },
      createdAt: '2026-09-18T12:00:00.000Z',
      updatedAt: '2026-09-18T12:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      rawPipeline,
      distributionMode: 'definition_only',
    });

    await expect(
      verifySharedPipelineAutomationInstallPin('remote-pipeline', installPin),
    ).resolves.toEqual(installPin);
    await expect(
      verifySharedPipelineAutomationInstallPin('remote-pipeline', {
        ...installPin,
        pipelineContentHash: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({
      name: 'SharedPipelinePinMismatchError',
      remoteId: 'remote-pipeline',
      pipelineName: 'Shared',
    });
    await expect(
      verifySharedPipelineAutomationInstallPin('remote-pipeline', {
        ...installPin,
        pipelineContentHash: 'b'.repeat(64),
      }),
    ).rejects.toThrow('could not be verified');
  });

  it('verifies a legacy definition-only pipeline detail with no distribution mode', async () => {
    const rawPipeline = 'name: Legacy shared\non: dispatch\njobs: {}\n';
    const installPin = {
      pipelineContentHash: hashPipelinePackageYaml(rawPipeline),
      distributionMode: 'definition_only' as const,
    };
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'legacy-remote-pipeline',
      name: 'Legacy shared',
      description: '',
      icon: '',
      version: '1.0.0',
      triggerTypes: ['dispatch'],
      scopes: ['directory'],
      createdBy: { id: 'user-1', name: 'Alice' },
      createdAt: '2026-09-18T12:00:00.000Z',
      updatedAt: '2026-09-18T12:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      rawPipeline,
    });

    await expect(
      verifySharedPipelineAutomationInstallPin(
        'legacy-remote-pipeline',
        installPin,
      ),
    ).resolves.toEqual(installPin);
  });

  it('derives the current shared-pipeline install pin for publishing', async () => {
    const rawPipeline = 'name: Shared\non: dispatch\njobs: {}\n';
    jest.mocked(getSharedPipeline).mockResolvedValue({
      id: 'remote-pipeline',
      name: 'Shared',
      description: '',
      icon: '',
      version: '1.0.0',
      triggerTypes: ['dispatch'],
      scopes: ['directory'],
      createdBy: { id: 'user-1', name: 'Alice' },
      createdAt: '2026-09-18T12:00:00.000Z',
      updatedAt: '2026-09-18T12:00:00.000Z',
      canUpdate: false,
      canDelete: false,
      rawPipeline,
      distributionMode: 'definition_only',
    });

    await expect(
      getSharedPipelineAutomationInstallPin('remote-pipeline'),
    ).resolves.toEqual({
      installPin: {
        pipelineContentHash: hashPipelinePackageYaml(rawPipeline),
        distributionMode: 'definition_only',
      },
      rawPipeline,
    });
  });
});

describe('public package installation transaction', () => {
  const externalId = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
  const rawPipeline = [
    'name: Shared package',
    'on: dispatch',
    'jobs:',
    '  review:',
    '    steps:',
    '      - run: echo ok',
    '',
  ].join('\n');
  const contentHash = hashPipelinePackageYaml(rawPipeline);
  const digest = `pp:v1:${'A'.repeat(43)}`;
  const manifest = {
    version: 1 as const,
    pipelineContentHash: contentHash,
    resources: [],
    bindings: [],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  };
  const request = {
    externalId,
    expectedPipelineContentHash: contentHash,
    expectedDistributionMode: 'package' as const,
    expectedPackageDigest: digest,
  };
  let root: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInstallContextEnabled = false;
    jest.mocked(authorizeSharedPipelineCreate).mockReset();
    root = await mkdtemp(join(tmpdir(), 'pipeline-package-install-'));
    mockReceiptDataDir = root;
    jest.mocked(getPublicPipelineShareSnapshot).mockResolvedValue({
      entity: 'pipeline',
      externalId,
      name: 'Shared package',
      description: '',
      rawPipeline,
      contentHash,
      distributionMode: 'package',
      package: {
        digest,
        version: 1,
        resources: [],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
      dependencies: [],
      authorUsername: null,
      updatedAt: '2026-08-30T12:00:00.000Z',
    });
    jest.mocked(getPublicPipelinePackage).mockResolvedValue({
      digest,
      manifest,
    });
    jest
      .mocked(installPipelinePackageAtomically)
      .mockResolvedValue(join(root, 'cached'));
    jest.mocked(findPipelinePackageInstall).mockResolvedValue(null);
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([]);
    jest.mocked(localPipelineService.listPipelines).mockReturnValue({
      success: true,
      data: [],
    });
    jest.mocked(localPipelineService.savePipeline).mockReturnValue({
      success: true,
      data: { id: 'created-pipeline' },
    } as never);
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: join(root, 'created-pipeline.yaml'),
    });
    jest.mocked(upsertPipelinePackageInstall).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const scopedInstallCases: Array<{
    distributionMode: 'definition_only' | 'package';
    failure: 'none' | 'create' | 'install-record';
  }> = [
    { distributionMode: 'definition_only', failure: 'none' },
    { distributionMode: 'package', failure: 'none' },
    { distributionMode: 'definition_only', failure: 'create' },
    { distributionMode: 'package', failure: 'create' },
    { distributionMode: 'definition_only', failure: 'install-record' },
    { distributionMode: 'package', failure: 'install-record' },
  ];
  it.each(scopedInstallCases)(
    'binds scoped $distributionMode installs to the persisted definition with failure=$failure',
    async ({ distributionMode, failure }) => {
      mockInstallContextEnabled = true;
      mockInstallContextRevision = 'original';
      const directory = join(root, 'definitions');
      const dir = jest
        .spyOn(pipelinePaths, 'getUserPipelinesDir')
        .mockReturnValue(directory);
      const index = jest
        .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
        .mockReturnValue(join(directory, 'index.json'));
      jest
        .mocked(localPipelineService.savePipeline)
        .mockImplementation(saveStoredPipeline);
      jest
        .mocked(localPipelineService.deletePipeline)
        .mockImplementation(deleteStoredPipeline);
      jest
        .mocked(localPipelineService.getPipelinePath)
        .mockImplementation(getStoredPipelinePath);
      if (failure === 'create')
        jest
          .mocked(localPipelineService.savePipeline)
          .mockReturnValueOnce({ success: false, error: 'create failed' });
      if (failure === 'install-record')
        jest
          .mocked(upsertPipelinePackageInstall)
          .mockRejectedValueOnce(new Error('install record failed'));
      const reviewed = await getPublicPipelineShareSnapshot(externalId);
      jest.mocked(getPublicPipelineShareSnapshot).mockResolvedValueOnce({
        ...reviewed,
        distributionMode,
        sourceRemoteId: 'remote-a',
      });
      jest.mocked(getSharedPipeline).mockResolvedValueOnce({
        id: 'remote-a',
        name: 'Shared package',
        description: '',
        icon: '',
        version: '1',
        triggerTypes: ['dispatch'],
        createdBy: { id: 'user-a', name: 'User' },
        createdAt: '2026-09-23T00:00:00Z',
        updatedAt: '2026-09-23T00:00:00Z',
        canUpdate: true,
        canDelete: true,
        rawPipeline,
        contentHash: 'remote-hash',
        shareScope: 'organization',
        owner: {
          type: 'organization',
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          name: 'A',
        },
      });
      jest.mocked(getPipelinePackage).mockResolvedValue({ digest, manifest });
      try {
        const operation = installPublicPackageShare({
          ...request,
          expectedDistributionMode: distributionMode,
        });
        if (failure !== 'none') {
          await expect(operation).rejects.toThrow(
            failure === 'create' ? 'create failed' : 'install record failed',
          );
          // Rollback keeps provenance but drops the aborted local binding.
          expect(
            (
              await createResourceInstallReceiptsStore(
                'user-a',
                root,
              ).listForAccount()
            ).flatMap((receipt) => receipt.localResourceIds ?? []),
          ).toEqual([]);
          expect(
            listStoredPipelines().data?.filter((row) => row.source === 'user'),
          ).toEqual([]);
          return;
        }
        const result = await operation;
        // A scoped share is the team or organization pipeline, not a Public
        // share, so it subscribes under that pipeline's id and hash.
        expect(recordSharedItemInstall).toHaveBeenCalledWith({
          kind: 'pipeline',
          remoteId: 'remote-a',
          sourceKind: 'shared',
          contentHash: 'remote-hash',
          localId: result.localPipelineId,
        });
        const receipts = await createResourceInstallReceiptsStore(
          'user-a',
          root,
        ).listForAccount();
        expect(receipts).toEqual([
          expect.objectContaining({
            localResourceIds: [result.localPipelineId],
          }),
        ]);
      } finally {
        mockInstallContextEnabled = false;
        dir.mockRestore();
        index.mockRestore();
      }
    },
  );

  it.each([false, true])(
    'rolls back a context change and retains provenance when deletion fails (%s)',
    async (deleteFails) => {
      jest
        .mocked(localPipelineService.deletePipeline)
        .mockReturnValue({ success: true });
      if (deleteFails)
        jest
          .mocked(localPipelineService.deletePipeline)
          .mockReturnValueOnce({ success: false, error: 'delete failed' });
      jest
        .mocked(localPipelineService.savePipeline)
        .mockImplementation((input, create) => ({
          success: true,
          data: {
            id: create?.id ?? input.id ?? 'created-pipeline',
            name: input.name,
            description: input.description,
            icon: input.icon,
            filename: 'created-pipeline.yaml',
            createdAt: '',
            updatedAt: '',
            source: 'user',
            readonly: false,
          },
        }));
      mockInstallContextEnabled = true;
      mockInstallContextRevision = 'original';
      const reviewed = await getPublicPipelineShareSnapshot(externalId);
      jest
        .mocked(getPublicPipelineShareSnapshot)
        .mockResolvedValueOnce({ ...reviewed, sourceRemoteId: 'remote-a' });
      jest.mocked(getSharedPipeline).mockResolvedValueOnce({
        id: 'remote-a',
        name: 'Shared package',
        description: '',
        icon: '',
        version: '1',
        triggerTypes: ['dispatch'],
        createdBy: { id: 'user-a', name: 'User' },
        createdAt: '2026-09-23T00:00:00Z',
        updatedAt: '2026-09-23T00:00:00Z',
        canUpdate: true,
        canDelete: true,
        rawPipeline,
        shareScope: 'organization',
        owner: {
          type: 'organization',
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          name: 'A',
        },
      });
      const cache = join(root, 'cached');
      jest
        .mocked(installPipelinePackageAtomically)
        .mockImplementationOnce(async (input) => {
          await mkdir(cache);
          await input.beforeCommit?.();
          input.onCreated?.(cache);
          return cache;
        });
      const privateDownload = jest
        .mocked(getPublicPipelinePackage)
        .getMockImplementation();
      if (!privateDownload) throw new Error('Missing package fixture');
      jest.mocked(getPipelinePackage).mockImplementationOnce(privateDownload);
      jest.mocked(upsertPipelinePackageInstall).mockImplementationOnce(() => {
        mockInstallContextRevision = 'changed';
        return Promise.resolve();
      });
      try {
        await expect(installPublicPackageShare(request)).rejects.toThrow(
          deleteFails
            ? 'delete failed'
            : 'Pipeline unavailable (context-mismatch)',
        );
        expect(localPipelineService.deletePipeline).toHaveBeenCalledWith(
          expect.any(String),
        );
        const receipts = await createResourceInstallReceiptsStore(
          'user-a',
          root,
        ).listForAccount();
        if (deleteFails) expect(receipts).toHaveLength(1);
        else
          expect(
            receipts.flatMap((receipt) => receipt.localResourceIds ?? []),
          ).toEqual([]);
        await expect(
          readFile(join(cache, 'manifest.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
        if (!deleteFails)
          expect(removePipelinePackageInstall).toHaveBeenCalledWith(
            '/tmp/install-store.json',
            expect.any(String),
          );
        // The created pipeline's owner entry is rolled back with it, but kept
        // when the pipeline itself couldn't be removed.
        if (deleteFails)
          expect(deleteUserPipelineLocalMetadata).not.toHaveBeenCalled();
        else
          expect(deleteUserPipelineLocalMetadata).toHaveBeenCalledWith(
            jest.mocked(recordUserPipelineOwner).mock.calls[0]?.[0],
          );
      } finally {
        mockInstallContextEnabled = false;
      }
    },
  );

  it('rejects a context change after staging before saving a pipeline', async () => {
    mockInstallContextEnabled = true;
    mockInstallContextRevision = 'original';
    jest.mocked(installPipelinePackageAtomically).mockImplementationOnce(() => {
      mockInstallContextRevision = 'changed';
      return Promise.resolve(join(root, 'cached'));
    });
    try {
      await expect(installPublicPackageShare(request)).rejects.toThrow(
        'Pipeline unavailable (context-mismatch)',
      );
      expect(localPipelineService.savePipeline).not.toHaveBeenCalled();
      expect(upsertPipelinePackageInstall).not.toHaveBeenCalled();
    } finally {
      mockInstallContextEnabled = false;
    }
  });

  it('registers a committed public install with the reviewed share id and hash', async () => {
    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'created-pipeline',
    });
    expect(recordSharedItemInstall).toHaveBeenCalledTimes(1);
    expect(recordSharedItemInstall).toHaveBeenCalledWith({
      kind: 'pipeline',
      remoteId: externalId,
      sourceKind: 'public',
      contentHash,
      localId: 'created-pipeline',
    });
  });

  it('does not register a public install whose local write failed', async () => {
    jest
      .mocked(upsertPipelinePackageInstall)
      .mockRejectedValueOnce(new Error('install record failed'));
    await expect(installPublicPackageShare(request)).rejects.toThrow(
      'install record failed',
    );
    expect(recordSharedItemInstall).not.toHaveBeenCalled();
  });

  it('registers coalesced concurrent installs once', async () => {
    await Promise.all([
      installPublicPackageShare(request),
      installPublicPackageShare(request),
    ]);
    expect(recordSharedItemInstall).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent installs of the same reviewed snapshot', async () => {
    const [first, second] = await Promise.all([
      installPublicPackageShare(request),
      installPublicPackageShare(request),
    ]);

    expect(first).toEqual(second);
    expect(localPipelineService.savePipeline).toHaveBeenCalledTimes(1);
    expect(upsertPipelinePackageInstall).toHaveBeenCalledTimes(1);
  });

  it('detaches an exact install record when its local YAML was edited', async () => {
    const locallyEditedRawPipeline =
      'name: Locally edited\non: dispatch\njobs: {}\n';
    jest.mocked(findPipelinePackageInstall).mockResolvedValue({
      localPipelineId: 'edited-pipeline',
      originExternalId: externalId,
      pipelineContentHash: contentHash,
      distributionMode: 'package',
      packageDigest: digest,
      installedAt: '2026-08-30T12:00:00.000Z',
    });
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: { id: 'edited-pipeline' },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: locallyEditedRawPipeline,
    });

    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'created-pipeline',
      packageDigest: digest,
    });
    expect(removePipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      'edited-pipeline',
    );
    expect(getPublicPipelinePackage).toHaveBeenCalledWith(externalId, digest);
    expect(localPipelineService.savePipeline).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'edited-pipeline' }),
    );
  });

  it('redownloads an exact install when its cached package is missing', async () => {
    jest.mocked(findPipelinePackageInstall).mockResolvedValue({
      localPipelineId: 'existing-pipeline',
      originExternalId: externalId,
      pipelineContentHash: contentHash,
      distributionMode: 'package',
      packageDigest: digest,
      installedAt: '2026-08-30T12:00:00.000Z',
    });
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'existing-pipeline',
        originExternalId: externalId,
        pipelineContentHash: contentHash,
        distributionMode: 'package',
        packageDigest: digest,
        installedAt: '2026-08-30T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: {
        info: { id: 'existing-pipeline' },
        content: {
          name: 'Shared package',
          on: 'dispatch',
          jobs: { review: { steps: [{ run: 'echo ok' }] } },
        },
      },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: rawPipeline,
    });
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValueOnce(null);

    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'existing-pipeline',
      packageDigest: digest,
    });
    expect(getPublicPipelinePackage).toHaveBeenCalledWith(externalId, digest);
    expect(installPipelinePackageAtomically).toHaveBeenCalled();
  });

  it('reuses an exact install after its YAML and cache verify', async () => {
    jest.mocked(findPipelinePackageInstall).mockResolvedValue({
      localPipelineId: 'existing-pipeline',
      originExternalId: externalId,
      pipelineContentHash: contentHash,
      distributionMode: 'package',
      packageDigest: digest,
      installedAt: '2026-08-30T12:00:00.000Z',
    });
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: { id: 'existing-pipeline' },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: rawPipeline,
    });
    jest.mocked(verifyCachedPipelinePackage).mockResolvedValueOnce(manifest);

    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'existing-pipeline',
      packageDigest: digest,
    });
    expect(verifyCachedPipelinePackage).toHaveBeenCalledWith(
      `/tmp/pipeline-packages/packages/${digest.slice('pp:v1:'.length)}`,
      digest,
    );
    expect(getPublicPipelinePackage).not.toHaveBeenCalled();
    expect(localPipelineService.savePipeline).not.toHaveBeenCalled();
  });

  it('preserves exact source YAML bytes when copying package provenance', async () => {
    const sourceRawPipeline = `# Reviewed recipient note\n${rawPipeline}`;
    const targetPath = join(root, 'duplicate.yaml');
    await writeFile(targetPath, 'pipeline:\n  name: Shared package (Copy)\n');
    jest.mocked(listPipelinePackageInstalls).mockResolvedValueOnce([
      {
        localPipelineId: 'source-pipeline',
        originExternalId: externalId,
        pipelineContentHash: hashPipelinePackageYaml(sourceRawPipeline),
        distributionMode: 'package',
        packageDigest: digest,
        installedAt: '2026-08-30T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: sourceRawPipeline,
    });
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: targetPath,
    });

    try {
      await copyPackageInstall('source-pipeline', 'duplicate-pipeline');

      await expect(readFile(targetPath, 'utf8')).resolves.toBe(
        sourceRawPipeline,
      );
      expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
        '/tmp/install-store.json',
        expect.objectContaining({
          localPipelineId: 'duplicate-pipeline',
          pipelineContentHash: hashPipelinePackageYaml(sourceRawPipeline),
          packageDigest: digest,
        }),
      );
    } finally {
      jest.mocked(localPipelineService.getPipelineText).mockReset();
      jest.mocked(localPipelineService.getPipelinePath).mockReset();
    }
  });

  it('installs and records a definition-only share without a package digest', async () => {
    jest.mocked(getPublicPipelineShareSnapshot).mockResolvedValueOnce({
      entity: 'pipeline',
      externalId,
      name: 'Shared package',
      description: '',
      rawPipeline,
      contentHash,
      distributionMode: 'definition_only',
    });

    await expect(
      installPublicPackageShare({
        externalId,
        expectedPipelineContentHash: contentHash,
        expectedDistributionMode: 'definition_only',
      } as never),
    ).resolves.toEqual({
      localPipelineId: 'created-pipeline',
      distributionMode: 'definition_only',
      resourceCount: 0,
    });
    expect(installPipelinePackageAtomically).not.toHaveBeenCalled();
    expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        localPipelineId: 'created-pipeline',
        originExternalId: externalId,
        pipelineContentHash: contentHash,
        distributionMode: 'definition_only',
      }),
    );
    expect(
      jest.mocked(upsertPipelinePackageInstall).mock.calls[0]?.[1],
    ).not.toHaveProperty('packageDigest');
  });

  it('keeps a committed install when its owner cannot be recorded', async () => {
    jest.mocked(getPublicPipelineShareSnapshot).mockResolvedValueOnce({
      entity: 'pipeline',
      externalId,
      name: 'Shared package',
      description: '',
      rawPipeline,
      contentHash,
      distributionMode: 'definition_only',
    });
    jest
      .mocked(selectedOwnerContext)
      .mockRejectedValueOnce(new Error('context unavailable'));

    await expect(
      installPublicPackageShare({
        externalId,
        expectedPipelineContentHash: contentHash,
        expectedDistributionMode: 'definition_only',
      } as never),
    ).resolves.toEqual({
      localPipelineId: 'created-pipeline',
      distributionMode: 'definition_only',
      resourceCount: 0,
    });
    expect(recordUserPipelineOwner).not.toHaveBeenCalled();
  });

  it('does not reassign another definition-only share linked to identical YAML', async () => {
    jest.mocked(getPublicPipelineShareSnapshot).mockResolvedValueOnce({
      entity: 'pipeline',
      externalId,
      name: 'Shared package',
      description: '',
      rawPipeline,
      contentHash,
      distributionMode: 'definition_only',
    });
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'other-share-pipeline',
        originExternalId: 'other-share',
        pipelineContentHash: contentHash,
        distributionMode: 'definition_only',
        installedAt: '2026-08-29T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.listPipelines).mockReturnValue({
      success: true,
      data: [
        {
          id: 'other-share-pipeline',
          source: 'user',
          readonly: false,
        },
      ],
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: rawPipeline,
    });

    await expect(
      installPublicPackageShare({
        externalId,
        expectedPipelineContentHash: contentHash,
        expectedDistributionMode: 'definition_only',
      }),
    ).resolves.toEqual({
      localPipelineId: 'created-pipeline',
      distributionMode: 'definition_only',
      resourceCount: 0,
    });
    expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        localPipelineId: 'created-pipeline',
        originExternalId: externalId,
      }),
    );
  });

  it('updates an unedited definition-only install when the share is republished', async () => {
    const previousRawPipeline =
      'name: Previous definition\non: dispatch\njobs: {}\n';
    const previousPath = join(root, 'existing-pipeline.yaml');
    await writeFile(previousPath, previousRawPipeline, 'utf8');
    jest.mocked(getPublicPipelineShareSnapshot).mockResolvedValueOnce({
      entity: 'pipeline',
      externalId,
      name: 'Shared package',
      description: '',
      rawPipeline,
      contentHash,
      distributionMode: 'definition_only',
    });
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'existing-pipeline',
        originExternalId: externalId,
        pipelineContentHash: hashPipelinePackageYaml(previousRawPipeline),
        distributionMode: 'definition_only',
        installedAt: '2026-08-29T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'existing-pipeline',
          name: 'Previous definition',
          description: 'Previous description',
          icon: 'workflow',
        },
        content: {
          name: 'Previous definition',
          on: 'dispatch',
          jobs: {},
        },
      },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: previousRawPipeline,
    });
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: previousPath,
    });
    jest.mocked(localPipelineService.savePipeline).mockReturnValue({
      success: true,
      data: { id: 'existing-pipeline' },
    } as never);

    await expect(
      installPublicPackageShare({
        externalId,
        expectedPipelineContentHash: contentHash,
        expectedDistributionMode: 'definition_only',
      }),
    ).resolves.toEqual({
      localPipelineId: 'existing-pipeline',
      distributionMode: 'definition_only',
      resourceCount: 0,
    });
    expect(localPipelineService.savePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-pipeline' }),
    );
    expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        localPipelineId: 'existing-pipeline',
        originExternalId: externalId,
        pipelineContentHash: contentHash,
        distributionMode: 'definition_only',
      }),
    );
    await expect(readFile(previousPath, 'utf8')).resolves.toBe(rawPipeline);
    expect(localPipelineService.deletePipeline).not.toHaveBeenCalled();
  });

  it('keeps the local identity when a package share becomes definition-only', async () => {
    const previousRawPipeline =
      'name: Previous package\non: dispatch\njobs: {}\n';
    const previousPath = join(root, 'existing-pipeline.yaml');
    await writeFile(previousPath, previousRawPipeline, 'utf8');
    jest.mocked(getPublicPipelineShareSnapshot).mockResolvedValueOnce({
      entity: 'pipeline',
      externalId,
      name: 'Shared package',
      description: '',
      rawPipeline,
      contentHash,
      distributionMode: 'definition_only',
    });
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'existing-pipeline',
        originExternalId: externalId,
        pipelineContentHash: hashPipelinePackageYaml(previousRawPipeline),
        distributionMode: 'package',
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-08-29T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'existing-pipeline',
          name: 'Previous package',
          description: 'Previous description',
          icon: 'workflow',
        },
        content: { name: 'Previous package', on: 'dispatch', jobs: {} },
      },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: previousRawPipeline,
    });
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: previousPath,
    });
    jest.mocked(localPipelineService.savePipeline).mockReturnValue({
      success: true,
      data: { id: 'existing-pipeline' },
    } as never);

    await expect(
      installPublicPackageShare({
        externalId,
        expectedPipelineContentHash: contentHash,
        expectedDistributionMode: 'definition_only',
      }),
    ).resolves.toMatchObject({
      localPipelineId: 'existing-pipeline',
      distributionMode: 'definition_only',
    });
    expect(localPipelineService.savePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-pipeline' }),
    );
    expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        localPipelineId: 'existing-pipeline',
        distributionMode: 'definition_only',
      }),
    );
  });

  it('attaches a package to an exact unlinked local YAML without creating a copy', async () => {
    jest.mocked(localPipelineService.listPipelines).mockReturnValue({
      success: true,
      data: [
        {
          id: 'existing-pipeline',
          source: 'user',
          readonly: false,
        },
      ],
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: rawPipeline,
    });

    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'existing-pipeline',
      packageDigest: digest,
    });
    expect(localPipelineService.savePipeline).not.toHaveBeenCalled();
    expect(localPipelineService.deletePipeline).not.toHaveBeenCalled();
    expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({ localPipelineId: 'existing-pipeline' }),
    );
  });

  it('updates the existing local pipeline for a republished package share', async () => {
    const previousRawPipeline =
      'name: Previous package\non: dispatch\njobs: {}\n';
    const previousPath = join(root, 'existing-pipeline.yaml');
    await writeFile(previousPath, previousRawPipeline, 'utf8');
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'existing-pipeline',
        originExternalId: request.externalId,
        pipelineContentHash: hashPipelinePackageYaml(previousRawPipeline),
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-08-29T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: {
        info: { id: 'existing-pipeline' },
        content: {
          name: 'Previous package',
          on: 'dispatch',
          jobs: {},
        },
      },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: previousRawPipeline,
    });
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: previousPath,
    });
    jest.mocked(localPipelineService.savePipeline).mockReturnValue({
      success: true,
      data: { id: 'existing-pipeline' },
    } as never);

    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'existing-pipeline',
      packageDigest: digest,
    });
    expect(localPipelineService.savePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-pipeline' }),
    );
    expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        localPipelineId: 'existing-pipeline',
        originExternalId: request.externalId,
        packageDigest: digest,
      }),
    );
    expect(localPipelineService.deletePipeline).not.toHaveBeenCalled();
  });

  it('keeps the local identity when a definition-only share becomes packaged', async () => {
    const previousRawPipeline =
      'name: Previous definition\non: dispatch\njobs: {}\n';
    const previousPath = join(root, 'existing-pipeline.yaml');
    await writeFile(previousPath, previousRawPipeline, 'utf8');
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'existing-pipeline',
        originExternalId: request.externalId,
        pipelineContentHash: hashPipelinePackageYaml(previousRawPipeline),
        distributionMode: 'definition_only',
        installedAt: '2026-08-29T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'existing-pipeline',
          name: 'Previous definition',
          description: 'Previous description',
          icon: 'workflow',
        },
        content: { name: 'Previous definition', on: 'dispatch', jobs: {} },
      },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: previousRawPipeline,
    });
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: previousPath,
    });
    jest.mocked(localPipelineService.savePipeline).mockReturnValue({
      success: true,
      data: { id: 'existing-pipeline' },
    } as never);

    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'existing-pipeline',
      distributionMode: 'package',
      packageDigest: digest,
    });
    expect(localPipelineService.savePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-pipeline' }),
    );
    expect(upsertPipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        localPipelineId: 'existing-pipeline',
        distributionMode: 'package',
        packageDigest: digest,
      }),
    );
  });

  it('detaches a stale install record instead of overwriting locally edited YAML', async () => {
    const installedRawPipeline =
      'name: Previously installed\non: dispatch\njobs: {}\n';
    const locallyEditedRawPipeline =
      'name: Locally edited\non: dispatch\njobs: {}\n';
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'edited-pipeline',
        originExternalId: request.externalId,
        pipelineContentHash: hashPipelinePackageYaml(installedRawPipeline),
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-08-29T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: {
        info: { id: 'edited-pipeline' },
        content: {
          name: 'Locally edited',
          on: 'dispatch',
          jobs: {},
        },
      },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: locallyEditedRawPipeline,
    });

    await expect(installPublicPackageShare(request)).resolves.toMatchObject({
      localPipelineId: 'created-pipeline',
      packageDigest: digest,
    });
    expect(removePipelinePackageInstall).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      'edited-pipeline',
    );
    expect(localPipelineService.savePipeline).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'edited-pipeline' }),
    );
  });

  it('restores the previous YAML when a package update ledger write fails', async () => {
    const previousRawPipeline =
      'name: Previous package\non: dispatch\njobs: {}\n';
    const previousContent: Pipeline = {
      name: 'Previous package',
      on: 'dispatch',
      jobs: {},
    };
    const previousPath = join(root, 'existing-pipeline.yaml');
    await writeFile(previousPath, previousRawPipeline, 'utf8');
    jest.mocked(listPipelinePackageInstalls).mockResolvedValue([
      {
        localPipelineId: 'existing-pipeline',
        originExternalId: request.externalId,
        pipelineContentHash: hashPipelinePackageYaml(previousRawPipeline),
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-08-29T12:00:00.000Z',
      },
    ]);
    jest.mocked(localPipelineService.getPipeline).mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'existing-pipeline',
          name: 'Previous package',
          description: 'Previous description',
          icon: 'workflow',
        },
        content: previousContent,
      },
    } as never);
    jest.mocked(localPipelineService.getPipelineText).mockReturnValue({
      success: true,
      data: previousRawPipeline,
    });
    jest.mocked(localPipelineService.getPipelinePath).mockReturnValue({
      success: true,
      data: previousPath,
    });
    jest.mocked(localPipelineService.savePipeline).mockReturnValue({
      success: true,
      data: { id: 'existing-pipeline' },
    } as never);
    jest
      .mocked(upsertPipelinePackageInstall)
      .mockRejectedValue(new Error('ledger write failed'));

    await expect(installPublicPackageShare(request)).rejects.toThrow(
      'ledger write failed',
    );
    await expect(readFile(previousPath, 'utf8')).resolves.toBe(
      previousRawPipeline,
    );
    expect(localPipelineService.savePipeline).toHaveBeenLastCalledWith({
      id: 'existing-pipeline',
      name: 'Previous package',
      description: 'Previous description',
      icon: 'workflow',
      content: previousContent,
    });
  });
});
