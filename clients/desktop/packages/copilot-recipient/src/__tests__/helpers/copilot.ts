import type { CopilotToolMetadataRpc } from '../../tool-snapshot';
import {
  runCopilotTurn,
  type CopilotTurnRequest,
  type CopilotTurnResult,
} from '../../turn-driver';
import type {
  CurrentToolMetadata,
  MessageOptions,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';

export interface CopilotFixtureAccount {
  host: string;
  login: string;
}

export const account: CopilotFixtureAccount = {
  host: 'https://github.com',
  login: 'fixture',
};

export interface FixtureSession {
  rpc: CopilotToolMetadataRpc;
  sessionId: string;
  send: (input: string | MessageOptions) => Promise<string>;
  abort: () => Promise<void>;
}

export interface FixtureRuntime {
  client: {
    createSession: jest.Mock<Promise<FixtureSession>, [SessionConfig]>;
    resumeSession: jest.Mock<Promise<FixtureSession>, [string, SessionConfig]>;
  };
  generation: number;
  account: CopilotFixtureAccount;
  runTurn(request: CopilotTurnRequest): Promise<CopilotTurnResult>;
  exited: Promise<void>;
  close: jest.Mock<Promise<void>, []>;
}

export interface CopilotNativeFixture {
  runtime: FixtureRuntime;
  sends: string[];
  configs: SessionConfig[];
  metadata: jest.Mock<Promise<{ tools: CurrentToolMetadata[] | null }>, []>;
}

export function nativeRuntime(
  options: {
    account?: CopilotFixtureAccount;
    hold?: boolean;
    sessionId?: string;
    assistantText?: string;
    openRuntime?: (runtime: FixtureRuntime) => void;
    driveTurn?: typeof runCopilotTurn;
    serverStatuses?: Record<string, 'connected' | 'needs-auth' | 'failed'>;
  } = {},
): CopilotNativeFixture {
  const metadata = jest.fn<
    Promise<{ tools: CurrentToolMetadata[] | null }>,
    []
  >(() => Promise.resolve({ tools: [] }));
  let reap!: () => void;
  const exited = new Promise<void>((resolve) => {
    reap = resolve;
  });
  const sends: string[] = [];
  const configs: SessionConfig[] = [];
  const sessionId = options.sessionId ?? 'native-child';
  const create = (config: SessionConfig): Promise<FixtureSession> => {
    configs.push(config);
    return Promise.resolve({
      sessionId,
      abort: () => Promise.resolve(),
      rpc: {
        tools: {
          initializeAndValidate: () => Promise.resolve({}),
          getCurrentMetadata: metadata,
        },
        mcp: {
          list: () =>
            Promise.resolve({
              servers: Object.keys(config.mcpServers ?? {}).map((name) => ({
                name,
                status:
                  options.serverStatuses?.[name] ?? ('connected' as const),
              })),
            }),
        },
      },
      send: (input: string | MessageOptions): Promise<string> => {
        sends.push(typeof input === 'string' ? input : input.prompt);
        const event = (type: string, data: unknown, id: string): void =>
          config.onEvent?.({
            id,
            type,
            data,
            timestamp: new Date(0).toISOString(),
            parentId: null,
            ephemeral: false,
          } as SessionEvent);
        event(
          'assistant.message',
          {
            messageId: 'answer',
            content: options.assistantText ?? 'Verified evidence',
          },
          'message',
        );
        event(
          'assistant.usage',
          { inputTokens: 12, cacheReadTokens: 2, outputTokens: 3 },
          'usage',
        );
        if (!options.hold) event('session.idle', {}, 'idle');
        return Promise.resolve('message-id');
      },
    });
  };
  const runtime: FixtureRuntime = {
    client: {
      createSession: jest.fn(create),
      resumeSession: jest.fn((_id: string, config: SessionConfig) =>
        create(config),
      ),
    },
    generation: 1,
    account: options.account ?? account,
    // The recipient handle drives the real turn over this fixture client.
    runTurn: (turn) =>
      (options.driveTurn ?? runCopilotTurn)({ ...turn, runtime }),
    exited,
    close: jest.fn(() => {
      reap();
      return Promise.resolve();
    }),
  };
  options.openRuntime?.(runtime);
  return { runtime, sends, configs, metadata };
}
