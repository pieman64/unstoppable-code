import {
  CodexAppServerJsonRpcError,
  CodexAppServerRequestTimeoutError,
  CodexSharedRestartPeerError,
} from '../connection';
import { classifyCodexTransportError } from '../transport-errors';

function withCause(error: Error, cause: unknown): Error {
  Object.defineProperty(error, 'cause', { value: cause, configurable: true });
  return error;
}

describe('classifyCodexTransportError', () => {
  it('marks an unanswered request with its method', () => {
    expect(
      classifyCodexTransportError(
        new CodexAppServerRequestTimeoutError('thread/resume', 120_000),
      ),
    ).toEqual({
      codex_error_code: 'app_server_request_timeout',
      codex_error_method: 'thread/resume',
    });
  });

  it('marks a peer failed by a shared restart', () => {
    expect(
      classifyCodexTransportError(new CodexSharedRestartPeerError()),
    ).toEqual({ codex_error_code: 'app_server_shared_restart' });
  });

  it('marks a resume rejected while the thread is closing', () => {
    expect(
      classifyCodexTransportError(
        new CodexAppServerJsonRpcError(
          'thread/resume',
          'thread 01a10835 is closing; retry thread/resume after the thread is closed',
          -32600,
          undefined,
        ),
      ),
    ).toEqual({ codex_error_code: 'thread_closing' });
  });

  it('finds a transport failure wrapped as an error cause', () => {
    const recoveryFailure = withCause(
      new Error(
        'Codex app-server background recovery failed: handlers did not settle',
      ),
      new CodexSharedRestartPeerError(),
    );
    const outer = withCause(new Error('turn failed'), recoveryFailure);

    expect(classifyCodexTransportError(outer)).toEqual({
      codex_error_code: 'app_server_shared_restart',
    });
  });

  it('stops at a cause cycle and at its depth bound', () => {
    const first = new Error('first');
    const second = withCause(new Error('second'), first);
    withCause(first, second);
    expect(classifyCodexTransportError(first)).toBeNull();

    let deep: Error = new CodexSharedRestartPeerError();
    for (let level = 0; level < 10; level += 1) {
      deep = withCause(new Error(`level ${String(level)}`), deep);
    }
    expect(classifyCodexTransportError(deep)).toBeNull();
  });

  it('leaves every other failure unmarked', () => {
    expect(classifyCodexTransportError(new Error('turn_cancelled'))).toBeNull();
    expect(
      classifyCodexTransportError(
        new Error(
          'Codex app-server did not respond to thread/resume within 120s',
        ),
      ),
    ).toBeNull();
    expect(classifyCodexTransportError('thread_closing')).toBeNull();
  });
});
