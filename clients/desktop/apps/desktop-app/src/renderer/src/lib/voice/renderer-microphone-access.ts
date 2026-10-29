import {
  VoiceMicrophoneError,
  VoicePermissionError,
  type VoiceMicrophoneFailureReason,
} from './voice-types';

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    sampleRate: 48000,
  },
  video: false,
};

/**
 * Map a `getUserMedia` rejection onto the cause the UI needs to explain it.
 *
 * The provider rejects on the macOS privacy status *before* calling
 * `getUserMedia`, so a rejection that lands here has already passed the
 * system-level check: the expected causes are capture failures, not denials.
 * `NotFoundError`/`OverconstrainedError` mean there is no usable input device;
 * `NotReadableError`/`AbortError` mean the device exists but capture failed,
 * typically because another app holds it. Reporting either as "denied" would
 * send the user to a System Settings toggle that is already on.
 *
 * `NotAllowedError`/`SecurityError` are still mapped to `denied` as a
 * defensive fallback for the unexpected case where the browser layer reports
 * a denial the system-level check did not.
 */
function reasonForGetUserMediaError(
  error: unknown,
): VoiceMicrophoneFailureReason | null {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no-input-device';
    case 'NotReadableError':
    case 'AbortError':
      return 'device-unavailable';
    default:
      return null;
  }
}

export async function openRendererMicrophoneStream(): Promise<MediaStream> {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new VoicePermissionError('microphone unavailable');
  }

  try {
    return await navigator.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'microphone unavailable';
    const reason = reasonForGetUserMediaError(error);
    if (reason) {
      throw new VoiceMicrophoneError(reason, message);
    }
    throw new VoicePermissionError(message);
  }
}

export async function requestRendererMicrophoneAccess(): Promise<void> {
  const stream = await openRendererMicrophoneStream();
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
