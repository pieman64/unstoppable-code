import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/services/speech_to_text_recognizer.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:speech_to_text_platform_interface/speech_to_text_platform_interface.dart';

/// Stands in for the native plugin so the options the adapter hands to
/// `speech_to_text` can be observed without a platform channel.
final class _RecordingPlatform extends SpeechToTextPlatform
    with MockPlatformInterfaceMixin {
  SpeechListenOptions? lastOptions;
  bool hasPermissionResult = true;
  bool initializeResult = true;

  @override
  Future<bool> hasPermission() async => hasPermissionResult;

  @override
  Future<bool> initialize({
    debugLogging = false,
    List<SpeechConfigOption>? options,
  }) async => initializeResult;

  @override
  Future<bool> listen({
    String? localeId,
    partialResults = true,
    onDevice = false,
    int listenMode = 0,
    sampleRate = 0,
    SpeechListenOptions? options,
  }) async {
    lastOptions = options;
    return true;
  }

  @override
  Future<void> stop() async {}

  @override
  Future<void> cancel() async {}
}

void main() {
  group('SpeechToTextRecognizer listen options', () {
    late _RecordingPlatform platform;
    late SpeechToTextRecognizer recognizer;

    setUp(() {
      platform = _RecordingPlatform();
      SpeechToTextPlatform.instance = platform;
      recognizer = SpeechToTextRecognizer();
    });

    tearDown(() async {
      await recognizer.cancel();
      debugDefaultTargetPlatformOverride = null;
    });

    Future<SpeechListenOptions> optionsOn(TargetPlatform target) async {
      debugDefaultTargetPlatformOverride = target;
      await recognizer.initialize(onStatus: (_) {}, onError: (_) {});
      await recognizer.listen(onResult: (_) {});
      return platform.lastOptions!;
    }

    test(
      'distinguishes permission denial from unavailable recognition',
      () async {
        platform.initializeResult = false;
        platform.hasPermissionResult = false;

        expect(
          await recognizer.initialize(onStatus: (_) {}, onError: (_) {}),
          SpeechRecognizerInitialization.permissionDenied,
        );

        platform.hasPermissionResult = true;
        expect(
          await recognizer.initialize(onStatus: (_) {}, onError: (_) {}),
          SpeechRecognizerInitialization.unavailable,
        );
      },
    );

    test(
      'maps partial, intermediate, and final results onto the seam',
      () async {
        final seen = <SpeechTranscript>[];
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        await recognizer.initialize(onStatus: (_) {}, onError: (_) {});
        await recognizer.listen(onResult: seen.add);

        String result(String words, int resultType) => jsonEncode({
          'alternates': [
            {'recognizedWords': words, 'confidence': 1.0},
          ],
          'resultType': resultType,
        });
        // ResultType.partial, ResultType.intermediate, ResultType.finalResult.
        platform.onTextRecognition!(result('first', 0));
        platform.onTextRecognition!(result('first phrase', 1));
        platform.onTextRecognition!(result('second', 0));
        platform.onTextRecognition!(result('second phrase', 2));

        expect(seen.map((t) => t.words), [
          'first',
          'first phrase',
          'second',
          'second phrase',
        ]);
        expect(seen.map((t) => t.isSegmentEnd), [false, true, false, false]);
        expect(seen.map((t) => t.isFinal), [false, false, false, true]);
      },
    );

    test('dictates with live partial results and punctuation', () async {
      final options = await optionsOn(TargetPlatform.android);

      expect(options.listenMode, ListenMode.dictation);
      expect(options.partialResults, isTrue);
      expect(options.autoPunctuation, isTrue);
    });

    test('Android gets a five second end-of-speech pause', () async {
      // Android's recognizer closes a session after roughly a second of
      // silence by default; pauseFor rides the recognizer intent as the
      // complete-silence length so a thinking pause does not end dictation.
      final options = await optionsOn(TargetPlatform.android);

      expect(options.pauseFor, const Duration(seconds: 5));
    });

    test(
      'iOS keeps the platform default so sessions run their full length',
      () async {
        // pauseFor is also enforced by a Dart-side timer, which on iOS would
        // cut sessions that today run for about a minute.
        final options = await optionsOn(TargetPlatform.iOS);

        expect(options.pauseFor, isNull);
      },
    );

    test(
      'a later adapter rebinds singleton status and error callbacks',
      () async {
        final plugin = SpeechToText();
        final first = SpeechToTextRecognizer(plugin: plugin);
        final second = SpeechToTextRecognizer(plugin: plugin);
        final firstStatuses = <SpeechRecognizerStatus>[];
        final secondStatuses = <SpeechRecognizerStatus>[];
        final firstErrors = <SpeechRecognizerError>[];
        final secondErrors = <SpeechRecognizerError>[];

        await first.initialize(
          onStatus: firstStatuses.add,
          onError: firstErrors.add,
        );
        await second.initialize(
          onStatus: secondStatuses.add,
          onError: secondErrors.add,
        );

        plugin.statusListener?.call(SpeechToText.doneStatus);
        plugin.errorListener?.call(
          SpeechRecognitionError('error_network', false),
        );

        expect(firstStatuses, isEmpty);
        expect(firstErrors, isEmpty);
        expect(secondStatuses, [SpeechRecognizerStatus.done]);
        expect(secondErrors.single.code, 'error_network');
      },
    );
  });
}
