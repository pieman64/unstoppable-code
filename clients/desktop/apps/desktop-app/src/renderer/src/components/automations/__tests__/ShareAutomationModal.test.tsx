/** @jest-environment jsdom */
import { shareEnvelope } from '@/test-utils/shareOperation';
import { act, createElement } from 'react';
// eslint-disable-next-line no-restricted-imports -- jsdom needs this test-only TextEncoder polyfill.
import { TextEncoder } from 'node:util';
// eslint-disable-next-line no-restricted-imports -- jsdom has no SubtleCrypto; the bundled-pipeline hash needs one.
import { webcrypto } from 'node:crypto';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, TextEncoder });
// jsdom defines `crypto` as a getter-only accessor, so `Object.assign` is a
// silent no-op here and the bundled-pipeline hash would fall back to its
// "no Web Crypto" degradation instead of being exercised.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
});
import { createRoot, type Root } from 'react-dom/client';
import type {
  SharedAutomationDetail,
  SharedAutomationPublicShareInfo,
} from '@canopy/protocol/automations';
import { automationSharePath } from '@canopy/protocol/automations';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { CHAT_LABEL } from '@canopy/protocol';
import { hashPipelineDocumentYaml } from '@/lib/pipelineDocument';
import { ResourceContextProvider } from '@canopy/ui-app/capability';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

let mockRows: unknown[] = [];
jest.mock('@/hooks/useUnifiedTableData', () => ({
  useUnifiedTableData: (): { rows: unknown[]; loading: boolean } => ({
    rows: mockRows,
    loading: false,
  }),
}));
const mockCopy = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (text: string): Promise<boolean> => mockCopy(text),
}));
const mockPostShareToast = jest.fn();
jest.mock('@/lib/share-toast', () => ({
  postShareToast: (toast: unknown): void => {
    mockPostShareToast(toast);
  },
}));
import {
  chooseSettingsOption,
  settingsSelectOptionValues,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';
import { ShareAutomationModal } from '../ShareAutomationModal';
import * as accountStateModule from '@/hooks/useCanopyCloudAccountState';

const mockGet = jest.fn<Promise<SharedAutomationDetail>, [string]>();
const mockBaseUrl = jest.fn<Promise<string | null>, []>();
const mockUpdate = jest.fn<Promise<SharedAutomationDetail>, [unknown]>();
const mockLocalUpdate = jest.fn().mockResolvedValue({ ok: true });
const mockCreate = jest.fn<Promise<SharedAutomationDetail>, [unknown]>();
const mockPublish = jest.fn<
  Promise<SharedAutomationPublicShareInfo>,
  [string]
>();
const mockRevoke = jest.fn<Promise<void>, [string, string?]>();
const mockAnalyzePackage = jest.fn<Promise<unknown>, [unknown]>();
const mockCancelPackage = jest.fn<Promise<void>, [string]>();
const mockCommitPackage = jest.fn<Promise<unknown>, [unknown]>();
const mockResolvePin = jest.fn<Promise<unknown>, [unknown]>();
const mockOnClose = jest.fn();
const mockOnShared = jest.fn();
let root: Root | null = null;
const publicShare: SharedAutomationPublicShareInfo = {
  externalId: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
  pinnedContentHash: 'public-hash',
  upToDate: true,
  sharePath: automationSharePath('9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'),
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

function pipelineDetail(): SharedAutomationDetail {
  return {
    id: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
    name: 'Nightly review pipeline',
    description: '',
    triggerKind: 'cron',
    actionType: 'worktree_pipeline',
    contentHash: 'a'.repeat(64),
    shareScope: 'private',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Alex', email: null },
    canUpdate: true,
    canDelete: true,
    automation: {
      version: 1,
      name: 'Nightly review pipeline',
      description: '',
      trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: { source: 'bundled', pipelineId: 'code-review' },
        inputKeys: ['branch'],
      },
      hasRunCondition: false,
    },
  };
}

const mockListPipelines = jest.fn<Promise<unknown>, []>();
const mockLoadProjects = jest.fn<Promise<unknown>, []>();
const mockGetWorktreePath = jest.fn<Promise<string>, [unknown]>();
const mockDiscoverProject = jest.fn<Promise<unknown>, [string]>();
const mockGetPipeline = jest.fn<Promise<unknown>, [unknown]>();

beforeEach((): void => {
  jest.clearAllMocks();
  mockRows = [];
  mockListPipelines.mockResolvedValue({ success: true, data: [] });
  // Sharing resolves the bound project's kind and the pipeline's scopes
  // (CAN-3734), so the default fixtures seed a real code project and a
  // readable pipeline definition.
  mockLoadProjects.mockResolvedValue({
    version: 1,
    items: [{ id: 'workspace-1', type: 'single-repo', worktrees: [] }],
  });
  mockGetWorktreePath.mockResolvedValue('/repo');
  mockDiscoverProject.mockResolvedValue({ success: true, data: [] });
  mockGetPipeline.mockResolvedValue({
    success: true,
    data: {
      info: { id: 'code-review', name: 'Code review', source: 'bundled' },
      content: { name: 'Code review', on: 'dispatch', jobs: {} },
    },
  });
  mockGet.mockResolvedValue({ ...pipelineDetail(), publicShare: null });
  mockCreate.mockResolvedValue({ ...pipelineDetail(), publicShare: null });
  mockUpdate.mockResolvedValue({ ...pipelineDetail(), publicShare: null });
  mockBaseUrl.mockResolvedValue('https://cloud.test');
  mockPublish.mockResolvedValue(publicShare);
  mockRevoke.mockResolvedValue(undefined);
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'automation-analysis',
    state: 'ready',
    pipelineContentHash: 'b'.repeat(64),
    blockers: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
    manifest: {
      version: 1,
      pipelineContentHash: 'b'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
  });
  mockCancelPackage.mockResolvedValue(undefined);
  mockCommitPackage.mockResolvedValue({
    capabilityPackage: {
      version: 1,
      digest: `pp:v1:${'A'.repeat(43)}`,
    },
    committedPackageUploadId: 'upload-1',
  });
  mockResolvePin.mockResolvedValue({
    installPin: {
      pipelineContentHash: 'b'.repeat(64),
      distributionMode: 'definition_only',
    },
    rawPipeline: 'name: Team review\non: dispatch\njobs: {}\n',
  });
  mockCopy.mockResolvedValue(true);
  Object.assign(window, {
    api: {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        account: { id: 'user-1' },
        capabilities: [
          'automations-crud-v1',
          'automations-target-requirements-v3',
          'automations-run-condition-v4',
          'automations-pipeline-dependencies-v5',
        ],
      }),
      loadProjects: mockLoadProjects,
      getWorktreePath: mockGetWorktreePath,
      getCanopyCloudBaseUrl: mockBaseUrl,
      automations: {
        update: mockLocalUpdate,
        getShared: mockGet,
        createShared: shareEnvelope(mockCreate),
        updateShared: shareEnvelope(mockUpdate),
        publishPublicShare: mockPublish,
        revokePublicShare: mockRevoke,
        analyzeCapabilityPackage: mockAnalyzePackage,
        cancelCapabilityPackageAnalysis: mockCancelPackage,
        commitCapabilityPackage: shareEnvelope(mockCommitPackage),
        resolveSharedPipelineInstallPin: mockResolvePin,
      },
    },
    pipelines: {
      list: mockListPipelines,
      discoverProject: mockDiscoverProject,
      get: mockGetPipeline,
    },
  });
});

