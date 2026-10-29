import type { JSX } from 'react';
import { VoiceErrorModal } from './VoiceErrorModal';
import type { VoiceErrorGuidance } from '../../lib/voice/voice-error';

interface VoiceDictationErrorModalProps {
  /** Guidance from `useVoiceTranscription().errorGuidance`; `null` renders nothing. */
  guidance: VoiceErrorGuidance | null;
  onDismiss: () => void;
}

/**
 * The single voice-failure surface shared by every composer. Composers render
 * this unconditionally and pass the hook's guidance straight through, so no
 * composer can accidentally ship a microphone button whose failures go
 * nowhere.
 */
export function VoiceDictationErrorModal({
  guidance,
  onDismiss,
}: VoiceDictationErrorModalProps): JSX.Element | null {
  if (!guidance) {
    return null;
  }
  const settingsUrl = guidance.settingsUrl;
  return (
    <VoiceErrorModal
      guidance={guidance}
      onClose={onDismiss}
      onOpenSettings={
        settingsUrl
          ? (): void => {
              void window.api.voice.openSettings({ url: settingsUrl });
              // Close behind the hand-off: the modal traps focus behind a
              // backdrop, and the last step tells the user to come back and
              // click the microphone. If it is still denied, the next attempt
              // re-opens this modal anyway.
              onDismiss();
            }
          : undefined
      }
    />
  );
}
