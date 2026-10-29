import { AppleSpeechBridgeProvider } from '../apple-speech-bridge';
import {
  VoicePermissionError,
  VoiceSpeechPermissionError,
} from '../voice-types';

jest.mock('../pcm-worklet', () => ({
  getPcmWorkletModuleUrl: (): string => 'blob:canopy-pcm-worklet',
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface VoiceApiMock {
  isSupported: jest.Mock<Promise<{ supported: boolean }>, []>;
  requestSystemAccess: jest.Mock<
    Promise<{
      microphone: 'granted' | 'denied' | 'restricted' | 'unavailable';
      speechRecognition: 'authorized' | 'denied' | 'restricted' | 'unavailable';
    }>,
    []
  >;
  start: jest.Mock<Promise<void>, [{ sessionId: string }]>;
  cancel: jest.Mock<Promise<void>, [{ sessionId: string }]>;
  stop: jest.Mock<Promise<void>, [{ sessionId: string }]>;
  pushAudio: jest.Mock<
    Promise<void>,
    [{ sessionId: string; pcm: ArrayBuffer }]
  >;
  onEvent: jest.Mock<() => void, [(event: unknown) => void]>;
}

interface MockMediaStreamSource {
  connect?: (destination: unknown) => void;
  disconnect: () => void;
}

interface AudioHarness {
  addModuleMock: jest.Mock<Promise<void>, [string]>;
  closeMock: jest.Mock<Promise<void>, []>;
  createMediaStreamSourceMock: jest.Mock<MockMediaStreamSource, [unknown]>;
  audioWorkletNodeConstructMock: jest.Mock<void, []>;
  trackStopMock: jest.Mock<void, []>;
  getUserMediaMock?: jest.Mock<
    Promise<{ getTracks: () => Array<{ stop: () => void }> }>,
    []
  >;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (resolveFn) {
        resolveFn(value);
      }
    },
  };
}

function installVoiceGlobals(
  voiceApi: VoiceApiMock,
  harness: AudioHarness,
): void {
  class MockAudioContext {
    readonly audioWorklet: { addModule: jest.Mock<Promise<void>, [string]> };

    constructor(options?: { sampleRate: number }) {
      void options;
      this.audioWorklet = { addModule: harness.addModuleMock };
    }

    createMediaStreamSource(stream: unknown): MockMediaStreamSource {
      return harness.createMediaStreamSourceMock(stream);
    }

    close(): Promise<void> {
      return harness.closeMock();
    }
  }

  class MockAudioWorkletNode {
    readonly port: {
      onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
    };

    constructor(
      audioContext: unknown,
      name: string,
      options: { numberOfInputs: number; numberOfOutputs: number },
    ) {
      void audioContext;
      void name;
      void options;
      harness.audioWorkletNodeConstructMock();
      this.port = { onmessage: null };
    }

    disconnect(): void {
      return;
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        voice: voiceApi,
      },
    },
  });
  const getUserMediaMock =
    harness.getUserMediaMock ??
    jest.fn<Promise<{ getTracks: () => Array<{ stop: () => void }> }>, []>(() =>
      Promise.resolve({
        getTracks: (): Array<{ stop: () => void }> => [
          { stop: harness.trackStopMock },
        ],
      }),
    );

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    },
  });
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: MockAudioContext,
  });
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: MockAudioWorkletNode,
  });
}

