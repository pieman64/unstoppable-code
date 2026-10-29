import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type {
  VoiceService as VoiceServiceClass,
  parseHelperEvent as parseHelperEventFn,
} from '../voice/service';

const spawnMock = jest.fn();
const execFileMock = jest.fn();
const existsSyncMock = jest.fn(() => true);
const getBundledDictateBinaryPathMock = jest.fn(
  () => '/mock/bin/canopy-dictate',
);
const getEnhancedEnvMock = jest.fn(() => ({ PATH: '/mock/bin' }));
const mockIsVoiceDictationPlatform = jest.fn(() => true);

jest.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

jest.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledDictateBinaryPath: getBundledDictateBinaryPathMock,
  getEnhancedEnv: getEnhancedEnvMock,
}));

jest.mock('@canopy/desktop-shared/platform-capabilities', () => ({
  isVoiceDictationPlatform: mockIsVoiceDictationPlatform,
}));

interface MockChildProcess extends EventEmitter {
  stdin: Writable & { end: jest.Mock };
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
}

function createMockChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  const stdin = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  }) as Writable & { end: jest.Mock };
  stdin.end = jest.fn();
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = jest.fn(() => true);
  return child;
}

function mockProbeSupported(): void {
  execFileMock.mockImplementationOnce(
    (
      _bin,
      _args,
      _opts,
      callback: (err: Error | null, stdout: string) => void,
    ) => {
      callback(null, JSON.stringify({ supported: true }) + '\n');
    },
  );
}

