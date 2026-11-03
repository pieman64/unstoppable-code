import 'dart:async';

import 'package:mobile/services/speech_recognizer.dart';

/// Scripted [SpeechRecognizer]: tests hold the callbacks the controller
/// registers and push transcripts, statuses, and errors through them.
final class FakeSpeechRecognizer implements SpeechRecognizer {
  FakeSpeechRecognizer({bool available = true})
    : initialization = available
          ? SpeechRecognizerInitialization.ready
          : SpeechRecognizerInitialization.permissionDenied;

  /// What [initialize] resolves to.
  SpeechRecognizerInitialization initialization;

  /// When set, [initialize] throws this instead of resolving.
  Object? initializeError;

  /// When set, [initialize] waits on it before resolving, so a caller can
  /// hold the controller in its connecting state until [releaseInitialize].
  Future<void> Function()? initializeGate;
  Completer<void>? _gate;

  void releaseInitialize() => _gate?.complete();

  int initializeCalls = 0;
  int listenCalls = 0;
  int stopCalls = 0;
  int cancelCalls = 0;

  SpeechStatusCallback? _onStatus;
  SpeechErrorCallback? _onError;
  SpeechResultCallback? _onResult;
  SpeechResultCallback? _lastResult;

  bool get listening => _onResult != null;

  @override
  Future<SpeechRecognizerInitialization> initialize({
    required SpeechStatusCallback onStatus,
    required SpeechErrorCallback onError,
  }) async {
    initializeCalls += 1;
    final error = initializeError;
    if (error != null) throw error;
    _onStatus = onStatus;
    _onError = onError;
    if (initializeGate != null) {
      _gate = Completer<void>();
      await _gate!.future;
    }
    return initialization;
  }

  @override
  Future<void> listen({required SpeechResultCallback onResult}) async {
    listenCalls += 1;
    _onResult = onResult;
    _lastResult = onResult;
    _onStatus?.call(SpeechRecognizerStatus.listening);
  }

  @override
  Future<void> stop() async {
    stopCalls += 1;
    _onStatus?.call(SpeechRecognizerStatus.notListening);
  }

  @override
  Future<void> cancel() async {
    cancelCalls += 1;
    _onResult = null;
    _onStatus?.call(SpeechRecognizerStatus.notListening);
    _onStatus?.call(SpeechRecognizerStatus.done);
  }

  /// Delivers an interim transcript for the open session.
  void emitInterim(String words) {
    _onResult!(SpeechTranscript(words, isFinal: false));
  }

  /// Ends the current segment the way Android does after a pause: the
  /// segment's words are settled, the session stays open, and the next
  /// results describe a new phrase.
  void emitSegmentEnd(String words) {
    _onResult!(SpeechTranscript(words, isFinal: false, isSegmentEnd: true));
  }

  /// Delivers the session's final transcript. Tests emit `done` separately
  /// when the platform has actually finished closing the recognizer.
  void emitFinal(String words) {
    final onResult = _onResult!;
    _onResult = null;
    onResult(SpeechTranscript(words, isFinal: true));
  }

  /// Ends the session the way the platform does after silence: no final
  /// result, just the closing edges.
  void emitTimeout() {
    _onResult = null;
    _onStatus?.call(SpeechRecognizerStatus.notListening);
    _onStatus?.call(SpeechRecognizerStatus.done);
  }

  void emitNotListening() {
    _onStatus?.call(SpeechRecognizerStatus.notListening);
  }

  void emitDone() {
    _onResult = null;
    _onStatus?.call(SpeechRecognizerStatus.done);
  }

  /// Models a platform callback already queued before cancellation completed.
  void emitLateInterim(String words) {
    _lastResult!(SpeechTranscript(words, isFinal: false));
  }

  void emitError(String code, {required bool permanent}) {
    _onError!(SpeechRecognizerError(code, permanent: permanent));
  }
}
