import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  DAEMON_TERMINAL_LIMIT,
  daemonRestoreDirectory,
  noteDaemonTerminalFallback,
  isDaemonTerminalRouteEligible,
  type DaemonTerminalRouteInput,
} from '../daemon-terminal-route';

const ELIGIBLE: DaemonTerminalRouteInput = {
  platform: 'darwin',
  experimentEnabled: true,
  context: { localWindow: true },
  request: { projectId: 'project', worktreeId: 'task' },
  daemonLatched: false,
  daemonTerminals: 0,
};

describe('daemon terminal route eligibility (CAN-5088)', () => {
  it('places a renderer terminal from a local window on macOS and Linux', () => {
    expect(isDaemonTerminalRouteEligible(ELIGIBLE)).toBe(true);
    expect(
      isDaemonTerminalRouteEligible({ ...ELIGIBLE, platform: 'linux' }),
    ).toBe(true);
  });

  it.each<[string, Partial<DaemonTerminalRouteInput>]>([
    ['the experiment is off', { experimentEnabled: false }],
    ['the host is Windows (CAN-5091)', { platform: 'win32' }],
    ['the host is unknown', { platform: null }],
    ['the remote-control bridge sent it', { context: { localWindow: false } }],
    [
      'it is not a renderer request (Portal and every other caller)',
      { context: undefined },
    ],
    ['the daemon is latched unreachable', { daemonLatched: true }],
    [
      'the daemon holds its limit of terminals',
      { daemonTerminals: DAEMON_TERMINAL_LIMIT },
    ],
    [
      'it opens a shared-container terminal',
      {
        request: {
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'c',
        },
      },
    ],
    [
      'it runs a managed command',
      { request: { projectId: 'p', worktreeId: 't', managedCommand: {} } },
    ],
    [
      'it opens in a relative directory',
      { request: { projectId: 'p', worktreeId: 't', relativeCwd: 'src' } },
    ],
  ])('keeps the terminal in process when %s', (_case, change) => {
    expect(isDaemonTerminalRouteEligible({ ...ELIGIBLE, ...change })).toBe(
      false,
    );
  });
});

describe('daemonRestoreDirectory', () => {
  let root = '';
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'c5088-route-')));
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('keeps a persisted directory that still exists inside the root', () => {
    expect(daemonRestoreDirectory(root, join(root, 'src', 'lib'))).toEqual({
      cwdRelativePath: 'src/lib',
      cwd: join(root, 'src', 'lib'),
    });
  });

  it('falls back to the root for a missing, outside or relative directory', () => {
    for (const persisted of [join(root, 'gone'), join(root, '..'), 'src', root])
      expect(daemonRestoreDirectory(root, persisted)).toEqual({
        cwdRelativePath: '',
        cwd: root,
      });
  });
});

describe('noteDaemonTerminalFallback', () => {
  it('opens in process when a reached daemon cannot start its terminal host', () => {
    const unavailable = Object.assign(new Error('host'), {
      payload: { kind: 'unavailable', retry: { kind: 'never' } },
    });
    expect(noteDaemonTerminalFallback(unavailable)).toBe(true);
  });

  it('never opens a second terminal when a keyed create has an unknown outcome', () => {
    const uncertain = Object.assign(new Error('lost'), {
      payload: { kind: 'unavailable', retry: { kind: 'same_idempotency_key' } },
    });
    expect(noteDaemonTerminalFallback(uncertain)).toBe(false);
  });

  it('fails any other refusal from a reached daemon', () => {
    const refused = Object.assign(new Error('refused'), {
      payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
    });
    expect(noteDaemonTerminalFallback(refused)).toBe(false);
  });
});
