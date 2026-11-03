import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/data/models/remote_app_advisor.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_app_advisor_commands.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/views/widgets/home_navigation_drawer.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_app_advisor_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_app_advisor_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:provider/provider.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/reduced_motion.dart';

Map<String, dynamic> _chatJson(
  String chatId, {
  required String workEntryId,
  String? workEntryTitle,
  int order = 0,
  bool? active,
  bool? turnActive,
  List<Map<String, dynamic>>? pendingQuestions,
}) => {
  'chatId': chatId,
  'title': 'Tab $chatId',
  'workEntryId': workEntryId,
  'workEntryTitle': ?workEntryTitle,
  'workEntryOrder': 0,
  'order': order,
  'active': ?active,
  'turnActive': ?turnActive,
  'pendingQuestions': ?pendingQuestions,
};

/// Taps Send the way a finger does, with a frame between down and up: the
/// composer resolves its tap only after the draft field gives up focus.
Future<void> _tapSend(WidgetTester tester) async {
  await tester.pump();
  final gesture = await tester.startGesture(
    tester.getCenter(find.byKey(const ValueKey('composer-send'))),
  );
  await tester.pump();
  await gesture.up();
}

/// Whether the composer's Send action can be used.
bool _canSend(WidgetTester tester) =>
    tester
        .widget<CanopyComposerAction>(
          find.byKey(const ValueKey('composer-send')),
        )
        .onPressed !=
    null;

RemotePortalEventBatch _batch(List<RemotePortalEvent> events) =>
    RemotePortalEventBatch(events: events, nextCursor: 1);

