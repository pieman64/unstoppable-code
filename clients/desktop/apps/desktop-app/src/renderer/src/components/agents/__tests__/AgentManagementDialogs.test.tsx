/**
 * @jest-environment jsdom
 *
 * The local agent editor and share dialogs the Marketplace hosts (CAN-4266),
 * moved here from the retired Agents page suite. Uses the repo's createRoot +
 * act jsdom convention; heavy dependencies (the agents store, the
 * current-UI-state reporter, the navigation store, and the plugin selector)
 * are module-mocked so the dialogs render deterministically.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { shareEnvelope } from '@/test-utils/shareOperation';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type {
  AgentModelDefinition,
  ImportSharedAgentRequest,
  ImportSharedAgentResponse,
  SaveAgentModelRequest,
} from '@canopy/desktop-shared/types/agent-models';

// --- Module mocks (hoisted; factories may reference `mock*`-prefixed vars). ---
interface AgentsMockState {
  agents: AgentModelDefinition[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: () => Promise<void>;
  remove: () => Promise<void>;
  importShared: (
    request: ImportSharedAgentRequest,
  ) => Promise<ImportSharedAgentResponse>;
  subscribe: () => () => void;
}

let mockAgentsState: AgentsMockState;
jest.mock('@/stores/agentsStore', () => ({
  useAgentsStore: (selector: (s: AgentsMockState) => unknown): unknown =>
    selector(mockAgentsState),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));

const mockOpenShareInstall = jest.fn();
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: Object.assign(
    (selector: (s: { openSettings: () => void }) => unknown): unknown =>
      selector({ openSettings: (): void => {} }),
    {
      getState: (): { openShareInstall: typeof mockOpenShareInstall } => ({
        openShareInstall: mockOpenShareInstall,
      }),
    },
  ),
}));

jest.mock('@/components/shared/PluginSelector', () => ({
  PluginSelector: (): null => null,
}));

jest.mock('@/components/chat/ChatPluginsModal', () => ({
  ChatPluginsModal: (): null => null,
}));

jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (enabled: boolean): boolean => enabled,
}));

jest.mock('@/hooks/useOpenCodeChatAvailable', () => ({
  useOpenCodeChatAvailable: (enabled: boolean): boolean => enabled,
}));

const mockPostShareToast = jest.fn();
jest.mock('@/lib/share-toast', () => ({
  postShareToast: (toast: unknown): void => {
    mockPostShareToast(toast);
  },
}));

let mockUnifiedTableData: { rows: unknown[]; loading: boolean };
jest.mock('@/hooks/useUnifiedTableData', () => ({
  useUnifiedTableData: (): { rows: unknown[]; loading: boolean } =>
    mockUnifiedTableData,
}));

import { useState } from 'react';
import { AgentModelModal } from '../AgentModelModal';
import { ShareAgentModal } from '../ShareAgentModal';
import { AGENT_PUBLIC_SHARE_CHANGED_EVENT } from '@/lib/share-links';

const BASE_MODEL = 'claude-agents-test';
const CODEX_BASE_MODEL = 'gpt-agents-test';
const mockCreateSharedAgent = jest.fn<Promise<unknown>, [unknown]>();
const mockUpdateSharedAgent = jest.fn<Promise<unknown>, [unknown]>();
const mockGetSharedAgent = jest.fn<Promise<unknown>, [string]>();
const mockPublishAgentPublicShare = jest.fn<Promise<unknown>, [string]>();
const mockRevokeAgentPublicShare = jest.fn<Promise<void>, [string]>();

beforeAll(() => {
  initClaudeModels([{ id: BASE_MODEL, label: 'Claude Agents Test' }]);
  initCodexModels([{ id: CODEX_BASE_MODEL, label: 'Codex Agents Test' }]);
});

let root: Root | null = null;

function render(node: ReactNode): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

function click(el: Element | null): void {
  if (!el) throw new Error('element to click not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function clickAsync(el: Element | null): Promise<void> {
  if (!el) throw new Error('element to click not found');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function flushShareDialog(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function buttonByTestId(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
}

function setValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(el, value);
  const eventType = el.tagName === 'SELECT' ? 'change' : 'input';
  act(() => {
    el.dispatchEvent(new Event(eventType, { bubbles: true }));
  });
}

/** Drive the ModelPicker dropdown used for the Agent base model. */
function selectBaseModel(model: string): void {
  click(byTestId('chat-model-picker'));
  click(byTestId(`chat-model-option-${model}`));
}

