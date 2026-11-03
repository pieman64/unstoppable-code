import 'dart:async';
import 'dart:convert';

import 'package:mobile/app/cloud_chat_prompts.dart';
import 'package:mobile/ui/core/chat/chat_prompt_host.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/analytics/app_rating_events.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/conversation_v2_fixtures.dart';
import '../../../support/fake_cloud_chat_repository.dart';
import '../../../support/recording_product_analytics.dart';

final class _NoReview implements StoreReviewLauncher {
  @override
  Future<StoreReviewRequestResult> request() async =>
      StoreReviewRequestResult.unavailable;
}

const _prompt = 'Are you enjoying the app?';

CloudCoreMessage _message(
  String id, {
  required String role,
  required String text,
  String? sourceKey,
  String? requestId,
  int createdAtMs = 1789890000000,
}) => CloudCoreMessage(
  id: id,
  role: role,
  text: text,
  sourceKey: sourceKey,
  clientRequestId: requestId,
  cost: const CloudCoreCost(kind: CloudCoreCostKind.zero),
  costBilledViaLlmProxy: false,
  createdAtMs: createdAtMs,
  artifacts: const [],
);

/// A v1 chat whose only turn has already finished.
final _settledV1 = CloudChatBootstrap(
  messages: [
    _message('u1', role: 'USER', text: 'hello agent', requestId: 'r1'),
    _message(
      'a1',
      role: 'ASSISTANT',
      text: 'hello human',
      sourceKey: 'turn-1',
      createdAtMs: 1789890001000,
    ),
  ],
  toolActivity: const [],
);

/// One open cloud chat with a real [SatisfactionPromptController] wired the
/// way production wires it (`buildCloudChatModels`).
final class _Harness {
  _Harness() {
    satisfaction = SatisfactionPromptController(
      store: InMemorySatisfactionPromptStore(),
      analytics: analytics,
      reviewLauncher: _NoReview(),
      isActive: () => true,
      thresholds: () => SatisfactionThresholds.verification,
    );
    list = CloudChatsViewModel(repository: repository);
    chat = CloudChatViewModel(
      repository: repository,
      openStream: (_, {after}) {
        final controller = StreamController<CloudSseFrame>();
        streams.add(controller);
        return controller.stream;
      },
      observeLifecycle: false,
      onSuccessfulTurn: (key) =>
          unawaited(satisfaction.recordSuccessfulTurn(key)),
    );
  }

  final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
  final analytics = RecordingProductAnalytics();
  final streams = <StreamController<CloudSseFrame>>[];
  late final SatisfactionPromptController satisfaction;
  late final CloudChatsViewModel list;
  late final CloudChatViewModel chat;

  Future<void> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(dispose);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          Provider<ChatPromptBuilder>.value(value: buildCloudChatPrompts),
          ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
          ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
          ChangeNotifierProvider<SatisfactionPromptController>.value(
            value: satisfaction,
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
                    builder: (_) => const CloudChatScreen(chatId: 'chat-1'),
                  ),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    await list.load();
    await list.ensureModels();
    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
  }

  /// Makes a prompt due without a live turn, so a test can check which chat
  /// states hold it back.
  Future<void> makePromptDue(WidgetTester tester) async {
    await satisfaction.recordSuccessfulTurn('cloud:seed:turn');
    await tester.pump();
    expect(satisfaction.pendingPrompt, isTrue);
  }

  /// Delivers one v2 `conversation.changed` frame.
  Future<void> changed(
    WidgetTester tester,
    String before,
    String after,
    List<Map<String, dynamic>> changes,
  ) async {
    streams.last.add(
      CloudSseFrame(
        event: 'conversation.changed',
        id: 'opaque/$after',
        data: jsonEncode({
          'protocolVersion': 2,
          'sessionId': 'session-1',
          'previousStateVersion': before,
          'stateVersion': after,
          'changes': changes,
        }),
      ),
    );
    await tester.pump();
  }

  /// Waits past the host's settle delay.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 1600));
    await tester.pumpAndSettle();
  }

  Future<void> dispose() async {
    chat.dispose();
    list.dispose();
    for (final stream in streams) {
      await stream.close();
    }
  }
}

