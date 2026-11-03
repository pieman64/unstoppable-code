import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';

import '../../../../support/fake_speech_recognizer.dart';

void main() {
  group('VoiceDictationController', () {
    late TextEditingController draft;
    late FakeSpeechRecognizer recognizer;
    late VoiceDictationController voice;

    setUp(() {
      draft = TextEditingController();
      recognizer = FakeSpeechRecognizer();
      voice = VoiceDictationController(draft: draft, recognizer: recognizer);
    });

    tearDown(() {
      voice.dispose();
      draft.dispose();
    });

    test(
      'start opens a session and streams interim words into the draft',
      () async {
        await voice.start();

        expect(voice.state, VoiceDictationState.listening);
        expect(recognizer.initializeCalls, 1);
        expect(recognizer.listenCalls, 1);

        recognizer.emitInterim('run the');
        expect(draft.text, 'run the');
        recognizer.emitInterim('run the tests');
        expect(draft.text, 'run the tests');
        expect(draft.selection.baseOffset, 'run the tests'.length);
      },
    );

    test(
      'the final result replaces the interim words and ends the session',
      () async {
        await voice.start();
        recognizer.emitInterim('run the test');
        recognizer.emitFinal('Run the tests.');
        recognizer.emitDone();

        expect(draft.text, 'Run the tests.');
        expect(voice.state, VoiceDictationState.idle);
        expect(voice.dictated, isTrue);
      },
    );

    test(
      'final words keep restart disabled until the recognizer is done',
      () async {
        await voice.start();

        recognizer.emitFinal('Run the tests.');

        expect(draft.text, 'Run the tests.');
        expect(voice.state, VoiceDictationState.listening);
        await voice.start();
        expect(recognizer.listenCalls, 1);

        recognizer.emitDone();
        expect(voice.state, VoiceDictationState.idle);
      },
    );

    test(
      'dictation is inserted at the cursor with a separating space',
      () async {
        draft.value = const TextEditingValue(
          text: 'Please fix',
          selection: TextSelection.collapsed(offset: 'Please fix'.length),
        );
        await voice.start();
        recognizer.emitFinal('the build');
        recognizer.emitDone();

        expect(draft.text, 'Please fix the build');
      },
    );

    test('no separator is added after whitespace or at the start', () async {
      draft.value = const TextEditingValue(
        text: 'Please fix ',
        selection: TextSelection.collapsed(offset: 'Please fix '.length),
      );
      await voice.start();
      recognizer.emitFinal('the build');
      recognizer.emitDone();

      expect(draft.text, 'Please fix the build');
    });

    test('a draft without a selection appends at the end', () async {
      draft.text = 'Please fix';
      await voice.start();
      recognizer.emitFinal('the build');
      recognizer.emitDone();

      expect(draft.text, 'Please fix the build');
    });

    test('an edit while listening cancels the accumulated segment', () async {
      await voice.start();
      recognizer.emitInterim('hello');
      draft.value = const TextEditingValue(
        text: 'hello!',
        selection: TextSelection.collapsed(offset: 'hello!'.length),
      );
      recognizer.emitLateInterim('hello there');

      expect(draft.text, 'hello!');
      expect(recognizer.cancelCalls, 1);
      expect(voice.state, VoiceDictationState.idle);
    });

    test(
      'moving the cursor before the first result keeps dictation active',
      () async {
        draft.value = const TextEditingValue(
          text: 'hello world',
          selection: TextSelection.collapsed(offset: 'hello world'.length),
        );
        await voice.start();

        draft.selection = const TextSelection.collapsed(offset: 5);

        expect(recognizer.cancelCalls, 0);
        expect(voice.state, VoiceDictationState.listening);
      },
    );

    test(
      'stop asks the recognizer to finish and keeps the final words',
      () async {
        await voice.start();
        recognizer.emitInterim('wrap up');
        await voice.stop();

        expect(recognizer.stopCalls, 1);
        expect(voice.state, VoiceDictationState.listening);
        recognizer.emitFinal('Wrap up.');
        recognizer.emitDone();
        expect(draft.text, 'Wrap up.');
        expect(voice.state, VoiceDictationState.idle);
        expect(voice.dictated, isTrue);
      },
    );

    test('a session that times out keeps the interim words', () async {
      await voice.start();
      recognizer.emitInterim('half a thought');
      recognizer.emitTimeout();

      expect(draft.text, 'half a thought');
      expect(voice.state, VoiceDictationState.idle);
      expect(voice.dictated, isTrue);
      expect(voice.takeIssue(), isNull);
    });

    test('a segment end keeps its words and the next phrase follows', () async {
      await voice.start();
      recognizer.emitInterim('first phr');
      recognizer.emitSegmentEnd('first phrase');
      recognizer.emitInterim('second');
      recognizer.emitInterim('second phrase');

      expect(draft.text, 'first phrase second phrase');
      expect(voice.state, VoiceDictationState.listening);

      recognizer.emitFinal('second phrase.');
      recognizer.emitDone();
      expect(draft.text, 'first phrase second phrase.');
    });

    test('consecutive segment ends keep both phrases', () async {
      await voice.start();
      recognizer.emitSegmentEnd('first phrase');
      recognizer.emitSegmentEnd('second phrase');

      expect(draft.text, 'first phrase second phrase');
    });

    test(
      'a final after a segment end revises that segment instead of repeating it',
      () async {
        // Android stop mid-phrase: the recognizer endpoints the phrase, then
        // the plugin turns that same result into the session's final.
        await voice.start();
        recognizer.emitInterim('hello world this is');
        await voice.stop();
        recognizer.emitSegmentEnd('hello world this is a test');
        recognizer.emitFinal('hello world this is a test');
        recognizer.emitDone();

        expect(draft.text, 'hello world this is a test');
        expect(voice.state, VoiceDictationState.idle);
      },
    );

    test('an empty interim keeps the dictated words', () async {
      // Google's recognizer briefly reports no stable words while it
      // re-hypothesizes a phrase.
      await voice.start();
      recognizer.emitInterim('the quick brown fox');
      recognizer.emitInterim('');

      expect(draft.text, 'the quick brown fox');

      recognizer.emitInterim('the quick brown fox jumps');
      expect(draft.text, 'the quick brown fox jumps');
    });

    test(
      'an empty segment end settles the phrase so the next one follows',
      () async {
        await voice.start();
        recognizer.emitInterim('first we open the project');
        recognizer.emitSegmentEnd('');
        recognizer.emitInterim('');
        recognizer.emitInterim('then');
        recognizer.emitInterim('then we change');

        expect(draft.text, 'first we open the project then we change');
      },
    );

    test('an empty final keeps the dictated words', () async {
      await voice.start();
      recognizer.emitInterim('wrap up');
      await voice.stop();
      recognizer.emitFinal('');
      recognizer.emitDone();

      expect(draft.text, 'wrap up');
      expect(voice.state, VoiceDictationState.idle);
      expect(voice.dictated, isTrue);
    });

    test('a second session continues after the first words', () async {
      await voice.start();
      recognizer.emitFinal('First sentence.');
      recognizer.emitDone();
      await voice.start();
      recognizer.emitInterim('second');

      expect(draft.text, 'First sentence. second');
      expect(recognizer.initializeCalls, 2);
      expect(recognizer.listenCalls, 2);
    });

    test('typing after dictation clears the dictated marker', () async {
      await voice.start();
      recognizer.emitFinal('Dictated');
      recognizer.emitDone();
      expect(voice.dictated, isTrue);

      draft.text = 'Dictated and typed';

      expect(voice.dictated, isFalse);
    });

    test(
      'a declined permission reports an issue and leaves the draft alone',
      () async {
        recognizer.initialization =
            SpeechRecognizerInitialization.permissionDenied;
        draft.text = 'keep me';

        await voice.start();

        expect(voice.state, VoiceDictationState.error);
        expect(voice.takeIssue(), VoiceDictationIssue.permissionDenied);
        expect(voice.takeIssue(), isNull, reason: 'issues are one-shot');
        expect(draft.text, 'keep me');
        expect(recognizer.listenCalls, 0);
      },
    );

    test('unavailable recognition reports unavailable guidance', () async {
      recognizer.initialization = SpeechRecognizerInitialization.unavailable;

      await voice.start();

      expect(voice.state, VoiceDictationState.error);
      expect(voice.takeIssue(), VoiceDictationIssue.unavailable);
      expect(recognizer.listenCalls, 0);
    });

    test(
      'a recognizer that throws on initialize is reported as unavailable',
      () async {
        recognizer.initializeError = StateError('no plugin');

        await voice.start();

        expect(voice.state, VoiceDictationState.error);
        expect(voice.takeIssue(), VoiceDictationIssue.unavailable);
      },
    );

    test('start retries after an error', () async {
      recognizer.initialization =
          SpeechRecognizerInitialization.permissionDenied;
      await voice.start();
      expect(voice.state, VoiceDictationState.error);

      recognizer.initialization = SpeechRecognizerInitialization.ready;
      await voice.start();

      expect(voice.state, VoiceDictationState.listening);
    });

    test('silence errors end the session quietly', () async {
      await voice.start();
      recognizer.emitError('error_no_match', permanent: false);
      recognizer.emitTimeout();

      expect(voice.state, VoiceDictationState.idle);
      expect(voice.takeIssue(), isNull);
    });

    test('a permission error mid-session reports permissionDenied', () async {
      await voice.start();
      recognizer.emitError('error_permission', permanent: true);

      expect(voice.state, VoiceDictationState.error);
      expect(voice.takeIssue(), VoiceDictationIssue.permissionDenied);
    });

    test(
      'other errors report a generic failure and keep dictated words',
      () async {
        await voice.start();
        recognizer.emitInterim('so far');
        recognizer.emitError('error_network', permanent: false);

        expect(voice.state, VoiceDictationState.error);
        expect(voice.takeIssue(), VoiceDictationIssue.failed);
        expect(draft.text, 'so far');
      },
    );

    test('abandon cancels the recognizer without touching the draft', () async {
      await voice.start();
      recognizer.emitInterim('partial');

      await voice.abandon();

      expect(recognizer.cancelCalls, 1);
      expect(voice.state, VoiceDictationState.idle);
      expect(draft.text, 'partial');
    });

    test(
      'abandon while initializing cannot open the microphone later',
      () async {
        recognizer.initializeGate = () async {};
        final starting = voice.start();
        await Future<void>.delayed(Duration.zero);

        final abandoning = voice.abandon();
        await Future<void>.delayed(Duration.zero);
        recognizer.releaseInitialize();
        await Future.wait([starting, abandoning]);

        expect(recognizer.listenCalls, 0);
        expect(voice.state, VoiceDictationState.idle);
      },
    );

    test(
      'stale initialization does not cancel a newer dictation session',
      () async {
        recognizer.initializeGate = () async {};
        final staleStart = voice.start();
        await Future<void>.delayed(Duration.zero);

        await voice.abandon();
        recognizer.initializeGate = null;
        await voice.start();
        expect(voice.state, VoiceDictationState.listening);

        recognizer.releaseInitialize();
        await staleStart;

        expect(recognizer.cancelCalls, 1);
        expect(voice.state, VoiceDictationState.listening);
      },
    );

    test('notListening stays non-restartable until done', () async {
      await voice.start();
      recognizer.emitNotListening();

      await voice.start();

      expect(recognizer.listenCalls, 1);
      expect(voice.state, VoiceDictationState.listening);

      recognizer.emitDone();
      expect(voice.state, VoiceDictationState.idle);
    });

    test('start while listening is ignored', () async {
      await voice.start();
      await voice.start();

      expect(recognizer.listenCalls, 1);
    });

    test('late platform callbacks after dispose stay quiet', () async {
      final ownDraft = TextEditingController();
      final ownRecognizer = FakeSpeechRecognizer();
      final own = VoiceDictationController(
        draft: ownDraft,
        recognizer: ownRecognizer,
      );
      await own.start();
      ownRecognizer.emitInterim('partial');

      own.dispose();
      ownRecognizer.emitLateInterim('partial words');
      ownRecognizer.emitTimeout();

      expect(ownDraft.text, 'partial');
      ownDraft.dispose();
    });

    test(
      'dispose while initializing cannot open the microphone later',
      () async {
        final ownDraft = TextEditingController();
        final ownRecognizer = FakeSpeechRecognizer()
          ..initializeGate = (() async {});
        final own = VoiceDictationController(
          draft: ownDraft,
          recognizer: ownRecognizer,
        );
        final starting = own.start();
        await Future<void>.delayed(Duration.zero);

        own.dispose();
        ownRecognizer.releaseInitialize();
        await starting;

        expect(ownRecognizer.listenCalls, 0);
        ownDraft.dispose();
      },
    );

    test('notifies listeners on every state change', () async {
      var notifications = 0;
      voice.addListener(() => notifications += 1);

      await voice.start();
      recognizer.emitFinal('done');
      recognizer.emitDone();

      expect(notifications, greaterThanOrEqualTo(3));
    });
  });
}
