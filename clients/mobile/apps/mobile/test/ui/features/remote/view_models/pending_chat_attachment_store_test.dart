import 'package:mobile/ui/features/remote/view_models/pending_chat_attachment_store.dart';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import '../../../../support/fake_remote_control_repository.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';

void main() {
  group('RemoteControlViewModel chat attachments', () {
    RemoteControlViewModel connectedVm(FakeRemoteControlRepository repository) {
      return RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
    }

    RemoteChatMessage message(
      String messageId, {
      String chatId = 'chat-1',
      ChatRole role = ChatRole.assistant,
      ChatMessageStatus status = ChatMessageStatus.complete,
      RemoteChatScope? scope,
      String text = 'hello',
      List<ChatMessageAttachment> attachments = const [],
    }) => RemoteChatMessage(
      messageId: messageId,
      chatId: chatId,
      role: role,
      status: status,
      scope: scope,
      text: text,
      attachments: attachments,
    );

    Future<void> pump() => Future<void>.delayed(Duration.zero);

    const target = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );

    const attachmentRef = ChatAttachmentRef(
      attachmentId: 'a',
      filename: 'p.png',
      mediaType: 'image/png',
      size: 1,
      contentSha256: 'x',
      storageKind: 'blob',
      source: '/c',
    );

    ChatAttachmentDraft attachmentDraft({
      required String id,
      required Uint8List bytes,
    }) => ChatAttachmentDraft(
      localId: id,
      filename: '$id.png',
      mediaType: 'image/png',
      bytes: bytes,
      status: ChatAttachmentStatus.ready,
      uploaded: ChatAttachmentRef(
        attachmentId: id,
        filename: '$id.png',
        mediaType: 'image/png',
        size: bytes.length,
        contentSha256: 'a' * 64,
        storageKind: 'blob',
        source: '/$id',
      ),
    );

    test('optimistic send bubble carries attachment chips', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      await vm.sendChatMessage(
        target,
        'see',
        options: const RemoteChatSendOptions(attachments: [attachmentRef]),
      );

      expect(
        vm.messagesFor(target).single.attachments.single.filename,
        'p.png',
      );
    });

    test(
      'desktop echo without attachments keeps the optimistic attachments',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');

        await vm.sendChatMessage(
          target,
          'see',
          options: const RemoteChatSendOptions(attachments: [attachmentRef]),
        );

        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: message('echo-1', role: ChatRole.user, text: 'see'),
              ),
            ],
            nextCursor: 1,
          ),
        );
        await pump();

        final shown = vm.messagesFor(target);
        expect(shown, hasLength(1));
        expect(shown.single.attachments.single.filename, 'p.png');
        expect(shown.single.attachments.single.attachmentId, 'a');
      },
    );

    test(
      'attachment-only echoes reconcile by message id when they arrive out of order',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = connectedVm(repository);
        await vm.connect('123456');
        const secondAttachment = ChatAttachmentRef(
          attachmentId: 'b',
          filename: 'q.png',
          mediaType: 'image/png',
          size: 1,
          contentSha256: 'y',
          storageKind: 'blob',
          source: '/d',
        );

        await vm.sendChatMessage(
          target,
          '',
          options: const RemoteChatSendOptions(attachments: [attachmentRef]),
        );
        await vm.sendChatMessage(
          target,
          '',
          options: const RemoteChatSendOptions(attachments: [secondAttachment]),
        );
        final firstMessageId =
            repository.sendChatMessageCalls[0].options!.userMessageId!;
        final secondMessageId =
            repository.sendChatMessageCalls[1].options!.userMessageId!;

        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: message(
                  secondMessageId,
                  role: ChatRole.user,
                  text: '',
                ),
              ),
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: message(firstMessageId, role: ChatRole.user, text: ''),
              ),
            ],
            nextCursor: 1,
          ),
        );
        await pump();

        final shown = vm.messagesFor(target);
        expect(
          shown
              .singleWhere((message) => message.messageId == firstMessageId)
              .attachments
              .single
              .attachmentId,
          'a',
        );
        expect(
          shown
              .singleWhere((message) => message.messageId == secondMessageId)
              .attachments
              .single
              .attachmentId,
          'b',
        );
      },
    );

    test('desktop echo with a matching attachment count keeps the optimistic '
        'attachment identity', () async {
      // The desktop's echo mints its own attachment id (`path-<hash>`) and
      // a slugified filename for the same file. When the count matches the
      // pending bubble, keep the names/ids the user chose instead of the
      // desktop's derived ones.
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      await vm.sendChatMessage(
        target,
        'see',
        options: const RemoteChatSendOptions(attachments: [attachmentRef]),
      );

      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: message(
                'echo-1',
                role: ChatRole.user,
                text: 'see',
                attachments: const [
                  ChatMessageAttachment(
                    attachmentId: 'path-1',
                    filename: 'p.png',
                    mediaType: 'image/png',
                  ),
                ],
              ),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();

      final shown = vm.messagesFor(target);
      expect(shown, hasLength(1));
      expect(shown.single.attachments.single.attachmentId, 'a');
      expect(shown.single.attachments.single.filename, 'p.png');
    });

    test('desktop echo with a different attachment count wins over the '
        'optimistic ones', () async {
      final repository = FakeRemoteControlRepository();
      final vm = connectedVm(repository);
      await vm.connect('123456');

      await vm.sendChatMessage(
        target,
        'see',
        options: const RemoteChatSendOptions(attachments: [attachmentRef]),
      );

      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: message(
                'echo-1',
                role: ChatRole.user,
                text: 'see',
                attachments: const [
                  ChatMessageAttachment(
                    attachmentId: 'path-1',
                    filename: 'p.png',
                    mediaType: 'image/png',
                  ),
                  ChatMessageAttachment(
                    attachmentId: 'path-2',
                    filename: 'q.png',
                    mediaType: 'image/png',
                  ),
                ],
              ),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await pump();

      final shown = vm.messagesFor(target);
      expect(shown, hasLength(1));
      expect(shown.single.attachments.map((a) => a.attachmentId).toList(), [
        'path-1',
        'path-2',
      ]);
    });

    test('supportsChatAttachments follows the repository capability', () {
      final repository = FakeRemoteControlRepository()
        ..supportsChatAttachments = true;
      final vm = RemoteControlViewModel(repository: repository);
      expect(vm.supportsChatAttachments, isTrue);
      // Independent: older desktops announce attachments without creation.
      expect(vm.supportsStandaloneChatCreate, isFalse);
      repository.supportsStandaloneChatCreate = true;
      expect(vm.supportsStandaloneChatCreate, isTrue);
    });

    test(
      'session reset preserves retry bytes and their original generation',
      () {
        final store = PendingChatAttachmentStore();
        addTearDown(store.dispose);
        final draft = attachmentDraft(
          id: 'retry',
          bytes: Uint8List.fromList([1]),
        );
        final first = store.retainSubmittingChatAttachments(
          target: target,
          drafts: [draft],
          sessionGeneration: 7,
        );
        store.markPendingChatAttachmentsForRestore(first);
        store.reset();
        final retained = store.pendingChatAttachmentsFor(target).single;
        expect(retained.sessionGeneration, 7);
        expect(retained.restoreImmediately, isTrue);
        expect(retained.drafts.single, same(draft));
        final next = store.retainSubmittingChatAttachments(
          target: target,
          drafts: [draft],
          sessionGeneration: 8,
        );
        expect(next, isNot(first));
        store.removePendingChatAttachments(first);
        expect(store.pendingChatAttachmentsFor(target).single.commandId, next);
        store.dispose();
        expect(store.pendingChatAttachmentsFor(target), isEmpty);
      },
    );

    test('pending attachment drafts expire instead of living forever', () {
      var now = DateTime(2026, 9, 20, 12);
      final vm = PendingChatAttachmentStore(clock: () => now);
      addTearDown(vm.dispose);
      vm.retainPendingChatAttachments(
        sessionGeneration: 0,
        commandId: 'cmd-old',
        target: target,
        drafts: [
          attachmentDraft(id: 'old', bytes: Uint8List.fromList([1])),
        ],
      );

      now = now.add(const Duration(days: 1));

      expect(vm.pendingChatAttachmentsFor(target), isEmpty);
    });

    test('pending attachment drafts have an aggregate byte ceiling', () {
      final vm = PendingChatAttachmentStore();
      addTearDown(vm.dispose);
      final maxSizeBytes = Uint8List(kChatAttachmentMaxBytes);
      vm.retainPendingChatAttachments(
        sessionGeneration: 0,
        commandId: 'cmd-full',
        target: target,
        drafts: [
          for (var index = 0; index < kChatAttachmentsMaxPerMessage; index++)
            attachmentDraft(id: 'full-$index', bytes: maxSizeBytes),
        ],
      );
      vm.retainPendingChatAttachments(
        sessionGeneration: 0,
        commandId: 'cmd-new',
        target: target,
        drafts: [
          attachmentDraft(id: 'new', bytes: Uint8List.fromList([1])),
        ],
      );

      expect(
        vm.pendingChatAttachmentsFor(target).map((batch) => batch.commandId),
        ['cmd-new'],
      );
    });

    group('restore delivery', () {
      const otherChat = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        chatId: 'chat-2',
      );
      final worktreeKey = remoteWorktreeKey('ws-1', 'wt-1');

      List<String> take(
        PendingChatAttachmentStore store,
        RemoteChatTarget? shown, {
        int generation = 0,
        bool canReupload = true,
      }) => [
        for (final batch in store.takeRestorable(
          target: shown,
          worktree: worktreeKey,
          sessionGeneration: generation,
          canReupload: canReupload,
        ))
          batch.commandId,
      ];

      void retain(
        PendingChatAttachmentStore store,
        String commandId, {
        RemoteChatTarget chat = target,
        int generation = 0,
      }) => store.retainPendingChatAttachments(
        commandId: commandId,
        sessionGeneration: generation,
        target: chat,
        drafts: [attachmentDraft(id: commandId, bytes: Uint8List(1))],
      );

      test('a failed send restores only in its own chat, once', () {
        final store = PendingChatAttachmentStore();
        addTearDown(store.dispose);
        retain(store, 'send-1');
        expect(take(store, target), isEmpty);

        expect(store.markSendFailed('send-1'), isTrue);
        expect(store.markSendFailed('send-1'), isFalse);
        expect(take(store, otherChat), isEmpty);
        expect(take(store, target), ['send-1']);
        expect(take(store, target), isEmpty);
      });

      test('a failed provisional chat restores its batches anywhere in the '
          'worktree, but not a send still awaiting its response', () {
        final store = PendingChatAttachmentStore();
        addTearDown(store.dispose);
        retain(store, 'send-1', chat: otherChat);
        final submitting = store.retainSubmittingChatAttachments(
          sessionGeneration: 0,
          target: otherChat,
          drafts: [attachmentDraft(id: 'inflight', bytes: Uint8List(1))],
        );

        expect(
          store.markChatCreateFailed((
            scope: RemoteChatScope.worktree,
            chatId: 'chat-2',
          )),
          isTrue,
        );
        expect(take(store, target), ['send-1']);
        expect(
          store.pendingChatAttachmentsFor(otherChat).single.commandId,
          submitting,
        );

        // The send settles its own batch; an explicit mark restores it.
        store.markPendingChatAttachmentsForRestore(submitting);
        expect(take(store, null), [submitting]);
      });

      test('an older-session batch waits until it can be re-uploaded', () {
        final store = PendingChatAttachmentStore();
        addTearDown(store.dispose);
        retain(store, 'send-old', generation: 1);

        expect(
          store.hasRestorable(
            target: target,
            worktree: worktreeKey,
            sessionGeneration: 2,
            canReupload: false,
          ),
          isFalse,
        );
        expect(take(store, target, generation: 2, canReupload: false), isEmpty);
        expect(take(store, target, generation: 2), ['send-old']);
      });

      test('queries never prune; writes do', () {
        var now = DateTime(2026, 10, 5, 12);
        final store = PendingChatAttachmentStore(clock: () => now);
        addTearDown(store.dispose);
        retain(store, 'send-1');
        store.markSendFailed('send-1');

        now = now.add(kRemotePendingChatAttachmentRetention);
        expect(store.pendingChatAttachmentsFor(target), isEmpty);
        expect(
          store.hasRestorable(
            target: target,
            worktree: worktreeKey,
            sessionGeneration: 0,
            canReupload: true,
          ),
          isFalse,
        );
        // The queries above filtered the expired batch without removing it.
        now = now.subtract(const Duration(minutes: 1));
        expect(store.pendingChatAttachmentsFor(target), hasLength(1));

        now = now.add(const Duration(minutes: 1));
        retain(store, 'send-2');
        now = now.subtract(const Duration(minutes: 1));
        expect(
          store.pendingChatAttachmentsFor(target).map((b) => b.commandId),
          ['send-2'],
        );
      });
    });
  });
}