function emptySelections(): AgentModelDefinition['pluginSelections'] {
  return { collectionIds: [], skillRefs: [], pluginRefs: [] };
}

function agentDef(
  over: Partial<AgentModelDefinition> = {},
): AgentModelDefinition {
  return {
    id: 'agent_model_reviewer',
    name: 'Code Reviewer',
    baseModel: BASE_MODEL,
    instructions: '',
    pluginSelections: emptySelections(),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...over,
  };
}

function importResponse(
  over: Partial<ImportSharedAgentResponse> = {},
): ImportSharedAgentResponse {
  const agent = agentDef();
  return {
    agent,
    requestedId: agent.id,
    finalId: agent.id,
    idChanged: false,
    ...over,
  };
}

function baseAgentsState(over: Partial<AgentsMockState> = {}): AgentsMockState {
  return {
    agents: [],
    loading: false,
    loaded: true,
    error: null,
    load: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    importShared: jest.fn().mockResolvedValue(importResponse()),
    subscribe: jest.fn().mockReturnValue(() => {}),
    ...over,
  };
}

beforeEach(() => {
  mockOpenShareInstall.mockClear();
  mockPostShareToast.mockClear();
  mockAgentsState = baseAgentsState();
  mockUnifiedTableData = { rows: [], loading: false };
  mockCreateSharedAgent.mockReset();
  mockUpdateSharedAgent.mockReset();
  mockGetSharedAgent.mockReset();
  mockPublishAgentPublicShare.mockReset();
  mockRevokeAgentPublicShare.mockReset();
  mockCreateSharedAgent.mockResolvedValue({
    id: 'shared-agent-id',
    contentHash: 'server-hash',
    agent: {
      version: 1,
      id: 'agent_model_reviewer',
      name: 'Code Reviewer',
      baseModel: BASE_MODEL,
      instructions: '',
      plugins: [],
    },
  });
  mockUpdateSharedAgent.mockResolvedValue({
    id: 'shared-agent-id',
    contentHash: 'server-hash-next',
    agent: {
      version: 1,
      id: 'agent_model_reviewer',
      name: 'Code Reviewer',
      baseModel: BASE_MODEL,
      instructions: '',
      plugins: [],
    },
  });
  mockGetSharedAgent.mockResolvedValue({
    id: 'shared-agent-id',
    contentHash: 'server-hash',
    shareScope: 'organization',
    owner: { type: 'organization', id: 'org-1', name: 'Example Org' },
    createdBy: {
      id: 'departed-user',
      name: 'Former teammate',
      email: 'former@example.test',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    canUpdate: false,
    canDelete: true,
    agent: {
      version: 1,
      id: 'agent_model_reviewer',
      name: 'Code Reviewer',
      baseModel: BASE_MODEL,
      instructions: '',
      plugins: [],
    },
    publicShare: {
      externalId: 'public-share-id',
      pinnedContentHash: 'server-hash',
      upToDate: true,
      sharePath: '/share/agents/public-share-id',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  });
  mockPublishAgentPublicShare.mockResolvedValue({
    externalId: 'public-share-id',
    pinnedContentHash: 'server-hash',
    upToDate: true,
    sharePath: '/share/agents/public-share-id',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  mockRevokeAgentPublicShare.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getCanopyCloudBaseUrl: jest
        .fn()
        .mockResolvedValue('https://cloud.example.test'),
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        account: { id: 'acct' },
        capabilities: ['agents-crud-v1'],
      }),
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      listSharedTeams: jest.fn().mockResolvedValue({ success: true, data: [] }),
      listSharedOrganizations: jest
        .fn()
        .mockResolvedValue({ success: true, data: [] }),
    },
  });
  Object.defineProperty(window, 'agents', {
    configurable: true,
    value: {
      createShared: shareEnvelope(mockCreateSharedAgent),
      updateShared: shareEnvelope(mockUpdateSharedAgent),
      getShared: mockGetSharedAgent,
      publishPublicShare: mockPublishAgentPublicShare,
      revokePublicShare: mockRevokeAgentPublicShare,
      inspectImport: jest.fn().mockResolvedValue({
        agent: { id: 'shared-agent-id', package: undefined },
        matchedRefs: [],
        unmatchedRefs: ['github:example/tools/review'],
        requirements: [
          {
            id: 'mcp:linear',
            kind: 'mcp',
            displayName: 'Linear',
            required: true,
            affectedSteps: [],
            setupHint: 'Connect Linear in Settings.',
            status: 'missing',
          },
        ],
      }),
      analyzeCapabilityPackage: jest.fn().mockResolvedValue({
        analysisId: 'analysis-1',
        state: 'ready',
        blockers: [],
        manifest: {
          version: 1,
          pipelineContentHash: 'a'.repeat(64),
          resources: [],
          bindings: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
      }),
      cancelCapabilityPackageAnalysis: jest.fn().mockResolvedValue(undefined),
      commitCapabilityPackage: shareEnvelope(jest.fn()),
    },
  });
});

