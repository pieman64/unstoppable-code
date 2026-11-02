import type {
  GitHubTokenProviderArgs,
  SessionConfig,
} from '@github/copilot-sdk';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import type { CopilotTurnRequest } from '@canopy/desktop-shared/node/copilot/turn-driver';

/** Ends a fixture turn once its SDK session has received a token. */
export class SessionTokenRead extends Error {
  constructor(readonly token: string) {
    super('Copilot session token read');
    this.name = 'SessionTokenRead';
  }
}

/**
 * A fake `createSession` / `resumeSession`: asks the session's provider for a
 * token as the native runtime does, then ends the turn with what it got.
 */
export async function requestSessionToken(
  config: SessionConfig,
  args: Partial<GitHubTokenProviderArgs> = {},
): Promise<never> {
  const provider = config.gitHubTokenProvider;
  if (!provider) throw new Error('The session has no token provider.');
  const provided = await provider({
    host: 'https://github.com',
    sessionId: 'fixture-session',
    reason: 'initial',
    ...args,
  });
  throw new SessionTokenRead(
    provided.kind === 'token' ? provided.accessToken : '',
  );
}

export function turnRequest(
  overrides: Partial<CopilotTurnRequest> = {},
): CopilotTurnRequest {
  return {
    turnId: 'fixture-turn',
    prompt: 'fixture prompt',
    workingDirectory: '/fixture/cwd',
    configDirectory: '/fixture/profile',
    model: 'fixture-model',
    signal: new AbortController().signal,
    authorize: () => Promise.resolve({ decision: 'deny' }),
    emit: () => undefined,
    onSession: () => undefined,
    ...overrides,
  };
}

/** The token a turn's SDK session receives; the turn then closes the handle. */
export function sessionToken(
  handle: CopilotRecipientHandle,
  overrides: Partial<CopilotTurnRequest> = {},
): Promise<string> {
  return handle.runTurn(turnRequest(overrides)).then(
    () => {
      throw new Error('The turn finished without reading a session token.');
    },
    (error: unknown) => {
      if (error instanceof SessionTokenRead) return error.token;
      throw error;
    },
  );
}
