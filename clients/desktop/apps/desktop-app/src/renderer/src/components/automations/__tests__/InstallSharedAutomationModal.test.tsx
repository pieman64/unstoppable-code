/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention;
 * @testing-library/react is not installed.
 */
import { act, createElement } from 'react';
// eslint-disable-next-line no-restricted-imports -- jsdom has no SubtleCrypto; the bundled-pipeline hash needs one.
import { createHash, webcrypto } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';

// eslint-disable-next-line no-restricted-imports -- jsdom needs this test-only TextEncoder polyfill.
import { TextEncoder } from 'node:util';

Object.assign(globalThis, { TextEncoder });
// jsdom defines `crypto` as a getter-only accessor, so `Object.assign` is a
// silent no-op here.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
});
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import { CHAT_LABEL } from '@canopy/protocol';
import type {
  AutomationCreateRequest,
  AutomationUpdateRequest,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES } from '@canopy/desktop-shared/lib/automations';
import { AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE } from '@canopy/desktop-shared/lib/automation-install';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import type { UnifiedTableRow } from '@/hooks/useUnifiedTableData';
import { serializePipelineDocument } from '@/lib/pipelineDocument';
import { useProjectsStore } from '@/stores/projectsStore';

const mockCreate = jest.fn<Promise<unknown>, [AutomationCreateRequest]>();
const mockUpdate = jest.fn<Promise<unknown>, [AutomationUpdateRequest]>();
const mockListPipelines = jest.fn<Promise<unknown>, []>();
const mockVerifyPin = jest.fn<Promise<unknown>, [unknown]>();
const mockReadiness = jest.fn<Promise<unknown>, [unknown]>();
const mockInstallPackage = jest.fn<Promise<unknown>, [unknown]>();
const mockDelete = jest.fn<Promise<unknown>, [unknown]>();
const mockSavePipeline = jest.fn<Promise<unknown>, [unknown]>();
const mockDeletePipeline = jest.fn<Promise<unknown>, [string]>();
const SHARED_RAW = 'name: Shared\non: dispatch\njobs: {}\n';
const SHARED_HASH = createHash('sha256').update(SHARED_RAW).digest('hex');
const mockResolveSharedPin = jest.fn();
const mockLoadProjects = jest.fn();
const mockCreationContext = jest.fn();
const mockGetPipeline = jest.fn<Promise<unknown>, [unknown]>();
let mockRows: UnifiedTableRow[] = [];

jest.mock('@/hooks/useUnifiedTableData', () => ({
  useUnifiedTableData: (): { rows: unknown[]; loading: boolean } => ({
    rows: mockRows,
    loading: false,
  }),
}));

import {
  InstallSharedAutomationModal,
  type InstallAutomationSource,
} from '../InstallSharedAutomationModal';

let root: Root | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [];
  mockCreationContext.mockReset();
  mockCreationContext.mockResolvedValue({
    context: { kind: 'personal' },
    revision: 0,
    organizations: [],
  });
  mockLoadProjects.mockResolvedValue({
    items: [
      { id: 'workspace-1', type: 'single-repo' },
      { id: 'cowork-1', type: 'cowork' },
    ],
  });
  mockResolveSharedPin.mockResolvedValue({
    rawPipeline: SHARED_RAW,
    installPin: {
      pipelineContentHash: SHARED_HASH,
      distributionMode: 'definition_only',
    },
  });
  mockCreate.mockResolvedValue({ ok: true, activity: { id: 'installed' } });
  mockUpdate.mockResolvedValue({ ok: true, activity: { id: 'installed' } });
  mockListPipelines.mockResolvedValue({ success: true, data: [] });
  mockVerifyPin.mockResolvedValue({
    pipelineContentHash: SHARED_HASH,
    distributionMode: 'definition_only',
  });
  mockReadiness.mockResolvedValue({ status: 'ready', requirements: [] });
  mockInstallPackage.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue({ ok: true });
  mockDone.mockClear();
  mockSavePipeline.mockResolvedValue({
    success: true,
    data: { id: 'local-pipeline-1' },
  });
  mockDeletePipeline.mockResolvedValue({ success: true });
  mockGetPipeline.mockResolvedValue({
    success: true,
    data: {
      info: {
        id: 'recorded-pipeline',
        name: 'Previous bundled review',
        description: 'Previous description',
        icon: 'archive',
        source: 'user',
      },
      content: {
        name: 'Previous bundled review',
        on: 'dispatch',
        jobs: { previous: { steps: [] } },
      },
    },
  });
  Object.assign(window, {
    api: {
      loadProjects: mockLoadProjects,
      workspaceContext: { get: mockCreationContext },
      chatProject: {
        getOrgDefaultCoworkEligibility: jest.fn().mockResolvedValue('eligible'),
      },
      orgProjects: {
        getMemberCodeEligibility: jest.fn().mockResolvedValue('ineligible'),
      },
      automations: {
        create: mockCreate,
        update: mockUpdate,
        verifySharedPipelineInstallPin: mockVerifyPin,
        resolveSharedPipelineInstallPin: mockResolveSharedPin,
        getCapabilityPackageReadiness: mockReadiness,
        installCapabilityPackage: mockInstallPackage,
        delete: mockDelete,
      },
    },
    pipelines: {
      list: mockListPipelines,
      get: mockGetPipeline,
      save: mockSavePipeline,
      delete: mockDeletePipeline,
    },
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setValue(element: HTMLElement | null, value: string): void {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error('expected form control');
  }
  // React reads the value through the native setter; assign via the
  // prototype so the synthetic change event observes the new value.
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(element, value);
  act(() => {
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/**
 * The values a shared `Select` offers, read by opening and closing its menu.
 * A disabled trigger throws instead of reading as empty, so a test cannot
 * pass vacuously; check `selectDisabled` for that case.
 */
function optionValues(testId: string): string[] {
  const trigger = byTestId(testId);
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`Expected the ${testId} dropdown`);
  }
  if (trigger.disabled) {
    throw new Error(`The ${testId} dropdown is disabled`);
  }
  act(() => trigger.click());
  const values = Array.from(
    document.querySelectorAll('[role="option"]'),
    (option) => option.getAttribute('data-value') ?? '',
  );
  act(() => trigger.click());
  return values;
}

/** Whether a shared `Select` trigger is disabled (offers nothing to pick). */
function selectDisabled(testId: string): boolean {
  const trigger = byTestId(testId);
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`Expected the ${testId} dropdown`);
  }
  return trigger.disabled;
}

/**
 * Asserts that a shared `Select` offers no project: it is disabled and holds
 * no choice. A disabled dropdown never opens (a browser sends no keys to a
 * disabled button, and `Select` closes when disabled), so its would-be options
 * are not read here; the enabled paths check what each picker offers.
 */
function expectNoProjectOffered(testId: string): void {
  expect(selectDisabled(testId)).toBe(true);
  const trigger = byTestId(testId);
  expect(trigger?.getAttribute('data-value')).toBeNull();
  expect(trigger?.getAttribute('aria-expanded')).not.toBe('true');
}

/** Opens a shared `Select` and chooses the option whose value is `value`. */
function chooseOption(testId: string, value: string): void {
  const trigger = byTestId(testId);
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`Missing dropdown ${testId}`);
  }
  act(() => trigger.click());
  const option = document.querySelector<HTMLElement>(
    `[role="option"][data-value="${value}"]`,
  );
  if (!option) throw new Error(`Missing option ${value} in ${testId}`);
  act(() => option.click());
}

function pipelineDetail(): SharedAutomationDetail {
  return {
    id: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
    name: 'Nightly review pipeline',
    description: '',
    triggerKind: 'cron',
    actionType: 'worktree_pipeline',
    contentHash: 'a'.repeat(64),
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Alex', email: null },
    canUpdate: false,
    canDelete: false,
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

function sharedPipelineDetail(installPin: {
  pipelineContentHash: string;
  distributionMode: 'package' | 'definition_only';
  packageDigest?: string;
}): SharedAutomationDetail {
  const base = pipelineDetail();
  return {
    ...base,
    automation: {
      ...base.automation,
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: {
          source: 'shared',
          remoteId: '5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
          name: 'Team review',
          installPin,
        },
        inputKeys: [],
      },
    },
  };
}

function unresolvedPipelineDetail(): SharedAutomationDetail {
  const base = pipelineDetail();
  return {
    ...base,
    automation: {
      ...base.automation,
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: { source: 'unresolved', name: 'Nightly review' },
        inputKeys: [],
      },
    },
  };
}

function coworkPromptDetail(): SharedAutomationDetail {
  const base = pipelineDetail();
  return {
    ...base,
    actionType: 'standalone_prompt',
    automation: {
      ...base.automation,
      action: {
        type: 'standalone_prompt',
        target: { kind: 'cowork' },
        prompt: 'Summarize today',
        plugins: [],
      },
    },
  };
}

function packagedPromptDetail(): SharedAutomationDetail {
  const base = coworkPromptDetail();
  return {
    ...base,
    automation: {
      ...base.automation,
      capabilityPackage: {
        version: 1,
        digest: `pp:v1:${'A'.repeat(43)}`,
      },
    },
  };
}

const mockDone = jest.fn<void, [string | undefined, string | undefined]>();

function renderModal(
  staleActivities?: ScheduledActivity[],
  detail: SharedAutomationDetail = pipelineDetail(),
  workspaces: Array<{
    id: string;
    name: string;
    type: 'single-repo' | 'multi-repo' | 'cowork';
    lacksProjectFolder?: boolean;
  }> = [{ id: 'workspace-1', name: 'Canopy', type: 'single-repo' }],
  publicShare = false,
  source?: InstallAutomationSource,
  options: {
    readonly leaveDisabled?: boolean;
    readonly onSubmittingChange?: (submitting: boolean) => void;
  } = {},
): void {
  mockLoadProjects.mockResolvedValue({
    items: workspaces.map((project) => ({ ...project, repoPath: '/repo' })),
  });
  root = createRoot(document.body);
  act(() => {
    root?.render(
      createElement(InstallSharedAutomationModal, {
        detail,
        staleActivities,
        workspaces,
        ...(publicShare ? { publicShare: true } : {}),
        ...(source ? { source } : {}),
        ...(options.leaveDisabled ? { leaveDisabled: true } : {}),
        ...(options.onSubmittingChange
          ? { onSubmittingChange: options.onSubmittingChange }
          : {}),
        onClose: (): void => {},
        onDone: mockDone,
      }),
    );
  });
}

