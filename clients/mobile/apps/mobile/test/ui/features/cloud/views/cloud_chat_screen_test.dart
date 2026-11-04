import 'dart:async';
import 'dart:convert';
import 'dart:ui' show Tristate;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import '../../../../support/conversation_v2_fixtures.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/widgets/chat_glyph.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_unsent_records.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chats_screen.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/ui/core/chat/view_models/model_routing_availability_controller.dart';

import '../../../../support/composer_driver.dart';
import '../../../../support/fake_attachment_picker.dart';
import '../../../../support/fake_cloud_chat_repository.dart';
import '../../../../support/fake_speech_recognizer.dart';
import '../../../../support/painted_scroll_frames.dart';

void main() {
  group('CloudChatScreen', () {
    late FakeCloudChatRepository repository;
    late CloudChatsViewModel list;
    late CloudChatViewModel chat;
    late ChatDraftStateStore store;
    late List<StreamController<CloudSseFrame>> streams;
    ModelRoutingAvailabilityController? routing;

    CloudCoreMessage message(
      String id, {
      required String role,
      required String text,
      String? sourceKey,
      String? requestId,
      List<Map<String, dynamic>> contentBlocks = const [],
      int createdAtMs = 1789890000000,
      ChatWatcherFiredInfo? watcherFired,
    }) => CloudCoreMessage(
      id: id,
      role: role,
      text: text,
      sourceKey: sourceKey,
      clientRequestId: requestId,
      contentBlocks: contentBlocks,
      cost: const CloudCoreCost(kind: CloudCoreCostKind.zero),
      costBilledViaLlmProxy: false,
      createdAtMs: createdAtMs,
      artifacts: const [],
      watcherFired: watcherFired,
    );

    CloudChatBootstrap conversation({
      String? activeTurnId,
      CloudTerminalSession? terminal,
    }) => CloudChatBootstrap(
      messages: [
        message('u1', role: 'USER', text: 'hello agent', requestId: 'r1'),
        message(
          'a1',
          role: 'ASSISTANT',
          text: 'hello human',
          sourceKey: 'turn-1',
          createdAtMs: 1789890001000,
        ),
      ],
      toolActivity: const [],
      activeTurnId: activeTurnId,
      activeUserMessageId: activeTurnId == null ? null : 'u1',
      activeStreamAfter: activeTurnId == null ? null : '7',
      terminalSession: terminal,
    );

    CloudChatBootstrap askUser({bool secret = false}) => CloudChatBootstrap(
      messages: [
        message('u1', role: 'USER', text: 'set it up', requestId: 'r1'),
        message(
          'a1',
          role: 'ASSISTANT',
          text: '',
          sourceKey: 'turn-1',
          contentBlocks: const [
            {
              'type': 'tool_call',
              'toolCallId': 'q1',
              'toolName': 'AskUserQuestion',
            },
          ],
          createdAtMs: 1789890001000,
        ),
      ],
      toolActivity: [
        CloudChatToolActivity(
          kind: CloudToolActivityKind.call,
          rawKind: 'call',
          sourceKey: 'turn-1',
          toolCallId: 'q1',
          toolName: 'AskUserQuestion',
          input: jsonEncode({
            'questions': [
              {
                'question': secret ? 'Paste the API key' : 'Which platform?',
                'header': 'Platform',
                'options': secret ? [] : ['iOS', 'Android'],
                'multiSelect': false,
                'secret': secret,
              },
            ],
          }),
          raw: const {},
        ),
      ],
      // The agent's turn has already finished: on cloud the ask-user tool
      // returns at once and the reply arrives as the next user turn.
    );

    Widget subject({FakeSpeechRecognizer? speech, AttachmentPicker? picker}) =>
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
            ChangeNotifierProvider<ChatDraftStoreHolder>.value(
              value: ChatDraftStoreHolder(store),
            ),
            if (routing case final routing?)
              ChangeNotifierProvider<ModelRoutingAvailabilityController>.value(
                value: routing,
              ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  key: const ValueKey('open'),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => CloudChatScreen(
                        chatId: 'chat-1',
                        speechRecognizer: speech,
                        attachmentPicker: picker,
                      ),
                    ),
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        );

    Future<void> openChat(
      WidgetTester tester, {
      FakeSpeechRecognizer? speech,
      AttachmentPicker? picker,
    }) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(subject(speech: speech, picker: picker));
      await list.load();
      await list.ensureModels();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
    }

    /// A chat that [model] answered; [bound] is Core's harness binding.
    CloudChatBootstrap answeredBootstrap({
      required String? bound,
      String model = 'gpt-5.6-luna',
    }) => CloudChatBootstrap(
      messages: [
        message('u1', role: 'USER', text: 'hello agent', requestId: 'r1'),
        CloudCoreMessage(
          id: 'a1',
          role: 'ASSISTANT',
          text: 'hello human',
          sourceKey: 'turn-1',
          model: {'id': model},
          cost: const CloudCoreCost(kind: CloudCoreCostKind.zero),
          costBilledViaLlmProxy: false,
          createdAtMs: 1789890001000,
          artifacts: const [],
        ),
      ],
      toolActivity: const [],
      executionHarness: bound,
    );

    Future<void> send(WidgetTester tester, String text) async {
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        text,
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
    }

    Future<void> openDraft(
      WidgetTester tester, {
      String? workspaceId,
      bool loadFirst = true,
      Size size = const Size(390, 844),
      AttachmentPicker? picker,
    }) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
            ChangeNotifierProvider<ChatDraftStoreHolder>.value(
              value: ChatDraftStoreHolder(store),
            ),
            if (routing case final routing?)
              ChangeNotifierProvider<ModelRoutingAvailabilityController>.value(
                value: routing,
              ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  key: const ValueKey('open'),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => CloudChatScreen.create(
                        initialWorkspaceId: workspaceId,
                        attachmentPicker: picker,
                      ),
                    ),
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        ),
      );
      if (loadFirst) {
        await list.load();
        await list.ensureModels();
      }
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pumpAndSettle();
    }

    Finder draftProject(String name) => find.descendant(
      of: find.byKey(const ValueKey('cloud-new-chat-project')),
      matching: find.text(name),
    );

    setUp(() {
      routing = null;
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

    for (final draft in [false, true]) {
      testWidgets(
        'CAN-5243 ${draft ? 'draft' : 'existing chat'} offers attachment sources',
        (tester) async {
          if (draft) {
            await openDraft(tester);
          } else {
            await openChat(tester);
            await tester.pumpAndSettle();
          }
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Review these files',
          );
          await tester.tap(find.byTooltip('Add files and more'));
          await tester.pumpAndSettle();
          expect(find.text('Take photo'), findsOneWidget);
          expect(find.text('Photo library'), findsOneWidget);
          expect(find.text('Files'), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );
    }

    testWidgets('a failed first workspace load offers a retry in the draft', (
      tester,
    ) async {
      repository.listError = const CloudApiException(
        statusCode: 500,
        message: 'Workspace request failed',
      );
      await openDraft(tester, loadFirst: false);

      expect(list.error, 'Workspace request failed');
      expect(
        find.byKey(const ValueKey('cloud-new-chat-workspaces-error')),
        findsOneWidget,
      );
      expect(find.text('Workspace request failed'), findsOneWidget);
      final retry = find.descendant(
        of: find.byKey(const ValueKey('cloud-new-chat-workspaces-error')),
        matching: find.text('Retry'),
      );
      expect(retry, findsOneWidget);

      repository.listError = null;
      await tester.tap(retry);
      await tester.pumpAndSettle();

      expect(repository.listCalls, hasLength(2));
      expect(
        find.byKey(const ValueKey('cloud-new-chat-workspaces-error')),
        findsNothing,
      );
      expect(draftProject('Mobile App'), findsOneWidget);
    });

    testWidgets(
      'v2 discovery opens history and sends through conversation turns',
      (tester) async {
        final paths = <String>[];
        chat.dispose();
        chat = CloudChatViewModel(
          repository: HttpCloudChatRepository(
            service: CloudApiService(
              apiClient: ApiClient(
                baseUrl: 'https://example.test',
                tokenProvider: () => 'test',
                httpClient: MockClient((request) async {
                  paths.add(request.url.path);
                  Object body;
                  if (request.url.path.endsWith('/discovery')) {
                    body = {'sessionId': 'session-1', 'protocolVersion': 2};
                  } else if (request.url.path.endsWith('/conversation')) {
                    body = v2Snapshot(
                      messages: [v2Message(text: 'Web-created history')],
                    );
                  } else if (request.url.path.endsWith('/conversation/turns')) {
                    final input =
                        jsonDecode(request.body) as Map<String, dynamic>;
                    body = v2Accepted(
                      input['clientRequestId'] as String,
                      input['content'] as String,
                    );
                  } else if (request.method == 'GET') {
                    body = {'messages': [], 'toolActivity': []};
                  } else {
                    return http.Response(
                      '{"error":"Conversation protocol changed while admitting the legacy message"}',
                      409,
                    );
                  }
                  return http.Response(jsonEncode(body), 200);
                }),
              ),
            ),
          ),
          openStream: (_, {after}) {
            final stream = StreamController<CloudSseFrame>();
            streams.add(stream);
            return stream.stream;
          },
          observeLifecycle: false,
        )..attachDraftStore(store);
        await openChat(tester);
        await send(tester, 'Continue from mobile');
        await tester.pump();
        expect(paths, contains('/api/cloud/chats/chat-1/conversation/turns'));
        expect(paths.any((p) => p.endsWith('/messages')), isFalse);
        expect(find.textContaining('Web-created history'), findsOneWidget);
        expect(find.textContaining('Continue from mobile'), findsOneWidget);
        expect(find.byKey(const ValueKey('cloud-send-error')), findsNothing);
      },
    );

    testWidgets('v2 history failure keeps the composer usable', (tester) async {
      repository.conversation = v2Snapshot(
        messages: [v2Message(text: 'Current message')],
        history: 'older-cursor',
      );
      await openChat(tester);
      await chat.loadOlder();
      await tester.pump();
      expect(chat.bootstrapError, isNull);
      expect(
        find.text("Couldn't load older messages. Try again."),
        findsOneWidget,
      );
      await send(tester, 'Still sending');
      expect(repository.conversationSends.single.content, 'Still sending');
    });

    testWidgets('v2 streams a reply and Stop targets its execution source', (
      tester,
    ) async {
      repository.conversation = v2Snapshot(
        turns: [v2Turn(status: 'RUNNING')],
        messages: [v2Message(id: 'user-r1')],
      );
      await openChat(tester);
      final link = {
        'turnId': 'turn-1',
        'userMessageId': 'user-r1',
        'inferenceRunId': 'run-turn-1',
        'sourceKey': 'execution-source',
        'executionGeneration': 1,
      };
      streams.single.add(
        CloudSseFrame(
          event: 'message.start',
          data: jsonEncode({...link, 'role': 'ASSISTANT'}),
        ),
      );
      streams.single.add(
        CloudSseFrame(
          event: 'message.delta',
          data: jsonEncode({
            ...link,
            'streamIndex': 0,
            'textDelta': 'Streamed on mobile',
          }),
        ),
      );
      await tester.pump();
      expect(find.textContaining('Streamed on mobile'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('composer-stop')));
      await tester.pump();
      expect(repository.interruptCalls.single.turnId, 'execution-source');
    });

    testWidgets('v2 streams reasoning as a one-line thinking preview', (
      tester,
    ) async {
      const reasoning =
          'I will start by reading the auth flow, then trace the badge '
          'visibility through the router before touching any tests.';
      repository.conversation = v2Snapshot(
        turns: [v2Turn(status: 'RUNNING')],
        messages: [v2Message(id: 'user-r1')],
      );
      await openChat(tester);
      final link = {
        'turnId': 'turn-1',
        'userMessageId': 'user-r1',
        'inferenceRunId': 'run-turn-1',
        'sourceKey': 'execution-source',
        'executionGeneration': 1,
      };
      void stream(String event, Map<String, Object?> data) => streams.single
          .add(CloudSseFrame(event: event, data: jsonEncode(data)));
      stream('message.start', {...link, 'role': 'ASSISTANT'});
      stream('message.reasoning', {
        ...link,
        'streamIndex': 0,
        'reasoningDelta': reasoning,
      });
      await tester.pump();

      expect(chat.turnInProgress, isTrue);
      expect(find.text('Thinking'), findsOneWidget);
      expect(find.text('${reasoning.substring(0, 80)}…'), findsOneWidget);
      expect(find.text(reasoning), findsNothing);
      expect(tester.takeException(), isNull);
    });

    ScrollPosition transcriptPosition(WidgetTester tester) => tester
        .widget<ListView>(find.byKey(const ValueKey('remote-chat-transcript')))
        .controller!
        .position;

    for (final platform in const [TargetPlatform.android, TargetPlatform.iOS]) {
      testWidgets('CAN-3945 a refreshed uneven transcript stays on the newest '
          'message without a scroll animation (${platform.name})', (
        tester,
      ) async {
        debugDefaultTargetPlatformOverride = platform;
        try {
          // Tall early turns and terse late ones: the lazy list's extent
          // estimate is thousands of pixels off until the real end lays out.
          final full = [
            for (var i = 0; i < 120; i++)
              message(
                'm$i',
                role: i.isEven ? 'USER' : 'ASSISTANT',
                text: i < 60
                    ? 'Message $i. ${'A long multi-paragraph body. ' * 50}'
                    : 'Short message $i.',
                requestId: i.isEven ? 'r$i' : null,
                sourceKey: i.isEven ? null : 'turn-${i - 1}',
                createdAtMs: 1789890000000 + i * 1000,
              ),
          ];
          repository.bootstraps['chat-1'] = CloudChatBootstrap(
            messages: full.sublist(80),
            toolActivity: const [],
          );
          await openChat(tester);
          await tester.pumpAndSettle();
          expect(find.text('Short message 119.'), findsOneWidget);
          final position = transcriptPosition(tester);
          expect(
            position.maxScrollExtent - position.pixels,
            lessThanOrEqualTo(1),
          );

          repository.bootstraps['chat-1'] = CloudChatBootstrap(
            messages: full,
            toolActivity: const [],
          );
          final recorded = await recordPaintedScrollFrames(
            tester,
            position,
            chat.refresh,
          );

          expectEveryFrameOnNewest(recorded);
          expect(find.text('Short message 119.'), findsOneWidget);
          expect(tester.takeException(), isNull);
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      });

      testWidgets('CAN-3945 the first frame after a streamed answer grows '
          'already shows the newest content (${platform.name})', (
        tester,
      ) async {
        debugDefaultTargetPlatformOverride = platform;
        try {
          repository.conversation = v2Snapshot(
            turns: [v2Turn(id: 'turn-16', request: 'r16', status: 'RUNNING')],
            messages: [
              for (var i = 0; i < 16; i++) ...[
                v2Message(
                  id: 'user-r$i',
                  request: 'r$i',
                  text: 'Question $i with enough text to give the row height.',
                  turnId: 'turn-$i',
                  seq: 2 * i + 1,
                ),
                v2Message(
                  id: 'assistant-$i',
                  request: 'r$i',
                  role: 'ASSISTANT',
                  text: 'Answer $i with enough text to make the feed scroll.',
                  turnId: 'turn-$i',
                  seq: 2 * i + 2,
                ),
              ],
              v2Message(
                id: 'user-r16',
                request: 'r16',
                text: 'Question 16, still running.',
                turnId: 'turn-16',
                seq: 33,
              ),
            ],
          );
          await openChat(tester);
          final link = {
            'turnId': 'turn-16',
            'userMessageId': 'user-r16',
            'inferenceRunId': 'run-turn-16',
            'sourceKey': 'execution-source',
            'executionGeneration': 1,
          };
          void stream(String event, Map<String, Object?> data) => streams.single
              .add(CloudSseFrame(event: event, data: jsonEncode(data)));
          stream('message.start', {...link, 'role': 'ASSISTANT'});
          stream('message.delta', {
            ...link,
            'streamIndex': 0,
            'textDelta': 'Streaming answer.',
          });
          for (var frame = 0; frame < 10; frame++) {
            await tester.pump(const Duration(milliseconds: 16));
          }
          expect(find.textContaining('Streaming answer.'), findsOneWidget);
          final position = transcriptPosition(tester);
          expect(
            position.maxScrollExtent - position.pixels,
            lessThanOrEqualTo(1),
          );
          final extentBefore = position.maxScrollExtent;

          final recorded = await recordPaintedScrollFrames(
            tester,
            position,
            () async => stream('message.delta', {
              ...link,
              'streamIndex': 1,
              'textDelta': ' ${'A long multi-paragraph answer body. ' * 120}',
            }),
          );

          expect(position.maxScrollExtent - extentBefore, greaterThan(2000));
          expectEveryFrameOnNewest(recorded);
          expect(tester.takeException(), isNull);
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      });
    }

    testWidgets('v2 ask-user survives completion and answers through turns', (
      tester,
    ) async {
      repository.conversation = v2Snapshot(turns: [v2Turn(status: 'RUNNING')]);
      await openChat(tester);
      final link = {
        'turnId': 'turn-1',
        'userMessageId': 'user-r1',
        'inferenceRunId': 'run-turn-1',
        'sourceKey': 'execution-source',
        'executionGeneration': 1,
      };
      streams.single.add(
        CloudSseFrame(
          event: 'message.start',
          data: jsonEncode({...link, 'role': 'ASSISTANT'}),
        ),
      );
      streams.single.add(
        CloudSseFrame(
          event: 'tool.call',
          data: jsonEncode({
            'sourceKey': 'execution-source',
            'toolCallId': 'q1',
            'toolName': 'AskUserQuestion',
            'args': jsonEncode({
              'questions': [
                {
                  'question': 'Which platform?',
                  'header': 'Platform',
                  'options': ['iOS', 'Android'],
                  'multiSelect': false,
                },
              ],
            }),
          }),
        ),
      );
      await tester.pump();
      expect(find.byType(PendingQuestionCard), findsOneWidget);
      streams.single.add(
        CloudSseFrame(
          event: 'conversation.changed',
          data: jsonEncode({
            'protocolVersion': 2,
            'sessionId': 'session-1',
            'previousStateVersion': '0',
            'stateVersion': '1',
            'changes': [
              {
                'type': 'message.upsert',
                'message': {
                  ...v2Message(id: 'assistant', role: 'ASSISTANT', text: ''),
                  'sourceKey': 'execution-source',
                  'contentBlocks': [
                    {
                      'type': 'tool_call',
                      'toolCallId': 'q1',
                      'toolName': 'AskUserQuestion',
                    },
                  ],
                },
              },
              {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
            ],
          }),
        ),
      );
      await tester.pump();
      expect(find.byType(PendingQuestionCard), findsOneWidget);
      await tester.tap(find.text('Android'));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('question-submit-q1')));
      await tester.pump();
      expect(repository.conversationSends.single.content, contains('Android'));
      expect(repository.postCalls, isEmpty);
      expect(find.byType(PendingQuestionCard), findsNothing);
    });

    testWidgets('v2 terminal chat continues then rediscovers before sending', (
      tester,
    ) async {
      repository.conversation = v2Snapshot(
        status: 'COMPLETED',
        messages: [v2Message(text: 'Earlier prompt')],
      );
      await openChat(tester);
      await send(tester, 'Continue the task');
      await tester.pump();
      await tester.pump();
      expect(repository.continueCalls, ['chat-1']);
      expect(chat.state!.cursorEpoch, 'session-1-continued');
      expect(repository.conversationSends.single.content, 'Continue the task');
      expect(repository.postCalls, isEmpty);
      expect(find.byKey(const ValueKey('composer-draft')), findsOneWidget);
    });

    testWidgets('a draft opens ready to type and creates nothing', (
      tester,
    ) async {
      await openDraft(tester);
      expect(
        find.byKey(const ValueKey('cloud-new-chat-screen')),
        findsOneWidget,
      );
      expect(draftProject('Mobile App'), findsOneWidget);
      expect(find.text('What would you like to do?'), findsOneWidget);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.autofocus, isTrue);
      expect(find.text('GPT-5.6 Luna'), findsOneWidget);
      expect(find.byKey(const ValueKey('cloud-chat-options')), findsNothing);
      expect(repository.createCalls, isEmpty);
      expect(chat.state, isNull);
    });

    testWidgets('the draft hides the project selector while projects load', (
      tester,
    ) async {
      final projects = Completer<List<CloudWorkspaceSummary>>();
      repository.listCompleter = projects;

      await openDraft(tester, loadFirst: false);

      expect(repository.listCalls, isNotEmpty);
      expect(list.isLoading, isTrue);
      expect(
        find.byKey(const ValueKey('cloud-new-chat-project')),
        findsNothing,
      );
      expect(find.text('No project'), findsNothing);

      repository.listCompleter = null;
      projects.complete([sampleWorkspace()]);
      await tester.pumpAndSettle();

      expect(draftProject('Mobile App'), findsOneWidget);
    });

    testWidgets('a new account waits for its first project, then sends', (
      tester,
    ) async {
      final setup = Completer<void>();
      repository
        ..workspaces = []
        ..provisionCompleter = setup;
      await openDraft(tester);
      unawaited(list.provisionFirstProjectIfNeeded(pairedDesktop: false));
      await tester.pump();

      // Setting up is not "No project": the selector stays hidden meanwhile.
      expect(list.isProvisioningFirstProject, isTrue);
      expect(
        find.byKey(const ValueKey('cloud-new-chat-project')),
        findsNothing,
      );
      expect(find.text('No project'), findsNothing);

      setup.complete();
      await tester.pumpAndSettle();
      expect(draftProject('My project'), findsOneWidget);

      await send(tester, 'hello from a new account');
      await tester.pump();
      await tester.pump();
      expect(repository.createCalls.single.workspaceId, 'ws-first');
      expect(repository.postCalls.single.text, 'hello from a new account');
    });

    testWidgets('the draft header reads project, slash, then the title', (
      tester,
    ) async {
      // A short name leaves free space in the row, as "Website" does.
      repository.workspaces = [sampleWorkspace(name: 'Web')];
      await openDraft(tester);
      final bar = find.byType(CanopyAppBar);
      final selector = find.byKey(const ValueKey('cloud-new-chat-project'));
      // One picker, in the app bar: none floats in the body below it.
      expect(selector, findsOneWidget);
      expect(find.descendant(of: bar, matching: selector), findsOneWidget);
      final slash = find.descendant(of: bar, matching: find.text('/'));
      final title = find.descendant(of: bar, matching: find.text('New chat'));
      expect(slash, findsOneWidget);
      expect(title, findsOneWidget);

      final project = tester.getRect(selector);
      expect(project.right, lessThanOrEqualTo(tester.getRect(slash).left));
      expect(
        tester.getRect(slash).right,
        lessThanOrEqualTo(tester.getRect(title).left),
      );
      // The whole `[Project ▾] / Title` group is centered on the screen.
      expect(
        (project.left + tester.getRect(title).right) / 2,
        moreOrLessEquals(390 / 2, epsilon: 0.5),
      );
      // The project name uses the title's font, only in a muted color.
      TextStyle? styleOf(String text) =>
          tester.renderObject<RenderParagraph>(find.text(text)).text.style;
      final projectStyle = styleOf('Web')!;
      final titleStyle = styleOf('New chat')!;
      expect(projectStyle.fontSize, titleStyle.fontSize);
      expect(projectStyle.fontFamily, titleStyle.fontFamily);
      expect(projectStyle.fontWeight, titleStyle.fontWeight);
      expect(projectStyle.fontVariations, titleStyle.fontVariations);
      expect(projectStyle.height, titleStyle.height);
      expect(projectStyle.letterSpacing, titleStyle.letterSpacing);
      expect(project.width, greaterThanOrEqualTo(44));
      expect(project.height, greaterThanOrEqualTo(44));
      expect(
        find.textContaining(RegExp('workspace', caseSensitive: false)),
        findsNothing,
      );
    });

    testWidgets('the draft project button announces when it is disabled', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      Tristate enabled(String name) =>
          tester.getSemantics(draftProject(name)).flagsCollection.isEnabled;
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      expect(enabled('Mobile App'), Tristate.isTrue);

      // The first send fixes the project while it creates the chat.
      await send(tester, 'hello');
      await tester.pump();
      expect(enabled('Mobile App'), Tristate.isFalse);

      creating.complete();
      await tester.pump();
      await tester.pump();
      semantics.dispose();
    });

    testWidgets('a draft without projects announces a disabled picker', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      repository.workspaces = [];
      await openDraft(tester);
      expect(
        tester
            .getSemantics(draftProject('No project'))
            .flagsCollection
            .isEnabled,
        Tristate.isFalse,
      );
      semantics.dispose();
    });

    for (final width in [320.0, 390.0]) {
      testWidgets('a long project name truncates in a ${width.toInt()}px '
          'header and keeps the chevron and title', (tester) async {
        const name = 'Customer onboarding and billing platform migration';
        repository.workspaces = [sampleWorkspace(name: name)];
        await openDraft(tester, size: Size(width, 844));
        expect(tester.takeException(), isNull);

        final selector = find.byKey(const ValueKey('cloud-new-chat-project'));
        final chevron = find.descendant(
          of: selector,
          matching: find.byWidgetPredicate(
            (w) => w is CanopyIcon && w.glyph == CanopyGlyph.chevronDownSmall,
          ),
        );
        final slash = find.text('/');
        final title = find.text('New chat');
        expect(chevron, findsOneWidget);
        expect(
          tester.getRect(chevron).right,
          lessThanOrEqualTo(tester.getRect(slash).left),
        );
        // The title keeps its share of the row, and the project name gives
        // way instead.
        final titleRect = tester.getRect(title);
        expect(titleRect.right, lessThanOrEqualTo(width));
        expect(titleRect.width, greaterThanOrEqualTo(48));
        expect(
          tester
              .renderObject<RenderParagraph>(find.text(name))
              .didExceedMaxLines,
          isTrue,
        );
      });
    }

    testWidgets('the first send creates the chat and binds it in place', (
      tester,
    ) async {
      await openDraft(tester);
      await chooseComposerEffort(tester, 'medium');
      await send(tester, 'start something new');
      await tester.pump();
      await tester.pump();

      final created = repository.createCalls.single;
      expect(created.workspaceId, 'ws-1');
      expect(created.model, 'gpt-5.6-luna');
      expect(chat.state?.chatId, created.externalId);
      expect(repository.postCalls.single.chatId, created.externalId);
      expect(repository.postCalls.single.text, 'start something new');
      // A draft starts with thinking off; the chosen level is sent.
      expect(repository.postCalls.single.thinking, 'medium');
      // Same route, now the chat: transcript, project subtitle, and overflow.
      expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsNothing);
      expect(find.byKey(const ValueKey('cloud-chat-screen')), findsOneWidget);
      expect(find.textContaining('start something new'), findsOneWidget);
      expect(find.text('Mobile App'), findsOneWidget);
      expect(find.byKey(const ValueKey('cloud-chat-options')), findsOneWidget);
      expect(list.workspaces.single.chats, hasLength(2));
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('open')), findsOneWidget);
    });

    testWidgets('the chat header marks it as a cloud chat (CAN-2932)', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await openDraft(tester);
      await send(tester, 'start something new');
      await tester.pump();
      await tester.pump();

      final icon = find.byKey(const ValueKey('chat-location-icon'));
      expect(
        tester
            .widget<CanopyIcon>(
              find.descendant(of: icon, matching: find.byType(CanopyIcon)),
            )
            .glyph,
        CanopyGlyph.cloud,
      );
      expect(tester.getSemantics(icon).label, 'Cloud chat');
      expect(
        find.descendant(
          of: find.byType(ChatLocationSubtitle),
          matching: find.text('Mobile App'),
        ),
        findsOneWidget,
      );
      semantics.dispose();
    });

    testWidgets('the first message shows at once while the chat is created', (
      tester,
    ) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'show me right away');

      // Creating: the prompt sits in the transcript, not the composer, and
      // the send action is not a spinner.
      expect(repository.createCalls, hasLength(1));
      expect(find.text('What would you like to do?'), findsNothing);
      expect(find.textContaining('show me right away'), findsOneWidget);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.controller!.text, isEmpty);
      final action = tester.widget<CanopyComposerAction>(
        find.byKey(const ValueKey('composer-send')),
      );
      expect(action.busy, isFalse);
      expect(action.onPressed, isNull);

      creating.complete();
      await tester.pump();
      await tester.pump();
      expect(repository.postCalls.single.text, 'show me right away');
      expect(find.byKey(const ValueKey('cloud-chat-screen')), findsOneWidget);
      expect(find.textContaining('show me right away'), findsOneWidget);
    });

    // CAN-4436 published review: a Cloud screen changes only its own chat.
    // A draft that becomes its chat under a drag is the same target, so the
    // release sets the created chat's level for its next send.
    testWidgets('a drag held while the draft creates its chat sets the '
        "created chat's next level", (tester) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'first');
      expect(repository.createCalls, hasLength(1));

      await openEffortSheet(tester);
      final gesture = await holdEffortDrag(tester, 'high');
      creating.complete();
      await tester.pump();
      await tester.pump();
      final created = repository.createCalls.single;
      expect(chat.state?.chatId, created.externalId);
      expect(repository.postCalls.single.thinking, isNot('high'));
      expect(effortHeadingText(tester), 'Effort  High');

      // The first turn runs, so the frames do not settle.
      await gesture.up();
      await tester.pump();
      expect(effortHeadingText(tester), 'Effort  High');
      Navigator.of(tester.element(find.byType(BottomSheet))).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('composer-thinking')),
          matching: find.text('High'),
        ),
        findsOneWidget,
        reason: 'the created chat shows the level its next send takes',
      );
      expect(repository.postCalls, hasLength(1));
      expect(tester.takeException(), isNull);
    });

    // CAN-4436 published review: creating the chat rebuilds the screen from
    // the draft layout under an open Effort sheet. The sheet must keep showing
    // and changing the screen's choices, which the next send takes.
    testWidgets('an Effort sheet open while the draft creates its chat '
        'follows the created chat', (tester) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'first');
      await openEffortSheet(tester);
      final fast = find.byKey(const ValueKey('effort-fast-mode'));
      String speedText() => tester
          .widget<Text>(
            find.descendant(
              of: find.byKey(const ValueKey('effort-speed')),
              matching: find.byType(Text),
            ),
          )
          .textSpan!
          .toPlainText();
      // The first turn runs, so the frames do not settle.
      Future<void> frames() async {
        await tester.pump();
        await tester.pump();
      }

      expect(speedText(), 'Speed  Regular');
      creating.complete();
      await frames();
      final chatId = repository.createCalls.single.externalId;
      expect(chat.state?.chatId, chatId);
      expect(chat.turnInProgress, isTrue);
      expect(find.byType(CanopyEffortPanel), findsOneWidget);

      await tester.tap(fast);
      await frames();
      expect(speedText(), 'Speed  Fast');
      await tester.tap(fast);
      await frames();
      expect(speedText(), 'Speed  Regular');
      await tester.tap(fast);
      await frames();
      expect(speedText(), 'Speed  Fast');
      final slider = tester.widget<Slider>(
        find.byKey(const ValueKey('effort-slider')),
      );
      slider.onChangeStart?.call(slider.value);
      slider.onChanged!(3);
      slider.onChangeEnd!(3);
      await frames();
      expect(effortHeadingText(tester), 'Effort  Extra High');

      // The first turn ends; Fast still turns off from the same sheet.
      void frame(String event, Map<String, Object?> data, String id) => streams
          .last
          .add(CloudSseFrame(event: event, data: jsonEncode(data), id: id));
      frame('message.start', {
        'sourceKey': 'turn-1',
        'role': 'assistant',
      }, '100');
      frame('message.delta', {
        'sourceKey': 'turn-1',
        'textDelta': 'done',
      }, '101');
      frame('message.finish', {'sourceKey': 'turn-1'}, '102');
      await frames();
      expect(chat.turnInProgress, isFalse);
      await tester.tap(fast);
      await frames();
      expect(speedText(), 'Speed  Regular');
      await closeEffortSheet(tester);

      await send(tester, 'second');
      await frames();
      expect(repository.postCalls, hasLength(2));
      final next = repository.postCalls.last;
      expect(next.chatId, chatId);
      expect(next.thinking, 'xhigh');
      expect(next.fast, isFalse);
      expect(tester.takeException(), isNull);
    });

    testWidgets('leaving during chat creation still sends the first message', (
      tester,
    ) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'send after leaving');
      expect(repository.createCalls, hasLength(1));

      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsNothing);

      creating.complete();
      await tester.pump();
      await tester.pump();
      expect(repository.postCalls.single.text, 'send after leaving');
      expect(chat.state?.chatId, repository.createCalls.single.externalId);
    });

    testWidgets('leaving during a failed create keeps the prompt as not sent', (
      tester,
    ) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
            ChangeNotifierProvider<ChatDraftStoreHolder>.value(
              value: ChatDraftStoreHolder(store),
            ),
          ],
          child: const MaterialApp(home: CloudChatsScreen()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-new-chat')));
      await tester.pumpAndSettle();
      await send(tester, 'keep my first prompt');
      await tester.pageBack();
      await tester.pumpAndSettle();
      repository.createError = const CloudApiException(
        statusCode: 402,
        message: 'Not enough credits',
      );
      creating.complete();
      await tester.pump();
      await tester.pump();
      final failed = cloudPendingCreates(store, 'ws-1').single;
      expect(failed.payload.text, 'keep my first prompt');
      expect(failed.status, UnsentStatus.notSent);

      // Opening the project's draft again shows it with Resend and Discard.
      await tester.tap(find.byKey(const ValueKey('cloud-new-chat')));
      await tester.pumpAndSettle();
      expect(find.text('keep my first prompt'), findsOneWidget);
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('Not enough credits'), findsOneWidget);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.controller!.text, isEmpty);
    });

    for (final failsAfterReset in [false, true]) {
      testWidgets(
        'reset drops a closed draft while creation ${failsAfterReset ? 'fails' : 'completes'}',
        (tester) async {
          final creating = Completer<void>();
          repository.createCompleters['ws-1'] = creating;
          await openDraft(tester);
          await send(tester, 'old account prompt');
          expect(repository.createCalls, hasLength(1));

          await tester.pageBack();
          await tester.pumpAndSettle();
          list.reset();
          if (failsAfterReset) {
            repository.createError = const CloudApiException(
              statusCode: 401,
              message: 'Signed out',
            );
          }
          creating.complete();
          await tester.pump();
          await tester.pump();

          // The old scope's prompt stays its unconfirmed first message; it
          // is neither sent nor moved into a chat draft.
          expect(
            cloudPendingCreates(store, 'ws-1').single.payload.text,
            'old account prompt',
          );
          expect(
            store.draftFor(
              CloudChatDraftTarget(repository.createCalls.single.externalId),
            ),
            isEmpty,
          );
          expect(repository.postCalls, isEmpty);
        },
      );
    }

    testWidgets('scope reset closes a draft containing an unsent prompt', (
      tester,
    ) async {
      await openDraft(tester);
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'old account unsent prompt',
      );

      list.reset();
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsNothing);
      expect(find.text('old account unsent prompt'), findsNothing);
      expect(find.byKey(const ValueKey('open')), findsOneWidget);
    });

    testWidgets('scope reset closes the project picker and its draft', (
      tester,
    ) async {
      await openDraft(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-new-chat-project')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('cloud-project-picker')),
        findsOneWidget,
      );

      list.reset();
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('cloud-project-picker')), findsNothing);
      expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsNothing);
      expect(find.byKey(const ValueKey('open')), findsOneWidget);
    });

    testWidgets('scope reset closes a draft while creation is pending', (
      tester,
    ) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'old account pending prompt');
      expect(repository.createCalls, hasLength(1));

      list.reset();
      await tester.pumpAndSettle();
      creating.complete();
      await tester.pump();

      expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsNothing);
      expect(find.byKey(const ValueKey('open')), findsOneWidget);
      expect(repository.postCalls, isEmpty);
      expect(
        cloudPendingCreates(store, 'ws-1').single.payload.text,
        'old account pending prompt',
      );
      expect(
        store.draftFor(
          CloudChatDraftTarget(repository.createCalls.single.externalId),
        ),
        isEmpty,
      );
    });

    testWidgets('a stale draft Resend sends nothing after the account resets', (
      tester,
    ) async {
      repository.createError = const CloudApiException(
        statusCode: 402,
        message: 'Not enough credits',
      );
      await openDraft(tester);
      await send(tester, 'old account prompt');
      await tester.pump();
      final resend = tester.widget<ChatFeed>(find.byType(ChatFeed)).onResend!;
      final before = cloudPendingCreates(store, 'ws-1').single;
      repository.createError = null;

      list.reset();
      resend('creating');
      await tester.pumpAndSettle();

      expect(repository.createCalls, hasLength(1));
      expect(repository.postCalls, isEmpty);
      final after = cloudPendingCreates(store, 'ws-1').single;
      expect(after.clientRequestId, before.clientRequestId);
      expect(after.status, UnsentStatus.notSent);
    });

    testWidgets('a pending draft never replaces another queued chat', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn-1',
        activeUserMessageId: 'user-1',
        activeStreamAfter: '7',
      );
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      await openDraft(tester);
      await send(tester, 'first draft prompt');
      await tester.pageBack();
      await tester.pumpAndSettle();
      chat.open('chat-1', cursorEpoch: 'session-chat-1');
      await tester.pump();
      await tester.pump();
      chat.send(
        clientRequestId: 'other-queued',
        payload: const CloudSendPayload(text: 'other chat prompt'),
      );
      creating.complete();
      await tester.pump();
      await tester.pump();
      expect(chat.state?.chatId, 'chat-1');
      expect(chat.state?.outbox.single.clientRequestId, 'other-queued');
      expect(
        store.draftFor(
          CloudChatDraftTarget(repository.createCalls.single.externalId),
        ),
        'first draft prompt',
      );
      expect(cloudPendingCreates(store, 'ws-1'), isEmpty);
      expect(
        repository.postCalls.where((call) => call.text == 'first draft prompt'),
        isEmpty,
      );
    });

    testWidgets('an offscreen pending draft never replaces an idle chat', (
      tester,
    ) async {
      final creating = Completer<void>();
      repository.createCompleters['ws-1'] = creating;
      var selectedTab = 0;
      await list.load();
      await list.ensureModels();
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
            ChangeNotifierProvider<ChatDraftStoreHolder>.value(
              value: ChatDraftStoreHolder(store),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            home: StatefulBuilder(
              builder: (context, setState) => Scaffold(
                body: Column(
                  children: [
                    TextButton(
                      onPressed: () => setState(
                        () => selectedTab = selectedTab == 0 ? 1 : 0,
                      ),
                      child: Text(
                        selectedTab == 0
                            ? 'Open another chat'
                            : 'Return to draft',
                      ),
                    ),
                    Expanded(
                      child: IndexedStack(
                        index: selectedTab,
                        children: [
                          CloudChatScreen.create(isActive: selectedTab == 0),
                          const Center(child: Text('Other chat')),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await send(tester, 'first draft prompt');
      expect(repository.createCalls, hasLength(1));

      await tester.tap(find.text('Open another chat'));
      await tester.pump();
      chat.open('chat-1', cursorEpoch: 'session-chat-1');
      await tester.pump();
      expect(chat.state?.chatId, 'chat-1');
      expect(chat.state?.outbox, isEmpty);

      creating.complete();
      await tester.pump();
      await tester.pump();

      expect(chat.state?.chatId, 'chat-1');
      expect(
        store.draftFor(
          CloudChatDraftTarget(repository.createCalls.single.externalId),
        ),
        'first draft prompt',
      );
      expect(cloudPendingCreates(store, 'ws-1'), isEmpty);
      expect(
        repository.postCalls.where((call) => call.text == 'first draft prompt'),
        isEmpty,
      );
      await tester.tap(find.text('Return to draft'));
      await tester.pumpAndSettle();
      final composer = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(composer.controller!.text, isEmpty);
      await send(tester, 'different prompt');
      await tester.pump();
      expect(repository.createCalls, hasLength(2));
      expect(
        repository.postCalls.where((call) => call.text == 'different prompt'),
        hasLength(1),
      );
      expect(
        repository.postCalls.where((call) => call.text == 'first draft prompt'),
        isEmpty,
      );
      expect(
        store.draftFor(
          CloudChatDraftTarget(repository.createCalls.first.externalId),
        ),
        'first draft prompt',
      );
    });

    testWidgets('the draft project can be changed before sending', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'ws-2', name: 'Second project', chats: []),
      ];
      await openDraft(tester);
      expect(draftProject('Mobile App'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('cloud-new-chat-project')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('cloud-project-picker')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('cloud-project-option-ws-2')));
      await tester.pumpAndSettle();
      expect(draftProject('Second project'), findsOneWidget);
      expect(repository.createCalls, isEmpty);

      await send(tester, 'in the second project');
      await tester.pump();
      expect(repository.createCalls.single.workspaceId, 'ws-2');
      expect(
        list.workspaces.last.chats.single.externalId,
        repository.createCalls.single.externalId,
      );
    });

    testWidgets('project picker announces the selected project', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'ws-2', name: 'Second project', chats: []),
      ];
      await openDraft(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-new-chat-project')));
      await tester.pumpAndSettle();
      final selected = find.byKey(const ValueKey('cloud-project-option-ws-1'));
      final unselected = find.byKey(
        const ValueKey('cloud-project-option-ws-2'),
      );
      expect(
        tester.getSemantics(selected).flagsCollection.isSelected,
        Tristate.isTrue,
      );
      expect(
        tester.getSemantics(unselected).flagsCollection.isSelected,
        Tristate.isFalse,
      );
    });

    testWidgets('a draft can preselect its project', (tester) async {
      repository.workspaces = [
        sampleWorkspace(),
        sampleWorkspace(id: 'ws-2', name: 'Second project', chats: []),
      ];
      await openDraft(tester, workspaceId: 'ws-2');
      expect(draftProject('Second project'), findsOneWidget);
      await send(tester, 'preselected');
      await tester.pump();
      expect(repository.createCalls.single.workspaceId, 'ws-2');
    });

    testWidgets('a model picked in the draft is used to create the chat', (
      tester,
    ) async {
      await openDraft(tester);
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('model-option-claude-opus-5')),
      );
      await tester.pumpAndSettle();
      expect(repository.setModelCalls, isEmpty);
      await send(tester, 'with opus');
      await tester.pump();
      expect(repository.createCalls.single.model, 'claude-opus-5');
      expect(repository.postCalls.single.model, 'claude-opus-5');
    });

    testWidgets('a failed create keeps the prompt as a not-sent row', (
      tester,
    ) async {
      repository.createError = const CloudApiException(
        statusCode: 402,
        message: 'Not enough credits',
      );
      await openDraft(tester);
      await send(tester, 'keep this text');
      await tester.pump();
      expect(find.text('Not enough credits'), findsOneWidget);
      expect(find.text('Not sent'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('cloud-new-chat-screen')),
        findsOneWidget,
      );
      expect(find.text('keep this text'), findsOneWidget);
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('composer-draft')),
      );
      expect(field.controller!.text, isEmpty);
      expect(chat.state, isNull);
      expect(repository.postCalls, isEmpty);
    });

    testWidgets('a draft send waits while another chat has a queued turn', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn-1',
        activeUserMessageId: 'user-1',
        activeStreamAfter: '7',
      );
      await openDraft(tester);
      chat.open('chat-1', cursorEpoch: 'session-chat-1');
      await tester.pump();
      await tester.pump();
      chat.send(
        clientRequestId: 'queued-follow-up',
        payload: const CloudSendPayload(text: 'Do this next'),
      );
      await send(tester, 'new chat please');
      expect(repository.createCalls, isEmpty);
      expect(chat.state!.outbox.single.clientRequestId, 'queued-follow-up');
      expect(find.text('new chat please'), findsOneWidget);
    });

    testWidgets('renders the hydrated transcript under the chat title', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation();
      await openChat(tester);
      expect(find.byKey(const ValueKey('cloud-chat-screen')), findsOneWidget);
      expect(find.text('Plan the mobile launch'), findsOneWidget);
      expect(find.textContaining('hello agent'), findsOneWidget);
      expect(find.textContaining('hello human'), findsOneWidget);
      expect(find.byKey(const ValueKey('composer-send')), findsOneWidget);
    });

    testWidgets('a fired watcher shows its title and notice, never its '
        'instruction block, each time the chat opens (CAN-4432)', (
      tester,
    ) async {
      const label = 'Chat completion: Release notes';
      repository.bootstraps['chat-1'] = CloudChatBootstrap(
        messages: [
          message('u1', role: 'USER', text: 'hello agent', requestId: 'r1'),
          message(
            'u2',
            role: 'USER',
            text:
                '<system_instruction>\n<canopy_watcher_event>\n'
                '{"label": "$label", "secret": "PRIVATE-PAYLOAD-SENTINEL"}\n'
                '</canopy_watcher_event>\n</system_instruction>\n\n'
                'Canopy watcher fired.\n$label',
            createdAtMs: 1789890001000,
            watcherFired: const ChatWatcherFiredInfo(kind: label),
          ),
        ],
        toolActivity: const [],
      );
      for (var open = 0; open < 2; open++) {
        await openChat(tester);
        expect(find.text('$label watcher has fired'), findsOneWidget);
        expect(find.byKey(const ValueKey('watcher-bubble-u2')), findsOneWidget);
        expect(find.byKey(const ValueKey('user-bubble-u1')), findsOneWidget);
        for (final hidden in [
          '<system_instruction>',
          'watcher_event',
          'PRIVATE-PAYLOAD-SENTINEL',
        ]) {
          expect(
            find.textContaining(hidden, findRichText: true),
            findsNothing,
            reason: hidden,
          );
        }
        Navigator.of(tester.element(find.byType(CloudChatScreen))).pop();
        await tester.pumpAndSettle();
      }
    });

    testWidgets('an empty chat shows the empty transcript prompt', (
      tester,
    ) async {
      await openChat(tester);
      expect(find.byKey(const ValueKey('cloud-chat-empty')), findsOneWidget);
    });

    testWidgets('a failed bootstrap offers Retry', (tester) async {
      repository.bootstrapErrors['chat-1'] = const CloudApiException(
        statusCode: 500,
        message: 'Cloud request failed with status 500',
      );
      await openChat(tester);
      expect(
        find.byKey(const ValueKey('cloud-chat-bootstrap-error')),
        findsOneWidget,
      );
      expect(find.text("Couldn't load chat history."), findsOneWidget);
      expect(find.text('Cloud request failed with status 500'), findsNothing);
      repository.bootstrapErrors.clear();
      repository.bootstraps['chat-1'] = conversation();
      await tester.tap(find.byKey(const ValueKey('cloud-chat-retry')));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('hello human'), findsOneWidget);
    });

    testWidgets('a failed bootstrap stays visible beside an empty live feed', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = const CloudChatBootstrap(
        messages: [],
        toolActivity: [],
        activeTurnId: 'turn-1',
        activeUserMessageId: 'user-1',
        activeStreamAfter: '7',
      );
      await openChat(tester);
      expect(chat.turnInProgress, isTrue);

      repository.bootstrapErrors['chat-1'] = const CloudApiException(
        statusCode: 500,
        message: 'Cloud request failed with status 500',
      );
      await chat.refresh();
      await tester.pump();

      expect(
        find.byKey(const ValueKey('cloud-bootstrap-error')),
        findsOneWidget,
      );
      expect(find.text("Couldn't load chat history."), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      chat.setForeground(false);
    });

    testWidgets('sending shows the optimistic row and posts the turn', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation();
      await openChat(tester);
      await send(tester, 'next step please');
      expect(find.textContaining('next step please'), findsOneWidget);
      expect(repository.postCalls.single.text, 'next step please');
      expect(repository.postCalls.single.chatId, 'chat-1');
      await tester.pump();
      expect(chat.state!.outbox, isEmpty);
      expect(find.textContaining('next step please'), findsOneWidget);
      expect(chat.turnInProgress, isTrue);
    });

    testWidgets('Stop interrupts the live turn', (tester) async {
      repository.bootstraps['chat-1'] = conversation(activeTurnId: 'turn-1');
      await openChat(tester);
      expect(chat.turnInProgress, isTrue);
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('composer-stop')));
      await tester.pump();
      expect(repository.interruptCalls.single.turnId, 'turn-1');
    });

    testWidgets('answering an ask-user card sends the answer as a turn', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = askUser();
      await openChat(tester);
      expect(find.byType(PendingQuestionCard), findsOneWidget);
      await tester.tap(find.text('Android'));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('question-submit-q1')));
      await tester.pump();
      expect(repository.postCalls.single.text, contains('Which platform?'));
      expect(repository.postCalls.single.text, contains('Android'));
      expect(find.byType(PendingQuestionCard), findsNothing);
    });

    for (final reset in [false, true]) {
      testWidgets(
        'a stale question card sends nothing after '
        '${reset ? 'the account resets' : 'the session moves to another chat'}',
        (tester) async {
          repository.bootstraps['chat-1'] = askUser();
          await openChat(tester);
          final submit = tester
              .widget<PendingQuestionCard>(find.byType(PendingQuestionCard))
              .onSubmit;
          if (reset) {
            list.reset();
          } else {
            chat.open('chat-2', cursorEpoch: '');
          }

          submit!(const [
            AskUserQuestionAnswer(
              question: 'Which platform?',
              selectedOptions: ['Android'],
            ),
          ]);
          expect(chat.state?.outbox ?? const [], isEmpty);
          await tester.pump();
          await tester.pump(const Duration(seconds: 1));
          expect(repository.postCalls, isEmpty);
        },
      );
    }

    testWidgets('a secret ask-user question is never sent from mobile', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = askUser(secret: true);
      await openChat(tester);
      expect(find.byType(PendingQuestionCard), findsNothing);
      expect(
        find.byKey(const ValueKey('cloud-secret-question-q1')),
        findsOneWidget,
      );
      expect(repository.postCalls, isEmpty);
    });

    testWidgets('sending to a terminal chat continues it in place', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation(
        terminal: const CloudTerminalSession(
          status: 'completed',
          sourceAgentSessionId: 'session-1',
        ),
      );
      await openChat(tester);
      expect(find.textContaining('hello human'), findsOneWidget);
      expect(find.text('Plan the mobile launch'), findsOneWidget);
      expect(find.byKey(const ValueKey('composer-draft')), findsOneWidget);
      expect(find.byKey(const ValueKey('cloud-continue')), findsNothing);
      repository.bootstraps['chat-1'] = conversation();
      await send(tester, 'continue from here');
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(repository.continueCalls, ['chat-1']);
      expect(chat.state!.sessionStatus, CloudSessionStatus.live);
      expect(repository.postCalls.single.text, 'continue from here');
      expect(find.byKey(const ValueKey('composer-draft')), findsOneWidget);
    });

    testWidgets('a session reset leaves the mounted cloud chat route', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation();
      await openChat(tester);
      expect(find.byType(CloudChatScreen), findsOneWidget);

      chat.close();
      await tester.pumpAndSettle();

      expect(find.byType(CloudChatScreen), findsNothing);
      expect(find.byKey(const ValueKey('open')), findsOneWidget);
    });

    testWidgets('Rename updates the title through the overflow menu', (
      tester,
    ) async {
      await openChat(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-chat-options')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-chat-rename')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('cloud-rename-field')),
        'Launch plan',
      );
      await tester.tap(find.byKey(const ValueKey('cloud-rename-save')));
      await tester.pumpAndSettle();
      expect(repository.renameCalls.single.title, 'Launch plan');
      expect(find.text('Launch plan'), findsOneWidget);
    });

    testWidgets('Archive confirms, archives, and leaves the chat', (
      tester,
    ) async {
      await openChat(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-chat-options')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-chat-archive')));
      await tester.pumpAndSettle();
      expect(repository.archiveCalls, isEmpty);
      await tester.tap(find.byKey(const ValueKey('cloud-archive-confirm')));
      await tester.pumpAndSettle();
      expect(repository.archiveCalls, ['chat-1']);
      expect(find.byKey(const ValueKey('cloud-chat-screen')), findsNothing);
      expect(list.chatById('chat-1'), isNull);
    });

    testWidgets('Archive closes a session with a queued follow-up', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation(activeTurnId: 'turn-1');
      await openChat(tester);
      await send(tester, 'send this after the active turn');
      expect(chat.state!.outbox, hasLength(1));

      await tester.tap(find.byKey(const ValueKey('cloud-chat-options')));
      await tester.pump(const Duration(seconds: 1));
      tester
          .widget<MenuItemButton>(
            find.byKey(const ValueKey('cloud-chat-archive')),
          )
          .onPressed!();
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('cloud-archive-confirm')));
      await tester.pump(const Duration(milliseconds: 300));

      expect(repository.archiveCalls, ['chat-1']);
      expect(chat.state, isNull);
    });

    testWidgets('a definitive send failure shows the server message inline', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation();
      repository.postError = const CloudSendError(
        kind: CloudSendErrorKind.definitive,
        status: 402,
        message: 'You are out of credits.',
      );
      await openChat(tester);
      await send(tester, 'try again later');
      await tester.pump();
      // The reason shows once, on the failed row; no banner (CAN-3556).
      expect(find.byKey(const ValueKey('cloud-send-error')), findsNothing);
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('You are out of credits.'), findsOneWidget);
      await tester.tap(find.text('Resend'));
      await tester.pump();
      await tester.pump();
      expect(repository.postCalls, hasLength(2));
      expect(find.text('Not sent'), findsNothing);
      expect(find.text('You are out of credits.'), findsNothing);
    });

    testWidgets('a repeated retry failure shows the new reason on the row', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation();
      repository.postError = const CloudSendError(
        kind: CloudSendErrorKind.definitive,
        status: 402,
        message: 'You are out of credits.',
      );
      await openChat(tester);
      await send(tester, 'try again later');
      await tester.pump();
      expect(find.text('You are out of credits.'), findsOneWidget);

      repository.postError = const CloudSendError(
        kind: CloudSendErrorKind.definitive,
        status: 402,
        message: 'Still out of credits.',
      );
      await tester.tap(find.text('Resend'));
      await tester.pump();
      await tester.pump();

      expect(find.byKey(const ValueKey('cloud-send-error')), findsNothing);
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('Still out of credits.'), findsOneWidget);
      expect(find.text('You are out of credits.'), findsNothing);
      expect(repository.postCalls, hasLength(2));
    });

    testWidgets(
      'a continuation failure shows one Retry with canonical delivery copy',
      (tester) async {
        repository.bootstraps['chat-1'] = conversation(
          terminal: const CloudTerminalSession(
            status: 'completed',
            sourceAgentSessionId: 'session-1',
          ),
        );
        repository.continueError = StateError('offline');
        await openChat(tester);

        await send(tester, 'continue when available');
        await tester.pump();
        await tester.pump();

        // A failed continuation keeps the banner (CAN-3556).
        expect(find.byKey(const ValueKey('cloud-send-error')), findsOneWidget);
        expect(find.text('Retry'), findsOneWidget);
        expect(find.text('Dismiss'), findsNothing);
        expect(find.text('Could not send the message. Retry.'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('cloud-bootstrap-error')),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a discarded send failure stays gone when a new message succeeds',
      (tester) async {
        repository.bootstraps['chat-1'] = conversation();
        repository.postError = const CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 402,
          message: 'You are out of credits.',
        );
        await openChat(tester);
        await send(tester, 'old failed message');
        await tester.pump();
        expect(find.byKey(const ValueKey('cloud-send-error')), findsNothing);
        expect(find.text('Not sent'), findsOneWidget);

        await tester.tap(find.text('Discard'));
        await tester.pump();
        expect(find.text('old failed message'), findsNothing);

        await send(tester, 'new successful message');
        await tester.pump();

        expect(repository.postCalls, hasLength(2));
        expect(find.byKey(const ValueKey('cloud-send-error')), findsNothing);
        expect(find.text('Not sent'), findsNothing);
        expect(store.unsentFor(kCloudUnsentSurface), isEmpty);
      },
    );

    group('out of AI Credits', () {
      const serverMessage = 'Not enough AI credits to continue.';
      const outOfCredits = "You're out of AI Credits.";

      String body(String code) => jsonEncode({
        'error': {'code': code, 'message': serverMessage},
      });

      // The error the transport throws for a refused send (CAN-4435).
      CloudSendError refusedSend(int status, String code) =>
          classifyCloudSendError(
            status: status,
            body: jsonDecode(body(code)),
            headers: {'X-Canopy-Error-Code': code},
          );

      testWidgets('a send refused for credits shows the app copy with Resend', (
        tester,
      ) async {
        repository.bootstraps['chat-1'] = conversation();
        repository.postError = refusedSend(402, 'INSUFFICIENT_CREDITS');
        await openChat(tester);

        await send(tester, 'one more task');
        await tester.pump();

        expect(tester.takeException(), isNull);
        expect(find.text(outOfCredits), findsOneWidget);
        expect(find.text(serverMessage), findsNothing);
        expect(find.text('Resend'), findsOneWidget);
      });

      testWidgets('a first send refused for credits shows the app copy', (
        tester,
      ) async {
        repository.createError = CloudApiException.fromApiException(
          ApiException(statusCode: 402, body: body('INSUFFICIENT_CREDITS')),
        );
        await openDraft(tester);

        await send(tester, 'first task');
        await tester.pump();

        expect(tester.takeException(), isNull);
        expect(find.text(outOfCredits), findsOneWidget);
        expect(find.text(serverMessage), findsNothing);
        expect(find.text('Resend'), findsOneWidget);
      });

      for (final (status, code) in [
        (402, 'OTHER_PAYMENT'),
        (400, 'INSUFFICIENT_CREDITS'),
      ]) {
        testWidgets('a $status $code refusal keeps the server message', (
          tester,
        ) async {
          repository.bootstraps['chat-1'] = conversation();
          repository.postError = refusedSend(status, code);
          await openChat(tester);

          await send(tester, 'one more task');
          await tester.pump();

          expect(find.text(serverMessage), findsOneWidget);
          expect(find.text(outOfCredits), findsNothing);
          expect(find.text('Resend'), findsOneWidget);
        });
      }
    });

    testWidgets(
      'a bootstrap recovery error keeps Retry visible while input is locked',
      (tester) async {
        repository.bootstraps['chat-1'] = conversation();
        await openChat(tester);
        repository.bootstrapErrors['chat-1'] = const CloudApiException(
          statusCode: 401,
          message: 'Authentication required',
        );
        await chat.refresh();
        await tester.pump();
        expect(
          find.byKey(const ValueKey('cloud-bootstrap-error')),
          findsOneWidget,
        );
        expect(find.text('Retry'), findsOneWidget);
        expect(find.text('Dismiss'), findsNothing);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'blocked while recovery is required',
        );
        await tester.pump();
        final send = tester.widget<CanopyComposerAction>(
          find.byKey(const ValueKey('composer-send')),
        );
        expect(send.onPressed, isNull);
        chat.setForeground(false);
      },
    );

    testWidgets('archive failure uses the canonical recovery copy', (
      tester,
    ) async {
      repository.archiveError = StateError('offline');
      await openChat(tester);
      await tester.tap(find.byKey(const ValueKey('cloud-chat-options')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-chat-archive')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cloud-archive-confirm')));
      await tester.pumpAndSettle();

      expect(
        find.text("Couldn't archive the cloud session. Try again."),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('cloud-chat-screen')), findsOneWidget);
    });

    testWidgets(
      'waits for the model catalog before sending a model-less chat',
      (tester) async {
        repository.workspaces = [
          sampleWorkspace(chats: [sampleChat(model: null)]),
        ];
        final models = Completer<CloudModelCatalog>();
        repository.modelsCompleter = models;

        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(subject());
        await list.load();
        await tester.tap(find.byKey(const ValueKey('open')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        await send(tester, 'wait for a safe model');
        expect(repository.postCalls, isEmpty);

        models.complete(sampleCatalog);
        await tester.pump();
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();

        expect(repository.postCalls.single.model, 'gpt-5.6-luna');
      },
    );

    testWidgets('keeps a model-less draft retryable after catalog failure', (
      tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(chats: [sampleChat(model: null)]),
      ];
      repository.modelsError = StateError('catalog unavailable');

      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(subject());
      await list.load();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      await tester.pump();
      expect(list.modelsLoading, isFalse);
      expect(list.modelsError, isNotNull);
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'keep this draft',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(repository.postCalls, isEmpty);
      expect(
        find.text("Couldn't load available models. Try again."),
        findsOneWidget,
      );
      expect(find.text('keep this draft'), findsOneWidget);

      ScaffoldMessenger.of(
        tester.element(find.byType(CloudChatScreen)),
      ).removeCurrentSnackBar();
      await tester.pump();
      repository.modelsError = null;
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();

      expect(repository.postCalls.single.model, 'gpt-5.6-luna');
    });

    // The composer stays editable while a send waits for the catalog. The
    // send must not reach another chat or erase newer text.
    Future<Completer<CloudModelCatalog>> openModelLessChat(
      WidgetTester tester,
    ) async {
      repository.workspaces = [
        sampleWorkspace(chats: [sampleChat(model: null)]),
      ];
      repository.modelsError = StateError('catalog unavailable');
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(subject());
      await list.load();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      repository.modelsError = null;
      final models = Completer<CloudModelCatalog>();
      repository.modelsCompleter = models;
      addTearDown(() {
        if (!models.isCompleted) models.complete(sampleCatalog);
      });
      return models;
    }

    final interruptions = <String, void Function()>{
      'the session closes': () => chat.close(),
      'the session moves to another chat': () {
        repository.bootstraps['chat-2'] = conversation();
        chat.open('chat-2', cursorEpoch: 'session-chat-2');
      },
      'the account resets': () => list.reset(),
    };
    for (final MapEntry(key: name, value: interrupt) in interruptions.entries) {
      testWidgets('a send waiting for models is dropped when $name', (
        tester,
      ) async {
        final models = await openModelLessChat(tester);
        await send(tester, 'keep this draft');

        interrupt();
        await tester.pump();
        models.complete(sampleCatalog);
        await tester.pump();
        await tester.pump();

        expect(repository.postCalls, isEmpty);
        expect(
          store.draftFor(const CloudChatDraftTarget('chat-1')),
          'keep this draft',
        );
      });
    }

    testWidgets('a send waiting for models sends the text typed meanwhile', (
      tester,
    ) async {
      final models = await openModelLessChat(tester);
      await send(tester, 'first');
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'second',
      );
      await tester.pump();
      models.complete(sampleCatalog);
      await tester.pump();
      await tester.pump();

      expect(repository.postCalls.single.text, 'second');
      expect(store.draftFor(const CloudChatDraftTarget('chat-1')), isEmpty);
    });

    testWidgets(
      'allows Core to resolve a model after a successful unavailable catalog',
      (tester) async {
        repository.workspaces = [
          sampleWorkspace(chats: [sampleChat(model: null)]),
        ];
        repository.catalog = const CloudModelCatalog(
          models: [],
          modelHarnesses: {},
          defaultModelId: null,
          defaultModelBlocked: false,
          defaultModelUnavailable: true,
        );

        await openChat(tester);
        await send(tester, 'let Core choose the model');

        expect(list.modelsError, isNull);
        expect(repository.postCalls.single.model, isNull);
      },
    );

    testWidgets('reopening after an in-place continuation keeps its epoch', (
      tester,
    ) async {
      repository.bootstraps['chat-1'] = conversation(
        terminal: const CloudTerminalSession(
          status: 'completed',
          sourceAgentSessionId: 'session-1',
        ),
      );
      await openChat(tester);
      repository.bootstraps['chat-1'] = conversation();
      await send(tester, 'continue this chat');
      await tester.pump();
      await tester.pump();
      expect(chat.state!.cursorEpoch, 'session-1-continued');

      await tester.pageBack();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(chat.state!.cursorEpoch, 'session-1-continued');
    });

    testWidgets('composer controls come from the cloud catalog', (
      tester,
    ) async {
      await openChat(tester);
      expect(find.text('GPT-5.6 Luna'), findsOneWidget);
      expect(find.text('Medium'), findsOneWidget);

      await openEffortSheet(tester);
      expect(
        tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel)).levels,
        ['off', 'medium', 'high', 'xhigh'],
      );
      await landEffortSlider(tester, 'high');
      await tester.tap(find.byKey(const ValueKey('effort-fast-mode')));
      await tester.pumpAndSettle();
      await closeEffortSheet(tester);
      expect(find.text('High'), findsOneWidget);
      expect(find.byKey(const ValueKey('effort-trigger-bolt')), findsOneWidget);
      await send(tester, 'go fast');
      expect(repository.postCalls.single.thinking, 'high');
      expect(repository.postCalls.single.fast, isTrue);
    });

    // CAN-4436 internal review: the chat moves to another model with the
    // same levels while a drag on the old model is down. The release of that
    // drag must not choose a level for the new model.
    testWidgets('a model switch under a drag sends no level for the new '
        'model; the next drag does', (tester) async {
      const sol = CloudModelOption(
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        provider: 'openai',
        family: 'gpt',
        familyLabel: 'GPT',
        harness: 'codex',
        fastModeSupported: true,
        thinkingLevels: ['off', 'medium', 'high', 'xhigh'],
      );
      repository.catalog = CloudModelCatalog(
        models: [...sampleCatalog.models, sol],
        modelHarnesses: {...sampleCatalog.modelHarnesses, sol.id: 'codex'},
        defaultModelId: sampleCatalog.defaultModelId,
        defaultModelBlocked: false,
      );
      await openChat(tester);
      await openEffortSheet(tester);
      final gesture = await holdEffortDrag(tester, 'high');

      // Another client moves the chat to Sol, which has the same levels.
      final workspace = repository.workspaces.single;
      repository.workspaces = [
        copyWorkspace(
          workspace,
          chats: [copyChat(workspace.chats.single, modelDefinitionId: sol.id)],
        ),
      ];
      await list.refresh();
      await tester.pump();
      await tester.pump();
      expect(find.text(sol.label), findsOneWidget);
      expect(
        tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel)).levels,
        sol.thinkingLevels,
      );
      expect(effortHeadingText(tester), 'Effort  Medium');

      await gesture.up();
      await tester.pumpAndSettle();
      expect(effortHeadingText(tester), 'Effort  Medium');
      await closeEffortSheet(tester);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('composer-thinking')),
          matching: find.text('Medium'),
        ),
        findsOneWidget,
        reason: 'the old drag chose nothing',
      );

      await chooseComposerEffort(tester, 'xhigh');
      await send(tester, 'think harder');
      expect(repository.postCalls.single.model, sol.id);
      expect(repository.postCalls.single.thinking, 'xhigh');
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'an explicitly non-thinking model hides and omits thinking controls',
      (tester) async {
        repository.catalog = const CloudModelCatalog(
          models: [
            CloudModelOption(
              id: 'gpt-5.6-luna',
              label: 'GPT-5.6 Luna',
              provider: 'openai',
              family: 'gpt',
              familyLabel: 'GPT',
              harness: 'codex',
              thinkingLevels: [],
            ),
          ],
          modelHarnesses: {'gpt-5.6-luna': 'codex'},
          defaultModelId: 'gpt-5.6-luna',
          defaultModelBlocked: false,
        );

        await openChat(tester);

        expect(find.byKey(const ValueKey('composer-thinking')), findsNothing);
        await send(tester, 'do not think');
        expect(repository.postCalls.single.thinking, isNull);
      },
    );

    testWidgets('a draft offers Core levels without Ultra; /thinking and '
        '/fast use the same state', (tester) async {
      repository.catalog = const CloudModelCatalog(
        models: [
          CloudModelOption(
            id: 'gpt-5.6-luna',
            label: 'GPT-5.6 Luna',
            provider: 'openai',
            family: 'gpt',
            familyLabel: 'GPT',
            harness: 'codex',
            fastModeSupported: true,
            thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'ultra'],
          ),
        ],
        modelHarnesses: {'gpt-5.6-luna': 'codex'},
        defaultModelId: 'gpt-5.6-luna',
        defaultModelBlocked: false,
      );
      await openDraft(tester);
      final draft = find.byKey(const ValueKey('composer-draft'));
      await tester.enterText(draft, '/thinking');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-command-thinking')));
      await tester.pumpAndSettle();
      expect(
        tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel)).levels,
        ['low', 'medium', 'high', 'xhigh'],
      );
      await landEffortSlider(tester, 'xhigh');
      await closeEffortSheet(tester);

      await tester.enterText(draft, '/fast');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-command-fast')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('effort-trigger-bolt')), findsOneWidget);
      await send(tester, 'start fast');
      await tester.pump();
      await tester.pump();
      expect(repository.postCalls.single.thinking, 'xhigh');
      expect(repository.postCalls.single.fast, isTrue);
      expect(tester.takeException(), isNull);
    });

    for (final (name, levels, shown, sent) in const [
      (
        'Ultra is dropped and a stored Ultra clamps to Max',
        ['off', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        'Max',
        'max',
      ),
      ('a model that declares only Ultra has no effort', ['ultra'], null, null),
    ]) {
      testWidgets('CAN4436 red: $name', (tester) async {
        repository.catalog = CloudModelCatalog(
          models: [
            CloudModelOption(
              id: 'gpt-5.6-luna',
              label: 'GPT-5.6 Luna',
              provider: 'openai',
              family: 'gpt',
              familyLabel: 'GPT',
              harness: 'codex',
              thinkingLevels: levels,
            ),
          ],
          modelHarnesses: const {'gpt-5.6-luna': 'codex'},
          defaultModelId: 'gpt-5.6-luna',
          defaultModelBlocked: false,
        );
        repository.workspaces = [
          sampleWorkspace(chats: [sampleChat(thinkingLevel: 'ultra')]),
        ];
        await openChat(tester);

        final trigger = find.byKey(const ValueKey('composer-thinking'));
        expect(find.text('Ultra'), findsNothing);
        if (shown == null) {
          expect(trigger, findsNothing);
        } else {
          expect(
            find.descendant(of: trigger, matching: find.text(shown)),
            findsOneWidget,
          );
        }
        await send(tester, 'no ultra on cloud');
        expect(repository.postCalls.single.thinking, sent);
        expect(tester.takeException(), isNull);
      });
    }

    // CAN-4436 published review: a chat saved on a model the catalog no
    // longer lists resolves its own levels (the provider fallback), never
    // the default model's row.
    for (final (name, defaultLevels) in const [
      ('a thinking default model', ['off', 'medium', 'high', 'xhigh']),
      ('a non-thinking default model', <String>[]),
    ]) {
      for (final touched in [false, true]) {
        testWidgets('CAN4436 red: a chat on an unlisted model beside $name '
            '${touched ? 'sends the chosen effort' : 'keeps its stored '
                      'effort and sends none'}', (tester) async {
          repository.catalog = CloudModelCatalog(
            models: [
              CloudModelOption(
                id: 'gpt-5.6-luna',
                label: 'GPT-5.6 Luna',
                provider: 'openai',
                family: 'gpt',
                familyLabel: 'GPT',
                harness: 'codex',
                thinkingLevels: defaultLevels,
              ),
            ],
            modelHarnesses: const {'gpt-5.6-luna': 'codex'},
            defaultModelId: 'gpt-5.6-luna',
            defaultModelBlocked: false,
          );
          repository.workspaces = [
            sampleWorkspace(
              chats: [
                sampleChat(model: 'claude-opus-4-5', thinkingLevel: 'max'),
              ],
            ),
          ];
          await openChat(tester);
          expect(find.text('Model no longer available'), findsOneWidget);
          if (!touched) {
            await send(tester, 'still on the old model');
            expect(repository.postCalls.single.model, 'claude-opus-4-5');
            expect(
              repository.postCalls.single.thinking,
              isNull,
              reason: 'nobody changed effort',
            );
          }

          final trigger = find.byKey(const ValueKey('composer-thinking'));
          expect(
            find.descendant(of: trigger, matching: find.text('Max')),
            findsOneWidget,
          );
          if (touched) {
            await openEffortSheet(tester);
            expect(
              tester
                  .widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel))
                  .levels,
              ['off', 'medium', 'high', 'xhigh', 'max'],
            );
            await landEffortSlider(tester, 'high');
            await closeEffortSheet(tester);
            await send(tester, 'still on the old model');
            expect(repository.postCalls.single.model, 'claude-opus-4-5');
            expect(repository.postCalls.single.thinking, 'high');
          }
          expect(tester.takeException(), isNull);
        });
      }
    }

    // CAN-4436 required review: the chat's bound harness picks the provider
    // fallback. A Codex chat whose catalog request failed has no row, so it
    // offers Codex levels (no Max), not the generic cycle.
    for (final touched in [false, true]) {
      testWidgets('CAN4436 red: a Codex chat whose catalog failed offers '
          'Codex levels and '
          '${touched ? 'sends the chosen effort' : 'sends no effort'}', (
        tester,
      ) async {
        repository.modelsError = StateError('catalog unavailable');
        repository.bootstraps['chat-1'] = answeredBootstrap(bound: 'codex');
        await openChat(tester);
        expect(list.modelsError, isNotNull);
        expect(list.models, isEmpty);
        expect(chat.state?.executionHarness, 'codex');

        final trigger = find.byKey(const ValueKey('composer-thinking'));
        expect(
          find.descendant(of: trigger, matching: find.text('Medium')),
          findsOneWidget,
        );
        await openEffortSheet(tester);
        expect(
          tester
              .widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel))
              .levels,
          ['off', 'medium', 'high', 'xhigh'],
        );
        if (touched) await landEffortSlider(tester, 'high');
        await closeEffortSheet(tester);
        await send(tester, 'keep going');
        expect(repository.postCalls.single.model, 'gpt-5.6-luna');
        expect(repository.postCalls.single.thinking, touched ? 'high' : null);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a Claude chat whose catalog failed keeps the Claude levels', (
      tester,
    ) async {
      repository.modelsError = StateError('catalog unavailable');
      repository.workspaces = [
        sampleWorkspace(
          chats: [sampleChat(model: 'claude-opus-5', thinkingLevel: 'max')],
        ),
      ];
      repository.bootstraps['chat-1'] = answeredBootstrap(
        bound: 'claude',
        model: 'claude-opus-5',
      );
      await openChat(tester);
      expect(list.models, isEmpty);

      await openEffortSheet(tester);
      expect(
        tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel)).levels,
        ['off', 'medium', 'high', 'xhigh', 'max'],
      );
      expect(effortHeadingText(tester), 'Effort  Max');
      await closeEffortSheet(tester);
      await send(tester, 'keep going');
      expect(repository.postCalls.single.model, 'claude-opus-5');
      expect(repository.postCalls.single.thinking, isNull);
    });

    testWidgets('a draft does not take the harness of the chat the session '
        'still holds', (tester) async {
      repository.modelsError = StateError('catalog unavailable');
      repository.bootstraps['chat-1'] = answeredBootstrap(bound: 'codex');
      chat.open('chat-1', cursorEpoch: 'session-1');
      await openDraft(tester);
      expect(
        tester.widget<CloudChatScreen>(find.byType(CloudChatScreen)).chatId,
        isNull,
      );
      expect(chat.state?.chatId, 'chat-1');
      expect(chat.state?.executionHarness, 'codex');
      expect(list.models, isEmpty);

      await openEffortSheet(tester);
      expect(
        tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel)).levels,
        ['off', 'medium', 'high', 'xhigh', 'max'],
      );
      expect(tester.takeException(), isNull);
    });

    for (final draft in [false, true]) {
      testWidgets('${draft ? 'a draft' : 'a chat'} shows hosted models as AI '
          'Credits rows on their harness', (tester) async {
        if (draft) {
          await openDraft(tester);
        } else {
          await openChat(tester);
        }
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        final opus = find.byKey(const ValueKey('model-option-claude-opus-5'));
        expect(
          find.descendant(of: opus, matching: find.text('AI credits')),
          findsOneWidget,
        );

        await tester.tap(find.byKey(const ValueKey('model-picker-tab-claude')));
        await tester.pumpAndSettle();
        expect(find.text('Other supported models'), findsOneWidget);
        await tester.longPress(opus);
        await tester.pumpAndSettle();
        expect(find.text('Harness'), findsOneWidget);
      });
    }

    testWidgets('an empty hosted catalog shows the neutral empty state', (
      tester,
    ) async {
      repository.catalog = const CloudModelCatalog(
        models: [],
        modelHarnesses: {},
        defaultModelId: null,
        defaultModelBlocked: false,
      );
      await openChat(tester);
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();

      expect(find.text('No models available'), findsOneWidget);
      expect(find.text('No models available yet.'), findsNothing);
      expect(find.textContaining('organization'), findsNothing);
    });

    testWidgets('a failed hosted catalog offers Retry inside the picker', (
      tester,
    ) async {
      repository.modelsError = Exception('offline');
      await openChat(tester);
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();

      expect(find.text('Couldn’t load'), findsOneWidget);
      repository.modelsError = null;
      await tester.tap(find.byKey(const ValueKey('model-picker-retry')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('model-option-claude-opus-5')),
        findsOneWidget,
      );
    });

    group('Auto', () {
      setUp(() {
        routing = ModelRoutingAvailabilityController(
          load: () async => ModelRoutingAvailability.available,
          accountScope: () => null,
        );
      });

      Future<void> pickAuto(WidgetTester tester) async {
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('model-picker-auto')));
        await tester.pumpAndSettle();
      }

      testWidgets('a chat persists the selection mode, never a model id', (
        tester,
      ) async {
        await openChat(tester);
        await pickAuto(tester);

        expect(repository.setAutoModelCalls, ['chat-1']);
        expect(repository.setModelCalls, isEmpty);
        expect(find.text('Auto'), findsOneWidget);
        expect(list.chatById('chat-1')?.modelAuto, isTrue);
      });

      testWidgets('a failed Auto returns to the model and says so', (
        tester,
      ) async {
        repository.setAutoModelError = const CloudApiException(
          statusCode: 409,
          message: 'Model routing is unavailable',
        );
        await openChat(tester);
        await pickAuto(tester);

        expect(find.text('Auto'), findsNothing);
        expect(find.text('GPT-5.6 Luna'), findsOneWidget);
        expect(find.text('Model routing is unavailable'), findsOneWidget);
      });

      CanopyComposerAction sendAction(WidgetTester tester) =>
          tester.widget(find.byKey(const ValueKey('composer-send')));

      // Starts an Auto or model choice whose save waits on the returned
      // completer.
      Future<Completer<void>> startChoice(
        WidgetTester tester, {
        required bool auto,
      }) async {
        final save = Completer<void>();
        addTearDown(() {
          if (!save.isCompleted) save.complete();
        });
        if (auto) {
          repository.setAutoModelCompleter = save;
        } else {
          repository.setModelCompleters['claude-opus-5'] = save;
        }
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        if (!auto) {
          await tester.tap(find.byKey(const ValueKey('model-picker-tab-all')));
          await tester.pump();
        }
        await tester.tap(
          find.byKey(
            ValueKey(auto ? 'model-picker-auto' : 'model-option-claude-opus-5'),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        return save;
      }

      // Send is held while a choice saves, so no send waits on a save and
      // every turn runs in the mode the chip shows.
      for (final auto in [true, false]) {
        final choice = auto ? 'an Auto' : 'a model';

        testWidgets('Send is held while $choice choice saves and later edits '
            'stay in the draft', (tester) async {
          await openChat(tester);
          final save = await startChoice(tester, auto: auto);
          await send(tester, 'first');
          final heldWhileSaving = sendAction(tester).onPressed == null;
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'second',
          );
          await tester.pump();
          save.complete();
          await tester.pump();
          await tester.pump();

          expect(repository.postCalls, isEmpty);
          expect(
            store.draftFor(const CloudChatDraftTarget('chat-1')),
            'second',
          );
          expect(heldWhileSaving, isTrue);

          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          expect(repository.postCalls.single.text, 'second');
          expect(list.chatById('chat-1')?.modelAuto, auto);
          if (!auto) {
            expect(repository.postCalls.single.model, 'claude-opus-5');
          }
        });

        testWidgets('a failed $choice choice sends nothing and keeps the '
            'draft', (tester) async {
          if (!auto) {
            repository.workspaces = [
              sampleWorkspace(chats: [copyChat(sampleChat(), modelAuto: true)]),
            ];
          }
          await openChat(tester);
          final save = await startChoice(tester, auto: auto);
          await send(tester, 'keep me');
          const failure = CloudApiException(
            statusCode: 409,
            message: 'The choice was not saved',
          );
          if (auto) {
            repository.setAutoModelError = failure;
          } else {
            repository.setModelErrors['claude-opus-5'] = failure;
          }
          save.complete();
          await tester.pump();
          await tester.pump();

          expect(repository.postCalls, isEmpty);
          expect(find.text('The choice was not saved'), findsOneWidget);
          expect(
            store.draftFor(const CloudChatDraftTarget('chat-1')),
            'keep me',
          );
          expect(find.text(auto ? 'GPT-5.6 Luna' : 'Auto'), findsOneWidget);
          expect(sendAction(tester).onPressed, isNotNull);
        });
      }

      testWidgets('Resend is held while a choice saves', (tester) async {
        repository.postError = const CloudSendError(
          kind: CloudSendErrorKind.definitive,
          status: 402,
          message: 'You are out of credits.',
        );
        await openChat(tester);
        await send(tester, 'try again later');
        await tester.pump();
        expect(find.text('Resend'), findsOneWidget);

        final save = await startChoice(tester, auto: true);
        expect(find.text('Resend'), findsNothing);
        save.complete();
        await tester.pump();
        await tester.pump();
        await tester.tap(find.text('Resend'));
        await tester.pump();
        await tester.pump();
        expect(repository.postCalls, hasLength(2));
      });

      // Leaves the chat route and opens it again, so a new screen state
      // starts while the shared view models keep running.
      Future<void> reopen(WidgetTester tester) async {
        Navigator.of(tester.element(find.byType(CloudChatScreen))).pop();
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        await tester.tap(find.byKey(const ValueKey('open')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pump();
      }

      // The gate belongs to the chat, not to the screen that made the choice.
      for (final auto in [true, false]) {
        for (final rejected in [false, true]) {
          final choice = auto ? 'an Auto' : 'a model';
          testWidgets('Send stays held after the chat reopens while $choice '
              'choice saves${rejected ? ' and fails' : ''}', (tester) async {
            if (!auto) {
              repository.workspaces = [
                sampleWorkspace(
                  chats: [copyChat(sampleChat(), modelAuto: true)],
                ),
              ];
            }
            await openChat(tester);
            final save = await startChoice(tester, auto: auto);
            await reopen(tester);
            await send(tester, 'first');

            expect(repository.postCalls, isEmpty);
            expect(sendAction(tester).onPressed, isNull);

            if (rejected) {
              const failure = CloudApiException(
                statusCode: 409,
                message: 'The choice was not saved',
              );
              if (auto) {
                repository.setAutoModelError = failure;
              } else {
                repository.setModelErrors['claude-opus-5'] = failure;
              }
            }
            save.complete();
            await tester.pump();
            await tester.pump();

            expect(repository.postCalls, isEmpty);
            expect(
              store.draftFor(const CloudChatDraftTarget('chat-1')),
              'first',
            );
            expect(list.chatById('chat-1')?.modelAuto, rejected ? !auto : auto);
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pump();
            await tester.pump();
            expect(repository.postCalls.single.text, 'first');
          });
        }
      }

      testWidgets('Retry is held while a choice saves and Resend stays held '
          'after the chat reopens', (tester) async {
        repository.bootstraps['chat-1'] = conversation(
          terminal: const CloudTerminalSession(
            status: 'completed',
            sourceAgentSessionId: 'session-1',
          ),
        );
        repository.continueError = StateError('offline');
        await openChat(tester);
        await send(tester, 'continue when available');
        await tester.pump();
        await tester.pump();
        expect(find.byKey(const ValueKey('cloud-send-error')), findsOneWidget);

        // Retry stays visible but disabled, so the banner keeps an action.
        TextButton retry() =>
            tester.widget(find.byKey(const ValueKey('cloud-send-error-retry')));
        final auto = await startChoice(tester, auto: true);
        expect(tester.takeException(), isNull);
        expect(retry().onPressed, isNull);
        expect(find.text('Resend'), findsNothing);
        auto.complete();
        await tester.pump();
        await tester.pump();
        expect(retry().onPressed, isNotNull);
        expect(find.text('Resend'), findsOneWidget);

        // Reopening loads the chat again, so the failed send keeps only its
        // row's Resend.
        final model = await startChoice(tester, auto: false);
        await reopen(tester);
        expect(find.byKey(const ValueKey('cloud-send-error')), findsNothing);
        expect(find.text('Resend'), findsNothing);
        model.complete();
        await tester.pump();
        await tester.pump();
        expect(find.text('Resend'), findsOneWidget);
      });

      // An answer posts a turn, so it waits for a choice like Send does.
      for (final rejected in [false, true]) {
        testWidgets('a question answer is held while a choice saves and kept '
            'when the save ${rejected ? 'fails' : 'lands'}', (tester) async {
          repository.bootstraps['chat-1'] = askUser();
          await openChat(tester);
          final save = await startChoice(tester, auto: true);
          await tester.tap(find.text('Android'));
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('question-submit-q1')));
          await tester.pump();

          expect(repository.postCalls, isEmpty);
          expect(find.byType(PendingQuestionCard), findsOneWidget);

          if (rejected) {
            repository.setAutoModelError = const CloudApiException(
              statusCode: 409,
              message: 'The choice was not saved',
            );
          }
          save.complete();
          await tester.pump();
          await tester.pump();
          expect(repository.postCalls, isEmpty);
          expect(find.byType(PendingQuestionCard), findsOneWidget);

          // The selection survived the hold.
          await tester.tap(find.byKey(const ValueKey('question-submit-q1')));
          await tester.pump();
          expect(repository.postCalls.single.text, contains('Android'));
          expect(list.chatById('chat-1')?.modelAuto, !rejected);
          expect(find.byType(PendingQuestionCard), findsNothing);
        });
      }

      // The server runs a send in the chat's saved mode when it accepts it,
      // so no new choice may overtake a send that is not yet accepted.
      Future<void> expectPickerHeld(WidgetTester tester) async {
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byKey(const ValueKey('model-picker-auto')), findsNothing);
      }

      for (final accepted in [true, false]) {
        testWidgets('the picker is held while a send posts until it is '
            '${accepted ? 'accepted' : 'rejected'}', (tester) async {
          final post = Completer<void>();
          repository.postCompleter = post;
          addTearDown(() {
            if (!post.isCompleted) post.complete();
          });
          if (!accepted) {
            repository.postError = const CloudSendError(
              kind: CloudSendErrorKind.definitive,
              status: 402,
              message: 'You are out of credits.',
            );
          }
          await openChat(tester);
          await send(tester, 'first');
          await expectPickerHeld(tester);

          post.complete();
          await tester.pump();
          await tester.pump();
          await startChoice(tester, auto: true);
          expect(repository.setAutoModelCalls, ['chat-1']);
        });
      }

      testWidgets('the picker is held while a send waits for the chat to '
          'load', (tester) async {
        final load = Completer<void>();
        repository.bootstrapCompleters['chat-1'] = load;
        addTearDown(() {
          if (!load.isCompleted) load.complete();
        });
        await openChat(tester);
        await send(tester, 'first');
        expect(repository.postCalls, isEmpty);
        await expectPickerHeld(tester);

        load.complete();
        await tester.pump();
        await tester.pump();
        expect(repository.postCalls.single.text, 'first');
        await startChoice(tester, auto: true);
        expect(repository.setAutoModelCalls, ['chat-1']);
      });

      // A retained record keeps its own selection, so the chip shows it and
      // takes no new choice until the record settles or is discarded.
      testWidgets('the picker is held while a draft creates its chat, so the '
          'first send keeps its selection', (tester) async {
        final creating = Completer<void>(), post = Completer<void>();
        repository.createCompleters['ws-1'] = creating;
        repository.postCompleter = post;
        addTearDown(() {
          for (final c in [creating, post]) {
            if (!c.isCompleted) c.complete();
          }
        });
        await openDraft(tester);
        await pickAuto(tester);
        await send(tester, 'hello');
        await expectPickerHeld(tester);
        expect(find.text('Auto'), findsOneWidget);

        creating.complete();
        await tester.pump();
        await tester.pump();
        expect(repository.autoModelCreates, hasLength(1));
        expect(repository.postCalls, hasLength(1));
        await expectPickerHeld(tester);
        post.complete();
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));

        expect(repository.setAutoModelCalls, isEmpty);
        expect(repository.setModelCalls, isEmpty);
        expect(find.text('Auto'), findsOneWidget);
        expect(find.byType(SnackBar), findsNothing);
      });

      testWidgets('a reopened draft shows a failed first send in its own '
          'selection and Resend creates the chat with it', (tester) async {
        repository.createError = const CloudApiException(
          statusCode: 402,
          message: 'Not enough credits',
        );
        await openDraft(tester);
        await pickAuto(tester);
        await send(tester, 'route it');
        await tester.pump();
        expect(find.text('Not sent'), findsOneWidget);

        Navigator.of(tester.element(find.byType(CloudChatScreen))).pop();
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('open')));
        await tester.pumpAndSettle();

        expect(find.text('Not sent'), findsOneWidget);
        expect(find.text('Auto'), findsOneWidget);
        await expectPickerHeld(tester);
        repository.createError = null;
        await tester.tap(find.text('Resend'));
        await tester.pump();
        await tester.pump();

        final [first, resent] = repository.createCalls;
        expect(resent.externalId, first.externalId);
        expect(repository.autoModelCreates, hasLength(2));
        expect(list.chatById(resent.externalId)?.modelAuto, isTrue);
        expect(repository.postCalls.single.text, 'route it');
        expect(find.text('Auto'), findsOneWidget);
      });

      // A send the server refused goes out again as a new send in the
      // selection the chip shows now.
      for (final v2 in [false, true]) {
        final protocol = v2 ? 'v2' : 'v1';

        void refuseNextSend() {
          const refused = CloudSendError(
            kind: CloudSendErrorKind.definitive,
            status: 402,
            message: 'You are out of credits.',
          );
          if (v2) {
            repository.conversationSendError = refused;
          } else {
            repository.postError = refused;
          }
        }

        // Each send as (id, model, replay) for either protocol.
        List<(String, String?, bool)> sends() => v2
            ? [
                for (final s in repository.conversationSends)
                  (s.clientRequestId, s.modelDefinitionId, s.retryUncertain),
              ]
            : [for (final p in repository.postCalls) (p.id, p.model, p.replay)];

        testWidgets('$protocol Resend of a refused Auto send uses the model '
            'picked since, under a new id', (tester) async {
          repository.workspaces = [
            sampleWorkspace(chats: [copyChat(sampleChat(), modelAuto: true)]),
          ];
          if (v2) repository.conversation = v2Snapshot();
          refuseNextSend();
          await openChat(tester);
          await send(tester, 'try again later');
          await tester.pump();
          expect(find.text('Resend'), findsOneWidget);

          (await startChoice(tester, auto: false)).complete();
          await tester.pump();
          await tester.pump();
          await tester.tap(find.text('Resend'));
          await tester.pump();
          await tester.pump();

          final [(firstId, firstModel, _), (id, model, replay)] = sends();
          expect(firstModel, 'gpt-5.6-luna');
          expect(model, 'claude-opus-5');
          expect(id, isNot(firstId));
          expect(replay, isFalse);
        });

        testWidgets('$protocol Resend of an interrupted Auto send replays it, '
            'and the chip shows Auto until it lands', (tester) async {
          repository.workspaces = [
            sampleWorkspace(chats: [copyChat(sampleChat(), modelAuto: true)]),
          ];
          final post = Completer<void>();
          addTearDown(() {
            if (!post.isCompleted) post.complete();
          });
          if (v2) {
            repository.conversation = v2Snapshot();
            repository.conversationSendCompleter = post;
          } else {
            repository.postCompleter = post;
          }
          await openChat(tester);
          await send(tester, 'did it land?');

          // The app stops before the server answers, and another device
          // saves a model for the chat meanwhile.
          Navigator.of(tester.element(find.byType(CloudChatScreen))).pop();
          await tester.pump();
          await tester.pump(const Duration(seconds: 1));
          chat.close();
          await list.setModel('chat-1', 'claude-opus-5');
          repository
            ..postCompleter = null
            ..conversationSendCompleter = null;
          await tester.tap(find.byKey(const ValueKey('open')));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          await tester.pump();

          expect(find.text('Resend'), findsOneWidget);
          expect(find.text('Auto'), findsOneWidget);
          await expectPickerHeld(tester);
          await tester.tap(find.text('Resend'));
          await tester.pump();
          await tester.pump();

          final [(firstId, _, _), (id, model, replay)] = sends();
          expect(id, firstId);
          expect(model, 'gpt-5.6-luna');
          expect(replay, isTrue);
          expect(find.text('Auto'), findsNothing);

          // The first post answers late, after its chat was closed, and the
          // replay's follow-up load runs.
          post.complete();
          await tester.pump(const Duration(seconds: 2));
        });

        testWidgets('$protocol an interrupted send in a model the catalog '
            'no longer lists keeps that model on the chip and in Resend', (
          tester,
        ) async {
          repository.workspaces = [
            sampleWorkspace(chats: [sampleChat(model: 'gpt-4.1-retired')]),
          ];
          final post = Completer<void>();
          addTearDown(() {
            if (!post.isCompleted) post.complete();
          });
          if (v2) {
            repository.conversation = v2Snapshot();
            repository.conversationSendCompleter = post;
          } else {
            repository.postCompleter = post;
          }
          await openChat(tester);
          await send(tester, 'did it land?');

          // Another device saves a listed model while the send is unknown.
          Navigator.of(tester.element(find.byType(CloudChatScreen))).pop();
          await tester.pump();
          await tester.pump(const Duration(seconds: 1));
          chat.close();
          await list.setModel('chat-1', 'claude-opus-5');
          repository
            ..postCompleter = null
            ..conversationSendCompleter = null;
          await tester.tap(find.byKey(const ValueKey('open')));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          await tester.pump();

          expect(find.text('Resend'), findsOneWidget);
          expect(find.text('Model no longer available'), findsOneWidget);
          expect(find.text('Opus 5'), findsNothing);
          await expectPickerHeld(tester);
          await tester.tap(find.text('Resend'));
          await tester.pump();
          await tester.pump();

          final [(firstId, firstModel, _), (id, model, replay)] = sends();
          expect(firstModel, 'gpt-4.1-retired');
          expect((id, model, replay), (firstId, 'gpt-4.1-retired', true));

          post.complete();
          await tester.pump(const Duration(seconds: 2));
        });

        testWidgets('$protocol continuation Retry of an Auto send uses the '
            'model picked since', (tester) async {
          repository.workspaces = [
            sampleWorkspace(chats: [copyChat(sampleChat(), modelAuto: true)]),
          ];
          if (v2) {
            repository.conversation = v2Snapshot(
              status: 'COMPLETED',
              messages: [v2Message(text: 'Earlier prompt')],
            );
          } else {
            repository.bootstraps['chat-1'] = conversation(
              terminal: const CloudTerminalSession(
                status: 'completed',
                sourceAgentSessionId: 'session-1',
              ),
            );
          }
          repository.continueError = StateError('offline');
          await openChat(tester);
          await send(tester, 'continue when available');
          await tester.pump();
          await tester.pump();
          expect(
            find.byKey(const ValueKey('cloud-send-error')),
            findsOneWidget,
          );
          final failedId = chat.failedSends.keys.single;

          (await startChoice(tester, auto: false)).complete();
          await tester.pump();
          await tester.pump();
          repository.continueError = null;
          repository.bootstraps['chat-1'] = conversation();
          await tester.tap(
            find.byKey(const ValueKey('cloud-send-error-retry')),
          );
          await tester.pump();
          await tester.pump();
          await tester.pump();

          final [(id, model, replay)] = sends();
          expect(model, 'claude-opus-5');
          expect(id, isNot(failedId));
          expect(replay, isFalse);
        });
      }

      testWidgets('an answered chat with no harness binding stays unlocked', (
        tester,
      ) async {
        // The curated row harness is display metadata, never a chat lock.
        repository.catalog = CloudModelCatalog(
          models: sampleCatalog.models,
          modelHarnesses: const {},
          defaultModelId: 'gpt-5.6-luna',
          defaultModelBlocked: false,
        );
        repository.bootstraps['chat-1'] = answeredBootstrap(bound: null);
        await openChat(tester);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();

        expect(find.text('Needs two or more models'), findsNothing);
        await tester.tap(find.byKey(const ValueKey('model-picker-tab-all')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('model-option-claude-opus-5')),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining('This chat is running on'), findsNothing);
        expect(repository.setModelCalls.single.model, 'claude-opus-5');
      });

      testWidgets('a draft in Auto creates the chat in Auto', (tester) async {
        await openDraft(tester);
        await pickAuto(tester);
        expect(find.text('Auto'), findsOneWidget);
        await send(tester, 'route it');
        await tester.pump();

        expect(repository.autoModelCreates, hasLength(1));
        expect(repository.setAutoModelCalls, isEmpty);
      });
    });

    for (final (name, bound) in [
      ('Core binding', 'codex'),
      ('answering model', null),
    ]) {
      testWidgets('an answered chat locks the picker to its harness from the '
          '$name', (tester) async {
        repository.bootstraps['chat-1'] = answeredBootstrap(bound: bound);
        await openChat(tester);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('model-option-claude-opus-5')),
          findsNothing,
          reason: 'the picker opens on the Codex tab',
        );
        await tester.tap(find.byKey(const ValueKey('model-picker-tab-all')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('model-option-claude-opus-5')),
        );
        await tester.pumpAndSettle();
        expect(repository.setModelCalls, isEmpty);
        expect(
          find.text(
            'This chat is running on Codex. Start a new chat to use Claude '
            'models.',
          ),
          findsOneWidget,
        );
      });
    }

    testWidgets('picking a model persists it and hides Fast when unsupported', (
      tester,
    ) async {
      await openChat(tester);
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('model-option-claude-opus-5')),
      );
      await tester.pumpAndSettle();
      expect(repository.setModelCalls.single.model, 'claude-opus-5');
      expect(find.text('Opus 5'), findsOneWidget);
      await openEffortSheet(tester);
      expect(find.byKey(const ValueKey('effort-fast-mode')), findsNothing);
    });

    testWidgets('model switch clamps the thinking level sent to the server', (
      tester,
    ) async {
      await openChat(tester);
      await chooseComposerEffort(tester, 'xhigh');
      expect(find.text('Extra High'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('model-option-claude-opus-5')),
      );
      await tester.pumpAndSettle();
      expect(find.text('High'), findsOneWidget);

      await send(tester, 'use the supported level');

      expect(repository.postCalls.single.thinking, 'high');
    });

    testWidgets(
      'model switch sends the displayed clamp for an untouched stored level',
      (tester) async {
        repository.workspaces = [
          sampleWorkspace(chats: [sampleChat(thinkingLevel: 'xhigh')]),
        ];
        await openChat(tester);
        expect(find.text('Extra High'), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('model-option-claude-opus-5')),
        );
        await tester.pumpAndSettle();
        expect(find.text('High'), findsOneWidget);

        await send(tester, 'send the displayed level');

        expect(repository.postCalls.single.thinking, 'high');
      },
    );

    testWidgets('voice dictation is offered when a recognizer is supplied', (
      tester,
    ) async {
      final speech = FakeSpeechRecognizer();
      await openChat(tester, speech: speech);
      expect(find.byKey(const ValueKey('composer-mic')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('composer-mic')));
      await tester.pump();
      speech.emitFinal('dictated words');
      await tester.pump();
      expect(find.text('dictated words'), findsOneWidget);
    });

    testWidgets('switching away from a mounted Chat tab cancels dictation', (
      tester,
    ) async {
      final speech = FakeSpeechRecognizer();
      var selectedTab = 0;
      await list.load();
      await list.ensureModels();
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
            ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
            ChangeNotifierProvider<ChatDraftStoreHolder>.value(
              value: ChatDraftStoreHolder(store),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            home: StatefulBuilder(
              builder: (context, setState) {
                return Scaffold(
                  body: Column(
                    children: [
                      TextButton(
                        onPressed: () => setState(() => selectedTab = 1),
                        child: const Text('Other tab'),
                      ),
                      Expanded(
                        child: IndexedStack(
                          index: selectedTab,
                          children: [
                            CloudChatScreen.create(
                              speechRecognizer: speech,
                              isActive: selectedTab == 0,
                            ),
                            const Center(child: Text('Other screen')),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-mic')));
      await tester.pump();
      expect(speech.listening, isTrue);

      await tester.tap(find.text('Other tab'));
      await tester.pump();

      expect(find.text('Other screen'), findsOneWidget);
      expect(speech.cancelCalls, 1);
      expect(speech.listening, isFalse);
    });

    group('command suggestions', () {
      Future<void> typeDraft(WidgetTester tester, String text) async {
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.tap(field);
        await tester.enterText(field, text);
        await tester.pumpAndSettle();
      }

      testWidgets('slash shows built-in actions in an existing chat', (
        tester,
      ) async {
        repository.bootstraps['chat-1'] = conversation();
        await openChat(tester);
        await tester.pumpAndSettle();

        await typeDraft(tester, '/');

        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('slash shows built-in actions in a new chat draft', (
        tester,
      ) async {
        await openDraft(tester);

        await typeDraft(tester, '/');

        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });

      const notesRef = {'sourceId': 'src', 'skillName': 'notes'};
      const rows = [
        ComposerCommand(
          name: 'review',
          description: 'Review the diff',
          insertText: '/review ',
        ),
        ComposerCommand(
          name: 'notes',
          description: 'Draft release notes',
          insertText: '/notes ',
          enableRef: notesRef,
        ),
      ];

      String draftText(WidgetTester tester) => tester
          .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
          .controller!
          .text;

      testWidgets('an existing chat enables an available row, then inserts', (
        tester,
      ) async {
        repository.invocableRows = rows;
        await openChat(tester);
        await tester.pumpAndSettle();

        await typeDraft(tester, 'Hi /');
        expect(repository.invocableCalls.single.scope, 'chat');
        expect(repository.invocableCalls.single.model, 'gpt-5.6-luna');
        await typeDraft(tester, 'Hi /no');
        expect(find.text('Available to enable'), findsOneWidget);

        await tester.tap(
          find.byKey(const ValueKey('composer-command-available-notes')),
        );
        await tester.pumpAndSettle();
        expect(repository.capabilityCalls.single.chatId, 'chat-1');
        expect(repository.capabilityCalls.single.selections['skillRefs'], [
          notesRef,
        ]);
        expect(draftText(tester), 'Hi /notes ');
        expect(repository.conversationSends, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('landscape keyboard leaves a tappable command suggestion', (
        tester,
      ) async {
        repository.invocableRows = rows;
        await openChat(tester);
        tester.view.physicalSize = const Size(678, 466) * 3;
        tester.view.devicePixelRatio = 3;
        tester.view.padding = const FakeViewPadding(right: 84 * 3);
        tester.view.viewPadding = const FakeViewPadding(
          right: 84 * 3,
          bottom: 34 * 3,
        );
        tester.view.viewInsets = const FakeViewPadding(bottom: 230 * 3);
        addTearDown(tester.view.reset);
        await tester.pumpAndSettle();
        await typeDraft(tester, 'Hi /no');
        final row = find.byKey(
          const ValueKey('composer-command-available-notes'),
        );
        final menu = find.byKey(const ValueKey('composer-command-list'));
        expect(
          tester.getSize(menu).height,
          greaterThanOrEqualTo(56),
          reason:
              'list=${tester.getRect(menu)} composer=${tester.getRect(find.byKey(const ValueKey("chat-composer")))}',
        );
        await tester.scrollUntilVisible(
          row,
          24,
          scrollable: find.descendant(
            of: menu,
            matching: find.byType(Scrollable),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          row.hitTestable(),
          findsOneWidget,
          reason:
              'row=${row.evaluate().isEmpty ? "missing" : tester.getRect(row)} list=${tester.getRect(menu)} composer=${tester.getRect(find.byKey(const ValueKey("chat-composer")))}',
        );
        await tester.tap(row);
        await tester.pumpAndSettle();
        expect(draftText(tester), 'Hi /notes ');
        expect(
          find.byKey(const ValueKey('composer-send')).hitTestable(),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('a failed enable shows the error and keeps the draft', (
        tester,
      ) async {
        repository
          ..invocableRows = rows
          ..capabilitiesError = const CloudApiException(
            statusCode: 409,
            message: 'conflict',
          );
        await openChat(tester);
        await tester.pumpAndSettle();

        await typeDraft(tester, 'Hi /no');
        await tester.tap(
          find.byKey(const ValueKey('composer-command-available-notes')),
        );
        await tester.pumpAndSettle();
        expect(
          find.text(
            'Could not enable that item. Try again or use the Plugins picker.',
          ),
          findsOneWidget,
        );
        expect(draftText(tester), 'Hi /no');
        expect(tester.takeException(), isNull);
      });

      testWidgets('a draft creates its chat with the enabled row', (
        tester,
      ) async {
        repository.invocableRows = rows;
        await openDraft(tester);

        await typeDraft(tester, '/no');
        expect(repository.invocableCalls.single.scope, 'workspace');
        await tester.tap(
          find.byKey(const ValueKey('composer-command-available-notes')),
        );
        await tester.pumpAndSettle();
        expect(repository.capabilityCalls, isEmpty);
        expect(draftText(tester), '/notes ');

        await typeDraft(tester, '/notes summarize the week');
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(repository.createCalls, hasLength(1));
        expect(repository.createPluginSelections.single, {
          'collectionIds': <Object?>[],
          'skillRefs': [notesRef],
          'pluginRefs': <Object?>[],
        });
        expect(tester.takeException(), isNull);
      });

      testWidgets('a draft keeps its enabled row across an app restart', (
        tester,
      ) async {
        repository.invocableRows = rows;
        await openDraft(tester);
        await typeDraft(tester, '/no');
        await tester.tap(
          find.byKey(const ValueKey('composer-command-available-notes')),
        );
        await tester.pumpAndSettle();
        await typeDraft(tester, '/notes summarize the week');

        // Restart before the first send: the account's draft file is read
        // back, and the composer state in memory starts empty.
        await tester.pumpWidget(const SizedBox());
        final restored = ChatDraftState.fromJson(
          jsonDecode(jsonEncode(store.state.toJson())),
        )!;
        list.dispose();
        list = CloudChatsViewModel(repository: repository);
        store = ChatDraftStateStore(state: restored);
        chat.attachDraftStore(store);
        await openDraft(tester);
        expect(draftText(tester), '/notes summarize the week');

        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(repository.createCalls, hasLength(1));
        expect(repository.createPluginSelections.single, {
          'collectionIds': <Object?>[],
          'skillRefs': [notesRef],
          'pluginRefs': <Object?>[],
        });
        expect(tester.takeException(), isNull);
      });

      testWidgets('clearing a draft offers its enabled row to enable again', (
        tester,
      ) async {
        // The project inventory lists a selected skill as ready to use, with
        // no enable ref; otherwise it is available to enable.
        repository.workspaceInvocableRows = (selections) {
          final refs = selections?['skillRefs'];
          final selected = refs is List && refs.contains(notesRef);
          return [
            ComposerCommand(
              name: 'notes',
              description: 'Draft release notes',
              insertText: '/notes ',
              enableRef: selected ? null : notesRef,
            ),
          ];
        };
        await openDraft(tester);
        await typeDraft(tester, '/no');
        await tester.tap(
          find.byKey(const ValueKey('composer-command-available-notes')),
        );
        await tester.pumpAndSettle();
        // The list loads again with the draft's selection: the skill is in.
        await typeDraft(tester, '/notes /no');
        expect(
          find.byKey(const ValueKey('composer-command-skills-notes')),
          findsOneWidget,
        );

        // Clearing the draft discards its selection, so the row must be
        // enabled again rather than inserted as already selected.
        await typeDraft(tester, '');
        await typeDraft(tester, '/no');
        expect(
          find.byKey(const ValueKey('composer-command-skills-notes')),
          findsNothing,
        );
        await tester.tap(
          find.byKey(const ValueKey('composer-command-available-notes')),
        );
        await tester.pumpAndSettle();
        await typeDraft(tester, '/notes summarize the week');
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(repository.createPluginSelections.single, {
          'collectionIds': <Object?>[],
          'skillRefs': [notesRef],
          'pluginRefs': <Object?>[],
        });
        expect(tester.takeException(), isNull);
      });

      testWidgets('same-name rows from different plugins stay selectable', (
        tester,
      ) async {
        const aRef = {'marketplaceId': 'mk', 'pluginName': 'a'};
        const bRef = {'marketplaceId': 'mk', 'pluginName': 'b'};
        repository.invocableRows = const [
          ComposerCommand(
            name: 'deploy',
            insertText: '/a:deploy ',
            displayName: '/a:deploy',
            enableRef: aRef,
          ),
          ComposerCommand(
            name: 'deploy',
            insertText: '/b:deploy ',
            displayName: '/b:deploy',
            enableRef: bRef,
          ),
        ];
        await openChat(tester);
        await tester.pumpAndSettle();

        await typeDraft(tester, 'Hi /dep');
        expect(find.text('/a:deploy'), findsOneWidget);
        expect(find.text('/b:deploy'), findsOneWidget);
        await tester.tap(
          find.byKey(const ValueKey('composer-command-available-deploy#2')),
        );
        await tester.pumpAndSettle();
        expect(repository.capabilityCalls.single.selections['pluginRefs'], [
          bRef,
        ]);
        expect(draftText(tester), 'Hi /b:deploy ');
        expect(tester.takeException(), isNull);
      });

      testWidgets('host rows use no glyph outside the Canopy glyph catalog', (
        tester,
      ) async {
        repository.invocableRows = rows;
        await openChat(tester);
        await tester.pumpAndSettle();

        await typeDraft(tester, 'Hi /');
        for (final key in [
          'composer-command-skills-review',
          'composer-command-available-notes',
        ]) {
          expect(
            find.descendant(
              of: find.byKey(ValueKey(key)),
              matching: find.byType(ChatIcon),
            ),
            findsNothing,
          );
        }
        expect(tester.takeException(), isNull);
      });

      testWidgets(r'Codex models open $ and hide unsupported thinking', (
        tester,
      ) async {
        repository.catalog = const CloudModelCatalog(
          models: [
            CloudModelOption(
              id: 'gpt-5.6-luna',
              label: 'GPT-5.6 Luna',
              provider: 'openai',
              family: 'gpt',
              familyLabel: 'GPT',
              harness: 'codex',
              fastModeSupported: true,
              thinkingLevels: [],
            ),
          ],
          modelHarnesses: {'gpt-5.6-luna': 'codex'},
          defaultModelId: 'gpt-5.6-luna',
          defaultModelBlocked: false,
        );
        await openChat(tester);
        await tester.pumpAndSettle();

        await typeDraft(tester, r'$');
        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('composer-command-fast')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('composer-command-thinking')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('composer-command-plan')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });
    });

    group('CAN-3924 attachments', () {
      late FakeAttachmentPicker picker;

      setUp(() => picker = FakeAttachmentPicker());

      Finder chips() => find.descendant(
        of: find.byKey(const ValueKey('attachment-strip')),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget.key is ValueKey<String> &&
              (widget.key! as ValueKey<String>).value.startsWith(
                'attachment-chip-',
              ),
        ),
      );

      CanopyComposerAction sendButton(WidgetTester tester) =>
          tester.widget<CanopyComposerAction>(
            find.byKey(const ValueKey('composer-send')),
          );

      Future<void> attach(
        WidgetTester tester,
        String rowKey,
        List<PickedAttachment> files,
      ) async {
        picker.next = AttachmentPickResult(
          AttachmentPickerOutcome.picked,
          files,
        );
        await openComposerActions(tester);
        await tester.tap(find.byKey(ValueKey(rowKey)));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pump();
      }

      // A send starts a live turn whose spinner never settles.
      Future<void> pumpFrames(WidgetTester tester) async {
        for (var i = 0; i < 6; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      // The failure snackbar sits over the composer until it times out.
      Future<void> waitOutSnackBar(WidgetTester tester) async {
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
      }

      Future<void> typeDraft(WidgetTester tester, String text) async {
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          text,
        );
        await tester.pump();
      }

      for (final draft in [false, true]) {
        testWidgets(
          'CAN-5243 v2 ${draft ? 'draft' : 'existing chat'} sends files with the accepted turn',
          (tester) async {
            repository.conversation = v2Snapshot();
            Completer<void>? create;
            if (draft) {
              create = Completer<void>();
              repository.createCompleters['ws-1'] = create;
              await openDraft(tester, picker: picker);
            } else {
              await openChat(tester, picker: picker);
              await tester.pumpAndSettle();
            }
            await attach(tester, 'composer-action-attach-files', [
              FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
            ]);
            await typeDraft(tester, 'Summarize the notes');
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pump();
            if (create != null) {
              repository.conversation = v2Snapshot(
                session: 'session-${repository.createCalls.single.externalId}',
              );
              create.complete();
            }
            await pumpFrames(tester);
            final turn = repository.conversationSends.single;
            expect(turn.content, 'Summarize the notes');
            expect(turn.cloudAttachments.single.filename, 'notes.txt');
            expect(repository.postCalls, isEmpty);
            expect(
              chat.messages
                  .lastWhere((message) => message.role == ChatRole.user)
                  .attachments
                  .single
                  .filename,
              'notes.txt',
            );
            expect(chips(), findsNothing);
            expect(tester.takeException(), isNull);
          },
        );
      }

      testWidgets(
        'an existing chat sends a photo with the message and shows it in '
        'the transcript',
        (tester) async {
          await openChat(tester, picker: picker);
          await tester.pumpAndSettle();

          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);

          expect(repository.uploadCalls.single.chatId, 'chat-1');
          expect(chips(), findsOneWidget);
          await typeDraft(tester, 'What is in this photo?');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          final post = repository.postCalls.single;
          expect(post.text, 'What is in this photo?');
          expect(post.attachments.single.attachmentId, 'cloud-att-1');
          expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
          final user = chat.messages.lastWhere((m) => m.role == ChatRole.user);
          expect(user.attachments.single.filename, 'photo.png');
          expect(find.textContaining('photo.png'), findsWidgets);
          expect(repository.deleteAttachmentCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a text-only first send uploads files picked after creation',
        (tester) async {
          await openDraft(tester, picker: picker);
          await typeDraft(tester, 'Hello');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);
          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          final chatId = repository.createCalls.single.externalId;
          expect(repository.uploadCalls, hasLength(1));
          expect(repository.uploadCalls.single.chatId, chatId);
          streams.last.add(
            CloudSseFrame(
              event: 'message.start',
              data: jsonEncode({
                'sourceKey': 'first-turn',
                'role': 'assistant',
              }),
            ),
          );
          streams.last.add(
            CloudSseFrame(
              event: 'message.finish',
              data: jsonEncode({'sourceKey': 'first-turn'}),
            ),
          );
          await pumpFrames(tester);
          await typeDraft(tester, 'Look at the photo');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);
          expect(repository.postCalls, hasLength(2));
          final outgoing = chat.messages.singleWhere(
            (message) =>
                message.role == ChatRole.user &&
                message.clientRequestId == repository.postCalls.last.id,
          );
          expect(
            repository.postCalls.last.attachments.single.attachmentId,
            'cloud-att-1',
          );
          expect(outgoing.text, 'Look at the photo');
          expect(outgoing.attachments.single.attachmentId, 'cloud-att-1');
          expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a draft stages a file, creates the chat, then sends the file with '
        'its first message',
        (tester) async {
          await openDraft(tester, picker: picker);

          await attach(tester, 'composer-action-attach-files', [
            FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
          ]);

          expect(chips(), findsOneWidget);
          expect(repository.uploadCalls, isEmpty);
          await typeDraft(tester, 'Summarize the notes');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          final created = repository.createCalls.single;
          expect(repository.uploadCalls.single.chatId, created.externalId);
          final post = repository.postCalls.single;
          expect(post.chatId, created.externalId);
          expect(post.text, 'Summarize the notes');
          expect(post.attachments.single.filename, 'notes.txt');
          expect(chat.state?.chatId, created.externalId);
          expect(find.byKey(const ValueKey('cloud-chat-screen')), findsOne);
          expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
          expect(find.byKey(const ValueKey('composer-draft')), findsOneWidget);
          expect(
            tester
                .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
                .controller!
                .text,
            isEmpty,
          );
          expect(
            cloudPendingCreates(store, sampleWorkspace().externalId),
            isEmpty,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a failed upload shows Retry and holds Send until it is retried',
        (tester) async {
          repository.uploadHandler = (_, _) => throw const CloudApiException(
            statusCode: 500,
            message: 'Upload failed',
          );
          await openChat(tester, picker: picker);
          await tester.pumpAndSettle();
          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await typeDraft(tester, 'Look');
          await tester.pumpAndSettle();

          final retry = find.byWidgetPredicate(
            (widget) =>
                widget.key is ValueKey<String> &&
                (widget.key! as ValueKey<String>).value.startsWith(
                  'attachment-retry-',
                ),
          );
          expect(retry, findsOneWidget);
          expect(sendButton(tester).onPressed, isNull);

          await waitOutSnackBar(tester);
          repository.uploadHandler = null;
          await tester.tap(retry);
          await tester.pumpAndSettle();

          expect(retry, findsNothing);
          expect(sendButton(tester).onPressed, isNotNull);
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);
          expect(repository.postCalls.single.attachments, hasLength(1));
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a failed upload removed from the strip frees Send for the text',
        (tester) async {
          repository.uploadHandler = (_, _) => throw const CloudApiException(
            statusCode: 500,
            message: 'Upload failed',
          );
          await openChat(tester, picker: picker);
          await tester.pumpAndSettle();
          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await typeDraft(tester, 'Look');
          await tester.pumpAndSettle();
          expect(sendButton(tester).onPressed, isNull);

          final remove = find.byWidgetPredicate(
            (widget) =>
                widget.key is ValueKey<String> &&
                (widget.key! as ValueKey<String>).value.startsWith(
                  'attachment-remove-',
                ),
          );
          await tester.tap(remove);
          await tester.pumpAndSettle();

          expect(chips(), findsNothing);
          expect(sendButton(tester).onPressed, isNotNull);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a draft whose upload fails binds to the created chat and sends '
        'nothing until the file is retried',
        (tester) async {
          repository.uploadHandler = (_, _) => throw const CloudApiException(
            statusCode: 500,
            message: 'Upload failed',
          );
          await openDraft(tester, picker: picker);
          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await typeDraft(tester, 'Look');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();

          final created = repository.createCalls.single.externalId;
          expect(chat.state?.chatId, created);
          expect(find.byKey(const ValueKey('cloud-chat-screen')), findsOne);
          expect(repository.postCalls, isEmpty);
          expect(find.text('Look'), findsOneWidget);
          expect(sendButton(tester).onPressed, isNull);

          await waitOutSnackBar(tester);
          repository.uploadHandler = null;
          await tester.tap(
            find.byWidgetPredicate(
              (widget) =>
                  widget.key is ValueKey<String> &&
                  (widget.key! as ValueKey<String>).value.startsWith(
                    'attachment-retry-',
                  ),
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          expect(repository.createCalls, hasLength(1));
          final post = repository.postCalls.single;
          expect(post.chatId, created);
          expect(post.text, 'Look');
          expect(post.attachments.single.source, '/cloud/$created');
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a draft whose chat create fails keeps the text and the files and '
        'retries under the same chat id',
        (tester) async {
          repository.createError = const CloudApiException(
            statusCode: 503,
            message: 'Cloud is busy',
          );
          await openDraft(tester, picker: picker);
          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await typeDraft(tester, 'Look');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          expect(find.text('Cloud is busy'), findsOneWidget);
          expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsOne);
          expect(chips(), findsOneWidget);
          expect(find.text('Look'), findsOneWidget);
          expect(repository.uploadCalls, isEmpty);
          expect(repository.postCalls, isEmpty);

          await waitOutSnackBar(tester);
          repository.createError = null;
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          expect(repository.createCalls, hasLength(2));
          expect(
            repository.createCalls.last.externalId,
            repository.createCalls.first.externalId,
          );
          expect(repository.postCalls.single.attachments, hasLength(1));
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'create retries keep separate identities across workspace switches in the composer',
        (tester) async {
          repository.workspaces = [
            sampleWorkspace(),
            sampleWorkspace(id: 'ws-2', name: 'Second project', chats: []),
          ];
          repository.createError = const CloudApiException(
            statusCode: 503,
            message: 'Cloud is busy',
          );
          await openDraft(tester, picker: picker);
          await attach(tester, 'composer-action-attach-files', [
            FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
          ]);
          await typeDraft(tester, 'First project notes');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);
          final firstId = repository.createCalls.single.externalId;
          await waitOutSnackBar(tester);
          await tester.tap(
            find.byKey(const ValueKey('cloud-new-chat-project')),
          );
          await tester.pumpAndSettle();
          await tester.tap(
            find.byKey(const ValueKey('cloud-project-option-ws-2')),
          );
          await tester.pumpAndSettle();
          await typeDraft(tester, 'Second project notes');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);
          expect(repository.createCalls.last.workspaceId, 'ws-2');
          expect(repository.createCalls.last.externalId, isNot(firstId));
          expect(repository.postCalls, isEmpty);
          expect(chips(), findsOneWidget);
          await waitOutSnackBar(tester);
          await tester.tap(
            find.byKey(const ValueKey('cloud-new-chat-project')),
          );
          await tester.pumpAndSettle();
          await tester.tap(
            find.byKey(const ValueKey('cloud-project-option-ws-1')),
          );
          await tester.pumpAndSettle();
          expect(find.text('First project notes'), findsOneWidget);
          repository.createError = null;
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);
          expect(repository.createCalls.last.externalId, firstId);
          expect(repository.uploadCalls.single.chatId, firstId);
          expect(repository.postCalls.single.text, 'First project notes');
          expect(
            repository.postCalls.single.attachments.single.filename,
            'notes.txt',
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'removing the last attachment after a failed create retains the chat id',
        (tester) async {
          repository.createError = const CloudApiException(
            statusCode: 503,
            message: 'Cloud is busy',
          );
          await openDraft(tester, picker: picker);
          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await typeDraft(tester, 'Look');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          expect(find.text('Cloud is busy'), findsOneWidget);
          expect(find.byKey(const ValueKey('cloud-new-chat-screen')), findsOne);
          expect(chips(), findsOneWidget);
          expect(find.text('Look'), findsOneWidget);
          expect(repository.uploadCalls, isEmpty);
          expect(repository.postCalls, isEmpty);

          await waitOutSnackBar(tester);
          await tester.tap(
            find.byWidgetPredicate(
              (widget) =>
                  widget.key is ValueKey<String> &&
                  (widget.key! as ValueKey<String>).value.startsWith(
                    'attachment-remove-',
                  ),
            ),
          );
          await tester.pumpAndSettle();
          expect(chips(), findsNothing);
          repository.createError = null;
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          expect(repository.createCalls, hasLength(2));
          expect(
            repository.createCalls.last.externalId,
            repository.createCalls.first.externalId,
          );
          expect(repository.postCalls.single.attachments, isEmpty);
          expect(repository.postCalls.single.text, 'Look');
          expect(
            repository.postCalls.single.chatId,
            repository.createCalls.first.externalId,
          );
          expect(repository.uploadCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a refused send keeps its text and photo on a Not sent row that '
        'resends both',
        (tester) async {
          repository.postError = const CloudSendError(
            kind: CloudSendErrorKind.definitive,
            status: 400,
            message: 'Message refused',
          );
          await openChat(tester, picker: picker);
          await tester.pumpAndSettle();
          await attach(tester, 'composer-action-attach-library', [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await typeDraft(tester, 'Look');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await pumpFrames(tester);

          final failed = chat.messages.lastWhere(
            (m) => m.role == ChatRole.user,
          );
          expect(failed.delivery, ChatDelivery.notSent);
          expect(failed.text, 'Look');
          expect(failed.attachments.single.filename, 'photo.png');
          expect(find.text('Resend'), findsOneWidget);

          await tester.tap(find.text('Resend'));
          await pumpFrames(tester);

          expect(repository.postCalls, hasLength(2));
          expect(repository.postCalls.last.text, 'Look');
          expect(
            repository.postCalls.last.attachments.single.attachmentId,
            'cloud-att-1',
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'eight attachments disable the attachment rows with the limit',
        (tester) async {
          await openChat(tester, picker: picker);
          await tester.pumpAndSettle();
          await attach(tester, 'composer-action-attach-library', [
            for (var i = 1; i <= 8; i++) FakeAttachmentPicker.file('p$i.png'),
          ]);
          await tester.pumpAndSettle();

          expect(repository.uploadCalls, hasLength(8));
          expect(await composerAttachRowEnabled(tester), isFalse);
          await openComposerActions(tester);
          expect(find.text(kComposerAttachmentLimitReason), findsOneWidget);
          await closeComposerActions(tester);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('attachments without text do not enable Send', (
        tester,
      ) async {
        await openChat(tester, picker: picker);
        await tester.pumpAndSettle();
        await attach(tester, 'composer-action-attach-library', [
          FakeAttachmentPicker.file('photo.png'),
        ]);
        await tester.pumpAndSettle();

        expect(chips(), findsOneWidget);
        expect(sendButton(tester).onPressed, isNull);
        expect(tester.takeException(), isNull);
      });

      testWidgets('leaving the chat deletes uploads that were never sent', (
        tester,
      ) async {
        await openChat(tester, picker: picker);
        await tester.pumpAndSettle();
        await attach(tester, 'composer-action-attach-library', [
          FakeAttachmentPicker.file('photo.png'),
        ]);
        await tester.pumpAndSettle();

        await tester.pageBack();
        await tester.pumpAndSettle();

        expect(repository.deleteAttachmentCalls.single, (
          chatId: 'chat-1',
          attachmentId: 'cloud-att-1',
        ));
        expect(tester.takeException(), isNull);
      });
    });

    group('CAN-3922 action menu', () {
      Future<void> openActions(WidgetTester tester) async {
        await tester.tap(find.byTooltip('Add files and more'));
        await tester.pumpAndSettle();
      }

      testWidgets('CAN-3922 an existing chat offers attachments and Plugins', (
        tester,
      ) async {
        await openChat(tester, picker: FakeAttachmentPicker());
        await tester.pumpAndSettle();

        await openActions(tester);

        expect(find.text('Plugins'), findsOneWidget);
        expect(find.text('Take photo'), findsOneWidget);
        expect(find.text('Plan mode'), findsNothing);
        expect(tester.takeException(), isNull);
      });

      testWidgets('CAN-3922 a new chat draft offers attachments and Plugins', (
        tester,
      ) async {
        await openDraft(tester, picker: FakeAttachmentPicker());

        await openActions(tester);

        expect(find.text('Plugins'), findsOneWidget);
        expect(find.text('Take photo'), findsOneWidget);
        expect(find.text('Plan mode'), findsNothing);
        expect(tester.takeException(), isNull);
      });

      const githubRef = {'marketplaceId': 'market', 'pluginName': 'github'};
      const pluginCatalog = ComposerPluginCatalog(
        items: [
          ComposerPluginItem(
            kind: ComposerPluginKind.plugin,
            ref: githubRef,
            name: 'GitHub',
            description: 'Pull requests and checks',
          ),
          ComposerPluginItem(
            kind: ComposerPluginKind.skill,
            ref: {'sourceId': 'src', 'skillName': 'notes'},
            name: 'Release notes',
          ),
        ],
      );
      const githubSwitch = ValueKey('composer-plugin-plugin:market/github');

      TextEditingController draftOf(WidgetTester tester) => tester
          .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
          .controller!;

      Future<void> openPlugins(WidgetTester tester) async {
        await openActions(tester);
        await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
        await tester.pumpAndSettle();
      }

      Future<void> closeSheet(WidgetTester tester) async {
        Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
        await tester.pumpAndSettle();
      }

      bool githubOn(WidgetTester tester) =>
          tester.widget<SwitchListTile>(find.byKey(githubSwitch)).value;

      testWidgets(
        'CAN-3922 an existing chat turns a plugin on through the PUT and '
        'the next / list reloads',
        (tester) async {
          repository
            ..capabilityCatalogValue = pluginCatalog
            ..invocableRows = const [
              ComposerCommand(
                name: 'review',
                description: 'Review the diff',
                insertText: '/review ',
              ),
            ];
          await openChat(tester);
          await tester.pumpAndSettle();
          final field = find.byKey(const ValueKey('composer-draft'));
          await tester.tap(field);
          await tester.enterText(field, 'Hi /');
          await tester.pumpAndSettle();
          expect(repository.invocableCalls, hasLength(1));
          await tester.enterText(field, 'Hi');
          await tester.pumpAndSettle();

          await openPlugins(tester);
          expect(repository.capabilityCatalogCalls, ['ws-1']);
          expect(githubOn(tester), isFalse);
          await tester.tap(find.byKey(githubSwitch));
          await tester.pumpAndSettle();
          expect(repository.capabilityCalls.single.chatId, 'chat-1');
          expect(repository.capabilityCalls.single.selections, {
            'collectionIds': <Object?>[],
            'skillRefs': <Object?>[],
            'pluginRefs': [githubRef],
          });
          expect(githubOn(tester), isTrue);
          await closeSheet(tester);
          expect(draftOf(tester).text, 'Hi');

          await openActions(tester);
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('composer-action-plugins')),
              matching: find.text('1'),
            ),
            findsOneWidget,
          );
          await closeSheet(tester);

          await tester.tap(field);
          await tester.enterText(field, 'Hi /');
          await tester.pumpAndSettle();
          expect(repository.invocableCalls, hasLength(2));
          expect(repository.conversationSends, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      // The cloud catalog marks each plugin with the harnesses it can run,
      // as the web picker reads it.
      final providerCatalog = ComposerPluginCatalog.fromJson({
        'plugins': [
          for (final (name, claude, codex) in [
            ('codex-tools', false, true),
            ('claude-tools', true, false),
          ])
            {
              'marketplaceId': 'market',
              'pluginName': name,
              'name': name,
              'claudeSupported': claude,
              'codexSupported': codex,
            },
          {'marketplaceId': 'market', 'pluginName': 'legacy', 'name': 'legacy'},
        ],
      });
      Finder providerSwitch(String name) =>
          find.byKey(ValueKey('composer-plugin-plugin:market/$name'));
      bool providerSwitchEnabled(WidgetTester tester, String name) =>
          tester.widget<SwitchListTile>(providerSwitch(name)).onChanged != null;

      testWidgets(
        'CAN-3922 a Codex chat turns on only plugins its harness supports',
        (tester) async {
          repository.capabilityCatalogValue = providerCatalog;
          await openChat(tester);
          await tester.pumpAndSettle();
          await openPlugins(tester);

          expect(providerSwitchEnabled(tester, 'claude-tools'), isFalse);
          expect(
            find.descendant(
              of: providerSwitch('claude-tools'),
              matching: find.text('Unsupported by this provider'),
            ),
            findsOneWidget,
          );
          expect(providerSwitchEnabled(tester, 'codex-tools'), isTrue);
          expect(providerSwitchEnabled(tester, 'legacy'), isTrue);
          await tester.tap(providerSwitch('claude-tools'));
          await tester.pumpAndSettle();
          expect(repository.capabilityCalls, isEmpty);

          await tester.tap(providerSwitch('codex-tools'));
          await tester.pumpAndSettle();
          expect(repository.capabilityCalls.single.selections['pluginRefs'], [
            {'marketplaceId': 'market', 'pluginName': 'codex-tools'},
          ]);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 a draft on a Claude model turns on only plugins Claude '
        'supports',
        (tester) async {
          repository.capabilityCatalogValue = providerCatalog;
          await openDraft(tester);
          await tester.tap(find.byKey(const ValueKey('composer-model')));
          await tester.pumpAndSettle();
          await tester.tap(
            find.byKey(const ValueKey('model-option-claude-opus-5')),
          );
          await tester.pumpAndSettle();
          await openPlugins(tester);

          expect(providerSwitchEnabled(tester, 'codex-tools'), isFalse);
          expect(providerSwitchEnabled(tester, 'claude-tools'), isTrue);
          expect(providerSwitchEnabled(tester, 'legacy'), isTrue);
          await tester.tap(providerSwitch('codex-tools'));
          await tester.pumpAndSettle();
          expect(
            tester.widget<SwitchListTile>(providerSwitch('codex-tools')).value,
            isFalse,
          );
          expect(tester.takeException(), isNull);
        },
      );

      for (final pruned in [false, true]) {
        testWidgets(
          'CAN-3922 a ${pruned ? 'pruned' : 'failed'} write turns the row '
          'back off with an error and keeps the draft',
          (tester) async {
            repository.capabilityCatalogValue = pluginCatalog;
            if (pruned) {
              repository.capabilitiesAnswer = (_) =>
                  const CloudCapabilityWriteResult(
                    selections: {
                      'collectionIds': <Object?>[],
                      'skillRefs': <Object?>[],
                      'pluginRefs': <Object?>[],
                    },
                  );
            } else {
              repository.capabilitiesError = const CloudApiException(
                statusCode: 409,
                message: 'conflict',
              );
            }
            await openChat(tester);
            await tester.pumpAndSettle();
            await tester.enterText(
              find.byKey(const ValueKey('composer-draft')),
              'Keep me',
            );
            await tester.pump();

            await openPlugins(tester);
            await tester.tap(find.byKey(githubSwitch));
            await tester.pumpAndSettle();

            expect(githubOn(tester), isFalse);
            expect(
              find.text('Could not change GitHub. Try again.'),
              findsOneWidget,
            );
            // The error replaces the row's label; its detail stays.
            expect(
              find.descendant(
                of: find.byWidget(
                  tester
                      .widget<SwitchListTile>(find.byKey(githubSwitch))
                      .title!,
                ),
                matching: find.text('Could not change GitHub. Try again.'),
              ),
              findsOneWidget,
            );
            for (final (text, count) in [
              ('GitHub', 0),
              ('Pull requests and checks', 1),
            ]) {
              expect(
                find.descendant(
                  of: find.byKey(githubSwitch),
                  matching: find.text(text),
                ),
                findsNWidgets(count),
              );
            }
            await closeSheet(tester);
            expect(draftOf(tester).text, 'Keep me');
            expect(tester.takeException(), isNull);
          },
        );
      }

      testWidgets(
        'CAN-3922 an MCP server the chat cannot use turns back off with an '
        'error on each attempt, and turns on once the chat can use it',
        (tester) async {
          const linearRef = {'serverId': 'linear', 'configId': 'default'};
          var usable = false;
          repository
            ..capabilityCatalogValue = const ComposerPluginCatalog(
              items: [
                ComposerPluginItem(
                  kind: ComposerPluginKind.mcpServer,
                  ref: linearRef,
                  name: 'Linear',
                ),
              ],
            )
            // Saved, but held back until the user reconnects it.
            ..capabilitiesAnswer = (selections) => CloudCapabilityWriteResult(
              selections: selections,
              unusableRefs: usable ? const [] : const [linearRef],
            );
          await openChat(tester);
          await tester.pumpAndSettle();

          await openPlugins(tester);
          const linearSwitch = ValueKey(
            'composer-plugin-mcpServer:linear/default',
          );
          bool linearOn() =>
              tester.widget<SwitchListTile>(find.byKey(linearSwitch)).value;
          final error = find.text('Could not change Linear. Try again.');
          for (final attempt in [1, 2]) {
            await tester.tap(find.byKey(linearSwitch));
            await tester.pumpAndSettle();

            expect(repository.capabilityCalls, hasLength(attempt));
            expect(linearOn(), isFalse, reason: 'attempt $attempt');
            expect(error, findsOneWidget, reason: 'attempt $attempt');
            expect(
              find.descendant(
                of: find.byWidget(
                  tester
                      .widget<SwitchListTile>(find.byKey(linearSwitch))
                      .title!,
                ),
                matching: error,
              ),
              findsOneWidget,
              reason: 'attempt $attempt',
            );
            expect(
              find.descendant(
                of: find.byKey(linearSwitch),
                matching: find.text('Linear'),
              ),
              findsNothing,
              reason: 'attempt $attempt',
            );
          }

          usable = true;
          await tester.tap(find.byKey(linearSwitch));
          await tester.pumpAndSettle();
          expect(repository.capabilityCalls, hasLength(3));
          expect(linearOn(), isTrue);
          expect(error, findsNothing);
          expect(
            find.descendant(
              of: find.byKey(linearSwitch),
              matching: find.text('Linear'),
            ),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 a sheet reopened while a plugin saves keeps that plugin '
        'when the next one turns on',
        (tester) async {
          repository.capabilityCatalogValue = pluginCatalog;
          // The server keeps each accepted write as the chat's selection.
          repository.capabilitiesAnswer = (selections) {
            repository.workspaces = [
              sampleWorkspace(
                chats: [
                  CloudChatSummary(
                    externalId: 'chat-1',
                    title: 'Plan the mobile launch',
                    taskChatExternalId: null,
                    modelDefinitionId: 'gpt-5.6-luna',
                    thinkingLevel: 'medium',
                    coreAgentSessionId: 'session-1',
                    createdAtMs: 1789890000000,
                    capabilitySelections: selections,
                  ),
                ],
              ),
            ];
            return CloudCapabilityWriteResult(selections: selections);
          };
          final gate = Completer<void>();
          repository.capabilitiesGate = gate;
          await openChat(tester);
          await tester.pumpAndSettle();
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Keep me',
          );
          await tester.pump();

          await openPlugins(tester);
          await tester.tap(find.byKey(githubSwitch));
          await tester.pump();
          expect(githubOn(tester), isTrue);
          await closeSheet(tester);

          await openActions(tester);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 500));
          // The reopened sheet waits for the save instead of showing the
          // selection from before it.
          expect(
            find.byKey(const ValueKey('composer-plugins-sheet')),
            findsOne,
          );
          expect(find.byKey(githubSwitch), findsNothing);
          gate.complete();
          await tester.pumpAndSettle();
          expect(githubOn(tester), isTrue);

          await tester.tap(
            find.byKey(const ValueKey('composer-plugin-skill:src/notes')),
          );
          await tester.pumpAndSettle();
          expect(repository.capabilityCalls, hasLength(2));
          expect(repository.capabilityCalls.last.selections, {
            'collectionIds': <Object?>[],
            'skillRefs': [
              {'sourceId': 'src', 'skillName': 'notes'},
            ],
            'pluginRefs': [githubRef],
          });
          expect(githubOn(tester), isTrue);
          await closeSheet(tester);
          expect(draftOf(tester).text, 'Keep me');
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 a draft chooses plugins before typing and creates the chat '
        'with them over the project defaults',
        (tester) async {
          repository
            ..capabilityCatalogValue = pluginCatalog
            ..defaultPluginSelections = {
              'collectionIds': ['defaults'],
              'skillRefs': <Object?>[],
              'pluginRefs': <Object?>[],
            };
          await openDraft(tester);

          await openPlugins(tester);
          // The project defaults load before the first change.
          expect(
            repository.invocableCalls.map((call) => call.scope),
            contains('workspace'),
          );
          await tester.tap(find.byKey(githubSwitch));
          await tester.pumpAndSettle();
          expect(githubOn(tester), isTrue);
          expect(repository.capabilityCalls, isEmpty);
          await closeSheet(tester);

          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Ship the launch notes',
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          expect(repository.createCalls, hasLength(1));
          expect(repository.createPluginSelections.single, {
            'collectionIds': ['defaults'],
            'skillRefs': <Object?>[],
            'pluginRefs': [githubRef],
          });
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('CAN-3922 /plugins in a draft opens the plugins sheet', (
        tester,
      ) async {
        repository.capabilityCatalogValue = pluginCatalog;
        await openDraft(tester);
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.tap(field);
        await tester.enterText(field, '/plugins');
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-command-plugins')),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('composer-plugins-sheet')),
          findsOneWidget,
        );
        expect(draftOf(tester).text, '');
        expect(repository.createCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'CAN-3922 /plugins keeps the plugins a draft chose before typing, '
        'and the first send creates the chat with them',
        (tester) async {
          repository
            ..capabilityCatalogValue = pluginCatalog
            ..defaultPluginSelections = {
              'collectionIds': ['defaults'],
              'skillRefs': <Object?>[],
              'pluginRefs': <Object?>[],
            };
          await openDraft(tester);
          await openPlugins(tester);
          await tester.tap(find.byKey(githubSwitch));
          await tester.pumpAndSettle();
          expect(githubOn(tester), isTrue);
          await closeSheet(tester);

          final field = find.byKey(const ValueKey('composer-draft'));
          await tester.tap(field);
          await tester.enterText(field, '/plugins');
          await tester.pumpAndSettle();
          await tester.tap(
            find.byKey(const ValueKey('composer-command-plugins')),
          );
          await tester.pumpAndSettle();
          expect(draftOf(tester).text, '');
          expect(githubOn(tester), isTrue);
          await closeSheet(tester);

          await tester.enterText(field, 'Ship the launch notes');
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          expect(repository.createPluginSelections.single, {
            'collectionIds': ['defaults'],
            'skillRefs': <Object?>[],
            'pluginRefs': [githubRef],
          });
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('CAN-3922 typing /plugins offers the Plugins action', (
        tester,
      ) async {
        await openChat(tester);
        await tester.pumpAndSettle();
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.tap(field);
        await tester.enterText(field, '/plu');
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('composer-command-plugins')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    });
  });
}