/** Mirrors a host: the dialog stays mounted until it asks to close. */
function ShareDialogHarness({
  agent,
}: {
  agent: AgentModelDefinition;
}): ReactNode {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(ShareAgentModal, {
        agent,
        onClose: () => setOpen(false),
        onOpenAccountSettings: () => {},
        onShared: () => {},
      })
    : null;
}

function renderShareDialog(agent: AgentModelDefinition): void {
  mockAgentsState = baseAgentsState({ agents: [agent] });
  render(createElement(ShareDialogHarness, { agent }));
}

describe('ShareAgentModal from the Marketplace', () => {
  it('closes the share modal and announces the public link in a toast', async () => {
    const agent = agentDef();
    mockAgentsState = baseAgentsState({ agents: [agent] });
    renderShareDialog(agent);
    await flushShareDialog();

    // Public is selected automatically when it is the only usable audience.
    expect(buttonByTestId('share-agent-scope-public')).toBeNull();
    expect(byTestId('share-agent-scope-description')?.textContent).toContain(
      'public',
    );
    await clickAsync(buttonByTestId('share-agent-submit'));

    expect(mockCreateSharedAgent).toHaveBeenCalledTimes(1);
    const createRequest = mockCreateSharedAgent.mock.calls[0]?.[0] as
      | { agent: { id: string }; shareScope: string }
      | undefined;
    expect(createRequest?.agent.id).toBe(agent.id);
    // A public share is stored as `private` with a published public link.
    expect(createRequest?.shareScope).toBe('private');
    expect(mockPublishAgentPublicShare).toHaveBeenCalledWith('shared-agent-id');
    expect(byTestId('share-agent-modal')).toBeNull();
    expect(mockPostShareToast).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Agent is now public',
      link: 'https://cloud.example.test/share/agents/public-share-id',
    });
  });

  it('updates an existing shared agent with the stored remote content hash', async () => {
    const agent = agentDef({
      remoteId: 'shared-agent-id',
      remoteContentHash: 'server-hash',
    });
    mockAgentsState = baseAgentsState({ agents: [agent] });
    renderShareDialog(agent);
    await flushShareDialog();

    await clickAsync(buttonByTestId('share-agent-submit'));

    expect(mockUpdateSharedAgent).toHaveBeenCalledTimes(1);
    const updateRequest = mockUpdateSharedAgent.mock.calls[0]?.[0] as
      | {
          agentId: string;
          agent: { id: string };
          expectedContentHash: string;
        }
      | undefined;
    expect(updateRequest?.agentId).toBe('shared-agent-id');
    expect(updateRequest?.agent.id).toBe(agent.id);
    expect(updateRequest?.expectedContentHash).toBe('server-hash');
    // Public updates normalize legacy organization ownership to a personal
    // copy while keeping the existing public link.
    expect(updateRequest).toHaveProperty('shareScope', 'private');
    expect(updateRequest).not.toHaveProperty('organizationId');
    expect(updateRequest).not.toHaveProperty('revokePublicShare');
    expect(mockCreateSharedAgent).not.toHaveBeenCalled();
  });

  it('lets an organization admin revoke a departed creator public link', async () => {
    const agent = agentDef({ remoteId: 'shared-agent-id' });
    mockAgentsState = baseAgentsState({ agents: [agent] });
    renderShareDialog(agent);
    await flushShareDialog();

    const revoke = buttonByTestId('share-agent-remove-public-link');
    if (!revoke) throw new Error('remove public link button not found');
    expect(revoke.disabled).toBe(false);
    await clickAsync(revoke);

    expect(mockRevokeAgentPublicShare).not.toHaveBeenCalled();
    await clickAsync(
      buttonByTestId('share-agent-remove-public-link-confirm-action'),
    );

    expect(mockRevokeAgentPublicShare).toHaveBeenCalledWith('shared-agent-id');
  });

  it('refreshes an open share modal after an App Advisor public-share change', async () => {
    const agent = agentDef({ remoteId: 'shared-agent-id' });
    mockAgentsState = baseAgentsState({ agents: [agent] });
    renderShareDialog(agent);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetSharedAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event(AGENT_PUBLIC_SHARE_CHANGED_EVENT));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockGetSharedAgent).toHaveBeenCalledTimes(2);
  });

  it('keeps sharing disabled until the plugin catalog finishes loading', async () => {
    mockUnifiedTableData = { rows: [], loading: true };
    const agent = agentDef();
    mockAgentsState = baseAgentsState({ agents: [agent] });
    renderShareDialog(agent);
    await flushShareDialog();

    expect(buttonByTestId('share-agent-submit')?.disabled).toBe(true);
    expect(mockCreateSharedAgent).not.toHaveBeenCalled();
    expect(mockUpdateSharedAgent).not.toHaveBeenCalled();
  });

  it('tells the user to re-fetch after a shared agent update conflict', async () => {
    mockUpdateSharedAgent.mockRejectedValue({ status: 409 });
    const agent = agentDef({
      remoteId: 'shared-agent-id',
      remoteContentHash: 'server-hash',
    });
    mockAgentsState = baseAgentsState({ agents: [agent] });
    renderShareDialog(agent);
    await flushShareDialog();

    await clickAsync(buttonByTestId('share-agent-submit'));

    expect(document.body.textContent).toContain(
      'This agent changed in the cloud since you last shared it. Close and reopen to review the latest version.',
    );
    expect(document.body.textContent).not.toContain('referenced elsewhere');
  });
});