function mockProbeUnsupported(reason: string): void {
  execFileMock.mockImplementationOnce(
    (
      _bin,
      _args,
      _opts,
      callback: (err: Error | null, stdout: string) => void,
    ) => {
      callback(null, JSON.stringify({ supported: false, reason }) + '\n');
    },
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('parseHelperEvent', () => {
  let parseHelperEvent: typeof parseHelperEventFn;

  beforeAll(() => {
    ({ parseHelperEvent } = jest.requireActual('../voice/service'));
  });

  it('parses interim transcript events', () => {
    const event = parseHelperEvent(
      'session-1',
      JSON.stringify({ type: 'interim', text: 'hello' }),
    );
    expect(event).toEqual({
      type: 'interim',
      sessionId: 'session-1',
      text: 'hello',
    });
  });

  it('parses final transcript events', () => {
    const event = parseHelperEvent(
      'session-2',
      JSON.stringify({ type: 'final', text: 'hello world' }),
    );
    expect(event).toEqual({
      type: 'final',
      sessionId: 'session-2',
      text: 'hello world',
    });
  });

  it('parses stopped events', () => {
    const event = parseHelperEvent(
      'session-3',
      JSON.stringify({ type: 'stopped' }),
    );
    expect(event).toEqual({ type: 'stopped', sessionId: 'session-3' });
  });

  it('parses error events with a message', () => {
    const event = parseHelperEvent(
      'session-4',
      JSON.stringify({ type: 'error', message: 'mic busy' }),
    );
    expect(event).toEqual({
      type: 'error',
      sessionId: 'session-4',
      message: 'mic busy',
    });
  });

  it('falls back to a default message when error payload lacks one', () => {
    const event = parseHelperEvent(
      'session-5',
      JSON.stringify({ type: 'error' }),
    );
    expect(event).toEqual({
      type: 'error',
      sessionId: 'session-5',
      message: 'unknown error',
    });
  });

  it('emits an error event when the line is not valid JSON', () => {
    const event = parseHelperEvent('session-6', 'not json');
    expect(event).toEqual({
      type: 'error',
      sessionId: 'session-6',
      message: 'invalid helper output: not json',
    });
  });

  it('ignores unrecognized event types', () => {
    const event = parseHelperEvent(
      'session-7',
      JSON.stringify({ type: 'debug', text: 'info' }),
    );
    expect(event).toBeNull();
  });

  it('ignores non-object JSON values', () => {
    expect(parseHelperEvent('session-8', '"string"')).toBeNull();
    expect(parseHelperEvent('session-8', '42')).toBeNull();
    expect(parseHelperEvent('session-8', 'null')).toBeNull();
  });

  it('treats a missing text field as empty string on interim/final', () => {
    const event = parseHelperEvent(
      'session-9',
      JSON.stringify({ type: 'final' }),
    );
    expect(event).toEqual({ type: 'final', sessionId: 'session-9', text: '' });
  });
});

describe('VoiceService lifecycle', () => {
  let VoiceService: typeof VoiceServiceClass;

  beforeEach(() => {
    jest.resetModules();
    spawnMock.mockReset();
    execFileMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    getBundledDictateBinaryPathMock.mockReturnValue('/mock/bin/canopy-dictate');
    getEnhancedEnvMock.mockReturnValue({ PATH: '/mock/bin' });
    mockIsVoiceDictationPlatform.mockReset();
    mockIsVoiceDictationPlatform.mockReturnValue(true);
    ({ VoiceService } = jest.requireActual('../voice/service'));
  });

  it('rejects start when another session is still running', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    await service.start('session-a');

    mockProbeSupported();
    await expect(service.start('session-b')).rejects.toThrow(
      'Voice session already active',
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a concurrent start that arrives while the first probe is pending', async () => {
    const service = new VoiceService();
    const probeHandle: { resolve: (() => void) | null } = { resolve: null };
    execFileMock.mockImplementationOnce(
      (
        _bin,
        _args,
        _opts,
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        probeHandle.resolve = (): void => {
          callback(null, JSON.stringify({ supported: true }) + '\n');
        };
      },
    );

    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);

    const first = service.start('session-a');
    // Second start arrives while the first is still awaiting the probe.
    await expect(service.start('session-b')).rejects.toThrow(
      'Voice session already active',
    );

    probeHandle.resolve?.();
    await expect(first).resolves.toBeUndefined();

    // Only the first start must have spawned a helper. If the race were
    // unguarded, the second start would overwrite activeSession with a
    // second child and orphan the first.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('frees the pending slot when a pending start is cancelled', async () => {
    const service = new VoiceService();
    const probeHandle: { resolve: (() => void) | null } = { resolve: null };
    execFileMock.mockImplementationOnce(
      (
        _bin,
        _args,
        _opts,
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        probeHandle.resolve = (): void => {
          callback(null, JSON.stringify({ supported: true }) + '\n');
        };
      },
    );

    const firstStart = service.start('session-a');
    service.cancel('session-a');

    // With the slot freed, a new start must not be rejected by the pending
    // guard even though the original probe hasn't resolved yet.
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const secondStart = service.start('session-b');

    probeHandle.resolve?.();
    await expect(firstStart).resolves.toBeUndefined();
    await expect(secondStart).resolves.toBeUndefined();

    // Only 'B' spawned; 'A' was aborted before spawn.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('self-heals when the prior session child has already exited', async () => {
    const service = new VoiceService();
    const first = createMockChild();
    spawnMock.mockReturnValueOnce(first);
    mockProbeSupported();

    await service.start('session-a');
    first.exitCode = 0;

    const second = createMockChild();
    spawnMock.mockReturnValueOnce(second);
    mockProbeSupported();

    await expect(service.start('session-b')).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('stop() closes stdin but does not SIGTERM', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    await service.start('session-a');
    service.stop('session-a');

    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('stop() prevents later audio writes to ended stdin', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    const writeSpy = jest.spyOn(child.stdin, 'write');
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    await service.start('session-a');
    service.stop('session-a');
    service.pushAudio('session-a', Buffer.from('hello'));

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('cancel() sends SIGTERM and clears the active session', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    await service.start('session-a');
    service.cancel('session-a');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // A subsequent start must now succeed without throwing.
    const next = createMockChild();
    spawnMock.mockReturnValueOnce(next);
    mockProbeSupported();
    await expect(service.start('session-b')).resolves.toBeUndefined();
  });

  it('cancel() during a pending start aborts the spawn', async () => {
    const service = new VoiceService();
    const probeHandle: { resolve: (() => void) | null } = { resolve: null };
    execFileMock.mockImplementationOnce(
      (
        _bin,
        _args,
        _opts,
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        probeHandle.resolve = (): void => {
          callback(null, JSON.stringify({ supported: true }) + '\n');
        };
      },
    );

    const started = service.start('session-a');
    // Cancel before probe resolves.
    service.cancel('session-a');
    expect(probeHandle.resolve).not.toBeNull();
    probeHandle.resolve?.();
    await expect(started).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('emits an error event when the child exits with a non-zero code', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    const events: unknown[] = [];
    service.onEvent((event) => events.push(event));

    await service.start('session-a');
    child.stderr.emit('data', Buffer.from('boom\n'));
    child.emit('exit', 7, null);

    expect(events).toContainEqual({
      type: 'error',
      sessionId: 'session-a',
      message: 'boom',
    });
  });

  it('emits an error event when the child is terminated by a signal', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    const events: unknown[] = [];
    service.onEvent((event) => events.push(event));

    await service.start('session-a');
    child.emit('exit', null, 'SIGABRT');

    expect(events).toContainEqual({
      type: 'error',
      sessionId: 'session-a',
      message: 'Canopy Dictate terminated by SIGABRT',
    });
  });

  it('emits a synthetic stopped event when the child exits cleanly without one', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    const events: unknown[] = [];
    service.onEvent((event) => events.push(event));

    await service.start('session-a');
    child.emit('exit', 0, null);

    expect(events).toContainEqual({ type: 'stopped', sessionId: 'session-a' });
  });

  it('rejects start when support probe reports unsupported', async () => {
    const service = new VoiceService();
    mockProbeUnsupported('macOS too old');

    await expect(service.start('session-a')).rejects.toThrow(
      'Voice input unavailable: macOS too old',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('requests speech recognition access through the helper', async () => {
    const service = new VoiceService();
    execFileMock.mockImplementationOnce(
      (
        _bin,
        _args,
        _opts,
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({ speechRecognition: 'authorized' }) + '\n',
        );
      },
    );

    await expect(service.requestSpeechRecognitionAccess()).resolves.toBe(
      'authorized',
    );
    expect(execFileMock).toHaveBeenCalledWith(
      '/mock/bin/canopy-dictate',
      ['--request-authorization'],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it('returns unavailable when speech recognition access cannot resolve the helper', async () => {
    const service = new VoiceService();
    existsSyncMock.mockReturnValueOnce(false);

    await expect(service.requestSpeechRecognitionAccess()).resolves.toBe(
      'unavailable',
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('shutdown() sends SIGTERM to an active session', async () => {
    const service = new VoiceService();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    mockProbeSupported();

    await service.start('session-a');
    service.shutdown();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('shutdown() is a no-op when no session is active', () => {
    const service = new VoiceService();
    expect(() => service.shutdown()).not.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('shutdown() aborts a pending start so it does not spawn after the fact', async () => {
    const service = new VoiceService();
    const probeHandle: { resolve: (() => void) | null } = { resolve: null };
    execFileMock.mockImplementationOnce(
      (
        _bin,
        _args,
        _opts,
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        probeHandle.resolve = (): void => {
          callback(null, JSON.stringify({ supported: true }) + '\n');
        };
      },
    );

    const started = service.start('session-a');
    service.shutdown();
    probeHandle.resolve?.();
    await flushMicrotasks();
    await expect(started).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
