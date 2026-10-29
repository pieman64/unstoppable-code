import { useCallback, useEffect, useRef, useState } from 'react';
import { AppleSpeechBridgeProvider } from '../lib/voice/apple-speech-bridge';
import {
  VoiceMicrophoneError,
  VoicePermissionError,
  VoiceSpeechPermissionError,
  VoiceUnsupportedError,
  type VoiceSessionState,
  type VoiceTranscriptionProvider,
} from '../lib/voice/voice-types';
import {
  classifyVoiceError,
  guidanceForMicrophoneFailure,
  unknownMicrophoneFailureGuidance,
  type VoiceErrorGuidance,
} from '../lib/voice/voice-error';
import type { VoiceTarget } from '../lib/voice/voice-target';

export interface UseVoiceTranscriptionOptions {
  target: VoiceTarget | null;
  /** A new draft can reuse the same editor; its identity still ends the take. */
  destinationKey?: string | null;
  onFinalCommitted?: (text: string) => void;
  /** Override the provider (used by tests). */
  provider?: VoiceTranscriptionProvider;
}

export interface UseVoiceTranscriptionResult {
  state: VoiceSessionState;
  error: string | null;
  /**
   * Recovery guidance for the current failure, or `null` when there is none to
   * show. Ownership lives here rather than in each composer so a dismissal can
   * never outlive the failure it dismissed: every `start()` clears it, so a
   * repeat failure always re-surfaces even when its message is byte-identical
   * to the one the user just closed (which is exactly what a denied
   * microphone produces on every retry).
   */
  errorGuidance: VoiceErrorGuidance | null;
  /** Hide the guidance for the current failure only. */
  dismissError: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  /**
   * The loudest microphone level (0 to 1) since the previous read, then
   * resets; a waveform polls it at its own pace. Kept out of React state so
   * audio chunks never re-render the composer.
   */
  readLevel: () => number;
  /** When the current take started listening (epoch ms), else `null`. */
  listeningSince: number | null;
}

/**
 * Recovery guidance for a `start()` rejection. Typed microphone failures carry
 * their own cause; everything else is classified from its message.
 */
function guidanceForStartError(error: unknown): {
  guidance: VoiceErrorGuidance;
  message: string;
} {
  if (error instanceof VoiceMicrophoneError) {
    // The title is the action to take, which is what the mic button's tooltip
    // and aria-label need; the full steps live in the modal.
    const guidance = guidanceForMicrophoneFailure(error.reason);
    return { guidance, message: guidance.title };
  }
  if (error instanceof VoiceSpeechPermissionError) {
    const message =
      'Speech Recognition access denied. Enable it in System Settings → Privacy & Security → Speech Recognition.';
    return { guidance: classifyVoiceError(message), message };
  }
  if (error instanceof VoicePermissionError) {
    // Bare, i.e. not a VoiceMicrophoneError — the cause is unknown, so never
    // assert a denial. The raw cause goes in the modal steps; `message` stays
    // the guidance title because it becomes the mic button's tooltip and
    // aria-label.
    const guidance = unknownMicrophoneFailureGuidance(error.message || null);
    return { guidance, message: guidance.title };
  }
  if (error instanceof VoiceUnsupportedError) {
    const message =
      error.message || 'Voice input is not supported on this device.';
    return { guidance: classifyVoiceError(message), message };
  }
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'Voice input failed to start';
  return { guidance: classifyVoiceError(message), message };
}

/** Why a take ended without success, as shown to the user. */
interface VoiceTakeFailure {
  message: string;
  guidance: VoiceErrorGuidance;
}

function failureFromMessage(message: string): VoiceTakeFailure {
  return { message, guidance: classifyVoiceError(message) };
}

/**
 * One recording take. Its transcript stays here, out of the editor, until the
 * take ends; the first terminal event wins and inserts it exactly once.
 */
interface VoiceTake {
  readonly version: number;
  /** The destination captured when the take began. */
  readonly target: VoiceTarget | null;
  /** Latest nonblank interim snapshot; snapshots replace, never concatenate. */
  transcript: string;
  terminal: boolean;
}