/** Let the pipeline-catalog and pin-verification effects settle. */
async function flush(): Promise<void> {
  await act(async () => {
    // `hashPipelineDocumentYaml` awaits a real `SubtleCrypto.digest`, which
    // needs more than a couple of microtask ticks to settle.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function waitForTestId(
  testId: string,
  timeoutMs = 2_000,
): Promise<HTMLElement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = byTestId(testId);
    if (element !== null) return element;
    // Web Crypto resolves outside the JavaScript microtask queue. Yield to
    // the event loop so React can render the effect result under CI load.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for data-testid="${testId}"`);
}

/**
 * Choose a project once compatible targets have resolved (CAN-3734): the
 * picker deliberately offers no options while pipeline scopes are checked.
 */
async function waitForSubmitEnabled(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    Date.now() < deadline &&
    byTestId('install-automation-submit')?.hasAttribute('disabled') !== false
  ) {
    // Web Crypto resolves outside the JavaScript microtask queue.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitForTargets(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    Date.now() < deadline &&
    byTestId('install-automation-target-checking') !== null
  ) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function selectTarget(testId: string, value: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (
      byTestId('install-automation-target-checking') === null &&
      !selectDisabled(testId) &&
      optionValues(testId).includes(value)
    ) {
      break;
    }
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  chooseOption(testId, value);
}

async function submit(): Promise<void> {
  const readyDeadline = Date.now() + 4_000;
  while (Date.now() < readyDeadline) {
    const button = byTestId('install-automation-submit');
    if (button !== null && !button.hasAttribute('disabled')) break;
    // Inline pipeline verification uses Web Crypto, which resolves outside
    // the microtask queue. Wait for React to enable the button before the
    // click; clicking a disabled button is intentionally a no-op.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  const button = byTestId('install-automation-submit');
  if (button === null || button.hasAttribute('disabled')) {
    throw new Error('Timed out waiting for automation submission to be ready');
  }
  act(() => {
    button.click();
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const error = byTestId('install-automation-error');
    if (mockDone.mock.calls.length > 0 || (error?.textContent ?? '') !== '') {
      return;
    }
    // Submission may await Web Crypto, which resolves outside the JavaScript
    // microtask queue. Yield to the event loop so the full handler, including
    // any rollback, finishes before this test releases its mocks to the next.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Timed out waiting for automation submission to finish');
}

describe('InstallSharedAutomationModal', () => {
  it('installs a copy with attached file references without a confirmation checkbox (CAN-3710)', async () => {
    const base = coworkPromptDetail();
    renderModal(
      undefined,
      {
        ...base,
        automation: {
          ...base.automation,
          version: 2,
          action: {
            type: 'standalone_prompt',
            target: { kind: 'cowork' },
            prompt: 'Read README.md',
            plugins: [],
            promptReferences: [
              {
                kind: 'file',
                textStart: 5,
                displayText: 'README.md',
                root: { kind: 'workspace' },
                relativePath: '.env',
              },
            ],
          },
        },
      },
      [{ id: 'cowork-1', name: 'Research', type: 'cowork' }],
    );
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    // Clicking Install is the confirmation: no file list or opt-in gates it.
    expect(byTestId('install-automation-file-references')).toBeNull();
    expect(byTestId('install-automation-confirm-files')).toBeNull();
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('installs a copy with provenance and turns it on after binding a project and inputs', async () => {
    renderModal();

    // Submit stays disabled until a workspace is bound.
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);

    await selectTarget('install-automation-workspace', 'workspace-1');
    setValue(byTestId('install-automation-input-branch'), 'develop');
    await submit();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Assert on the captured request (typed `unknown` by the mock signature)
    // with plain literals — recursive subset matching without matcher casts.
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      name: 'Nightly review pipeline',
      enabled: false,
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop' },
      },
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'a'.repeat(64),
      },
    });
    // The copy is created off and turned on as the last step (CAN-3651).
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ id: 'installed', enabled: true });
    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
  });

  it('leaves a new copy off when asked to, so a duplicate never runs before it is reviewed (CAN-4072)', async () => {
    renderModal(undefined, pipelineDetail(), undefined, false, undefined, {
      leaveDisabled: true,
    });

    await selectTarget('install-automation-workspace', 'workspace-1');
    setValue(byTestId('install-automation-input-branch'), 'develop');
    await submit();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
    // No turn-on step: the copy stays exactly as it was created.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
  });

  it('reports the write as busy until it settles, so a newer share link waits (CAN-3710)', async () => {
    const reported: boolean[] = [];
    let busyDuringCreate: boolean | undefined;
    mockCreate.mockImplementationOnce(() => {
      busyDuringCreate = reported.at(-1);
      return Promise.resolve({ ok: true, activity: { id: 'installed' } });
    });
    renderModal(undefined, pipelineDetail(), undefined, false, undefined, {
      onSubmittingChange: (submitting) => {
        reported.push(submitting);
      },
    });

    await selectTarget('install-automation-workspace', 'workspace-1');
    setValue(byTestId('install-automation-input-branch'), 'develop');
    await submit();
    await flush();

    expect(busyDuringCreate).toBe(true);
    expect(reported).toEqual([true, false]);
    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
  });

  it('installs a shared-pipeline automation against a pin that verified', async () => {
    const installPin = {
      pipelineContentHash: SHARED_HASH,
      distributionMode: 'definition_only' as const,
    };
    renderModal(undefined, sharedPipelineDetail(installPin));
    await flush();

    expect(byTestId('install-automation-shared-pipeline-blocked')).toBeNull();
    await selectTarget('install-automation-workspace', 'workspace-1');
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);
    await submit();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const request = mockCreate.mock.calls[0]?.[0] as {
      action: {
        pipelineId: string;
        pipelineSource: string;
        sharedPipeline: {
          serverId: string;
          remoteId: string;
          installPin: typeof installPin;
        };
      };
    };
    expect(request.action).toEqual({
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'shared:canopy-cloud:5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
      pipelineSource: 'shared',
      pipelineName: 'Team review',
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: '5f6b0f5e-2f66-4be4-9f8e-1f0a54a1c222',
        installPin,
      },
    });
  });

  it('surfaces a pin that fails verification up front with Install disabled', async () => {
    mockVerifyPin.mockRejectedValue(
      new Error('The pinned version of "Team review" could not be verified.'),
    );
    renderModal(
      undefined,
      sharedPipelineDetail({
        pipelineContentHash: SHARED_HASH,
        distributionMode: 'definition_only',
      }),
    );
    await flush();

    expect(
      byTestId('install-automation-shared-pipeline-blocked')?.textContent,
    ).toContain('could not be verified');
    // An unverifiable pin leaves nothing to choose a project for.
    expect(
      byTestId('install-automation-workspace')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it("rebinds an unresolved pipeline ref to one of the recipient's own pipelines", async () => {
    mockListPipelines.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'my-review',
          name: 'My review',
          filename: 'my-review.yaml',
          description: '',
          icon: '',
          createdAt: '2026-08-19T00:00:00.000Z',
          updatedAt: '2026-08-19T00:00:00.000Z',
          source: 'user',
          readonly: false,
        },
      ],
    });
    renderModal(undefined, unresolvedPipelineDetail());
    await flush();

    const picker = byTestId('install-automation-pipeline');
    expect(picker).not.toBeNull();
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);

    chooseOption('install-automation-pipeline', 'my-review');
    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const request = mockCreate.mock.calls[0]?.[0] as {
      action: { pipelineId: string; pipelineSource: string };
    };
    expect(request.action.pipelineId).toBe('my-review');
    expect(request.action.pipelineSource).toBe('user');
  });

  it('binds a Cowork project for a portable standalone prompt', async () => {
    renderModal(undefined, coworkPromptDetail(), [
      { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();

    expect(byTestId('install-automation-workspace')).toBeNull();
    const picker = byTestId('install-automation-cowork-project');
    expect(picker).not.toBeNull();
    expect(optionValues('install-automation-cowork-project')).toHaveLength(1);

    chooseOption('install-automation-cowork-project', 'cowork-1');
    await submit();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const request = mockCreate.mock.calls[0]?.[0] as {
      action: { type: string; chatProjectId: string };
    };
    expect(request.action.type).toBe('standalone_prompt');
    expect(request.action.chatProjectId).toBe('cowork-1');
  });

  it('keeps the update review light, with no enabled-state note (CAN-3710)', () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-disabled',
      name: 'Nightly review pipeline',
      enabled: false,
      // Identical trigger to the document — the note must not claim the
      // schedule changed just because the copy was already disabled.
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop' },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    renderModal([existing]);

    expect(byTestId('install-automation-note')).toBeNull();
    expect(byTestId('install-automation-submit')?.textContent).toBe(
      'Apply update',
    );
  });

  it('blocks submission when the retained project binding is no longer eligible', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-stale-workspace',
      name: 'Nightly review pipeline',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        // Bound to a workspace that has since been deleted (absent from the
        // selectable options), so submission must stay disabled until a
        // valid replacement is chosen.
        workspaceId: 'workspace-deleted',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop' },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    renderModal([existing]);

    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);

    await selectTarget('install-automation-workspace', 'workspace-1');
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('resolves plugin and claude_plugin discriminators as equivalent refs', async () => {
    // Local catalog rows carry one discriminator; the document carries the
    // other. Both directions must resolve (mirrors the main-process
    // matchShareablePluginRef fallback between the two forms).
    mockRows = [
      {
        rowOrigin: 'pipeline-derived',
        viewDisabled: true,
        kind: 'plugin',
        key: 'acme-marketplace/browser',
        name: 'browser',
        description: '',
        source: 'https://github.com/acme/marketplace',
        sourceSubtitle: 'Acme',
        sourceIcon: 'repo',
        lastUpdated: '2026-08-01T00:00:00.000Z',
        shareableRef: {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/marketplace' },
          plugin_name: 'browser',
        },
      },
      {
        rowOrigin: 'pipeline-derived',
        viewDisabled: true,
        kind: 'plugin',
        key: 'builtin-app/navigator',
        name: 'navigator',
        description: '',
        source: '',
        sourceSubtitle: 'App',
        sourceIcon: 'app',
        lastUpdated: '2026-08-01T00:00:00.000Z',
        shareableRef: {
          type: 'plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'navigator',
        },
      },
    ];
    const detail: SharedAutomationDetail = {
      ...pipelineDetail(),
      actionType: 'worktree_prompt',
      automation: {
        version: 1,
        name: 'Nightly review pipeline',
        description: '',
        trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
        action: {
          type: 'worktree_prompt',
          target: { kind: 'workspace' },
          prompt: 'Review the queue.',
          plugins: [
            {
              type: 'plugin',
              marketplace: { type: 'github', repo: 'acme/marketplace' },
              plugin_name: 'browser',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'builtin', id: 'app' },
              plugin_name: 'navigator',
            },
          ],
        },
        hasRunCondition: false,
      },
    };
    renderModal(undefined, detail);

    // Neither ref is reported missing despite the discriminator mismatch.
    expect(byTestId('install-automation-plugins-blocked')).toBeNull();

    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      action: {
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'acme-marketplace', pluginName: 'browser' },
            { marketplaceId: 'builtin-app', pluginName: 'navigator' },
          ],
        },
      },
    });
  });

  it('applies an update to an installed copy, preserving bindings and enabled state', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Nightly review pipeline',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop' },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    renderModal([existing]);
    await waitForTargets();

    // A single stale copy needs no disambiguation control.
    expect(byTestId('install-automation-copy')).toBeNull();
    // Bindings are prefilled from the installed copy, so submit is enabled.
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);

    await submit();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'activity-installed',
      enabled: true,
      installedFrom: {
        contentHash: 'a'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('lets the user pick which stale copy to update when several are installed', async () => {
    const copy = (id: string, name: string): ScheduledActivity => ({
      version: 1,
      id,
      name,
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop' },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    renderModal([
      copy('copy-first', 'First copy'),
      copy('copy-second', 'Second copy'),
    ]);

    // Both stale copies are offered; the first is preselected.
    const picker = byTestId('install-automation-copy');
    expect(picker?.getAttribute('data-value')).toBe('copy-first');
    expect(optionValues('install-automation-copy')).toHaveLength(2);

    // Choosing the second copy retargets the update — its id, not the
    // first match, must reach the update IPC.
    chooseOption('install-automation-copy', 'copy-second');
    await submit();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'copy-second',
      enabled: true,
    });
  });

  it('never names a project for a stale copy with no project', () => {
    const copy = (
      id: string,
      action: ScheduledActivity['action'],
    ): ScheduledActivity => ({
      version: 1,
      id,
      name: id,
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    const pipeline = {
      type: 'worktree_pipeline',
      pipelineId: 'code-review',
      pipelineSource: 'bundled',
      inputs: {},
    } as const;
    renderModal([
      copy('project-copy', { ...pipeline, workspaceId: 'workspace-1' }),
      // The inert `workspaceId` on a global action names no project.
      copy('global-copy', {
        ...pipeline,
        target: { kind: 'global' },
        workspaceId: 'workspace-1',
      }),
    ]);

    const trigger = byTestId('install-automation-copy');
    act(() => trigger?.click());
    const options = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).map((option) => option.textContent);
    act(() => trigger?.click());
    expect(options).toEqual(['project-copy — Canopy', 'global-copy']);
  });

  it('materializes packaged resources before completing install, without listing them (CAN-3710)', async () => {
    mockReadiness.mockResolvedValue({
      status: 'ready',
      requirements: [],
      includedResources: [
        {
          id: 'skill-1',
          displayName: 'Review skill',
          kind: 'standalone_skill',
        },
      ],
    });
    const installedActivity: ScheduledActivity = {
      version: 1,
      id: 'installed',
      name: packagedPromptDetail().name,
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Summarize today',
      },
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      failureCount: 0,
    };
    mockCreate.mockResolvedValueOnce({ ok: true, activity: installedActivity });
    renderModal(undefined, packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');

    expect(byTestId('install-automation-package-readiness')).toBeNull();
    expect(document.body.textContent).not.toContain('Review skill');
    await submit();

    expect(mockInstallPackage).toHaveBeenCalledWith({
      remoteId: packagedPromptDetail().id,
      localAutomationId: 'installed',
      packageRef: packagedPromptDetail().automation.capabilityPackage,
      localContentHash: createHash('sha256')
        .update(
          JSON.stringify({
            name: installedActivity.name,
            action: installedActivity.action,
          }),
        )
        .digest('hex'),
    });
  });

  it('installs packaged pipelines in main on Submit and points the prompt at the local copies', async () => {
    const authorId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const localId = '9b2c1d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
    const base = packagedPromptDetail();
    const detail: SharedAutomationDetail = {
      ...base,
      automation: {
        ...base.automation,
        version: 5,
        action: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: `Run ${authorId} today.`,
          plugins: [],
          pipelineDependencies: [
            {
              key: authorId,
              pipeline: {
                source: 'packaged',
                key: authorId,
                pipelineContentHash: 'c'.repeat(64),
                name: 'Journey specialist',
              },
              promptSpans: [{ textStart: 4, text: authorId }],
            },
          ],
        },
      },
    };
    mockInstallPackage.mockImplementation((request) => {
      const stage =
        typeof request === 'object' && request !== null && 'stage' in request
          ? request.stage
          : undefined;
      if (stage === 'pipelines-preview') {
        return Promise.resolve({
          pipelines: [
            {
              key: authorId,
              pipelineContentHash: 'c'.repeat(64),
              outcome: 'created',
              rewrites: false,
              rawPipeline: 'name: Journey specialist\n',
              assetChanges: [],
            },
          ],
        });
      }
      return Promise.resolve(
        stage === 'pipelines'
          ? {
              pipelines: [
                {
                  key: authorId,
                  localPipelineId: localId,
                  pipelineContentHash: 'c'.repeat(64),
                  outcome: 'created',
                },
              ],
            }
          : undefined,
      );
    });
    const installedActivity: ScheduledActivity = {
      version: 1,
      id: 'installed',
      name: detail.name,
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: `Run ${localId} today.`,
      },
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      failureCount: 0,
    };
    mockCreate.mockResolvedValueOnce({ ok: true, activity: installedActivity });
    renderModal(undefined, detail, [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();

    // The review reads Stage A's dry run; opening the dialog writes nothing,
    // so cancelling leaves no pipeline, install record or file behind.
    expect(mockInstallPackage).toHaveBeenCalledTimes(1);
    expect(mockInstallPackage).toHaveBeenCalledWith({
      stage: 'pipelines-preview',
      remoteId: detail.id,
      packageRef: detail.automation.capabilityPackage,
    });
    expect(
      byTestId(`install-automation-packaged-pipeline-${authorId}`)?.dataset
        .status,
    ).toBe('new');
    expect(
      byTestId('install-automation-packaged-pipelines')?.textContent,
    ).toContain('Journey specialist');

    await selectTarget('install-automation-cowork-project', 'cowork-1');
    expect(mockInstallPackage).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'pipelines' }),
    );
    await submit();

    expect(mockInstallPackage).toHaveBeenCalledWith({
      stage: 'pipelines',
      remoteId: detail.id,
      packageRef: detail.automation.capabilityPackage,
    });
    const created = mockCreate.mock.calls[0]?.[0];
    expect(created).toMatchObject({
      action: { prompt: `Run ${localId} today.` },
      installedFrom: {
        pipelineDependencies: [
          {
            key: authorId,
            localPipelineId: localId,
            pipelineContentHash: 'c'.repeat(64),
          },
        ],
      },
    });
    expect(mockInstallPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        localAutomationId: 'installed',
        packageRef: detail.automation.capabilityPackage,
      }),
    );
    expect(mockSavePipeline).not.toHaveBeenCalled();
  });

  it('previews an update of packaged pipelines: the new YAML, file changes, and a local edit refusal', async () => {
    const authorId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const localId = '9b2c1d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
    const base = packagedPromptDetail();
    const detail: SharedAutomationDetail = {
      ...base,
      automation: {
        ...base.automation,
        version: 5,
        action: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt: `Run ${authorId} today.`,
          plugins: [],
          pipelineDependencies: [
            {
              key: authorId,
              pipeline: {
                source: 'packaged',
                key: authorId,
                pipelineContentHash: 'd'.repeat(64),
                name: 'Journey specialist',
              },
              promptSpans: [{ textStart: 4, text: authorId }],
            },
          ],
        },
      },
    };
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: detail.name,
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: `Run ${localId} today.`,
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: detail.id,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
        capabilityPackage: { version: 1, digest: `pp:v1:${'B'.repeat(43)}` },
        pipelineDependencies: [
          {
            key: authorId,
            localPipelineId: localId,
            pipelineContentHash: 'c'.repeat(64),
          },
        ],
      },
    };
    const existingPipelines = [
      {
        key: authorId,
        localPipelineId: localId,
        expectedContentHash: 'c'.repeat(64),
      },
    ];
    mockInstallPackage.mockImplementation((request) =>
      Promise.resolve(
        typeof request === 'object' &&
          request !== null &&
          'stage' in request &&
          request.stage === 'pipelines-preview'
          ? {
              pipelines: [
                {
                  key: authorId,
                  localPipelineId: localId,
                  pipelineContentHash: 'd'.repeat(64),
                  outcome: 'reused',
                  rewrites: true,
                  rawPipeline: 'name: Journey specialist v2\n',
                  assetChanges: [
                    {
                      assetId: 'specialists',
                      installMode: 'replace',
                      added: [],
                      updated: [],
                      overwritten: ['mine.json'],
                      kept: [],
                    },
                  ],
                },
              ],
            }
          : undefined,
      ),
    );
    renderModal([existing], detail, [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();

    // The review reads Stage A's dry run; nothing is installed before Submit.
    expect(mockInstallPackage).toHaveBeenCalledTimes(1);
    expect(mockInstallPackage).toHaveBeenCalledWith({
      stage: 'pipelines-preview',
      remoteId: detail.id,
      packageRef: detail.automation.capabilityPackage,
      existingPipelines,
    });
    const row = byTestId(`install-automation-packaged-pipeline-${authorId}`);
    expect(row?.dataset.status).toBe('update');
    // The new YAML sits behind the row's closed review disclosure.
    const review = byTestId(
      `install-automation-packaged-pipeline-${authorId}-review`,
    );
    expect(review?.getAttribute('aria-expanded')).toBe('false');
    expect(
      byTestId(`install-automation-packaged-pipeline-${authorId}-yaml`),
    ).toBeNull();
    act(() => review?.click());
    expect(review?.getAttribute('aria-expanded')).toBe('true');
    expect(
      byTestId(`install-automation-packaged-pipeline-${authorId}-yaml`)
        ?.textContent,
    ).toBe('name: Journey specialist v2\n');
    expect(
      byTestId(`install-automation-packaged-pipeline-${authorId}-files`)
        ?.textContent,
    ).toContain('Overwrites 1 file you changed in “specialists”: mine.json');
    act(() => {
      root?.unmount();
    });
    root = null;

    // A local edit refuses the update in the review, before Submit.
    mockInstallPackage.mockReset();
    mockInstallPackage.mockRejectedValue(
      new Error(AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE),
    );
    renderModal([existing], detail, [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();
    expect(byTestId('install-automation-pipelines-blocked')?.textContent).toBe(
      AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE,
    );
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('removes a prior capability package when an update no longer requires one', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Packaged prompt',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Old prompt',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
        capabilityPackage: {
          version: 1,
          digest: `pp:v1:${'B'.repeat(43)}`,
        },
      },
    };
    mockUpdate.mockResolvedValue({ ok: true, activity: existing });
    renderModal([existing], coworkPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);

    await flush();
    await submit();
    await flush();

    expect(mockInstallPackage).toHaveBeenCalledWith({
      localAutomationId: 'activity-installed',
      remove: true,
    });
  });

  it('restores an existing automation when replacement package installation fails', async () => {
    const oldPackage = {
      version: 1 as const,
      digest: `pp:v1:${'B'.repeat(43)}`,
    };
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Old packaged prompt',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Old prompt',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
        capabilityPackage: oldPackage,
      },
    };
    mockUpdate.mockResolvedValue({ ok: true, activity: existing });
    mockInstallPackage.mockRejectedValueOnce(
      new Error('package install failed'),
    );
    renderModal([existing], packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);

    await flush();
    await submit();
    await flush();

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls[1]?.[0]).toEqual({
      id: existing.id,
      name: existing.name,
      schedule: existing.schedule,
      action: existing.action,
      enabled: existing.enabled,
      installedFrom: existing.installedFrom,
    });
    expect(byTestId('install-automation-error')?.textContent).toContain(
      'package install failed',
    );
  });

  it('keeps install disabled when a capability package cannot be verified', async () => {
    mockReadiness.mockRejectedValue(new Error('digest mismatch'));
    renderModal(undefined, packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');

    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      byTestId('install-automation-package-invalid')?.textContent,
    ).toContain('could not be verified');
  });
});

