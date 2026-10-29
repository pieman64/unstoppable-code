import { createServer, type Server } from 'node:http';
import { connect, Server as NetServer } from 'node:net';
import {
  AccountProxySignInPortBusyError,
  RemoteAccountProxySignIns,
} from '../client/account-proxy-sign-in';
import type { AccountProxySignInCallbackParams } from '../remote-protocol';

const STATE = 'state0123456789abcdef';
const PAGE = `https://claude.ai/oauth/authorize?state=${STATE}`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No port.');
  return address.port;
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

interface Setup {
  signIns: RemoteAccountProxySignIns;
  port: number;
  opened: string[];
  forwarded: AccountProxySignInCallbackParams[];
  forward: jest.Mock<Promise<void>, [AccountProxySignInCallbackParams]>;
}

const live: RemoteAccountProxySignIns[] = [];
const servers: Server[] = [];

async function setup(options: { timeoutMs?: number } = {}): Promise<Setup> {
  const port = await freePort();
  const opened: string[] = [];
  const forwarded: AccountProxySignInCallbackParams[] = [];
  const forward = jest.fn((callback: AccountProxySignInCallbackParams) => {
    forwarded.push(callback);
    return Promise.resolve();
  });
  const signIns = new RemoteAccountProxySignIns({
    openExternal: (url: string): Promise<void> => {
      opened.push(url);
      return Promise.resolve();
    },
    forward,
    ports: { claude: port, codex: await freePort() },
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  live.push(signIns);
  return { signIns, port, opened, forwarded, forward };
}

function callback(
  port: number,
  query: string,
  path = '/callback',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}?${query}`);
}

async function waitUntilClosed(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (await answers(port)) {
    if (Date.now() > deadline) throw new Error('Still listening.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const signIns of live.splice(0)) signIns.closeAll();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('RemoteAccountProxySignIns', () => {
  it('opens the page here and sends the matching redirect to the host once', async () => {
    const { signIns, port, opened, forwarded } = await setup();
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    expect(opened).toEqual([PAGE]);
    expect(await answers(port)).toBe(true);

    const response = await callback(port, `code=the-code&state=${STATE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('the-code');
    expect(forwarded).toEqual([
      { state: STATE, code: 'the-code', error: null },
    ]);
    await waitUntilClosed(port);
    expect(signIns.listening).toBeNull();
  });

  it('sends a provider refusal on as an error', async () => {
    const { signIns, port, forwarded } = await setup();
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    await callback(port, `error=access_denied&state=${STATE}`);
    expect(forwarded).toEqual([
      { state: STATE, code: null, error: 'access_denied' },
    ]);
  });

  it('ignores other paths and other states, and keeps waiting', async () => {
    const { signIns, port, forward } = await setup();
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    expect(
      (await callback(port, `code=c&state=${STATE}`, '/auth/callback')).status,
    ).toBe(404);
    expect((await callback(port, 'code=c&state=otherstate123456')).status).toBe(
      400,
    );
    expect((await callback(port, 'code=c')).status).toBe(400);
    expect((await callback(port, `state=${STATE}`)).status).toBe(400);
    const post = await fetch(
      `http://127.0.0.1:${String(port)}/callback?code=c&state=${STATE}`,
      { method: 'POST' },
    );
    expect(post.status).toBe(404);
    expect(forward).not.toHaveBeenCalled();
    expect(signIns.listening).toEqual({ state: STATE, port });
  });

  it('opens no page that is not on the provider sign-in host', async () => {
    const { signIns, port, opened } = await setup();
    await expect(
      signIns.open({
        provider: 'claude',
        url: 'https://claude.ai.example.com/oauth/authorize',
        state: STATE,
      }),
    ).rejects.toThrow('unexpected sign-in page');
    await expect(
      signIns.open({ provider: 'codex', url: PAGE, state: STATE }),
    ).rejects.toThrow('unexpected sign-in page');
    expect(opened).toEqual([]);
    expect(await answers(port)).toBe(false);
  });

  it('leaves a busy port to its owner and says how to free it', async () => {
    const { signIns, port, opened } = await setup();
    const owner = createServer((_request, response) => response.end('owner'));
    servers.push(owner);
    // Bound to every address, the way a proxy's own callback forwarder is.
    await new Promise<void>((resolve) => owner.listen(port, resolve));
    const opening = signIns.open({
      provider: 'claude',
      url: PAGE,
      state: STATE,
    });
    await expect(opening).rejects.toBeInstanceOf(
      AccountProxySignInPortBusyError,
    );
    await expect(opening).rejects.toThrow(`Port ${String(port)}`);
    expect(opened).toEqual([]);
    expect(await (await callback(port, `code=c&state=${STATE}`)).text()).toBe(
      'owner',
    );
  });

  it('reports a port taken between the check and the bind as busy', async () => {
    const port = await freePort();
    const owner = createServer();
    servers.push(owner);
    await new Promise<void>((resolve) =>
      owner.listen(port, '127.0.0.1', resolve),
    );
    const signIns = new RemoteAccountProxySignIns({
      openExternal: (): Promise<void> => Promise.resolve(),
      forward: (): Promise<void> => Promise.resolve(),
      ports: { claude: port, codex: port },
      portInUse: (): Promise<boolean> => Promise.resolve(false),
    });
    live.push(signIns);
    await expect(
      signIns.open({ provider: 'claude', url: PAGE, state: STATE }),
    ).rejects.toBeInstanceOf(AccountProxySignInPortBusyError);
  });

  it('stops listening when the sign-in times out', async () => {
    const { signIns, port } = await setup({ timeoutMs: 50 });
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    await waitUntilClosed(port);
    expect(signIns.listening).toBeNull();
  });

  it('stops listening when the session ends', async () => {
    const { signIns, port } = await setup();
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    signIns.closeAll();
    await waitUntilClosed(port);
  });

  it('stops listening only for the sign-in the host ended', async () => {
    const { signIns, port } = await setup();
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    signIns.end('otherstate123456');
    expect(await answers(port)).toBe(true);
    signIns.end(STATE);
    await waitUntilClosed(port);
  });

  it('opens the page again without a second listener', async () => {
    const { signIns, port, opened } = await setup();
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    expect(opened).toEqual([PAGE, PAGE]);
    expect(signIns.listening).toEqual({ state: STATE, port });
  });

  it('shows a failure and stops listening when the host refuses the redirect', async () => {
    const { signIns, port, forward } = await setup();
    forward.mockImplementationOnce(() => Promise.reject(new Error('no')));
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    const response = await callback(port, `code=c&state=${STATE}`);
    expect(response.status).toBe(502);
    await waitUntilClosed(port);
  });

  it('stops listening when the browser does not open', async () => {
    const port = await freePort();
    const signIns = new RemoteAccountProxySignIns({
      openExternal: (): Promise<void> =>
        Promise.reject(new Error('no browser')),
      forward: (): Promise<void> => Promise.resolve(),
      ports: { claude: port, codex: port },
    });
    live.push(signIns);
    await expect(
      signIns.open({ provider: 'claude', url: PAGE, state: STATE }),
    ).rejects.toThrow('no browser');
    await waitUntilClosed(port);
  });

  it('answers a malformed request target with 400 and keeps waiting', async () => {
    const { signIns, port, forwarded } = await setup();
    await signIns.open({ provider: 'claude', url: PAGE, state: STATE });
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString();
      });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
      socket.write(
        'GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      );
    });
    expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
    expect(signIns.listening).toEqual({ state: STATE, port });
    await callback(port, `code=c&state=${STATE}`);
    expect(forwarded).toEqual([{ state: STATE, code: 'c', error: null }]);
  });

  it('opens nothing and leaves no listener when ended while checking the port', async () => {
    const port = await freePort();
    const opened: string[] = [];
    let finishProbe: (busy: boolean) => void = () => undefined;
    const signIns = new RemoteAccountProxySignIns({
      openExternal: (url: string): Promise<void> => {
        opened.push(url);
        return Promise.resolve();
      },
      forward: (): Promise<void> => Promise.resolve(),
      ports: { claude: port, codex: port },
      portInUse: (): Promise<boolean> =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    });
    live.push(signIns);
    const opening = signIns.open({
      provider: 'claude',
      url: PAGE,
      state: STATE,
    });
    await new Promise((resolve) => setImmediate(resolve));
    signIns.end(STATE);
    finishProbe(false);
    await expect(opening).rejects.toThrow('cancelled');
    expect(opened).toEqual([]);
    expect(signIns.listening).toBeNull();
    expect(await answers(port)).toBe(false);
  });

  it('closes a listener bound after the session ended and opens nothing', async () => {
    const { signIns, port, opened } = await setup();
    const listen = jest
      .spyOn(NetServer.prototype, 'listen')
      .mockImplementationOnce(function (
        this: NetServer,
        ...args: Parameters<NetServer['listen']>
      ): NetServer {
        signIns.closeAll();
        listen.mockRestore();
        return this.listen(...args);
      });
    try {
      await expect(
        signIns.open({ provider: 'claude', url: PAGE, state: STATE }),
      ).rejects.toThrow('cancelled');
    } finally {
      listen.mockRestore();
    }
    expect(opened).toEqual([]);
    expect(signIns.listening).toBeNull();
    await waitUntilClosed(port);
  });
});
