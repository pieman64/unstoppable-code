import type {
  CanopyCoreRelayApi,
  CanopyCoreRelayReply,
  CanopyCoreRelayRequest,
} from '../../../../shared/canopy-core-relay';
import { createRelayCoreCoworkInvoker } from '../relay-invoker';

describe('cloud cowork relay invoker', () => {
  it('every call carries authority web-core', async () => {
    const requests: CanopyCoreRelayRequest[] = [];
    let reads = 0;
    const relay: CanopyCoreRelayApi = {
      invoke: (request): Promise<CanopyCoreRelayReply> => {
        requests.push(request);
        if (request.kind === 'openStream')
          return Promise.resolve({
            ok: true,
            value: { subscriptionId: 'sub-1', acceptedCursor: null },
          });
        if (request.kind === 'readStream') {
          reads += 1;
          // A quiet stream: the relay's read deadline passes once first.
          return Promise.resolve(
            reads === 1
              ? {
                  ok: false,
                  error: {
                    kind: 'deadline_exceeded',
                    message: 'The relay deadline passed.',
                    retry: { kind: 'never' },
                  },
                }
              : {
                  ok: true,
                  value: {
                    kind: 'item',
                    cursor: { daemonEpoch: 'feed', sequence: 1 },
                    item: { kind: 'resync' },
                  },
                },
          );
        }
        return Promise.resolve({ ok: true, value: null });
      },
    };
    const invoker = createRelayCoreCoworkInvoker(relay);

    await invoker.request('core.workspace.list', {});
    const stream = await invoker.openStream('core.chat.task.events', {
      scope: 'all',
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'item' },
    });
    await stream.close();

    expect(requests.map((request) => request.kind)).toEqual([
      'request',
      'openStream',
      'readStream',
      'readStream',
      'closeStream',
    ]);
    for (const request of requests) expect(request.authority).toBe('web-core');
  });
});
