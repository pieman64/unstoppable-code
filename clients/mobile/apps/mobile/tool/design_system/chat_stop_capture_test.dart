// Running chat stop state: COMPOSER_STAGE=before/after flutter test tool/design_system/chat_stop_capture_test.dart --update-goldens
// Deterministic repository and bundled fonts, no network. Both color modes.
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import '../../test/support/fake_remote_control_repository.dart';
import '../../test/support/reduced_motion.dart';

bool captureDark = false;
void main() {
  group('RemoteChatScreen composer controls', () {
    // Streaming fixtures put always-on spinners on screen; reduce-motion
    // keeps every pumpAndSettle in this suite able to settle.
    useReducedMotion();

    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget host(RemoteControlViewModel viewModel, Widget screen) =>
        MultiProvider(
          providers: [
            // `create` (not `.value`) so the widget tree owns disposal: when
            // the tree is torn down the view model is disposed, cancelling
            // its hydration watchdog timers before the pending-timer
            // invariant runs.
            ChangeNotifierProvider<RemoteControlViewModel>(
              create: (_) => viewModel,
            ),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            theme: captureDark ? AppTheme.dark : AppTheme.light,
            darkTheme: AppTheme.dark,
            home: screen,
          ),
        );

    const models = [
      ModelOption(
        id: 'claude-sonnet',
        label: 'Claude Sonnet 4.5',
        provider: 'claude',
        vendor: 'anthropic',
        kind: 'model',
        available: true,
      ),
      ModelOption(
        id: 'gpt-5-codex',
        label: 'GPT-5 Codex',
        provider: 'codex',
        vendor: 'openai',
        kind: 'model',
        available: true,
      ),
      ModelOption(
        id: 'kimi-k3',
        label: 'Kimi K3',
        provider: 'codex',
        vendor: 'moonshot',
        kind: 'model',
        available: true,
      ),
      ModelOption(
        id: 'minimax-m3',
        label: 'MiniMax M3',
        provider: 'codex',
        vendor: 'minimax',
        kind: 'model',
        available: true,
      ),
      ModelOption(
        id: 'premium-model',
        label: 'Premium Model',
        provider: 'claude',
        vendor: 'anthropic',
        kind: 'model',
        available: true,
        extraChargeOnly: true,
        extraChargeMessage: 'Uses AI Credits.',
      ),
    ];

    RemoteSessionSnapshot worktreeSnapshot({
      required String providerType,
      bool streaming = false,
      bool working = false,
      List<ModelOption>? availableModels,
      String? model,
      String? modelLabel,
      String thinkingLevel = 'off',
    }) => RemoteSessionSnapshot(
      workspaces: const [],
      worktrees: [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
          isStreaming: working,
        ),
      ],
      standaloneChats: const [],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat A',
          active: true,
          providerType: providerType,
          model:
              model ??
              (providerType == 'codex' ? 'gpt-5-codex' : 'claude-sonnet'),
          modelLabel:
              modelLabel ??
              (providerType == 'codex' ? 'GPT-5 Codex' : 'Claude Sonnet 4.5'),
          planMode: false,
          thinkingLevel: thinkingLevel,
          fastMode: false,
          providerAvailability: const ProviderAvailability(
            claude: true,
            codex: true,
          ),
          availableModels: availableModels ?? models,
          // Wire-faithful: the desktop sets this whenever it sends the array,
          // so a non-empty catalog always implies `true`. Derived rather than
          // hardcoded because callers can pass an empty list to simulate the
          // desktop omitting the field. `fromJson` derives it as
          // `json['availableModels'] is List`, and `_projectedCatalogState`
          // re-derives it from non-emptiness.
          modelCatalogProjected: (availableModels ?? models).isNotEmpty,
        ),
      ],
      chatMessages: [
        RemoteChatMessage(
          messageId: 'm-1',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: streaming
              ? ChatMessageStatus.streaming
              : ChatMessageStatus.complete,
          text: 'Working on it…',
        ),
      ],
    );

    Future<RemoteControlViewModel> connected(
      WidgetTester tester,
      FakeRemoteControlRepository repository,
    ) async {
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      return vm;
    }

    for (final dark in [false, true]) {
      testWidgets('composer capture $dark', (tester) async {
        captureDark = dark;
        usePhoneViewport(tester);
        final loader = FontLoader('Inter')
          ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
        await loader.load();
        final icons = FontLoader('MaterialIcons')
          ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
        await icons.load();
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'codex');
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        final stage = Platform.environment['COMPOSER_STAGE'] ?? 'after';
        Future<void> capture(String name) => expectLater(
          find.byKey(const ValueKey('chat-composer')),
          matchesGoldenFile(
            '../../../../.playwright/mobile-chat-stop/$name-$stage-${dark ? 'dark' : 'light'}.png',
          ),
        );
        await capture('idle');
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'codex', working: true);
        await tester.runAsync(() => vm.refresh());
        await tester.pumpAndSettle();
        await capture('running-empty');
        await tester.enterText(find.byType(TextField), 'Follow up');
        await tester.pumpAndSettle();
        await capture('running-draft');
      });
    }
  });
}