Map<String, dynamic> _reply() =>
    v2Message(id: 'assistant-1', role: 'ASSISTANT', text: 'Done.', seq: 2);

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('a completed v2 turn in an open chat shows the prompt once '
      'idle', (tester) async {
    final h = _Harness();
    h.repository.conversation = v2Snapshot(
      turns: [v2Turn(status: 'RUNNING')],
      messages: [v2Message(id: 'user-r1')],
    );
    await h.open(tester);

    await h.changed(tester, '0', '1', [
      {'type': 'message.upsert', 'message': _reply()},
      {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
    ]);
    await tester.pump();
    expect(find.text(_prompt), findsNothing);

    await h.settle(tester);
    expect(find.text(_prompt), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('satisfaction-prompt-not-now')));
    await tester.pumpAndSettle();
    expect(find.text(_prompt), findsNothing);
    expect(h.analytics.names, [
      AppRatingEvents.promptView,
      AppRatingEvents.promptCancel,
    ]);
    expect(
      h.analytics.events.first.properties['trigger_surface'],
      'cloud_chat',
    );
  });

  testWidgets('a due prompt waits while the v2 turn is still running', (
    tester,
  ) async {
    final h = _Harness();
    h.repository.conversation = v2Snapshot(
      turns: [v2Turn(status: 'RUNNING')],
      messages: [v2Message(id: 'user-r1')],
    );
    await h.open(tester);
    expect(h.chat.turnInProgress, isTrue);
    await h.makePromptDue(tester);

    await tester.pump(const Duration(seconds: 3));
    expect(find.text(_prompt), findsNothing);

    await h.changed(tester, '0', '1', [
      {'type': 'message.upsert', 'message': _reply()},
      {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
    ]);
    await tester.pump();
    await h.settle(tester);
    expect(find.text(_prompt), findsOneWidget);
  });

  testWidgets('a due prompt waits while a send error is shown', (tester) async {
    final h = _Harness();
    h.repository.bootstraps['chat-1'] = _settledV1;
    h.repository.postError = const CloudSendError(
      kind: CloudSendErrorKind.definitive,
      status: 402,
      message: 'You are out of credits.',
    );
    await h.open(tester);
    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'one more thing',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump();
    await tester.pump();
    // An ordinary failure shows on its row, not in a banner (CAN-3556).
    expect(find.text('Not sent'), findsOneWidget);
    await h.makePromptDue(tester);

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text(_prompt), findsNothing);
  });

  testWidgets('a due prompt waits while older history failed to load', (
    tester,
  ) async {
    final h = _Harness();
    h.repository.conversation = v2Snapshot(
      messages: [
        v2Message(id: 'user-r1'),
        v2Message(id: 'assistant-1', role: 'ASSISTANT', text: 'Done.', seq: 2),
      ],
      history: 'older-cursor',
    );
    await h.open(tester);
    await h.chat.loadOlder();
    await tester.pump();
    expect(
      find.byKey(const ValueKey('cloud-older-history-error')),
      findsOneWidget,
    );
    await h.makePromptDue(tester);

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text(_prompt), findsNothing);
  });

  testWidgets('a due prompt waits while a send is not yet accepted', (
    tester,
  ) async {
    final h = _Harness();
    h.repository.bootstraps['chat-1'] = _settledV1;
    final accepted = Completer<void>();
    h.repository.postCompleter = accepted;
    await h.open(tester);
    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'one more thing',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump();
    expect(h.repository.postCalls, hasLength(1));
    expect(h.chat.turnInProgress, isFalse);
    await h.makePromptDue(tester);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text(_prompt), findsNothing);

    accepted.complete();
    await tester.pump();
  });
}
