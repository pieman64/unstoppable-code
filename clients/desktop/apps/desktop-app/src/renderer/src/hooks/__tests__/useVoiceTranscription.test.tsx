/**
 * @jest-environment jsdom
 */
import { act, createElement, useEffect, useMemo, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useVoiceTranscription,
  type UseVoiceTranscriptionResult,
} from '../useVoiceTranscription';
import {
  VoiceMicrophoneError,
  VoicePermissionError,
  type VoiceProviderHandlers,
  type VoiceTranscriptionProvider,
} from '@/lib/voice/voice-types';
import type { VoiceTarget } from '@/lib/voice/voice-target';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function createTarget(): VoiceTarget {
  return { commitFinal: jest.fn() };
}

class AlwaysFailingProvider implements VoiceTranscriptionProvider {
  readonly name = 'always-failing';
  startCount = 0;

  constructor(private readonly failure: () => Error) {}

  isSupported(): Promise<boolean> {
    return Promise.resolve(true);
  }

  start(handlers: VoiceProviderHandlers): Promise<void> {
    void handlers;
    this.startCount += 1;
    return Promise.reject(this.failure());
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

function Harness({
  provider,
  onRender,
}: {
  provider: VoiceTranscriptionProvider;
  onRender: (voice: UseVoiceTranscriptionResult) => void;
}): JSX.Element {
  const target = useMemo(createTarget, []);
  const voice = useVoiceTranscription({ target, provider });
  useEffect(() => {
    onRender(voice);
  });
  return createElement('div');
}

function mountHarness(provider: VoiceTranscriptionProvider): {
  latest: () => UseVoiceTranscriptionResult;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  let current: UseVoiceTranscriptionResult | null = null;

  act(() => {
    root = createRoot(container);
    root.render(
      createElement(Harness, {
        provider,
        onRender: (voice): void => {
          current = voice;
        },
      }),
    );
  });

  return {
    latest: (): UseVoiceTranscriptionResult => {
      if (!current) throw new Error('harness did not render');
      return current;
    },
    unmount: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe('useVoiceTranscription error recovery', () => {
  it('re-surfaces guidance on a repeat failure with an identical message', async () => {
    // Denied microphone access produces byte-identical errors on every retry,
    // so dismissal must be scoped to one failure, never to the message text.
    const provider = new AlwaysFailingProvider(
      () => new VoiceMicrophoneError('denied'),
    );
    const harness = mountHarness(provider);

    try {
      await act(async () => {
        await harness.latest().start();
      });
      expect(harness.latest().state).toBe('error');
      expect(harness.latest().errorGuidance?.kind).toBe(
        'microphone-permission-denied',
      );

      act(() => {
        harness.latest().dismissError();
      });
      expect(harness.latest().errorGuidance).toBeNull();

      await act(async () => {
        await harness.latest().start();
      });

      expect(provider.startCount).toBe(2);
      expect(harness.latest().errorGuidance?.kind).toBe(
        'microphone-permission-denied',
      );
    } finally {
      harness.unmount();
    }
  });

  it('never asserts a denial for a failure it cannot name', async () => {
    // A bare VoicePermissionError means the cause is unknown: the provider
    // throws the typed VoiceMicrophoneError for every status it can name. The
    // denial copy claims macOS "will not ask again" and links a Settings
    // toggle, so asserting it here would send users to a switch already on.
    const provider = new AlwaysFailingProvider(
      () => new VoicePermissionError('microphone unavailable'),
    );
    const harness = mountHarness(provider);

    try {
      await act(async () => {
        await harness.latest().start();
      });

      const guidance = harness.latest().errorGuidance;
      expect(guidance?.kind).toBe('generic');
      expect(guidance?.settingsUrl).toBeUndefined();
      expect(guidance?.steps.join(' ')).toContain('microphone unavailable');
    } finally {
      harness.unmount();
    }
  });

  it('distinguishes a missing input device from a denied permission', async () => {
    const provider = new AlwaysFailingProvider(
      () => new VoiceMicrophoneError('no-input-device'),
    );
    const harness = mountHarness(provider);

    try {
      await act(async () => {
        await harness.latest().start();
      });

      expect(harness.latest().errorGuidance?.kind).toBe('no-input-device');
      expect(harness.latest().errorGuidance?.settingsUrl).toBeUndefined();
    } finally {
      harness.unmount();
    }
  });

  it('tells the user to retry when macOS has not been asked yet', async () => {
    const provider = new AlwaysFailingProvider(
      () => new VoiceMicrophoneError('not-determined'),
    );
    const harness = mountHarness(provider);

    try {
      await act(async () => {
        await harness.latest().start();
      });

      expect(harness.latest().errorGuidance?.kind).toBe(
        'microphone-permission-not-determined',
      );
    } finally {
      harness.unmount();
    }
  });

  it('reports a policy restriction as unfixable by the user', async () => {
    const provider = new AlwaysFailingProvider(
      () => new VoiceMicrophoneError('restricted'),
    );
    const harness = mountHarness(provider);

    try {
      await act(async () => {
        await harness.latest().start();
      });

      expect(harness.latest().errorGuidance?.kind).toBe(
        'microphone-restricted',
      );
    } finally {
      harness.unmount();
    }
  });
});

class ListeningProvider implements VoiceTranscriptionProvider {
  readonly name = 'listening';
  handlers: VoiceProviderHandlers | null = null;

  isSupported(): Promise<boolean> {
    return Promise.resolve(true);
  }

  start(handlers: VoiceProviderHandlers): Promise<void> {
    this.handlers = handlers;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

describe('useVoiceTranscription recording feedback', () => {
  it('reports the loudest level since the last read, then resets', async () => {
    const provider = new ListeningProvider();
    const harness = mountHarness(provider);
    try {
      await act(async () => {
        await harness.latest().start();
      });
      expect(harness.latest().readLevel()).toBe(0);
      provider.handlers?.onLevel?.(0.2);
      provider.handlers?.onLevel?.(0.7);
      provider.handlers?.onLevel?.(0.4);
      expect(harness.latest().readLevel()).toBe(0.7);
      expect(harness.latest().readLevel()).toBe(0);
    } finally {
      harness.unmount();
    }
  });

  it('knows when listening began, and forgets it once idle', async () => {
    const provider = new ListeningProvider();
    const harness = mountHarness(provider);
    try {
      expect(harness.latest().listeningSince).toBeNull();
      const before = Date.now();
      await act(async () => {
        await harness.latest().start();
      });
      const since = harness.latest().listeningSince;
      expect(since).not.toBeNull();
      expect(since ?? 0).toBeGreaterThanOrEqual(before);
      await act(async () => {
        await harness.latest().cancel();
      });
      expect(harness.latest().listeningSince).toBeNull();
    } finally {
      harness.unmount();
    }
  });
});
