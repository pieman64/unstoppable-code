import {
  classifyVoiceError,
  guidanceForMicrophoneFailure,
  unknownMicrophoneFailureGuidance,
} from '../voice-error';

describe('classifyVoiceError', () => {
  it('reports the actual minimum supported macOS version', () => {
    const guidance = classifyVoiceError(
      'SpeechAnalyzer requires macOS 26 or later',
    );

    expect(guidance).toEqual({
      kind: 'unsupported',
      title: 'Voice input is unavailable on this device',
      steps: [
        'macOS 26 or later is required for voice dictation in Canopy.',
        'If you are already on macOS 26+, try restarting Canopy. If the problem persists, disable voice input.',
      ],
    });
  });

  it('routes locale download failures to language guidance before permission guidance', () => {
    const guidance = classifyVoiceError(
      'on-device speech recognition unavailable for locale en-US',
    );

    expect(guidance).toEqual({
      kind: 'language-unavailable',
      title: 'Install a speech recognition language',
      steps: [
        'Open System Settings → Keyboard → Dictation.',
        'Add English under Languages — macOS will download the on-device model Canopy currently uses.',
        'Return to Canopy once the download finishes.',
      ],
      settingsUrl:
        'x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Dictation',
      settingsLabel: 'Open Keyboard Settings',
    });
  });

  it('routes speech recognition access denials to speech privacy guidance', () => {
    const guidance = classifyVoiceError(
      'Speech Recognition access denied. Enable it in System Settings → Privacy & Security → Speech Recognition.',
    );

    expect(guidance.kind).toBe('speech-permission-denied');
    expect(guidance.settingsUrl).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
    );
  });
});

describe('classifyVoiceError microphone matching', () => {
  it('does not treat a mere mention of the microphone as a denial', () => {
    // The denial copy asserts macOS "will not ask again" and links a Settings
    // toggle; claiming that for a non-denial sends users to a switch that is
    // already on.
    expect(classifyVoiceError('microphone unavailable').kind).not.toBe(
      'microphone-permission-denied',
    );
    expect(
      classifyVoiceError('Could not start microphone source').kind,
    ).not.toBe('microphone-permission-denied');
  });

  it.each([
    'Microphone access denied by the system',
    'Microphone permission was refused',
    'microphone use is not allowed',
    'microphone access blocked',
    'permission denied',
  ])('still classifies %s as a denial', (message) => {
    expect(classifyVoiceError(message).kind).toBe(
      'microphone-permission-denied',
    );
  });
});

describe('guidanceForMicrophoneFailure', () => {
  it.each([
    ['denied', 'microphone-permission-denied', true],
    ['restricted', 'microphone-restricted', false],
    ['not-determined', 'microphone-permission-not-determined', false],
    ['no-input-device', 'no-input-device', false],
    ['device-unavailable', 'device-unavailable', false],
    ['unavailable', 'generic', true],
  ] as const)('maps %s to the %s kind', (reason, kind, expectsSettingsLink) => {
    const guidance = guidanceForMicrophoneFailure(reason);

    expect(guidance.kind).toBe(kind);
    expect(guidance.steps.length).toBeGreaterThan(0);
    // Only offer a System Settings deep link where flipping a switch can
    // actually fix the failure.
    expect(Boolean(guidance.settingsUrl)).toBe(expectsSettingsLink);
  });

  it('tells the user macOS will not ask again when access is denied', () => {
    // Without this, users keep clicking the mic waiting for a prompt that
    // macOS will never show again.
    expect(guidanceForMicrophoneFailure('denied').steps[0]).toContain(
      'will not ask again',
    );
  });

  it('does not blame permissions when the device is busy', () => {
    const guidance = guidanceForMicrophoneFailure('device-unavailable');

    expect(guidance.steps.join(' ')).toContain('access is allowed');
    expect(guidance.settingsUrl).toBeUndefined();
  });
});

describe('unknownMicrophoneFailureGuidance', () => {
  it('surfaces the raw cause without asserting a denial', () => {
    const guidance = unknownMicrophoneFailureGuidance('Could not start source');

    expect(guidance.kind).not.toBe('microphone-permission-denied');
    expect(guidance.steps.join(' ')).toContain('Could not start source');
  });

  it('offers no Settings deep link, so the raw cause survives on screen', () => {
    // The modal autofocuses the settings button and dismisses on click, which
    // would discard the only diagnostic the user has for an unnamed failure.
    const guidance = unknownMicrophoneFailureGuidance('boom');

    expect(guidance.settingsUrl).toBeUndefined();
    expect(guidance.settingsLabel).toBeUndefined();
  });

  it('falls back to a placeholder when there is no message', () => {
    expect(unknownMicrophoneFailureGuidance(null).steps).toContain(
      'Unknown error.',
    );
  });
});
