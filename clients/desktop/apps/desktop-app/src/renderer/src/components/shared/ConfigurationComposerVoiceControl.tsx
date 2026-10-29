import { useEffect, useMemo, useRef, type JSX } from 'react';
import type { ChatEditor } from '@canopy/ui-rich/types';
import { useVoiceDictationGate } from '@/hooks/useVoiceDictationGate';
import { useVoiceTranscription } from '@/hooks/useVoiceTranscription';
import { createSlateVoiceTarget } from '@/lib/voice/insert-into-slate';
import { VoiceInputButton } from './VoiceInputButton';
import { VoiceDictationErrorModal } from './VoiceDictationErrorModal';

interface ConfigurationComposerVoiceControlProps {
  editor: ChatEditor;
  scopeKey: string;
  disabled: boolean;
  onCommitted: () => void;
  onPendingChange?: (pending: boolean) => void;
}

/** Text dictation only; no audio attachment is created or persisted. */
export function ConfigurationComposerVoiceControl(
  props: ConfigurationComposerVoiceControlProps,
): JSX.Element | null {
  const { voiceSupported, voiceEnabledPref } = useVoiceDictationGate();
  if (!voiceSupported || !voiceEnabledPref || props.disabled) return null;
  // A destination change releases the provider and discards its take.
  return <ConfigurationVoiceSession key={props.scopeKey} {...props} />;
}

function ConfigurationVoiceSession({
  editor,
  onCommitted,
  onPendingChange,
}: ConfigurationComposerVoiceControlProps): JSX.Element {
  const target = useMemo(() => createSlateVoiceTarget(editor), [editor]);
  const voice = useVoiceTranscription({
    target,
    onFinalCommitted: onCommitted,
  });
  const callbackRef = useRef(onPendingChange);
  callbackRef.current = onPendingChange;
  const active = voice.state === 'connecting' || voice.state === 'listening';
  useEffect(() => {
    callbackRef.current?.(active);
  }, [active]);
  useEffect(
    () => (): void => {
      callbackRef.current?.(false);
    },
    [],
  );
  return (
    <>
      <VoiceInputButton
        state={voice.state}
        error={voice.error}
        onStart={(): void => {
          void voice.start();
        }}
        onStop={(): void => {
          void voice.stop();
        }}
        capsule
      />
      <VoiceDictationErrorModal
        guidance={voice.errorGuidance}
        onDismiss={voice.dismissError}
      />
    </>
  );
}
