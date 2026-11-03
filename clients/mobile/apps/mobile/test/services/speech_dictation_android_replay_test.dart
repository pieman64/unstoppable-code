import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/speech_to_text_recognizer.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:speech_to_text_platform_interface/speech_to_text_platform_interface.dart';

/// Mirrors the vendored Android plugin: `listen` notifies `listening`, and
/// `stop` notifies `notListening` then `done` at once, before the recognizer
/// delivers its late results.
final class _AndroidPlatform extends SpeechToTextPlatform
    with MockPlatformInterfaceMixin {
  bool _listening = false;
  bool _resultSent = false;

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<bool> initialize({
    debugLogging = false,
    List<SpeechConfigOption>? options,
  }) async => true;

  @override
  Future<bool> listen({
    String? localeId,
    partialResults = true,
    onDevice = false,
    int listenMode = 0,
    sampleRate = 0,
    SpeechListenOptions? options,
  }) async {
    if (_listening) return false;
    _resultSent = false;
    _listening = true;
    onStatus!('listening');
    return true;
  }

  @override
  Future<void> stop() async => _closeMicrophone();

  @override
  Future<void> cancel() async => _closeMicrophone();

  void _closeMicrophone() {
    if (!_listening) return;
    _listening = false;
    onStatus!('notListening');
    onStatus!(_resultSent ? 'done' : 'doneNoResult');
  }

  void _send(String words, int resultType) {
    if (words.isNotEmpty) _resultSent = true;
    onTextRecognition!(
      jsonEncode({
        'alternates': [
          {'recognizedWords': words, 'confidence': -1},
        ],
        'resultType': resultType,
      }),
    );
  }

  /// A partial bundle: stable results plus the unstable tail.
  void partial(String words) => _send(words, 0);

  /// A `final_result` partial bundle: the recognizer endpointed a phrase.
  void segmentEnd(String words) => _send(words, 1);

  /// `onResults`.
  void finalResult(String words) => _send(words, 2);

  void noMatch() {
    onError!(jsonEncode({'errorMsg': 'error_no_match', 'permanent': true}));
  }

  void failWithoutResult() {
    noMatch();
    _listening = false;
    onStatus!('doneNoResult');
    onStatus!('done');
  }
}

void main() {
  late _AndroidPlatform platform;
  late TextEditingController draft;
  late VoiceDictationController voice;

  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    platform = _AndroidPlatform();
    SpeechToTextPlatform.instance = platform;
    draft = TextEditingController();
    voice = VoiceDictationController(
      draft: draft,
      recognizer: SpeechToTextRecognizer(
        plugin: SpeechToText.withMethodChannel(),
      ),
    );
  });

  tearDown(() {
    voice.dispose();
    draft.dispose();
    debugDefaultTargetPlatformOverride = null;
  });

  void startSession(FakeAsync async) {
    unawaited(voice.start());
    async.flushMicrotasks();
    expect(voice.state, VoiceDictationState.listening);
  }

  void tapStop(FakeAsync async) {
    unawaited(voice.stop());
    async.flushMicrotasks();
  }

  const sentence = 'hello world this is a dictation test for Android';

  test('iOS failure after a partial ends listening without a user stop', () {
    fakeAsync((async) {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      startSession(async);
      platform.partial('recognized words');
      platform.failWithoutResult();
      async.flushMicrotasks();

      expect(draft.text, 'recognized words');
      expect(voice.state, VoiceDictationState.idle);
    });
  });

  test('stop as a phrase ends inserts the phrase once', () {
    fakeAsync((async) {
      startSession(async);
      platform.partial('hello world this is a dictation test');
      tapStop(async);
      platform.segmentEnd(sentence);
      platform.finalResult('');
      async.elapse(const Duration(seconds: 3));

      expect(draft.text, sentence);
      expect(voice.state, VoiceDictationState.idle);
    });
  });

  test(
    'stop as a phrase ends inserts it once when no final result arrives',
    () {
      fakeAsync((async) {
        startSession(async);
        platform.partial('hello world this is a dictation test');
        tapStop(async);
        platform.segmentEnd(sentence);
        // The plugin makes its own final from the segment end after its
        // final timeout.
        async.elapse(const Duration(seconds: 3));

        expect(draft.text, sentence);
        expect(voice.state, VoiceDictationState.idle);
      });
    },
  );

  test('a phrase after a pause follows the previous phrase', () {
    fakeAsync((async) {
      startSession(async);
      platform.partial('first');
      platform.partial('first we open the project settings');
      platform.segmentEnd('');
      platform.partial('then');
      platform.partial('then we change the default model');
      platform.segmentEnd('then we change the default model');
      tapStop(async);
      platform.finalResult('');
      async.elapse(const Duration(seconds: 3));

      expect(
        draft.text,
        'first we open the project settings then we change the default model',
      );
      expect(voice.state, VoiceDictationState.idle);
    });
  });

  test('an empty partial starts a new phrase after a settled phrase', () {
    fakeAsync((async) {
      startSession(async);
      platform.partial('first phrase');
      platform.segmentEnd('first phrase');
      platform.partial('');
      platform.finalResult('second phrase');
      async.flushMicrotasks();

      expect(draft.text, 'first phrase second phrase');
    });
  });

  test('an empty boundary before stop waits for a late final result', () {
    fakeAsync((async) {
      startSession(async);
      platform.partial('first phrase');
      platform.segmentEnd('');
      tapStop(async);

      expect(voice.state, VoiceDictationState.listening);
      platform.finalResult('first phrase complete');
      async.flushMicrotasks();

      expect(draft.text, 'first phrase complete');
      expect(voice.state, VoiceDictationState.idle);
    });
  });

  test('an empty first boundary before stop waits for late words', () {
    fakeAsync((async) {
      startSession(async);
      platform.segmentEnd('');
      tapStop(async);

      expect(voice.state, VoiceDictationState.listening);
      platform.finalResult('first phrase');
      async.flushMicrotasks();

      expect(draft.text, 'first phrase');
      expect(voice.state, VoiceDictationState.idle);
    });
  });

  test('an empty boundary before stop completes on final timeout', () {
    fakeAsync((async) {
      startSession(async);
      platform.partial('first phrase');
      platform.segmentEnd('');
      tapStop(async);

      expect(voice.state, VoiceDictationState.listening);
      async.elapse(const Duration(seconds: 3));

      expect(draft.text, 'first phrase');
      expect(voice.state, VoiceDictationState.idle);
    });
  });

  test('a recognizer reset and a stop mid-phrase keep the dictated words', () {
    fakeAsync((async) {
      startSession(async);
      platform.partial('the quick brown fox jumps over the');
      platform.partial('');
      platform.partial('the quick brown fox jumps over the lazy');
      tapStop(async);
      platform.partial('');
      platform.partial('the quick brown fox jumps over the lazy dog');
      platform.segmentEnd('');
      platform.noMatch();
      async.elapse(const Duration(seconds: 3));

      expect(draft.text, 'the quick brown fox jumps over the lazy dog');
      expect(voice.state, VoiceDictationState.idle);
    });
  });
}
