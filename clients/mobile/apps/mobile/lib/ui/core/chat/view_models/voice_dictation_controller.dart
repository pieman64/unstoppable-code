import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/services/speech_recognizer.dart';

/// Composer mic states; mirrors desktop `VoiceInputButton`.
enum VoiceDictationState { idle, connecting, listening, error }

/// Something the user has to see about a session that could not run.
enum VoiceDictationIssue {
  /// Microphone or speech recognition access was declined.
  permissionDenied,

  /// The device cannot recognize speech at all.
  unavailable,

  /// The session ended on a transient platform error.
  failed,
}

/// Dictates into a composer draft.
///
/// Interim transcripts occupy an anchored range in [draft] that each new
/// result replaces, so the field reads like the desktop editor: words appear
/// at the cursor, with a separating space when the cursor follows a
/// non-space character, and the final result snaps the range to its text.
/// A segment end (Android endpointing a phrase across a pause) also settles
/// the range, so the next phrase is appended rather than overwriting it; a
/// final that arrives before the next phrase revises the settled range.
/// Empty words never erase dictated text.
/// Ending a session, by tap, silence, or error, keeps whatever was dictated;
/// only [abandon] skips the final result, and even that leaves the draft as
/// it is.
class VoiceDictationController extends ChangeNotifier {
  VoiceDictationController({required this._draft, required this._recognizer}) {
    _draft.addListener(_onDraftChanged);
  }

  final TextEditingController _draft;
  final SpeechRecognizer _recognizer;

  VoiceDictationState _state = VoiceDictationState.idle;
  VoiceDictationState get state => _state;

  bool _dictated = false;

  /// True while the most recent change to the draft came from dictation; the
  /// send path uses it to flag the message as spoken.
  bool get dictated => _dictated;

  VoiceDictationIssue? _issue;

  /// Returns and clears the pending issue so the owner can surface it once.
  VoiceDictationIssue? takeIssue() {
    final issue = _issue;
    _issue = null;
    return issue;
  }

  /// Start offset of the range interim words occupy, or null between sessions.
  int? _anchor;
  int _anchorLength = 0;

  /// True after a segment end or final until the next phrase's first result.
  bool _segmentSettled = false;

  /// The draft text as this controller last wrote it, used to notice edits
  /// made by the user in between results.
  String? _lastWritten;

  /// Results are dropped outside an open session so a stale platform
  /// callback cannot re-insert words after the user moved on.
  bool _accepting = false;

  /// Invalidates callbacks and asynchronous continuations from older starts.
  int _sessionGeneration = 0;

  /// Codes the platform sends when a session simply heard nothing.
  static const _silenceCodes = {'error_no_match', 'error_speech_timeout'};

  static const _permissionCodes = {
    'error_permission',
    'error_speech_recognizer_request_not_authorized',
    'error_speech_recognizer_disabled',
  };

  Future<void> start() async {
    if (_state == VoiceDictationState.connecting ||
        _state == VoiceDictationState.listening) {
      return;
    }
    final generation = ++_sessionGeneration;
    _setState(VoiceDictationState.connecting);
    SpeechRecognizerInitialization initialization;
    try {
      initialization = await _recognizer.initialize(
        onStatus: (status) => _onStatus(generation, status),
        onError: (error) => _onError(generation, error),
      );
    } catch (_) {
      if (!_isCurrent(generation)) return;
      _fail(VoiceDictationIssue.unavailable);
      return;
    }
    if (!_isCurrent(generation)) {
      return;
    }
    switch (initialization) {
      case SpeechRecognizerInitialization.ready:
        break;
      case SpeechRecognizerInitialization.permissionDenied:
        _fail(VoiceDictationIssue.permissionDenied);
        return;
      case SpeechRecognizerInitialization.unavailable:
        _fail(VoiceDictationIssue.unavailable);
        return;
    }
    _anchor = null;
    _anchorLength = 0;
    _segmentSettled = false;
    _lastWritten = _draft.text;
    _accepting = true;
    try {
      await _recognizer.listen(
        onResult: (transcript) => _onResult(generation, transcript),
      );
    } catch (_) {
      if (!_isCurrent(generation)) return;
      _accepting = false;
      _fail(VoiceDictationIssue.failed);
      return;
    }
    if (_state == VoiceDictationState.connecting) {
      _setState(VoiceDictationState.listening);
    }
  }

  /// Ends the session; the platform's final result still lands in the draft.
  Future<void> stop() async {
    if (_state != VoiceDictationState.listening &&
        _state != VoiceDictationState.connecting) {
      return;
    }
    await _recognizer.stop();
  }

