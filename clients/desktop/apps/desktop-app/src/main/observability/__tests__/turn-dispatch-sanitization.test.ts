import {
  sanitizeTurnDispatchSlowDiagnostic,
  type SessionDiagnosticRecord,
} from '../service';

describe('sanitizeTurnDispatchSlowDiagnostic', () => {
  it('keeps only bounded timing and session-scope fields', () => {
    const event = {
      version: 1,
      timestamp: '2026-10-16T00:00:00.000Z',
      kind: 'turn_dispatch_slow',
      sessionKey: 'session-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      providerType: 'claude',
      totalMs: Number.POSITIVE_INFINITY,
      endpoint: 'first_event',
      phases: [
        { phase: 'auth_preflight', elapsedMs: -12 },
        { phase: 'prompt_commit', elapsedMs: Number.NaN },
      ],
      requestText: 'private prompt contents',
      rawError: new Error('private failure details'),
      localPath: '/private/worktree',
    } satisfies SessionDiagnosticRecord & {
      requestText: string;
      rawError: Error;
      localPath: string;
    };

    expect(sanitizeTurnDispatchSlowDiagnostic(event)).toEqual({
      version: 1,
      timestamp: '2026-10-16T00:00:00.000Z',
      kind: 'turn_dispatch_slow',
      sessionKey: 'session-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      providerType: 'claude',
      totalMs: 0,
      endpoint: 'first_event',
      phases: [{ phase: 'auth_preflight', elapsedMs: 0 }],
    });
  });
});
