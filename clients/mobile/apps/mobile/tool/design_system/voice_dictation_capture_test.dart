// Composer voice dictation (mobile): before/after captures of the remote chat
// composer with the new microphone control, in both color modes.
//
//   VOICE_STAGE=before flutter test tool/design_system/voice_dictation_capture_test.dart --update-goldens
//   VOICE_STAGE=after  flutter test tool/design_system/voice_dictation_capture_test.dart --update-goldens
//
// "before" renders ChatInput without a dictation controller, which is
// exactly the pre-change composer (the mic renders only when one is supplied).
// "after" walks every mic state through a scripted FakeSpeechRecognizer:
// idle, connecting, listening with interim words, error, and the permission
// guidance dialog. Deterministic: bundled fonts, no platform channels, no
// network. Output lands in .playwright/mobile-voice-dictation/.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/voice_dictation_dialog.dart';

import '../../test/support/fake_speech_recognizer.dart';
import '../../test/support/reduced_motion.dart';

void main() {
  group('composer voice dictation captures', () {
    useReducedMotion();

    final stage = Platform.environment['VOICE_STAGE'] ?? 'after';

    ComposerControlsData controls({bool running = false}) =>
        ComposerControlsData(
          providerType: 'claude',
          modelLabel: 'Claude Sonnet 4.5',
          selectedModelId: 'claude-sonnet',
          availableModels: const [
            ModelOption(
              id: 'claude-sonnet',
              label: 'Claude Sonnet 4.5',
              provider: 'claude',
              vendor: 'anthropic',
              kind: 'model',
              available: true,
            ),
          ],
          providerAvailability: const ProviderAvailability(
            claude: true,
            codex: true,
          ),
          planMode: PlanModeControl(enabled: false, onToggle: () {}),
          effort: EffortControl(
            level: 'off',
            levels: const ['off', 'medium', 'high', 'xhigh', 'max'],
            onSelect: (_) async => true,
          ),
          speed: CanopyEffortSpeed.regular,
          supportsFastMode: false,
          isRunning: running,
          onSelectModel: (_) {},
          onToggleFast: () {},
          onStop: () {},
          catalogStatus: ModelCatalogStatus.loaded,
        );

    for (final dark in [false, true]) {
      final mode = dark ? 'dark' : 'light';

      testWidgets('composer mic states ($mode)', (tester) async {
        tester.view.physicalSize = const Size(1170, 2532);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);
        final inter = FontLoader('Inter')
          ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
        await inter.load();
        final icons = FontLoader('MaterialIcons')
          ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
        await icons.load();

        final draft = TextEditingController();
        addTearDown(draft.dispose);
        final recognizer = FakeSpeechRecognizer();
        final voice = VoiceDictationController(
          draft: draft,
          recognizer: recognizer,
        );
        addTearDown(voice.dispose);
        final navigatorKey = GlobalKey<NavigatorState>();

        await tester.pumpWidget(
          MaterialApp(
            navigatorKey: navigatorKey,
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            darkTheme: AppTheme.dark,
            home: Builder(
              builder: (context) {
                return Scaffold(
                  body: Align(
                    alignment: Alignment.bottomCenter,
                    child: RepaintBoundary(
                      key: const ValueKey('composer-capture'),
                      child: ChatInput(
                        controller: draft,
                        sending: false,
                        onSend: () {},
                        controls: controls(),
                        voice: stage == 'before' ? null : voice,
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        );
        await tester.pumpAndSettle();

        Future<void> capture(String name) => expectLater(
          find.byKey(const ValueKey('composer-capture')),
          matchesGoldenFile(
            '../../../../.playwright/mobile-voice-dictation/$name-$stage-$mode.png',
          ),
        );

        draft.text = 'Please';
        await tester.pump();
        await capture('composer-idle');
        if (stage == 'before') return;

        // Hold the recognizer in "connecting" by not answering initialize.
        recognizer.initializeGate = () async {};
        final starting = voice.start();
        await tester.pump();
        await capture('composer-connecting');
        recognizer.releaseInitialize();
        await starting;
        await tester.pump();

        recognizer.emitInterim('run the tests and report');
        await tester.pump();
        await capture('composer-listening');

        recognizer.emitError('error_network', permanent: false);
        await tester.pump();
        await capture('composer-error');

        // Guidance dialog for a declined permission, captured full-screen.
        final dialog = showVoiceDictationIssueDialog(
          navigatorKey.currentContext!,
          VoiceDictationIssue.permissionDenied,
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            '../../../../.playwright/mobile-voice-dictation/permission-dialog-$stage-$mode.png',
          ),
        );
        await tester.tap(find.byKey(const ValueKey('voice-dictation-close')));
        await tester.pumpAndSettle();
        await dialog;
      });
    }
  });
}