export function useVoiceTranscription(
  options: UseVoiceTranscriptionOptions,
): UseVoiceTranscriptionResult {
  const { target, destinationKey, onFinalCommitted, provider } = options;
  const [state, setState] = useState<VoiceSessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<VoiceErrorGuidance | null>(null);
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const providerRef = useRef<VoiceTranscriptionProvider | null>(null);
  const targetRef = useRef<VoiceTarget | null>(target);
  const destinationKeyRef = useRef(destinationKey);
  const onFinalCommittedRef = useRef<typeof onFinalCommitted>(onFinalCommitted);
  const requestVersionRef = useRef(0);
  const takeRef = useRef<VoiceTake | null>(null);
  const peakLevelRef = useRef(0);
  const [listeningSince, setListeningSince] = useState<number | null>(null);

  useEffect(() => {
    onFinalCommittedRef.current = onFinalCommitted;
  }, [onFinalCommitted]);

  /** Ends the current take without inserting anything. */
  const discardTake = useCallback((): void => {
    requestVersionRef.current += 1;
    if (takeRef.current) takeRef.current.terminal = true;
    takeRef.current = null;
  }, []);

  useEffect(() => {
    if (
      targetRef.current === target &&
      destinationKeyRef.current === destinationKey
    )
      return;
    targetRef.current = target;
    destinationKeyRef.current = destinationKey;
    if (!takeRef.current) return;
    // A destination change permanently discards the take, even if the user
    // later returns to the same editor. Invalidate before cancellation can
    // synchronously deliver any remaining provider events.
    discardTake();
    void providerRef.current?.cancel();
    setState('idle');
  }, [target, destinationKey, discardTake]);

  useEffect(() => {
    providerRef.current = provider ?? new AppleSpeechBridgeProvider();
    return (): void => {
      discardTake();
      void providerRef.current?.cancel();
      providerRef.current = null;
    };
  }, [provider, discardTake]);

  const isLive = useCallback(
    (take: VoiceTake): boolean =>
      !take.terminal && take.version === requestVersionRef.current,
    [],
  );

  /**
   * The single terminal path for final, stopped, and error events. The take is
   * marked terminal before anything else runs, so duplicate or reentrant
   * events cannot insert twice, and the transcript is in the editor before the
   * committed callback and before state leaves recording (chat and home send
   * on the transition to idle).
   */
  const finishTake = useCallback(
    (
      take: VoiceTake,
      finalText: string | null,
      failure: VoiceTakeFailure | null,
    ): void => {
      if (!isLive(take)) return;
      take.terminal = true;
      const transcript =
        finalText !== null && finalText.trim() ? finalText : take.transcript;
      take.transcript = '';
      if (takeRef.current === take) takeRef.current = null;
      let outcome = failure;
      const destination = targetRef.current;
      // A destination that changed mid-take never receives the old take.
      if (transcript.trim() && destination && destination === take.target) {
        let inserted = false;
        try {
          destination.commitFinal(transcript);
          inserted = true;
        } catch {
          // Never acknowledge a commit that did not land, so no send follows.
          outcome ??= failureFromMessage("Couldn't insert the dictated text");
        }
        if (inserted) onFinalCommittedRef.current?.(transcript);
      }
      if (outcome) {
        setError(outcome.message);
        setGuidance(outcome.guidance);
        setGuidanceDismissed(false);
        setState('error');
        return;
      }
      setState('idle');
    },
    [isLive],
  );

  const start = useCallback(async (): Promise<void> => {
    const activeProvider = providerRef.current;
    if (!activeProvider) return;
    if (state === 'connecting' || state === 'listening') return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const take: VoiceTake = {
      version: requestVersion,
      target: targetRef.current,
      transcript: '',
      terminal: false,
    };
    takeRef.current = take;
    setError(null);
    setGuidance(null);
    // A new attempt is a new failure opportunity — never let the previous
    // dismissal suppress whatever this attempt reports.
    setGuidanceDismissed(false);
    setState('connecting');
    peakLevelRef.current = 0;
    setListeningSince(Date.now());
    try {
      await activeProvider.start({
        onInterim: (text) => {
          if (!isLive(take)) return;
          // Buffer only: the editor stays the user's while they record.
          if (text.trim()) take.transcript = text;
          setState('listening');
        },
        onFinal: (text) => {
          finishTake(take, text, null);
        },
        onStopped: () => {
          // The helper ended without a final event (e.g. the user stopped very
          // quickly); keep what was heard rather than discarding it.
          finishTake(take, null, null);
        },
        onLevel: (level) => {
          if (!isLive(take)) return;
          peakLevelRef.current = Math.max(peakLevelRef.current, level);
        },
        onError: (message) => {
          // Preserve any text the user has already dictated. Only real
          // permission/configuration errors should bubble up to the UI; the
          // text they spoke is never thrown away.
          finishTake(take, null, failureFromMessage(message));
        },
      });
      if (!isLive(take)) return;
      setState('listening');
    } catch (err) {
      finishTake(take, null, guidanceForStartError(err));
    }
  }, [state, isLive, finishTake]);

  const stop = useCallback(async (): Promise<void> => {
    const activeProvider = providerRef.current;
    if (!activeProvider) return;
    if (state === 'idle') return;
    const take = takeRef.current;
    if (state === 'connecting') {
      // Stopping is never a discard: anything already heard is kept.
      if (take) finishTake(take, null, null);
      discardTake();
      await activeProvider.cancel();
      // finishTake already published the outcome. Cleanup must not overwrite
      // an insertion failure, or the state of a subsequent take.
      return;
    }
    try {
      // The take keeps its transcript until the provider's terminal event.
      await activeProvider.stop();
    } catch (err) {
      if (!take) return;
      finishTake(
        take,
        null,
        failureFromMessage(
          err instanceof Error && err.message
            ? err.message
            : 'Voice input failed to stop',
        ),
      );
    }
  }, [state, finishTake, discardTake]);

  const cancel = useCallback(async (): Promise<void> => {
    const activeProvider = providerRef.current;
    if (!activeProvider) return;
    // Invalidate first, so callbacks fired during cancellation insert nothing.
    discardTake();
    await activeProvider.cancel();
    setState('idle');
    setError(null);
    setGuidance(null);
  }, [discardTake]);

  const dismissError = useCallback((): void => {
    setGuidanceDismissed(true);
  }, []);

  const readLevel = useCallback((): number => {
    const level = peakLevelRef.current;
    peakLevelRef.current = 0;
    return level;
  }, []);

  // A take's clock runs only while it is connecting or listening.
  useEffect(() => {
    if (state === 'idle' || state === 'error') setListeningSince(null);
  }, [state]);

  return {
    state,
    error,
    errorGuidance: guidanceDismissed ? null : guidance,
    dismissError,
    start,
    stop,
    cancel,
    readLevel,
    listeningSince,
  };
}