  /// Ends the session without a final result, leaving the draft as is. Used
  /// when the draft is sent or the composer goes away mid-dictation.
  Future<void> abandon() async {
    if (_state != VoiceDictationState.listening &&
        _state != VoiceDictationState.connecting) {
      return;
    }
    _sessionGeneration += 1;
    _accepting = false;
    _setState(VoiceDictationState.idle);
    await _recognizer.cancel();
  }

  /// Restores the send classification together with a draft after a rejected
  /// send. Clearing the composer intentionally removes this marker first.
  void restoreDictatedMarker() {
    if (_dictated) return;
    _dictated = true;
    if (!_disposed) notifyListeners();
  }

  void _fail(VoiceDictationIssue issue) {
    _issue = issue;
    _setState(VoiceDictationState.error);
  }

  bool _isCurrent(int generation) =>
      !_disposed && generation == _sessionGeneration;

  Future<void> _cancelRecognizerQuietly() async {
    try {
      await _recognizer.cancel();
    } catch (_) {
      // Best-effort cleanup for an attempt the owner already abandoned.
    }
  }

  void _onStatus(int generation, SpeechRecognizerStatus status) {
    if (!_isCurrent(generation)) return;
    switch (status) {
      case SpeechRecognizerStatus.listening:
        if (_state == VoiceDictationState.connecting) {
          _setState(VoiceDictationState.listening);
        }
      case SpeechRecognizerStatus.notListening:
        // A final transcript may still follow. Stay non-restartable until the
        // final result or `done` closes this generation.
        break;
      case SpeechRecognizerStatus.done:
        _accepting = false;
        if (_state == VoiceDictationState.listening ||
            _state == VoiceDictationState.connecting) {
          _setState(VoiceDictationState.idle);
        }
    }
  }

  void _onError(int generation, SpeechRecognizerError error) {
    if (!_isCurrent(generation)) return;
    if (_silenceCodes.contains(error.code)) return;
    _accepting = false;
    _fail(
      _permissionCodes.contains(error.code)
          ? VoiceDictationIssue.permissionDenied
          : VoiceDictationIssue.failed,
    );
  }

  void _onResult(int generation, SpeechTranscript transcript) {
    if (!_isCurrent(generation) || !_accepting) return;
    final ends = transcript.isFinal || transcript.isSegmentEnd;
    if (_segmentSettled && !transcript.isFinal) {
      // An empty partial can be the first result of a new phrase. Reset its
      // range before deciding whether there are words to write.
      _anchor = null;
      _anchorLength = 0;
      _segmentSettled = false;
    }
    // Empty words never replace dictated text: Android reports them while it
    // re-hypothesizes a phrase, and on segment ends and finals that add
    // nothing.
    if (transcript.words.isNotEmpty) {
      // A settled segment keeps its range until the next phrase starts, so a
      // final that follows a segment end revises those words, not repeats
      // them.
      _write(transcript.words);
    }
    if (ends) _segmentSettled = true;
    if (transcript.isFinal) {
      _accepting = false;
    }
  }

  void _write(String words) {
    final current = _draft.value;
    if (_anchor == null || current.text != _lastWritten) {
      final selection = current.selection;
      final cursor = selection.isValid
          ? selection.end.clamp(0, current.text.length)
          : current.text.length;
      _anchor = cursor;
      _anchorLength = 0;
    }
    final anchor = _anchor!;
    final text = current.text;
    final before = text.substring(0, anchor);
    final after = text.substring(anchor + _anchorLength);
    final needsSpace =
        words.isNotEmpty &&
        before.isNotEmpty &&
        !_isWhitespace(before[before.length - 1]);
    final inserted = needsSpace ? ' $words' : words;
    final next = '$before$inserted$after';
    _anchorLength = inserted.length;
    _lastWritten = next;
    _dictated = true;
    _draft.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: anchor + inserted.length),
    );
  }

  static bool _isWhitespace(String char) => char.trim().isEmpty;

  void _onDraftChanged() {
    if (_draft.text == _lastWritten) return;
    if (_accepting) {
      _sessionGeneration += 1;
      _accepting = false;
      _anchor = null;
      _anchorLength = 0;
      unawaited(_cancelRecognizerQuietly());
      _setState(VoiceDictationState.idle);
    }
    if (_dictated) {
      _dictated = false;
      notifyListeners();
    }
  }

  bool _disposed = false;

  void _setState(VoiceDictationState next) {
    if (_state == next) return;
    _state = next;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    final shouldCancel =
        _accepting ||
        _state == VoiceDictationState.connecting ||
        _state == VoiceDictationState.listening;
    _disposed = true;
    _sessionGeneration += 1;
    _accepting = false;
    if (shouldCancel) unawaited(_cancelRecognizerQuietly());
    _draft.removeListener(_onDraftChanged);
    super.dispose();
  }
}
