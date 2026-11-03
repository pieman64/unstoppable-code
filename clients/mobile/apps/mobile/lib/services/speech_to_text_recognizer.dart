import 'package:flutter/foundation.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import 'speech_recognizer.dart';

/// [SpeechRecognizer] backed by the `speech_to_text` plugin.
///
/// The plugin is a process-wide singleton, so this adapter is stateless
/// beyond the callbacks it registers. Dictation mode with partial results
/// gives the composer a live transcript. Android's recognizer closes a
/// session after roughly a second of silence by default, so on Android
/// [androidPauseFor] rides the recognizer intent as the complete-silence
/// length; the recognizer treats it as a hint, and the plugin also enforces
/// it with its own timer. iOS is left on the platform default (sessions run
/// for about a minute) because that same timer would otherwise cut them
/// short. The controller keeps whatever was recognized either way.
final class SpeechToTextRecognizer implements SpeechRecognizer {
  /// Silence Android may wait for before ending a session.
  static const Duration androidPauseFor = Duration(seconds: 5);

  SpeechToTextRecognizer({SpeechToText? plugin})
    : _plugin = plugin ?? SpeechToText();

  final SpeechToText _plugin;

  @override
  Future<SpeechRecognizerInitialization> initialize({
    required SpeechStatusCallback onStatus,
    required SpeechErrorCallback onError,
  }) async {
    void handleStatus(String status) {
      final mapped = switch (status) {
        SpeechToText.listeningStatus => SpeechRecognizerStatus.listening,
        SpeechToText.notListeningStatus => SpeechRecognizerStatus.notListening,
        SpeechToText.doneStatus => SpeechRecognizerStatus.done,
        _ => null,
      };
      if (mapped != null) onStatus(mapped);
    }

    void handleError(SpeechRecognitionError error) {
      onError(
        SpeechRecognizerError(error.errorMsg, permanent: error.permanent),
      );
    }

    final ready = await _plugin.initialize(
      onStatus: handleStatus,
      onError: handleError,
    );
    // SpeechToText is a process singleton and skips listener assignment after
    // its first successful initialize, so each screen must explicitly take
    // ownership of the callbacks again.
    _plugin.statusListener = handleStatus;
    _plugin.errorListener = handleError;
    if (ready) return SpeechRecognizerInitialization.ready;
    return await _plugin.hasPermission
        ? SpeechRecognizerInitialization.unavailable
        : SpeechRecognizerInitialization.permissionDenied;
  }

  @override
  Future<void> listen({required SpeechResultCallback onResult}) {
    return _plugin.listen(
      onResult: (result) => onResult(
        SpeechTranscript(
          result.recognizedWords,
          isFinal: result.finalResult,
          // Android flags a partial bundle `final_result` when the recognizer
          // endpointed a phrase but the session stays open (the plugin's
          // "intermediate" type); the next results describe a new phrase.
          isSegmentEnd: result.resultTypeValue == ResultType.intermediate,
        ),
      ),
      listenOptions: SpeechListenOptions(
        listenMode: ListenMode.dictation,
        partialResults: true,
        autoPunctuation: true,
        pauseFor: defaultTargetPlatform == TargetPlatform.android
            ? androidPauseFor
            : null,
      ),
    );
  }

  @override
  Future<void> stop() => _plugin.stop();

  @override
  Future<void> cancel() => _plugin.cancel();
}
