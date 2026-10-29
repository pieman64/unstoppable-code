import { AcpClientError } from '../../acp/errors';
import { isTransientAcpFailure } from '../acp-failure';

describe('isTransientAcpFailure', () => {
  it('treats a fixed-window RPC timeout as transient, not lost context', () => {
    // Independent-review finding: `loadSession`'s bare catch reported the ACP
    // client's own 30-second RPC window as permanent context loss, replacing a
    // retryable fault with a false "your saved context is gone" diagnosis.
    expect(
      isTransientAcpFailure(
        new AcpClientError(
          'timeout',
          'ACP operation did not settle within its deadline',
        ),
      ),
    ).toBe(true);
  });

  it.each(['closed', 'busy'] as const)(
    'treats %s as transient, since it describes the connection not the session',
    (code) => {
      expect(isTransientAcpFailure(new AcpClientError(code, code))).toBe(true);
    },
  );

  it.each(['protocol', 'provider', 'unsupported', 'invalid-input'] as const)(
    'leaves %s classified as context loss',
    (code) => {
      // An agent-side rejection of `session/load` is the ordinary
      // orphaned-profile case this path exists to handle, and it does NOT
      // arrive as `invalid-session` — that code is only the client's own
      // "is this session attached to this connection" check.
      expect(isTransientAcpFailure(new AcpClientError(code, code))).toBe(false);
    },
  );

  it('leaves a non-ACP error classified as context loss, as before the change', () => {
    expect(isTransientAcpFailure(new Error('spawn failed'))).toBe(false);
  });
});
