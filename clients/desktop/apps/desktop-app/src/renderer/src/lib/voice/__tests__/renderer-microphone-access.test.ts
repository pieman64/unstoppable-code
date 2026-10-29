import {
  openRendererMicrophoneStream,
  requestRendererMicrophoneAccess,
} from '../renderer-microphone-access';
import { VoiceMicrophoneError, VoicePermissionError } from '../voice-types';

function installNavigatorMediaDevices(getUserMedia?: jest.Mock): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value:
      getUserMedia === undefined
        ? {}
        : {
            mediaDevices: {
              getUserMedia,
            },
          },
  });
}

describe('renderer microphone access', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: undefined,
    });
    jest.clearAllMocks();
  });

  it('opens a renderer microphone stream with the shared constraints', async () => {
    const stream = { getTracks: jest.fn() } as unknown as MediaStream;
    const getUserMedia = jest.fn<
      Promise<MediaStream>,
      [MediaStreamConstraints]
    >(() => Promise.resolve(stream));
    installNavigatorMediaDevices(getUserMedia);

    await expect(openRendererMicrophoneStream()).resolves.toBe(stream);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
      video: false,
    });
  });

  it('stops every acquired track when requesting access', async () => {
    const stopFirst = jest.fn<void, []>();
    const stopSecond = jest.fn<void, []>();
    const getUserMedia = jest.fn<
      Promise<MediaStream>,
      [MediaStreamConstraints]
    >(() =>
      Promise.resolve({
        getTracks: () =>
          [{ stop: stopFirst }, { stop: stopSecond }] as MediaStreamTrack[],
      } as MediaStream),
    );
    installNavigatorMediaDevices(getUserMedia);

    await expect(requestRendererMicrophoneAccess()).resolves.toBeUndefined();

    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(stopSecond).toHaveBeenCalledTimes(1);
  });

  it('throws VoicePermissionError without calling getUserMedia when unavailable', async () => {
    installNavigatorMediaDevices();

    await expect(requestRendererMicrophoneAccess()).rejects.toBeInstanceOf(
      VoicePermissionError,
    );
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no-input-device'],
    ['OverconstrainedError', 'no-input-device'],
    ['NotReadableError', 'device-unavailable'],
    ['AbortError', 'device-unavailable'],
  ])('maps a %s rejection to the %s reason', async (name, reason) => {
    const failure = new Error('capture failed');
    failure.name = name;
    const getUserMedia = jest.fn<
      Promise<MediaStream>,
      [MediaStreamConstraints]
    >(() => Promise.reject(failure));
    installNavigatorMediaDevices(getUserMedia);

    await expect(openRendererMicrophoneStream()).rejects.toMatchObject({
      name: 'VoiceMicrophoneError',
      reason,
    });
  });

  it('keeps an unrecognized rejection out of the typed reasons', async () => {
    const getUserMedia = jest.fn<
      Promise<MediaStream>,
      [MediaStreamConstraints]
    >(() => Promise.reject(new Error('something else entirely')));
    installNavigatorMediaDevices(getUserMedia);

    const error = await openRendererMicrophoneStream().catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(VoicePermissionError);
    expect(error).not.toBeInstanceOf(VoiceMicrophoneError);
  });

  it('wraps getUserMedia rejections in VoicePermissionError', async () => {
    const getUserMedia = jest.fn<
      Promise<MediaStream>,
      [MediaStreamConstraints]
    >(() => Promise.reject(new Error('Permission denied')));
    installNavigatorMediaDevices(getUserMedia);

    await expect(requestRendererMicrophoneAccess()).rejects.toMatchObject({
      name: 'VoicePermissionError',
      message: 'Permission denied',
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
