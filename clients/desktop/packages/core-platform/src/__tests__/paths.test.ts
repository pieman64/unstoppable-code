import type { PlatformOperatingSystem as Os } from '@canopy/core-runtime';
import { createPlatformPathServices as P, PlatformPathError } from '../paths';

type Env = Readonly<Record<string, string | undefined>>;

function dirs(os: Os, home: string, env: Env = {}, app = 'A'): unknown[] {
  const d = P(os).appDataDir({ appName: app, homeDir: home, env });
  return [d.data, d.config, d.logs, d.runtime];
}

const rt = (os: Os, dataRoot: string): string =>
  P(os).runtimeDirectory({ dataRoot });

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PlatformPathError) return error.code;
    throw error;
  }
  return 'ok';
}

const INVALID = 'invalid_path';
const BAD_APP = 'invalid_app_name';
const ENV = { APPDATA: 'C:\\r' };
const HOSTS = [
  ['darwin', '/h'],
  ['linux', '/h'],
  ['win32', 'C:\\h'],
] as const;
const BAD_APPS = ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a\0b'];
const MAC = '/Library/Application Support/A';
const W = 'C:\\r\\A';
const U = '\\\\s\\p\\A';
const LINUX = ['/.local/share/A', '/.config/A', '/.config/A/logs', null];
const X = { XDG_DATA_HOME: '/d', XDG_CONFIG_HOME: '/c', XDG_RUNTIME_DIR: '/r' };
const RX = { XDG_DATA_HOME: 'd', XDG_CONFIG_HOME: '', XDG_RUNTIME_DIR: 'r' };

describe('createPlatformPathServices', () => {
  it.each<[Os, string, Env, unknown[]]>([
    ['darwin', '/', X, [MAC, MAC, '/Library/Logs/A', null]],
    ['win32', 'C:\\h', { APPDATA: 'C:/r' }, [W, W, `${W}\\logs`, null]],
    ['win32', '\\\\s\\h', { APPDATA: '\\\\s\\p' }, [U, U, `${U}\\logs`, null]],
    ['linux', '/', {}, LINUX],
    ['linux', '/', RX, LINUX],
    ['linux', '/', X, ['/d/A', '/c/A', '/c/A/logs', '/r/A']],
  ])('%s home %j env %j', (os, home, env, expected) => {
    expect(dirs(os, home, env)).toEqual(expected);
  });

  // Rejected as home, as data root, and on win32 as APPDATA.
  it.each<[Os, string]>([
    ['darwin', 'Users/a'],
    ['linux', ''],
    ['linux', '/h/\0a'],
    ['win32', 'C:h'],
    ['win32', '\\h'],
    ['win32', '/h'],
    ['win32', 'Roaming'],
    ['win32', '\\\\?\\C:\\h'],
    ['win32', '\\\\.\\C:\\h'],
    ['win32', '//?/UNC/s/p'],
    ['win32', '\\\\.\\pipe\\canopy'],
  ])('%s rejects path %j', (os, bad) => {
    const win = os === 'win32';
    const home = win ? 'C:\\h' : '/h';
    expect(codeOf(() => dirs(os, bad, ENV))).toBe(INVALID);
    expect(codeOf(() => dirs(os, home, { APPDATA: bad }))).toBe(
      win ? INVALID : 'ok',
    );
    expect(codeOf(() => rt(os, bad))).toBe(INVALID);
  });

  it('win32 fails closed without APPDATA', () => {
    expect(codeOf(() => dirs('win32', 'C:\\h'))).toBe(INVALID);
  });

  it.each(BAD_APPS)('rejects app name %j on every host', (app) => {
    for (const [os, home] of HOSTS) {
      expect(codeOf(() => dirs(os, home, ENV, app))).toBe(BAD_APP);
    }
  });

  // Windows-only leaf policy; POSIX accepts these names verbatim.
  const WIN_BAD = 'a< a> a" a| a? a* a. CON nul Prn.txt aux COM1 lpt9.log';
  it.each([...WIN_BAD.split(' '), 'a ', 'a\u0001'])(
    'win32 rejects app name %j',
    (app) => {
      expect(codeOf(() => dirs('win32', 'C:\\h', ENV, app))).toBe(BAD_APP);
      expect(dirs('linux', '/', {}, app)[0]).toBe(`/.local/share/${app}`);
    },
  );

  it.each(['CONIN$', 'conout$', 'CONIN$.txt', 'conout$.log'])(
    'win32 rejects console device app name %j',
    (app) => {
      expect(codeOf(() => dirs('win32', 'C:\\h', ENV, app))).toBe(BAD_APP);
    },
  );

  it.each(['COM0', 'LPT0'])('win32 accepts app name %j', (app) => {
    expect(dirs('win32', 'C:\\h', ENV, app)[0]).toBe(`C:\\r\\${app}`);
  });

  it.each<[Os, string, string]>([
    ['darwin', '/Users/a/Data', '/Users/a/Data/runtime'],
    ['linux', '/data/canopy/', '/data/canopy/runtime'],
    ['win32', 'D:/canopy', 'D:\\canopy\\runtime'],
    ['win32', '\\\\s\\share\\c', '\\\\s\\share\\c\\runtime'],
  ])('%s runtimeDirectory derives from %j', (os, dataRoot, expected) => {
    expect(rt(os, dataRoot)).toBe(expected);
  });

  it('ignores ambient process.env; explicit data root wins over XDG', () => {
    const saved = { ...process.env };
    Object.assign(process.env, X, { APPDATA: 'C:\\ambient' });
    try {
      expect(dirs('linux', '/')).toEqual(LINUX);
      expect(codeOf(() => dirs('win32', 'C:\\h'))).toBe(INVALID);
      expect(rt('linux', '/root')).toBe('/root/runtime');
    } finally {
      process.env = saved;
    }
  });
});