// ---------------------------------------------------------------------------
// CAN-4550: pipeline destinations.
// ---------------------------------------------------------------------------

function destinationDetail(
  kind: 'global' | 'task' | 'project' | 'new_worktree',
): SharedAutomationDetail {
  const base = pipelineDetail();
  return {
    ...base,
    automation: {
      ...base.automation,
      version: 6,
      action: {
        type: 'worktree_pipeline',
        target: { kind },
        pipeline: { source: 'bundled', pipelineId: 'code-review' },
        inputKeys: [],
      },
    },
  };
}

describe('InstallSharedAutomationModal pipeline destinations (CAN-4550)', () => {
  it('installs a pipeline with no project without a project picker', async () => {
    mockGetPipeline.mockResolvedValue({
      success: true,
      data: {
        info: { id: 'code-review', name: 'Review', source: 'bundled' },
        content: {
          name: 'Review',
          on: 'dispatch',
          scope: ['global'],
          jobs: {},
        },
      },
    });
    renderModal(undefined, destinationDetail('global'));
    await waitForTargets();
    expect(byTestId('install-automation-workspace')).toBeNull();
    expect(byTestId('install-automation-task')).toBeNull();
    await submit();

    const request = mockCreate.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineId: 'code-review',
      },
    });
    expect(request).not.toHaveProperty('action.workspaceId');
  });

  it("never prefills a project from a no-project copy's inert workspaceId", async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'global-copy',
      name: 'Global copy',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: {},
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'b'.repeat(64),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    renderModal([existing], destinationDetail('project'), [
      { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
      { id: 'workspace-2', name: 'Other', type: 'single-repo' },
    ]);
    await waitForTargets();

    const picker = byTestId('install-automation-workspace');
    expect(picker).not.toBeNull();
    expect(picker?.hasAttribute('data-value')).toBe(false);
  });

  it('offers no project without a folder for a project-folder destination', async () => {
    renderModal(undefined, destinationDetail('project'), [
      { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
      {
        id: 'multi-1',
        name: 'No root',
        type: 'multi-repo',
        lacksProjectFolder: true,
      },
    ]);
    await waitForTargets();

    expect(optionValues('install-automation-workspace')).toEqual([
      'workspace-1',
    ]);
  });

  it('asks for a task before installing an existing-task destination', async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'workspace-1',
          name: 'Canopy',
          type: 'single-repo',
          worktrees: [{ id: 'wt-1', branchName: 'feature' }],
        },
      ],
    } as unknown as Parameters<typeof useProjectsStore.setState>[0]);
    renderModal(undefined, destinationDetail('task'));
    await selectTarget('install-automation-workspace', 'workspace-1');
    await flush();

    const task = byTestId('install-automation-task');
    expect(task).toBeInstanceOf(HTMLButtonElement);
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(document.body.textContent).toContain(
      'Pick a task to run the workflow in.',
    );

    act(() => task?.click());
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((candidate) => candidate.textContent?.includes('feature'));
    act(() => option?.click());
    await submit();

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        target: { kind: 'task', taskId: 'wt-1' },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// CAN-3135: bundled (`inline`) pipeline + anonymous public installs.
// ---------------------------------------------------------------------------

