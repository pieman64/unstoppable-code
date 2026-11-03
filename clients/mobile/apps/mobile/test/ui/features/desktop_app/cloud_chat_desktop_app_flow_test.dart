import 'dart:async';
import 'dart:convert';

import 'package:mobile/app/cloud_chat_prompts.dart';
import 'package:mobile/ui/core/chat/chat_prompt_host.dart';
import 'package:mobile/ui/features/desktop_app/views/desktop_app_prompt_sheet.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/data/services/desktop_app_prompt_store.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/desktop_app/desktop_app_prompt_policy.dart';
import 'package:mobile/services/link_sharer.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/app/cloud_turn_prompts.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
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

final class _NoShare implements LinkSharer {
  @override
  Future<void> share({
    required String text,
    String? subject,
    Rect? origin,
  }) async {}
}

const _desktopPrompt = 'Get the desktop app';
const _satisfactionPrompt = 'Are you enjoying the app?';
const _account = 'production:7';

/// One open cloud chat with both end-of-turn prompts wired the way
/// production wires them (`buildCloudChatModels`). The satisfaction prompt
/// uses its one-turn verification thresholds, so both are due on the first
/// completed turn.
final class _Harness {
  _Harness() {
    satisfaction = SatisfactionPromptController(
      store: InMemorySatisfactionPromptStore(),
      analytics: RecordingProductAnalytics(),
      reviewLauncher: _NoReview(),
      isActive: () => true,
      thresholds: () => SatisfactionThresholds.verification,
    );
    desktopApp = DesktopAppPromptController(
      store: desktopStore,
      isActive: () => true,
      downloadUrl: () => 'https://production.test/download',
      sharer: _NoShare(),
      showPrompt: showDesktopAppPromptSheet,
    )..updateContext(accountScope: _account, pairing: DesktopPairing.none);
    list = CloudChatsViewModel(repository: repository);
    chat = CloudChatViewModel(
      repository: repository,
      openStream: (_, {after}) {
        final controller = StreamController<CloudSseFrame>();
        streams.add(controller);
        return controller.stream;
      },
      observeLifecycle: false,
      onSuccessfulTurn: (key) => unawaited(
        recordCloudChatTurn(
          key,
          desktopApp: desktopApp,
          satisfaction: satisfaction,
        ),
      ),
    );
  }

  final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
  final desktopStore = InMemoryDesktopAppPromptStore();
  final streams = <StreamController<CloudSseFrame>>[];
  late final SatisfactionPromptController satisfaction;
  late final DesktopAppPromptController desktopApp;
  late final CloudChatsViewModel list;
  late final CloudChatViewModel chat;