afterEach((): void => {
  act((): void => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!(element instanceof HTMLElement))
    throw new Error(`Missing testid ${id}`);
  return element;
}

const ADVANCED_TOGGLE = 'share-automation-advanced-toggle';

/** The shared document preview lives under Advanced; open it when closed. */
function expandAdvanced(): void {
  const toggle = document.querySelector(`[data-testid="${ADVANCED_TOGGLE}"]`);
  if (
    toggle instanceof HTMLElement &&
    toggle.getAttribute('aria-expanded') === 'false'
  ) {
    act((): void => {
      toggle.click();
    });
  }
}

function previewElement(): HTMLElement {
  expandAdvanced();
  return byTestId('share-automation-preview');
}

/** Testids that live under More details; reading one opens it. */
function detailsElement(id: string): HTMLElement {
  expandAdvanced();
  return byTestId(id);
}

function previewText(): string {
  return previewElement().textContent ?? '';
}

async function click(id: string): Promise<void> {
  await act(async (): Promise<void> => {
    byTestId(id).click();
    await Promise.resolve();
  });
}

/**
 * Waits for state the component reaches only after real asynchronous work.
 *
 * Counting microtask ticks does not wait for `SubtleCrypto.digest`: it settles
 * outside the microtask queue, so a fixed `await Promise.resolve()` loop
 * returned before the bundled-pipeline state existed and the assertions read a
 * half-computed preview. Yield to the event loop instead, on the same bounded
 * deadline `submit` already uses, and let the original assertions report the
 * failure if readiness never arrives.
 */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (ready()) return;
    await act(async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * The same readiness wait, keyed on a testid's text instead of a predicate, and
 * reporting the timeout itself. Arrived from develop for the preview
 * assertions; both are kept because both are used.
 */
async function waitForTextContent(
  id: string,
  expected: string,
  timeoutMs = 4_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    expandAdvanced();
    const text =
      document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
    if (text.includes(expected)) return text;
    // Bundled-pipeline hashing uses Web Crypto, which resolves outside the
    // microtask queue. Yield to the event loop so React can commit the result
    // even when the full Jest shard is under load.
    await act(async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for ${id} to contain ${expected}`);
}

async function submit(): Promise<void> {
  const readyDeadline = Date.now() + 4_000;
  while (Date.now() < readyDeadline) {
    const button = byTestId('share-automation-submit');
    if (!button.hasAttribute('disabled')) break;
    const consent = document.querySelector<HTMLInputElement>(
      '[data-testid="share-automation-consent"] input',
    );
    if (consent && !consent.checked) {
      await act(async (): Promise<void> => {
        consent.click();
        await Promise.resolve();
      });
      continue;
    }
    // Bundled-pipeline hashing uses Web Crypto, which resolves outside the
    // microtask queue. Wait for React to enable the button before clicking;
    // clicking a disabled button is intentionally a no-op.
    await act(async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  const button = byTestId('share-automation-submit');
  if (button.hasAttribute('disabled')) {
    throw new Error('Timed out waiting for automation sharing to be ready');
  }
  act(() => {
    button.click();
  });
  const completionDeadline = Date.now() + 4_000;
  while (Date.now() < completionDeadline) {
    if (
      mockPostShareToast.mock.calls.length > 0 ||
      document.querySelector('[data-testid="share-automation-success"]') !==
        null ||
      document.querySelector('[data-testid="share-automation-partial"]') !==
        null ||
      document.querySelector('[role="alert"]') !== null
    ) {
      return;
    }
    // Submission itself can await Web Crypto and remote mocks. Keep those
    // updates inside act before assertions inspect the resulting UI.
    await act(async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Timed out waiting for automation sharing to finish');
}

async function renderModal(
  shared = true,
  action: ScheduledActivity['action'] = {
    type: 'worktree_pipeline',
    workspaceId: 'workspace-1',
    pipelineId: 'code-review',
    pipelineSource: 'bundled',
    inputs: {},
  },
  activityOverrides: Partial<ScheduledActivity> = {},
  selectPublic = true,
  resourceContext?: {
    readonly context: { kind: 'organization'; organizationId: string };
    readonly personalOrganizationId: string;
  },
): Promise<void> {
  const detail = pipelineDetail();
  const activity: ScheduledActivity = {
    version: 1,
    id: 'activity-1',
    name: detail.name,
    enabled: false,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    failureCount: 0,
    ...(shared
      ? {
          remote: {
            remoteId: detail.id,
            contentHash: detail.contentHash,
            shareScope: detail.shareScope,
            sharedAt: detail.updatedAt,
          },
        }
      : {}),
    ...activityOverrides,
  };
  root = createRoot(document.body);
  await act(async (): Promise<void> => {
    const modal = createElement(ShareAutomationModal, {
      activity,
      onClose: mockOnClose,
      onOpenAccountSettings: (): void => {},
      onShared: mockOnShared,
    });
    root?.render(
      resourceContext
        ? createElement(ResourceContextProvider, {
            ...resourceContext,
            children: modal,
          })
        : modal,
    );
    await Promise.resolve();
  });
  if (selectPublic) {
    const publicOption = document.querySelector<HTMLElement>(
      '[data-testid="share-automation-scope-public"]',
    );
    if (publicOption) await click('share-automation-scope-public');
  }
}

it('shares a session-bound automation and says the chat target stays behind', async (): Promise<void> => {
  await renderModal(false, {
    type: 'worktree_session_prompt',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    prompt: 'Summarize the diff',
    attachmentPaths: ['/Users/me/secret.pdf'],
  });

  expect(
    document.querySelector('[data-testid="share-automation-blocked"]'),
  ).toBeNull();
  const notices = detailsElement('share-automation-notices').textContent ?? '';
  expect(notices).toContain(
    'The original chat and its history stay on this machine',
  );
  expect(notices).toContain('Attached files');
  expect(previewElement().textContent).toContain('"type": "worktree_prompt"');
  expect(detailsElement('automation-summary-runs-in').textContent).toBe(
    'Runs in a code project',
  );
});

// CAN-3734: the reported automation was a session prompt bound to a Cowork
// chat; sharing it must keep the Cowork destination, not convert it to a
// code-project worktree prompt.
it('shares a Cowork-bound session prompt as a Cowork prompt', async (): Promise<void> => {
  mockLoadProjects.mockResolvedValue({
    version: 1,
    items: [{ id: 'cowork-1', type: 'cowork', worktrees: [] }],
  });
  await renderModal(false, {
    type: 'worktree_session_prompt',
    workspaceId: 'cowork-1',
    worktreeId: 'cowork-home',
    chatId: 'chat-1',
    prompt: 'Check #feed-canopy-ci for my blame issues',
    planMode: true,
  });

  const preview = previewElement().textContent ?? '';
  expect(preview).toContain('"type": "standalone_prompt"');
  expect(preview).toContain('"kind": "cowork"');
  expect(preview).not.toContain('worktree_prompt');
  expect(preview).not.toContain('planMode');
  expect(detailsElement('automation-summary-runs-in').textContent).toBe(
    `Runs in a ${CHAT_LABEL} project`,
  );

  await submit();
  const createRequest = JSON.stringify(mockCreate.mock.calls[0]?.[0]);
  expect(createRequest).toContain('"type":"standalone_prompt"');
});

it('shares an App Advisor session prompt as an App Advisor prompt', async (): Promise<void> => {
  await renderModal(false, {
    type: 'worktree_session_prompt',
    workspaceId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'app-advisor',
    chatId: 'chat-1',
    prompt: 'Summarize my week',
  });

  expect(previewElement().textContent).toContain(
    '"type": "app_advisor_prompt"',
  );
  expect(mockLoadProjects).not.toHaveBeenCalled();
});

it('blocks sharing a session prompt whose project cannot be resolved', async (): Promise<void> => {
  mockLoadProjects.mockResolvedValue({ version: 1, items: [] });
  await renderModal(false, {
    type: 'worktree_session_prompt',
    workspaceId: 'deleted-project',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    prompt: 'Summarize the diff',
  });

  expect(byTestId('share-automation-blockers').textContent).toContain(
    'Choose an accessible chat before sharing this automation.',
  );
  expect(byTestId('share-automation-submit').hasAttribute('disabled')).toBe(
    true,
  );
});

it('shares an automation with an approval mode and says the mode stays behind', async (): Promise<void> => {
  await renderModal(false, {
    type: 'standalone_prompt',
    chatProjectId: 'cowork-1',
    prompt: 'Summarize the inbox',
    approvalMode: 'full-access',
  });

  expect(
    document.querySelector('[data-testid="share-automation-blockers"]'),
  ).toBeNull();
  expect(detailsElement('share-automation-notices').textContent).toContain(
    'The approval mode stays on this machine',
  );
  expect(previewElement().textContent).not.toContain('full-access');

  await submit();
  const createRequest = JSON.stringify(mockCreate.mock.calls[0]?.[0]);
  expect(createRequest).toContain('"type":"standalone_prompt"');
  expect(createRequest).not.toContain('approvalMode');
  expect(createRequest).not.toContain('full-access');
});

it('resolves a session-bound prompt’s plugin selections against the catalog', async (): Promise<void> => {
  mockRows = [
    {
      kind: 'skill',
      key: 'source-a/portable',
      name: 'portable',
      description: '',
      source: 'source-a',
      sourceSubtitle: '',
      sourceIcon: 'folder',
      shareableRef: {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'portable',
      },
    },
  ];
  await renderModal(false, {
    type: 'worktree_session_prompt',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    prompt: 'Summarize the diff',
    model: 'sonnet',
    planMode: true,
    pluginSelections: {
      collectionIds: [],
      skillRefs: [{ sourceId: 'source-a', skillName: 'portable' }],
      pluginRefs: [],
    },
  });

  expect(
    document.querySelector('[data-testid="share-automation-blockers"]'),
  ).toBeNull();
  const preview = previewElement().textContent ?? '';
  expect(preview).toContain('"skill_name": "portable"');
  expect(preview).toContain('"model": "sonnet"');
  expect(preview).toContain('"planMode": true');
  expect(preview).not.toContain('source-a');
});

it('does not mark local capabilities as dropped when packaging is available', async (): Promise<void> => {
  mockRows = [
    {
      kind: 'skill',
      key: 'source-a/portable',
      name: 'portable',
      description: '',
      source: 'source-a',
      sourceSubtitle: '',
      sourceIcon: 'folder',
      shareableRef: {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'portable',
      },
    },
  ];
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Review this',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [
        { sourceId: 'source-a', skillName: 'portable' },
        { sourceId: 'local', skillName: 'only-here' },
      ],
      pluginRefs: [],
    },
  });

  expect(
    document.querySelector('[data-testid="share-automation-blocked"]'),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="share-automation-dropped-plugins"]'),
  ).toBeNull();
});

/** A prompt automation whose local-only skill forces a capability package. */
const LOCAL_CAPABILITY_PROMPT_ACTION: ScheduledActivity['action'] = {
  type: 'worktree_prompt',
  workspaceId: 'workspace-1',
  prompt: 'Review this',
  pluginSelections: {
    collectionIds: [],
    skillRefs: [
      { sourceId: 'source-a', skillName: 'portable' },
      { sourceId: 'source-b', skillName: 'packaged-portable' },
      { sourceId: 'local', skillName: 'only-here' },
    ],
    pluginRefs: [],
  },
};

function arrangeLocalCapabilityPackage(): void {
  mockRows = [
    {
      kind: 'skill',
      key: 'source-a/portable',
      name: 'portable',
      description: '',
      source: 'source-a',
      sourceSubtitle: '',
      sourceIcon: 'folder',
      shareableRef: {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'portable',
      },
    },
    {
      kind: 'skill',
      key: 'source-b/packaged-portable',
      name: 'packaged-portable',
      description: '',
      source: 'source-b',
      sourceSubtitle: '',
      sourceIcon: 'folder',
      shareableRef: {
        type: 'skill',
        source: { type: 'github', repo: 'acme/tools' },
        skill_name: 'packaged-portable',
      },
    },
  ];
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'analysis-1',
    state: 'ready',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [
        {
          id: 'skill-1',
          kind: 'standalone_skill',
          displayName: 'only-here',
          sourceLabel: 'local',
          sourceVisibility: 'local',
          invocationKeys: ['$only-here'],
          dependencyResourceIds: [],
          trees: [],
        },
      ],
      bindings: [
        { jobId: 'automation', stepId: 'action', resourceIds: ['skill-1'] },
      ],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [],
    optionalResourceIds: [],
    dismissedInvocations: [],
  });
}

it('packages local capabilities while preserving reference-only built-ins', async (): Promise<void> => {
  arrangeLocalCapabilityPackage();
  await renderModal(false, LOCAL_CAPABILITY_PROMPT_ACTION);
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(
    document.querySelector('[data-testid="share-automation-dropped-plugins"]'),
  ).toBeNull();
  await submit();
  expect(mockCommitPackage).toHaveBeenCalledWith({
    analysisId: 'analysis-1',
    selectedOptionalResourceIds: [],
  });
  const createRequest = JSON.stringify(mockCreate.mock.calls[0]?.[0]);
  expect(createRequest).toContain('"committedPackageUploadId":"upload-1"');
  expect(createRequest).toContain('"capabilityPackage":{"version":1');
  expect(createRequest).toContain(
    '"plugins":[{"type":"skill","source":{"type":"builtin","id":"app"},"skill_name":"portable"}]',
  );
  expect(createRequest).not.toContain('acme/tools');
});

const DEPENDENCY_PIPELINE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function arrangePackagedPipelineAnalysis(): void {
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'analysis-pipelines',
    state: 'ready',
    pipelineContentHash: 'a'.repeat(64),
    blockers: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [
        {
          id: `automation-pipeline-${DEPENDENCY_PIPELINE_ID}`,
          kind: 'automation_pipeline',
          displayName: 'Journey specialist',
          sourceLabel: 'local pipeline',
          sourceVisibility: 'local',
          invocationKeys: [],
          dependencyResourceIds: [],
          trees: [],
          pipelineKey: DEPENDENCY_PIPELINE_ID,
          pipelineContentHash: 'c'.repeat(64),
        },
      ],
      bindings: [
        {
          jobId: 'automation',
          stepId: 'action',
          resourceIds: [`automation-pipeline-${DEPENDENCY_PIPELINE_ID}`],
        },
      ],
      environmentRequirements: [],
      totalFiles: 1,
      totalBytes: 10,
    },
    packagedPipelines: [
      {
        key: DEPENDENCY_PIPELINE_ID,
        resourceId: `automation-pipeline-${DEPENDENCY_PIPELINE_ID}`,
        name: 'Journey specialist',
        pipelineContentHash: 'c'.repeat(64),
        source: 'user',
        isActionPipeline: false,
        optional: false,
        promptSpans: [{ textStart: 4, text: DEPENDENCY_PIPELINE_ID }],
      },
    ],
  });
}

it('packages the pipelines a prompt runs and shares them as a v5 document', async (): Promise<void> => {
  jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
    hasApiKey: true,
    authMode: 'api_key',
    credentialSource: 'manual',
    storageAvailable: true,
    account: {
      id: 'user-1',
      name: 'Alex',
      email: 'alex@example.com',
      role: 'ADMIN',
    },
    capabilities: [
      'automations-crud-v1',
      'automations-target-requirements-v3',
      'automations-run-condition-v4',
      'automations-pipeline-dependencies-v5',
    ],
  });
  arrangePackagedPipelineAnalysis();
  const dependencies = {
    pipelines: [
      { pipelineId: DEPENDENCY_PIPELINE_ID, source: 'user' as const },
    ],
  };
  await renderModal(
    false,
    {
      type: 'app_advisor_prompt',
      prompt: `Run ${DEPENDENCY_PIPELINE_ID} every day.`,
    },
    { dependencies },
  );
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockAnalyzePackage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      promptText: `Run ${DEPENDENCY_PIPELINE_ID} every day.`,
      pipelineDependencies: dependencies.pipelines,
      audience: 'public',
    }),
  );
  expect(
    detailsElement(
      `share-automation-dependencies-pipeline-${DEPENDENCY_PIPELINE_ID}`,
    ).dataset.included,
  ).toBe('true');

  await submit();
  const created = mockCreate.mock.calls[0]?.[0] as
    | { automation: { version: number; action: Record<string, unknown> } }
    | undefined;
  expect(created?.automation.version).toBe(5);
  expect(created?.automation.action.pipelineDependencies).toEqual([
    {
      key: DEPENDENCY_PIPELINE_ID,
      pipeline: {
        source: 'packaged',
        key: DEPENDENCY_PIPELINE_ID,
        pipelineContentHash: 'c'.repeat(64),
        name: 'Journey specialist',
      },
      promptSpans: [{ textStart: 4, text: DEPENDENCY_PIPELINE_ID }],
    },
  ]);
});

it('adds a pipeline from the share dialog: saves it with the automation and analyzes again', async (): Promise<void> => {
  const workerId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  mockListPipelines.mockResolvedValue({
    success: true,
    data: [
      { id: workerId, name: 'Journey worker', source: 'user' },
      { id: 'project-pipeline', name: 'Project review', source: 'project' },
    ],
  });
  await renderModal(false, {
    type: 'app_advisor_prompt',
    prompt: 'Run the journey specialists.',
  });
  await waitFor(() => mockAnalyzePackage.mock.calls.length > 0);
  const select = detailsElement('share-automation-dependencies-pipeline-add');
  if (
    !(select instanceof HTMLButtonElement) ||
    select.getAttribute('role') !== 'combobox'
  )
    throw new Error('expected a settings select');
  // Only the author's own pipelines are offered.
  expect(settingsSelectOptionValues(select)).toEqual([workerId]);

  await chooseSettingsOption(select, workerId);
  await waitFor(() =>
    mockAnalyzePackage.mock.calls.some(
      ([request]) =>
        typeof request === 'object' &&
        request !== null &&
        'pipelineDependencies' in request,
    ),
  );

  expect(mockLocalUpdate).toHaveBeenCalledWith({
    id: 'activity-1',
    dependencies: { pipelines: [{ pipelineId: workerId, source: 'user' }] },
  });
  expect(mockAnalyzePackage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      pipelineDependencies: [{ pipelineId: workerId, source: 'user' }],
    }),
  );
});

it('shares without pipeline dependencies when the server cannot publish them', async (): Promise<void> => {
  jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
    hasApiKey: true,
    authMode: 'api_key',
    credentialSource: 'manual',
    storageAvailable: true,
    account: {
      id: 'user-1',
      name: 'Alex',
      email: 'alex@example.com',
      role: 'ADMIN',
    },
    capabilities: [
      'automations-crud-v1',
      'automations-target-requirements-v3',
      'automations-run-condition-v4',
    ],
  });
  const plainAnalysis = await mockAnalyzePackage({});
  arrangePackagedPipelineAnalysis();
  const packagedAnalysis = await mockAnalyzePackage({});
  mockAnalyzePackage.mockClear();
  mockAnalyzePackage.mockImplementation((request) =>
    Promise.resolve(
      typeof request === 'object' &&
        request !== null &&
        'packagePipelines' in request &&
        request.packagePipelines === false
        ? plainAnalysis
        : packagedAnalysis,
    ),
  );
  await renderModal(false, {
    type: 'app_advisor_prompt',
    prompt: `Run ${DEPENDENCY_PIPELINE_ID} every day.`,
  });
  await waitFor(() =>
    mockAnalyzePackage.mock.calls.some(
      ([request]) =>
        typeof request === 'object' &&
        request !== null &&
        'packagePipelines' in request,
    ),
  );
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockAnalyzePackage).toHaveBeenLastCalledWith(
    expect.objectContaining({ packagePipelines: false }),
  );
  expect(
    document.querySelector(
      '[data-testid="share-automation-dependencies-pipeline-add"]',
    ),
  ).toBeNull();

  await submit();
  const created = mockCreate.mock.calls[0]?.[0] as
    | { automation: { version: number; action: Record<string, unknown> } }
    | undefined;
  expect(created?.automation.version).toBeLessThan(5);
  expect(created?.automation.action).not.toHaveProperty('pipelineDependencies');
});

function blockedPromptAnalysis(
  dismissedInvocations: Array<{ provider: string; token: string }> = [],
): unknown {
  return {
    analysisId: 'analysis-blocked',
    state: 'blocked',
    pipelineContentHash: 'a'.repeat(64),
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [
      {
        code: 'UNRESOLVED_INVOCATION',
        message: 'Required invocation /invalid-skill could not be resolved.',
        subject: '/invalid-skill',
        origin: 'direct',
        provider: 'claude',
        occurrences: [{ jobId: 'automation', stepId: 'action' }],
        dismissal: { provider: 'claude', token: '/invalid-skill' },
      },
    ],
    optionalResourceIds: [],
    dismissedInvocations,
  };
}

it('analyzes the prompt of an automation that carries no plugin selections', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue(blockedPromptAnalysis());
  await renderModal(false, {
    type: 'worktree_session_prompt',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    prompt: 'Say hello with /invalid-skill name',
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockAnalyzePackage).toHaveBeenCalledWith(
    expect.objectContaining({
      promptText: 'Say hello with /invalid-skill name',
    }),
  );
  expect(
    byTestId('share-automation-dependency-problems').dataset.problemCount,
  ).toBe('1');
  expect(
    byTestId(
      'share-automation-dependency-problems-dismiss-unresolved-invocation-invalid-skill',
    ),
  ).toBeDefined();
});

it('blocks the share while a prompt dependency is unresolved', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue(blockedPromptAnalysis());
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Say hello with /invalid-skill name',
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const submit = byTestId('share-automation-submit');
  expect(submit.getAttribute('disabled')).not.toBeNull();
  await click('share-automation-submit');
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockCommitPackage).not.toHaveBeenCalled();
});

it('re-analyzes with the dismissal once the author marks a token as not a command', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue(blockedPromptAnalysis());
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Say hello with /invalid-skill name',
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  mockAnalyzePackage.mockResolvedValue({
    ...(blockedPromptAnalysis([
      { provider: 'claude', token: '/invalid-skill' },
    ]) as Record<string, unknown>),
    analysisId: 'analysis-dismissed',
    state: 'ready',
    blockers: [],
  });
  await click(
    'share-automation-dependency-problems-dismiss-unresolved-invocation-invalid-skill',
  );
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockAnalyzePackage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      dismissedInvocations: [{ provider: 'claude', token: '/invalid-skill' }],
    }),
  );
  expect(
    byTestId('share-automation-submit').getAttribute('disabled'),
  ).toBeNull();
});

it('re-shares an installed capability package without replacing it from portable refs', async (): Promise<void> => {
  const capabilityPackage = {
    version: 1 as const,
    digest: `pp:v1:${'I'.repeat(43)}`,
  };
  mockRows = [
    {
      kind: 'skill',
      key: 'app/portable',
      name: 'portable',
      description: '',
      source: 'app',
      sourceSubtitle: '',
      sourceIcon: 'folder',
      shareableRef: {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'portable',
      },
    },
  ];
  mockCommitPackage.mockResolvedValueOnce({
    capabilityPackage,
    committedPackageUploadId: 'upload-1',
  });
  await renderModal(
    false,
    {
      type: 'worktree_prompt',
      workspaceId: 'workspace-1',
      prompt: 'Review this',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'app', skillName: 'portable' }],
        pluginRefs: [],
      },
    },
    {
      installedFrom: {
        remoteId: 'installed-share',
        contentHash: 'c'.repeat(64),
        installedAt: '2026-09-18T12:00:00.000Z',
        capabilityPackage,
      },
    },
  );

  expandAdvanced();
  expect(
    document.querySelector('[data-testid="share-automation-dependencies"]'),
  ).not.toBeNull();
  await submit();

  expect(mockAnalyzePackage).not.toHaveBeenCalled();
  const commitRequest = mockCommitPackage.mock.calls[0]?.[0] as
    | {
        localAutomationId?: unknown;
        packageRef?: unknown;
        expectedPackageContentHash?: unknown;
      }
    | undefined;
  expect(commitRequest).toMatchObject({
    localAutomationId: 'activity-1',
    packageRef: capabilityPackage,
  });
  expect(commitRequest?.expectedPackageContentHash).toEqual(
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(JSON.stringify(mockCreate.mock.calls[0]?.[0])).toContain(
    `"capabilityPackage":${JSON.stringify(capabilityPackage)}`,
  );
  expect(JSON.stringify(mockCreate.mock.calls[0]?.[0])).toContain(
    '"committedPackageUploadId":"upload-1"',
  );
});

it('blocks re-sharing an installed prompt package after the prompt changes', async (): Promise<void> => {
  const capabilityPackage = {
    version: 1 as const,
    digest: `pp:v1:${'I'.repeat(43)}`,
  };
  const originalAction: ScheduledActivity['action'] = {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Review this with /original-helper',
  };
  const originalHash = await hashPipelineDocumentYaml(
    JSON.stringify({ name: pipelineDetail().name, action: originalAction }),
  );
  if (originalHash === null) throw new Error('Web Crypto unavailable');
  mockCommitPackage.mockImplementationOnce((request) => {
    const expectedPackageContentHash = (
      request as { expectedPackageContentHash?: string | null }
    ).expectedPackageContentHash;
    // Match the main-process compatibility behavior: an omitted expectation
    // skips identity validation, while a supplied mismatch fails closed.
    if (
      expectedPackageContentHash !== undefined &&
      expectedPackageContentHash !== originalHash
    ) {
      throw new Error(
        'The automation changed since this capability package was installed.',
      );
    }
    return Promise.resolve({
      capabilityPackage,
      committedPackageUploadId: 'upload-1',
    });
  });

  await renderModal(
    false,
    {
      ...originalAction,
      prompt: 'Review this with /new-helper',
    },
    {
      installedFrom: {
        remoteId: 'installed-share',
        contentHash: 'c'.repeat(64),
        installedAt: '2026-09-18T12:00:00.000Z',
        capabilityPackage,
      },
    },
  );
  await submit();

  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'The automation changed since this capability package was installed.',
  );
  expect(mockCreate).not.toHaveBeenCalled();
});

it('pins an installed package commit to the exact stored bundled pipeline bytes', async (): Promise<void> => {
  const capabilityPackage = {
    version: 1 as const,
    digest: `pp:v1:${'I'.repeat(43)}`,
  };
  const rawPipeline = [
    '# preserve this installed-package comment',
    'name: Edited installed pipeline',
    'on: dispatch',
    'jobs:',
    '  review:',
    '    steps:',
    '      - id: review',
    '        run: /edited-review',
    '',
  ].join('\n');
  const expectedContentHash = await hashPipelineDocumentYaml(rawPipeline);
  if (expectedContentHash === null) throw new Error('Web Crypto unavailable');
  mockListPipelines.mockResolvedValue({
    success: true,
    data: [
      {
        id: 'installed-pipeline',
        name: 'Edited installed pipeline',
        filename: 'edited-installed-pipeline.yaml',
        description: '',
        icon: '',
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
        source: 'user',
        readonly: false,
      },
    ],
  });
  mockGetPipeline.mockResolvedValue({
    success: true,
    data: {
      info: {
        id: 'installed-pipeline',
        name: 'Edited installed pipeline',
        filename: 'edited-installed-pipeline.yaml',
        description: '',
        icon: '',
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
        source: 'user',
        readonly: false,
      },
      content: {
        name: 'Edited installed pipeline',
        jobs: { review: { steps: [{ id: 'review', run: '/edited-review' }] } },
      },
      rawContent: rawPipeline,
    },
  });
  await renderModal(
    false,
    {
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'installed-pipeline',
      pipelineSource: 'user',
      inputs: {},
    },
    {
      installedFrom: {
        remoteId: 'installed-share',
        contentHash: 'c'.repeat(64),
        installedAt: '2026-09-18T12:00:00.000Z',
        bundledPipelineLocalId: 'installed-pipeline',
        capabilityPackage,
      },
    },
  );
  await act(async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

  await submit();

  expect(mockAnalyzePackage).not.toHaveBeenCalled();
  const commitRequest = mockCommitPackage.mock.calls[0]?.[0] as
    | {
        localAutomationId?: unknown;
        packageRef?: unknown;
        expectedPackageContentHash?: unknown;
      }
    | undefined;
  expect(commitRequest).toMatchObject({
    localAutomationId: 'activity-1',
    packageRef: capabilityPackage,
  });
  expect(commitRequest?.expectedPackageContentHash).toBe(expectedContentHash);
});

// CAN-5479: a converted chat automation installed with a package shares the
// chat action its package binds, pinned to the hash its install recorded.
it('re-shares a converted package install as the chat action it shows', async (): Promise<void> => {
  const capabilityPackage = {
    version: 1 as const,
    digest: `pp:v1:${'I'.repeat(43)}`,
  };
  const chatAction: ScheduledActivity['action'] = {
    type: 'standalone_prompt',
    chatProjectId: 'cowork-1',
    prompt: 'Review this',
  };
  mockCommitPackage.mockResolvedValueOnce({
    capabilityPackage,
    committedPackageUploadId: 'upload-1',
  });
  await renderModal(false, chatAction, {
    installedFrom: {
      remoteId: 'installed-share',
      contentHash: 'c'.repeat(64),
      installedAt: '2026-09-18T12:00:00.000Z',
      capabilityPackage,
    },
    ownedPipeline: {
      pipelineId: 'owned-1',
      chatEditable: true,
      storedAction: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineId: 'owned-1',
        pipelineSource: 'user',
        inputs: { project_id: 'cowork-1' },
      },
    },
  });
  await submit();

  const expectedContentHash = await hashPipelineDocumentYaml(
    JSON.stringify({ name: pipelineDetail().name, action: chatAction }),
  );
  if (expectedContentHash === null) throw new Error('Web Crypto unavailable');
  const commitRequest = mockCommitPackage.mock.calls[0]?.[0] as
    | { expectedPackageContentHash?: unknown }
    | undefined;
  expect(commitRequest?.expectedPackageContentHash).toBe(expectedContentHash);
  const created = JSON.stringify(mockCreate.mock.calls[0]?.[0]);
  expect(created).toContain('"type":"standalone_prompt"');
  expect(created).not.toContain('worktree_pipeline');
});

it('analyzes again when publishing fails after package commit', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'analysis-retry',
    state: 'ready',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      // A ready analysis over real selections always yields at least one
      // resource; an empty manifest is never committed as a package.
      resources: [
        {
          id: 'skill-1',
          kind: 'standalone_skill',
          displayName: 'only-here',
          sourceLabel: 'local',
          sourceVisibility: 'local',
          invocationKeys: ['/only-here'],
          dependencyResourceIds: [],
          trees: [],
        },
      ],
      bindings: [
        { jobId: 'automation', stepId: 'action', resourceIds: ['skill-1'] },
      ],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [],
    optionalResourceIds: [],
    dismissedInvocations: [],
  });
  mockCreate.mockRejectedValueOnce(new Error('Unable to publish'));
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Review this',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [{ sourceId: 'local', skillName: 'only-here' }],
      pluginRefs: [],
    },
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Unable to publish',
  );
  // A failed share re-reviews the dependencies; Share stays disabled until
  // the new analysis lands.
  await waitFor(() => mockAnalyzePackage.mock.calls.length === 2);
  expect(mockAnalyzePackage).toHaveBeenCalledTimes(2);
  await submit();

  expect(mockCommitPackage).toHaveBeenCalledTimes(2);
  expect(mockCommitPackage).toHaveBeenNthCalledWith(2, {
    analysisId: 'analysis-retry',
    selectedOptionalResourceIds: [],
  });
  expect(mockCreate).toHaveBeenCalledTimes(2);
});

it('keeps collection-expanded MCP omissions visible when packaging is ready', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'analysis-1',
    state: 'ready',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [],
    optionalResourceIds: [],
    dismissedInvocations: [],
    unpackageableSelectionLabels: [
      'collection-server',
      'Collection "missing" was not found.',
    ],
  });
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Review this',
    pluginSelections: {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [],
    },
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  // Nothing is copied, but the left-out selections keep the review, which
  // sits under More details above the shared document, collapsed by default.
  expect(
    document.querySelector('[data-testid="share-automation-dependencies"]'),
  ).toBeNull();
  expandAdvanced();
  const review = byTestId('share-automation-dependencies');
  expect(byTestId('share-automation-advanced-body').contains(review)).toBe(
    true,
  );
  // DOCUMENT_POSITION_FOLLOWING === 4.
  expect(review.compareDocumentPosition(previewElement()) & 4).toBe(4);
  // The help icon after the summary names what stays private.
  act(() => {
    const help = byTestId('share-automation-dependencies-help');
    for (const type of ['mouseover', 'mousemove']) {
      help.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
  const dropped = byTestId('share-automation-dependencies-help-details');
  expect(dropped.textContent).toContain('Kept private: collection-server');
  expect(dropped.textContent).toContain('Collection "missing" was not found.');
  expect(dropped.textContent).not.toContain('collection-1');
});

it('keeps the dependency section after the last blocker is dismissed', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue(blockedPromptAnalysis());
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Say hello with /invalid-skill name',
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  mockAnalyzePackage.mockResolvedValue({
    ...(blockedPromptAnalysis([
      { provider: 'claude', token: '/invalid-skill' },
    ]) as Record<string, unknown>),
    analysisId: 'analysis-all-dismissed',
    state: 'ready',
    blockers: [],
  });
  await click(
    'share-automation-dependency-problems-dismiss-unresolved-invocation-invalid-skill',
  );
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  // Nothing left to package, but the acknowledgement and its undo must stay:
  // hiding the section here would erase the author's action as they took it.
  const problems = byTestId('share-automation-dependency-problems');
  expect(problems.dataset.problemCount).toBe('0');
  expect(problems.dataset.dismissedCount).toBe('1');
});

it('omits Included files when the share copies nothing', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'analysis-empty',
    state: 'ready',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [],
    optionalResourceIds: [],
    dismissedInvocations: [],
  });
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Review this with no dependencies at all',
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  // Nothing to copy and nothing to set up: More details has no Included
  // files section at all, and Share stays available.
  expandAdvanced();
  expect(previewElement()).toBeTruthy();
  expect(
    document.querySelector('[data-testid="share-automation-dependencies"]'),
  ).toBeNull();
  expect(document.body.textContent).not.toContain('Included files');
  expect(
    byTestId('share-automation-submit').getAttribute('disabled'),
  ).toBeNull();
});

it('keeps a blocked dependency review outside Advanced', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue(blockedPromptAnalysis());
  await renderModal(false, {
    type: 'worktree_prompt',
    workspaceId: 'workspace-1',
    prompt: 'Say hello with /invalid-skill name',
  });
  await waitFor(
    () =>
      document.querySelector(
        '[data-testid="share-automation-dependency-problems"]',
      ) !== null,
  );

  const review = byTestId('share-automation-dependencies');
  expect(byTestId('share-automation-advanced').contains(review)).toBe(false);
  expandAdvanced();
  expect(
    byTestId('share-automation-advanced-body').querySelector(
      '[data-testid="share-automation-dependencies"]',
    ),
  ).toBeNull();
});

it('leaves out the Markdown hint under the description', async (): Promise<void> => {
  await renderModal(false, {
    type: 'app_advisor_prompt',
    prompt: 'Review today.',
  });

  expect(byTestId('share-automation-description')).toBeTruthy();
  expect(
    document.querySelector('[data-testid="share-automation-description-hint"]'),
  ).toBeNull();
  expect(document.body.textContent).not.toContain('Markdown works here.');
});

it('orders sharing scope above what the share carries', async (): Promise<void> => {
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'analysis-order',
    state: 'ready',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [],
    optionalResourceIds: [],
    dismissedInvocations: [],
  });
  await renderModal(false, {
    type: 'worktree_session_prompt',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    prompt: 'Summarize the diff',
    attachmentPaths: ['/Users/me/secret.pdf'],
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  });

  // Matches SharePipelineModal: scope and its target come before the review of
  // what actually travels. DOCUMENT_POSITION_FOLLOWING === 4.
  const scope = byTestId('share-automation-scope-description');
  const notices = detailsElement('share-automation-notices');
  expect(scope.compareDocumentPosition(notices) & 4).toBe(4);
  const preview = previewElement();
  expect(scope.compareDocumentPosition(preview) & 4).toBe(4);
});

it('derives a current install pin when sharing a shared pipeline', async (): Promise<void> => {
  await renderModal(false, {
    type: 'worktree_pipeline',
    workspaceId: 'workspace-1',
    pipelineId: 'shared:canopy-cloud:remote-1',
    pipelineSource: 'shared',
    pipelineName: 'Team review',
    sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
  });
  // Same readiness rule as the bundling test below: the derived pin reaches
  // the preview only after the component's real hashing resolves. The preview
  // may not be mounted on the first poll under a loaded shard.
  await waitFor(() => {
    expandAdvanced();
    return (
      document.querySelector('[data-testid="share-automation-preview"]')
        ?.textContent ?? ''
    ).includes('bbbbbbbbbbbb');
  });

  expect(mockResolvePin).toHaveBeenCalledWith({ remoteId: 'remote-1' });
  expect(previewElement().textContent).toContain('bbbbbbbbbbbb');
});

it('hides the notices panel entirely for a document with nothing to strip', async (): Promise<void> => {
  await renderModal(false, {
    type: 'app_advisor_prompt',
    prompt: 'Check the queue',
  });

  expandAdvanced();
  expect(
    document.querySelector('[data-testid="share-automation-notices"]'),
  ).toBeNull();
});

it('bundles the referenced pipeline definition into the shared document', async (): Promise<void> => {
  await renderModal(false, {
    type: 'worktree_pipeline',
    workspaceId: 'workspace-1',
    pipelineId: 'shared:canopy-cloud:remote-1',
    pipelineSource: 'shared',
    pipelineName: 'Team review',
    sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
  });
  // The bundled definition is only in the preview once the component's real
  // Web Crypto hash has resolved; its notice is that state becoming visible.
  await waitFor(() => {
    expandAdvanced();
    return (
      document.querySelector('[data-testid="share-automation-notices"]')
        ?.textContent ?? ''
    ).includes('The workflow definition travels with this automation');
  });

  expect(mockResolvePin).toHaveBeenCalledWith({ remoteId: 'remote-1' });
  const preview = await waitForTextContent(
    'share-automation-preview',
    '"source": "inline"',
  );
  expect(preview).toContain('"source": "inline"');
  // A shared pipeline keeps its team-share provenance alongside the bytes.
  expect(preview).toContain('"origin"');
  expect(preview).toContain('bbbbbbbbbbbb');
  // The bundled definition is included, so it is not listed as kept private.
  expect(
    detailsElement('share-automation-included-notices').textContent,
  ).toContain('Included with this automation:');
  expect(
    detailsElement('share-automation-included-notices').textContent,
  ).toContain('The workflow definition travels with this automation');
  expect(detailsElement('share-automation-notices').textContent).not.toContain(
    'The workflow definition travels with this automation',
  );
});

it('reads a pinless project pipeline from the project root without analyzing repo context', async (): Promise<void> => {
  mockLoadProjects.mockResolvedValue({
    version: 1,
    items: [
      {
        id: 'workspace-1',
        type: 'single-repo',
        repoPath: '/repo',
        worktrees: [{ id: 'worktree-default' }],
      },
    ],
  });
  mockDiscoverProject.mockResolvedValue({
    success: true,
    data: [
      {
        id: 'project-review',
        name: 'Project review',
        filename: 'review.yaml',
        filePath: '/repo/.canopy/pipelines/review.yaml',
        description: '',
        icon: '',
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-18T00:00:00.000Z',
        source: 'project',
        readonly: false,
      },
    ],
  });
  mockGetPipeline.mockResolvedValue({
    success: true,
    data: {
      info: {
        id: 'project-review',
        name: 'Project review',
        filename: 'review.yaml',
        filePath: '/repo/.canopy/pipelines/review.yaml',
        description: '',
        icon: '',
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-18T00:00:00.000Z',
        source: 'project',
        readonly: false,
      },
      content: {
        name: 'Project review',
        jobs: {
          review: { steps: [{ id: 'review', run: '/repo-review' }] },
        },
      },
    },
  });
  mockAnalyzePackage.mockResolvedValue({
    analysisId: 'analysis-project',
    state: 'ready',
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [],
    optionalResourceIds: [],
    dismissedInvocations: [],
  });

  await renderModal(false, {
    type: 'worktree_pipeline',
    workspaceId: 'workspace-1',
    pipelineId: 'project-review',
    pipelineSource: 'project',
    projectPipelineFilename: 'review.yaml',
  });
  const analysisDeadline = Date.now() + 4_000;
  let analysisRequest:
    | { pipelineContent?: unknown; worktree?: unknown }
    | undefined;
  while (Date.now() < analysisDeadline) {
    analysisRequest = mockAnalyzePackage.mock.calls
      .map(([request]) => request as typeof analysisRequest)
      .find((request) => request?.pipelineContent !== undefined);
    if (analysisRequest !== undefined) break;
    // Pipeline hashing uses Web Crypto, so the content-bearing analysis can
    // arrive after the microtask queue drains when the full CI shard is busy.
    await act(async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(mockAnalyzePackage).toHaveBeenCalled();
  expect(analysisRequest?.pipelineContent).toEqual(
    expect.stringContaining('/repo-review'),
  );
  expect(analysisRequest?.worktree).toBeUndefined();
});

it('sends a private share scope for a public share, then publishes', async (): Promise<void> => {
  await renderModal(false);
  expect(document.body.textContent).toContain('Anyone can view');
  mockCreate.mockResolvedValue({ ...pipelineDetail(), publicShare: null });
  await submit();

  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
    shareScope: 'private',
  });
  expect(mockPublish).toHaveBeenCalledWith(pipelineDetail().id);
  // The dialog stays open on its success notice instead of toasting.
  expect(mockOnClose).not.toHaveBeenCalled();
  expect(mockPostShareToast).not.toHaveBeenCalled();
  expect(byTestId('share-automation-success').textContent).toContain(
    'Automation is now public',
  );
  expect(byTestId('share-automation-link').textContent).toBe(
    'https://cloud.test/portal/plugins/automations/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
  );
});

function teamAccountWithPlatformTeam(): void {
  Object.assign(window.api, {
    loadCanopyCloudAccount: jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'user-1' },
      capabilities: ['automations-crud-v1', 'teams-v1'],
    }),
  });
  Object.assign(window.pipelines, {
    listSharedTeams: jest.fn().mockResolvedValue({
      success: true,
      data: {
        data: [
          {
            id: 'team-1',
            name: 'Platform',
            organization: { id: 'org-1', name: 'Acme' },
          },
        ],
      },
    }),
  });
}

function scopeChecked(label: string): string | null | undefined {
  return Array.from(
    byTestId('share-automation-scope').querySelectorAll('button'),
  )
    .find((button) => button.textContent?.trim() === label)
    ?.getAttribute('aria-checked');
}

// CAN-3844: an organization-owned automation can't move to the personal owner
// Public needs while context policy applies, so Public is disabled with a
// reason and the Organization update still works.
it('disables Public for an organization-owned automation and keeps the Organization update', async (): Promise<void> => {
  const organizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  Object.assign(window.api, {
    loadCanopyCloudAccount: jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'user-1' },
      capabilities: [
        'automations-crud-v1',
        'automations-target-requirements-v3',
        'automations-run-condition-v4',
        'organizations-v1',
      ],
    }),
  });
  Object.assign(window.pipelines, {
    listSharedOrganizations: jest.fn().mockResolvedValue({
      success: true,
      data: { data: [{ id: organizationId, name: 'Acme' }] },
    }),
  });
  const organizationDetail: SharedAutomationDetail = {
    ...pipelineDetail(),
    shareScope: 'organization',
    owner: { type: 'organization', id: organizationId, name: 'Acme' },
  };
  mockGet.mockResolvedValue({ ...organizationDetail, publicShare: null });
  mockUpdate.mockResolvedValue({ ...organizationDetail, publicShare: null });

  await renderModal(
    true,
    undefined,
    {
      remote: {
        remoteId: organizationDetail.id,
        contentHash: organizationDetail.contentHash,
        shareScope: 'organization',
        sharedAt: organizationDetail.updatedAt,
      },
    },
    false,
    {
      context: { kind: 'organization', organizationId },
      personalOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  );
  await waitFor(() => scopeChecked('Organization') === 'true');

  expect(scopeChecked('Organization')).toBe('true');
  expect(
    byTestId('share-automation-scope-public').hasAttribute('disabled'),
  ).toBe(true);
  expect(byTestId('share-automation-public-locked-hint').textContent).toBe(
    "Organization shares can't be made public yet.",
  );

  await submit();
  expect(mockUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ shareScope: 'organization', organizationId }),
  );
  expect(mockPublish).not.toHaveBeenCalled();
});

// CAN-3009: every type reads a team share with a public link the same way.
// It opens as Public so Remove public link is reachable, and an Update keeps
// the team as the owner instead of moving the automation to a personal copy.
it('normalizes a legacy team automation on explicit Public update', async (): Promise<void> => {
  teamAccountWithPlatformTeam();
  const teamDetail: SharedAutomationDetail = {
    ...pipelineDetail(),
    shareScope: 'team',
    publicShare,
  };
  mockGet.mockResolvedValue(teamDetail);
  mockUpdate.mockResolvedValue(teamDetail);

  await renderModal(true, undefined, {}, false);
  // Same readiness rule: the loaded share's scope is rendered after the
  // detail's own asynchronous work, not after a fixed number of microtasks.
  await waitFor(() => scopeChecked('Public') === 'true');

  expect(scopeChecked('Public')).toBe('true');
  expect(scopeChecked('Team')).toBe('false');
  expect(byTestId('share-automation-remove-public-link')).toBeDefined();

  await submit();
  expect(mockUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ shareScope: 'private' }),
  );
  // The public link stays: nothing asks the update to revoke it.
  expect(mockUpdate).not.toHaveBeenCalledWith(
    expect.objectContaining({
      revokePublicShare: {
        externalId: publicShare.externalId,
        updatedAt: publicShare.updatedAt,
      },
    }),
  );
  expect(mockPublish).toHaveBeenCalledTimes(1);
});

it('keeps the team preselected when a team automation with a public link is narrowed to Team', async (): Promise<void> => {
  teamAccountWithPlatformTeam();
  const teamDetail: SharedAutomationDetail = {
    ...pipelineDetail(),
    shareScope: 'team',
    publicShare,
  };
  mockGet.mockResolvedValue(teamDetail);
  mockUpdate.mockResolvedValue({ ...teamDetail, publicShare: null });

  await renderModal(true, undefined, {}, false);
  await waitFor(() => scopeChecked('Public') === 'true');
  await click('share-automation-scope-team');
  expect(scopeChecked('Team')).toBe('true');

  // The current owner is preselected in the shared picker once its list
  // arrives: avatar, the owning organization, and a filled indicator.
  await waitFor(
    () =>
      document
        .querySelector(
          '[data-testid="share-automation-team-picker-option-team-1"]',
        )
        ?.getAttribute('aria-pressed') === 'true',
  );
  const ownerRow = byTestId('share-automation-team-picker-option-team-1');
  expect(ownerRow.getAttribute('aria-pressed')).toBe('true');
  expect(ownerRow.textContent).toContain('Acme');
  expect(
    ownerRow
      .querySelector('[data-testid="shared-target-picker-selection-indicator"]')
      ?.getAttribute('data-selected'),
  ).toBe('true');
  expect(
    byTestId('share-automation-team-picker')
      .querySelector('input[type="search"]')
      ?.getAttribute('placeholder'),
  ).toBe('Search teams…');

  await submit();
  expect(mockUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      shareScope: 'team',
      teamId: 'team-1',
      revokePublicShare: {
        externalId: publicShare.externalId,
        updatedAt: publicShare.updatedAt,
      },
    }),
  );
  expect(mockPublish).not.toHaveBeenCalled();
});

it('removes the observed public link through the shared confirmation flow', async (): Promise<void> => {
  mockGet.mockResolvedValue({ ...pipelineDetail(), publicShare });

  await renderModal(true, undefined, {}, false);
  await waitFor(
    () =>
      document.querySelector('[data-testid="share-automation-copy-link"]') !==
      null,
  );
  expect(byTestId('share-automation-copy-link')).toBeDefined();
  await click('share-automation-remove-public-link');
  // The fixture is team-owned, so removing the link keeps that audience.
  expect(
    byTestId('share-automation-remove-public-link-confirm').textContent,
  ).toContain(
    'People outside Platform who have the link will lose access. Platform members keep access, including through links they already have.',
  );
  await click('share-automation-remove-public-link-confirm-action');

  expect(mockRevoke).toHaveBeenCalledWith(pipelineDetail().id);
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
});

it('retains the public link when retry succeeds but completion fails', async (): Promise<void> => {
  mockPublish.mockRejectedValueOnce(new Error('Unable to publish.'));
  mockOnShared.mockImplementationOnce(() => {
    throw new Error('Local share state could not be saved.');
  });
  await renderModal(false);
  await submit();

  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(byTestId('share-automation-partial').textContent).toContain(
    "Automation saved, but the public link couldn't be created.",
  );
  await click('share-automation-retry-public');
  // The create is never retried — that would duplicate the share.
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockPublish).toHaveBeenCalledTimes(2);
  expect(mockPostShareToast).not.toHaveBeenCalled();
  expect(byTestId('share-automation-error').textContent).toContain(
    'Local share state could not be saved.',
  );
  await click('share-automation-copy-link');
  expect(mockCopy).toHaveBeenCalledWith(
    'https://cloud.test/portal/plugins/automations/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
  );
  await click('share-automation-done');
  // Done retries completion and closes; the author already has the link, so
  // there is no success notice or toast to stay for.
  expect(mockOnShared).toHaveBeenCalledTimes(2);
  expect(mockOnClose).toHaveBeenCalledTimes(1);
  expect(mockPostShareToast).not.toHaveBeenCalled();
});

it('stays open with a copyable link after a public share until Done', async (): Promise<void> => {
  const shareUrl =
    'https://cloud.test/portal/plugins/automations/9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
  await renderModal(false);
  await submit();

  expect(mockOnClose).not.toHaveBeenCalled();
  expect(mockPostShareToast).not.toHaveBeenCalled();
  expect(byTestId('share-automation-success').textContent).toContain(
    'Automation is now public',
  );
  expect(byTestId('share-automation-link').textContent).toBe(shareUrl);
  await click('share-automation-copy-link');
  expect(mockCopy).toHaveBeenCalledWith(shareUrl);
  await click('share-automation-done');
  expect(mockOnClose).toHaveBeenCalledTimes(1);
  expect(mockPostShareToast).not.toHaveBeenCalled();
});

it('preselects Public for a first share when it is the only usable scope', async (): Promise<void> => {
  // The account has no teams or organizations capability, so Public is the
  // one scope it can use: picking it for the author avoids a disabled Share
  // button with no visible reason.
  await renderModal(false, undefined, {}, false);

  expect(
    document
      .querySelector('[data-testid="share-automation-scope-public"]')
      ?.getAttribute('aria-checked'),
  ).toBe('true');
  expect(byTestId('share-automation-scope-description').textContent).toContain(
    'Anyone can view this automation',
  );
  expect(byTestId('share-automation-submit').hasAttribute('disabled')).toBe(
    false,
  );
});

// CAN-3734: pipeline authors may narrow where recipients can run the share;
// narrowing emits a v3 document with an explicit target requirement.
it('lets a pipeline author narrow the target to code projects', async (): Promise<void> => {
  await renderModal(false);
  await waitFor(() => {
    expandAdvanced();
    return (
      document.querySelector(
        '[data-testid="share-automation-target-narrowing"]',
      ) !== null
    );
  });
  expect(previewElement().textContent).not.toContain('targetRequirement');

  const cowork = detailsElement('share-automation-target-cowork');
  if (!(cowork instanceof HTMLInputElement)) throw new Error('expected input');
  act(() => {
    cowork.click();
  });

  const preview = previewElement().textContent ?? '';
  expect(preview).toContain('"version": 3');
  expect(preview).toContain('"targetRequirement"');
  expect(preview).toContain('"worktree"');
  // The last allowed context cannot be removed.
  const worktree = detailsElement('share-automation-target-worktree');
  if (!(worktree instanceof HTMLInputElement))
    throw new Error('expected input');
  expect(worktree.disabled).toBe(true);
});

it('offers no narrowing for a worktree-only pipeline and says where it runs', async (): Promise<void> => {
  mockGetPipeline.mockResolvedValue({
    success: true,
    data: {
      info: { id: 'code-review', name: 'Code review', source: 'bundled' },
      content: {
        name: 'Code review',
        on: 'dispatch',
        scope: 'worktree',
        jobs: {},
      },
    },
  });
  await renderModal(false);
  await waitFor(() => {
    expandAdvanced();
    return (
      document.querySelector('[data-testid="automation-summary-runs-in"]') !==
      null
    );
  });

  expect(
    document.querySelector('[data-testid="share-automation-target-narrowing"]'),
  ).toBeNull();
  expect(detailsElement('automation-summary-runs-in').textContent).toBe(
    'Runs in a code project',
  );
});

it('persists an authored narrowing before publishing the v3 snapshot', async () => {
  await renderModal(false);
  await waitFor(() => {
    expandAdvanced();
    return (
      document.querySelector(
        '[data-testid="share-automation-target-cowork"]',
      ) !== null
    );
  });
  act(() => detailsElement('share-automation-target-cowork').click());
  await submit();
  expect(mockLocalUpdate).toHaveBeenCalledWith({
    id: 'activity-1',
    targetRequirement: { contexts: ['worktree'] },
  });
  expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
    automation: { version: 3, targetRequirement: { contexts: ['worktree'] } },
  });
});

it('blocks v3 publication when the server does not advertise target requirements', async () => {
  Object.assign(window.api, {
    loadCanopyCloudAccount: jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'user-1' },
      capabilities: ['automations-crud-v1'],
    }),
  });
  await renderModal(false);
  await waitFor(() => {
    expandAdvanced();
    return (
      document.querySelector(
        '[data-testid="share-automation-target-cowork"]',
      ) !== null
    );
  });
  act(() => detailsElement('share-automation-target-cowork').click());
  await waitFor(
    () =>
      document.querySelector('[data-testid="share-automation-submit"]') ===
      null,
  );
  expect(
    document.querySelector('[data-testid="share-automation-submit"]'),
  ).toBeNull();
  expect(mockCreate).not.toHaveBeenCalled();
});

const PROJECT_FOLDER_ACTION: ScheduledActivity['action'] = {
  type: 'worktree_pipeline',
  workspaceId: 'workspace-1',
  target: { kind: 'project' },
  pipelineId: 'code-review',
  pipelineSource: 'bundled',
  inputs: {},
};

it('offers no narrowing for a pipeline with no project and says where it runs', async () => {
  Object.assign(window.api, {
    loadCanopyCloudAccount: jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'user-1' },
      capabilities: [
        'automations-crud-v1',
        'automations-target-requirements-v3',
        'automations-pipeline-targets-v6',
      ],
    }),
  });
  mockGetPipeline.mockResolvedValue({
    success: true,
    data: {
      info: { id: 'code-review', name: 'Code review', source: 'bundled' },
      content: {
        name: 'Code review',
        on: 'dispatch',
        scope: ['global', 'directory', 'worktree'],
        jobs: {},
      },
    },
  });
  await renderModal(false, {
    type: 'worktree_pipeline',
    target: { kind: 'global' },
    pipelineId: 'code-review',
    pipelineSource: 'bundled',
    inputs: {},
  });
  await waitFor(() => {
    expandAdvanced();
    return (
      document.querySelector(
        '[data-testid="automation-summary-destination"]',
      ) !== null
    );
  });

  expect(
    document.querySelector('[data-testid="share-automation-target-narrowing"]'),
  ).toBeNull();
  expect(detailsElement('automation-summary-destination').textContent).toBe(
    'Runs with no project.',
  );
});

it('blocks v5 publication when the server advertises only target requirements', async () => {
  await renderModal(false, PROJECT_FOLDER_ACTION);
  await waitFor(
    () =>
      document.querySelector('[data-testid="share-automation-submit"]') ===
      null,
  );
  expect(
    document.querySelector('[data-testid="share-automation-submit"]'),
  ).toBeNull();
  expect(mockCreate).not.toHaveBeenCalled();
});

it('blocks v5 publication when the server advertises only run conditions', async () => {
  Object.assign(window.api, {
    loadCanopyCloudAccount: jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'user-1' },
      capabilities: [
        'automations-crud-v1',
        'automations-target-requirements-v3',
        'automations-run-condition-v4',
      ],
    }),
  });
  await renderModal(false, PROJECT_FOLDER_ACTION);
  await waitFor(
    () =>
      document.querySelector('[data-testid="share-automation-submit"]') ===
      null,
  );
  expect(
    document.querySelector('[data-testid="share-automation-submit"]'),
  ).toBeNull();
  expect(mockCreate).not.toHaveBeenCalled();
});

it('publishes a pipeline destination as v6 when the server advertises it', async () => {
  Object.assign(window.api, {
    loadCanopyCloudAccount: jest.fn().mockResolvedValue({
      hasApiKey: true,
      account: { id: 'user-1' },
      capabilities: [
        'automations-crud-v1',
        'automations-target-requirements-v3',
        'automations-pipeline-targets-v6',
      ],
    }),
  });
  await renderModal(false, PROJECT_FOLDER_ACTION);
  await submit();
  expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
    automation: {
      version: 6,
      action: { type: 'worktree_pipeline', target: { kind: 'project' } },
    },
  });
});

it('honors an explicitly cleared local declaration when re-sharing an edited App Advisor prompt', async () => {
  const remote = pipelineDetail();
  remote.automation.version = 3;
  remote.automation.targetRequirement = { contexts: ['worktree'] };
  mockGet.mockResolvedValue(remote);
  await renderModal(
    true,
    { type: 'app_advisor_prompt', prompt: 'Review today.' },
    { targetRequirementCleared: true },
  );
  expect(
    document.querySelector('[data-testid="share-automation-blockers"]'),
  ).toBeNull();
  await submit();
  const outgoing = mockUpdate.mock.calls[0]?.[0];
  expect(outgoing).toMatchObject({
    automation: { action: { type: 'app_advisor_prompt' } },
  });
  expect(outgoing).not.toHaveProperty('automation.targetRequirement');
  expect(outgoing).not.toHaveProperty('automation.targetRequirementCleared');
});

it('retains a remote narrowing for a legacy local record without an explicit clear', async () => {
  const remote = pipelineDetail();
  remote.automation.version = 3;
  remote.automation.targetRequirement = { contexts: ['worktree'] };
  mockGet.mockResolvedValue(remote);
  await renderModal(true);
  await submit();
  expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
    automation: { targetRequirement: { contexts: ['worktree'] } },
  });
});

// CAN-3959: the author can carry the run-condition command into the share,
// reviewed under Advanced; unchecking keeps today's strip behavior.
const GATED_COMMAND = 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 ./check.sh';
const LOCAL_FILE_COMMAND = 'test -f ~/.config/capacity-ok';
const GATED_PROMPT_ACTION: ScheduledActivity['action'] = {
  type: 'app_advisor_prompt',
  prompt: 'Review today.',
};

function runConditionToggleText(): string {
  return byTestId(ADVANCED_TOGGLE).textContent ?? '';
}

describe('run-condition command', (): void => {
  it('keeps a likely secret off by default until the author opts in', async (): Promise<void> => {
    await renderModal(false, GATED_PROMPT_ACTION, {
      ifCommand: `  ${GATED_COMMAND}\n`,
    });

    expect(runConditionToggleText()).toBe(
      'More details · May contain a secret, kept private',
    );
    expect(previewText()).not.toContain('"version": 4');
    expect(previewText()).not.toContain('ghp_');

    expandAdvanced();
    const include = byTestId('share-automation-include-run-condition');
    expect(include).toBeInstanceOf(HTMLInputElement);
    expect((include as HTMLInputElement).checked).toBe(false);
    expect((include as HTMLInputElement).disabled).toBe(false);
    expect(
      byTestId('share-automation-run-condition-secret-off').textContent,
    ).toBe("The command may contain a secret, so it's off by default.");
    await click('share-automation-include-run-condition');

    expect(
      document.querySelector(
        '[data-testid="share-automation-run-condition-secret-off"]',
      ),
    ).toBeNull();
    expect(previewText()).toContain('"version": 4');
    expect(previewText()).toContain(GATED_COMMAND);
    expect(
      document.querySelector('[data-testid="share-automation-notices"]')
        ?.textContent ?? '',
    ).not.toContain('run-condition command stays on this machine');
    const command = byTestId('share-automation-run-condition-command');
    expect(command.textContent).toBe(GATED_COMMAND);
    expect(command.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    const warnings =
      byTestId('share-automation-run-condition-warnings').textContent ?? '';
    expect(warnings).toContain('The command may contain a secret.');
    expect(warnings).toContain('The command references a local file');
    expect(
      previewElement()
        .querySelector('pre')
        ?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(true);

    await submit();
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      automation: {
        version: 4,
        hasRunCondition: true,
        runCondition: { command: GATED_COMMAND },
      },
    });
  });

  it('includes a command without a likely secret by default', async (): Promise<void> => {
    await renderModal(false, GATED_PROMPT_ACTION, {
      ifCommand: LOCAL_FILE_COMMAND,
    });

    expect(runConditionToggleText()).toBe(
      'More details · References a local file',
    );
    expect(previewText()).toContain('"version": 4');
    expandAdvanced();
    const include = byTestId('share-automation-include-run-condition');
    expect((include as HTMLInputElement).checked).toBe(true);
    expect(
      document.querySelector(
        '[data-testid="share-automation-run-condition-secret-off"]',
      ),
    ).toBeNull();
  });

  it('strips the command and says so when the author unchecks it', async (): Promise<void> => {
    await renderModal(false, GATED_PROMPT_ACTION, {
      ifCommand: LOCAL_FILE_COMMAND,
    });
    expandAdvanced();
    await click('share-automation-include-run-condition');

    expect(
      document.querySelector(
        '[data-testid="share-automation-run-condition-warnings"]',
      ),
    ).toBeNull();
    expect(previewText()).not.toContain('"version": 4');
    expect(previewText()).not.toContain('capacity-ok');
    expect(detailsElement('share-automation-notices').textContent).toContain(
      'The run-condition command stays on this machine',
    );
    await click(ADVANCED_TOGGLE);
    expect(runConditionToggleText()).toBe(
      'More details · Run condition kept private',
    );

    await submit();
    const outgoing = mockCreate.mock.calls[0]?.[0];
    expect(outgoing).toMatchObject({ automation: { hasRunCondition: true } });
    expect(outgoing).not.toHaveProperty('automation.runCondition');
    expect(JSON.stringify(outgoing)).not.toContain('capacity-ok');
  });

  it('shows a bare Advanced row for a command without warnings', async (): Promise<void> => {
    await renderModal(false, GATED_PROMPT_ACTION, { ifCommand: 'exit 0' });

    expect(runConditionToggleText()).toBe('More details');
  });

  it('groups where it runs, what stays private, the checkbox and the document under More details', async (): Promise<void> => {
    await renderModal(false, GATED_PROMPT_ACTION, {
      ifCommand: LOCAL_FILE_COMMAND,
    });

    expect(
      document.querySelectorAll('[data-testid="share-automation-advanced"]'),
    ).toHaveLength(1);
    expect(document.querySelector('details')).toBeNull();
    for (const id of [
      'automation-summary-runs-in',
      'share-automation-notices',
      'share-automation-preview',
    ]) {
      expect(document.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }
    await click(ADVANCED_TOGGLE);
    // Uncheck so the run condition joins the kept-private notice.
    await click('share-automation-include-run-condition');
    const body = byTestId('share-automation-advanced-body');
    const ordered = [
      'automation-summary-runs-in',
      'share-automation-notices',
      'share-automation-run-condition',
      'share-automation-preview',
    ].map(byTestId);
    for (const element of ordered) expect(body.contains(element)).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING === 4.
    ordered.slice(1).forEach((element, index) => {
      expect(ordered[index]?.compareDocumentPosition(element)).toBe(4);
    });
  });

  it('renders nothing new for an ungated automation', async (): Promise<void> => {
    await renderModal(false, GATED_PROMPT_ACTION, { ifCommand: '   ' });

    expect(runConditionToggleText()).toBe('More details');
    expect(
      document.querySelector('[data-testid="share-automation-run-condition"]'),
    ).toBeNull();
    expect(previewText()).not.toContain('"version": 4');
    expect(previewText()).not.toContain('runCondition');
  });

  it('keeps the command private when the server lacks the v4 capability', async (): Promise<void> => {
    Object.assign(window.api, {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        account: { id: 'user-1' },
        capabilities: [
          'automations-crud-v1',
          'automations-target-requirements-v3',
        ],
      }),
    });
    await renderModal(false, GATED_PROMPT_ACTION, {
      ifCommand: LOCAL_FILE_COMMAND,
    });
    await waitFor(
      () =>
        document.querySelector(`[data-testid="${ADVANCED_TOGGLE}"]`)
          ?.textContent === 'More details · Run condition kept private',
    );

    expect(runConditionToggleText()).toBe(
      'More details · Run condition kept private',
    );
    expandAdvanced();
    const include = byTestId('share-automation-include-run-condition');
    expect(include).toBeInstanceOf(HTMLInputElement);
    expect((include as HTMLInputElement).checked).toBe(false);
    expect((include as HTMLInputElement).disabled).toBe(true);
    expect(
      byTestId('share-automation-run-condition-unsupported').textContent,
    ).toContain('can’t receive run-condition commands');

    await submit();
    const outgoing = mockCreate.mock.calls[0]?.[0];
    expect(outgoing).toMatchObject({ automation: { hasRunCondition: true } });
    expect(outgoing).not.toHaveProperty('automation.runCondition');
  });

  it('keeps the command private when its own account read fails', async (): Promise<void> => {
    // The dialog's own read succeeds; only the capability read fails.
    const accountState = jest
      .spyOn(accountStateModule, 'useCanopyCloudAccountState')
      .mockReturnValue({ account: null, readError: true });
    await renderModal(false, GATED_PROMPT_ACTION, {
      ifCommand: LOCAL_FILE_COMMAND,
    });

    expect(previewText()).not.toContain('"version": 4');
    expandAdvanced();
    const include = byTestId('share-automation-include-run-condition');
    expect((include as HTMLInputElement).disabled).toBe(true);
    expect(
      document.querySelector(
        '[data-testid="share-automation-run-condition-unsupported"]',
      ),
    ).toBeNull();
    accountState.mockRestore();
  });

  it('keeps a command with hidden characters private and says why', async (): Promise<void> => {
    await renderModal(false, GATED_PROMPT_ACTION, {
      ifCommand: 'exit\u200B 0',
    });

    expect(runConditionToggleText()).toBe(
      'More details · Run condition kept private',
    );
    expandAdvanced();
    const include = byTestId('share-automation-include-run-condition');
    expect(include).toBeInstanceOf(HTMLInputElement);
    expect((include as HTMLInputElement).checked).toBe(false);
    expect((include as HTMLInputElement).disabled).toBe(true);
    expect(
      byTestId('share-automation-run-condition-hidden-characters').textContent,
    ).toBe("This command has hidden characters, so it can't be shared.");
    expect(previewText()).not.toContain('"version": 4');

    await submit();
    const outgoing = mockCreate.mock.calls[0]?.[0];
    expect(outgoing).toMatchObject({ automation: { hasRunCondition: true } });
    expect(outgoing).not.toHaveProperty('automation.runCondition');
  });

  it('keeps the command in the document rebuilt after packaging', async (): Promise<void> => {
    arrangeLocalCapabilityPackage();
    await renderModal(false, LOCAL_CAPABILITY_PROMPT_ACTION, {
      ifCommand: 'exit 0',
    });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await submit();
    expect(mockCommitPackage).toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      automation: {
        version: 4,
        capabilityPackage: { version: 1 },
        runCondition: { command: 'exit 0' },
      },
    });
  });
});
