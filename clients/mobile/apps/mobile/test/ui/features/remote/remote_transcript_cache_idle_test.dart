import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/memory_remote_transcript_storage.dart';
import '../../../support/fake_remote_control_repository.dart';
import '../../../support/remote_transcript_cache_fixture.dart';

final class _RestoringRepository extends FakeRemoteControlRepository {
  @override
  Future<RemoteConnection?> restoreSession() => connect('restored');
}

void main() {
  testWidgets(
    'a chat mounted before restoration persists later live revisions',
    (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      const chat = Can3373Chat.standalone;
      final storage = MemoryRemoteTranscriptStorage();
      final repository = _RestoringRepository()
        ..connectedSessionId = kCan3373SessionId
        ..cachedChatMessages = can3373Rows(chat, 0, 2);
      final cache = RemoteTranscriptCache(
        storage: storage,
        accountScope: kCan3373AccountScope,
      );
      final vm = RemoteControlViewModel(
        repository: repository,
        transcriptCache: cache,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.pumpWidget(can3373ChatHost(vm, chat));
      await tester.pump();
      expect(vm.isConnected, isFalse);
      final generation = vm.sessionGeneration;
      await vm.restoreIfIdle();
      await tester.pumpAndSettle();
      expect(vm.isConnected, isTrue);
      expect(vm.sessionGeneration, generation);
      final latest = can3373Row(
        chat,
        2,
        text: 'Live revision after restoration',
      );
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: 1,
          events: [
            RemoteChatMessageEvent(
              chatId: chat.chatId,
              scope: chat.scope,
              message: latest,
            ),
          ],
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      await cache.flush();
      expect(vm.messagesFor(chat.target).last.text, latest.text);
      const owner = (
        accountScope: kCan3373AccountScope,
        sessionId: kCan3373SessionId,
      );
      expect(
        storage
            .files[owner]?[(scope: chat.scope, chatId: chat.chatId)]
            ?.rows
            .last
            .text,
        latest.text,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      cache.close();
    },
  );

  testWidgets('two mounted chats do not rewrite idle tails on notifications', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final storage = MemoryRemoteTranscriptStorage();
    const owner = (
      accountScope: kCan3373AccountScope,
      sessionId: kCan3373SessionId,
    );
    storage.files[owner] = {
      for (final chat in Can3373Chat.values)
        (scope: chat.scope, chatId: chat.chatId): PersistedTranscript(
          chat: (scope: chat.scope, chatId: chat.chatId),
          openedAt: chat.index + 1,
          rows: can3373Rows(chat, 0, 2),
        ),
    };
    final repository = Can3373Repository();
    final cache = RemoteTranscriptCache(
      storage: storage,
      accountScope: owner.accountScope,
    );
    final vm = RemoteControlViewModel(
      repository: repository,
      transcriptCache: cache,
      stateRefreshDebounce: Duration.zero,
    );
    await vm.connect('123456');
    await cache.restoreSession(kCan3373SessionId);
    final active = ValueNotifier(1);
    addTearDown(active.dispose);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: vm),
          ChangeNotifierProvider(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: ValueListenableBuilder<int>(
            valueListenable: active,
            builder: (context, index, child) => IndexedStack(
              index: index,
              children: [
                RemoteChatScreen.worktree(
                  worktree: kCan3373Worktree,
                  initialChatId: 'chat-worktree',
                  isActive: index == 0,
                ),
                RemoteChatScreen.standalone(
                  standaloneChat: kCan3373StandaloneChat,
                  isActive: index == 1,
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await cache.flush();
    final before = storage.log.where((row) => row.startsWith('write ')).length;
    final hiddenRecency = storage
        .files[owner]![(
          scope: RemoteChatScope.worktree,
          chatId: 'chat-worktree',
        )]!
        .openedAt;
    // Unrelated shell changes notify both mounted screens. Neither chat changes.
    for (var i = 0; i < 6; i++) {
      vm.allowDesktop(notify: false);
      vm.settleWithoutDesktop();
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: i + 1,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'overview',
              workspaces: [
                RemoteWorkspace(
                  localId: 'ws-cache',
                  name: 'Workspace $i',
                  type: RemoteWorkspaceType.singleRepo,
                ),
              ],
            ),
          ],
        ),
      );
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
    }
    await cache.flush();
    expect(
      storage.log.where((row) => row.startsWith('write ')),
      hasLength(before),
    );
    expect(
      hiddenRecency,
      1,
      reason: 'The covered chat never became foreground',
    );
    active.value = 0;
    await tester.pumpAndSettle();
    await cache.flush();
    expect(
      storage.log.where((row) => row.startsWith('write ')),
      hasLength(before + 1),
    );
    final nowVisible =
        storage.files[owner]![(
          scope: RemoteChatScope.worktree,
          chatId: 'chat-worktree',
        )]!;
    final nowHidden =
        storage.files[owner]![(
          scope: RemoteChatScope.standalone,
          chatId: 'chat-standalone',
        )]!;
    expect(nowVisible.openedAt, greaterThan(nowHidden.openedAt));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
    cache.close();
  });
}
