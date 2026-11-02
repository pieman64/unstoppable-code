import {
  createW5ConfinedFileReader,
  windowsW5ConfinedFileReader,
} from '../w5-confined-read';

// The TS half of Windows W5 capture confinement (CAN-5202): what the addon's
// results may say, and when no reader exists. The native walk itself is
// exercised on Windows by w5-confined-read.windows.test.ts.

const IO = { state: 'unreadable', reason: 'io' };

describe('createW5ConfinedFileReader', () => {
  it.each<readonly [string, unknown, unknown]>([
    ['absent', { state: 'absent' }, { state: 'absent' }],
    ['too-large', { state: 'too-large' }, { state: 'too-large' }],
    ...(['root-unavailable', 'root-changed'] as const).map(
      (state) => [state, { state }, { state }] as const,
    ),
    ...(['unsafe-path', 'not-file', 'io'] as const).map(
      (reason) =>
        [
          `unreadable ${reason}`,
          { state: 'unreadable', reason },
          { state: 'unreadable', reason },
        ] as const,
    ),
    ['an unknown reason', { state: 'unreadable', reason: 'denied' }, IO],
    ['an unknown state', { state: 'present-ish' }, IO],
    ['present without bytes', { state: 'present' }, IO],
    ['present with text', { state: 'present', bytes: 'secret' }, IO],
    [
      'present beyond the allowed bytes',
      { state: 'present', bytes: Buffer.alloc(5) },
      IO,
    ],
    ['null', null, IO],
    ['a string', 'present', IO],
  ])('reads %s', async (_name, native, expected) => {
    const reader = createW5ConfinedFileReader(() => native);
    await expect(reader.read('C:\\root', ['index.json'], 4)).resolves.toEqual(
      expected,
    );
  });

  it('passes bytes within the bound through and the request as a fresh array', async () => {
    const bytes = Buffer.from('four');
    const calls: unknown[][] = [];
    const reader = createW5ConfinedFileReader((...args) => {
      calls.push(args);
      return { state: 'present', bytes };
    });
    const components = Object.freeze(['alpha', 'workspace.json']);
    await expect(reader.read('C:\\root', components, 4)).resolves.toEqual({
      state: 'present',
      bytes,
    });
    expect(calls).toEqual([['C:\\root', ['alpha', 'workspace.json'], 4]]);
    expect(calls[0]?.[1]).not.toBe(components);
  });

  it('reads a throwing addon call as io', async () => {
    const reader = createW5ConfinedFileReader(() => {
      throw Object.assign(new Error('invalid'), {
        code: 'ERR_CONFINED_READ_ARGUMENT',
      });
    });
    await expect(reader.read('C:\\root', ['..'], 4)).resolves.toEqual(IO);
  });
});

// The Windows owned-child addon's other calls, which every load requires.
const OWNED_CHILD = Object.fromEntries(
  [
    'spawn',
    'observe',
    'stopGroup',
    'members',
    'release',
    'commit',
    'rollbackSync',
    'rollbackUndelivered',
  ].map((name) => [name, (): null => null]),
);

describe('windowsW5ConfinedFileReader', () => {
  it.each([
    ['darwin', 'C:\\app\\resources\\cli\\core-owned-child.node'],
    ['linux', '/app/core-owned-child.node'],
    [null, 'C:\\app\\resources\\cli\\core-owned-child.node'],
    ['win32', undefined],
    ['win32', 'core-owned-child.node'],
    ['win32', '\\resources\\cli\\core-owned-child.node'],
    ['win32', '\\\\?\\C:\\app\\core-owned-child.node'],
  ] as const)(
    'has no reader on %s with addon %p, without loading anything',
    (os, nativePath) => {
      const dlopen = jest.spyOn(process, 'dlopen');
      try {
        expect(windowsW5ConfinedFileReader(os, nativePath)()).toBeNull();
        expect(dlopen).not.toHaveBeenCalled();
      } finally {
        dlopen.mockRestore();
      }
    },
  );

  it('loads the addon once and reports no reader when it fails to load', () => {
    const dlopen = jest.spyOn(process, 'dlopen').mockImplementation(() => {
      throw new Error('missing');
    });
    try {
      const source = windowsW5ConfinedFileReader(
        'win32',
        'C:\\missing\\core-owned-child.node',
      );
      expect(source()).toBeNull();
      expect(source()).toBeNull();
      expect(dlopen).toHaveBeenCalledTimes(1);
    } finally {
      dlopen.mockRestore();
    }
  });

  it('reports no reader for an addon without readConfinedFile', () => {
    const dlopen = jest
      .spyOn(process, 'dlopen')
      .mockImplementation((module: object) => {
        Reflect.set(module, 'exports', {
          ...OWNED_CHILD,
          setExecutionState: () => true,
        });
      });
    try {
      expect(
        windowsW5ConfinedFileReader(
          'win32',
          'C:\\app\\resources\\cli\\core-owned-child.node',
        )(),
      ).toBeNull();
    } finally {
      dlopen.mockRestore();
    }
  });

  it('reports no reader for an addon that is not the owned-child addon', () => {
    const dlopen = jest
      .spyOn(process, 'dlopen')
      .mockImplementation((module: object) => {
        Reflect.set(module, 'exports', {
          readConfinedFile: () => ({ state: 'absent' }),
        });
      });
    try {
      expect(
        windowsW5ConfinedFileReader(
          'win32',
          'C:\\app\\resources\\cli\\core-owned-child.node',
        )(),
      ).toBeNull();
    } finally {
      dlopen.mockRestore();
    }
  });

  it('calls the loaded addon with its own exports as the receiver', async () => {
    const native = {
      ...OWNED_CHILD,
      readConfinedFile(this: unknown, ...args: unknown[]): unknown {
        return this === native && args.length === 3
          ? { state: 'absent' }
          : { state: 'wrong' };
      },
    };
    const dlopen = jest
      .spyOn(process, 'dlopen')
      .mockImplementation((module: object) => {
        Reflect.set(module, 'exports', native);
      });
    try {
      const source = windowsW5ConfinedFileReader(
        'win32',
        '\\\\server\\share\\cli\\core-owned-child.node',
      );
      const reader = source();
      expect(reader).not.toBeNull();
      expect(source()).toBe(reader);
      await expect(
        reader?.read('C:\\root', ['index.json'], 1),
      ).resolves.toEqual({ state: 'absent' });
    } finally {
      dlopen.mockRestore();
    }
  });
});
