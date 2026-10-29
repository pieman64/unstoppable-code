import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinuxIconResolver } from '../lib/linux-desktop-icons';

jest.mock('electron', () => ({
  nativeImage: { createFromBuffer: jest.fn(), createFromBitmap: jest.fn() },
}));

interface IconImage {
  isEmpty: () => boolean;
  resize: () => IconImage;
  toPNG: () => Buffer;
  toDataURL: () => string;
}

const { createFromBuffer, createFromBitmap } = jest.requireMock<{
  nativeImage: {
    createFromBuffer: jest.Mock<IconImage, [Buffer]>;
    createFromBitmap: jest.Mock<
      IconImage,
      [Buffer, { width: number; height: number }]
    >;
  };
}>('electron').nativeImage;
// Real filesystem fixtures use Linux/POSIX paths; Windows keeps the portable
// parser, launch, cache, and unchanged Windows application suites.
const testPosix =
  jest
    .requireActual<{
      hostOperatingSystem: () => 'darwin' | 'linux' | 'win32' | null;
    }>('@canopy/core-platform/host-platform')
    .hostOperatingSystem() === 'win32'
    ? test.skip
    : test;

const originalConfig = process.env.XDG_CONFIG_HOME;
let root: string;
let png: Buffer;

async function file(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

beforeEach(async () => {
  jest.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'linux-icons-'));
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);
  const image: IconImage = {
    isEmpty: () => false,
    resize: () => image,
    toPNG: () => Buffer.from('png'),
    toDataURL: () => 'data:image/png;base64,cG5n',
  };
  createFromBuffer.mockReturnValue(image);
  createFromBitmap.mockReturnValue(image);
});
afterEach(async () => {
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
  await rm(root, { recursive: true, force: true });
});

testPosix(
  'selected GTK theme inherits before hicolor and caches repeated requests',
  async () => {
    await file(
      join(root, 'config/gtk-3.0/settings.ini'),
      '[Settings]\ngtk-icon-theme-name=Selected\n',
    );
    await file(
      join(root, 'icons/Selected/index.theme'),
      '[Icon Theme]\nDirectories=64x64/apps\nInherits=Parent,hicolor\n',
    );
    await file(
      join(root, 'icons/Parent/index.theme'),
      '[Icon Theme]\nDirectories=48x48/apps\nInherits=Selected\n',
    );
    await file(join(root, 'icons/Parent/48x48/apps/editor.png'), png);
    await file(
      join(root, 'icons/hicolor/64x64/apps/editor.png'),
      Buffer.concat([png, Buffer.from('fallback')]),
    );
    const resolve = createLinuxIconResolver([root]);
    expect(await resolve('editor')).toBe('data:image/png;base64,cG5n');
    expect(createFromBuffer).toHaveBeenCalledWith(png);
    await resolve('editor');
    expect(createFromBuffer).toHaveBeenCalledTimes(1);
  },
);

testPosix(
  'never loads untrusted SVG, falls back to PNG or neutral artwork',
  async () => {
    await file(
      join(root, 'icons/Adwaita/scalable/apps/editor.svg'),
      '<svg onload="hostile"/>',
    );
    await file(join(root, 'icons/hicolor/64x64/apps/editor.png'), png);
    const resolve = createLinuxIconResolver([root]);
    expect(await resolve('editor')).toContain('data:image/png;');
    expect(
      await resolve(join(root, 'icons/Adwaita/scalable/apps/editor.svg')),
    ).toBe('');
    expect(await resolve('missing')).toBe('');
    expect(createFromBuffer).toHaveBeenCalledTimes(1);
  },
);

testPosix('uses pixmaps and bounded XPM bitmap decoding', async () => {
  await file(
    join(root, 'pixmaps/editor.xpm'),
    '/* XPM */\nstatic char *x[]={\n"1 1 1 1",\n"x c #ff0000",\n"x"\n};',
  );
  expect(await createLinuxIconResolver([root])('editor')).toContain(
    'data:image/png;',
  );
  expect(createFromBitmap).toHaveBeenCalledWith(Buffer.from([0, 0, 255, 255]), {
    width: 1,
    height: 1,
  });
});

testPosix.each([false, true])(
  'bounds parsing time for large newline-padded XPM (valid image: %s)',
  async (valid) => {
    const padding = '\n'.repeat(128 * 1024);
    const image = valid ? '  "1 1 1 1",\n\t"x c #ff0000",\n "x"\n' : '';
    const icon = join(root, 'padded.xpm');
    await file(icon, image + padding);
    const resolve = createLinuxIconResolver([root]);
    const start = performance.now();
    expect(await resolve(icon)).toBe(valid ? 'data:image/png;base64,cG5n' : '');
    // Includes async file IO. The old multiline whitespace matcher takes
    // seconds here; leave ample headroom for ordinary CI scheduling noise.
    expect(performance.now() - start).toBeLessThan(500);
    expect(createFromBitmap).toHaveBeenCalledTimes(valid ? 1 : 0);
  },
);

testPosix(
  'rejects oversized bytes and decompressed PNG dimensions before native decode',
  async () => {
    const huge = Buffer.from(png);
    huge.writeUInt32BE(100_000, 16);
    await file(join(root, 'huge.png'), huge);
    await file(join(root, 'large.png'), Buffer.alloc(1024 * 1024 + 1));
    await file(
      join(root, 'large.xpm'),
      '"1 1 1 1",\n"x c #ff0000",\n"x"\n' + ' '.repeat(384 * 1024),
    );
    const resolve = createLinuxIconResolver([root]);
    expect(await resolve(join(root, 'huge.png'))).toBe('');
    expect(await resolve(join(root, 'large.png'))).toBe('');
    expect(await resolve(join(root, 'large.xpm'))).toBe('');
    expect(createFromBuffer).not.toHaveBeenCalled();
    expect(createFromBitmap).not.toHaveBeenCalled();
  },
);

testPosix(
  'exhausted inherited-theme budget still checks final hicolor fallback',
  async () => {
    await file(
      join(root, 'config/gtk-3.0/settings.ini'),
      '[Settings]\ngtk-icon-theme-name=Chain0\n',
    );
    for (let i = 0; i < 20; i += 1) {
      await file(
        join(root, `icons/Chain${i}/index.theme`),
        `[Icon Theme]\nInherits=Chain${i + 1}\n`,
      );
    }
    await file(join(root, 'icons/hicolor/64x64/apps/editor.png'), png);
    expect(await createLinuxIconResolver([root])('editor')).toContain(
      'data:image/png;',
    );
  },
);
