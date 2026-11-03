import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_attachment_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';

import '../../../../support/fake_attachment_picker.dart';
import '../../../../support/fake_cloud_chat_repository.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeCloudChatRepository repository;
  late CloudChatsViewModel list;
  late CloudChatViewModel session;
  late ChatAttachmentController attachments;
  late CloudChatAttachmentViewModel flow;
  late ComposerDraftBinding binding;
  late TextEditingController composer;
  late ChatDraftStateStore store;

  setUp(() async {
    repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
    list = CloudChatsViewModel(repository: repository);
    await list.load();
    session = CloudChatViewModel(
      repository: repository,
      openStream: (_, {after}) => const Stream.empty(),
      observeLifecycle: false,
    );
    store = InMemoryChatDraftStore();
    session.attachDraftStore(store);
    composer = TextEditingController(text: 'Look');
    binding = ComposerDraftBinding(controller: composer, store: store)
      ..rebind(const CloudNewChatDraftTarget('ws-1'));
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('photo.png'),
      ]);
    attachments = ChatAttachmentController(uploader: null, picker: picker);
    flow = CloudChatAttachmentViewModel(
      session: session,
      list: list,
      attachments: attachments,
      drafts: binding,
    );
    await attachments.addFromPhotoLibrary();
  });

  tearDown(() {
    flow.dispose();
    attachments.dispose();
    binding.dispose();
    composer.dispose();
    session.dispose();
    list.dispose();
  });

  Future<void> create({
    String workspaceId = 'ws-1',
    void Function()? onBound,
  }) => flow.createAndSend(
    workspaceId: workspaceId,
    selection: const CloudSendPayload(text: ''),
    pluginSelections: null,
    canBind: () => true,
    onBound: (_) => onBound?.call(),
    currentPayload: () => CloudSendPayload(text: composer.text),
    onSent: composer.clear,
  );

  test('a bound chat refuses to send a staged file until it uploads', () async {
    session.open('chat-1', cursorEpoch: 'session-1');
    expect(flow.send(const CloudSendPayload(text: 'Look')), isFalse);
    expect(attachments.drafts.single.status, ChatAttachmentStatus.staged);
    expect(session.state!.outbox, isEmpty);
    await flow.bindAttachments('chat-1');
    expect(flow.send(const CloudSendPayload(text: 'Look')), isTrue);
    expect(session.messages.last.attachments.single.filename, 'photo.png');
  });

  test('create binds the draft, uploads, and sends the current text', () async {
    await create(onBound: () => composer.text = 'Updated while creating');
    final id = repository.createCalls.single.externalId;
    expect(binding.target, CloudChatDraftTarget(id));
    expect(repository.uploadCalls.single.chatId, id);
    expect(session.messages.last.text, 'Updated while creating');
    expect(session.messages.last.attachments.single.filename, 'photo.png');
    expect(composer.text, isEmpty);
    expect(attachments.isEmpty, isTrue);
  });

  test('a failed create retains the retry identity and staged files', () async {
    repository.createError = const CloudApiException(
      statusCode: 503,
      message: 'Try later',
    );
    await expectLater(create(), throwsA(isA<CloudApiException>()));
    final id = repository.createCalls.single.externalId;
    expect(attachments.drafts.single.status, ChatAttachmentStatus.staged);
    expect(composer.text, 'Look');
    repository.createError = null;
    await create();
    expect(repository.createCalls.last.externalId, id);
    expect(session.messages.last.attachments.single.filename, 'photo.png');
  });

  test(
    'create retries keep separate identities across workspace switches',
    () async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'ws-2', chats: []),
      ];
      await list.load();
      repository.createError = const CloudApiException(
        statusCode: 503,
        message: 'Try later',
      );
      await expectLater(create(), throwsA(isA<CloudApiException>()));
      final firstId = repository.createCalls.single.externalId;
      expect(flow.hasPendingCreateFor('ws-1'), isTrue);
      expect(flow.hasPendingCreateFor('ws-2'), isFalse);
      expect(flow.hasPendingCreateFor(null), isFalse);
      await expectLater(
        create(workspaceId: 'ws-2'),
        throwsA(isA<CloudApiException>()),
      );
      final secondId = repository.createCalls.last.externalId;
      expect(secondId, isNot(firstId));
      await expectLater(
        create(workspaceId: 'ws-2'),
        throwsA(isA<CloudApiException>()),
      );
      expect(repository.createCalls.last.externalId, secondId);
      repository.createError = null;
      await create();
      expect(repository.createCalls.last.externalId, firstId);
      expect(flow.hasPendingCreateFor('ws-1'), isFalse);
      expect(flow.hasPendingCreateFor('ws-2'), isTrue);
      expect(repository.uploadCalls.single.chatId, firstId);
      expect(session.messages.last.attachments.single.filename, 'photo.png');
    },
  );

  for (final invalidate in ['dispose', 'account', 'conversation']) {
    test('a $invalidate change during upload prevents the send', () async {
      final uploaded = Completer<void>();
      repository.uploadHandler = (chatId, bytes) async {
        await uploaded.future;
        return ChatAttachmentRef(
          attachmentId: 'uploaded',
          filename: 'photo.png',
          mediaType: 'image/png',
          size: 3,
          contentSha256: 'a' * 64,
          storageKind: 'blob',
          source: '/cloud/$chatId',
        );
      };
      final bound = Completer<void>();
      final creating = create(onBound: bound.complete);
      await bound.future;
      switch (invalidate) {
        case 'dispose':
          flow.dispose();
        case 'account':
          list.reset();
        case 'conversation':
          session.open('chat-1', cursorEpoch: 'other-session');
      }
      uploaded.complete();
      await creating;
      expect(repository.postCalls, isEmpty);
      expect(composer.text, 'Look');
      expect(attachments.isEmpty, isFalse);
    });
  }
}
