// New-chat state regression. Fake desktop projection, no live agents or network.
// NEW_CHAT_CAPTURE=1 NEW_CHAT_STAGE=before flutter test test/capture/new_chat_state_capture_test.dart --update-goldens
// Repeat with NEW_CHAT_STAGE=after (default). Both color modes run together.
//
// The destination layout checks (CAN-2932) always run; with NEW_CHAT_CAPTURE=1
// they also write .playwright/can-2932-chat-destination/*.png.
import 'dart:io';
import 'package:flutter/services.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/data/models/chat_destination_store.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/services/chat_destination_preference_store.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/composition/new_chat/new_chat_draft.dart';

import '../support/cloud_chat_providers.dart';
import '../support/fake_cloud_chat_repository.dart';
import '../support/fake_remote_control_repository.dart';

void main() {
  final enabled = Platform.environment['NEW_CHAT_CAPTURE'] == '1';
  final stage = Platform.environment['NEW_CHAT_STAGE'] == 'before'
      ? 'before'
      : 'after';
  setUpAll(() async {
    if (!enabled) return;
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    final icons = await File(
      '${Platform.environment['FLUTTER_ROOT']!}/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    ).readAsBytes();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(Future.value(ByteData.sublistView(icons)))).load();
  });
  for (final dark in [false, true]) {
    Widget buildSubject(RemoteControlViewModel viewModel, Widget screen) {
      return MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          debugShowCheckedModeBanner: false,
          darkTheme: AppTheme.dark,
          home: RepaintBoundary(key: const ValueKey('capture'), child: screen),
        ),
      );
    }

    testWidgets('new active chat ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      const projectTurn = true;
      final repository = FakeRemoteControlRepository();
      RemoteChatSummary summary(String id, {required bool active}) =>
          RemoteChatSummary.fromJson({
            'chatId': id,
            'scope': 'worktree',
            'workspaceLocalId': 'ws-1',
            'worktreeLocalId': 'wt-1',
            'title': id == 'chat-a' ? 'Chat A' : 'New chat',
            'active': active,
            if (projectTurn) 'turnActive': id == 'chat-a',
            'availableModels': [
              {
                'id': 'gpt-5-codex',
                'label': 'GPT-5 Codex',
                'provider': 'codex',
                'kind': 'model',
                'available': true,
                'isDefault': true,
              },
            ],
          });
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        standaloneChats: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
            isStreaming: true,
          ),
        ],
        chatSummaries: [summary('chat-a', active: true)],
        chatMessages: const [
          RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.streaming,
            text: 'Running in Chat A',
          ),
        ],
      );
      final vm = RemoteControlViewModel(repository: repository);

      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        buildSubject(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
        ),
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.byKey(const ValueKey('new-chat-button')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      final id = repository.createChatTabTargets.single.chatId!;
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              chatSummaries: [
                summary('chat-a', active: false),
                summary(id, active: true),
              ],
            ),
          ],
          nextCursor: 2,
        ),
      );
      await tester.pump();
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetChatId: id,
              targetChatScope: RemoteChatScope.worktree,
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
          nextCursor: 3,
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      Directory('../../.playwright/new-chat-state').createSync(recursive: true);
      await expectLater(
        find.byKey(const ValueKey('capture')),
        matchesGoldenFile(
          '../../../../.playwright/new-chat-state/new-chat-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      vm.dispose();
    }, skip: !enabled);
  }

  // CAN-2932: the destination control, the composer toolbar and the text
  // field stay apart and reachable with the keyboard up, on narrow phones.
  for (final dark in [false, true]) {
    for (final size in const [Size(360, 800), Size(390, 844)]) {
      for (final destination in ['cloud', 'computer-offline']) {
        final mode = dark ? 'dark' : 'light';
        final name =
            '$destination-${size.width.toInt()}x${size.height.toInt()}-$mode';
        testWidgets('new chat destination $name', (tester) async {
          tester.view.physicalSize = size;
          tester.view.devicePixelRatio = 1;
          tester.view.viewInsets = const FakeViewPadding(bottom: 300);
          addTearDown(tester.view.reset);
          final remote = _OfflineStudioRepository();
          final vm = RemoteControlViewModel(repository: remote);
          await tester.runAsync(vm.restoreIfIdle);
          final draftStore = InMemoryChatDraftStore();
          await tester.pumpWidget(
            MultiProvider(
              providers: [
                ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
                ...cloudChatTestProviders(
                  repository: FakeCloudChatRepository(
                    workspaces: [sampleWorkspace()],
                  ),
                  draftStore: draftStore,
                ),
                Provider<ChatDestinationStore>.value(
                  value: InMemoryChatDestinationStore(
                    destination == 'cloud' ? 'cloud' : 'computer:Studio',
                  ),
                ),
              ],
              child: MaterialApp(
                theme: dark ? AppTheme.dark : AppTheme.light,
                debugShowCheckedModeBanner: false,
                home: const RepaintBoundary(
                  key: ValueKey('capture'),
                  child: NewChatDraft(),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Fix the flaky login test and open a PR',
          );
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull);
          final control = tester.getRect(
            find.byKey(const ValueKey('new-chat-project-pill')),
          );
          final field = tester.getRect(
            find.byKey(const ValueKey('composer-draft')),
          );
          final send = tester.getRect(
            find.byKey(const ValueKey('composer-send')),
          );
          final keyboardTop = size.height - 300;
          expect(control.bottom, lessThanOrEqualTo(field.top));
          expect(field.bottom, lessThanOrEqualTo(send.top));
          expect(send.bottom, lessThanOrEqualTo(keyboardTop));
          expect(control.left, greaterThanOrEqualTo(0));
          expect(control.right, lessThanOrEqualTo(size.width));
          expect(control.height, greaterThanOrEqualTo(48));
          if (destination == 'cloud') {
            final toolbar = tester.getRect(find.byType(ComposerToolbar));
            expect(field.bottom, lessThanOrEqualTo(toolbar.top));
            expect(toolbar.bottom, lessThanOrEqualTo(keyboardTop));
          } else {
            final toolbar = tester.getRect(find.byType(ComposerToolbar));
            expect(field.bottom, lessThanOrEqualTo(toolbar.top));
            expect(toolbar.bottom, lessThanOrEqualTo(keyboardTop));
            final reconnect = tester.getRect(
              find.byKey(const ValueKey('remote-new-chat-reconnect')),
            );
            expect(reconnect.height, greaterThanOrEqualTo(48));
            expect(reconnect.bottom, lessThanOrEqualTo(control.top));
            expect(
              tester
                  .widget<CanopyComposerAction>(
                    find.byKey(const ValueKey('composer-send')),
                  )
                  .onPressed,
              isNull,
            );
          }
          if (enabled) {
            Directory(
              '../../.playwright/can-2932-chat-destination',
            ).createSync(recursive: true);
            await expectLater(
              find.byKey(const ValueKey('capture')),
              matchesGoldenFile(
                '../../../../.playwright/can-2932-chat-destination/'
                'new-chat-$name.png',
              ),
            );
            if (size.width == 390 && destination == 'computer-offline') {
              // The project list: Cloud's and the computer's in one list.
              await tester.tap(
                find.byKey(const ValueKey('new-chat-project-pill')),
              );
              await tester.pumpAndSettle();
              await expectLater(
                find.byType(MaterialApp),
                matchesGoldenFile(
                  '../../../../.playwright/can-2932-chat-destination/'
                  'new-chat-project-list-$mode.png',
                ),
              );
            }
          }
          vm.dispose();
        });
      }
    }
  }
}

/// A paired computer named Studio whose desktop stopped answering, with one
/// project.
final class _OfflineStudioRepository extends FakeRemoteControlRepository {
  _OfflineStudioRepository() {
    snapshotBuilder = () => RemoteSessionSnapshot(
      workspaces: const [
        RemoteWorkspace(
          localId: 'ws-mobile',
          name: 'Mobile App',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: const [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-mobile',
          branch: 'feature/login',
          label: 'otter',
        ),
      ],
      standaloneChats: const [],
      chatSummaries: [
        RemoteChatSummary.fromJson({
          'chatId': 'chat-1',
          'scope': 'worktree',
          'workspaceLocalId': 'ws-mobile',
          'worktreeLocalId': 'wt-1',
          'title': 'Login fix',
          'active': true,
          'model': 'gpt-6.1-sol',
          'providerType': 'codex',
          'thinkingLevel': 'high',
          'availableModels': [
            {
              'id': 'gpt-6.1-sol',
              'label': 'GPT 6.1 Sol',
              'provider': 'codex',
              'vendor': 'openai',
              'kind': 'model',
              'available': true,
            },
            {
              'id': 'claude-sonnet',
              'label': 'Claude Sonnet 4.5',
              'provider': 'claude',
              'vendor': 'anthropic',
              'kind': 'model',
              'available': true,
              'isDefault': true,
            },
          ],
        }),
      ],
    );
  }

  @override
  Future<RemoteConnection?> restoreSession() async => RemoteConnection(
    deviceLabel: 'Studio',
    pairedAt: DateTime(2026),
    connectionStatus: RemotePortalConnectionStatus.inactive,
  );
}