const BUNDLED_YAML = [
  'pipeline:',
  '  name: Bundled review',
  '  on: manual',
  '  jobs:',
  '    review:',
  '      steps:',
  '        - name: Echo',
  '          run: echo hi',
  '',
].join('\n');

const PREVIOUS_BUNDLED_PIPELINE: Pipeline = {
  name: 'Previous bundled review',
  on: 'dispatch',
  jobs: { previous: { steps: [] } },
};

function bundledHash(): string {
  return createHash('sha256').update(BUNDLED_YAML).digest('hex');
}

function previousBundledHash(): string {
  return createHash('sha256')
    .update(serializePipelineDocument(PREVIOUS_BUNDLED_PIPELINE))
    .digest('hex');
}

function inlinePipelineDetail(
  overrides: {
    rawPipeline?: string;
    pipelineContentHash?: string;
    origin?: unknown;
  } = {},
): SharedAutomationDetail {
  const base = pipelineDetail();
  const rawPipeline = overrides.rawPipeline ?? BUNDLED_YAML;
  return {
    ...base,
    automation: {
      ...base.automation,
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'workspace' },
        pipeline: {
          source: 'inline',
          name: 'Bundled review',
          rawPipeline,
          pipelineContentHash:
            overrides.pipelineContentHash ??
            createHash('sha256').update(rawPipeline).digest('hex'),
          ...(overrides.origin !== undefined
            ? { origin: overrides.origin }
            : {}),
        },
        inputKeys: [],
      },
    },
  } as SharedAutomationDetail;
}

describe('InstallSharedAutomationModal bundled pipeline (CAN-3135)', () => {
  it('passes the pinned YAML bytes verbatim to the local pipeline store', async () => {
    const rawPipeline =
      '# keep this publisher comment\npipeline: {name: Bundled review, on: dispatch, jobs: {review: {steps: []}}}\n';
    renderModal(
      undefined,
      inlinePipelineDetail({ rawPipeline }),
      undefined,
      true,
    );
    await flush();

    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(mockSavePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ rawContent: rawPipeline }),
    );
  });

  it('reads a packaged action pipeline from the preview and saves it only on Submit', async () => {
    const localId = '9b2c1d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
    const pipelineContentHash = createHash('sha256')
      .update(BUNDLED_YAML)
      .digest('hex');
    const base = inlinePipelineDetail();
    const detail = {
      ...base,
      automation: {
        ...base.automation,
        version: 5,
        capabilityPackage: { version: 1, digest: `pp:v1:${'A'.repeat(43)}` },
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'workspace' },
          pipeline: {
            source: 'packaged',
            key: 'action',
            pipelineContentHash,
            name: 'Bundled review',
          },
          inputKeys: [],
        },
      },
    } as SharedAutomationDetail;
    mockInstallPackage.mockImplementation((request) => {
      const stage =
        typeof request === 'object' && request !== null && 'stage' in request
          ? request.stage
          : undefined;
      if (stage === 'pipelines-preview') {
        return Promise.resolve({
          pipelines: [
            {
              key: 'action',
              pipelineContentHash,
              outcome: 'created',
              rewrites: false,
              rawPipeline: BUNDLED_YAML,
              assetChanges: [],
            },
          ],
        });
      }
      return Promise.resolve(
        stage === 'pipelines'
          ? {
              pipelines: [
                {
                  key: 'action',
                  localPipelineId: localId,
                  pipelineContentHash,
                  outcome: 'created',
                },
              ],
            }
          : undefined,
      );
    });
    renderModal(undefined, detail, undefined, true);
    await flush();

    await selectTarget('install-automation-workspace', 'workspace-1');
    expect(mockInstallPackage).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'pipelines' }),
    );
    await submit();

    expect(mockInstallPackage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'pipelines' }),
    );
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      action: { pipelineId: localId },
    });
    expect(mockSavePipeline).not.toHaveBeenCalled();
  });

  it('verifies the bundled bytes locally and never calls the authenticated pin check', async () => {
    renderModal(undefined, inlinePipelineDetail(), undefined, true);
    await flush();

    await selectTarget('install-automation-workspace', 'workspace-1');
    // Install enables only after the component's real Web Crypto
    // verification resolves, which `flush`'s microtask ticks do not wait for.
    await waitForSubmitEnabled();

    expect(mockVerifyPin).not.toHaveBeenCalled();
    // CAN-3710: the review never shows the pipeline definition.
    expect(byTestId('install-automation-bundled-pipeline')).toBeNull();
    expect(byTestId('install-automation-shared-pipeline-blocked')).toBeNull();
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);
    await submit();
    await flush();
    expect(byTestId('install-automation-error')?.textContent ?? '').toBe('');

    // The local pipeline is materialized before the automation is created.
    expect(mockSavePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bundled review' }),
    );
    const request = mockCreate.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      action: { pipelineSource: 'user', pipelineId: 'local-pipeline-1' },
      installedFrom: { bundledPipelineLocalId: 'local-pipeline-1' },
    });
    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
  });

  it('rewrites the recorded bundled pipeline on update instead of creating an orphan', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'installed-automation',
      name: 'Nightly review pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'recorded-pipeline',
        pipelineSource: 'user',
      },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: inlinePipelineDetail().id,
        contentHash: '0'.repeat(64),
        installedAt: '2026-09-18T00:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'recorded-pipeline',
        bundledPipelineContentHash: previousBundledHash(),
      },
    };
    mockListPipelines.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'recorded-pipeline',
          name: 'Bundled review',
          description: '',
          icon: '',
          filename: 'recorded-pipeline.yaml',
          createdAt: '2026-09-18T00:00:00.000Z',
          updatedAt: '2026-09-18T00:00:00.000Z',
          source: 'user',
          readonly: false,
        },
      ],
    });
    mockSavePipeline.mockResolvedValue({
      success: true,
      data: { id: 'recorded-pipeline' },
    });
    renderModal([existing], inlinePipelineDetail(), undefined, true);
    await flush();

    await submit();

    expect(mockSavePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'recorded-pipeline' }),
    );
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'installed-automation',
      action: { pipelineId: 'recorded-pipeline' },
      installedFrom: {
        bundledPipelineLocalId: 'recorded-pipeline',
        bundledPipelineContentHash: bundledHash(),
      },
    });
  });

  it('does not overwrite a recipient-edited bundled pipeline on update', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'installed-automation',
      name: 'Nightly review pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'recorded-pipeline',
        pipelineSource: 'user',
      },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: inlinePipelineDetail().id,
        contentHash: '0'.repeat(64),
        installedAt: '2026-09-18T00:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'recorded-pipeline',
        bundledPipelineContentHash: 'f'.repeat(64),
      },
    };
    mockListPipelines.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'recorded-pipeline',
          name: 'Recipient edit',
          description: '',
          icon: '',
          filename: 'recorded-pipeline.yaml',
          createdAt: '2026-09-18T00:00:00.000Z',
          updatedAt: '2026-09-19T00:00:00.000Z',
          source: 'user',
          readonly: false,
        },
      ],
    });
    renderModal([existing], inlinePipelineDetail(), undefined, true);
    await flush();

    await submit();
    const error = await waitForTestId('install-automation-error');

    expect(mockSavePipeline).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(error.textContent).toContain('local changes');
  });

  it('blocks an update when the bundled-pipeline catalog cannot be read', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'installed-automation',
      name: 'Nightly review pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'recorded-pipeline',
        pipelineSource: 'user',
      },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: inlinePipelineDetail().id,
        contentHash: '0'.repeat(64),
        installedAt: '2026-09-18T00:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'recorded-pipeline',
        bundledPipelineContentHash: previousBundledHash(),
      },
    };
    mockListPipelines.mockResolvedValue({
      success: false,
      error: 'catalog temporarily unavailable',
    });
    renderModal([existing], inlinePipelineDetail(), undefined, true);
    await flush();

    await submit();

    expect(mockSavePipeline).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(byTestId('install-automation-error')?.textContent).toContain(
      'catalog temporarily unavailable',
    );
  });

  it('deletes a newly materialized pipeline when automation creation fails', async () => {
    mockCreate.mockResolvedValue({ ok: false, error: 'create failed' });
    renderModal(undefined, inlinePipelineDetail(), undefined, true);
    await flush();

    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(mockDeletePipeline).toHaveBeenCalledWith('local-pipeline-1');
    expect(byTestId('install-automation-error')?.textContent).toContain(
      'create failed',
    );
  });

  it('restores overwritten pipeline bytes when automation update fails', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'installed-automation',
      name: 'Nightly review pipeline',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'recorded-pipeline',
        pipelineSource: 'user',
      },
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: inlinePipelineDetail().id,
        contentHash: '0'.repeat(64),
        installedAt: '2026-09-18T00:00:00.000Z',
        sourceKind: 'public',
        bundledPipelineLocalId: 'recorded-pipeline',
        bundledPipelineContentHash: previousBundledHash(),
      },
    };
    mockListPipelines.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'recorded-pipeline',
          name: 'Previous bundled review',
          description: 'Previous description',
          icon: 'archive',
          filename: 'recorded-pipeline.yaml',
          createdAt: '2026-09-18T00:00:00.000Z',
          updatedAt: '2026-09-18T00:00:00.000Z',
          source: 'user',
          readonly: false,
        },
      ],
    });
    mockUpdate.mockResolvedValue({ ok: false, error: 'update failed' });
    renderModal([existing], inlinePipelineDetail(), undefined, true);
    await flush();

    await submit();

    expect(mockGetPipeline).toHaveBeenCalledWith({
      id: 'recorded-pipeline',
      source: 'user',
    });
    expect(mockSavePipeline).toHaveBeenCalledTimes(2);
    expect(mockSavePipeline.mock.calls[1]?.[0]).toEqual({
      id: 'recorded-pipeline',
      name: 'Previous bundled review',
      description: 'Previous description',
      icon: 'archive',
      content: {
        name: 'Previous bundled review',
        on: 'dispatch',
        jobs: { previous: { steps: [] } },
      },
    });
    expect(byTestId('install-automation-error')?.textContent).toContain(
      'update failed',
    );
  });

  it('blocks when the bundled bytes do not match the pinned hash', async () => {
    renderModal(
      undefined,
      inlinePipelineDetail({ pipelineContentHash: 'f'.repeat(64) }),
      undefined,
      true,
    );

    const blocked = await waitForTestId(
      'install-automation-shared-pipeline-blocked',
    );
    expect(blocked.textContent).toContain(
      'does not match the version the author pinned',
    );
    await flush();
    expect(
      byTestId('install-automation-workspace')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(mockSavePipeline).not.toHaveBeenCalled();
  });

  it('never offers the rebind picker for a bundled ref', async () => {
    renderModal(undefined, inlinePipelineDetail(), undefined, true);
    await flush();
    // Substituting a different pipeline would run something other than what
    // the author sent.
    expect(byTestId('install-automation-pipeline')).toBeNull();
  });

  it('tells a public visitor a legacy shared-pipeline ref needs re-sharing', async () => {
    renderModal(
      undefined,
      sharedPipelineDetail({
        pipelineContentHash: SHARED_HASH,
        distributionMode: 'definition_only',
      }),
      undefined,
      true,
    );
    await flush();

    expect(mockVerifyPin).not.toHaveBeenCalled();
    expect(
      byTestId('install-automation-shared-pipeline-blocked')?.textContent,
    ).toContain('share it again');
  });

  it('threads publicShare into the package install seam', async () => {
    renderModal(
      undefined,
      packagedPromptDetail(),
      [{ id: 'cowork-1', name: 'Notes', type: 'cowork' }],
      true,
    );
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await flush();
    await submit();

    expect(mockInstallPackage).toHaveBeenCalledWith(
      expect.objectContaining({ publicShare: true }),
    );
  });

  it('records public provenance on the created copy', async () => {
    renderModal(
      undefined,
      packagedPromptDetail(),
      [{ id: 'cowork-1', name: 'Notes', type: 'cowork' }],
      true,
    );
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await flush();
    await submit();

    // `installedFrom.remoteId` holds a public-share id here, a different
    // namespace from a team-share id, so without `sourceKind` the landing
    // page can never recognize its own install.
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      installedFrom: { sourceKind: 'public' },
    });
  });
});

