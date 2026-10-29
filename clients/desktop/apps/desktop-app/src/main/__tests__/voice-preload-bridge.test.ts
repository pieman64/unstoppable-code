import { EventEmitter } from 'node:events';
import {
  IPC_CHANNELS,
  type VoiceEventPayload,
} from '@canopy/desktop-shared/types';

const mockIpcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockServiceIsSupported = jest.fn();
const mockServiceOnEvent = jest.fn<
  void,
  [(event: VoiceEventPayload) => void]
>();
const mockServiceRequestSpeechRecognitionAccess = jest.fn();
const mockAskForMediaAccess = jest.fn();
const mockGetMediaAccessStatus = jest.fn();
const mockServiceStart = jest.fn();
const mockServiceCancel = jest.fn();

jest.mock('electron', () => ({
  shell: {
    openExternal: jest.fn(),
  },
  systemPreferences: {
    askForMediaAccess: mockAskForMediaAccess,
    getMediaAccessStatus: mockGetMediaAccessStatus,
  },
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (channel: string, handler: (...args: unknown[]) => unknown): void => {
      mockIpcHandlers.set(channel, handler);
    },
  ),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../voice/service', () => ({
  getVoiceService: jest.fn(() => ({
    onEvent: mockServiceOnEvent,
    isSupported: mockServiceIsSupported,
    resetSupportCache: jest.fn(),
    requestSpeechRecognitionAccess: mockServiceRequestSpeechRecognitionAccess,
    start: mockServiceStart,
    pushAudio: jest.fn(),
    stop: jest.fn(),
    cancel: mockServiceCancel,
  })),
}));

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

function setE2eVoiceFlow(flow: string | undefined): () => void {
  const originalE2e = Object.getOwnPropertyDescriptor(
    globalThis,
    '__CANOPY_E2E__',
  );
  const originalFlow = process.env.CANOPY_E2E_VOICE_ACCESS_FLOW;
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value: true,
  });
  if (flow === undefined) {
    delete process.env.CANOPY_E2E_VOICE_ACCESS_FLOW;
  } else {
    process.env.CANOPY_E2E_VOICE_ACCESS_FLOW = flow;
  }

  return (): void => {
    if (originalE2e) {
      Object.defineProperty(globalThis, '__CANOPY_E2E__', originalE2e);
    } else {
      Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
    }
    if (originalFlow === undefined) {
      delete process.env.CANOPY_E2E_VOICE_ACCESS_FLOW;
    } else {
      process.env.CANOPY_E2E_VOICE_ACCESS_FLOW = originalFlow;
    }
  };
}