describe('AgentModelModal validation', () => {
  const existing = agentDef({ id: 'agent_model_existing', name: 'Existing' });

  function renderModal(
    agent: AgentModelDefinition | null,
    onSave: (request: unknown) => Promise<void> = () => Promise.resolve(),
  ): void {
    render(
      createElement(AgentModelModal, {
        agent,
        existingAgents: [existing],
        onClose: () => {},
        onSave,
      }),
    );
  }

  function submit(): void {
    click(byTestId('agent-model-submit'));
  }

  it.each([
    ['claude', BASE_MODEL],
    ['codex', CODEX_BASE_MODEL],
  ])(
    'selects an Agent base model from the %s harness',
    async (harness, model) => {
      const onSave = jest
        .fn<Promise<void>, [SaveAgentModelRequest]>()
        .mockResolvedValue(undefined);
      renderModal(agentDef(), onSave);
      click(byTestId('chat-model-picker'));
      expect(byTestId(`chat-model-harness-tab-${harness}`)).not.toBeNull();
      click(byTestId(`chat-model-harness-tab-${harness}`));
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid="chat-model-option-${model}"]`,
        ),
      ).filter((row) => !row.closest('[hidden]'));
      expect(rows).toHaveLength(1);
      click(rows[0] ?? null);
      await clickAsync(byTestId('agent-model-submit'));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ baseModel: model }),
      );
    },
  );

  it('requires a name', () => {
    renderModal(null);
    submit();
    expect(byTestId('agent-model-name-error')?.textContent).toBe(
      'Name is required.',
    );
  });

  it('rejects a duplicate name', () => {
    renderModal(null);
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Existing');
    selectBaseModel(BASE_MODEL);
    submit();
    expect(byTestId('agent-model-name-error')?.textContent).toBe(
      'An agent with this name already exists.',
    );
  });

  it('requires a base model', () => {
    renderModal(null);
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Fresh Agent');
    submit();
    expect(byTestId('agent-model-base-model-error')?.textContent).toBe(
      'Choose a base model.',
    );
  });

  it('rejects another agent as the base model', () => {
    // Edit an Agent whose base model is (invalidly) another Agent id. The
    // picker never offers Agent ids (hideAgents), so this can only arise from
    // persisted data; the validator still catches it.
    renderModal(
      agentDef({
        id: 'agent_model_edit',
        name: 'Edit Me',
        baseModel: 'agent_model_other',
      }),
    );
    submit();
    expect(byTestId('agent-model-base-model-error')?.textContent).toBe(
      'Base model cannot be another agent.',
    );
  });

  it('rejects instructions that are too long', () => {
    renderModal(null);
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Long Agent');
    selectBaseModel(BASE_MODEL);
    setValue(
      byTestId('agent-model-instructions') as HTMLTextAreaElement,
      'x'.repeat(64 * 1024 + 1),
    );
    submit();
    expect(byTestId('agent-model-instructions-error')?.textContent).toBe(
      'Instructions are too long.',
    );
  });

  it('previews the derived stable id on create and never changes it', () => {
    renderModal(null);
    const idField = byTestId('agent-model-id') as HTMLInputElement;
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Code Reviewer');
    expect(idField.value).toBe('code_reviewer');
  });

  it('submits a manually customized model id suffix on create', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    renderModal(null, onSave);
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Code Reviewer');
    setValue(byTestId('agent-model-id') as HTMLInputElement, 'Review Bot');
    selectBaseModel(BASE_MODEL);

    await clickAsync(byTestId('agent-model-submit'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ modelIdSlug: 'review_bot' }),
    );
  });

  it('clears plugin selections when changing the base provider', async () => {
    const onSave = jest
      .fn<Promise<void>, [SaveAgentModelRequest]>()
      .mockResolvedValue(undefined);
    renderModal(
      agentDef({
        id: 'agent_model_edit',
        name: 'Edit Me',
        baseModel: BASE_MODEL,
        pluginSelections: {
          collectionIds: ['collection-a'],
          skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
          pluginRefs: [],
        },
      }),
      onSave,
    );

    selectBaseModel(CODEX_BASE_MODEL);
    await clickAsync(byTestId('agent-model-submit'));

    const request = onSave.mock.calls[0]?.[0] as
      | SaveAgentModelRequest
      | undefined;
    expect(request?.baseModel).toBe(CODEX_BASE_MODEL);
    expect(request?.pluginSelections.collectionIds).toEqual([]);
    expect(request?.pluginSelections.skillRefs).toEqual([]);
    expect(request?.pluginSelections.pluginRefs).toEqual([]);
  });

  it('saves an agent that uses the default model', async () => {
    const onSave = jest
      .fn<Promise<void>, [SaveAgentModelRequest]>()
      .mockResolvedValue(undefined);
    renderModal(null, onSave);
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Follower');
    click(byTestId('agent-model-base-default'));
    expect(byTestId('agent-model-base-model')).toBeNull();

    await clickAsync(byTestId('agent-model-submit'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ baseModel: 'default' }),
    );
  });

  it('switches a default-model agent to a specific model and keeps its plugins', async () => {
    const onSave = jest
      .fn<Promise<void>, [SaveAgentModelRequest]>()
      .mockResolvedValue(undefined);
    renderModal(
      agentDef({
        id: 'agent_model_follower',
        name: 'Follower',
        baseModel: 'default',
        pluginSelections: {
          collectionIds: ['collection-a'],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
      onSave,
    );
    expect(
      (byTestId('agent-model-base-default') as HTMLInputElement).checked,
    ).toBe(true);

    click(byTestId('agent-model-base-specific'));
    submit();
    expect(byTestId('agent-model-base-model-error')?.textContent).toBe(
      'Choose a base model.',
    );
    selectBaseModel(CODEX_BASE_MODEL);
    await clickAsync(byTestId('agent-model-submit'));

    const request = onSave.mock.calls[0]?.[0];
    expect(request?.baseModel).toBe(CODEX_BASE_MODEL);
    expect(request?.pluginSelections.collectionIds).toEqual(['collection-a']);
  });

  it('rejects invalid model id suffixes', () => {
    renderModal(null);
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Fresh Agent');
    setValue(byTestId('agent-model-id') as HTMLInputElement, 'fresh_');
    selectBaseModel(BASE_MODEL);
    submit();
    expect(byTestId('agent-model-id-error')?.textContent).toBe(
      'Model ID can only contain lowercase letters, numbers, and single underscores.',
    );
  });

  it('rejects a duplicate model id suffix', () => {
    renderModal(null);
    setValue(byTestId('agent-model-name') as HTMLInputElement, 'Fresh Agent');
    setValue(byTestId('agent-model-id') as HTMLInputElement, 'existing');
    selectBaseModel(BASE_MODEL);
    submit();
    expect(byTestId('agent-model-id-error')?.textContent).toBe(
      'An agent with this model ID already exists.',
    );
  });
});