describe('InstallSharedAutomationModal — curated catalog source', () => {
  const COWORK = [{ id: 'cowork-1', name: 'Notes', type: 'cowork' as const }];

  it('titles the review with the automation and its type (CAN-3710)', () => {
    renderModal(undefined, pipelineDetail(), undefined, false, 'curated');

    expect(
      document.getElementById('install-shared-automation-title')?.textContent,
    ).toBe(pipelineDetail().automation.name);
    expect(byTestId('share-install-type-label')?.textContent).toBe(
      'Automation',
    );
    expect(document.body.textContent).not.toContain(
      'Install shared automation',
    );
  });

  it('records curated provenance on the created copy', async () => {
    renderModal(undefined, coworkPromptDetail(), COWORK, false, 'curated');
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await flush();
    await submit();

    // `installedFrom.remoteId` holds the catalog key here. Without
    // `sourceKind` the copy would read as a team-share install, and main
    // would look the key up as a team share.
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      enabled: false,
      installedFrom: {
        remoteId: coworkPromptDetail().id,
        contentHash: coworkPromptDetail().contentHash,
        sourceKind: 'curated',
      },
    });
  });

  it('reads and installs the capability package through the curated source', async () => {
    renderModal(undefined, packagedPromptDetail(), COWORK, false, 'curated');
    await flush();

    expect(mockReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'curated' }),
    );
    expect(mockReadiness.mock.calls[0]?.[0]).not.toHaveProperty('publicShare');

    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await flush();
    await submit();

    expect(mockInstallPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: packagedPromptDetail().id,
        localAutomationId: 'installed',
        source: 'curated',
      }),
    );
    expect(mockInstallPackage.mock.calls[0]?.[0]).not.toHaveProperty(
      'publicShare',
    );
  });

  it('keeps a team-share install free of a source on the package seams', async () => {
    renderModal(undefined, packagedPromptDetail(), COWORK);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await flush();
    await submit();

    expect(mockReadiness.mock.calls[0]?.[0]).not.toHaveProperty('source');
    expect(mockInstallPackage.mock.calls[0]?.[0]).not.toHaveProperty('source');
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty(
      'installedFrom.sourceKind',
    );
  });

  it('names a public share as the source alongside the legacy flag', async () => {
    renderModal(undefined, packagedPromptDetail(), COWORK, true);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await flush();
    await submit();

    expect(mockInstallPackage).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'public', publicShare: true }),
    );
  });

  it('updates an installed curated copy in place and keeps its bindings', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-curated',
      name: 'Nightly review pipeline',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'code-review',
        pipelineSource: 'bundled',
        inputs: { branch: 'develop' },
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        sourceKind: 'curated',
      },
    };
    renderModal([existing], pipelineDetail(), undefined, false, 'curated');

    expect(document.body.textContent).toContain('Apply update');
    expect(document.body.textContent).not.toContain('Apply shared update');
    await submit();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'activity-curated',
      enabled: true,
      action: {
        workspaceId: 'workspace-1',
        inputs: { branch: 'develop' },
      },
      installedFrom: {
        contentHash: 'a'.repeat(64),
        sourceKind: 'curated',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// CAN-3651: install copy, missing-input helper, and completion outcome.
// ---------------------------------------------------------------------------

function fileReferenceDetail(): SharedAutomationDetail {
  const base = coworkPromptDetail();
  return {
    ...base,
    automation: {
      ...base.automation,
      version: 2,
      action: {
        type: 'standalone_prompt',
        target: { kind: 'cowork' },
        prompt: 'Read README.md',
        plugins: [],
        promptReferences: [
          {
            kind: 'file',
            textStart: 5,
            displayText: 'README.md',
            root: { kind: 'workspace' },
            relativePath: 'README.md',
          },
        ],
      },
    },
  };
}

function staleCopy(enabled: boolean): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-installed',
    name: 'Nightly review pipeline',
    enabled,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'workspace-1',
      pipelineId: 'code-review',
      pipelineSource: 'bundled',
      inputs: { branch: 'develop' },
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    failureCount: 0,
    installedFrom: {
      remoteId: pipelineDetail().id,
      contentHash: 'old'.padEnd(64, '0'),
      installedAt: '2026-08-01T00:00:00.000Z',
    },
  };
}

function submitReason(): string | null {
  return byTestId('install-automation-submit-reason')?.textContent ?? null;
}