  Future<void> open(WidgetTester tester, {bool embedded = false}) async {
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
          ChangeNotifierProvider<DesktopAppPromptController>.value(
            value: desktopApp,
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
                    builder: (_) => embedded
                        ? const Scaffold(
                            body: CloudChatScreen(chatId: 'chat-1'),
                          )
                        : const CloudChatScreen(chatId: 'chat-1'),
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

  /// Ends the running first turn with [status].
  Future<void> endFirstTurn(WidgetTester tester, String status) =>
      changed(tester, '0', '1', [
        if (status == 'COMPLETED')
          {
            'type': 'message.upsert',
            'message': v2Message(
              id: 'assistant-1',
              role: 'ASSISTANT',
              text: 'Done.',
              seq: 2,
            ),
          },
        {'type': 'turn.upsert', 'turn': v2Turn(status: status)},
      ]);

  /// Runs a second turn to completion after the first one ended.
  Future<void> completeSecondTurn(WidgetTester tester) async {
    await changed(tester, '1', '2', [
      {
        'type': 'message.upsert',
        'message': v2Message(
          id: 'user-r2',
          request: 'r2',
          turnId: 'turn-2',
          seq: 3,
        ),
      },
      {
        'type': 'turn.upsert',
        'turn': v2Turn(
          id: 'turn-2',
          request: 'r2',
          status: 'RUNNING',
          order: '2',
        ),
      },
    ]);
    await changed(tester, '2', '3', [
      {
        'type': 'message.upsert',
        'message': v2Message(
          id: 'assistant-2',
          request: 'r2',
          role: 'ASSISTANT',
          text: 'Done again.',
          turnId: 'turn-2',
          seq: 4,
        ),
      },
      {
        'type': 'turn.upsert',
        'turn': v2Turn(
          id: 'turn-2',
          request: 'r2',
          status: 'COMPLETED',
          order: '2',
        ),
      },
    ]);
  }

  /// Waits past the hosts' settle delay.
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

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  _Harness running() {
    final h = _Harness();
    h.repository.conversation = v2Snapshot(
      turns: [v2Turn(status: 'RUNNING')],
      messages: [v2Message(id: 'user-r1')],
    );
    return h;
  }

  testWidgets('the first completed turn opens the desktop app prompt once the '
      'reply has settled, and the satisfaction prompt waits', (tester) async {
    final h = running();
    await h.open(tester);
    expect(find.text(_desktopPrompt), findsNothing);

    await h.endFirstTurn(tester, 'COMPLETED');
    await tester.pump();
    expect(find.text(_desktopPrompt), findsNothing);

    await h.settle(tester);
    expect(find.text(_desktopPrompt), findsOneWidget);
    expect(find.text(_satisfactionPrompt), findsNothing);

    await tester.tap(find.byKey(const ValueKey('desktop-app-prompt-not-now')));
    await h.settle(tester);
    expect(find.text(_desktopPrompt), findsNothing);
    // The turn the desktop prompt took never raises the other one.
    expect(find.text(_satisfactionPrompt), findsNothing);
    expect(await h.desktopStore.isDismissed(_account), isTrue);

    // The next completed turn may raise the satisfaction prompt, and the
    // closed desktop prompt stays closed.
    await h.completeSecondTurn(tester);
    await h.settle(tester);
    expect(find.text(_satisfactionPrompt), findsOneWidget);
    expect(find.text(_desktopPrompt), findsNothing);
  });

  for (final status in ['FAILED', 'CANCELLED']) {
    testWidgets('a ${status.toLowerCase()} first turn opens nothing; the next '
        'completed turn does', (tester) async {
      final h = running();
      await h.open(tester);

      await h.endFirstTurn(tester, status);
      await h.settle(tester);
      expect(find.text(_desktopPrompt), findsNothing);

      await h.completeSecondTurn(tester);
      await h.settle(tester);
      expect(find.text(_desktopPrompt), findsOneWidget);
    });
  }

  for (final embedded in [false, true]) {
    testWidgets('waits for the keyboard to close, embedded: $embedded', (
      tester,
    ) async {
      final h = running();
      await h.open(tester, embedded: embedded);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump();

      await h.endFirstTurn(tester, 'COMPLETED');
      await h.settle(tester);
      expect(find.text(_desktopPrompt), findsNothing);

      tester.view.resetViewInsets();
      await tester.pump();
      await h.settle(tester);
      expect(find.text(_desktopPrompt), findsOneWidget);
    });
  }

  testWidgets('an account that closed it before only gets the satisfaction '
      'prompt', (tester) async {
    final h = running();
    await h.desktopStore.markDismissed(_account);
    await h.open(tester);

    await h.endFirstTurn(tester, 'COMPLETED');
    await h.settle(tester);
    expect(find.text(_desktopPrompt), findsNothing);
    expect(find.text(_satisfactionPrompt), findsOneWidget);
  });

  testWidgets('a paired desktop never sees it', (tester) async {
    final h = running();
    h.desktopApp.updateContext(
      accountScope: _account,
      pairing: DesktopPairing.paired,
    );
    await h.open(tester);

    await h.endFirstTurn(tester, 'COMPLETED');
    await h.settle(tester);
    expect(find.text(_desktopPrompt), findsNothing);
  });
}
