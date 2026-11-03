/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  DeepLinkResolveShareResponse,
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
} from '@canopy/desktop-shared/types';
import type { DetectPublicAgentRequest } from '@canopy/desktop-shared/types/agent-models';
import type { PipelinePackageReadiness } from '@canopy/desktop-shared/types/pipeline';
import * as CollectionImport from '@/lib/sharedCollectionImport';
import {
  CUSTOM_SKILL_SOURCE_ID,
  findInstalledSkillByContentHash,
} from '@/lib/sharedSkillImport';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';
import type * as SharedSkillImportModule from '@/lib/sharedSkillImport';
import type { SharedWorkspaceTemplateDocument } from '@canopy/protocol';
import { tryParseAndValidateYaml } from '@/lib/pipeline-yaml';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  type PublicShareLanding,
  usePublicShareLanding,
} from '../usePublicShareLanding';

let mockResourceContextEnabled = false;
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: {
    getState: (): { isEnabled: () => boolean } => ({
      isEnabled: (): boolean => mockResourceContextEnabled,
    }),
  },
}));
const mockImportSharedSkill = jest.fn();
const mockLookupInstalledSharedSkill = jest.fn();
jest.mock('@/lib/sharedSkillImport', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/sharedSkillImport'),
  findInstalledSkillByContentHash: jest.fn().mockResolvedValue(null),
  lookupInstalledSharedSkill: (...args: unknown[]): unknown =>
    mockLookupInstalledSharedSkill(...args),
  importSharedSkill: (...args: unknown[]): unknown =>
    mockImportSharedSkill(...args),
}));
const mockInsertSkillInvocation = jest.fn();
jest.mock('../shareChatTarget', () => ({
  watchShareChatTarget: jest.fn(() => (): void => undefined),
  insertSkillInvocation: (...args: unknown[]): unknown =>
    mockInsertSkillInvocation(...args),
}));
const mockOpenPipelineEdit = jest.fn();
const mockOpenAutomationEdit = jest.fn();
const mockNavigate = jest.fn();
const mockLoadChatProjects = jest.fn().mockResolvedValue(undefined);
const mockSwitchChatProject = jest.fn().mockResolvedValue(true);
const mockLoadProjects = jest.fn().mockResolvedValue(undefined);
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    subscribe: jest.fn(() => (): void => undefined),
    getState: (): {
      openPipelineEdit: jest.Mock;
      openAutomationEdit: jest.Mock;
      openPipelineDispatch: jest.Mock;
      openSkillViewer: jest.Mock;
      navigate: jest.Mock;
    } => ({
      openPipelineEdit: mockOpenPipelineEdit,
      openAutomationEdit: mockOpenAutomationEdit,
      openPipelineDispatch: jest.fn(),
      openSkillViewer: jest.fn(),
      navigate: mockNavigate,
    }),
  },
}));
const mockRequestConnect = jest.fn<void, [{ subtitle?: string }, () => void]>();
// The real store imports openBillingPage, which imports this mock, so the
// actual module loads only when isConnectedNonGuest is first called.
jest.mock('@/stores/cloudConnectGateStore', () => ({
  isConnectedNonGuest: (
    account: CanopyCloudAccountPublicState | null | undefined,
  ): boolean =>
    jest
      .requireActual<{
        isConnectedNonGuest: (
          account: CanopyCloudAccountPublicState | null | undefined,
        ) => boolean;
      }>('@/stores/cloudConnectGateStore')
      .isConnectedNonGuest(account),
  useCloudConnectGateStore: {
    getState: (): { requestConnect: typeof mockRequestConnect } => ({
      requestConnect: mockRequestConnect,
    }),
  },
}));
const mockOpenCloudAccountSettings = jest.fn();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openCloudAccountSettings: (...args: unknown[]): unknown =>
    mockOpenCloudAccountSettings(...args),
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { selectedWorktree: null } => ({ selectedWorktree: null }),
  },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): {
      loadChatProjects: typeof mockLoadChatProjects;
      switchChatProject: typeof mockSwitchChatProject;
    } => ({
      loadChatProjects: mockLoadChatProjects,
      switchChatProject: mockSwitchChatProject,
    }),
  },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { loadProjects: typeof mockLoadProjects } => ({
      loadProjects: mockLoadProjects,
    }),
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RAW_PIPELINE = 'name: Packaged\non: dispatch\njobs: {}\n';
const OLD_DIGEST = `pp:v1:${'A'.repeat(43)}`;
const NEW_DIGEST = `pp:v1:${'B'.repeat(43)}`;
const SHARE_ID = '4f4f51c1-a72b-4e12-9320-a038b90189f0';
const CONTENT_HASH = 'c'.repeat(64);

const snapshot = {
  entity: 'pipeline',
  externalId: SHARE_ID,
  name: 'Packaged',
  description: 'Packaged fixture',
  rawPipeline: RAW_PIPELINE,
  contentHash: CONTENT_HASH,
  distributionMode: 'package',
  package: {
    digest: NEW_DIGEST,
    version: 1,
    resources: [],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  },
  authorUsername: 'fixture-author',
  updatedAt: '2026-08-30T00:00:00.000Z',
} as PublicShareSnapshot;

const link: DeepLinkShareOpenEvent = {
  entity: 'pipeline',
  externalId: SHARE_ID,
  intent: 'try',
  expectedPipelineContentHash: CONTENT_HASH,
  expectedDistributionMode: 'package',
  expectedPackageDigest: NEW_DIGEST,
};

interface HookProbe {
  current: PublicShareLanding | null;
}

function Harness({ probe }: { probe: HookProbe }): null {
  probe.current = usePublicShareLanding(link);
  return null;
}

const workspaceLink: DeepLinkShareOpenEvent = {
  entity: 'workspace',
  externalId: SHARE_ID,
  intent: 'try',
  expectedWorkspaceTemplateContentHash: CONTENT_HASH,
};