describe('InstallSharedAutomationModal install copy (CAN-3651)', () => {
  it('labels a fresh install Install and enable without an off-state note', () => {
    renderModal();

    expect(byTestId('install-automation-submit')?.textContent).toBe(
      'Install and enable',
    );
    expect(byTestId('install-automation-note')).toBeNull();
  });

  it('shows the share description as plain text and attribution', () => {
    const base = pipelineDetail();
    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(InstallSharedAutomationModal, {
          detail: {
            ...base,
            automation: {
              ...base.automation,
              description: 'Reviews **every** branch overnight.',
            },
          },
          workspaces: [
            { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
          ],
          subtitle: 'Shared by morgan',
          onClose: jest.fn(),
          onDone: mockDone,
        }),
      );
    });

    expect(byTestId('share-install-description')?.textContent).toBe(
      'Reviews every branch overnight.',
    );
    expect(byTestId('install-shared-automation-modal')?.textContent).toContain(
      'Shared by morgan',
    );
  });

  it('keeps the update action text, with no notes (CAN-3710)', () => {
    renderModal([staleCopy(true)]);

    expect(byTestId('install-automation-submit')?.textContent).toBe(
      'Apply update',
    );
    expect(byTestId('install-automation-note')).toBeNull();
    expect(byTestId('install-automation-submit-reason')).toBeNull();
  });

  it('preselects the only compatible project, so it needs no input (CAN-3710)', async () => {
    renderModal();
    await waitForTargets();

    const picker = byTestId('install-automation-workspace');
    expect(picker?.getAttribute('data-value')).toBe('workspace-1');
    expect(byTestId('install-automation-submit-reason')).toBeNull();
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('names a missing project and clears the reason once it is chosen', async () => {
    renderModal(undefined, pipelineDetail(), [
      { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
      { id: 'workspace-2', name: 'Docs', type: 'single-repo' },
    ]);
    await waitForTargets();

    expect(submitReason()).toBe('Choose a project to continue');
    await selectTarget('install-automation-workspace', 'workspace-1');
    expect(byTestId('install-automation-submit-reason')).toBeNull();
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('names a missing Cowork project', async () => {
    renderModal(undefined, coworkPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
      { id: 'cowork-2', name: 'Notes', type: 'cowork' },
    ]);
    await flush();

    expect(submitReason()).toMatch(/^Choose a .+ project to continue$/);
    expect(submitReason()).not.toBe('Choose a project to continue');
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    expect(byTestId('install-automation-submit-reason')).toBeNull();
  });

  it('resolves a missing pipeline before offering compatible projects', async () => {
    mockListPipelines.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'my-review',
          name: 'My review',
          filename: 'my-review.yaml',
          description: '',
          icon: '',
          createdAt: '2026-08-19T00:00:00.000Z',
          updatedAt: '2026-08-19T00:00:00.000Z',
          source: 'user',
          readonly: false,
        },
      ],
    });
    renderModal(undefined, unresolvedPipelineDetail());
    await flush();

    expect(submitReason()).toBe('Choose a workflow to continue');
    expect(byTestId('install-automation-workspace')).not.toBeNull();
    // No project is offered: the picker is disabled and holds none.
    expectNoProjectOffered('install-automation-workspace');
    chooseOption('install-automation-pipeline', 'my-review');
    await selectTarget('install-automation-workspace', 'workspace-1');
    expect(byTestId('install-automation-submit-reason')).toBeNull();
  });

  it('suppresses the reason while the pipeline catalog is loading', () => {
    mockListPipelines.mockReturnValue(new Promise<unknown>(() => {}));
    renderModal(undefined, unresolvedPipelineDetail());

    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(byTestId('install-automation-submit-reason')).toBeNull();
  });

  it('names only the missing project for a share with file references', async () => {
    renderModal(undefined, fileReferenceDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
      { id: 'cowork-2', name: 'Notes', type: 'cowork' },
    ]);

    expect(submitReason()).toMatch(/project to continue$/);
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    expect(byTestId('install-automation-submit-reason')).toBeNull();
  });

  it('defers to an inline alert instead of naming a missing input', async () => {
    mockVerifyPin.mockRejectedValue(
      new Error('The pinned version of "Team review" could not be verified.'),
    );
    renderModal(
      undefined,
      sharedPipelineDetail({
        pipelineContentHash: SHARED_HASH,
        distributionMode: 'definition_only',
      }),
    );
    await flush();

    expect(
      byTestId('install-automation-shared-pipeline-blocked'),
    ).not.toBeNull();
    // The project is also missing, but the alert is the real blocker.
    expect(byTestId('install-automation-submit-reason')).toBeNull();
  });

  it('defers to an unverifiable capability package', async () => {
    mockReadiness.mockRejectedValue(new Error('digest mismatch'));
    renderModal(undefined, packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();

    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(byTestId('install-automation-submit-reason')).toBeNull();
  });

  it('hides the reason while submitting', async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    mockCreate.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    setValue(byTestId('install-automation-input-branch'), 'develop');
    act(() => {
      byTestId('install-automation-submit')?.click();
    });
    await flush();

    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(byTestId('install-automation-submit-reason')).toBeNull();
    await act(async () => {
      resolveCreate({ ok: true, activity: { id: 'installed' } });
      await Promise.resolve();
    });
    await flush();
  });

  it('shows a spinner and marks the button busy while submitting', async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    mockCreate.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    setValue(byTestId('install-automation-input-branch'), 'develop');
    expect(
      byTestId('install-automation-submit')?.getAttribute('aria-busy'),
    ).toBe('false');
    act(() => {
      byTestId('install-automation-submit')?.click();
    });
    await flush();

    expect(byTestId('install-automation-submit-spinner')).not.toBeNull();
    expect(
      byTestId('install-automation-submit')?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(byTestId('install-automation-submit')?.textContent).toBe(
      'Install and enable',
    );

    await act(async () => {
      resolveCreate({ ok: true, activity: { id: 'installed' } });
      await Promise.resolve();
    });
    await flush();

    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
    // The harness keeps the modal mounted after `onClose`, so the success
    // path must clear the busy state itself.
    expect(byTestId('install-automation-submit-spinner')).toBeNull();
    expect(
      byTestId('install-automation-submit')?.getAttribute('aria-busy'),
    ).toBe('false');
  });

  it('clears the spinner when the install fails', async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    mockCreate.mockReturnValue(
      new Promise<unknown>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    setValue(byTestId('install-automation-input-branch'), 'develop');
    act(() => {
      byTestId('install-automation-submit')?.click();
    });
    await flush();
    expect(byTestId('install-automation-submit-spinner')).not.toBeNull();

    await act(async () => {
      resolveCreate({ ok: false, error: 'boom' });
      await Promise.resolve();
    });
    await flush();

    expect(byTestId('install-automation-submit-spinner')).toBeNull();
    expect(
      byTestId('install-automation-submit')?.getAttribute('aria-busy'),
    ).toBe('false');
    expect(byTestId('install-automation-error')?.textContent).toContain('boom');
  });

  it('creates the automation once when submit is clicked twice before rerender', async () => {
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    const button = byTestId('install-automation-submit');
    if (button === null) throw new Error('missing submit');
    // Both clicks land in the same act scope, before React re-renders the
    // button disabled.
    act(() => {
      button.click();
      button.click();
    });
    await flush();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockDone).toHaveBeenCalledTimes(1);
  });

  it('does not install again when submit is clicked after a successful install', async () => {
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();
    expect(mockDone).toHaveBeenCalledTimes(1);

    // The harness keeps the modal mounted after `onClose`.
    act(() => {
      byTestId('install-automation-submit')?.click();
    });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockDone).toHaveBeenCalledTimes(1);
  });

  it('reports an installed outcome with the new copy id', async () => {
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
  });

  it('creates and installs the package once for rapid duplicate submissions', async () => {
    // Exercise completion across an event-loop turn, as Web Crypto does.
    mockCreate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { ok: true, activity: { id: 'installed' } };
    });
    renderModal(undefined, packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    const button = byTestId('install-automation-submit');
    if (button === null) throw new Error('missing submit');
    const completed = new Promise<void>((resolve) => {
      mockDone.mockImplementationOnce(() => resolve());
    });
    await act(async () => {
      button.click();
      button.click();
      await completed;
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockInstallPackage).toHaveBeenCalledTimes(1);
    expect(mockDone).toHaveBeenCalledTimes(1);
  });

  it('keeps an update failure in review and completes only its successful retry', async () => {
    mockUpdate.mockResolvedValueOnce({ ok: false, error: 'update failed' });
    mockUpdate.mockResolvedValue({ ok: true, activity: staleCopy(true) });
    renderModal([staleCopy(true)]);
    await submit();
    expect(byTestId('install-automation-error')?.textContent).toContain(
      'update failed',
    );
    expect(mockDone).not.toHaveBeenCalled();
    await submit();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockDone).toHaveBeenCalledWith('activity-installed', 'updated');
  });

  it('retries a rolled-back partial package install before completing', async () => {
    mockInstallPackage.mockRejectedValueOnce(
      new Error('package install failed'),
    );
    renderModal(undefined, packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await submit();
    expect(mockDone).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith({ id: 'installed' });
    await submit();
    expect(mockInstallPackage).toHaveBeenCalledTimes(2);
    expect(mockDone).toHaveBeenCalledTimes(1);
  });

  it('reports an updated outcome with the existing copy id', async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      activity: { id: 'activity-installed' },
    });
    renderModal([staleCopy(true)]);
    await submit();

    expect(mockDone).toHaveBeenCalledWith('activity-installed', 'updated');
  });

  it('does not report completion when creation fails, and allows a retry', async () => {
    mockCreate.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(byTestId('install-automation-error')?.textContent).toBe('disk full');
    expect(mockDone).not.toHaveBeenCalled();

    await submit();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
  });

  it('does not report completion when package installation fails', async () => {
    mockInstallPackage.mockRejectedValue(new Error('package install failed'));
    renderModal(undefined, packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await submit();

    expect(byTestId('install-automation-error')?.textContent).toContain(
      'package install failed',
    );
    expect(mockDone).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith({ id: 'installed' });
  });

  it('turns the copy on only after its capability package installs', async () => {
    const order: string[] = [];
    mockCreate.mockImplementation(() => {
      order.push('create');
      return Promise.resolve({ ok: true, activity: { id: 'installed' } });
    });
    mockInstallPackage.mockImplementation(() => {
      order.push('package');
      return Promise.resolve();
    });
    mockUpdate.mockImplementation(() => {
      order.push('enable');
      return Promise.resolve({ ok: true, activity: { id: 'installed' } });
    });
    renderModal(undefined, packagedPromptDetail(), [
      { id: 'cowork-1', name: 'Research', type: 'cowork' },
    ]);
    await flush();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await submit();

    expect(order).toEqual(['create', 'package', 'enable']);
    expect(mockDone).toHaveBeenCalledWith('installed', 'installed');
  });

  it('rolls the new copy back when it cannot be turned on', async () => {
    mockUpdate.mockResolvedValue({ ok: false, error: 'write failed' });
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(byTestId('install-automation-error')?.textContent).toBe(
      "write failed. The automation wasn't installed.",
    );
    expect(mockDelete).toHaveBeenCalledWith({ id: 'installed' });
    expect(mockDone).not.toHaveBeenCalled();
    expect(
      byTestId('install-automation-submit')?.getAttribute('aria-busy'),
    ).toBe('false');
  });

  it('keeps a refusal that already ends in a period intact', async () => {
    mockUpdate.mockResolvedValue({
      ok: false,
      error: 'You no longer have access to something this uses.',
    });
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(byTestId('install-automation-error')?.textContent).toBe(
      "You no longer have access to something this uses. The automation wasn't installed.",
    );
    expect(mockDelete).toHaveBeenCalledWith({ id: 'installed' });
  });

  it('falls back to the generic message when the enable refusal has no text', async () => {
    mockUpdate.mockResolvedValue({ ok: false, error: '   ' });
    renderModal();
    await selectTarget('install-automation-workspace', 'workspace-1');
    await submit();

    expect(byTestId('install-automation-error')?.textContent).toBe(
      "The automation couldn't be turned on, so it wasn't installed. Try again.",
    );
    expect(mockDelete).toHaveBeenCalledWith({ id: 'installed' });
    expect(mockDone).not.toHaveBeenCalled();
  });

  it('has no Cancel button; the close button dismisses without installing', () => {
    const onClose = jest.fn();
    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(InstallSharedAutomationModal, {
          detail: pipelineDetail(),
          workspaces: [
            { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
          ],
          onClose,
          onDone: mockDone,
        }),
      );
    });
    const buttons = Array.from(document.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent === 'Cancel')).toBe(
      false,
    );
    const close = document.querySelector('button[aria-label="Close"]');
    if (!(close instanceof HTMLButtonElement)) throw new Error('missing X');
    act(() => close.click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDone).not.toHaveBeenCalled();
  });
});

