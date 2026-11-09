import { routeRendererRelayRequest } from '../relay-authority';

const event = { sender: { id: 1 } };

function localRelay(): {
  invoke: jest.Mock<Promise<{ ok: true; value: unknown }>, [unknown, unknown]>;
} {
  return {
    invoke: jest.fn<Promise<{ ok: true; value: unknown }>, [unknown, unknown]>(
      () => Promise.resolve({ ok: true as const, value: 'local' }),
    ),
  };
}

describe('canopy-core:relay authority routing (CAN-4185)', () => {
  it('sends a request without an authority to the local core unchanged', async () => {
    const local = localRelay();
    const request = { kind: 'request', method: 'core.chat.list', params: {} };
    await expect(
      routeRendererRelayRequest({ local }, event, request),
    ).resolves.toEqual({ ok: true, value: 'local' });
    expect(local.invoke).toHaveBeenCalledWith(event, request);
  });

  it('never sends a web core request to the local core', async () => {
    const local = localRelay();
    const reply = await routeRendererRelayRequest({ local }, event, {
      authority: 'web-core',
      kind: 'request',
      method: 'core.chat.list',
      params: {},
    });
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(local.invoke).not.toHaveBeenCalled();
  });

  it('refuses an unknown authority instead of treating it as local', async () => {
    const local = localRelay();
    for (const authority of ['local', 'desktop', null, undefined]) {
      const reply = await routeRendererRelayRequest({ local }, event, {
        authority,
        kind: 'close',
      });
      expect(reply).toMatchObject({
        ok: false,
        error: { kind: 'invalid_argument' },
      });
    }
    expect(local.invoke).not.toHaveBeenCalled();
  });
});
