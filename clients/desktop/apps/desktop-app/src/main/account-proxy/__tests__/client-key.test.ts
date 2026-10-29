import type * as ManagementClient from '../management-client';

const serverKeys: { list: string[] } = { list: [] };
/** Runs after each of this device's writes: another device's stale write. */
let afterWrite: (() => void) | null = null;

jest.mock('../management-client', () => ({
  ...jest.requireActual<typeof ManagementClient>('../management-client'),
  requestAccountProxyManagement: jest.fn(
    (request: { method: string; body?: unknown }) => {
      if (request.method === 'PUT') {
        serverKeys.list = Array.isArray(request.body)
          ? request.body.filter((key): key is string => typeof key === 'string')
          : [];
        const other = afterWrite;
        afterWrite = null;
        // The other device's PUT lands after this device read its own back.
        if (other) setTimeout(other, 10);
        return Promise.resolve({ version: '8.0.27', body: { status: 'ok' } });
      }
      return Promise.resolve({ version: '8.0.27', body: [...serverKeys.list] });
    },
  ),
}));

import { ensureAccountProxyClientKey } from '../client-key';

const CONNECTION = {
  id: 'connection-1',
  kind: 'server' as const,
  url: 'https://proxy.example.com',
};

describe('ensureAccountProxyClientKey', () => {
  beforeEach(() => {
    serverKeys.list = ['ck-other'];
    afterWrite = null;
  });

  it('adds its key back when another device overwrote the list', async () => {
    // Another device read the list before this device wrote, and writes its
    // own key over it just after this device confirmed.
    afterWrite = (): void => {
      serverKeys.list = ['ck-other', 'canopy-second-device'];
    };

    const key = await ensureAccountProxyClientKey(CONNECTION, 'mk', null, {
      settleMs: 50,
    });

    expect(key).toMatch(/^canopy-[a-f0-9]{48}$/);
    expect(serverKeys.list).toEqual(['ck-other', 'canopy-second-device', key]);
  });

  it('keeps a key the server still lists without writing', async () => {
    serverKeys.list = ['ck-other', 'canopy-mine'];
    await expect(
      ensureAccountProxyClientKey(CONNECTION, 'mk', 'canopy-mine', {
        settleMs: 0,
      }),
    ).resolves.toBe('canopy-mine');
    expect(serverKeys.list).toEqual(['ck-other', 'canopy-mine']);
  });
});
