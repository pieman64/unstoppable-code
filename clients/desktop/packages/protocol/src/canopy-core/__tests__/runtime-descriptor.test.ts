import { CanopyRuntimeDescriptorSchema } from '../runtime-descriptor';

const descriptor = {
  version: 1,
  pid: 42,
  startIdentity: 'start-42',
  endpoint: { kind: 'socket', path: '/runtime/core.sock' },
  protocolRange: { min: 1, max: 2 },
  buildVersion: 'test',
  tokenRef: '/runtime/core.token',
};

it('accepts discovery metadata and drops additive fields', () => {
  expect(
    CanopyRuntimeDescriptorSchema.parse({ ...descriptor, future: true }),
  ).toEqual(descriptor);
});

it.each([{ version: undefined }, { version: 2 }, { version: '1' }])(
  'rejects a missing or unknown format version: %j',
  (fields) => {
    expect(
      CanopyRuntimeDescriptorSchema.safeParse({ ...descriptor, ...fields })
        .success,
    ).toBe(false);
  },
);

it('accepts a decimal POSIX socket identity', () => {
  const socketIdentity = { device: '0', inode: '18446744073709551615' };
  expect(
    CanopyRuntimeDescriptorSchema.parse({ ...descriptor, socketIdentity }),
  ).toEqual({ ...descriptor, socketIdentity });
});

it.each([
  { pid: 0 },
  { pid: Number.MAX_SAFE_INTEGER + 1 },
  { startIdentity: ' padded ' },
  { endpoint: { kind: 'http', path: '/runtime/core.sock' } },
  { protocolRange: { min: 2, max: 1 } },
  { tokenRef: '' },
  { buildVersion: '' },
  { socketIdentity: { device: '01', inode: '2' } },
  { socketIdentity: { device: '1', inode: '18446744073709551616' } },
  { socketIdentity: { device: '1', inode: 2 } },
  { socketIdentity: { device: '-1', inode: '2' } },
  { socketIdentity: { device: '1' } },
])('rejects malformed discovery metadata: %j', (fields) => {
  expect(
    CanopyRuntimeDescriptorSchema.safeParse({ ...descriptor, ...fields })
      .success,
  ).toBe(false);
});
