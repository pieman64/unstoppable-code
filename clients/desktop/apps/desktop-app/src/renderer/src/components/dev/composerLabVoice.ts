import type {
  VoiceProviderHandlers,
  VoiceTranscriptionProvider,
} from '@/lib/voice/voice-types';

const LAB_TRANSCRIPT =
  'The upload test fails about one run in five, mostly on CI. Can you check the mock server timing and make the wait deterministic?';

/** Milliseconds between the stand-in speaker's words. */
const WORD_INTERVAL_MS = 380;

/**
 * Stand-in dictation for the composer lab, where the app's microphone helper
 * is not available. It speaks through the same provider seam the real one
 * does, so the composer's own dictation code handles the take: words arrive
 * as a growing interim transcript, stop commits it, and cancel drops it.
 */
export class ScriptedVoiceProvider implements VoiceTranscriptionProvider {
  readonly name = 'composer-lab';
  private handlers: VoiceProviderHandlers | null = null;
  private timer: number | null = null;
  private spoken = '';

  isSupported(): Promise<boolean> {
    return Promise.resolve(true);
  }

  start(handlers: VoiceProviderHandlers): Promise<void> {
    this.clear();
    this.handlers = handlers;
    this.spoken = '';
    const words = LAB_TRANSCRIPT.split(' ');
    let next = 0;
    this.timer = window.setInterval((): void => {
      if (next >= words.length) return;
      next += 1;
      this.spoken = words.slice(0, next).join(' ');
      handlers.onInterim(this.spoken);
    }, WORD_INTERVAL_MS);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    const handlers = this.handlers;
    this.clear();
    if (handlers) {
      handlers.onFinal(this.spoken);
      handlers.onStopped();
    }
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    this.clear();
    return Promise.resolve();
  }

  private clear(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.handlers = null;
  }
}