void main() {
  useReducedMotion();

  void usePhoneViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  late FakeRemoteControlRepository repository;

  setUp(() {
    repository = FakeRemoteControlRepository()
      ..supportsAppAdvisor = true
      ..connectedStatus = RemotePortalConnectionStatus.active;
  });

  Future<RemoteControlViewModel> connected(WidgetTester tester) async {
    final viewModel = RemoteControlViewModel(repository: repository);
    await tester.runAsync(() => viewModel.connect('123456'));
    addTearDown(viewModel.dispose);
    return viewModel;
  }

  Widget subject(RemoteControlViewModel viewModel, Widget screen) =>
      ChangeNotifierProvider<RemoteControlViewModel>.value(
        value: viewModel,
        child: MaterialApp(theme: AppTheme.light, home: screen),
      );

  Future<void> deliver(WidgetTester tester, List<RemotePortalEvent> events) {
    repository.eventsController.add(_batch(events));
    return tester.pumpAndSettle();
  }

  RemoteAppAdvisorSnapshotEvent snapshot(List<Map<String, dynamic>> chats) =>
      RemoteAppAdvisorSnapshotEvent(
        chats: [for (final chat in chats) RemoteAppAdvisorChat.fromJson(chat)],
      );

  group('side menu', () {
    testWidgets('lists Advisor directly above Remote control', (tester) async {
      usePhoneViewport(tester);
      HomeTab? selected;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: HomeNavigationDrawer(
            tabs: organizationHomeTabs,
            selectedTab: HomeTab.chat,
            onSelected: (tab) => selected = tab,
          ),
        ),
      );
      final advisor = find.byKey(const ValueKey('home-nav-advisor'));
      final remote = find.byKey(const ValueKey('home-nav-remote'));
      expect(
        find.descendant(of: advisor, matching: find.text('Orchestrator')),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(advisor).dy,
        lessThan(tester.getTopLeft(remote).dy),
      );
      await tester.tap(advisor);
      expect(selected, HomeTab.advisor);
      expect(tester.takeException(), isNull);
    });
  });

  group('Advisor destination', () {
    testWidgets('without a pairing it offers the pairing form', (tester) async {
      usePhoneViewport(tester);
      final viewModel = RemoteControlViewModel(repository: repository);
      addTearDown(viewModel.dispose);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen()),
      );
      await tester.pumpAndSettle();
      expect(find.byType(ConnectDesktopView), findsOneWidget);
      expect(find.byKey(const ValueKey('app-advisor-new-chat')), findsNothing);
      expect(repository.appAdvisorCommands, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('starts loading chats in the background once connected', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      // Advisor is not the visible destination, yet the list is on its way.
      expect(repository.appAdvisorCommands.single, {
        'type': 'portal.state.request',
        'scope': 'app_advisor',
      });
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen(isActive: false)),
      );
      await deliver(tester, [snapshot([])]);

      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen()),
      );
      await tester.pumpAndSettle();
      // Opening Advisor reuses the list instead of asking again.
      expect(repository.appAdvisorCommands, hasLength(1));
      expect(find.text('No chats yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an older desktop gets the update prompt and no command', (
      tester,
    ) async {
      usePhoneViewport(tester);
      repository.supportsAppAdvisor = false;
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen()),
      );
      await tester.pumpAndSettle();
      expect(find.text(kRemoteAppAdvisorNeedsDesktopUpdate), findsOneWidget);
      expect(repository.appAdvisorCommands, isEmpty);
      expect(tester.takeException(), isNull);
    });
  });

  group('RemoteAppAdvisorScreen', () {
    testWidgets('partial results keep hydration Retry available', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen()),
      );
      await tester.pump();
      await deliver(tester, [
        RemoteCommandFailedEvent(
          commandId: 'advisor-${repository.appAdvisorCommands.length}',
          message: 'Unavailable',
        ),
      ]);
      await deliver(tester, [
        RemoteAppAdvisorDeltaEvent(
          chats: [
            RemoteAppAdvisorChat.fromJson(
              _chatJson(
                'c1',
                workEntryId: 'e1',
                workEntryTitle: 'Release checklist',
              ),
            ),
          ],
        ),
      ]);
      expect(find.text('Release checklist'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      final requests = repository.appAdvisorCommands.length;
      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(repository.appAdvisorCommands, hasLength(requests + 1));
      expect(
        repository.appAdvisorCommands.last['type'],
        'portal.state.request',
      );
      await deliver(tester, [
        snapshot([
          _chatJson(
            'c1',
            workEntryId: 'e1',
            workEntryTitle: 'Release checklist',
          ),
          _chatJson('c2', workEntryId: 'e2', workEntryTitle: 'Billing'),
        ]),
      ]);
      expect(find.text('Retry'), findsNothing);
      expect(find.text('Billing'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows the empty state', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen()),
      );
      await tester.pump();
      await deliver(tester, [snapshot([])]);
      expect(find.text('No chats yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('lists Work Entries with activity and tab counts', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen()),
      );
      await tester.pump();
      await deliver(tester, [
        snapshot([
          _chatJson(
            'c1',
            workEntryId: 'e1',
            workEntryTitle: 'Release checklist',
            active: true,
            turnActive: true,
          ),
          _chatJson('c2', workEntryId: 'e1', order: 1),
          _chatJson('c3', workEntryId: 'e2', workEntryTitle: 'Billing'),
        ]),
      ]);
      expect(find.text('Release checklist'), findsOneWidget);
      expect(find.text('2 chats'), findsOneWidget);
      expect(find.byTooltip('Working'), findsOneWidget);
      expect(find.text('Billing'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Release checklist'));
      await tester.pumpAndSettle();
      expect(find.byType(RemoteAppAdvisorChatScreen), findsOneWidget);
      expect(find.text('Tab c1'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('switches to the update prompt when the capability goes', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorScreen()),
      );
      await tester.pump();
      await deliver(tester, [snapshot([])]);
      repository.supportsAppAdvisor = false;
      viewModel.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.byType(AppAdvisorUpdatePrompt), findsOneWidget);
    });
  });

  group('RemoteAppAdvisorChatScreen', () {
    Future<RemoteControlViewModel> pumpChat(
      WidgetTester tester, {
      String? chatId = 'c1',
      List<Map<String, dynamic>>? pendingQuestions,
    }) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, RemoteAppAdvisorChatScreen(chatId: chatId)),
      );
      await deliver(tester, [
        snapshot([
          _chatJson(
            'c1',
            workEntryId: 'e1',
            workEntryTitle: 'Release checklist',
            active: true,
            pendingQuestions: pendingQuestions,
          ),
          _chatJson('c2', workEntryId: 'e1', order: 1),
        ]),
      ]);
      return viewModel;
    }

    testWidgets('an untitled chat reads Orchestrator', (tester) async {
      await pumpChat(tester, chatId: 'unlisted');
      await tester.pumpAndSettle();
      expect(find.text('Orchestrator'), findsWidgets);
      expect(find.text('Message Orchestrator…'), findsOneWidget);
    });

    for (final uncertain in [false, true]) {
      testWidgets(
        'existing chat controls work during another first send, uncertain=$uncertain',
        (tester) async {
          final viewModel = await pumpChat(tester);
          final advisor = viewModel.appAdvisor;
          await advisor.send(chatId: 'c1', text: 'Retry this');
          await deliver(tester, [
            RemoteCommandFailedEvent(
              commandId: 'advisor-${repository.appAdvisorCommands.length}',
              message: 'Busy',
            ),
          ]);
          advisor.send(text: 'New chat elsewhere').ignore();
          await tester.pump();
          final firstCommand =
              'advisor-${repository.appAdvisorCommands.length}';
          if (uncertain) {
            await tester.pump(const Duration(seconds: 61));
          }
          await tester.pumpAndSettle();
          await tester.enterText(find.byType(TextField), 'Existing chat');
          await tester.pump();
          expect(_canSend(tester), isTrue);
          final input = tester.widget<ChatInput>(find.byType(ChatInput));
          expect(input.controls?.onSelectModel, isNotNull);
          await _tapSend(tester);
          await tester.pumpAndSettle();
          expect(repository.appAdvisorCommands.last['chatId'], 'c1');
          expect(repository.appAdvisorCommands.last['text'], 'Existing chat');
          await tester.tap(find.text('Resend'));
          await tester.pumpAndSettle();
          expect(repository.appAdvisorCommands.last['chatId'], 'c1');
          expect(repository.appAdvisorCommands.last['text'], 'Retry this');
          await deliver(tester, [
            RemoteAppAdvisorDeltaEvent(
              chats: [
                RemoteAppAdvisorChat.fromJson(
                  _chatJson('c1', workEntryId: 'e1', turnActive: true),
                ),
              ],
            ),
          ]);
          await tester.enterText(find.byType(TextField), '');
          await tester.pump();
          final stop = tester.widget<CanopyComposerAction>(
            find.byKey(const ValueKey('composer-stop')),
          );
          expect(stop.onPressed, isNotNull);
          await tester.tap(find.byKey(const ValueKey('composer-stop')));
          await tester.pump();
          expect(
            repository.appAdvisorCommands.last['type'],
            'portal.app_advisor.cancel',
          );
          await deliver(tester, [
            RemoteCommandCompletedEvent(
              commandId: firstCommand,
              result: const {'chatId': 'new-1'},
            ),
          ]);
          expect(tester.takeException(), isNull);
        },
      );
    }

    testWidgets('pending and rejected follow-ups keep Stop visible', (
      tester,
    ) async {
      await pumpChat(tester);
      await deliver(tester, [
        RemoteAppAdvisorMessageEvent(
          chatId: 'c1',
          message: RemoteChatMessage.fromWireJson({
            'messageId': 'a1',
            'chatId': 'c1',
            'role': 'assistant',
            'status': 'streaming',
            'text': 'Checking',
            'createdAtMs': 1000,
          }),
        ),
      ]);
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Try another approach');
      await _tapSend(tester);
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      await deliver(tester, [
        RemoteCommandFailedEvent(
          commandId: 'advisor-${repository.appAdvisorCommands.length}',
          message: 'Busy',
        ),
      ]);
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('streams a reply and stops a running turn', (tester) async {
      await pumpChat(tester);
      await tester.enterText(find.byType(TextField), 'Check the build');
      await _tapSend(tester);
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands.last, {
        'type': 'portal.app_advisor.send',
        'chatId': 'c1',
        'userMessageId': isA<String>(),
        'text': 'Check the build',
      });
      expect(find.text('Check the build'), findsOneWidget);

      await deliver(tester, [
        RemoteAppAdvisorMessageEvent(
          chatId: 'c1',
          message: RemoteChatMessage.fromWireJson({
            'messageId': 'a1',
            'chatId': 'c1',
            'role': 'assistant',
            'status': 'streaming',
            'text': 'Looking at the build',
          }),
        ),
      ]);
      expect(find.textContaining('Looking at the build'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('composer-stop')));
      await tester.pump();
      expect(repository.appAdvisorCommands.last, {
        'type': 'portal.app_advisor.cancel',
        'chatId': 'c1',
      });
      expect(tester.takeException(), isNull);
    });

    testWidgets('the model chip shows and changes the chat model', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorChatScreen(chatId: 'c1')),
      );
      Map<String, dynamic> model(String id, String label) => {
        'id': id,
        'label': label,
        'provider': 'claude',
        'vendor': 'anthropic',
        'available': true,
      };
      await deliver(tester, [
        snapshot([
          {
            ..._chatJson('c1', workEntryId: 'e1', active: true),
            'model': 'claude-sonnet',
            'modelLabel': 'Claude Sonnet',
            'providerType': 'claude',
            'availableModels': [
              model('claude-sonnet', 'Claude Sonnet'),
              model('claude-opus', 'Claude Opus'),
            ],
          },
        ]),
      ]);
      final chip = find.byKey(const ValueKey('composer-model'));
      expect(
        find.descendant(of: chip, matching: find.text('Claude Sonnet')),
        findsOneWidget,
      );
      // Advisor plan, thinking, and fast mode stay desktop settings.
      expect(find.byKey(const ValueKey('composer-thinking')), findsNothing);
      expect(find.byKey(const ValueKey('composer-plan')), findsNothing);

      await tester.tap(chip);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('model-option-claude-opus')));
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands.last, {
        'type': 'portal.app_advisor.set_model',
        'chatId': 'c1',
        'model': 'claude-opus',
      });
      expect(
        find.descendant(of: chip, matching: find.text('Claude Opus')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    Map<String, dynamic> modelJson(String id, String label) => {
      'id': id,
      'label': label,
      'provider': 'claude',
      'vendor': 'anthropic',
      'available': true,
    };

    testWidgets('a new chat shows the Advisor default and sends the chosen '
        'model', (tester) async {
      repository.appAdvisorSettings = {
        'model': 'claude-sonnet',
        'availableModels': [
          modelJson('claude-sonnet', 'Claude Sonnet'),
          modelJson('claude-opus', 'Claude Opus'),
        ],
      };
      await pumpChat(tester, chatId: null);
      final chip = find.byKey(const ValueKey('composer-model'));
      expect(
        find.descendant(of: chip, matching: find.text('Claude Sonnet')),
        findsOneWidget,
      );

      await tester.tap(chip);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('model-option-claude-opus')));
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: chip, matching: find.text('Claude Opus')),
        findsOneWidget,
      );

      await tester.enterText(find.byType(TextField), 'Hello');
      await _tapSend(tester);
      await tester.pump();
      final send = repository.appAdvisorCommands.last;
      expect(send['type'], 'portal.app_advisor.send');
      expect(send.containsKey('chatId'), isFalse);
      expect(send['model'], 'claude-opus');
      repository.eventsController.add(
        _batch([
          RemoteCommandCompletedEvent(
            commandId: 'advisor-${repository.appAdvisorCommands.length}',
            result: const {'ok': true, 'chatId': 'new-1'},
          ),
        ]),
      );
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: chip, matching: find.text('Claude Opus')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a new tab shows the Advisor default, not a bare "Model"', (
      tester,
    ) async {
      repository.appAdvisorSettings = {
        'model': 'claude-sonnet',
        'availableModels': [modelJson('claude-sonnet', 'Claude Sonnet')],
      };
      await pumpChat(tester);
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('New chat'));
      await tester.pumpAndSettle();
      final chip = find.byKey(const ValueKey('composer-model'));
      expect(
        find.descendant(of: chip, matching: find.text('Claude Sonnet')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: chip, matching: find.text('Model')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('the composer shows no + because Advisor has nothing to add', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorChatScreen(chatId: 'c1')),
      );
      await deliver(tester, [
        RemoteAppAdvisorSnapshotEvent(
          chats: [
            RemoteAppAdvisorChat.fromJson(
              _chatJson('c1', workEntryId: 'e1', active: true),
            ),
          ],
        ),
      ]);

      expect(find.byKey(const ValueKey('chat-composer')), findsOneWidget);
      expect(find.byKey(const ValueKey('composer-actions')), findsNothing);
      expect(find.byTooltip('Add files and more'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('opening a chat loads just that chat', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connected(tester);
      await tester.pumpWidget(
        subject(viewModel, const RemoteAppAdvisorChatScreen(chatId: 'c1')),
      );
      repository.eventsController.add(
        _batch([
          RemoteAppAdvisorSnapshotEvent(
            chats: [
              RemoteAppAdvisorChat.fromJson(
                _chatJson('c1', workEntryId: 'e1', active: true),
              ),
            ],
            chatMessagesTruncated: true,
          ),
        ]),
      );
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands.last, {
        'type': 'portal.state.request',
        'scope': 'app_advisor',
        'target': {'chatLocalId': 'c1'},
      });
      expect(find.text('Loading conversation…'), findsOneWidget);

      await deliver(tester, [
        RemoteAppAdvisorSnapshotEvent(
          chats: [
            RemoteAppAdvisorChat.fromJson(
              _chatJson('c1', workEntryId: 'e1', active: true),
            ),
          ],
          targetChatId: 'c1',
          chatMessages: [
            RemoteChatMessage.fromWireJson({
              'messageId': 'm1',
              'chatId': 'c1',
              'role': 'assistant',
              'status': 'complete',
              'text': 'Earlier answer',
            }),
          ],
          chatMessagesTruncated: true,
        ),
      ]);
      expect(find.text('Loading conversation…'), findsNothing);
      expect(find.textContaining('Earlier answer'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'failed history loads wait for Retry, including partial feeds',
      (tester) async {
        usePhoneViewport(tester);
        final viewModel = await connected(tester);
        await tester.pumpWidget(
          subject(viewModel, const RemoteAppAdvisorChatScreen(chatId: 'c1')),
        );
        await deliver(tester, [
          RemoteAppAdvisorSnapshotEvent(
            chats: [
              RemoteAppAdvisorChat.fromJson(_chatJson('c1', workEntryId: 'e1')),
            ],
            chatMessagesTruncated: true,
            chatMessages: [
              RemoteChatMessage.fromWireJson({
                'chatId': 'c1',
                'messageId': 'seed',
                'role': 'assistant',
                'status': 'complete',
                'text': 'Partial history',
              }),
            ],
          ),
        ]);
        final requestCount = repository.appAdvisorCommands.length;
        await deliver(tester, [
          RemoteCommandFailedEvent(
            commandId: 'advisor-$requestCount',
            message: 'Unavailable',
          ),
        ]);
        await tester.pump(const Duration(seconds: 1));
        expect(repository.appAdvisorCommands, hasLength(requestCount));
        expect(find.text('Retry'), findsOneWidget);
        await tester.tap(find.text('Retry'));
        await tester.pumpAndSettle();
        expect(repository.appAdvisorCommands, hasLength(requestCount + 1));
        await deliver(tester, [
          RemoteAppAdvisorSnapshotEvent(chats: [], targetChatId: 'c1'),
        ]);
        expect(find.text('Retry'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'an uncertain existing-chat send offers Discard without Resend',
      (tester) async {
        await pumpChat(tester);
        repository.appAdvisorError =
            const RemoteChatSendOutcomeUnknownException('Response lost');
        await tester.enterText(find.byType(TextField), 'Only once');
        await _tapSend(tester);
        await tester.pumpAndSettle();
        expect(find.text('Only once'), findsOneWidget);
        expect(find.text('Delivery uncertain'), findsOneWidget);
        expect(find.text('Resend'), findsNothing);
        expect(find.text('Discard'), findsOneWidget);
        final commands = repository.appAdvisorCommands.length;
        await tester.tap(find.text('Discard'));
        await tester.pumpAndSettle();
        expect(find.text('Only once'), findsNothing);
        expect(find.text('Delivery uncertain'), findsNothing);
        expect(repository.appAdvisorCommands, hasLength(commands));
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('late send rejection keeps text and offers Resend', (
      tester,
    ) async {
      await pumpChat(tester);
      await tester.enterText(find.byType(TextField), 'Keep these words');
      await _tapSend(tester);
      await tester.pumpAndSettle();
      final commandId = 'advisor-${repository.appAdvisorCommands.length}';
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      await deliver(tester, [
        RemoteCommandFailedEvent(commandId: commandId, message: 'Busy'),
      ]);
      expect(find.text('Keep these words'), findsOneWidget);
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('Resend'), findsOneWidget);
      expect(find.text('Discard'), findsOneWidget);
      final commands = repository.appAdvisorCommands.length;
      await tester.tap(find.text('Resend'));
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands, hasLength(commands + 1));
      expect(repository.appAdvisorCommands.last['chatId'], 'c1');
      expect(repository.appAdvisorCommands.last['text'], 'Keep these words');
      expect(find.text('Keep these words'), findsOneWidget);
      expect(find.text('Not sent'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('lists tabs and opens a new one', (tester) async {
      await pumpChat(tester);
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pumpAndSettle();
      expect(find.text('Tab c2'), findsOneWidget);
      await tester.tap(find.text('New chat'));
      await tester.pumpAndSettle();
      final create = repository.appAdvisorCommands.last;
      expect(create['type'], 'portal.app_advisor.create_tab');
      expect(create['workEntryId'], 'e1');
      expect(tester.takeException(), isNull);
    });

    testWidgets('rejected new tab returns to a live tab', (tester) async {
      await pumpChat(tester);
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('New chat'));
      await tester.pumpAndSettle();
      final rejectedId = repository.appAdvisorCommands.last['chatId'];
      await deliver(tester, [
        RemoteCommandFailedEvent(
          commandId: 'advisor-${repository.appAdvisorCommands.length}',
          message: 'Could not create the tab.',
        ),
      ]);
      expect(find.text('Tab c1'), findsOneWidget);
      expect(find.byKey(const ValueKey('chat-tabs-fab')), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'After rejection');
      await _tapSend(tester);
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands.last['chatId'], 'c1');
      expect(repository.appAdvisorCommands.last['chatId'], isNot(rejectedId));
      expect(tester.takeException(), isNull);
    });

    testWidgets('removing the open tab selects another live tab', (
      tester,
    ) async {
      await pumpChat(tester);
      await deliver(tester, [
        RemoteAppAdvisorDeltaEvent(chats: const [], removedChatIds: ['c1']),
      ]);
      expect(find.text('Tab c2'), findsOneWidget);
      expect(find.byKey(const ValueKey('chat-tabs-fab')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('pending send preserves a later tab selection', (tester) async {
      await pumpChat(tester);
      final gate = Completer<void>();
      repository.appAdvisorSubmitGate = gate;
      await tester.enterText(find.byType(TextField), 'Slow send');
      await _tapSend(tester);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Tab c2').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Tab c2'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      gate.complete();
      repository.appAdvisorSubmitGate = null;
      await tester.pumpAndSettle();
      expect(find.text('Tab c2'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Next message');
      await _tapSend(tester);
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands.last['chatId'], 'c2');
      expect(tester.takeException(), isNull);
    });

    testWidgets('failed pending send stays with its original tab', (
      tester,
    ) async {
      await pumpChat(tester);
      final gate = Completer<void>();
      repository.appAdvisorSubmitGate = gate;
      await tester.enterText(find.byType(TextField), 'Slow send');
      await _tapSend(tester);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Tab c2').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Tab c2'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      gate.completeError(const RemoteControlException('Busy'));
      repository.appAdvisorSubmitGate = null;
      await tester.pumpAndSettle();
      expect(find.text('Tab c2'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      expect(find.text('Slow send'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tab c1'));
      await tester.pumpAndSettle();
      expect(find.text('Slow send'), findsOneWidget);
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('Resend'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'Next message');
      await _tapSend(tester);
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands.last['chatId'], 'c1');
      expect(tester.takeException(), isNull);
    });

    testWidgets('answers a question and shows a desktop rejection', (
      tester,
    ) async {
      await pumpChat(
        tester,
        pendingQuestions: [
          {
            'requestId': 'q1',
            'questions': [
              {
                'question': 'Ship it?',
                'options': ['Yes', 'No'],
              },
            ],
          },
        ],
      );
      expect(find.text('Ship it?'), findsOneWidget);
      await tester.tap(find.text('Yes'));
      await tester.pumpAndSettle();
      final submit = find.widgetWithText(FilledButton, 'Submit');
      if (submit.evaluate().isNotEmpty) {
        await tester.tap(submit);
        await tester.pumpAndSettle();
      }
      expect(
        repository.appAdvisorCommands.last['type'],
        'portal.app_advisor.answer_question',
      );
      expect(find.text('Ship it?'), findsNothing);

      final commandId = 'advisor-${repository.appAdvisorCommands.length}';
      repository.eventsController.add(
        _batch([
          RemoteCommandFailedEvent(
            commandId: commandId,
            message: 'Orchestrator question is no longer awaiting an answer.',
          ),
        ]),
      );
      await tester.pumpAndSettle();
      expect(find.text('Ship it?'), findsOneWidget);
      expect(
        find.text('Orchestrator question is no longer awaiting an answer.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a new chat holds the composer until the desktop names it', (
      tester,
    ) async {
      await pumpChat(tester, chatId: null);
      expect(find.text('Send a message to start a chat.'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Hello');
      await _tapSend(tester);
      await tester.pump();
      final send = repository.appAdvisorCommands.last;
      expect(send.containsKey('chatId'), isFalse);
      await tester.enterText(find.byType(TextField), 'Next');
      await tester.pump();
      expect(_canSend(tester), isFalse);

      repository.eventsController.add(
        _batch([
          RemoteCommandCompletedEvent(
            commandId: 'advisor-${repository.appAdvisorCommands.length}',
            result: const {'ok': true, 'chatId': 'new-1'},
          ),
        ]),
      );
      await tester.pumpAndSettle();
      expect(_canSend(tester), isTrue);
      expect(find.text('Hello'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'a lost first-send response waits for its echo without Resend',
      (tester) async {
        await pumpChat(tester, chatId: null);
        repository.appAdvisorError =
            const RemoteChatSendOutcomeUnknownException('Response lost');
        await tester.enterText(find.byType(TextField), 'Only once');
        await _tapSend(tester);
        await tester.pumpAndSettle();
        expect(find.text('Delivery uncertain'), findsOneWidget);
        expect(find.text('Resend'), findsNothing);
        expect(_canSend(tester), isFalse);
        final messageId = repository.appAdvisorCommands.last['userMessageId'];
        final count = repository.appAdvisorCommands.length;
        await deliver(tester, [
          RemoteAppAdvisorMessageEvent(
            chatId: 'new-1',
            message: RemoteChatMessage.fromWireJson({
              'chatId': 'new-1',
              'messageId': messageId,
              'role': 'user',
              'status': 'complete',
              'text': 'Only once',
            }),
          ),
        ]);
        expect(find.text('Delivery uncertain'), findsNothing);
        await tester.enterText(find.byType(TextField), 'Next');
        await _tapSend(tester);
        await tester.pumpAndSettle();
        expect(repository.appAdvisorCommands.length, count + 1);
        expect(repository.appAdvisorCommands.last['chatId'], 'new-1');
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('late first-send success recovers after a delivery timeout', (
      tester,
    ) async {
      await pumpChat(tester, chatId: null);
      await tester.enterText(find.byType(TextField), 'Only once');
      await _tapSend(tester);
      await tester.pump();
      final commandId = 'advisor-${repository.appAdvisorCommands.length}';
      expect(
        find.byKey(const ValueKey('remote-chat-working-indicator')),
        findsOneWidget,
      );
      await tester.pump(const Duration(seconds: 61));
      await tester.pumpAndSettle();
      expect(find.text('Delivery uncertain'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('remote-chat-working-indicator')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('app-advisor-error')), findsNothing);
      expect(find.text('Resend'), findsNothing);
      await deliver(tester, [
        RemoteCommandCompletedEvent(
          commandId: commandId,
          result: const {'chatId': 'new-1'},
        ),
      ]);
      expect(find.text('Only once'), findsOneWidget);
      expect(find.text('Delivery uncertain'), findsNothing);
      await tester.enterText(find.byType(TextField), 'Follow up');
      await _tapSend(tester);
      await tester.pumpAndSettle();
      expect(repository.appAdvisorCommands.last['chatId'], 'new-1');
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'a rejected first send preserves a newer draft and can resend',
      (tester) async {
        await pumpChat(tester, chatId: null);
        await tester.enterText(find.byType(TextField), 'Original submission');
        await _tapSend(tester);
        await tester.pump();
        await tester.enterText(find.byType(TextField), 'Newer draft');
        await deliver(tester, [
          RemoteCommandFailedEvent(
            commandId: 'advisor-${repository.appAdvisorCommands.length}',
            message: 'Busy',
          ),
        ]);
        expect(find.text('Original submission'), findsOneWidget);
        expect(find.text('Newer draft'), findsOneWidget);
        expect(find.text('Not sent'), findsOneWidget);
        await tester.tap(find.text('Resend'));
        await tester.pump();
        expect(
          repository.appAdvisorCommands.last['text'],
          'Original submission',
        );
        expect(
          repository.appAdvisorCommands.last.containsKey('chatId'),
          isFalse,
        );
        await deliver(tester, [
          RemoteCommandCompletedEvent(
            commandId: 'advisor-${repository.appAdvisorCommands.length}',
            result: const {'ok': true, 'chatId': 'new-1'},
          ),
        ]);
        expect(find.text('Original submission'), findsOneWidget);
        expect(find.text('Not sent'), findsNothing);
        expect(find.text('Newer draft'), findsOneWidget);
        await _tapSend(tester);
        await tester.pumpAndSettle();
        expect(repository.appAdvisorCommands.last['chatId'], 'new-1');
        expect(repository.appAdvisorCommands.last['text'], 'Newer draft');
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('an offline desktop keeps cached content; an ended session '
        'stops commands', (tester) async {
      await pumpChat(tester);
      await deliver(tester, [
        RemoteAppAdvisorMessageEvent(
          chatId: 'c1',
          message: RemoteChatMessage.fromWireJson({
            'messageId': 'a1',
            'chatId': 'c1',
            'role': 'assistant',
            'status': 'complete',
            'text': 'Cached reply',
          }),
        ),
      ]);
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [],
          nextCursor: 2,
          connectionStatus: RemotePortalConnectionStatus.inactive,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Cached reply'), findsOneWidget);

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [RemoteSessionEndedEvent()],
          nextCursor: 3,
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Still there?');
      await tester.pump();
      expect(_canSend(tester), isFalse);
      expect(tester.takeException(), isNull);
    });
  });
}