describe('InstallSharedAutomationModal target compatibility (CAN-3734)', (): void => {
  const mixedWorkspaces: Array<{
    id: string;
    name: string;
    type: 'single-repo' | 'multi-repo' | 'cowork';
  }> = [
    { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
    { id: 'cowork-1', name: 'Research', type: 'cowork' },
  ];

  function mockPipelineScope(scope: unknown): void {
    mockGetPipeline.mockResolvedValue({
      success: true,
      data: {
        info: { id: 'code-review', name: 'Code review', source: 'bundled' },
        content: { name: 'Code review', on: 'dispatch', scope, jobs: {} },
      },
    });
  }

  it('blocks unverified legacy shared pipelines without selectable projects', async () => {
    Object.defineProperty(
      window.api.automations,
      'resolveSharedPipelineInstallPin',
      { value: undefined, configurable: true },
    );
    renderModal(
      undefined,
      sharedPipelineDetail({
        pipelineContentHash: SHARED_HASH,
        distributionMode: 'definition_only',
      }),
      mixedWorkspaces,
    );
    await flush();
    // No project is offered: the picker is disabled and holds none.
    expectNoProjectOffered('install-automation-workspace');
    expect(byTestId('install-automation-target-blocked')).not.toBeNull();
  });

  it('offers only Cowork projects for a Cowork prompt', async () => {
    renderModal(undefined, coworkPromptDetail(), mixedWorkspaces);
    await waitForTargets();

    expect(optionValues('install-automation-cowork-project')).toEqual([
      'cowork-1',
    ]);
    expect(byTestId('install-automation-workspace')).toBeNull();
  });

  it('excludes Cowork projects for a worktree-only pipeline', async () => {
    mockPipelineScope('worktree');
    renderModal(undefined, pipelineDetail(), mixedWorkspaces);
    await waitForTargets();

    expect(optionValues('install-automation-workspace')).toEqual([
      'workspace-1',
    ]);
  });

  it('offers both project kinds for a directory-capable pipeline', async () => {
    mockPipelineScope('directory');
    renderModal(undefined, pipelineDetail(), mixedWorkspaces);
    await waitForTargets();

    expect(optionValues('install-automation-workspace')).toEqual([
      'workspace-1',
      'cowork-1',
    ]);
  });

  it('honors a declared narrowing and carries it onto the installed copy', async () => {
    mockPipelineScope('directory');
    const base = pipelineDetail();
    const narrowed: SharedAutomationDetail = {
      ...base,
      automation: {
        ...base.automation,
        version: 3,
        targetRequirement: { contexts: ['cowork'] },
      },
    };
    renderModal(undefined, narrowed, mixedWorkspaces);
    await waitForTargets();

    expect(optionValues('install-automation-workspace')).toEqual(['cowork-1']);
    await selectTarget('install-automation-workspace', 'cowork-1');
    setValue(byTestId('install-automation-input-branch'), 'develop');
    await submit();

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      action: { type: 'worktree_pipeline', workspaceId: 'cowork-1' },
      targetRequirement: { contexts: ['cowork'] },
    });
  });

  it('blocks a global-only pipeline with a reason instead of a picker', async () => {
    mockPipelineScope('global');
    renderModal(undefined, pipelineDetail(), mixedWorkspaces);
    await waitForTargets();

    expect(
      byTestId('install-automation-target-blocked')?.textContent,
    ).toContain('no compatible automation target');
    // No project is offered: the picker is disabled and holds none.
    expectNoProjectOffered('install-automation-workspace');
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('blocks a declared requirement when the pipeline cannot be read', async () => {
    mockGetPipeline.mockResolvedValue({ success: false, error: 'not found' });
    const base = pipelineDetail();
    renderModal(
      undefined,
      {
        ...base,
        automation: {
          ...base.automation,
          version: 3,
          targetRequirement: { contexts: ['worktree'] },
        },
      },
      mixedWorkspaces,
    );
    await waitForTargets();

    expect(
      byTestId('install-automation-target-blocked')?.textContent,
    ).toContain('not found');
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('explains that a compatible project is needed when none exist', async () => {
    renderModal(undefined, coworkPromptDetail(), [
      { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
    ]);
    await waitForTargets();

    expect(byTestId('install-automation-target-empty')?.textContent).toContain(
      `runs in a ${CHAT_LABEL} project`,
    );
    expect(byTestId('install-automation-cowork-project')).toBeNull();
    expect(byTestId('install-automation-submit-reason')).toBeNull();
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it('requires a Cowork choice and applies a worktree-to-Cowork update disabled', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Hourly CI blame',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Summarize today',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: coworkPromptDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    renderModal([existing], coworkPromptDetail(), [
      ...mixedWorkspaces,
      { id: 'cowork-2', name: 'Notes', type: 'cowork' },
    ]);
    await waitForTargets();

    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(byTestId('install-automation-submit-reason')?.textContent).toBe(
      `Choose a ${CHAT_LABEL} project to continue`,
    );

    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await submit();

    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'activity-installed',
      enabled: false,
      action: { type: 'standalone_prompt', chatProjectId: 'cowork-1' },
    });
  });

  it('predicts a disabled update when the mapper drops a local target binding', async () => {
    // Same action type and project, but the update cannot carry the
    // recipient's Work Entry, so the mapper and main both land it disabled.
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Hourly CI blame',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        workEntryId: 'entry-1',
        prompt: 'Summarize today',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: coworkPromptDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    renderModal([existing], coworkPromptDetail(), mixedWorkspaces);
    await waitForTargets();

    await submit();

    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'activity-installed',
      enabled: false,
    });
  });

  it('re-enables the restored copy when rollback follows a rebinding update', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Hourly CI blame',
      enabled: true,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        prompt: 'Summarize today',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: packagedPromptDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    // Main lands any shared update that changes the target binding disabled,
    // including the restore of the previous binding.
    mockUpdate.mockImplementation((request) =>
      Promise.resolve({
        ok: true,
        activity: {
          ...existing,
          enabled:
            typeof request === 'object' &&
            request !== null &&
            'installedFrom' in request
              ? false
              : true,
        },
      }),
    );
    mockInstallPackage.mockRejectedValueOnce(
      new Error('package install failed'),
    );
    renderModal([existing], packagedPromptDetail(), mixedWorkspaces);
    await waitForTargets();
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    await submit();
    await flush();

    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(mockUpdate.mock.calls[1]?.[0]).toMatchObject({
      id: existing.id,
      action: existing.action,
      installedFrom: existing.installedFrom,
    });
    expect(mockUpdate.mock.calls[2]?.[0]).toEqual({
      id: existing.id,
      enabled: true,
    });
    expect(byTestId('install-automation-error')?.textContent).toContain(
      'package install failed',
    );
  });
});

it('refreshes access on submit and rejects a project removed after selection', async () => {
  renderModal(undefined, coworkPromptDetail(), [
    { id: 'cowork-1', name: 'Research', type: 'cowork' },
  ]);
  await selectTarget('install-automation-cowork-project', 'cowork-1');
  mockLoadProjects.mockResolvedValue({ items: [] });
  await submit();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(byTestId('install-automation-error')?.textContent).toContain(
    'Choose a compatible project again',
  );
});

it('discards a late pipeline resolution from an obsolete document revision', async () => {
  let complete: ((value: unknown) => void) | undefined;
  mockGetPipeline.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  renderModal();
  await flush();
  expect(byTestId('install-automation-workspace')).not.toBeNull();
  // No project is offered: the picker is disabled and holds none.
  expectNoProjectOffered('install-automation-workspace');
  mockGetPipeline.mockResolvedValue({
    success: true,
    data: {
      info: { id: 'code-review' },
      content: { name: 'Global', on: 'dispatch', scope: 'global', jobs: {} },
    },
  });
  act(() => {
    root?.render(
      createElement(InstallSharedAutomationModal, {
        detail: { ...pipelineDetail(), contentHash: 'd'.repeat(64) },
        workspaces: [{ id: 'workspace-1', name: 'Code', type: 'single-repo' }],
        onClose: () => {},
        onDone: mockDone,
      }),
    );
  });
  await waitForTargets();
  act(() => {
    complete?.({
      success: true,
      data: {
        info: { id: 'code-review' },
        content: { name: 'Old', on: 'dispatch', scope: 'directory', jobs: {} },
      },
    });
  });
  await flush();
  expect(byTestId('install-automation-target-blocked')?.textContent).toContain(
    'no compatible',
  );
  expect(byTestId('install-automation-workspace')).not.toBeNull();
  expectNoProjectOffered('install-automation-workspace');
});

it('verifies a project replacement separately for each candidate project', async () => {
  mockListPipelines.mockResolvedValue({
    success: true,
    data: [
      {
        id: 'project-review',
        name: 'Project review',
        filename: 'review.yaml',
        source: 'project',
        readonly: true,
      },
    ],
  });
  Object.assign(window.api, {
    getWorktreePath: jest.fn().mockResolvedValue('/cowork'),
  });
  Object.assign(window.pipelines, {
    discoverProject: jest.fn().mockImplementation((cwd: string) =>
      Promise.resolve({
        success: true,
        data: [
          {
            id: 'project-review',
            filename: 'review.yaml',
            filePath: `${cwd}/review.yaml`,
            source: 'project',
          },
        ],
      }),
    ),
  });
  mockGetPipeline.mockImplementation((locator: unknown) =>
    Promise.resolve({
      success: true,
      data: {
        info: { id: 'project-review' },
        content: {
          name: 'Project review',
          on: 'dispatch',
          scope:
            typeof locator === 'object' &&
            locator !== null &&
            'cwd' in locator &&
            locator.cwd === '/repo'
              ? 'worktree'
              : 'global',
          jobs: {},
        },
      },
    }),
  );
  renderModal(undefined, unresolvedPipelineDetail(), [
    { id: 'workspace-1', name: 'Code', type: 'single-repo' },
    { id: 'cowork-1', name: 'Research', type: 'cowork' },
  ]);
  await flush();
  chooseOption('install-automation-pipeline', 'project-review');
  await selectTarget('install-automation-workspace', 'workspace-1');
  expect(optionValues('install-automation-workspace')).toEqual(['workspace-1']);
  await submit();
  expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
    action: {
      workspaceId: 'workspace-1',
      pipelineSource: 'project',
      projectPipelineFilename: 'review.yaml',
    },
  });
});

it('swaps to host creation with the same revision and draft only for a compatible-project shortage', async () => {
  const onClose = jest.fn();
  const onCreateProject = jest.fn();
  root = createRoot(document.body);
  act(() => {
    root?.render(
      createElement(InstallSharedAutomationModal, {
        detail: coworkPromptDetail(),
        workspaces: [],
        onClose,
        onDone: mockDone,
        onCreateProject,
      }),
    );
  });
  await flush();
  expect(byTestId('install-automation-target-empty')).not.toBeNull();
  act(() => byTestId('install-automation-create-cowork')?.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onCreateProject).toHaveBeenCalledWith(
    expect.objectContaining({
      context: 'cowork',
      detail: coworkPromptDetail(),
      draft: expect.objectContaining({ workspaceId: '' }) as unknown,
    }),
  );
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
    onCreateProject.mock.invocationCallOrder[0] ?? 0,
  );
});

it('does not offer code project creation when the selected organization only permits Cowork creation', async () => {
  mockCreationContext.mockResolvedValue({
    context: { kind: 'organization', organizationId: 'org-1' },
    revision: 1,
    organizations: [],
  });
  const detail = inlinePipelineDetail({
    rawPipeline: 'name: Review\non: dispatch\nscope: worktree\njobs: {}\n',
  });
  detail.automation.targetRequirement = { contexts: ['worktree'] };
  root = createRoot(document.body);
  act(() => {
    root?.render(
      createElement(InstallSharedAutomationModal, {
        detail,
        workspaces: [],
        onClose: jest.fn(),
        onDone: mockDone,
        onCreateProject: jest.fn(),
      }),
    );
  });
  await waitForTestId('install-automation-target-empty');
  expect(byTestId('install-automation-create-worktree')).toBeNull();
  await waitForTestId('install-automation-creation-unavailable');
  expect(
    byTestId('install-automation-creation-unavailable')?.textContent,
  ).toContain('another organization');
});

