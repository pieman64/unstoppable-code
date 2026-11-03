import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_unsent_records.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_cloud_chat_repository.dart';

/// Per-target cloud drafts and durable first messages (CAN-3556).
void main() {
  group('CloudChatScreen drafts', () {
    late FakeCloudChatRepository repository;
    late CloudChatsViewModel list;
    late CloudChatViewModel chat;
    late InMemoryChatDraftStore store;
    late List<StreamController<CloudSseFrame>> streams;

    Widget host(Widget Function() screen) => MultiProvider(
      providers: [
        ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
        ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
        ChangeNotifierProvider<ChatDraftStoreHolder>.value(
          value: ChatDraftStoreHolder(store),
        ),
      ],
      child: MaterialApp(
        theme: AppTheme.light,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              key: const ValueKey('open'),
              onPressed: () => Navigator.of(
                context,
              ).push(MaterialPageRoute<void>(builder: (_) => screen())),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );

    Future<void> openChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        host(() => const CloudChatScreen(chatId: 'chat-1')),
      );
      await list.load();
      await list.ensureModels();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      expect(tester.takeException(), isNull);
    }

    Future<void> send(WidgetTester tester, String text) async {
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        text,
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
    }

    Future<void> openDraft(WidgetTester tester, {String? workspaceId}) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        host(() => CloudChatScreen.create(initialWorkspaceId: workspaceId)),
      );
      await list.load();
      await list.ensureModels();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
    }

    setUp(() {
      repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
      list = CloudChatsViewModel(repository: repository);
      streams = [];
      store = InMemoryChatDraftStore();
      chat = CloudChatViewModel(
        repository: repository,
        openStream: (_, {after}) {
          final controller = StreamController<CloudSseFrame>();
          streams.add(controller);
          return controller.stream;
        },
        observeLifecycle: false,
      )..attachDraftStore(store);
    });

    tearDown(() async {
      chat.dispose();
      list.dispose();
      for (final stream in streams) {
        await stream.close();
      }
    });

    testWidgets('an existing chat restores its draft after remount', (
      tester,
    ) async {
      store.setDraft(const CloudChatDraftTarget('chat-1'), 'half written');
      await openChat(tester);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.controller!.text, 'half written');
    });

    testWidgets('text typed before projects load is kept for the project', (
      tester,
    ) async {
      final projects = Completer<List<CloudWorkspaceSummary>>();
      repository.listCompleter = projects;
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(host(CloudChatScreen.create));
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      expect(list.isLoading, isTrue);
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'typed early',
      );
      await tester.pump();

      repository.listCompleter = null;
      projects.complete([sampleWorkspace()]);
      await tester.pumpAndSettle();

      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.controller!.text, 'typed early');
      expect(
        store.draftFor(const CloudNewChatDraftTarget('ws-1')),
        'typed early',
      );
    });

    testWidgets('each project keeps its own new-chat draft', (tester) async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'w2', name: 'Second project', chats: []),
      ];
      store.setDraft(const CloudNewChatDraftTarget('w2'), 'for w2');
      await openDraft(tester, workspaceId: 'w2');
      expect(find.text('for w2'), findsOneWidget);
    });

    testWidgets('a failed create shows a not-sent row and reuses externalId', (
      tester,
    ) async {
      repository.createError = const CloudApiException(
        statusCode: 402,
        message: 'Not enough credits',
      );
      await openDraft(tester);
      await send(tester, 'keep this text');
      await tester.pumpAndSettle();
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('Not enough credits'), findsOneWidget);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.controller!.text, '');

      repository.createError = null;
      await tester.tap(find.textContaining('Resend'));
      // Not pumpAndSettle: the created chat's running turn keeps animating.
      await tester.pump();
      await tester.pump();
      expect(repository.createCalls, hasLength(2));
      expect(
        repository.createCalls.last.externalId,
        repository.createCalls.first.externalId,
      );
      expect(repository.postCalls.single.text, 'keep this text');
    });

    testWidgets('pending create uses the injected clock', (tester) async {
      final now = DateTime.utc(2026, 10, 4, 12);
      repository.createError = const CloudApiException(
        statusCode: 402,
        message: 'Not enough credits',
      );
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        host(
          () => CloudChatScreen.create(
            initialWorkspaceId: 'ws-1',
            now: () => now,
          ),
        ),
      );
      await list.load();
      await list.ensureModels();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      await send(tester, 'first message');
      await tester.pumpAndSettle();
      expect(cloudPendingCreates(store, 'ws-1').single.createdAt, now);
    });

    testWidgets('text typed while the chat is created moves to that chat', (
      tester,
    ) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'first message');
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'typed meanwhile',
      );
      await tester.pump();

      creating.complete();
      await tester.pump();
      await tester.pump();

      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.controller!.text, 'typed meanwhile');
      final chatId = repository.createCalls.single.externalId;
      expect(store.draftFor(CloudChatDraftTarget(chatId)), 'typed meanwhile');
      expect(store.draftFor(const CloudNewChatDraftTarget('ws-1')), isEmpty);
    });

    testWidgets('Discard removes a failed new-chat message', (tester) async {
      repository.createError = const CloudApiException(
        statusCode: 402,
        message: 'Not enough credits',
      );
      await openDraft(tester);
      await send(tester, 'drop me');
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Discard'));
      await tester.pumpAndSettle();
      expect(find.text('drop me'), findsNothing);
      expect(store.unsentFor('cloud'), isEmpty);
    });

    testWidgets('a pending create survives remounting the draft screen', (
      tester,
    ) async {
      repository.createError = const CloudApiException(
        statusCode: 500,
        message: 'Server error',
      );
      await openDraft(tester);
      await send(tester, 'try later');
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await openDraft(tester);
      expect(find.text('try later'), findsOneWidget);
      expect(find.text('Not sent'), findsOneWidget);
    });

    testWidgets('a failed send in a chat shows Resend and Discard', (
      tester,
    ) async {
      repository.postError = const CloudSendError(
        kind: CloudSendErrorKind.definitive,
        status: 400,
        message: 'bad request',
      );
      await openChat(tester);
      await send(tester, 'oops');
      await tester.pumpAndSettle();
      expect(find.text('Not sent'), findsOneWidget);
      await tester.tap(find.textContaining('Discard'));
      await tester.pumpAndSettle();
      expect(find.text('oops'), findsNothing);
    });

    CloudUnsentRecord seedPendingCreate({
      String workspaceId = 'ws-1',
      required String externalId,
      String text = 'stored first message',
      UnsentStatus status = UnsentStatus.sending,
      DateTime? createdAt,
    }) {
      final record = CloudUnsentRecord.pendingCreate(
        workspaceId: workspaceId,
        externalId: externalId,
        clientRequestId: 'request-$externalId',
        payload: CloudSendPayload(text: text),
        createdAt: createdAt ?? DateTime.now(),
      ).copyWith(status: status);
      store.putUnsent(record.toUnsentRecord());
      return record;
    }

    testWidgets('a pending create whose chat landed moves to that chat', (
      tester,
    ) async {
      // `chat-1` is already in the project: the create landed before the
      // app closed.
      seedPendingCreate(externalId: 'chat-1');
      await openDraft(tester);

      expect(find.text('stored first message'), findsNothing);
      expect(find.text('What would you like to do?'), findsOneWidget);
      expect(cloudPendingCreates(store, 'ws-1'), isEmpty);
      final moved = cloudRecordsForChat(store, 'chat-1').single;
      expect(moved.payload.text, 'stored first message');
      expect(moved.status, UnsentStatus.uncertain);
    });

    testWidgets('opening a landed chat shows its pending first message', (
      tester,
    ) async {
      seedPendingCreate(externalId: 'chat-1');

      await openChat(tester);

      expect(find.text('stored first message'), findsOneWidget);
      expect(find.text('Delivery uncertain'), findsOneWidget);
      expect(find.textContaining('Resend'), findsOneWidget);
      expect(find.textContaining('Discard'), findsOneWidget);
    });

    testWidgets('a landed first message joins an already-open chat session', (
      tester,
    ) async {
      await openChat(tester);
      Navigator.of(
        tester.element(find.byKey(const ValueKey('cloud-chat-screen'))),
      ).pop();
      await tester.pumpAndSettle();
      seedPendingCreate(externalId: 'chat-1');
      await openDraft(tester);
      expect(cloudRecordsForChat(store, 'chat-1'), hasLength(1));

      Navigator.of(
        tester.element(find.byKey(const ValueKey('cloud-new-chat-screen'))),
      ).pop();
      await tester.pumpAndSettle();
      await openChat(tester);
      expect(find.text('stored first message'), findsOneWidget);
      await send(tester, 'next message');
      expect(
        cloudRecordsForChat(store, 'chat-1').map((r) => r.payload.text),
        contains('stored first message'),
      );
    });

    testWidgets('an interrupted pending create shows as delivery uncertain', (
      tester,
    ) async {
      seedPendingCreate(externalId: 'never-landed');
      await openDraft(tester);

      expect(find.text('stored first message'), findsOneWidget);
      expect(find.text('Delivery uncertain'), findsOneWidget);
      expect(
        cloudPendingCreates(store, 'ws-1').single.status,
        UnsentStatus.uncertain,
      );
      expect(repository.createCalls, isEmpty);
    });

    testWidgets("another project's pending create is not shown", (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'w2', name: 'Second project', chats: []),
      ];
      seedPendingCreate(workspaceId: 'w2', externalId: 'other-chat');
      await openDraft(tester);

      expect(find.text('stored first message'), findsNothing);
      expect(find.text('Delivery uncertain'), findsNothing);
      expect(cloudPendingCreates(store, 'w2'), hasLength(1));
    });

    testWidgets('a create that fails after its screen left shows on the next '
        'draft', (tester) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'sent then left');

      // Leave while the create is pending and open a fresh draft.
      Navigator.of(
        tester.element(find.byKey(const ValueKey('cloud-new-chat-screen'))),
      ).pop();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
      expect(find.text('sent then left'), findsNothing);

      repository.createError = const CloudApiException(
        statusCode: 500,
        message: 'Server error',
      );
      creating.complete();
      await tester.pumpAndSettle();

      expect(find.text('sent then left'), findsOneWidget);
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('Server error'), findsOneWidget);
    });

    testWidgets('discarding the newest pending create shows an older one', (
      tester,
    ) async {
      final now = DateTime.now();
      seedPendingCreate(
        externalId: 'older',
        text: 'older message',
        status: UnsentStatus.notSent,
        createdAt: now.subtract(const Duration(minutes: 5)),
      );
      seedPendingCreate(
        externalId: 'newer',
        text: 'newer message',
        status: UnsentStatus.notSent,
        createdAt: now,
      );
      await openDraft(tester);
      expect(find.text('newer message'), findsOneWidget);
      expect(find.text('older message'), findsNothing);

      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();

      expect(find.text('newer message'), findsNothing);
      expect(find.text('older message'), findsOneWidget);
      expect(cloudPendingCreates(store, 'ws-1').single.externalId, 'older');
    });

    for (final action in ['Resend', 'Discard']) {
      testWidgets('$action on a stale row leaves the store alone', (
        tester,
      ) async {
        final seeded = seedPendingCreate(
          externalId: 'stale-chat',
          status: UnsentStatus.notSent,
        );
        await openDraft(tester);
        expect(find.text('Not sent'), findsOneWidget);

        // Another draft screen created the chat meanwhile: the record is now
        // that chat's own record.
        final chatRecord = seeded
            .copyWith(chatId: 'stale-chat', status: UnsentStatus.notSent)
            .toUnsentRecord();
        store.putUnsent(chatRecord);

        await tester.tap(find.text(action));
        await tester.pumpAndSettle();

        expect(find.text('stored first message'), findsNothing);
        expect(repository.createCalls, isEmpty);
        final stored = store.unsentById(chatRecord.id);
        expect(stored?.targetKey, chatRecord.targetKey);
        expect(stored?.status, UnsentStatus.notSent);
        expect(
          cloudRecordsForChat(store, 'stale-chat').single.payload.text,
          'stored first message',
        );
      });
    }
  });
}
