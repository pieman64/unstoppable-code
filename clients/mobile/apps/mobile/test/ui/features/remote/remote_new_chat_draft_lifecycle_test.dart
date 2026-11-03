import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_destination_store.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/services/chat_destination_preference_store.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/composition/new_chat/new_chat_draft.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import '../../../support/cloud_chat_providers.dart';
import '../../../support/fake_remote_control_repository.dart';
import '../../../support/fake_speech_recognizer.dart';

void main() {
  for (final departure in ['tab', 'hidden', 'paused', 'detached']) {
    testWidgets('computer draft cancels dictation on $departure', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final speech = FakeSpeechRecognizer();
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'notes',
              order: 0,
              name: 'Notes',
              type: RemoteWorkspaceType.cowork,
            ),
          ],
          worktrees: [],
          standaloneChats: [],
        );
      final vm = RemoteControlViewModel(repository: repository);
      await tester.runAsync(() => vm.connect('123456'));
      final active = ValueNotifier(true);
      addTearDown(active.dispose);
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>(create: (_) => vm),
            Provider<ChatDestinationStore>.value(
              value: InMemoryChatDestinationStore(
                'computer:${vm.connection!.deviceLabel}',
              ),
            ),
            ...cloudChatTestProviders(draftStore: InMemoryChatDraftStore()),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            home: ValueListenableBuilder<bool>(
              valueListenable: active,
              builder: (_, isActive, _) => IndexedStack(
                index: isActive ? 0 : 1,
                children: [
                  NewChatDraft(isActive: isActive, speechRecognizer: speech),
                  const Text('Other tab'),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-mic')));
      await tester.pump();
      expect(speech.listening, isTrue);
      speech.emitInterim('keep these words');
      await tester.pump();
      if (departure == 'tab') {
        active.value = false;
      } else {
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        if (departure != 'hidden') {
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.paused,
          );
        }
        if (departure == 'detached') {
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.detached,
          );
        }
      }
      await tester.pump();
      expect(speech.cancelCalls, 1);
      expect(speech.listening, isFalse);
      speech.emitLateInterim('late words must not arrive');
      await tester.pump();
      active.value = true;
      if (departure == 'paused') {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      }
      if (departure == 'hidden' || departure == 'paused') {
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
      }
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      final input = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(input.controller!.text, 'keep these words');
      expect(tester.takeException(), isNull);
    });
  }
}
