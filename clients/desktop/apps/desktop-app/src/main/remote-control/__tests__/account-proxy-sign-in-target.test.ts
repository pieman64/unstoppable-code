import {
  accountProxyRemoteSignInTarget,
  type AccountProxySignInSession,
} from '../host/account-proxy-sign-in-target';
import { REMOTE_METHODS, UnknownRemoteMethodError } from '../remote-protocol';
import { RpcRemoteError } from '../transport/rpc-peer';

const PAGE = {
  provider: 'claude' as const,
  url: 'https://claude.ai/oauth/authorize?state=state0123456789',
  state: 'state0123456789',
};
const OUTDATED = 'Update the app on this computer.';

function session(
  open: AccountProxySignInSession['openAccountProxySignIn'],
): AccountProxySignInSession & { ended: string[] } {
  const ended: string[] = [];
  return {
    ended,
    openAccountProxySignIn: open,
    endAccountProxySignIn: (state: string): void => {
      ended.push(state);
    },
    onClosed: (): (() => void) => () => undefined,
  };
}

describe('accountProxyRemoteSignInTarget', () => {
  it('opens and ends sign-ins on the controller', async () => {
    const opened: unknown[] = [];
    const live = session((params) => {
      opened.push(params);
      return Promise.resolve();
    });
    const target = accountProxyRemoteSignInTarget({
      controllerDeviceId: 'device',
      session: live,
      outdatedControllerMessage: OUTDATED,
    });
    await target.open(PAGE);
    target.end(PAGE.state);
    expect(opened).toEqual([PAGE]);
    expect(live.ended).toEqual([PAGE.state]);
  });

  it('asks the user to update a controller that predates remote sign-in', async () => {
    const unknown = new UnknownRemoteMethodError(
      REMOTE_METHODS.accountProxySignInOpen,
    );
    const target = accountProxyRemoteSignInTarget({
      controllerDeviceId: 'device',
      session: session(() =>
        Promise.reject(new RpcRemoteError(unknown.message, unknown.code)),
      ),
      outdatedControllerMessage: OUTDATED,
    });
    await expect(target.open(PAGE)).rejects.toThrow(OUTDATED);
  });

  it("passes on the controller's own refusal, such as a busy port", async () => {
    const target = accountProxyRemoteSignInTarget({
      controllerDeviceId: 'device',
      session: session(() =>
        Promise.reject(new RpcRemoteError('Port 54545 is in use.', 'busy')),
      ),
      outdatedControllerMessage: OUTDATED,
    });
    await expect(target.open(PAGE)).rejects.toThrow('Port 54545 is in use.');
  });

  it('fails at once when the session is already gone', async () => {
    const target = accountProxyRemoteSignInTarget({
      controllerDeviceId: 'device',
      session: null,
      outdatedControllerMessage: OUTDATED,
    });
    await expect(target.open(PAGE)).rejects.toThrow('closed');
    const closed = jest.fn();
    target.onClosed(closed);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
