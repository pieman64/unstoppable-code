import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import type { DelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  createCodexDelegationRunner,
  type CodexDelegationPreparation,
} from '../../../agents/delegation/codex-runner';
import type { DelegationCommandSpools } from '../../../agents/delegation/command-output-spools';

export interface TurnRequest {
  input: { text: string }[];
  permissions?: string;
  signal?: AbortSignal;
  /** Stream-backed runs return their admission lane; scripts may await it. */
  onEvent?: (event: {
    method: string;
    params: Record<string, unknown>;
  }) => void | Promise<void>;
  mcpElicitationPolicy?: {
    evaluate(
      call: {
        serverName: string;
        toolName: string;
        approvalKind: string;
      },
      signal?: AbortSignal,
    ): Promise<{ approved: boolean }> | { approved: boolean };
  };
  nativeApprovalPolicy?: (
    method: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export type TurnScript = (
  request: TurnRequest,
  interrupted: Promise<void>,
) => Promise<{
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
  errorInfo?: string;
}>;

export interface FakeHandle {
  threadId: string;
  runTurn: jest.Mock;
  interrupt: jest.Mock;
  unsubscribe: jest.Mock;
  submitSteeringInput: jest.Mock;
  turns: TurnRequest[];
}

export function fakeHandle(threadId: string, script: TurnScript): FakeHandle {
  let interruptTurn: () => void = () => undefined;
  const handle: FakeHandle = {
    threadId,
    turns: [],
    interrupt: jest.fn(() => {
      interruptTurn();
      return Promise.resolve();
    }),
    unsubscribe: jest.fn(() => Promise.resolve()),
    submitSteeringInput: jest.fn(),
    runTurn: jest.fn(async (request: TurnRequest) => {
      handle.turns.push(request);
      const interrupted = new Promise<void>((resolve) => {
        interruptTurn = resolve;
      });
      const result = await script(request, interrupted);
      return {
        status: result.status,
        threadId,
        finalText: result.text,
        usage: { inputTokens: 2, outputTokens: 3 },
        ...(result.error ? { error: result.error } : {}),
        ...(result.errorInfo ? { errorInfo: result.errorInfo } : {}),
      };
    }),
  };
  return handle;
}

export function tools(
  overrides: Partial<Record<string, unknown>> = {},
): CodexDelegationPreparation['tools'] {
  const value: unknown = {
    cwd: '/worktree',
    readRoots: [],
    gitAccess: {
      metadataRoots: [],
      privateMetadataRoots: [],
      runtimeRoots: [],
      commandDirectories: [],
    },
    instructions: () => 'Delegated instructions',
    writePaths: [],
    writable: () => true,
    prepareCodexSandboxWrites: () => Promise.resolve([]),
    codexSandboxWritesRevoked: () => Promise.resolve(false),
    codexSandboxWritesNarrowing: () => false,
    policyContextKey: () => 'policy-1',
    setCodexTurnWrites: jest.fn(),
    observeCodex: jest.fn(),
    approveCodex: jest.fn(() => Promise.resolve({ decision: 'decline' })),
    authorizeMcp: jest.fn(() => Promise.resolve(true)),
    ...overrides,
  };
  // Test fixture intentionally supplies only members exercised by the runner.
  return value as CodexDelegationPreparation['tools'];
}

export function preparation(
  extra: Partial<CodexDelegationPreparation> = {},
): CodexDelegationPreparation {
  return {
    model: 'gpt-test',
    profile: { environmentPolicy: 'restricted', includeCanopySecrets: false },
    tools: tools(),
    ...extra,
  };
}

export const request = {
  delegationId: 'delegation-1',
  runGeneration: 1,
  launchKey: 'launch-1',
  parent: {
    harnessId: 'claude',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    sessionKey: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    runtimeGeneration: 1,
    depth: 0,
  },
  task: {
    modelId: 'gpt-test',
    description: 'Inspect code',
    prompt: 'Inspect the requested code.',
    executionMode: 'foreground',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  },
  route: {
    selectedModelId: 'gpt-test',
    runtimeModelId: 'gpt-test',
    harnessId: 'codex',
    runtimeKind: 'codex-app-server',
    runnerRegistrationId: 'codex-local',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'codex',
    assignmentRevision: 'assignment-1',
    billingAuthority: 'native',
    aiCreditsRouted: false,
    capabilities: ['read'],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: 'read-only-1',
  },
  cwd: '/worktree',
  effectivePermission: 'read-only',
  signal: new AbortController().signal,
} satisfies AgentRunRequest;

export interface Harness {
  events: AgentDelegationEvent['event'][];
  terminal: Promise<AgentDelegationEvent['event']>;
  runtime: {
    startThread: jest.Mock;
    materializeThread: jest.Mock;
    resumeThread: jest.Mock;
  };
  materialized: unknown[];
  started: unknown[];
  resumes: unknown[];
  stop: () => Promise<void>;
}

export function run(options: {
  prepare: () => Promise<CodexDelegationPreparation>;
  handles: FakeHandle[];
  runRequest?: AgentRunRequest;
  transcriptPort?: DelegationTranscriptPort;
  /** Spool owner factory for stream-backed runs, for example with a fault hook. */
  spools?: () => DelegationCommandSpools;
  /** Receives the runner's reported errors; a fresh mock by default. */
  reportError?: (error: unknown) => void;
}): Harness {
  const handles = [...options.handles];
  const materialized: unknown[] = [];
  const started: unknown[] = [];
  const resumes: unknown[] = [];
  const next = (): Promise<FakeHandle> => {
    const handle = handles.shift();
    return handle
      ? Promise.resolve(handle)
      : Promise.reject(new Error('No fake thread left'));
  };
  const runtime = {
    admin: (): { request: jest.Mock } => ({
      request: jest.fn(() => Promise.resolve({ config: { mcp_servers: {} } })),
    }),
    startThread: jest.fn((startRequest: unknown) => {
      started.push(startRequest);
      return next();
    }),
    materializeThread: jest.fn((materializeRequest: unknown) => {
      materialized.push(materializeRequest);
      return next();
    }),
    resumeThread: jest.fn((resumeRequest: unknown) => {
      resumes.push(resumeRequest);
      return next();
    }),
    getCanonicalState: jest.fn(() => Promise.resolve({ codexHome: '/codex' })),
  };
  const runner = createCodexDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: options.prepare,
    reportError: options.reportError ?? jest.fn(),
    // Tests provide only the runtime surface exercised by the runner.
    runtime: () => runtime as never,
    loadResumeItems: () => Promise.resolve([{ type: 'message' }]),
    transcriptPort: options.transcriptPort,
    ...(options.spools ? { spools: options.spools } : {}),
  });
  const events: AgentDelegationEvent['event'][] = [];
  const runRequest = options.runRequest ?? request;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    void runner.start(runRequest, (envelope: AgentDelegationEvent) => {
      events.push(envelope.event);
      if (envelope.event.type === 'terminal') resolve(envelope.event);
      return Promise.resolve();
    });
  });
  return {
    events,
    terminal,
    runtime,
    materialized,
    started,
    resumes,
    stop: async (): Promise<void> => {
      await runner.stop({ runId: runRequest.delegationId }, 'user_cancelled');
    },
  };
}
