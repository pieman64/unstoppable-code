/// Provider-neutral speech recognition seam.
///
/// The remote chat composer dictates through this contract so the
/// `speech_to_text` plugin stays behind one adapter
/// (`SpeechToTextRecognizer`) and widget tests can drive scripted
/// transcripts without a platform channel.
abstract interface class SpeechRecognizer {
  /// Prepares the platform recognizer. The first call prompts for the
  /// microphone and speech recognition permissions.
  Future<SpeechRecognizerInitialization> initialize({
    required SpeechStatusCallback onStatus,
    required SpeechErrorCallback onError,
  });

  /// Starts one listen session. [onResult] receives the accumulated
  /// transcript for the session, first as interim results and finally as
  /// one result flagged final.
  Future<void> listen({required SpeechResultCallback onResult});

  /// Ends the session and lets the platform deliver its final result.
  Future<void> stop();

  /// Ends the session without a final result.
  Future<void> cancel();
}

/// Outcome of preparing the platform speech recognizer.
enum SpeechRecognizerInitialization {
  /// Recognition is ready to listen.
  ready,

  /// Microphone or speech-recognition permission was declined.
  permissionDenied,

  /// Permissions are present, but recognition is unavailable on this device.
  unavailable,
}

typedef SpeechStatusCallback = void Function(SpeechRecognizerStatus status);
typedef SpeechErrorCallback = void Function(SpeechRecognizerError error);
typedef SpeechResultCallback = void Function(SpeechTranscript transcript);

/// Session lifecycle edges, in the order a session emits them.
enum SpeechRecognizerStatus {
  /// The microphone is open.
  listening,

  /// The microphone closed; a final result may still follow.
  notListening,

  /// Every result for the session has been delivered.
  done,
}

/// The transcript so far for the current segment of a session.
///
/// Recognizers revise the segment's words with each result. Android may
/// endpoint a phrase after a pause while the session stays open; that result
/// carries [isSegmentEnd] and the words of the following results belong to a
/// new segment, so consumers must keep the ended segment's text. A segment end
/// or final result may carry empty [words]; it marks the boundary and adds no
/// text.
class SpeechTranscript {
  const SpeechTranscript(
    this.words, {
    required this.isFinal,
    this.isSegmentEnd = false,
  });

  final String words;

  /// The session's last result; nothing follows.
  final bool isFinal;

  /// This segment is complete; later results start a new one.
  final bool isSegmentEnd;
}

/// One error from the platform recognizer.
class SpeechRecognizerError {
  const SpeechRecognizerError(this.code, {required this.permanent});

  /// Platform error identifier such as `error_permission`; not user copy.
  final String code;

  /// True when recognition cannot continue until the user fixes something.
  final bool permanent;
}
