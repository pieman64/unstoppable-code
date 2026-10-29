import { rejection } from '../../__tests__/client-conformance';
import { validateCanopyEndpoint, validateCanopyTimeout } from '../endpoint';
import type { CanopyClientEndpoint } from '../index';

const auth = { secret: 'endpoint-secret', dataRootHash: 'a'.repeat(64) };
const at = (kind: 'socket' | 'pipe', path: string): CanopyClientEndpoint => ({
  kind,
  path,
  auth,
});
const thrown = (action: () => unknown): ReturnType<typeof rejection> =>
  rejection(Promise.resolve().then(action));

it('defaults the setup timeout to 10000 ms and accepts integers 1..2^31 - 1', async () => {
  expect(
    [undefined, 1, 2 ** 31 - 1].map((ms) => validateCanopyTimeout(ms)),
  ).toEqual([10_000, 1, 2 ** 31 - 1]);
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31])
    expect(await thrown(() => validateCanopyTimeout(timeoutMs))).toMatchObject({
      kind: 'invalid_argument',
    });
});

it('accepts sockets off Windows and standard pipe names on Windows only', async () => {
  validateCanopyEndpoint(at('socket', '/tmp/private/s'), 'darwin');
  validateCanopyEndpoint(at('socket', '/tmp/private/s'), 'linux');
  validateCanopyEndpoint(at('pipe', '\\\\.\\pipe\\private'), 'win32');
  validateCanopyEndpoint(at('pipe', '\\\\?\\pipe\\private'), 'win32');
  const rejected: [CanopyClientEndpoint, NodeJS.Platform, string][] = [
    [at('socket', '/tmp/private/s'), 'win32', 'capability_unavailable'],
    [at('pipe', '\\\\.\\pipe\\private'), 'darwin', 'capability_unavailable'],
    [at('socket', ''), 'linux', 'invalid_argument'],
    [at('pipe', ''), 'win32', 'invalid_argument'],
    [at('pipe', '\\\\.\\pipe\\'), 'win32', 'invalid_argument'],
    [at('pipe', '\\\\?\\pipe\\'), 'win32', 'invalid_argument'],
    [at('pipe', 'C:\\private\\pipe'), 'win32', 'invalid_argument'],
    [at('pipe', '\\\\host\\pipe\\private'), 'win32', 'invalid_argument'],
  ];
  for (const [endpoint, platform, kind] of rejected) {
    const payload = await thrown(() =>
      validateCanopyEndpoint(endpoint, platform),
    );
    expect({ endpoint, platform, kind: payload.kind }).toEqual({
      endpoint,
      platform,
      kind,
    });
    expect(JSON.stringify(payload)).not.toMatch(/private|endpoint-secret/);
  }
});