describe('voice preload bridge', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockIpcHandlers.clear();
  });

  describe('a take and the page that started it', () => {
    // A page that reloads or goes away mid-take can no longer stop it, and
    // the still-running helper then refused every later start with "Voice
    // session already active" until the app restarted.
    async function startTake(sessionId: string): Promise<EventEmitter> {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);
      const page = new EventEmitter();
      await mockIpcHandlers.get(IPC_CHANNELS.voiceStart)?.(
        { sender: page },
        { sessionId },
      );
      return page;
    }

    it('ends the take when its page reloads', async () => {
      const restorePlatform = setPlatform('darwin');
      try {
        const page = await startTake('take-1');
        // An in-page navigation keeps the page, so the take goes on.
        page.emit('did-start-navigation', {
          isMainFrame: true,
          isSameDocument: true,
        });
        expect(mockServiceCancel).not.toHaveBeenCalled();

        page.emit('did-start-navigation', {
          isMainFrame: true,
          isSameDocument: false,
        });
        expect(mockServiceCancel).toHaveBeenCalledWith('take-1');
        expect(page.listenerCount('did-start-navigation')).toBe(0);
      } finally {
        restorePlatform();
      }
    });

    it('ends the take when its page goes away', async () => {
      const restorePlatform = setPlatform('darwin');
      try {
        const page = await startTake('take-2');
        page.emit('render-process-gone');
        expect(mockServiceCancel).toHaveBeenCalledWith('take-2');
        expect(page.listenerCount('destroyed')).toBe(0);
      } finally {
        restorePlatform();
      }
    });

    it('lets go of the page once the take stops on its own', async () => {
      const restorePlatform = setPlatform('darwin');
      try {
        const page = await startTake('take-3');
        const emit = mockServiceOnEvent.mock.calls[0]?.[0];
        emit?.({ type: 'stopped', sessionId: 'take-3' });
        expect(page.listenerCount('did-start-navigation')).toBe(0);
        expect(page.listenerCount('render-process-gone')).toBe(0);
        expect(page.listenerCount('destroyed')).toBe(0);
        page.emit('destroyed');
        expect(mockServiceCancel).not.toHaveBeenCalled();
      } finally {
        restorePlatform();
      }
    });

    it('does not hold the page when the take cannot start', async () => {
      const restorePlatform = setPlatform('darwin');
      mockServiceStart.mockRejectedValueOnce(
        new Error('Voice session already active'),
      );
      try {
        const { registerVoiceHandlers } =
          await import('../voice/preload-bridge');
        registerVoiceHandlers(() => null);
        const page = new EventEmitter();
        await expect(
          mockIpcHandlers.get(IPC_CHANNELS.voiceStart)?.(
            { sender: page },
            { sessionId: 'take-4' },
          ),
        ).rejects.toThrow('Voice session already active');
        expect(page.listenerCount('did-start-navigation')).toBe(0);
      } finally {
        restorePlatform();
      }
    });
  });

  it('reports a denied microphone for the deny-microphone E2E flow on macOS', async () => {
    const restorePlatform = setPlatform('darwin');
    const restoreFlow = setE2eVoiceFlow('deny-microphone');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      expect(mockIpcHandlers.get(IPC_CHANNELS.voiceIsSupported)?.()).toEqual({
        supported: true,
      });
      expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceGetMicrophoneAccess)?.(),
      ).toBe('denied');
      await expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceRequestSystemAccess)?.(),
      ).resolves.toEqual({
        microphone: 'denied',
        speechRecognition: 'denied',
      });
      // The fixed answer must not reach the real macOS privacy APIs.
      expect(mockGetMediaAccessStatus).not.toHaveBeenCalled();
      expect(mockAskForMediaAccess).not.toHaveBeenCalled();
    } finally {
      restoreFlow();
      restorePlatform();
    }
  });

  it('keeps the deny-microphone E2E flow platform-gated off macOS', async () => {
    // Without the gate the app would report unsupported and denied at once,
    // rendering a mic button whose start() throws.
    const restorePlatform = setPlatform('win32');
    const restoreFlow = setE2eVoiceFlow('deny-microphone');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      expect(mockIpcHandlers.get(IPC_CHANNELS.voiceIsSupported)?.()).toEqual({
        supported: false,
        reason: 'Voice dictation is only available on macOS.',
      });
      expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceGetMicrophoneAccess)?.(),
      ).toBe('unavailable');
      await expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceRequestSystemAccess)?.(),
      ).resolves.toEqual({
        microphone: 'unavailable',
        speechRecognition: 'unavailable',
      });
    } finally {
      restoreFlow();
      restorePlatform();
    }
  });

  it('keeps the grant-after-request E2E flow platform-gated off macOS', async () => {
    const restorePlatform = setPlatform('win32');
    const restoreFlow = setE2eVoiceFlow('grant-after-request');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceGetMicrophoneAccess)?.(),
      ).toBe('unavailable');
      await expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceRequestSystemAccess)?.(),
      ).resolves.toEqual({
        microphone: 'unavailable',
        speechRecognition: 'unavailable',
      });
    } finally {
      restoreFlow();
      restorePlatform();
    }
  });

  it('forces an unsupported capability through the existing E2E voice seam', async () => {
    const restorePlatform = setPlatform('darwin');
    const restoreFlow = setE2eVoiceFlow('unsupported');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      expect(mockIpcHandlers.get(IPC_CHANNELS.voiceIsSupported)?.()).toEqual({
        supported: false,
        reason: 'Voice dictation is unavailable in this test scenario.',
      });
      expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceGetMicrophoneAccess)?.(),
      ).toBe('unavailable');
      await expect(
        mockIpcHandlers.get(IPC_CHANNELS.voiceRequestSystemAccess)?.(),
      ).resolves.toEqual({
        microphone: 'unavailable',
        speechRecognition: 'unavailable',
      });
      expect(mockServiceIsSupported).not.toHaveBeenCalled();
    } finally {
      restoreFlow();
      restorePlatform();
    }
  });

  it('returns the unsupported macOS-only response on non-macOS', async () => {
    const restorePlatform = setPlatform('win32');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      const response = mockIpcHandlers.get(IPC_CHANNELS.voiceIsSupported)?.();
      expect(response).toEqual({
        supported: false,
        reason: 'Voice dictation is only available on macOS.',
      });
      expect(mockServiceIsSupported).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('returns unavailable system access on non-macOS', async () => {
    const restorePlatform = setPlatform('win32');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      const response = await mockIpcHandlers.get(
        IPC_CHANNELS.voiceRequestSystemAccess,
      )?.();
      expect(response).toEqual({
        microphone: 'unavailable',
        speechRecognition: 'unavailable',
      });
      expect(mockServiceRequestSpeechRecognitionAccess).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('returns granted microphone status without prompting when already granted on macOS', async () => {
    const restorePlatform = setPlatform('darwin');
    mockGetMediaAccessStatus.mockReturnValue('granted');
    mockServiceRequestSpeechRecognitionAccess.mockResolvedValue('authorized');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      const response = await mockIpcHandlers.get(
        IPC_CHANNELS.voiceRequestSystemAccess,
      )?.();

      expect(mockAskForMediaAccess).not.toHaveBeenCalled();
      expect(mockGetMediaAccessStatus).toHaveBeenCalledWith('microphone');
      expect(mockServiceRequestSpeechRecognitionAccess).toHaveBeenCalledTimes(
        1,
      );
      expect(response).toEqual({
        microphone: 'granted',
        speechRecognition: 'authorized',
      });
    } finally {
      restorePlatform();
    }
  });

  it('prompts for microphone access when status is not determined on macOS', async () => {
    const restorePlatform = setPlatform('darwin');
    mockGetMediaAccessStatus.mockReturnValue('not-determined');
    mockAskForMediaAccess.mockResolvedValue(true);
    mockServiceRequestSpeechRecognitionAccess.mockResolvedValue('authorized');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      const response = await mockIpcHandlers.get(
        IPC_CHANNELS.voiceRequestSystemAccess,
      )?.();

      expect(mockAskForMediaAccess).toHaveBeenCalledWith('microphone');
      expect(mockServiceRequestSpeechRecognitionAccess).toHaveBeenCalledTimes(
        1,
      );
      expect(response).toEqual({
        microphone: 'granted',
        speechRecognition: 'authorized',
      });
    } finally {
      restorePlatform();
    }
  });

  it('returns post-prompt microphone status when microphone access is denied on macOS', async () => {
    const restorePlatform = setPlatform('darwin');
    mockGetMediaAccessStatus
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('denied');
    mockAskForMediaAccess.mockResolvedValue(false);
    mockServiceRequestSpeechRecognitionAccess.mockResolvedValue('authorized');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      const response = await mockIpcHandlers.get(
        IPC_CHANNELS.voiceRequestSystemAccess,
      )?.();

      expect(mockAskForMediaAccess).toHaveBeenCalledWith('microphone');
      expect(response).toEqual({
        microphone: 'denied',
        speechRecognition: 'authorized',
      });
    } finally {
      restorePlatform();
    }
  });

  it('maps microphone access status failures to unavailable', async () => {
    const restorePlatform = setPlatform('darwin');
    mockGetMediaAccessStatus.mockImplementation(() => {
      throw new Error('status failed');
    });
    mockServiceRequestSpeechRecognitionAccess.mockResolvedValue('authorized');

    try {
      const { registerVoiceHandlers } = await import('../voice/preload-bridge');
      registerVoiceHandlers(() => null);

      const response = await mockIpcHandlers.get(
        IPC_CHANNELS.voiceRequestSystemAccess,
      )?.();

      expect(mockAskForMediaAccess).not.toHaveBeenCalled();
      expect(mockGetMediaAccessStatus).toHaveBeenCalledWith('microphone');
      expect(response).toEqual({
        microphone: 'unavailable',
        speechRecognition: 'authorized',
      });
    } finally {
      restorePlatform();
    }
  });
});