// CAN-3959: an author-included run condition is reviewed in the dialog, off
// by default, and stored only when the recipient turns it on and installs.
describe('InstallSharedAutomationModal run condition (CAN-3959)', () => {
  const COMMAND = 'test -f ~/.config/capacity-ok';
  const COWORK_ONLY: Array<{
    id: string;
    name: string;
    type: 'single-repo' | 'multi-repo' | 'cowork';
  }> = [{ id: 'cowork-1', name: 'Research', type: 'cowork' }];

  function withRunCondition(
    detail: SharedAutomationDetail,
    command: string = COMMAND,
  ): SharedAutomationDetail {
    return {
      ...detail,
      automation: {
        ...detail.automation,
        version: 4,
        hasRunCondition: true,
        runCondition: { command },
      },
    };
  }

  function promptDetail(prompt: string): SharedAutomationDetail {
    const base = coworkPromptDetail();
    return withRunCondition({
      ...base,
      automation: {
        ...base.automation,
        action: {
          type: 'standalone_prompt',
          target: { kind: 'cowork' },
          prompt,
          plugins: [],
        },
      },
    });
  }

  function commandField(): HTMLTextAreaElement {
    const element = byTestId('install-automation-run-condition-command');
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('expected the run-condition textarea');
    }
    return element;
  }

  function setCommand(value: string): void {
    const element = commandField();
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set?.call(element, value);
    act(() => {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function toggle(): HTMLInputElement {
    const element = byTestId('install-automation-run-condition-toggle');
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('expected the run-condition checkbox');
    }
    return element;
  }

  function flip(): void {
    act(() => toggle().click());
  }

  async function renderCoworkInstall(
    detail: SharedAutomationDetail,
  ): Promise<void> {
    renderModal(undefined, detail, COWORK_ONLY);
    await selectTarget('install-automation-cowork-project', 'cowork-1');
  }

  function gatedStaleCopy(ifCommand?: string): ScheduledActivity {
    return {
      ...staleCopy(true),
      ...(ifCommand !== undefined ? { ifCommand } : {}),
    };
  }

  /** A copy whose gate came from approving {@link COMMAND} on a share. */
  function shareApprovedCopy(ifCommand: string): ScheduledActivity {
    return {
      ...staleCopy(true),
      ifCommand,
      installedFrom: {
        remoteId: pipelineDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
        approvedRunCondition: COMMAND,
      },
    };
  }

  it('shows the shared command off by default and installs without it', async () => {
    await renderCoworkInstall(promptDetail('Summarize today'));

    expect(toggle().checked).toBe(false);
    expect(toggle().closest('label')?.textContent).toBe(
      'Check a command before each run',
    );
    expect(commandField().value).toBe(COMMAND);
    expect(commandField().readOnly).toBe(true);
    expect(commandField().getAttribute('aria-label')).toBe(
      'Run condition command',
    );
    await submit();

    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('ifCommand');
    expect(mockCreate.mock.calls[0]?.[0]?.installedFrom).not.toHaveProperty(
      'approvedRunCondition',
    );
  });

  it('installs with the shared command once turned on', async () => {
    await renderCoworkInstall(promptDetail('Summarize today'));
    flip();

    expect(commandField().readOnly).toBe(false);
    await submit();

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      ifCommand: COMMAND,
      installedFrom: { approvedRunCondition: COMMAND },
    });
  });

  it('does not cap the command field, so the whole command shows before install', async () => {
    await renderCoworkInstall(promptDetail('Summarize today'));

    expect(commandField().className.split(/\s+/)).not.toContainEqual(
      expect.stringMatching(/^max-h-/),
    );
    expect(commandField().className.split(/\s+/)).toContain(
      'field-sizing-content',
    );
  });

  it('installs an edited command trimmed', async () => {
    await renderCoworkInstall(promptDetail('Summarize today'));
    flip();
    setCommand('  exit 0  \n');
    await submit();

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      ifCommand: 'exit 0',
    });
  });

  it('installs with no gate when left off and names the unfilled placeholder', async () => {
    const name = AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES[0] ?? '';
    await renderCoworkInstall(promptDetail(`Act on {{ ${name} }} now.`));

    expect(
      byTestId('install-automation-run-condition-output-note')?.textContent,
    ).toBe(`{{${name}}} won't be filled in without the run condition.`);
    flip();
    expect(byTestId('install-automation-run-condition-output-note')).toBeNull();
    flip();
    await submit();

    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('ifCommand');
  });

  it('says nothing about placeholders when declining an update keeps a local command', () => {
    const name = AUTOMATION_IF_CMD_OUTPUT_VAR_NAMES[0] ?? '';
    const detail = promptDetail(`Act on {{ ${name} }} now.`);
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Summarize',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: `Act on {{ ${name} }} now.`,
      },
      ifCommand: 'exit 1',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: detail.id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    renderModal([existing], detail, COWORK_ONLY);

    expect(
      byTestId('install-automation-run-condition-keeps-current'),
    ).not.toBeNull();
    expect(byTestId('install-automation-run-condition-output-note')).toBeNull();
  });

  it('says nothing about placeholders the prompt does not use', async () => {
    await renderCoworkInstall(promptDetail('Summarize today'));

    expect(byTestId('install-automation-run-condition-output-note')).toBeNull();
  });

  it.each([
    ['empty', '', 'Enter a command or turn the run condition off'],
    [
      'whitespace-only',
      '   \n ',
      'Enter a command or turn the run condition off',
    ],
    [
      'oversize',
      'x'.repeat(20_001),
      'Shorten the command to 20,000 characters or turn the run condition off',
    ],
  ])('blocks Install on an %s command', async (_label, value, reason) => {
    await renderCoworkInstall(promptDetail('Summarize today'));
    flip();
    setCommand(value);

    expect(submitReason()).toBe(reason);
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(true);
    flip();
    expect(submitReason()).toBeNull();
    await waitForSubmitEnabled();
    expect(
      byTestId('install-automation-submit')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('renders no row and stores no gate for a command the author kept private', async () => {
    const base = coworkPromptDetail();
    await renderCoworkInstall({
      ...base,
      automation: { ...base.automation, version: 3, hasRunCondition: true },
    });

    expect(byTestId('install-automation-run-condition')).toBeNull();
    await submit();
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('ifCommand');
  });

  it('notes that declining an update keeps a different local command', async () => {
    renderModal([gatedStaleCopy('exit 1')], withRunCondition(pipelineDetail()));

    expect(
      byTestId('install-automation-run-condition-keeps-current')?.textContent,
    ).toBe('Leaving this off keeps your current command.');
    expect(byTestId('install-automation-run-condition-turns-off')).toBeNull();
    await submit();

    expect(mockUpdate.mock.calls[0]?.[0]).not.toHaveProperty('ifCommand');
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({ enabled: true });
  });

  it('replaces the local command and lands disabled when an update is approved', async () => {
    renderModal([gatedStaleCopy('exit 1')], withRunCondition(pipelineDetail()));
    flip();

    expect(
      byTestId('install-automation-run-condition-turns-off')?.textContent,
    ).toBe(
      'The automation turns off after this update so you can check it first.',
    );
    await submit();

    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      ifCommand: COMMAND,
      enabled: false,
      installedFrom: { approvedRunCondition: COMMAND },
    });
  });

  it('removes a shared gate the author dropped and says so', async () => {
    renderModal([shareApprovedCopy(COMMAND)], pipelineDetail());

    expect(byTestId('install-automation-run-condition')).toBeNull();
    expect(
      byTestId('install-automation-run-condition-removed')?.textContent,
    ).toBe(
      'The author removed the run condition, so this update removes yours too.',
    );
    await submit();

    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({ ifCommand: '' });
    expect(mockUpdate.mock.calls[0]?.[0]?.installedFrom).not.toHaveProperty(
      'approvedRunCondition',
    );
  });

  it('keeps a shared gate when the author stays gated but keeps the command private', async () => {
    renderModal([shareApprovedCopy(COMMAND)], {
      ...pipelineDetail(),
      automation: {
        ...pipelineDetail().automation,
        version: 3,
        hasRunCondition: true,
      },
    });

    expect(byTestId('install-automation-run-condition-removed')).toBeNull();
    await submit();

    expect(mockUpdate.mock.calls[0]?.[0]).not.toHaveProperty('ifCommand');
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      installedFrom: { approvedRunCondition: COMMAND },
    });
  });

  it('keeps a gate the recipient changed after approving it', async () => {
    renderModal([shareApprovedCopy('exit 1')], pipelineDetail());

    expect(byTestId('install-automation-run-condition-removed')).toBeNull();
    await submit();

    expect(mockUpdate.mock.calls[0]?.[0]).not.toHaveProperty('ifCommand');
  });

  it('adds no keeps-current line when the local command already matches', () => {
    renderModal(
      [gatedStaleCopy(`${COMMAND}\n`)],
      withRunCondition(pipelineDetail()),
    );

    expect(byTestId('install-automation-run-condition')).not.toBeNull();
    expect(
      byTestId('install-automation-run-condition-keeps-current'),
    ).toBeNull();
    expect(
      byTestId('install-automation-run-condition-already-current')?.textContent,
    ).toBe('Your copy already uses this command.');
  });

  it('clears an approved gate when a failed update rolls back an ungated copy', async () => {
    const existing: ScheduledActivity = {
      version: 1,
      id: 'activity-installed',
      name: 'Summarize',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Summarize today',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      failureCount: 0,
      installedFrom: {
        remoteId: packagedPromptDetail().id,
        contentHash: 'old'.padEnd(64, '0'),
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    mockInstallPackage.mockRejectedValueOnce(
      new Error('package install failed'),
    );
    renderModal(
      [existing],
      withRunCondition(packagedPromptDetail()),
      COWORK_ONLY,
    );
    await selectTarget('install-automation-cowork-project', 'cowork-1');
    flip();
    await submit();
    await flush();

    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({ ifCommand: COMMAND });
    expect(mockUpdate.mock.calls[1]?.[0]).toMatchObject({
      id: existing.id,
      ifCommand: '',
    });
    expect(byTestId('install-automation-error')?.textContent).toContain(
      'package install failed',
    );
  });

  it('keeps the choice across the create-project detour', async () => {
    const onCreateProject = jest.fn();
    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(InstallSharedAutomationModal, {
          detail: promptDetail('Summarize today'),
          workspaces: [],
          onClose: jest.fn(),
          onDone: mockDone,
          onCreateProject,
        }),
      );
    });
    await flush();
    setCommand('exit 0');
    act(() => byTestId('install-automation-create-cowork')?.click());

    expect(onCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          runConditionEnabled: false,
          runConditionCommand: 'exit 0',
        }) as unknown,
      }),
    );

    act(() => root?.unmount());
    root = createRoot(document.body);
    act(() => {
      root?.render(
        createElement(InstallSharedAutomationModal, {
          detail: promptDetail('Summarize today'),
          workspaces: COWORK_ONLY,
          initialDraft: {
            workspaceId: '',
            coworkWorkspaceId: 'cowork-1',
            existingBranch: '',
            inputs: {},
            chosenPipelineId: '',
            runConditionEnabled: false,
            runConditionCommand: 'exit 0',
          },
          onClose: jest.fn(),
          onDone: mockDone,
        }),
      );
    });
    expect(toggle().checked).toBe(false);
    act(() => toggle().click());
    expect(commandField().value).toBe('exit 0');
  });
});
