// Freezes the exact name, description, and JSON input schema every agent
// surface advertises for the shared agent action tools. A change here is a
// model-visible tool contract change on that surface.

jest.mock('../../canopy-tools/core', () => ({
  executeCanopyInjectedTool: jest.fn(),
}));
jest.mock('../../canopy-tools/session-runtime', () => ({
  loadWorktreeScriptOutput: jest.fn(),
  saveLocalMemory: jest.fn(),
  searchLocalMemory: jest.fn(),
  readLocalMemory: jest.fn(),
  loadGitPreferences: jest.fn(),
  loadWorktreePipelineYaml: jest.fn(),
  getFileCommentsInSession: jest.fn(),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    upsertPendingQuestion: jest.fn(),
    consumePendingQuestion: jest.fn(),
    getState: jest.fn(),
  }),
}));
jest.mock('../../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: jest.fn(),
    dispose: jest.fn(),
  })),
}));
jest.mock('../../feature-flags', (): unknown => ({
  getFeatureFlagService: (): object => ({ isEnabled: (): boolean => true }),
}));

import { createServer } from 'node:http';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  type CanopyInjectedToolKey,
  type CanopyInjectedToolSurface,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { buildCanopyDynamicToolSpecs } from '../../codex/canopy-dynamic-tools';
import {
  createDelegateCanopyTools,
  DELEGATE_SCRIPT_ACTION_TYPES,
} from '../../agents/delegation/canopy-tools';
import { McpHttpProxyService } from '../../mcp/http-proxy-service';

const AGENT_ACTION_TOOL_KEYS: readonly CanopyInjectedToolKey[] = [
  'search_actions',
  'dispatch_action',
  'search_watchers',
  'setup_watchers',
  'delete_watchers',
  'start_forked_agent',
  'start_branched_agent',
];

interface FrozenTool {
  key: CanopyInjectedToolKey;
  name: string;
  description: string;
  inputSchema: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyForName(name: string): CanopyInjectedToolKey | undefined {
  return AGENT_ACTION_TOOL_KEYS.find((key) => {
    const entry = CANOPY_INJECTED_TOOL_REGISTRY[key];
    return entry.displayName === name || entry.codexToolName === name;
  });
}

function freeze(tools: readonly unknown[]): FrozenTool[] {
  return tools.flatMap((tool): FrozenTool[] => {
    if (!isRecord(tool) || typeof tool.name !== 'string') return [];
    const key = keyForName(tool.name);
    if (!key || typeof tool.description !== 'string') return [];
    return [
      {
        key,
        name: tool.name,
        description: tool.description,
        inputSchema: JSON.stringify(tool.inputSchema),
      },
    ];
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('Expected TCP server address.'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

describe('agent action tool surface golden', () => {
  let service: McpHttpProxyService;

  beforeEach(() => {
    service = new McpHttpProxyService();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  async function listMcpTools(
    toolSurface: CanopyInjectedToolSurface,
  ): Promise<FrozenTool[]> {
    const sessionKey = `golden-${toolSurface}`;
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/worktree',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: 0,
      hookHandler: jest.fn(),
      toolSurface,
    });
    const response = await fetch(service.getCanopyWorktreeMcpUrl(sessionKey), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !isRecord(payload.result)) return [];
    const tools = payload.result.tools;
    return Array.isArray(tools) ? freeze(tools) : [];
  }

  it.each<CanopyInjectedToolSurface>([
    'native-sdk',
    'native-sdk-standalone',
    'cursor-acp',
    'cursor-acp-standalone',
  ])('freezes the %s MCP surface', async (surface) => {
    expect(await listMcpTools(surface)).toMatchSnapshot();
  });

  it('freezes the managed-delegate surface', () => {
    const tools = createDelegateCanopyTools(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'root-chat',
        delegationId: 'delegation',
        provider: 'claude',
        isolated: false,
        parentCwd: '/worktrees/project',
        executionCwd: '/worktrees/project',
        codeGraphAvailable: false,
        getWindow: (): null => null,
        authorizeCommand: (): Promise<boolean> => Promise.resolve(false),
      },
      (): Promise<boolean> => Promise.resolve(true),
    ).tools;
    expect({
      allowedActionTypes: DELEGATE_SCRIPT_ACTION_TYPES,
      tools: freeze(tools).map((tool) => ({
        ...tool,
        codexName: tools.find((entry) => entry.key === tool.key)?.codexName,
      })),
    }).toMatchSnapshot();
  });

  it.each(['worktree', 'cowork'] as const)(
    'freezes the Codex %s dynamic tools',
    (mode) => {
      expect(
        freeze(
          buildCanopyDynamicToolSpecs({ includeChatVisuals: false, mode }),
        ),
      ).toMatchSnapshot();
    },
  );
});
