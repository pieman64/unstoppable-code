import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chats_screen.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_workspace_section.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_cloud_chat_repository.dart';
import '../../../../support/conversation_v2_fixtures.dart';

void main() {
  group('CloudChatsScreen', () {
    late FakeCloudChatRepository repository;
    late CloudChatsViewModel list;
    late CloudChatViewModel chat;
    late List<StreamController<CloudSseFrame>> streams;

    Widget subject() => MultiProvider(
      providers: [
        ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
        ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
      ],
      child: MaterialApp(
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        home: const CloudChatsScreen(),
      ),
    );

    Future<void> pumpLoaded(WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(subject());
      await tester.pump();
      await tester.pump();
    }

    setUp(() {
      repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
      list = CloudChatsViewModel(repository: repository);
      streams = [];
      chat = CloudChatViewModel(
        repository: repository,
        // Held open: an already-closed stream would read as a dropped
        // connection and schedule a reconnect timer past the test's end.
        openStream: (_, {after}) {
          final controller = StreamController<CloudSseFrame>();
          streams.add(controller);
          return controller.stream;
        },
        observeLifecycle: false,
      );
    });

    tearDown(() async {
      chat.dispose();
      list.dispose();
      for (final stream in streams) {
        await stream.close();
      }
    });

    testWidgets('lists each workspace with its chats and created time', (
      tester,
    ) async {
      await pumpLoaded(tester);
      expect(find.text('Cloud chats'), findsOneWidget);
      expect(find.text('Mobile App'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        findsOneWidget,
      );
      expect(find.text('Plan the mobile launch'), findsOneWidget);
      expect(find.textContaining('ago'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('cloud-chat-working-chat-1')),
        findsNothing,
      );
      expect(repository.listCalls, hasLength(1));
    });

    testWidgets('groups project chats under a Projects section', (
      tester,
    ) async {
      await pumpLoaded(tester);
      final label = find.byKey(const ValueKey('cloud-projects-section'));
      expect(label, findsOneWidget);
      expect(
        find.descendant(of: label, matching: find.text('Projects')),
        findsOneWidget,
      );
      final labelLeft = tester.getTopLeft(label).dx;
      final projectName = tester.getTopLeft(find.text('Mobile App')).dx;
      final chatTitle = tester.getTopLeft(find.text('Plan the mobile launch'));
      // The section label, then the project, then its chats indented so they
      // line up with the project name rather than the screen edge.
      expect(
        tester.getTopLeft(label).dy,
        lessThan(tester.getTopLeft(find.text('Mobile App')).dy),
      );
      expect(chatTitle.dx, greaterThan(labelLeft));
      expect(chatTitle.dx, projectName);
    });

    testWidgets('project headers start at the left edge with a New chat plus', (
      tester,
    ) async {
      await pumpLoaded(tester);
      final header = find.byKey(const ValueKey('cloud-workspace-header-ws-1'));
      // The project's folder icon lines up with the section label; only its
      // chats are indented.
      expect(
        tester
            .getTopLeft(
              find.descendant(
                of: header,
                matching: find.byType(CloudProjectIcon),
              ),
            )
            .dx,
        tester.getTopLeft(find.text('Projects')).dx,
      );
      final folder = find.descendant(
        of: find.descendant(
          of: header,
          matching: find.byType(CloudProjectIcon),
        ),
        matching: find.byType(CanopyIcon),
      );
      expect(tester.getSize(folder), const Size.square(14));
      expect(
        tester.widget<CanopyIcon>(folder).glyph.assetPath,
        endsWith('/folder-filled.svg'),
      );
      final plus = find.byKey(const ValueKey('cloud-new-chat-ws-1'));
      expect(find.descendant(of: header, matching: plus), findsOneWidget);
      expect(
        tester.getCenter(plus).dx,
        greaterThan(tester.getCenter(find.text('Mobile App')).dx),
      );
      expect(find.byKey(const ValueKey('cloud-new-chat')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('untitled chats fall back to "New chat"', (tester) async {
      repository.workspaces = [
        sampleWorkspace(chats: [sampleChat(title: null)]),
      ];
      await pumpLoaded(tester);
      expect(find.text('New chat'), findsOneWidget);
    });

    testWidgets('shows a working indicator for the chat with a live turn', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn',
        activeUserMessageId: 'user',
        activeStreamAfter: '5',
      );
      await pumpLoaded(tester);
      chat.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump();
      await tester.pump();
      expect(chat.turnInProgress, isTrue);
      expect(
        find.byKey(const ValueKey('cloud-chat-working-chat-1')),
        findsOneWidget,
      );
    });

    testWidgets('tapping a row opens that chat', (tester) async {
      await pumpLoaded(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-chat-row-chat-1')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byKey(const ValueKey('cloud-chat-screen')), findsOneWidget);
      expect(chat.state?.chatId, 'chat-1');
    });

    testWidgets('long press offers Delete; cancelling keeps the chat', (
      tester,
    ) async {
      await pumpLoaded(tester);
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-chat-chat-1')));
      await tester.pumpAndSettle();
      expect(find.text('Delete chat?'), findsOneWidget);
      expect(
        find.text(
          'Delete “Plan the mobile launch”? Deleted chats are kept for 30 '
          'days, then removed. You can restore it on the web from Archived '
          'and deleted.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repository.deleteCalls, isEmpty);
      expect(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        findsOneWidget,
      );
    });

    testWidgets('confirming Delete removes the chat from the list', (
      tester,
    ) async {
      await pumpLoaded(tester);
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-chat-chat-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
      await tester.pumpAndSettle();
      expect(repository.deleteCalls, ['chat-1']);
      expect(find.byKey(const ValueKey('cloud-chat-row-chat-1')), findsNothing);
    });

    testWidgets('deleting the bound chat closes its session', (tester) async {
      await pumpLoaded(tester);
      chat.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump();
      await tester.pump();
      expect(chat.state?.chatId, 'chat-1');
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-chat-chat-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
      await tester.pumpAndSettle();
      expect(chat.state, isNull);
    });

    testWidgets('delete completion keeps a different chat opened meanwhile', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(
          chats: [
            sampleChat(),
            sampleChat(id: 'chat-2', title: 'Second chat'),
          ],
        ),
      ];
      repository.deleteCompleter = Completer<void>();
      await pumpLoaded(tester);
      chat.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump();
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-chat-chat-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
      await tester.pump();
      expect(repository.deleteCalls, ['chat-1']);

      chat.open('chat-2', cursorEpoch: 'session-2');
      await tester.pump();
      repository.deleteCompleter!.complete();
      await tester.pumpAndSettle();

      expect(chat.state?.chatId, 'chat-2');
      expect(
        find.byKey(const ValueKey('cloud-chat-row-chat-2')),
        findsOneWidget,
      );
    });

    testWidgets('an idle child tab cannot be deleted from its menu', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(
          chats: [
            sampleChat(),
            sampleChat(
              id: 'child-1',
              title: 'Child tab',
              taskChatExternalId: 'chat-1',
            ),
          ],
        ),
      ];
      await pumpLoaded(tester);
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-child-1')),
      );
      await tester.pumpAndSettle();

      final item = tester.widget<PopupMenuItem<String>>(
        find.byKey(const ValueKey('cloud-delete-chat-child-1')),
      );
      expect(item.enabled, isFalse);
      expect(repository.deleteCalls, isEmpty);
      final hint = tester.widget<Text>(
        find.text('Delete the main chat to remove its child tabs.'),
      );
      expect(hint.maxLines, 1);
      expect(hint.overflow, TextOverflow.ellipsis);
    });

    testWidgets('deleting a main chat closes its selected child session', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(
          chats: [
            sampleChat(),
            sampleChat(
              id: 'child-1',
              title: 'Child tab',
              taskChatExternalId: 'chat-1',
            ),
          ],
        ),
      ];
      await pumpLoaded(tester);
      chat.open('child-1', cursorEpoch: 'session-1');
      await tester.pump();
      await tester.pump();
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-chat-chat-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
      await tester.pumpAndSettle();

      expect(chat.state, isNull);
      expect(
        find.byKey(const ValueKey('cloud-chat-row-child-1')),
        findsNothing,
      );
    });

    testWidgets('a rejected delete keeps the row and shows the reason', (
      tester,
    ) async {
      repository.deleteError = const CloudApiException(
        statusCode: 409,
        message: 'Change the task lifecycle from its main chat.',
      );
      await pumpLoaded(tester);
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-chat-chat-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
      await tester.pumpAndSettle();
      expect(
        find.text('Change the task lifecycle from its main chat.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        findsOneWidget,
      );
    });

    testWidgets('Delete is disabled while the chat has a live turn', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn',
        activeUserMessageId: 'user',
        activeStreamAfter: '5',
      );
      await pumpLoaded(tester);
      chat.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump();
      await tester.pump();
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      final item = tester.widget<PopupMenuItem<String>>(
        find.byKey(const ValueKey('cloud-delete-chat-chat-1')),
      );
      expect(item.enabled, isFalse);
      expect(
        find.text('Wait for the chat to finish before deleting it.'),
        findsOneWidget,
      );
    });

    testWidgets('Delete is disabled while the main chat has a queued send', (
      tester,
    ) async {
      await pumpLoaded(tester);
      chat.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump();
      chat.setForeground(false);
      chat.send(
        clientRequestId: 'queued-send',
        payload: const CloudSendPayload(text: 'Keep this message'),
      );
      expect(chat.turnInProgress, isFalse);
      expect(chat.state!.outbox, hasLength(1));

      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      final item = tester.widget<PopupMenuItem<String>>(
        find.byKey(const ValueKey('cloud-delete-chat-chat-1')),
      );
      expect(item.enabled, isFalse);
      expect(repository.deleteCalls, isEmpty);
      final hint = tester.widget<Text>(
        find.text('Wait for the queued message to send before deleting it.'),
      );
      expect(hint.maxLines, 1);
      expect(hint.overflow, TextOverflow.ellipsis);
    });

    testWidgets('Delete is disabled for an accepted queued turn', (
      tester,
    ) async {
      repository.conversation = v2Snapshot(turns: [v2Turn()]);
      await pumpLoaded(tester);
      chat.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump();
      await tester.pump();
      expect(chat.state!.outbox, isEmpty);
      expect(chat.queuedTurns, hasLength(1));
      expect(chat.turnInProgress, isFalse);

      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      final item = tester.widget<PopupMenuItem<String>>(
        find.byKey(const ValueKey('cloud-delete-chat-chat-1')),
      );
      expect(item.enabled, isFalse);
      expect(repository.deleteCalls, isEmpty);
    });

    testWidgets(
      'main chat Delete is disabled while a child has a queued send',
      (tester) async {
        repository.workspaces = [
          sampleWorkspace(
            chats: [
              sampleChat(),
              sampleChat(id: 'child-1', taskChatExternalId: 'chat-1'),
            ],
          ),
        ];
        await pumpLoaded(tester);
        chat.open('child-1', cursorEpoch: 'session-child');
        await tester.pump();
        chat.setForeground(false);
        chat.send(
          clientRequestId: 'queued-child-send',
          payload: const CloudSendPayload(text: 'Keep child message'),
        );
        await tester.longPress(
          find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        );
        await tester.pumpAndSettle();

        final item = tester.widget<PopupMenuItem<String>>(
          find.byKey(const ValueKey('cloud-delete-chat-chat-1')),
        );
        expect(item.enabled, isFalse);
        expect(repository.deleteCalls, isEmpty);
      },
    );

    testWidgets(
      'queued child send started during confirmation blocks deletion',
      (tester) async {
        repository.workspaces = [
          sampleWorkspace(
            chats: [
              sampleChat(),
              sampleChat(id: 'child-1', taskChatExternalId: 'chat-1'),
            ],
          ),
        ];
        await pumpLoaded(tester);
        await tester.longPress(
          find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('cloud-delete-chat-chat-1')),
        );
        await tester.pumpAndSettle();

        chat.open('child-1', cursorEpoch: 'session-child');
        await tester.pump();
        chat.setForeground(false);
        chat.send(
          clientRequestId: 'queued-child-send',
          payload: const CloudSendPayload(text: 'Keep child message'),
        );
        expect(chat.turnInProgress, isFalse);
        expect(chat.state!.outbox, hasLength(1));
        await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
        await tester.pumpAndSettle();

        expect(repository.deleteCalls, isEmpty);
        expect(chat.state!.outbox.single.clientRequestId, 'queued-child-send');
        expect(
          find.byKey(const ValueKey('cloud-chat-row-chat-1')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'accepted queued child turn started during confirmation blocks deletion',
      (tester) async {
        repository.workspaces = [
          sampleWorkspace(
            chats: [
              sampleChat(),
              sampleChat(
                id: 'child-1',
                taskChatExternalId: 'chat-1',
                session: 'session-child',
              ),
            ],
          ),
        ];
        repository.conversation = v2Snapshot(
          session: 'session-child',
          turns: [v2Turn()],
        );
        await pumpLoaded(tester);
        await tester.longPress(
          find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('cloud-delete-chat-chat-1')),
        );
        await tester.pumpAndSettle();

        chat.open('child-1', cursorEpoch: 'session-child');
        await tester.pump();
        await tester.pump();
        expect(chat.state!.outbox, isEmpty);
        expect(chat.queuedTurns, hasLength(1));
        await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
        await tester.pumpAndSettle();

        expect(repository.deleteCalls, isEmpty);
        expect(chat.state?.chatId, 'child-1');
        expect(chat.queuedTurns, hasLength(1));
      },
    );

    testWidgets('main chat Delete is disabled while a child tab is working', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(
          chats: [
            sampleChat(),
            sampleChat(id: 'child-1', taskChatExternalId: 'chat-1'),
          ],
        ),
      ];
      repository.bootstraps['child-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn',
        activeUserMessageId: 'user',
        activeStreamAfter: '5',
      );
      await pumpLoaded(tester);
      chat.open('child-1', cursorEpoch: 'session-child');
      await tester.pump();
      await tester.pump();
      expect(chat.turnInProgress, isTrue);
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      final item = tester.widget<PopupMenuItem<String>>(
        find.byKey(const ValueKey('cloud-delete-chat-chat-1')),
      );
      expect(item.enabled, isFalse);
      expect(repository.deleteCalls, isEmpty);
    });

    testWidgets('a child reply started in the confirmation blocks deletion', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(
          chats: [
            sampleChat(),
            sampleChat(id: 'child-1', taskChatExternalId: 'chat-1'),
          ],
        ),
      ];
      repository.bootstraps['child-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn',
        activeUserMessageId: 'user',
        activeStreamAfter: '5',
      );
      await pumpLoaded(tester);
      await tester.longPress(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-delete-chat-chat-1')));
      await tester.pumpAndSettle();

      chat.open('child-1', cursorEpoch: 'session-child');
      await tester.pump();
      await tester.pump();
      expect(chat.turnInProgress, isTrue);
      await tester.tap(find.byKey(const ValueKey('cloud-delete-confirm')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(repository.deleteCalls, isEmpty);
      expect(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        findsOneWidget,
      );
    });

    testWidgets('queued follow-ups block opening a different chat', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(
          chats: [
            sampleChat(),
            sampleChat(id: 'chat-2', title: 'Second chat'),
          ],
        ),
      ];
      repository.bootstraps['chat-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn-1',
        activeUserMessageId: 'user-1',
        activeStreamAfter: '7',
      );
      await pumpLoaded(tester);
      chat.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump();
      await tester.pump();
      chat.send(
        clientRequestId: 'queued-follow-up',
        payload: const CloudSendPayload(text: 'Do this next'),
      );
      expect(chat.state!.outbox, hasLength(1));

      await tester.tap(find.byKey(const ValueKey('cloud-chat-row-chat-2')));
      await tester.pump();

      expect(find.byKey(const ValueKey('cloud-chat-screen')), findsNothing);
      expect(chat.state?.chatId, 'chat-1');
      expect(chat.state!.outbox.single.clientRequestId, 'queued-follow-up');
      expect(
        find.text(
          'Wait for the queued message to send before opening another chat.',
        ),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('cloud-new-chat')));
      await tester.pump();
      expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsNothing);
      expect(chat.state!.outbox.single.clientRequestId, 'queued-follow-up');
    });

    testWidgets('New chat in the app bar opens a draft on the first project', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'ws-2', name: 'Second project', chats: []),
      ];
      await pumpLoaded(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-new-chat')));
      await tester.pumpAndSettle();
      final selector = find.byKey(const ValueKey('cloud-new-chat-project'));
      expect(
        find.byKey(const ValueKey('cloud-new-chat-screen')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: selector, matching: find.text('Mobile App')),
        findsOneWidget,
      );
      // Opening the draft creates nothing and leaves the session alone.
      expect(repository.createCalls, isEmpty);
      expect(chat.state, isNull);
    });

    testWidgets('a project plus opens a draft on that project', (tester) async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'ws-2', name: 'Second project', chats: []),
      ];
      await pumpLoaded(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-new-chat-ws-2')));
      await tester.pumpAndSettle();
      final selector = find.byKey(const ValueKey('cloud-new-chat-project'));
      expect(
        find.descendant(of: selector, matching: find.text('Second project')),
        findsOneWidget,
      );
      expect(repository.createCalls, isEmpty);
    });

    testWidgets('empty account shows the empty state', (tester) async {
      repository.workspaces = const [];
      await pumpLoaded(tester);
      expect(find.byKey(const ValueKey('cloud-chats-empty')), findsOneWidget);
      expect(find.byType(StateMessageView), findsOneWidget);
      expect(find.byType(CanopyIcon), findsOneWidget);
      expect(
        find.text('Create a project on the web to start chatting here.'),
        findsOneWidget,
      );
      expect(find.textContaining('workspace'), findsNothing);
      expect(find.byKey(const ValueKey('cloud-new-chat')), findsNothing);
    });

    testWidgets('a first project being set up shows progress, then lists it', (
      tester,
    ) async {
      final setup = Completer<void>();
      repository
        ..workspaces = const []
        ..provisionCompleter = setup;
      await pumpLoaded(tester);
      unawaited(list.provisionFirstProjectIfNeeded(pairedDesktop: false));
      await tester.pump();

      expect(find.byKey(const ValueKey('cloud-chats-empty')), findsNothing);
      expect(
        find.text('Create a project on the web to start chatting here.'),
        findsNothing,
      );

      setup.complete();
      await tester.pumpAndSettle();
      expect(find.text('My project'), findsOneWidget);
      expect(find.byKey(const ValueKey('cloud-new-chat')), findsOneWidget);
    });

    testWidgets('cloud unavailable shows the unavailable state', (
      tester,
    ) async {
      repository.cloudUnavailable = true;
      await pumpLoaded(tester);
      expect(find.byKey(const ValueKey('cloud-unavailable')), findsOneWidget);
    });

    testWidgets('a load failure offers Retry', (tester) async {
      repository.listError = const CloudApiException(
        statusCode: 500,
        message: 'Cloud request failed with status 500',
      );
      await pumpLoaded(tester);
      expect(find.byKey(const ValueKey('cloud-chats-error')), findsOneWidget);
      expect(find.text('Cloud request failed with status 500'), findsOneWidget);
      repository.listError = null;
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await tester.pump();
      expect(
        find.byKey(const ValueKey('cloud-chat-row-chat-1')),
        findsOneWidget,
      );
    });

    testWidgets('pull to refresh re-fetches', (tester) async {
      await pumpLoaded(tester);
      await tester.fling(
        find.byKey(const ValueKey('cloud-chats-list')),
        const Offset(0, 400),
        1000,
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(repository.listCalls, hasLength(2));
    });
  });
}