function WorkspaceHarness({
  probe,
  shareLink = workspaceLink,
}: {
  probe: HookProbe;
  shareLink?: DeepLinkShareOpenEvent;
}): null {
  probe.current = usePublicShareLanding(shareLink);
  return null;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('usePublicShareLanding package failure guards', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  const installPackageShare = jest.fn();
  const deletePipeline = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    const parsed = tryParseAndValidateYaml(RAW_PIPELINE);
    if (!parsed.success) throw new Error(parsed.error);
    Object.assign(window, {
      api: {
        deepLinkResolveShare: jest.fn().mockResolvedValue({
          ok: true,
          snapshot,
        }),
        deepLinkReportHandoffEvent: jest.fn().mockResolvedValue({
          success: true,
        }),
      },
      pipelines: {
        list: jest.fn().mockResolvedValue({
          success: true,
          data: [{ id: 'pipeline-1', source: 'user', name: 'Packaged' }],
        }),
        get: jest.fn().mockResolvedValue({
          success: true,
          data: { content: parsed.pipeline },
        }),
        listPackageInstalls: jest.fn().mockResolvedValue({
          success: true,
          data: [
            {
              localPipelineId: 'pipeline-1',
              originExternalId: SHARE_ID,
              pipelineContentHash: CONTENT_HASH,
              packageDigest: OLD_DIGEST,
              distributionMode: 'package',
            },
          ],
        }),
        getPackageReadiness: jest.fn().mockResolvedValue({
          success: true,
          data: {
            status: 'invalid',
            distributionMode: 'package',
            requirements: [],
          },
        }),
        installPackageShare,
        delete: deletePipeline,
      },
    });
    deletePipeline.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('invalidates callbacks captured before authoritative validation fails', async () => {
    await act(async () => {
      root.render(<Harness probe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    const landing = probe.current;
    expect(landing?.installed).toMatchObject({
      entity: 'pipeline',
      pipelineId: 'pipeline-1',
      updateAvailable: true,
    });
    if (!landing) throw new Error('Expected landing hook to render');
    const staleTryNow = landing.tryNow;
    const staleManage = landing.manage;
    const staleUninstall = landing.uninstall;
    const pending = deferred<{ success: false; error: string }>();
    installPackageShare.mockReturnValueOnce(pending.promise);

    let installation!: Promise<unknown>;
    act(() => {
      installation = landing.install();
    });
    pending.resolve({ success: false, error: 'Delayed package failure' });
    await act(async () => installation);

    await act(async () => {
      staleTryNow();
      staleManage();
      await staleUninstall();
    });

    expect(mockOpenPipelineEdit).not.toHaveBeenCalled();
    expect(deletePipeline).not.toHaveBeenCalled();
  });

  it('reports a definition-only install as installed, so the review lands on it', async () => {
    const definitionOnly = {
      ...snapshot,
      distributionMode: 'definition_only',
      package: undefined,
    } as PublicShareSnapshot;
    Object.assign(window.api, {
      deepLinkResolveShare: jest
        .fn()
        .mockResolvedValue({ ok: true, snapshot: definitionOnly }),
    });
    Object.assign(window.pipelines, {
      list: jest.fn().mockResolvedValue({ success: true, data: [] }),
      listPackageInstalls: jest
        .fn()
        .mockResolvedValue({ success: true, data: [] }),
    });
    installPackageShare.mockResolvedValueOnce({
      success: true,
      data: {
        localPipelineId: 'pipeline-2',
        distributionMode: 'definition_only',
      },
    });
    const definitionLink: DeepLinkShareOpenEvent = {
      entity: 'pipeline',
      externalId: SHARE_ID,
      intent: 'install',
      expectedPipelineContentHash: CONTENT_HASH,
      expectedDistributionMode: 'definition_only',
    };
    function DefinitionHarness(): null {
      probe.current = usePublicShareLanding(definitionLink);
      return null;
    }
    await act(async () => {
      root.render(<DefinitionHarness />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    let result: Awaited<ReturnType<PublicShareLanding['install']>> = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });

    expect(result).toEqual({
      target: { entity: 'pipeline', pipelineId: 'pipeline-2' },
      status: 'Workflow definition installed without dependencies.',
      // The author chose to share the definition alone; nothing failed.
      partial: false,
    });
  });

  it('never installs a pipeline install link on arrival', async () => {
    const installLink: DeepLinkShareOpenEvent = { ...link, intent: 'install' };
    function InstallHarness(): null {
      probe.current = usePublicShareLanding(installLink, {
        reportHandoffEvents: true,
      });
      return null;
    }
    await act(async () => {
      root.render(<InstallHarness />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(probe.current?.state.phase).toBe('ready');
    expect(installPackageShare).not.toHaveBeenCalled();
    expect(window.api.deepLinkReportHandoffEvent).not.toHaveBeenCalled();
  });
});

describe('usePublicShareLanding workspace templates', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  let createFromTemplate: jest.MockedFunction<
    (input: {
      template: SharedWorkspaceTemplateDocument;
      sourceTemplate: {
        externalId: string;
        contentHash: string;
        package?: unknown;
        skillPackages?: unknown[];
      };
    }) => Promise<{
      project: { id: string };
      unresolvedRefs: string[];
    }>
  >;
  let listChatProjects: jest.Mock;
  let inspectTemplateCapabilityPackages: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    createFromTemplate = jest.fn().mockResolvedValue({
      project: { id: 'workspace-1' },
      unresolvedRefs: ['plugin:missing'],
    });
    listChatProjects = jest.fn().mockResolvedValue({ projects: [] });
    inspectTemplateCapabilityPackages = jest.fn().mockResolvedValue({
      status: 'setup_required',
      distributionMode: 'package',
      requirements: [
        {
          id: 'mcp:slack',
          kind: 'mcp',
          displayName: 'Slack',
          required: true,
          affectedSteps: [],
          setupHint: 'Connect Slack.',
          status: 'missing',
          detail: 'MCP server is not installed.',
        },
      ],
    });
    Object.assign(window, {
      api: {
        deepLinkResolveShare: jest.fn().mockResolvedValue({
          ok: true,
          snapshot: {
            entity: 'workspace',
            externalId: SHARE_ID,
            template: {
              version: 1,
              name: 'Biology 101',
              description: 'Course workspace',
              instructions: 'Tutor patiently.',
              plugins: [],
              customSkills: [],
            },
            contentHash: CONTENT_HASH,
            distributionMode: 'package',
            package: {
              digest: NEW_DIGEST,
              version: 1,
              resources: [],
              environmentRequirements: [],
              totalFiles: 0,
              totalBytes: 0,
            },
            skillPackages: [
              {
                clientKey: 'skill-1',
                package: {
                  digest: OLD_DIGEST,
                  version: 1,
                  resources: [],
                  environmentRequirements: [],
                  totalFiles: 0,
                  totalBytes: 0,
                },
              },
            ],
            authorUsername: null,
            updatedAt: '2026-09-09T00:00:00.000Z',
          },
        }),
        deepLinkReportHandoffEvent: jest.fn().mockResolvedValue({
          success: true,
        }),
        chatProject: {
          createFromTemplate,
          list: listChatProjects,
          inspectTemplateCapabilityPackages,
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('installs the snapshot through chat-project IPC and opens the workspace for Try', async () => {
    await act(async () => {
      root.render(<WorkspaceHarness probe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    if (!probe.current) throw new Error('Expected workspace landing');

    expect(inspectTemplateCapabilityPackages).toHaveBeenCalledWith({
      packages: [
        expect.objectContaining({ digest: NEW_DIGEST }),
        expect.objectContaining({ digest: OLD_DIGEST }),
      ],
    });
    expect(probe.current.workspaceReadiness).toMatchObject({
      status: 'setup_required',
      requirements: [expect.objectContaining({ status: 'missing' })],
    });

    expect(window.api.deepLinkResolveShare).toHaveBeenCalledWith({
      entity: 'workspace',
      externalId: SHARE_ID,
      expectedWorkspaceTemplateContentHash: CONTENT_HASH,
    });

    await act(async () => probe.current?.install());

    expect(createFromTemplate).toHaveBeenCalledTimes(1);
    expect(createFromTemplate.mock.calls[0]?.[0]).toMatchObject({
      seed: 'shared',
    });
    const createRequest = createFromTemplate.mock.calls[0]?.[0];
    expect(createRequest?.template).toBeUndefined();
    expect(createRequest?.sourceTemplate).toEqual({
      externalId: SHARE_ID,
      contentHash: CONTENT_HASH,
      // Jest's asymmetric matcher is intentionally untyped.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      package: expect.objectContaining({ digest: NEW_DIGEST }),
      skillPackages: [
        expect.objectContaining({
          clientKey: 'skill-1',
          // Jest's asymmetric matcher is intentionally untyped.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          package: expect.objectContaining({ digest: OLD_DIGEST }),
        }),
      ],
    });
    expect(mockLoadChatProjects).toHaveBeenCalledTimes(1);
    expect(mockLoadProjects).toHaveBeenCalledWith({ silent: true });
    expect(probe.current?.installed).toEqual({
      entity: 'workspace',
      projectId: 'workspace-1',
    });
    expect(probe.current?.installStatus).toContain('1 item unavailable');

    act(() => probe.current?.tryNow());
    expect(mockSwitchChatProject).toHaveBeenCalledWith('workspace-1');
    expect(mockNavigate).toHaveBeenCalledWith('chat');
  });

  it('detects an existing completed installation by source share identity', async () => {
    listChatProjects.mockResolvedValue({
      projects: [
        {
          id: 'workspace-1',
          name: 'Customized locally',
          createdAt: '2026-09-09T00:00:00.000Z',
          installedFromTemplateExternalId: SHARE_ID,
          installedFromTemplateContentHash: 'a'.repeat(64),
        },
      ],
    });

    await act(async () => {
      root.render(<WorkspaceHarness probe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(probe.current?.installed).toEqual({
      entity: 'workspace',
      projectId: 'workspace-1',
    });
    expect(createFromTemplate).not.toHaveBeenCalled();
  });

  it('keeps a partial packaged project installable after the landing remounts', async () => {
    createFromTemplate
      .mockRejectedValueOnce(new Error('package download failed'))
      .mockResolvedValueOnce({
        project: { id: 'workspace-1' },
        unresolvedRefs: [],
      });

    await act(async () => {
      root.render(<WorkspaceHarness probe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    await act(async () => probe.current?.install());
    expect(probe.current?.installError).toContain('package download failed');

    listChatProjects.mockResolvedValue({
      projects: [
        {
          id: 'workspace-1',
          name: 'Biology 101',
          createdAt: '2026-09-09T00:00:00.000Z',
          installedFromTemplateExternalId: SHARE_ID,
        },
      ],
    });
    act(() => root.unmount());
    root = createRoot(container);
    probe = { current: null };
    await act(async () => {
      root.render(<WorkspaceHarness probe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(probe.current?.installed).toBeNull();
    await act(async () => probe.current?.install());
    expect(createFromTemplate).toHaveBeenCalledTimes(2);
    expect(probe.current?.installed).toEqual({
      entity: 'workspace',
      projectId: 'workspace-1',
    });
  });

  it('requires an explicit click for an install-intent project template', async () => {
    await act(async () => {
      root.render(
        <WorkspaceHarness
          probe={probe}
          shareLink={{ ...workspaceLink, intent: 'install' }}
        />,
      );
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(probe.current?.state.phase).toBe('ready');
    expect(createFromTemplate).not.toHaveBeenCalled();
  });
});

describe('usePublicShareLanding public Agents', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  const importPublic = jest.fn();
  const inspectPublic = jest.fn<
    Promise<PipelinePackageReadiness>,
    [DetectPublicAgentRequest]
  >();
  const agentLink: DeepLinkShareOpenEvent = {
    entity: 'agent',
    externalId: SHARE_ID,
    intent: 'install',
  };
  const agentPackage = {
    digest: NEW_DIGEST,
    version: 1 as const,
    resources: [],
    environmentRequirements: [
      {
        id: 'mcp:slack',
        kind: 'mcp' as const,
        displayName: 'slack',
        required: true,
        affectedSteps: [],
        setupHint: 'Connect Slack in Settings.',
      },
    ],
    totalFiles: 0,
    totalBytes: 0,
  };

  function AgentHarness({ hookProbe }: { hookProbe: HookProbe }): null {
    hookProbe.current = usePublicShareLanding(agentLink);
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    importPublic.mockResolvedValue({ id: 'agent_model_reviewer' });
    inspectPublic.mockResolvedValue({
      status: 'ready',
      distributionMode: 'package',
      requirements: [
        {
          ...agentPackage.environmentRequirements[0],
          status: 'available',
          detail: 'MCP server is connected.',
        },
      ],
    });
    Object.assign(window, {
      api: {
        deepLinkResolveShare: jest.fn().mockResolvedValue({
          ok: true,
          snapshot: {
            entity: 'agent',
            externalId: SHARE_ID,
            agent: {
              version: 1,
              id: 'agent_model_reviewer',
              name: 'Reviewer',
              baseModel: 'sonnet',
              instructions: 'Review carefully.',
              plugins: [],
            },
            contentHash: CONTENT_HASH,
            distributionMode: 'package',
            package: agentPackage,
            authorUsername: null,
            updatedAt: '2026-09-23T00:00:00.000Z',
          },
        }),
        deepLinkReportHandoffEvent: jest.fn().mockResolvedValue({
          success: true,
        }),
      },
      agents: {
        detectPublic: jest.fn().mockResolvedValue(null),
        inspectPublic,
        importPublic,
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('passes the reviewed package into the one-step public import', async () => {
    await act(async () => {
      root.render(<AgentHarness hookProbe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    await act(async () => probe.current?.install());

    expect(importPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: SHARE_ID,
        contentHash: CONTENT_HASH,
        package: agentPackage,
        installMissing: true,
      }),
    );
  });

  it('loads machine-specific package readiness before public Agent install', async () => {
    await act(async () => {
      root.render(<AgentHarness hookProbe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(inspectPublic).toHaveBeenCalledWith({
      agent: {
        version: 1,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review carefully.',
        plugins: [],
      },
      externalId: SHARE_ID,
      contentHash: CONTENT_HASH,
      package: agentPackage,
    });
    expect(
      (
        probe.current as unknown as {
          agentReadiness: { requirements: Array<{ status: string }> } | null;
        }
      )?.agentReadiness?.requirements[0]?.status,
    ).toBe('available');
  });

  it('does not auto-install an install-intent Agent while readiness is under review', async () => {
    let resolveReadiness: ((value: PipelinePackageReadiness) => void) | null =
      null;
    inspectPublic.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReadiness = resolve;
      }),
    );

    await act(async () => {
      root.render(<AgentHarness hookProbe={probe} />);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(probe.current?.agentReadinessLoading).toBe(true);
    expect(importPublic).not.toHaveBeenCalled();

    await act(async () => {
      resolveReadiness?.({
        status: 'ready',
        distributionMode: 'package',
        requirements: [],
      });
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });

    expect(probe.current?.agentReadinessLoading).toBe(false);
    expect(importPublic).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CAN-3135: a public automation link installs through a review wizard.
// ---------------------------------------------------------------------------

const AUTOMATION_SHARE_ID = '7a2f0c11-5b3e-4a77-9d21-0c4e9a7b3f10';
const AUTOMATION_CONTENT_HASH = 'd'.repeat(64);

const automationSnapshot = {
  entity: 'automation',
  externalId: AUTOMATION_SHARE_ID,
  contentHash: AUTOMATION_CONTENT_HASH,
  automation: {
    version: 1,
    name: 'Nightly review',
    description: 'Reviews changes overnight.',
    trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'app_advisor_prompt',
      prompt: 'Check the queue',
    },
    hasRunCondition: false,
  },
  authorUsername: null,
  updatedAt: '2026-09-15T00:00:00.000Z',
} as PublicShareSnapshot;

const automationLink: DeepLinkShareOpenEvent = {
  entity: 'automation',
  externalId: AUTOMATION_SHARE_ID,
  intent: 'install',
  expectedAutomationContentHash: AUTOMATION_CONTENT_HASH,
};

function AutomationHarness({
  probe,
  shareLink = automationLink,
  onAutoNavigate,
}: {
  probe: HookProbe;
  shareLink?: DeepLinkShareOpenEvent;
  onAutoNavigate?: () => void;
}): null {
  // A deep-link review: it reports the web handoff funnel.
  probe.current = usePublicShareLanding(shareLink, {
    onAutoNavigate,
    reportHandoffEvents: true,
  });
  return null;
}

describe('usePublicShareLanding automation install review', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  const listAutomations = jest.fn();
  const deleteAutomation = jest.fn();
  const deletePipeline = jest.fn();
  const reportHandoff = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    listAutomations.mockResolvedValue({ activities: [], recentRuns: [] });
    deleteAutomation.mockResolvedValue({ ok: true });
    deletePipeline.mockResolvedValue({ success: true });
    reportHandoff.mockResolvedValue({ success: true });
    Object.assign(window, {
      api: {
        deepLinkResolveShare: jest
          .fn()
          .mockResolvedValue({ ok: true, snapshot: automationSnapshot }),
        deepLinkReportHandoffEvent: reportHandoff,
        automations: { list: listAutomations, delete: deleteAutomation },
      },
      pipelines: {
        onPackageProgress: jest.fn().mockReturnValue(() => {}),
        delete: deletePipeline,
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(<AutomationHarness probe={probe} />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  }

  it('forwards the automation content pin to the resolve request', async () => {
    await mount();
    // Without this the server can never answer 409 for a republished share,
    // so the pin the recipient reviewed on the web page is decorative.
    expect(window.api.deepLinkResolveShare).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'automation',
        externalId: AUTOMATION_SHARE_ID,
        expectedAutomationContentHash: AUTOMATION_CONTENT_HASH,
      }),
    );
  });

  it('forwards scoped automation audience to the desktop resolver', async () => {
    await act(async () => {
      root.render(
        <AutomationHarness
          probe={probe}
          shareLink={{ ...automationLink, audience: 'TEAM' }}
        />,
      );
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(window.api.deepLinkResolveShare).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'automation',
        externalId: AUTOMATION_SHARE_ID,
        audience: 'TEAM',
      }),
    );
  });

  it('forwards curated automation provenance and detects a prior catalog install', async () => {
    listAutomations.mockResolvedValue({
      activities: [
        {
          version: 1,
          id: 'activity-curated',
          name: 'Daily review',
          enabled: false,
          schedule: {
            kind: 'cron',
            expression: '0 2 * * *',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
          failureCount: 0,
          installedFrom: {
            remoteId: 'daily-review',
            contentHash: AUTOMATION_CONTENT_HASH,
            installedAt: '2026-09-15T00:00:00.000Z',
            sourceKind: 'curated',
          },
        },
      ],
      recentRuns: [],
    });
    window.api.deepLinkResolveShare = jest.fn().mockResolvedValue({
      ok: true,
      snapshot: {
        ...automationSnapshot,
        externalId: 'daily-review',
        sourceKind: 'curated',
      },
    });

    await act(async () => {
      root.render(
        <AutomationHarness
          probe={probe}
          shareLink={{
            ...automationLink,
            externalId: 'daily-review',
            automationSource: 'curated',
          }}
        />,
      );
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(window.api.deepLinkResolveShare).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'automation',
        externalId: 'daily-review',
        automationSource: 'curated',
      }),
    );
    expect(probe.current?.installed).toEqual({
      entity: 'automation',
      activityId: 'activity-curated',
      updateAvailable: false,
    });
  });

  it('opens the review on arrival without installing anything', async () => {
    await mount();
    // CAN-3651: the review is the one surface; its single explicit click
    // installs. Arriving never writes anything.
    expect(probe.current?.installReview).toEqual({
      entity: 'automation',
      externalId: AUTOMATION_SHARE_ID,
    });
    expect(probe.current?.openingInstallReview).toBe(false);
    expect(probe.current?.installed).toBeNull();
    expect(reportHandoff).not.toHaveBeenCalled();
  });

  it('opens the review without an install intent too', async () => {
    const legacyLink: DeepLinkShareOpenEvent = { ...automationLink };
    // Simulate an older decoded link: the current contract normalizes intent,
    // while this branch intentionally keeps pinning the hook's fallback.
    Reflect.deleteProperty(legacyLink, 'intent');
    await act(async () => {
      root.render(<AutomationHarness probe={probe} shareLink={legacyLink} />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(probe.current?.installReview).toEqual({
      entity: 'automation',
      externalId: AUTOMATION_SHARE_ID,
    });
  });

  it('reports the review as opening until it is ready', async () => {
    let resolveShare: (
      value:
        | DeepLinkResolveShareResponse
        | PromiseLike<DeepLinkResolveShareResponse>,
    ) => void = () => {};
    window.api.deepLinkResolveShare = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveShare = resolve;
        }),
    );
    let resolveList: (value: unknown) => void = () => {};
    listAutomations.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    await mount();
    // Still resolving: the shell shows its ordinary loading state.
    expect(probe.current?.openingInstallReview).toBe(false);

    await act(async () => {
      resolveShare({ ok: true, snapshot: automationSnapshot });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    // Resolved, detection pending: never flash the landing.
    expect(probe.current?.openingInstallReview).toBe(true);
    expect(probe.current?.installReview).toBeNull();

    await act(async () => {
      resolveList({ activities: [], recentRuns: [] });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(probe.current?.openingInstallReview).toBe(false);
    expect(probe.current?.installReview).not.toBeNull();
  });

  it('opens an out-of-date copy straight into its update review', async () => {
    const stale = {
      version: 1,
      id: 'activity-stale',
      name: 'Nightly review',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: AUTOMATION_SHARE_ID,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-09-15T00:00:00.000Z',
        sourceKind: 'public',
      },
    };
    listAutomations.mockResolvedValue({
      activities: [stale],
      recentRuns: [],
    });
    await mount();

    expect(probe.current?.installReview).toEqual({
      entity: 'automation',
      externalId: AUTOMATION_SHARE_ID,
      staleActivity: stale,
    });
  });

  it('reports INSTALLED on completion, not on install', async () => {
    await mount();
    await act(async () => {
      await probe.current?.install();
    });
    expect(reportHandoff).not.toHaveBeenCalled();

    await act(async () => {
      probe.current?.completeInstallReview('activity-1');
      await Promise.resolve();
    });
    expect(probe.current?.installReview).toBeNull();
    expect(probe.current?.installed).toEqual({
      entity: 'automation',
      activityId: 'activity-1',
    });
    expect(reportHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'automation',
        externalId: AUTOMATION_SHARE_ID,
        eventType: 'INSTALLED',
      }),
    );
  });

  it('reports nothing for a review opened in the app', async () => {
    function InAppHarness(): null {
      probe.current = usePublicShareLanding(automationLink);
      return null;
    }
    await act(async () => {
      root.render(<InAppHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    await act(async () => {
      probe.current?.completeInstallReview('activity-1');
      await Promise.resolve();
    });
    expect(reportHandoff).not.toHaveBeenCalled();
  });

  it('detects a prior public install and uninstalls via the automations API', async () => {
    listAutomations.mockResolvedValue({
      activities: [
        {
          version: 1,
          id: 'activity-9',
          name: 'Nightly review',
          enabled: false,
          schedule: {
            kind: 'cron',
            expression: '0 2 * * *',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
          failureCount: 0,
          installedFrom: {
            remoteId: AUTOMATION_SHARE_ID,
            contentHash: AUTOMATION_CONTENT_HASH,
            installedAt: '2026-09-15T00:00:00.000Z',
            sourceKind: 'public',
          },
        },
      ],
      recentRuns: [],
    });
    await mount();
    expect(probe.current?.installed).toEqual({
      entity: 'automation',
      activityId: 'activity-9',
      updateAvailable: false,
    });
    // A current copy has nothing to install, so it stays on the landing.
    expect(probe.current?.installReview).toBeNull();
    expect(probe.current?.openingInstallReview).toBe(false);

    await act(async () => {
      await probe.current?.uninstall();
    });
    expect(deleteAutomation).toHaveBeenCalledWith({ id: 'activity-9' });
    // Never the pipeline delete the `else` branch would otherwise reach.
    expect(deletePipeline).not.toHaveBeenCalled();
    expect(probe.current?.installed).toBeNull();
  });

  it('detects a prior scoped install by authenticated share identity', async () => {
    listAutomations.mockResolvedValue({
      activities: [
        {
          version: 1,
          id: 'activity-team',
          name: 'Nightly review',
          enabled: false,
          schedule: {
            kind: 'cron',
            expression: '0 2 * * *',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
          failureCount: 0,
          installedFrom: {
            remoteId: AUTOMATION_SHARE_ID,
            contentHash: AUTOMATION_CONTENT_HASH,
            installedAt: '2026-09-15T00:00:00.000Z',
          },
        },
      ],
      recentRuns: [],
    });

    await act(async () => {
      root.render(
        <AutomationHarness
          probe={probe}
          shareLink={{ ...automationLink, audience: 'TEAM' }}
        />,
      );
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(probe.current?.installed).toEqual({
      entity: 'automation',
      activityId: 'activity-team',
      updateAvailable: false,
    });
  });

  it('auto-opens an already-installed automation for intent=try', async () => {
    const onAutoNavigate = jest.fn();
    listAutomations.mockResolvedValue({
      activities: [
        {
          version: 1,
          id: 'activity-try',
          name: 'Nightly review',
          enabled: false,
          schedule: {
            kind: 'cron',
            expression: '0 2 * * *',
            timezone: 'local',
          },
          action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
          failureCount: 0,
          installedFrom: {
            remoteId: AUTOMATION_SHARE_ID,
            contentHash: AUTOMATION_CONTENT_HASH,
            installedAt: '2026-09-15T00:00:00.000Z',
            sourceKind: 'public',
          },
        },
      ],
      recentRuns: [],
    });

    await act(async () => {
      root.render(
        <AutomationHarness
          probe={probe}
          shareLink={{ ...automationLink, intent: 'try' }}
          onAutoNavigate={onAutoNavigate}
        />,
      );
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    expect(mockOpenAutomationEdit).toHaveBeenCalledWith({
      activityId: 'activity-try',
    });
    expect(onAutoNavigate).toHaveBeenCalledTimes(1);
    expect(reportHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'automation',
        eventType: 'TRY_NOW',
      }),
    );
  });

  it('opens the update wizard with the stale public automation copy', async () => {
    const staleActivity = {
      version: 1 as const,
      id: 'activity-stale',
      name: 'Nightly review',
      enabled: false,
      schedule: {
        kind: 'cron' as const,
        expression: '0 2 * * *',
        timezone: 'local' as const,
      },
      action: { type: 'app_advisor_prompt' as const, prompt: 'Old prompt' },
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: AUTOMATION_SHARE_ID,
        contentHash: '0'.repeat(64),
        installedAt: '2026-09-15T00:00:00.000Z',
        sourceKind: 'public' as const,
      },
    };
    listAutomations.mockResolvedValue({
      activities: [staleActivity],
      recentRuns: [],
    });
    await mount();
    expect(probe.current?.installed).toEqual({
      entity: 'automation',
      activityId: 'activity-stale',
      updateAvailable: true,
    });

    await act(async () => {
      await probe.current?.install();
    });

    expect(probe.current?.installReview).toEqual({
      entity: 'automation',
      externalId: AUTOMATION_SHARE_ID,
      staleActivity,
    });
  });

  it('shows a failed copy lookup as an install error instead of rejecting', async () => {
    listAutomations.mockResolvedValue({
      activities: [
        {
          version: 1 as const,
          id: 'activity-stale',
          name: 'Nightly review',
          enabled: false,
          schedule: {
            kind: 'cron' as const,
            expression: '0 2 * * *',
            timezone: 'local' as const,
          },
          action: { type: 'app_advisor_prompt' as const, prompt: 'Old' },
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
          failureCount: 0,
          installedFrom: {
            remoteId: AUTOMATION_SHARE_ID,
            contentHash: '0'.repeat(64),
            installedAt: '2026-09-15T00:00:00.000Z',
            sourceKind: 'public' as const,
          },
        },
      ],
      recentRuns: [],
    });
    await mount();
    listAutomations.mockRejectedValueOnce(new Error('Automations unavailable'));

    let result: unknown = 'unset';
    await act(async () => {
      result = await probe.current?.install();
    });

    expect(result).toBeNull();
    expect(probe.current?.installError).toBe('Automations unavailable');
  });
});

describe('scoped agent share landing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  const list = jest.fn();
  const importShared = jest.fn();
  const inspectImport = jest.fn();
  const remove = jest.fn();
  const importPublic = jest.fn();
  const uninstallPublic = jest.fn();
  const reviewedAgent = { id: SHARE_ID, name: 'Org agent' };
  const agentLink: DeepLinkShareOpenEvent = {
    entity: 'agent',
    externalId: SHARE_ID,
    intent: 'install',
    audience: 'ORGANIZATION',
  };
  function AgentHarness(): null {
    probe.current = usePublicShareLanding(agentLink);
    return null;
  }
  beforeEach(() => {
    jest.clearAllMocks();
    agentLink.intent = 'install';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    list.mockResolvedValue({ agents: [] });
    importShared.mockResolvedValue({
      agent: { id: 'agent_model_org' },
      requestedId: 'agent_model_org',
      finalId: 'agent_model_org',
      idChanged: false,
    });
    inspectImport.mockResolvedValue({
      agent: reviewedAgent,
      matchedRefs: [],
      unmatchedRefs: [],
      requirements: [],
    });
    remove.mockResolvedValue(undefined);
    const agentSnapshot: PublicShareSnapshot = {
      entity: 'agent',
      externalId: SHARE_ID,
      sourceRemoteId: SHARE_ID,
      contentHash: CONTENT_HASH,
      agent: {
        version: 1,
        id: 'agent_model_org',
        name: 'Org agent',
        baseModel: 'sonnet',
        instructions: '',
        plugins: [],
      },
      authorUsername: null,
      updatedAt: '',
    };
    Object.assign(window, {
      api: {
        deepLinkResolveShare: jest
          .fn()
          .mockResolvedValue({ ok: true, snapshot: agentSnapshot }),
        deepLinkReportHandoffEvent: jest
          .fn()
          .mockResolvedValue({ success: true }),
      },
      agents: {
        list,
        importShared,
        inspectImport,
        delete: remove,
        importPublic,
        uninstallPublic,
      },
      pipelines: { onPackageProgress: jest.fn().mockReturnValue(() => {}) },
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  it('keeps the reviewed share across a context switch made elsewhere (CAN-2962)', async (): Promise<void> => {
    await act(async (): Promise<void> => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(probe.current?.snapshot?.entity).toBe('agent');
    expect(list).toHaveBeenCalledTimes(1);
    // The new context would refuse a fresh resolve of this share.
    jest
      .mocked(window.api.deepLinkResolveShare)
      .mockResolvedValue({ ok: false, reason: 'not-found' });
    list.mockResolvedValue({
      agents: [
        {
          id: 'agent_model_org',
          remoteId: SHARE_ID,
          remoteContentHash: CONTENT_HASH,
          importedFromRemoteId: SHARE_ID,
          importedContentHash: 'local-hash',
          contentHash: 'local-hash',
        },
      ],
    });
    await act(async (): Promise<void> => {
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
      }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    // Main refuses the install instead; only installed state is read again.
    expect(window.api.deepLinkResolveShare).toHaveBeenCalledTimes(1);
    expect(probe.current?.state.phase).toBe('ready');
    expect(list).toHaveBeenCalledTimes(2);
    expect(probe.current?.installed).toMatchObject({
      entity: 'agent',
      agentId: 'agent_model_org',
    });
    expect(probe.current?.detecting).toBe(false);
  });
  it('re-reads installed state after an install running across a context switch', async (): Promise<void> => {
    await act(async (): Promise<void> => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    let refuse: (error: Error) => void = () => undefined;
    importShared.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );
    let work: Promise<unknown> | undefined;
    await act(async (): Promise<void> => {
      work = probe.current?.install();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(importShared).toHaveBeenCalledTimes(1);
    await act(async (): Promise<void> => {
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
      }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    // The read waits for the install to settle.
    expect(list).toHaveBeenCalledTimes(1);
    await act(async (): Promise<void> => {
      refuse(new Error('Agent unavailable (context-mismatch)'));
      await work;
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(probe.current?.installError).not.toBe('');
    expect(probe.current?.detecting).toBe(false);
  });
  it('resolves a failed share again after a context switch', async (): Promise<void> => {
    const resolve = jest.mocked(window.api.deepLinkResolveShare);
    resolve.mockResolvedValueOnce({ ok: false, reason: 'not-found' });
    await act(async (): Promise<void> => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'not-found',
    });
    await act(async (): Promise<void> => {
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
      }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.snapshot?.entity).toBe('agent');
  });
  it('drops a resolve still in flight when the context switches', async (): Promise<void> => {
    const resolve = jest.mocked(window.api.deepLinkResolveShare);
    let answerStale: (value: { ok: false; reason: 'not-found' }) => void = () =>
      undefined;
    resolve.mockReturnValueOnce(
      new Promise((resolveStale) => {
        answerStale = resolveStale;
      }),
    );
    await act(async (): Promise<void> => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(probe.current?.state.phase).toBe('loading');
    await act(async (): Promise<void> => {
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
      }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    // The old context's answer arrives last and is ignored.
    await act(async (): Promise<void> => {
      answerStale({ ok: false, reason: 'not-found' });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.snapshot?.entity).toBe('agent');
    expect(probe.current?.detecting).toBe(false);
  });
  it('does not offer scoped uninstall for the authored source with later local edits', async (): Promise<void> => {
    agentLink.intent = 'try';
    list.mockResolvedValue({
      agents: [
        {
          id: 'agent_model_org',
          remoteId: SHARE_ID,
          remoteContentHash: CONTENT_HASH,
          instructions: 'Later local edits',
        },
      ],
    });
    await act(async (): Promise<void> => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(probe.current?.installed).toBeNull();
    await act(async (): Promise<void> => {
      await probe.current?.uninstall();
    });
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(['edited', 'legacy'])(
    'does not offer scoped uninstall for an %s imported copy',
    async (kind): Promise<void> => {
      agentLink.intent = 'try';
      list.mockResolvedValue({
        agents: [
          {
            id: 'agent_model_org',
            remoteId: SHARE_ID,
            remoteContentHash: CONTENT_HASH,
            importedFromRemoteId: SHARE_ID,
            contentHash: 'current-local-hash',
            ...(kind === 'edited'
              ? { importedContentHash: 'original-local-hash' }
              : {}),
          },
        ],
      });
      await act(async (): Promise<void> => {
        root.render(<AgentHarness />);
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(probe.current?.installed).toBeNull();
      await act(async (): Promise<void> => {
        await probe.current?.uninstall();
      });
      expect(remove).not.toHaveBeenCalled();
    },
  );
  it('detects a scoped imported copy rather than its authored source', async (): Promise<void> => {
    list.mockResolvedValue({
      agents: [
        {
          id: 'agent_model_org',
          remoteId: SHARE_ID,
          remoteContentHash: CONTENT_HASH,
        },
        {
          id: 'agent_model_org_2',
          remoteId: SHARE_ID,
          remoteContentHash: CONTENT_HASH,
          importedFromRemoteId: SHARE_ID,
          importedContentHash: 'local-hash',
          contentHash: 'local-hash',
        },
      ],
    });
    await act(async (): Promise<void> => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(probe.current?.installed).toEqual({
      entity: 'agent',
      agentId: 'agent_model_org_2',
    });
  });
  it('installs by checked remote identity and deletes through the checked local store', async () => {
    await act(async () => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    await act(async () => {
      await probe.current?.install();
    });
    // The install takes the exact snapshot the inspection read.
    expect(inspectImport).toHaveBeenCalledWith(SHARE_ID);
    expect(importShared).toHaveBeenCalledWith({
      agentId: SHARE_ID,
      installMissing: true,
      reviewedAgent,
    });
    expect(importPublic).not.toHaveBeenCalled();
    expect(probe.current?.installed).toEqual({
      entity: 'agent',
      agentId: 'agent_model_org',
    });
    await act(async () => {
      await probe.current?.uninstall();
    });
    expect(remove).toHaveBeenCalledWith({
      id: 'agent_model_org',
      importedShare: { remoteId: SHARE_ID, contentHash: CONTENT_HASH },
    });
    expect(uninstallPublic).not.toHaveBeenCalled();
  });

  it('installs the agent read when the review opened, not one edited since', async () => {
    await act(async () => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    // The review read the share as soon as it opened.
    expect(inspectImport).toHaveBeenCalledTimes(1);
    // The publisher edits it while the review is open.
    inspectImport.mockResolvedValue({
      agent: { id: SHARE_ID, name: 'Edited later' },
      matchedRefs: [],
      unmatchedRefs: [],
      requirements: [],
    });
    await act(async () => {
      await probe.current?.install();
    });

    expect(inspectImport).toHaveBeenCalledTimes(1);
    expect(importShared).toHaveBeenCalledWith({
      agentId: SHARE_ID,
      installMissing: true,
      reviewedAgent,
    });
  });

  it('says so when the agent had to install under another id', async () => {
    importShared.mockResolvedValueOnce({
      agent: { id: 'agent_model_org-2' },
      requestedId: 'agent_model_org',
      finalId: 'agent_model_org-2',
      idChanged: true,
    });
    await act(async () => {
      root.render(<AgentHarness />);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    let result: Awaited<ReturnType<PublicShareLanding['install']>> = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });
    expect(result).toEqual({
      target: { entity: 'agent', agentId: 'agent_model_org-2' },
      status:
        'Agent installed as agent_model_org-2 because agent_model_org already exists locally.',
      partial: true,
    });
  });
});

describe('usePublicShareLanding skill install endpoint', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  const skillLink: DeepLinkShareOpenEvent = {
    entity: 'skill',
    externalId: SHARE_ID,
    intent: 'install',
  };
  const packageSummary = { digest: NEW_DIGEST, totalFiles: 2, totalBytes: 10 };
  const publisher = {
    name: 'Anthropic',
    sourceUrl: 'https://github.com/anthropics/skills',
    license: 'MIT',
    pluginName: 'examples',
  };
  function SkillHarness(): null {
    probe.current = usePublicShareLanding(skillLink, {
      reportHandoffEvents: true,
    });
    return null;
  }

  async function installSnapshot(extra: {
    scopedShare?: boolean;
  }): Promise<void> {
    Object.assign(window, {
      api: {
        deepLinkResolveShare: jest.fn().mockResolvedValue({
          ok: true,
          snapshot: {
            entity: 'skill',
            externalId: SHARE_ID,
            name: 'helper',
            description: '',
            rawSkill: '# Helper',
            contentHash: CONTENT_HASH,
            dependencies: [],
            distributionMode: 'package',
            package: packageSummary,
            authorUsername: null,
            updatedAt: '2026-09-01T00:00:00.000Z',
            ...extra,
          },
        }),
        deepLinkReportHandoffEvent: jest
          .fn()
          .mockResolvedValue({ success: true }),
      },
      // The hook subscribes to package progress on mount.
      pipelines: {},
    });
    act(() => {
      root.render(<SkillHarness />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await probe.current?.install();
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(findInstalledSkillByContentHash).mockResolvedValue(null);
    mockImportSharedSkill.mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function arrive(extra: Record<string, unknown>): Promise<void> {
    Object.assign(window, {
      api: {
        deepLinkResolveShare: jest.fn().mockResolvedValue({
          ok: true,
          snapshot: {
            entity: 'skill',
            externalId: SHARE_ID,
            name: 'helper',
            description: '',
            rawSkill: '# Helper',
            contentHash: CONTENT_HASH,
            dependencies: [],
            distributionMode: 'package',
            package: packageSummary,
            authorUsername: null,
            updatedAt: '2026-09-01T00:00:00.000Z',
            ...extra,
          },
        }),
        deepLinkReportHandoffEvent: jest
          .fn()
          .mockResolvedValue({ success: true }),
      },
      pipelines: {},
    });
    act(() => {
      root.render(<SkillHarness />);
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  }

  it('installs only on the explicit click and resolves what it installed', async () => {
    await arrive({ publisher });
    expect(probe.current?.state.phase).toBe('ready');
    expect(mockImportSharedSkill).not.toHaveBeenCalled();
    let result: Awaited<ReturnType<PublicShareLanding['install']>> = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });
    expect(mockImportSharedSkill).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      target: {
        entity: 'skill',
        sourceId: CUSTOM_SKILL_SOURCE_ID,
        skillName: 'helper',
      },
      status: '',
      partial: false,
    });
  });

  it('reports Try now only once Use in this chat stages the skill (CAN-5219)', async () => {
    const chat = { projectId: 'project', worktreeId: 'worktree', tabId: 'a' };
    await arrive({});
    const landed: {
      result: Awaited<ReturnType<PublicShareLanding['install']>>;
    } = { result: null };
    await act(async () => {
      landed.result = (await probe.current?.install()) ?? null;
    });
    if (landed.result === null) throw new Error('not installed');
    const { target } = landed.result;
    if (target.entity !== 'skill') throw new Error('expected skill target');
    const tryNowReported = (): number =>
      jest
        .mocked(window.api.deepLinkReportHandoffEvent)
        .mock.calls.filter(([event]) => event.eventType === 'TRY_NOW').length;

    // Another installed copy is stale: nothing is staged.
    expect(
      await probe.current?.insertInChat(
        { ...target, skillName: 'other' },
        chat,
      ),
    ).toBe('stale');
    expect(mockInsertSkillInvocation).not.toHaveBeenCalled();

    jest.mocked(findInstalledSkillByContentHash).mockResolvedValue({
      sourceId: 'custom:app',
      skillName: 'helper',
      skillId: 'custom:app/helper',
    });
    mockInsertSkillInvocation.mockReturnValueOnce('unhandled');
    expect(await probe.current?.insertInChat(target, chat)).toBe('unhandled');
    expect(tryNowReported()).toBe(0);

    mockInsertSkillInvocation.mockReturnValueOnce('inserted');
    expect(await probe.current?.insertInChat(target, chat)).toBe('inserted');
    expect(mockInsertSkillInvocation).toHaveBeenLastCalledWith(chat, 'helper');
    expect(window.api.deepLinkReportHandoffEvent).toHaveBeenLastCalledWith({
      entity: 'skill',
      externalId: SHARE_ID,
      eventType: 'TRY_NOW',
      audience: undefined,
    });
    expect(tryNowReported()).toBe(1);
    expect(await probe.current?.insertInChat(target, chat)).toBe('stale');
    expect(mockInsertSkillInvocation).toHaveBeenCalledTimes(2);
    expect(tryNowReported()).toBe(1);
  });

  it.each(['rejection', 'throw'])(
    'keeps successful insertion consumed after telemetry %s',
    async (failure) => {
      await arrive({});
      let target: PublicShareLanding['installed'] = null;
      await act(async () => {
        target = (await probe.current?.install())?.target ?? null;
      });
      if (target === null) throw new Error('not installed');
      jest.mocked(findInstalledSkillByContentHash).mockResolvedValue({
        sourceId: 'custom:app',
        skillName: 'helper',
        skillId: 'custom:app/helper',
      });
      jest
        .mocked(window.api.deepLinkReportHandoffEvent)
        .mockImplementation(() => {
          if (failure === 'throw') throw new Error('offline');
          return Promise.reject(new Error('offline'));
        });
      mockInsertSkillInvocation.mockReturnValue('inserted');
      const chat = { projectId: 'project', worktreeId: 'worktree', tabId: 'a' };
      expect(await probe.current?.insertInChat(target, chat)).toBe('inserted');
      expect(await probe.current?.insertInChat(target, chat)).toBe('stale');
      expect(mockInsertSkillInvocation).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an installed copy removed after the review closed', async () => {
    await arrive({});
    let target: PublicShareLanding['installed'] = null;
    await act(async () => {
      target = (await probe.current?.install())?.target ?? null;
    });
    if (target === null) throw new Error('not installed');
    jest.mocked(findInstalledSkillByContentHash).mockResolvedValue(null);
    expect(
      await probe.current?.insertInChat(target, {
        projectId: 'project',
        worktreeId: 'worktree',
        tabId: 'a',
      }),
    ).toBe('stale');
    expect(mockInsertSkillInvocation).not.toHaveBeenCalled();
  });

  it('keeps a publisher package failure retryable instead of marking it installed', async () => {
    mockImportSharedSkill.mockResolvedValueOnce({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: false,
      packageInstallError: 'digest mismatch',
    });
    await arrive({ publisher });
    await act(async () => {
      await probe.current?.install();
    });
    expect(probe.current?.installed).toBeNull();
    expect(probe.current?.installError).toContain('digest mismatch');
    expect(window.api.deepLinkReportHandoffEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'INSTALLED' }),
    );
    await act(async () => {
      await probe.current?.install();
    });
    expect(probe.current?.installed).toMatchObject({
      entity: 'skill',
      skillName: 'helper',
    });
  });

  it('does not treat a publisher definition without its package as installed on arrival', async () => {
    jest.mocked(findInstalledSkillByContentHash).mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      sourceId: 'custom:app',
    });
    Object.assign(window, {
      skills: {
        listMarketplace: jest.fn().mockResolvedValue([
          {
            externalId: SHARE_ID,
            name: 'helper',
            description: '',
            publisher: 'Anthropic',
          },
        ]),
      },
    });
    await arrive({ publisher });
    expect(probe.current?.installed).toBeNull();
    expect(mockImportSharedSkill).not.toHaveBeenCalled();
  });

  it.each([
    { installedPackageDigest: OLD_DIGEST, expectedInstalled: false },
    { installedPackageDigest: NEW_DIGEST, expectedInstalled: true },
  ])(
    'checks publisher package revision on arrival: $expectedInstalled',
    async ({ installedPackageDigest, expectedInstalled }) => {
      jest.mocked(findInstalledSkillByContentHash).mockResolvedValue({
        skillId: 'custom:app/helper',
        skillName: 'helper',
        sourceId: 'custom:app',
      });
      Object.assign(window, {
        skills: {
          listMarketplace: jest.fn().mockResolvedValue([
            {
              externalId: SHARE_ID,
              name: 'helper',
              description: '',
              publisher: 'Anthropic',
              installedSkillName: 'helper',
              installedPackageDigest,
            },
          ]),
        },
      });
      await arrive({ publisher });
      expect(Boolean(probe.current?.installed)).toBe(expectedInstalled);
      expect(mockImportSharedSkill).not.toHaveBeenCalled();
    },
  );

  // CAN-3710: every install is the review's one click. An install link from
  // the web opens the review; it never installs on arrival, whatever the
  // package carries.
  it.each([
    { label: 'nothing that runs', executableFiles: undefined },
    { label: 'runnable scripts', executableFiles: ['scripts/run.sh'] },
  ])(
    'never installs an install link on arrival ($label)',
    async ({ executableFiles }) => {
      await arrive({
        package: {
          ...packageSummary,
          resources: [
            {
              id: 'helper',
              displayName: 'helper',
              kind: 'standalone_skill',
              sourceLabel: 'Custom',
              fileCount: 2,
              totalBytes: 10,
              affectedSteps: [],
              ...(executableFiles ? { executableFiles } : {}),
            },
          ],
        },
      });

      expect(probe.current?.state.phase).toBe('ready');
      expect(mockImportSharedSkill).not.toHaveBeenCalled();
      expect(window.api.deepLinkReportHandoffEvent).not.toHaveBeenCalled();
    },
  );

  it('reads a public share package through the public endpoints', async () => {
    await installSnapshot({});

    expect(mockImportSharedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHARE_ID, fromPublicShare: true }),
    );
  });

  // A partial success has to reach the user: the skill landed, but saying
  // nothing would leave the recipient believing they received all of it.
  it('reports supporting files that did not install', async () => {
    mockImportSharedSkill.mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: false,
      packageInstallError: 'digest mismatch',
    });

    await installSnapshot({});

    expect(probe.current?.installStatus).toBe(
      'Skill added, but its supporting files could not be installed. digest mismatch',
    );
  });

  it('reports files kept because the recipient already had their own version', async () => {
    mockImportSharedSkill.mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: true,
      packageInstall: {
        supportingFileCount: 0,
        installedDependencies: [],
        uninstalledResourceLabels: [],
        keptLocalFiles: ['helper/references/a.md', 'helper/references/b.md'],
      },
    });

    await installSnapshot({});

    expect(probe.current?.installStatus).toBe(
      'Skill added. You already had 2 of its files, so your versions were kept.',
    );
  });

  it('says nothing extra for a complete install', async () => {
    await installSnapshot({});

    expect(probe.current?.installStatus).toBe('');
  });

  // A team or organization skill reached through the scoped fallback has no
  // public share, so the public package endpoints 404 for it.
  it('reads a scoped skill package through the owned-skill endpoints', async () => {
    await installSnapshot({ scopedShare: true });

    expect(mockImportSharedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHARE_ID, fromPublicShare: false }),
    );
  });
});

const originalResolveCollectionImport =
  CollectionImport.resolveSharedCollectionImport;
describe('usePublicShareLanding collection install authorization', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  const collectionSnapshot = {
    entity: 'collection',
    externalId: SHARE_ID,
    collection: { version: 1, name: 'Kit', description: '', items: [] },
    contentHash: CONTENT_HASH,
    itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
    customSkills: [],
    authorUsername: null,
    updatedAt: '2026-10-02T00:00:00Z',
    distributionMode: 'package',
    package: {
      digest: NEW_DIGEST,
      version: 1,
      resources: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
  };
  const memberImport = jest.spyOn(
    CollectionImport,
    'resolveSharedCollectionImport',
  );
  const resolve = jest.fn();
  const save = jest.fn<Promise<CollectionConfig>, [unknown]>();
  const remove = jest.fn();
  const installPackage = jest.fn<Promise<unknown>, [unknown]>();
  beforeEach(() => {
    jest.clearAllMocks();
    memberImport
      .mockReset()
      .mockImplementation(originalResolveCollectionImport);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    resolve.mockResolvedValue({ ok: true, snapshot: collectionSnapshot });
    save.mockResolvedValue({
      id: 'local-kit',
      name: 'Kit',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [],
      createdAt: 'now',
      updatedAt: 'now',
    });
    remove.mockResolvedValue(undefined);
    installPackage.mockRejectedValue(new Error('Package unavailable'));
    Object.assign(window, {
      api: {
        deepLinkResolveShare: resolve,
        deepLinkReportHandoffEvent: jest.fn(),
      },
      collections: {
        loadIndex: jest.fn().mockResolvedValue([]),
        saveCollection: save,
        deleteCollection: remove,
        installCapabilityPackage: installPackage,
      },
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function renderCollection(
    audience?: DeepLinkShareOpenEvent['audience'],
  ): Promise<void> {
    await act(async () => {
      root.render(
        <WorkspaceHarness
          probe={probe}
          shareLink={{
            entity: 'collection',
            externalId: SHARE_ID,
            intent: 'install',
            ...(audience ? { audience } : {}),
          }}
        />,
      );
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  }
  it.each([
    ['TEAM', false],
    ['ORGANIZATION', false],
    ['TEAM', true],
    ['ORGANIZATION', true],
  ] as const)(
    'installs an authorized %s custom skill with resource context enabled (package=%s)',
    async (audience, packaged) => {
      mockResourceContextEnabled = true;
      const actual = jest.requireActual<typeof SharedSkillImportModule>(
        '@/lib/sharedSkillImport',
      );
      mockImportSharedSkill.mockImplementation(actual.importSharedSkill);
      const writeRawSkill = jest
        .fn()
        .mockImplementation((input: { sourceRemoteId?: string }) => {
          if (!input.sourceRemoteId)
            return Promise.reject(
              new Error('A shared skill source is required.'),
            );
          return Promise.resolve({
            skillId: 'custom:app/scoped-review',
            skillName: 'scoped-review',
          });
        });
      Object.assign(window, {
        skills: {
          loadSkills: jest.fn().mockResolvedValue({ success: true, data: [] }),
          writeRawSkill,
        },
      });
      const { package: packageRef, ...definition } = collectionSnapshot;
      const detail = {
        ...definition,
        distributionMode: packaged ? 'package' : 'definition_only',
        ...(packaged ? { package: packageRef } : {}),
        collection: {
          version: 1,
          name: 'Kit',
          description: '',
          items: [
            {
              type: 'custom_skill',
              skillId: 'scoped-skill',
              skill_name: 'scoped-review',
              contentHash: CONTENT_HASH,
            },
          ],
        },
        customSkills: [
          {
            id: 'scoped-skill',
            name: 'scoped-review',
            rawSkill: 'Review this change.',
            contentHash: CONTENT_HASH,
          },
        ],
      };
      resolve.mockResolvedValue({ ok: true, snapshot: detail });
      installPackage.mockResolvedValue({
        collection: {
          id: 'local-kit',
          name: 'Kit',
          description: '',
          skills: [],
          plugins: [],
          mcpServers: [],
        },
        uninstalledResourceLabels: [],
        unmetRequirements: [],
      });
      try {
        await renderCollection(audience);
        await act(async () => probe.current?.install());
        expect(writeRawSkill).toHaveBeenCalledWith({
          skillName: 'scoped-review',
          rawSkill: 'Review this change.',
          sourceRemoteId: 'scoped-skill',
          // The collection's own update subscription covers its skills.
          inCollection: true,
        });
        expect(save).toHaveBeenLastCalledWith(
          expect.objectContaining({
            skills: [{ sourceId: 'custom:app', skillName: 'scoped-review' }],
          }),
        );
        expect(probe.current?.installStatus).toBe('Collection installed.');
      } finally {
        mockResourceContextEnabled = false;
        mockImportSharedSkill.mockReset();
      }
    },
  );
  it('counts packaged resources and requirements that did not land (CAN-3710)', async () => {
    Object.assign(window, {
      pipelines: { onPackageProgress: jest.fn().mockReturnValue(() => {}) },
    });
    memberImport.mockResolvedValue({ skills: [], plugins: [], failures: [] });
    installPackage.mockResolvedValue({
      collection: {
        id: 'local-kit',
        name: 'Kit',
        description: '',
        skills: [],
        plugins: [],
        mcpServers: [],
      },
      uninstalledResourceLabels: ['Linear MCP'],
      unmetRequirements: [
        { displayName: 'GitHub token', required: true, setupHint: 'Add one.' },
      ],
    });
    await renderCollection();
    let result: Awaited<
      ReturnType<NonNullable<typeof probe.current>['install']>
    > = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });

    expect(probe.current?.installStatus).toBe(
      'Collection installed with 2 items unavailable.',
    );
    expect(result).toMatchObject({ partial: true });
  });

  it('installs a Public collection custom skill through its pinned collection snapshot', async () => {
    mockResourceContextEnabled = true;
    const actual = jest.requireActual<typeof SharedSkillImportModule>(
      '@/lib/sharedSkillImport',
    );
    mockImportSharedSkill.mockImplementation(actual.importSharedSkill);
    const writeRawSkill = jest.fn().mockResolvedValue({
      skillId: 'custom:app/pinned-review',
      skillName: 'pinned-review',
    });
    Object.assign(window, {
      skills: {
        loadSkills: jest.fn().mockResolvedValue({ success: true, data: [] }),
        writeRawSkill,
      },
    });
    const skillHash = 'e'.repeat(64);
    resolve.mockResolvedValue({
      ok: true,
      snapshot: {
        ...collectionSnapshot,
        package: undefined,
        distributionMode: 'definition_only',
        collection: {
          version: 1,
          name: 'Kit',
          description: '',
          items: [
            {
              type: 'custom_skill',
              skillId: 'pinned-skill',
              skill_name: 'pinned-review',
              contentHash: skillHash,
            },
          ],
        },
        customSkills: [
          {
            id: 'pinned-skill',
            name: 'pinned-review',
            rawSkill: 'Review this change.',
            contentHash: skillHash,
          },
        ],
      },
    });
    try {
      await renderCollection();
      await act(async () => probe.current?.install());
      expect(writeRawSkill).toHaveBeenCalledWith({
        skillName: 'pinned-review',
        rawSkill: 'Review this change.',
        publicShare: {
          externalId: 'pinned-skill',
          contentHash: skillHash,
          collection: { externalId: SHARE_ID, contentHash: CONTENT_HASH },
        },
      });
      expect(probe.current?.installStatus).toBe('Collection installed.');
    } finally {
      mockResourceContextEnabled = false;
      mockImportSharedSkill.mockReset();
    }
  });
  it.each(['revoked', 'context changed', 'persistence failed'])(
    'imports no members when the definition-only collection cannot commit (%s)',
    async (message) => {
      resolve.mockResolvedValue({
        ok: true,
        snapshot: {
          ...collectionSnapshot,
          package: undefined,
          distributionMode: 'definition_only',
        },
      });
      save.mockRejectedValueOnce(new Error(message));
      await renderCollection();
      await act(async () => probe.current?.install());
      expect(memberImport).not.toHaveBeenCalled();
      expect(probe.current?.installed).toBeNull();
      expect(probe.current?.installError).toContain(message);
    },
  );
  it('keeps a committed definition-only collection and reports partial installation when member linking is denied', async () => {
    resolve.mockResolvedValue({
      ok: true,
      snapshot: {
        ...collectionSnapshot,
        package: undefined,
        distributionMode: 'definition_only',
      },
    });
    memberImport.mockResolvedValue({
      skills: [{ sourceId: 'custom:app', skillName: 'review' }],
      plugins: [],
      failures: [],
    });
    save
      .mockResolvedValueOnce({
        id: 'local-kit',
        name: 'Kit',
        description: '',
        skills: [],
        plugins: [],
        mcpServers: [],
        createdAt: 'now',
        updatedAt: 'now',
      })
      .mockRejectedValueOnce(new Error('revoked'));
    await renderCollection();
    await act(async () => probe.current?.install());
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      memberImport.mock.invocationCallOrder[0],
    );
    expect(save).toHaveBeenCalledTimes(2);
    expect(probe.current?.installed).toEqual({
      entity: 'collection',
      collectionId: 'local-kit',
    });
    expect(probe.current?.installStatus).toContain('1 item unavailable');
    expect(probe.current?.installError).toBe('');
    expect(remove).not.toHaveBeenCalled();
  });
  it('refuses a revoked share at install time before saving locally', async () => {
    await renderCollection();
    resolve.mockResolvedValueOnce({ ok: false, reason: 'not-found' });
    await act(async () => probe.current?.install());
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedCollectionContentHash: CONTENT_HASH }),
    );
    expect(save).not.toHaveBeenCalled();
  });
  it('passes Public provenance and the verified snapshot to the package transaction', async () => {
    await renderCollection();
    await act(async () => probe.current?.install());
    expect(installPackage.mock.calls[0]?.[0]).toMatchObject({
      createCollection: {
        sharedSource: {
          remoteId: SHARE_ID,
          fromPublicShare: true,
          contentHash: CONTENT_HASH,
        },
      },
    });
  });
  it('preserves a completed package when optional member linking fails', async () => {
    installPackage.mockResolvedValueOnce({
      collection: {
        id: 'local-kit',
        name: 'Kit',
        description: '',
        skills: [{ sourceId: 'custom:app', skillName: 'packaged' }],
        plugins: [],
        mcpServers: [],
        createdAt: 'now',
        updatedAt: 'now',
      },
      uninstalledResourceLabels: [],
      unmetRequirements: [],
    });
    memberImport.mockRejectedValueOnce(new Error('Member unavailable'));
    await renderCollection();
    await act(async () => probe.current?.install());
    expect(probe.current?.installed).toEqual({
      entity: 'collection',
      collectionId: 'local-kit',
    });
    expect(probe.current?.installStatus).toContain('1 item unavailable');
    expect(probe.current?.installError).toBe('');
    expect(remove).not.toHaveBeenCalled();
  });

  it('imports remaining members after package commit and preserves packaged skill refs', async () => {
    installPackage.mockResolvedValueOnce({
      collection: {
        id: 'local-kit',
        name: 'Kit',
        description: '',
        skills: [{ sourceId: 'custom:app', skillName: 'packaged' }],
        plugins: [],
        mcpServers: [],
        createdAt: 'now',
        updatedAt: 'now',
      },
      uninstalledResourceLabels: [],
      unmetRequirements: [],
    });
    memberImport.mockResolvedValueOnce({
      skills: [{ sourceId: 'builtin:core', skillName: 'review' }],
      plugins: [],
      failures: [],
    });
    await renderCollection();
    await act(async () => probe.current?.install());
    expect(installPackage.mock.invocationCallOrder[0]).toBeLessThan(
      memberImport.mock.invocationCallOrder[0],
    );
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      skills: [
        { sourceId: 'custom:app', skillName: 'packaged' },
        { sourceId: 'builtin:core', skillName: 'review' },
      ],
    });
  });

  it('does not import members or persist a renderer collection when its package fails', async () => {
    await renderCollection();
    await act(async () => probe.current?.install());
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(memberImport).not.toHaveBeenCalled();
    expect(probe.current?.installed).toBeNull();
    expect(probe.current?.installError).toContain('Package unavailable');
  });

  it.each([
    ['a republished Public install as not installed', 'd'.repeat(64), null],
    [
      'a current Public install as installed',
      CONTENT_HASH,
      { entity: 'collection', collectionId: 'local-kit' },
    ],
    [
      'a scoped install without a pinned hash as installed',
      undefined,
      { entity: 'collection', collectionId: 'local-kit' },
    ],
  ] as const)('detects %s', async (_label, contentHash, expected) => {
    Object.assign(window.collections, {
      loadIndex: jest.fn().mockResolvedValue([{ id: 'local-kit' }]),
      loadCollection: jest.fn().mockResolvedValue({
        id: 'local-kit',
        sharedSource: {
          remoteId: SHARE_ID,
          fetchedAt: 'now',
          ...(contentHash ? { fromPublicShare: true, contentHash } : {}),
        },
      }),
    });
    await renderCollection();
    expect(probe.current?.detecting).toBe(false);
    expect(probe.current?.installed).toEqual(expected);
  });
});

describe('scoped skill updates in place (CAN-5307)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  const resolveShare = jest.fn();
  const skillLink: DeepLinkShareOpenEvent = {
    entity: 'skill',
    externalId: SHARE_ID,
    intent: 'install',
    audience: 'TEAM',
  };
  const packageSummary = { digest: NEW_DIGEST, totalFiles: 2, totalBytes: 10 };
  const LOCAL_HASH = 'b'.repeat(64);
  const SOURCE_HASH = 'a'.repeat(64);
  const stale = {
    status: 'installed',
    skillId: 'custom:app/helper',
    sourceId: CUSTOM_SKILL_SOURCE_ID,
    skillName: 'helper',
    updateAvailable: true,
    locallyEdited: true,
    localContentHash: LOCAL_HASH,
    sourceContentHash: SOURCE_HASH,
  };

  function SkillHarness({
    shareLink = skillLink,
    skillTarget,
  }: {
    shareLink?: DeepLinkShareOpenEvent;
    skillTarget?: SharedSkillImportModule.InstalledSharedSkillTarget;
  }): null {
    probe.current = usePublicShareLanding(
      shareLink,
      skillTarget ? { skillTarget } : undefined,
    );
    return null;
  }

  async function flush(): Promise<void> {
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
  }

  async function arrive(
    skillTarget?: SharedSkillImportModule.InstalledSharedSkillTarget,
  ): Promise<void> {
    act(() => {
      root.render(<SkillHarness skillTarget={skillTarget} />);
    });
    await flush();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResourceContextEnabled = true;
    mockLookupInstalledSharedSkill.mockResolvedValue(stale);
    mockImportSharedSkill.mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: false,
    });
    resolveShare.mockResolvedValue({
      ok: true,
      snapshot: {
        entity: 'skill',
        externalId: SHARE_ID,
        name: 'helper',
        description: '',
        rawSkill: '# Helper v2',
        contentHash: CONTENT_HASH,
        dependencies: [],
        distributionMode: 'package',
        package: packageSummary,
        scopedShare: true,
        authorUsername: null,
        updatedAt: '2026-10-29T00:00:00.000Z',
      },
    });
    Object.assign(window, {
      api: {
        deepLinkResolveShare: resolveShare,
        deepLinkReportHandoffEvent: jest.fn().mockResolvedValue({}),
      },
      pipelines: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockResourceContextEnabled = false;
  });

  it('treats a receipted copy with different bytes as installed, with an update', async () => {
    await arrive();

    expect(mockLookupInstalledSharedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHARE_ID, rawSkill: '# Helper v2' }),
    );
    expect(probe.current?.installed).toEqual({
      entity: 'skill',
      sourceId: CUSTOM_SKILL_SOURCE_ID,
      skillName: 'helper',
      updateAvailable: true,
      replacement: {
        expectedLocalContentHash: LOCAL_HASH,
        expectedSourceContentHash: SOURCE_HASH,
        expectedSourcePackageDigest: NEW_DIGEST,
        locallyEdited: true,
      },
    });
    expect(probe.current?.verificationError).toBe('');
  });

  it('uses an installed-detail destination without forwarding it to the share resolver', async () => {
    const target = { sourceId: CUSTOM_SKILL_SOURCE_ID, skillName: 'helper' };
    await arrive(target);
    expect(mockLookupInstalledSharedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHARE_ID }),
      target,
    );
    const anyTarget: unknown = expect.anything();
    expect(resolveShare).toHaveBeenCalledWith(
      expect.not.objectContaining({ skillTarget: anyTarget }),
    );
  });

  it('never turns an installed destination into an ordinary public install', async () => {
    resolveShare.mockResolvedValueOnce({
      ok: true,
      snapshot: {
        entity: 'skill',
        externalId: SHARE_ID,
        name: 'helper',
        description: '',
        rawSkill: '# Helper v2',
        contentHash: CONTENT_HASH,
        dependencies: [],
        scopedShare: false,
        authorUsername: null,
        updatedAt: '2026-10-29T00:00:00.000Z',
      },
    });
    await arrive({ sourceId: CUSTOM_SKILL_SOURCE_ID, skillName: 'helper' });
    expect(probe.current?.verificationError).not.toBe('');
    await act(async () => {
      await probe.current?.install();
    });
    expect(mockImportSharedSkill).not.toHaveBeenCalled();
  });

  it('does not revive an earlier destination when its read arrives late', async () => {
    const pending =
      deferred<
        Awaited<
          ReturnType<typeof SharedSkillImportModule.lookupInstalledSharedSkill>
        >
      >();
    mockLookupInstalledSharedSkill.mockReturnValueOnce(pending.promise);
    await arrive({ sourceId: CUSTOM_SKILL_SOURCE_ID, skillName: 'copy-a' });
    mockLookupInstalledSharedSkill.mockResolvedValue({
      ...stale,
      skillName: 'copy-b',
    });
    await arrive({ sourceId: CUSTOM_SKILL_SOURCE_ID, skillName: 'copy-b' });
    pending.resolve({
      ...stale,
      status: 'installed',
      skillName: 'copy-a',
      sourceId: CUSTOM_SKILL_SOURCE_ID,
    });
    await flush();
    expect(probe.current?.installed).toMatchObject({ skillName: 'copy-b' });
    expect(mockImportSharedSkill).not.toHaveBeenCalled();
  });

  it('blocks a removed destination instead of offering another install', async () => {
    mockLookupInstalledSharedSkill.mockResolvedValue({
      status: 'missing-copy',
    });
    await arrive({ sourceId: CUSTOM_SKILL_SOURCE_ID, skillName: 'helper' });
    expect(probe.current?.verificationError).not.toBe('');
    await act(async () => {
      await probe.current?.install();
    });
    expect(mockImportSharedSkill).not.toHaveBeenCalled();
  });

  it('releases its local destination only after deliberately uninstalling that copy', async () => {
    await arrive({ sourceId: CUSTOM_SKILL_SOURCE_ID, skillName: 'helper' });
    Object.assign(window.skills, {
      removeSkill: jest.fn().mockResolvedValue({ success: true }),
    });
    mockLookupInstalledSharedSkill.mockResolvedValue({
      ...stale,
      skillName: 'sibling',
      updateAvailable: false,
    });
    await act(async () => {
      expect(await probe.current?.uninstall()).toBe(true);
    });
    expect(probe.current?.installed).toMatchObject({ skillName: 'sibling' });
    expect(mockLookupInstalledSharedSkill).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: SHARE_ID }),
    );
  });

  it('replaces the reviewed copy in place and reloads its actual state', async () => {
    await arrive();
    mockLookupInstalledSharedSkill.mockResolvedValue({
      ...stale,
      updateAvailable: false,
      locallyEdited: false,
      localContentHash: SOURCE_HASH,
    });
    let result: Awaited<ReturnType<PublicShareLanding['install']>> = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });

    expect(mockImportSharedSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        replaceInstalled: {
          skillName: 'helper',
          expectedLocalContentHash: LOCAL_HASH,
          expectedSourceContentHash: SOURCE_HASH,
          expectedSourcePackageDigest: NEW_DIGEST,
        },
      }),
    );
    expect(result).toEqual({
      target: {
        entity: 'skill',
        sourceId: CUSTOM_SKILL_SOURCE_ID,
        skillName: 'helper',
      },
      status: '',
      partial: false,
    });
  });

  it('starts only one replacement when Update is activated again before it settles', async () => {
    await arrive();
    const pending =
      deferred<
        Awaited<ReturnType<typeof SharedSkillImportModule.importSharedSkill>>
      >();
    mockImportSharedSkill.mockReturnValueOnce(pending.promise);
    let first: ReturnType<PublicShareLanding['install']> | undefined;
    let second: ReturnType<PublicShareLanding['install']> | undefined;
    act(() => {
      first = probe.current?.install();
      second = probe.current?.install();
    });
    await flush();
    expect(mockImportSharedSkill).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBeNull();
    mockLookupInstalledSharedSkill.mockResolvedValue({
      ...stale,
      updateAvailable: false,
      locallyEdited: false,
      localContentHash: SOURCE_HASH,
    });
    await act(async () => {
      pending.resolve({
        skillId: 'custom:app/helper',
        skillName: 'helper',
        reused: false,
      });
      await first;
    });
    expect(probe.current?.installing).toBe(false);
    expect(probe.current?.installed).toMatchObject({ skillName: 'helper' });
    expect(
      probe.current?.installed?.entity === 'skill' &&
        probe.current.installed.updateAvailable,
    ).not.toBe(true);
    expect(mockImportSharedSkill).toHaveBeenCalledTimes(1);
  });

  it('keeps the update available when the supporting files did not all land', async () => {
    await arrive();
    mockImportSharedSkill.mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: false,
      packageInstall: {
        supportingFilesComplete: false,
        supportingFileCount: 1,
        installedDependencies: [],
        uninstalledResourceLabels: [],
        keptLocalFiles: ['notes.md'],
      },
    });
    let result: Awaited<ReturnType<PublicShareLanding['install']>> = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });

    expect(result).toMatchObject({
      target: { updateAvailable: true },
      status:
        'Skill updated. You already had one of its files, so your version was kept.',
      partial: true,
    });
  });

  it('requires a fresh review after a conflict and never retries on its own', async () => {
    await arrive();
    mockImportSharedSkill.mockRejectedValue(
      new Error(
        "Error invoking remote method 'skills:write-raw': Error: Skill unavailable (local-conflict). Your installed skill changed. Refresh and review your edits again.",
      ),
    );
    await act(async () => {
      await probe.current?.install();
    });
    expect(probe.current?.needsRefresh).toBe(true);
    expect(probe.current?.installError).toBe(
      'Skill unavailable (local-conflict). Your installed skill changed. Refresh and review your edits again.',
    );
    await act(async () => {
      await probe.current?.install();
    });
    expect(mockImportSharedSkill).toHaveBeenCalledTimes(1);

    act(() => probe.current?.refresh());
    await flush();
    expect(resolveShare).toHaveBeenCalledTimes(2);
    expect(probe.current?.needsRefresh).toBe(false);
    expect(probe.current?.installError).toBe('');
  });

  it('reports a durable update as partial and blocks actions if the post-write check fails', async () => {
    await arrive();
    mockLookupInstalledSharedSkill.mockResolvedValue({ status: 'unverified' });
    let result: Awaited<ReturnType<PublicShareLanding['install']>> = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });
    expect(result).toMatchObject({
      partial: true,
      target: { updateAvailable: true },
    });
    expect(probe.current?.verificationError).not.toBe('');
    await act(async () => {
      await probe.current?.install();
    });
    expect(mockImportSharedSkill).toHaveBeenCalledTimes(1);
  });

  it('keeps subscription bookkeeping failure visible as partial success', async () => {
    await arrive();
    mockImportSharedSkill.mockResolvedValue({
      skillId: stale.skillId,
      skillName: 'helper',
      reused: false,
      subscriptionWarning: 'subscription-update-failed',
    });
    let result: Awaited<ReturnType<PublicShareLanding['install']>> = null;
    await act(async () => {
      result = (await probe.current?.install()) ?? null;
    });
    expect(result).toMatchObject({ partial: true });
  });

  it('discards a write completion from a previous share review', async () => {
    await arrive();
    const pending =
      deferred<
        Awaited<ReturnType<typeof SharedSkillImportModule.importSharedSkill>>
      >();
    mockImportSharedSkill.mockReturnValue(pending.promise);
    let work: ReturnType<PublicShareLanding['install']> | undefined;
    act(() => {
      work = probe.current?.install();
    });
    mockLookupInstalledSharedSkill.mockResolvedValue({ status: 'absent' });
    await act(async () => {
      root.render(
        <SkillHarness
          shareLink={{ ...skillLink, externalId: 'another-share' }}
        />,
      );
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      pending.resolve({
        skillId: stale.skillId,
        skillName: 'helper',
        reused: false,
      });
      await work;
    });
    expect(probe.current?.installed).toBeNull();
  });

  it('rechecks installed state on skill events and resource-context changes', async () => {
    await arrive();
    mockLookupInstalledSharedSkill.mockResolvedValue({ status: 'absent' });
    act(() => {
      window.dispatchEvent(new Event('canopy:skills-changed'));
    });
    await flush();
    expect(probe.current?.installed).toBeNull();
    mockLookupInstalledSharedSkill.mockResolvedValue(stale);
    act(() => {
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
      }));
    });
    await flush();
    expect(probe.current?.installed).toMatchObject({ skillName: 'helper' });
  });

  it.each([
    [
      'unverified',
      'Your installed copy of this skill could not be checked. Try again.',
    ],
    [
      'missing-copy',
      'Your installed copy of this skill is missing. Restore it, then try again.',
    ],
  ])('offers no install while the copy is %s', async (status, message) => {
    mockLookupInstalledSharedSkill.mockResolvedValue({ status });
    await arrive();

    expect(probe.current?.installed).toBeNull();
    expect(probe.current?.verificationError).toBe(message);
    await act(async () => {
      await probe.current?.install();
    });
    expect(mockImportSharedSkill).not.toHaveBeenCalled();
  });
});

describe('usePublicShareLanding failure recovery (CAN-5222)', () => {
  const skillLink: DeepLinkShareOpenEvent = {
    entity: 'skill',
    externalId: SHARE_ID,
    audience: 'ORGANIZATION',
    intent: 'install',
  };
  const skillSnapshot = {
    entity: 'skill',
    externalId: SHARE_ID,
    name: 'Scoped skill',
    description: 'Scoped fixture',
    rawSkill: '---\nname: scoped\n---\nBody\n',
    contentHash: CONTENT_HASH,
    authorUsername: 'fixture-author',
    updatedAt: '2026-10-29T00:00:00.000Z',
  } as PublicShareSnapshot;
  const READY: DeepLinkResolveShareResponse = {
    ok: true,
    snapshot: skillSnapshot,
  };
  const SIGNED_OUT: CanopyCloudAccountPublicState = {
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
  };
  function connected(
    accountId: string,
    keyId: string,
  ): CanopyCloudAccountPublicState {
    return {
      hasApiKey: true,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
      serverApiKeyId: keyId,
      account: {
        id: accountId,
        name: 'Reader',
        email: 'reader@example.com',
        role: 'DEVELOPER',
      },
    };
  }

  let currentLink: DeepLinkShareOpenEvent;
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;
  let resolve: jest.Mock<
    Promise<DeepLinkResolveShareResponse>,
    [Record<string, unknown>]
  >;
  let loadAccount: jest.Mock<Promise<CanopyCloudAccountPublicState>, []>;

  function SkillHarness(): null {
    probe.current = usePublicShareLanding(currentLink);
    return null;
  }

  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  async function mount(): Promise<void> {
    act(() => {
      root.render(<SkillHarness />);
    });
    await flush();
  }

  async function changeAccount(
    account: CanopyCloudAccountPublicState,
  ): Promise<void> {
    loadAccount.mockResolvedValue(account);
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    currentLink = skillLink;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
    resolve = jest.fn<
      Promise<DeepLinkResolveShareResponse>,
      [Record<string, unknown>]
    >();
    loadAccount = jest
      .fn<Promise<CanopyCloudAccountPublicState>, []>()
      .mockResolvedValue(SIGNED_OUT);
    Object.assign(window, {
      api: {
        deepLinkResolveShare: resolve,
        deepLinkReportHandoffEvent: jest.fn().mockResolvedValue({
          success: true,
        }),
        loadCanopyCloudAccount: loadAccount,
      },
      pipelines: {},
      skills: { list: jest.fn().mockResolvedValue([]) },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('retries the same link after a failure until it resolves', async () => {
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'cloud-unreachable' })
      .mockResolvedValueOnce({ ok: false, reason: 'cloud-unreachable' })
      .mockResolvedValueOnce(READY);
    await mount();
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'cloud-unreachable',
    });

    act(() => probe.current?.retryResolve());
    await flush();
    // A repeated failure stays actionable.
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'cloud-unreachable',
    });

    act(() => probe.current?.retryResolve());
    await flush();
    expect(probe.current?.state).toEqual({
      phase: 'ready',
      snapshot: skillSnapshot,
    });
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolve.mock.calls[2]?.[0]).toEqual(resolve.mock.calls[0]?.[0]);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      entity: 'skill',
      externalId: SHARE_ID,
      audience: 'ORGANIZATION',
    });
  });

  it('never overlaps attempts on repeated clicks', async () => {
    const pending = deferred<DeepLinkResolveShareResponse>();
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'cloud-unreachable' })
      .mockReturnValueOnce(pending.promise);
    await mount();
    act(() => {
      probe.current?.retryResolve();
      probe.current?.retryResolve();
    });
    act(() => probe.current?.retryResolve());
    expect(probe.current?.state).toEqual({ phase: 'loading' });
    expect(resolve).toHaveBeenCalledTimes(2);
    act(() => pending.resolve(READY));
    await flush();
    expect(probe.current?.state.phase).toBe('ready');
  });

  it('opens the connect gate when signed out and resolves once after sign-in', async () => {
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'sign-in-required' })
      .mockResolvedValueOnce(READY);
    await mount();
    act(() => probe.current?.signIn());
    await flush();
    expect(mockRequestConnect).toHaveBeenCalledTimes(1);
    expect(mockRequestConnect.mock.calls[0]?.[0]).toEqual({
      subtitle: 'Sign in to open this skill.',
    });
    expect(mockOpenCloudAccountSettings).not.toHaveBeenCalled();

    // Signing in both resumes the gate and broadcasts the account change.
    const proceed = mockRequestConnect.mock.calls[0]?.[1];
    if (proceed === undefined) throw new Error('connect gate not requested');
    loadAccount.mockResolvedValue(connected('acct-a', 'key-a'));
    act(() => {
      proceed();
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.state).toEqual({
      phase: 'ready',
      snapshot: skillSnapshot,
    });
  });

  it('keeps the share recoverable when sign-in is cancelled', async () => {
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'sign-in-required' })
      .mockResolvedValueOnce(READY);
    await mount();
    act(() => probe.current?.signIn());
    await flush();
    // The gate closed without a change: nothing re-resolves.
    await changeAccount(SIGNED_OUT);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'sign-in-required',
    });
    act(() => probe.current?.signIn());
    await flush();
    expect(mockRequestConnect).toHaveBeenCalledTimes(2);
  });

  it('opens account settings for a connected but refused credential', async () => {
    loadAccount.mockResolvedValue(connected('acct-a', 'key-a'));
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'sign-in-required' })
      .mockResolvedValueOnce(READY);
    await mount();
    act(() => probe.current?.signIn());
    await flush();
    expect(mockOpenCloudAccountSettings).toHaveBeenCalledTimes(1);
    expect(mockRequestConnect).not.toHaveBeenCalled();

    // Signing in again to the same account issues a new key.
    await changeAccount(connected('acct-a', 'key-b'));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.state.phase).toBe('ready');
  });

  it('recovers once after replacing a manual key for the same account', async () => {
    const account: CanopyCloudAccountPublicState = {
      ...connected('acct-a', ''),
      authMode: 'api_key',
      credentialSource: 'manual',
      serverApiKeyId: undefined,
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
    };
    loadAccount.mockResolvedValue(account);
    const pending = deferred<DeepLinkResolveShareResponse>();
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'sign-in-required' })
      .mockReturnValueOnce(pending.promise);
    await mount();
    act(() => probe.current?.signIn());
    await flush();
    expect(mockOpenCloudAccountSettings).toHaveBeenCalledTimes(1);

    const replacement = {
      ...account,
      updatedAt: '2026-10-29T00:01:00.000Z',
    };
    await changeAccount(replacement);
    await changeAccount(replacement);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.state.phase).toBe('loading');
    act(() => pending.resolve(READY));
    await flush();
    expect(probe.current?.state.phase).toBe('ready');
  });

  it('does not retry a refused manual key on an account-data refresh', async () => {
    const account: CanopyCloudAccountPublicState = {
      ...connected('acct-a', ''),
      authMode: 'api_key',
      credentialSource: 'manual',
      serverApiKeyId: undefined,
      updatedAt: '2026-10-29T00:00:00.000Z',
    };
    loadAccount.mockResolvedValue(account);
    resolve.mockResolvedValue({ ok: false, reason: 'sign-in-required' });
    await mount();
    loadAccount.mockResolvedValue({
      ...account,
      updatedAt: '2026-10-29T00:01:00.000Z',
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
          detail: { reason: 'same-account-refresh' },
        }),
      );
    });
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'sign-in-required',
    });
  });

  it('re-resolves after switching to another account from an access refusal', async () => {
    loadAccount.mockResolvedValue(connected('acct-a', 'key-a'));
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'not-a-member' })
      .mockResolvedValueOnce({ ok: false, reason: 'sign-in-required' })
      .mockResolvedValueOnce(READY);
    await mount();
    act(() => probe.current?.switchAccount());
    expect(mockOpenCloudAccountSettings).toHaveBeenCalledTimes(1);

    // An event for the unchanged account does not re-resolve.
    await changeAccount(connected('acct-a', 'key-a'));
    expect(resolve).toHaveBeenCalledTimes(1);

    await changeAccount(SIGNED_OUT);
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'sign-in-required',
    });
    await changeAccount(connected('acct-b', 'key-c'));
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(probe.current?.state.phase).toBe('ready');
  });

  it('discards a result read under the previous account', async () => {
    loadAccount.mockResolvedValue(connected('acct-a', 'key-a'));
    const oldAccountRead = deferred<DeepLinkResolveShareResponse>();
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'not-a-member' })
      .mockReturnValueOnce(oldAccountRead.promise)
      .mockResolvedValueOnce(READY);
    await mount();
    await changeAccount(connected('acct-b', 'key-b'));
    expect(probe.current?.state).toEqual({ phase: 'loading' });
    // The account changes again while that resolve is still running.
    await changeAccount(connected('acct-c', 'key-c'));
    act(() => oldAccountRead.resolve({ ok: false, reason: 'not-a-member' }));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(probe.current?.state.phase).toBe('ready');
  });

  it('stops listening for account changes once the share resolves or unmounts', async () => {
    loadAccount.mockResolvedValue(connected('acct-a', 'key-a'));
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'not-a-member' })
      .mockResolvedValueOnce(READY);
    await mount();
    await changeAccount(connected('acct-b', 'key-b'));
    expect(probe.current?.state.phase).toBe('ready');
    const reads = loadAccount.mock.calls.length;
    await changeAccount(connected('acct-c', 'key-c'));
    expect(loadAccount).toHaveBeenCalledTimes(reads);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('does not watch account changes for failures sign-in cannot fix', async () => {
    resolve.mockResolvedValue({ ok: false, reason: 'not-found' });
    await mount();
    await changeAccount(connected('acct-b', 'key-b'));
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('stops watching when a recovery attempt reaches an unavailable share', async () => {
    resolve
      .mockResolvedValueOnce({ ok: false, reason: 'not-a-member' })
      .mockResolvedValueOnce({ ok: false, reason: 'not-found' });
    await mount();
    act(() => probe.current?.retryResolve());
    await flush();
    await changeAccount(connected('acct-b', 'key-b'));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'not-found',
    });
  });

  it('stops recovery when the new link fails with a terminal reason', async () => {
    resolve
      .mockResolvedValue({ ok: false, reason: 'not-found' })
      .mockResolvedValueOnce({ ok: false, reason: 'not-a-member' })
      .mockResolvedValueOnce({ ok: false, reason: 'not-found' });
    await mount();
    currentLink = { ...skillLink, externalId: 'other-share' };
    act(() => root.render(<SkillHarness />));
    await flush();
    await changeAccount(connected('acct-b', 'key-b'));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'not-found',
    });
  });

  it('ignores sign-in completion saved for an older link', async () => {
    resolve
      .mockResolvedValue({ ok: false, reason: 'cloud-unreachable' })
      .mockResolvedValueOnce({ ok: false, reason: 'sign-in-required' })
      .mockResolvedValueOnce({ ok: false, reason: 'cloud-unreachable' });
    await mount();
    act(() => probe.current?.signIn());
    await flush();
    const proceed = mockRequestConnect.mock.calls[0]?.[1];
    if (!proceed) throw new Error('No pending sign-in');
    currentLink = { ...skillLink, externalId: 'other-share' };
    act(() => root.render(<SkillHarness />));
    await flush();
    loadAccount.mockResolvedValue(connected('acct-b', 'key-b'));
    act(() => proceed());
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'cloud-unreachable',
    });
  });

  it('ignores older account reads that finish after a newer account event', async () => {
    loadAccount.mockResolvedValue(connected('acct-a', 'key-a'));
    resolve.mockResolvedValue({ ok: false, reason: 'not-a-member' });
    await mount();
    const oldRead = deferred<CanopyCloudAccountPublicState>();
    loadAccount.mockReturnValueOnce(oldRead.promise);
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await changeAccount(connected('acct-c', 'key-c'));
    expect(resolve).toHaveBeenCalledTimes(2);
    act(() => oldRead.resolve(connected('acct-b', 'key-b')));
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('cleans up a failed landing on unmount, including pending account reads', async () => {
    resolve.mockResolvedValue({ ok: false, reason: 'not-a-member' });
    await mount();
    const pendingAccount = deferred<CanopyCloudAccountPublicState>();
    loadAccount.mockReturnValueOnce(pendingAccount.promise);
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    act(() => root.render(null));
    const reads = loadAccount.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    act(() => pendingAccount.resolve(connected('acct-b', 'key-b')));
    await flush();
    expect(loadAccount).toHaveBeenCalledTimes(reads);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('discards a pending resolve after changing the share link', async () => {
    const oldResolve = deferred<DeepLinkResolveShareResponse>();
    resolve
      .mockReturnValueOnce(oldResolve.promise)
      .mockResolvedValueOnce({ ok: false, reason: 'not-found' });
    await mount();
    currentLink = { ...skillLink, externalId: 'other-share' };
    act(() => root.render(<SkillHarness />));
    await flush();
    act(() => oldResolve.resolve(READY));
    await flush();
    expect(probe.current?.state).toEqual({
      phase: 'error',
      reason: 'not-found',
    });
  });
});