describe('AppleSpeechBridgeProvider', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'AudioWorkletNode', {
      configurable: true,
      value: undefined,
    });
    jest.clearAllMocks();
  });

  it('cleans up the microphone stream and audio context when addModule fails', async () => {
    const harness: AudioHarness = {
      addModuleMock: jest.fn<Promise<void>, [string]>((url: string) => {
        void url;
        return Promise.reject(new Error('worklet failed'));
      }),
      closeMock: jest.fn<Promise<void>, []>(() => Promise.resolve()),
      createMediaStreamSourceMock: jest.fn<MockMediaStreamSource, [unknown]>(
        (stream: unknown) => {
          void stream;
          return {
            disconnect: (): void => {
              return;
            },
          };
        },
      ),
      audioWorkletNodeConstructMock: jest.fn<void, []>(),
      trackStopMock: jest.fn<void, []>(),
    };
    const voiceApi: VoiceApiMock = {
      isSupported: jest.fn<Promise<{ supported: boolean }>, []>(() =>
        Promise.resolve({ supported: true }),
      ),
      requestSystemAccess: jest.fn(() =>
        Promise.resolve({
          microphone: 'granted',
          speechRecognition: 'authorized',
        }),
      ),
      start: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      cancel: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      stop: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      pushAudio: jest.fn<
        Promise<void>,
        [{ sessionId: string; pcm: ArrayBuffer }]
      >((request: { sessionId: string; pcm: ArrayBuffer }) => {
        void request;
        return Promise.resolve();
      }),
      onEvent: jest.fn<() => void, [(event: unknown) => void]>(
        (eventHandler: (event: unknown) => void) => {
          void eventHandler;
          return (): void => {
            return;
          };
        },
      ),
    };
    installVoiceGlobals(voiceApi, harness);

    const provider = new AppleSpeechBridgeProvider();

    await expect(
      provider.start({
        onInterim: (): void => {
          return;
        },
        onFinal: (): void => {
          return;
        },
        onStopped: (): void => {
          return;
        },
        onError: (): void => {
          return;
        },
      }),
    ).rejects.toThrow('worklet failed');

    expect(harness.trackStopMock).toHaveBeenCalledTimes(1);
    expect(harness.closeMock).toHaveBeenCalledTimes(1);
    expect(voiceApi.start).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', 'denied'],
    ['restricted', 'restricted'],
    ['not-determined', 'not-determined'],
    ['unknown', 'unavailable'],
  ] as const)(
    'does not open a renderer microphone stream when system microphone access is %s',
    async (microphone, expectedReason) => {
      const harness: AudioHarness = {
        addModuleMock: jest.fn<Promise<void>, [string]>((url: string) => {
          void url;
          return Promise.resolve();
        }),
        closeMock: jest.fn<Promise<void>, []>(() => Promise.resolve()),
        createMediaStreamSourceMock: jest.fn<
          { disconnect: () => void },
          [unknown]
        >((stream: unknown) => {
          void stream;
          return {
            disconnect: (): void => {
              return;
            },
          };
        }),
        audioWorkletNodeConstructMock: jest.fn<void, []>(),
        trackStopMock: jest.fn<void, []>(),
        getUserMediaMock: jest.fn(() =>
          Promise.reject(new Error('Permission denied')),
        ),
      };
      const voiceApi: VoiceApiMock = {
        isSupported: jest.fn<Promise<{ supported: boolean }>, []>(() =>
          Promise.resolve({ supported: true }),
        ),
        requestSystemAccess: jest.fn(() =>
          Promise.resolve({
            microphone,
            speechRecognition: 'authorized',
          }),
        ),
        start: jest.fn<Promise<void>, [{ sessionId: string }]>(
          (request: { sessionId: string }) => {
            void request;
            return Promise.resolve();
          },
        ),
        cancel: jest.fn<Promise<void>, [{ sessionId: string }]>(
          (request: { sessionId: string }) => {
            void request;
            return Promise.resolve();
          },
        ),
        stop: jest.fn<Promise<void>, [{ sessionId: string }]>(
          (request: { sessionId: string }) => {
            void request;
            return Promise.resolve();
          },
        ),
        pushAudio: jest.fn<
          Promise<void>,
          [{ sessionId: string; pcm: ArrayBuffer }]
        >((request: { sessionId: string; pcm: ArrayBuffer }) => {
          void request;
          return Promise.resolve();
        }),
        onEvent: jest.fn<() => void, [(event: unknown) => void]>(
          (eventHandler: (event: unknown) => void) => {
            void eventHandler;
            return (): void => {
              return;
            };
          },
        ),
      };
      installVoiceGlobals(voiceApi, harness);

      const provider = new AppleSpeechBridgeProvider();

      await expect(
        provider.start({
          onInterim: (): void => {
            return;
          },
          onFinal: (): void => {
            return;
          },
          onStopped: (): void => {
            return;
          },
          onError: (): void => {
            return;
          },
        }),
      ).rejects.toMatchObject({
        name: 'VoiceMicrophoneError',
        reason: expectedReason,
      });

      expect(harness.getUserMediaMock).not.toHaveBeenCalled();
      expect(voiceApi.requestSystemAccess).toHaveBeenCalledTimes(1);
      expect(voiceApi.start).not.toHaveBeenCalled();
    },
  );

  it.each(['denied', 'restricted'] as const)(
    'does not open a renderer microphone stream when speech recognition access is %s',
    async (speechRecognition) => {
      const harness: AudioHarness = {
        addModuleMock: jest.fn<Promise<void>, [string]>((url: string) => {
          void url;
          return Promise.resolve();
        }),
        closeMock: jest.fn<Promise<void>, []>(() => Promise.resolve()),
        createMediaStreamSourceMock: jest.fn<
          { disconnect: () => void },
          [unknown]
        >((stream: unknown) => {
          void stream;
          return {
            disconnect: (): void => {
              return;
            },
          };
        }),
        audioWorkletNodeConstructMock: jest.fn<void, []>(),
        trackStopMock: jest.fn<void, []>(),
        getUserMediaMock: jest.fn(() =>
          Promise.resolve({
            getTracks: (): Array<{ stop: () => void }> => [
              { stop: harness.trackStopMock },
            ],
          }),
        ),
      };
      const voiceApi: VoiceApiMock = {
        isSupported: jest.fn<Promise<{ supported: boolean }>, []>(() =>
          Promise.resolve({ supported: true }),
        ),
        requestSystemAccess: jest.fn(() =>
          Promise.resolve({
            microphone: 'granted',
            speechRecognition,
          }),
        ),
        start: jest.fn<Promise<void>, [{ sessionId: string }]>(
          (request: { sessionId: string }) => {
            void request;
            return Promise.resolve();
          },
        ),
        cancel: jest.fn<Promise<void>, [{ sessionId: string }]>(
          (request: { sessionId: string }) => {
            void request;
            return Promise.resolve();
          },
        ),
        stop: jest.fn<Promise<void>, [{ sessionId: string }]>(
          (request: { sessionId: string }) => {
            void request;
            return Promise.resolve();
          },
        ),
        pushAudio: jest.fn<
          Promise<void>,
          [{ sessionId: string; pcm: ArrayBuffer }]
        >((request: { sessionId: string; pcm: ArrayBuffer }) => {
          void request;
          return Promise.resolve();
        }),
        onEvent: jest.fn<() => void, [(event: unknown) => void]>(
          (eventHandler: (event: unknown) => void) => {
            void eventHandler;
            return (): void => {
              return;
            };
          },
        ),
      };
      installVoiceGlobals(voiceApi, harness);

      const provider = new AppleSpeechBridgeProvider();

      await expect(
        provider.start({
          onInterim: (): void => {
            return;
          },
          onFinal: (): void => {
            return;
          },
          onStopped: (): void => {
            return;
          },
          onError: (): void => {
            return;
          },
        }),
      ).rejects.toBeInstanceOf(VoiceSpeechPermissionError);

      expect(harness.getUserMediaMock).not.toHaveBeenCalled();
      expect(harness.trackStopMock).not.toHaveBeenCalled();
      expect(voiceApi.start).not.toHaveBeenCalled();
    },
  );

  it('surfaces the microphone error first when microphone and speech access are denied', async () => {
    const harness: AudioHarness = {
      addModuleMock: jest.fn<Promise<void>, [string]>((url: string) => {
        void url;
        return Promise.resolve();
      }),
      closeMock: jest.fn<Promise<void>, []>(() => Promise.resolve()),
      createMediaStreamSourceMock: jest.fn<MockMediaStreamSource, [unknown]>(
        (stream: unknown) => {
          void stream;
          return {
            disconnect: (): void => {
              return;
            },
          };
        },
      ),
      audioWorkletNodeConstructMock: jest.fn<void, []>(),
      trackStopMock: jest.fn<void, []>(),
      getUserMediaMock: jest.fn(() =>
        Promise.reject(new Error('Permission denied')),
      ),
    };
    const voiceApi: VoiceApiMock = {
      isSupported: jest.fn<Promise<{ supported: boolean }>, []>(() =>
        Promise.resolve({ supported: true }),
      ),
      requestSystemAccess: jest.fn(() =>
        Promise.resolve({
          microphone: 'denied',
          speechRecognition: 'denied',
        }),
      ),
      start: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      cancel: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      stop: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      pushAudio: jest.fn<
        Promise<void>,
        [{ sessionId: string; pcm: ArrayBuffer }]
      >((request: { sessionId: string; pcm: ArrayBuffer }) => {
        void request;
        return Promise.resolve();
      }),
      onEvent: jest.fn<() => void, [(event: unknown) => void]>(
        (eventHandler: (event: unknown) => void) => {
          void eventHandler;
          return (): void => {
            return;
          };
        },
      ),
    };
    installVoiceGlobals(voiceApi, harness);

    const provider = new AppleSpeechBridgeProvider();

    await expect(
      provider.start({
        onInterim: (): void => {
          return;
        },
        onFinal: (): void => {
          return;
        },
        onStopped: (): void => {
          return;
        },
        onError: (): void => {
          return;
        },
      }),
    ).rejects.toBeInstanceOf(VoicePermissionError);

    expect(harness.getUserMediaMock).not.toHaveBeenCalled();
    expect(voiceApi.start).not.toHaveBeenCalled();
  });

  it('stops the renderer media stream when cancelled while speech access is pending', async () => {
    const speechAccessDeferred = createDeferred<{
      microphone: 'granted';
      speechRecognition: 'authorized';
    }>();
    const harness: AudioHarness = {
      addModuleMock: jest.fn<Promise<void>, [string]>((url: string) => {
        void url;
        return Promise.resolve();
      }),
      closeMock: jest.fn<Promise<void>, []>(() => Promise.resolve()),
      createMediaStreamSourceMock: jest.fn<
        { disconnect: () => void },
        [unknown]
      >((stream: unknown) => {
        void stream;
        return {
          disconnect: (): void => {
            return;
          },
        };
      }),
      audioWorkletNodeConstructMock: jest.fn<void, []>(),
      trackStopMock: jest.fn<void, []>(),
      getUserMediaMock: jest.fn(() =>
        Promise.resolve({
          getTracks: (): Array<{ stop: () => void }> => [
            { stop: harness.trackStopMock },
          ],
        }),
      ),
    };
    const voiceApi: VoiceApiMock = {
      isSupported: jest.fn<Promise<{ supported: boolean }>, []>(() =>
        Promise.resolve({ supported: true }),
      ),
      requestSystemAccess: jest.fn(() => speechAccessDeferred.promise),
      start: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      cancel: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      stop: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      pushAudio: jest.fn<
        Promise<void>,
        [{ sessionId: string; pcm: ArrayBuffer }]
      >((request: { sessionId: string; pcm: ArrayBuffer }) => {
        void request;
        return Promise.resolve();
      }),
      onEvent: jest.fn<() => void, [(event: unknown) => void]>(
        (eventHandler: (event: unknown) => void) => {
          void eventHandler;
          return (): void => {
            return;
          };
        },
      ),
    };
    installVoiceGlobals(voiceApi, harness);

    const provider = new AppleSpeechBridgeProvider();
    const startPromise = provider.start({
      onInterim: (): void => {
        return;
      },
      onFinal: (): void => {
        return;
      },
      onStopped: (): void => {
        return;
      },
      onError: (): void => {
        return;
      },
    });

    await flushMicrotasks();
    expect(voiceApi.requestSystemAccess).toHaveBeenCalledTimes(1);
    await provider.cancel();
    speechAccessDeferred.resolve({
      microphone: 'granted',
      speechRecognition: 'authorized',
    });
    await expect(startPromise).resolves.toBeUndefined();

    expect(harness.trackStopMock).not.toHaveBeenCalled();
    expect(voiceApi.start).not.toHaveBeenCalled();
    expect(harness.createMediaStreamSourceMock).not.toHaveBeenCalled();
  });

  it('does not let a stale speech access request dispose a newer session', async () => {
    const firstSpeechAccessDeferred = createDeferred<{
      microphone: 'granted';
      speechRecognition: 'authorized';
    }>();
    const firstTrackStopMock = jest.fn<void, []>();
    const secondTrackStopMock = jest.fn<void, []>();
    const harness: AudioHarness = {
      addModuleMock: jest.fn<Promise<void>, [string]>((url: string) => {
        void url;
        return Promise.resolve();
      }),
      closeMock: jest.fn<Promise<void>, []>(() => Promise.resolve()),
      createMediaStreamSourceMock: jest.fn<MockMediaStreamSource, [unknown]>(
        (stream: unknown) => {
          void stream;
          return {
            connect: (destination: unknown): void => {
              void destination;
            },
            disconnect: (): void => {
              return;
            },
          };
        },
      ),
      audioWorkletNodeConstructMock: jest.fn<void, []>(),
      trackStopMock: jest.fn<void, []>(),
      getUserMediaMock: jest
        .fn<Promise<{ getTracks: () => Array<{ stop: () => void }> }>, []>()
        .mockResolvedValueOnce({
          getTracks: (): Array<{ stop: () => void }> => [
            { stop: firstTrackStopMock },
          ],
        })
        .mockResolvedValueOnce({
          getTracks: (): Array<{ stop: () => void }> => [
            { stop: secondTrackStopMock },
          ],
        }),
    };
    const voiceApi: VoiceApiMock = {
      isSupported: jest.fn<Promise<{ supported: boolean }>, []>(() =>
        Promise.resolve({ supported: true }),
      ),
      requestSystemAccess: jest
        .fn<
          Promise<{
            microphone: 'granted';
            speechRecognition: 'authorized';
          }>,
          []
        >()
        .mockReturnValueOnce(firstSpeechAccessDeferred.promise)
        .mockResolvedValueOnce({
          microphone: 'granted',
          speechRecognition: 'authorized',
        }),
      start: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      cancel: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      stop: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      pushAudio: jest.fn<
        Promise<void>,
        [{ sessionId: string; pcm: ArrayBuffer }]
      >((request: { sessionId: string; pcm: ArrayBuffer }) => {
        void request;
        return Promise.resolve();
      }),
      onEvent: jest.fn<() => void, [(event: unknown) => void]>(
        (eventHandler: (event: unknown) => void) => {
          void eventHandler;
          return (): void => {
            return;
          };
        },
      ),
    };
    installVoiceGlobals(voiceApi, harness);

    const provider = new AppleSpeechBridgeProvider();
    const handlers = {
      onInterim: (): void => {
        return;
      },
      onFinal: (): void => {
        return;
      },
      onStopped: (): void => {
        return;
      },
      onError: (): void => {
        return;
      },
    };
    const staleStartPromise = provider.start(handlers);

    await flushMicrotasks();
    expect(voiceApi.requestSystemAccess).toHaveBeenCalledTimes(1);
    await provider.cancel();

    await expect(provider.start(handlers)).resolves.toBeUndefined();
    expect(voiceApi.requestSystemAccess).toHaveBeenCalledTimes(2);
    expect(firstTrackStopMock).not.toHaveBeenCalled();
    expect(secondTrackStopMock).not.toHaveBeenCalled();

    firstSpeechAccessDeferred.resolve({
      microphone: 'granted',
      speechRecognition: 'authorized',
    });
    await expect(staleStartPromise).resolves.toBeUndefined();

    expect(firstTrackStopMock).not.toHaveBeenCalled();
    expect(secondTrackStopMock).not.toHaveBeenCalled();
    expect(harness.createMediaStreamSourceMock).toHaveBeenCalledTimes(1);
  });

  it('does not finish startup after cancellation while the main-process start is still pending', async () => {
    const startDeferred = createDeferred<void>();
    const harness: AudioHarness = {
      addModuleMock: jest.fn<Promise<void>, [string]>((url: string) => {
        void url;
        return Promise.resolve();
      }),
      closeMock: jest.fn<Promise<void>, []>(() => Promise.resolve()),
      createMediaStreamSourceMock: jest.fn<
        { disconnect: () => void },
        [unknown]
      >((stream: unknown) => {
        void stream;
        return {
          disconnect: (): void => {
            return;
          },
        };
      }),
      audioWorkletNodeConstructMock: jest.fn<void, []>(),
      trackStopMock: jest.fn<void, []>(),
    };
    const voiceApi: VoiceApiMock = {
      isSupported: jest.fn<Promise<{ supported: boolean }>, []>(() =>
        Promise.resolve({ supported: true }),
      ),
      requestSystemAccess: jest.fn(() =>
        Promise.resolve({
          microphone: 'granted',
          speechRecognition: 'authorized',
        }),
      ),
      start: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }): Promise<void> => {
          void request;
          return startDeferred.promise;
        },
      ),
      cancel: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      stop: jest.fn<Promise<void>, [{ sessionId: string }]>(
        (request: { sessionId: string }) => {
          void request;
          return Promise.resolve();
        },
      ),
      pushAudio: jest.fn<
        Promise<void>,
        [{ sessionId: string; pcm: ArrayBuffer }]
      >((request: { sessionId: string; pcm: ArrayBuffer }) => {
        void request;
        return Promise.resolve();
      }),
      onEvent: jest.fn<() => void, [(event: unknown) => void]>(
        (eventHandler: (event: unknown) => void) => {
          void eventHandler;
          return (): void => {
            return;
          };
        },
      ),
    };
    installVoiceGlobals(voiceApi, harness);

    const provider = new AppleSpeechBridgeProvider();
    const startPromise = provider.start({
      onInterim: (): void => {
        return;
      },
      onFinal: (): void => {
        return;
      },
      onStopped: (): void => {
        return;
      },
      onError: (): void => {
        return;
      },
    });

    await flushMicrotasks();
    await flushMicrotasks();
    expect(voiceApi.start).toHaveBeenCalledTimes(1);
    await provider.cancel();
    startDeferred.resolve(undefined);
    await expect(startPromise).resolves.toBeUndefined();

    expect(voiceApi.cancel).toHaveBeenCalled();
    expect(harness.createMediaStreamSourceMock).not.toHaveBeenCalled();
  });
});
