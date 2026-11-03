import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/services/active_chat_tracker.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/core/design-system/composer/canopy_model_icon.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_row.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import '../../../support/fake_attachment_picker.dart';
import '../../../support/tiny_png.dart';
import '../../../support/chat_tabs_sheet_driver.dart';
import '../../../support/fake_remote_control_repository.dart';
import '../../../support/fake_speech_recognizer.dart';
import '../../../support/composer_driver.dart';
import '../../../support/reduced_motion.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/ui/core/chat/view_models/model_routing_availability_controller.dart';

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

    Widget host(
      RemoteControlViewModel viewModel,
      Widget screen, {
      ModelRoutingAvailabilityController? routing,
    }) => MultiProvider(
      providers: [
        if (routing != null)
          ChangeNotifierProvider<ModelRoutingAvailabilityController>.value(
            value: routing,
          ),
        // `create` (not `.value`) so the widget tree owns disposal: when
        // the tree is torn down the view model is disposed, cancelling
        // its hydration watchdog timers before the pending-timer
        // invariant runs.
        ChangeNotifierProvider<RemoteControlViewModel>(
          create: (_) => viewModel,
        ),
        ChangeNotifierProvider<TurnFeedbackController>(
          create: (_) =>
              TurnFeedbackController(repository: MockTurnFeedbackRepository()),
        ),
      ],
      child: MaterialApp(
        navigatorObservers: [appRouteObserver],
        theme: AppTheme.light,
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

    /// An Ollama row. The desktop projection deliberately leaves
    /// `OLLAMA_MODELS` unfiltered by the org model policy (local inference
    /// never leaves the member's machine), so it must stay selectable even
    /// alongside a policy-filtered Claude/Codex catalog.
    const ollamaModel = ModelOption(
      id: 'ollama:llama3',
      label: 'Llama 3',
      provider: 'ollama',
      kind: 'model',
      available: true,
    );

    RemoteSessionSnapshot worktreeSnapshot({
      required String providerType,
      bool streaming = false,
      bool working = false,
      List<ModelOption>? availableModels,
      String? model,
      String? modelLabel,
      String thinkingLevel = 'off',
      bool planMode = false,
      bool fastMode = false,
      bool withChat = true,
      ProviderAvailability? providerAvailability,
      bool omitProviderAvailability = false,
      bool? catalogProjected,
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
        if (withChat)
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
            turnActive: working,
            providerType: providerType,
            model:
                model ??
                (providerType == 'codex' ? 'gpt-5-codex' : 'claude-sonnet'),
            modelLabel:
                modelLabel ??
                (providerType == 'codex' ? 'GPT-5 Codex' : 'Claude Sonnet 4.5'),
            planMode: planMode,
            thinkingLevel: thinkingLevel,
            fastMode: fastMode,
            providerAvailability: omitProviderAvailability
                ? null
                : (providerAvailability ??
                      const ProviderAvailability(claude: true, codex: true)),
            availableModels: availableModels ?? models,
            // Wire-faithful: the desktop sets this whenever it sends the array,
            // so a non-empty catalog always implies `true`. Derived rather than
            // hardcoded because callers can pass an empty list to simulate the
            // desktop omitting the field. `fromJson` derives it as
            // `json['availableModels'] is List`, and `_projectedCatalogState`
            // re-derives it from non-emptiness.
            modelCatalogProjected:
                catalogProjected ?? (availableModels ?? models).isNotEmpty,
          ),
      ],
      chatMessages: [
        if (withChat)
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

    testWidgets(
      'send follows trimmed draft and corner follows the action circle',
      (tester) async {
        final controller = TextEditingController();
        addTearDown(controller.dispose);
        var sends = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            home: Scaffold(
              body: ChatInput(
                controller: controller,
                sending: false,
                onSend: () => sends++,
              ),
            ),
          ),
        );
        IconButton sendButton() => tester.widget<IconButton>(
          find.descendant(
            of: find.byKey(const ValueKey('composer-send')),
            matching: find.byType(IconButton),
          ),
        );
        expect(sendButton().onPressed, isNull);
        await tester.enterText(find.byType(TextField), '  \n ');
        await tester.pump();
        expect(sendButton().onPressed, isNull);
        await tester.testTextInput.receiveAction(TextInputAction.newline);
        expect(sends, 0);
        await tester.enterText(find.byType(TextField), 'Hello');
        await tester.pump();
        expect(sendButton().onPressed, isNotNull);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        expect(sends, 1);
        controller.clear();
        await tester.pump();
        expect(sendButton().onPressed, isNull);
        final shell = find.byKey(const ValueKey('chat-composer'));
        final decoration =
            tester.widget<Container>(shell).decoration! as BoxDecoration;
        final radius = (decoration.borderRadius! as BorderRadius).bottomRight.x;
        final shellRect = tester.getRect(shell);
        final sendAction = find.byKey(const ValueKey('composer-send'));
        final sendCenter = tester.getCenter(sendAction);
        expect(
          tester.getSize(sendAction),
          const Size.square(CanopyComposerAction.diameter),
        );
        expect(
          sendButton().style?.fixedSize?.resolve({}),
          const Size.square(CanopyComposerAction.diameter),
        );
        expect(shellRect.right - sendCenter.dx, closeTo(radius, 0.01));
        expect(shellRect.bottom - sendCenter.dy, closeTo(radius, 0.01));
      },
    );

    testWidgets(
      'keyboard return keeps a multiline draft until Send is tapped',
      (tester) async {
        usePhoneViewport(tester);
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
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.enterText(field, 'First line');
        expect(
          tester.testTextInput.setClientArgs!['inputAction'],
          'TextInputAction.newline',
        );
        expect(
          tester.widget<TextField>(field).keyboardType,
          TextInputType.multiline,
        );
        await tester.testTextInput.receiveAction(TextInputAction.newline);
        await tester.pump();
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.testTextInput.isVisible, isTrue);
        final lines = List.generate(8, (index) => 'Line ${index + 1}');
        await tester.enterText(field, lines.take(4).join('\n'));
        await tester.pumpAndSettle();
        final fourLineHeight = tester.getSize(field).height;
        await tester.enterText(field, lines.take(7).join('\n'));
        await tester.pumpAndSettle();
        final sevenLineHeight = tester.getSize(field).height;
        expect(sevenLineHeight, greaterThan(fourLineHeight));
        await tester.enterText(field, lines.join('\n'));
        await tester.pumpAndSettle();
        expect(tester.getSize(field).height, sevenLineHeight);
        // The platform IME inserts newlines through editing-value updates.
        tester.testTextInput.enterText('First line\nSecond line');
        await tester.pump();
        expect(
          tester.widget<TextField>(field).controller!.text,
          'First line\nSecond line',
        );
        expect(repository.sendChatMessageCalls, isEmpty);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();
        expect(
          repository.sendChatMessageCalls.single.text,
          'First line\nSecond line',
        );
        expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      },
    );

    testWidgets(
      'model picker uses the declared vendor instead of its Codex harness',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        final vendorModels = [
          for (final vendor in ['moonshot', 'minimax'])
            ModelOption.fromJson({
              'id': '$vendor-model',
              'label': '$vendor model',
              'provider': 'codex',
              'vendor': vendor,
              'available': true,
            }),
        ];
        repository.snapshotBuilder = () => worktreeSnapshot(
          providerType: 'codex',
          availableModels: vendorModels,
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        for (final vendor in ['moonshot', 'minimax']) {
          final row = find.byKey(ValueKey('model-option-$vendor-model'));
          // The row's only icon brands the vendor, not the Codex harness.
          final icons = tester
              .widgetList<CanopyModelIcon>(
                find.descendant(
                  of: row,
                  matching: find.byType(CanopyModelIcon),
                ),
              )
              .map((icon) => icon.vendor);
          expect(icons, [vendor]);
        }
        await tester.tap(
          find.byKey(const ValueKey('model-option-minimax-model')),
        );
        await tester.pumpAndSettle();
        expect(repository.lastSetModel, 'minimax-model');
      },
    );

    testWidgets(
      'compact controls act independently and draft uses regular sans',
      (tester) async {
        usePhoneViewport(tester);
        tester.view.physicalSize = const Size(960, 2532);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'codex', thinkingLevel: 'high');
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        final field = tester.widget<TextField>(find.byType(TextField));
        expect(field.decoration!.hintStyle, isNotNull);
        expect(
          field.decoration!.hintStyle!.fontFamily,
          AppTypography.sansFamily,
        );
        expect(
          field.decoration!.hintStyle!.fontVariations,
          AppTypography.regularVariations,
        );
        final model = find.byKey(const ValueKey('composer-model'));
        final effort = find.byKey(const ValueKey('composer-thinking'));
        // Fast mode lives in the Effort sheet, not the toolbar.
        expect(find.byKey(const ValueKey('composer-fast')), findsNothing);
        expect(
          tester.getRect(model).left,
          lessThan(tester.getRect(effort).left),
        );

        expect(
          find.descendant(of: model, matching: find.text('High')),
          findsNothing,
        );
        expect(field.style!.letterSpacing, isNull);
        expect(field.decoration!.hintStyle!.letterSpacing, isNull);
        await tester.tap(find.text('High'));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('composer-effort-sheet')),
          findsOneWidget,
        );
        await landEffortSlider(tester, 'xhigh');
        expect(repository.lastSetThinkingLevel, 'xhigh');
        expect(
          find.byKey(const ValueKey('model-option-gpt-5-codex')),
          findsNothing,
        );
        await tester.tap(find.byKey(const ValueKey('effort-fast-mode')));
        await tester.pumpAndSettle();
        expect(repository.lastSetFastMode, isTrue);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('composer places the draft above its reachable toolbar', (
      tester,
    ) async {
      usePhoneViewport(tester);
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
      final field = find.byType(TextField);
      final model = find.byKey(const ValueKey('composer-model'));
      expect(
        tester.getBottomLeft(field).dy,
        lessThanOrEqualTo(tester.getTopLeft(model).dy),
      );
      expect(tester.getSize(model).height, equals(32));
      final composerRect = tester.getRect(
        find.byKey(const ValueKey('chat-composer')),
      );
      final sendRect = tester.getRect(
        find.byKey(const ValueKey('composer-send')),
      );
      expect(
        composerRect.bottom - sendRect.bottom,
        closeTo(composerRect.right - sendRect.right, 0.01),
      );
      expect(find.byKey(const ValueKey('composer-plan')), findsNothing);
      final thinking = find.byKey(const ValueKey('composer-thinking'));
      expect(
        tester.getRect(thinking).left - tester.getRect(model).right,
        closeTo(4, 0.01),
      );
      // A 48px target whose 32px chip shares the row's bottom edge.
      expect(tester.getSize(thinking).height, 48);
      final effortChip = tester.getRect(
        find.descendant(of: thinking, matching: find.byType(TextButton)),
      );
      expect(effortChip.height, 32);
      expect(effortChip.bottom, closeTo(tester.getRect(model).bottom, 0.01));
      await tester.enterText(field, 'Review this change');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets('worktree selects Plan from + and shows a dismissible chip', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude');
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('composer-model')), findsOneWidget);
      expect(find.byKey(const ValueKey('composer-plan')), findsNothing);
      expect(find.byKey(const ValueKey('composer-thinking')), findsOneWidget);
      // Fast mode is Codex-only.
      expect(find.byKey(const ValueKey('composer-fast')), findsNothing);
      // No running turn → no Stop control.
      expect(find.byKey(const ValueKey('composer-stop')), findsNothing);

      await toggleComposerPlan(tester);
      await tester.pump();
      expect(repository.lastSetPlanMode, isTrue);
      final chip = find.byKey(const ValueKey('composer-plan'));
      expect(find.text('Plan'), findsOneWidget);
      expect(
        tester.getRect(chip).bottom,
        lessThanOrEqualTo(tester.getRect(find.byType(TextField)).top),
      );
      await tester.tap(chip);
      await tester.pumpAndSettle();
      expect(repository.lastSetPlanMode, isFalse);
      expect(chip, findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Codex chats expose Fast mode in the Effort sheet', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'codex');
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await openEffortSheet(tester);
      final fast = find.byKey(const ValueKey('effort-fast-mode'));
      expect(fast, findsOneWidget);
      await tester.tap(fast);
      await tester.pumpAndSettle();
      expect(repository.lastSetFastMode, isTrue);
      final icon = tester.widget<CanopyIcon>(
        find.descendant(of: fast, matching: find.byType(CanopyIcon)),
      );
      expect(icon.glyph, CanopyGlyph.zapFilled);
      expect(icon.tint, AppColors.of(tester.element(fast))['fg-accent']);
      await closeEffortSheet(tester);
      expect(find.byKey(const ValueKey('effort-trigger-bolt')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('composer-model')),
          matching: find.text('Fast'),
        ),
        findsNothing,
      );
    });

    testWidgets('the Effort sheet offers the provider levels and sets one', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude');
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      // The row declares no levels, so the Claude provider levels apply.
      await openEffortSheet(tester);
      expect(
        tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel)).levels,
        ['off', 'medium', 'high', 'xhigh', 'max'],
      );
      await landEffortSlider(tester, 'high');
      expect(repository.lastSetThinkingLevel, 'high');
    });

    String effortHeading(WidgetTester tester) => tester
        .widget<Text>(
          find.descendant(
            of: find.byKey(const ValueKey('effort-level')),
            matching: find.byType(Text),
          ),
        )
        .textSpan!
        .toPlainText();
    double effortSliderValue(WidgetTester tester) => tester
        .widget<Slider>(find.byKey(const ValueKey('effort-slider')))
        .value;

    // CAN-4436 review: a choice that is refused before the next frame never
    // reaches the sheet as a level change, so the sheet must drop it itself.
    for (final (name, answer, error)
        in <(String, Future<String> Function(), String?)>[
          ('is not sent', () async => '', null),
          (
            'fails to send',
            () async => throw const RemoteControlException('Effort not sent'),
            'Effort not sent',
          ),
        ]) {
      testWidgets('an Effort choice that $name at once shows the chat level '
          'again', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..setThinkingLevelHandler = (_) => answer();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude', thinkingLevel: 'medium');
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();

        await openEffortSheet(tester);
        await landEffortSlider(tester, 'high');
        expect(repository.lastSetThinkingLevel, 'high');
        if (error != null) expect(find.text(error), findsOneWidget);
        expect(effortHeading(tester), 'Effort  Medium');
        expect(effortSliderValue(tester), 1);

        await closeEffortSheet(tester);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('composer-thinking')),
            matching: find.text('Medium'),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a pending Effort choice stays shown each frame, then a later '
        'rejection shows the chat level again', (tester) async {
      usePhoneViewport(tester);
      final answer = Completer<String>();
      final repository = FakeRemoteControlRepository()
        ..setThinkingLevelHandler = (_) => answer.future;
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude', thinkingLevel: 'medium');
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        host(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
        ),
      );
      await tester.pumpAndSettle();

      await openEffortSheet(tester);
      final slider = tester.widget<Slider>(
        find.byKey(const ValueKey('effort-slider')),
      );
      slider.onChangeStart!(slider.value);
      slider.onChanged!(2);
      slider.onChangeEnd!(2);
      for (var frame = 0; frame < 4; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        expect(effortHeading(tester), 'Effort  High', reason: 'frame $frame');
        expect(effortSliderValue(tester), 2, reason: 'frame $frame');
      }
      answer.complete('effort-cmd');
      for (var frame = 0; frame < 4; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        expect(effortHeading(tester), 'Effort  High', reason: 'sent $frame');
      }
      await tester.pumpAndSettle();
      expect(effortHeading(tester), 'Effort  High');

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'Effort refused',
              commandId: 'effort-cmd',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Effort refused'), findsOneWidget);
      expect(effortHeading(tester), 'Effort  Medium');
      expect(effortSliderValue(tester), 1);
      expect(tester.takeException(), isNull);
    });

    // CAN-4436 published review: the chat rolls back an older pending choice
    // while a newer drag is still down. The drag keeps its level, and the
    // release sends the level that the sheet shows.
    for (final target in ['max', 'high']) {
      testWidgets('a rollback of a pending High during a drag to $target '
          'keeps the dragged level', (tester) async {
        usePhoneViewport(tester);
        final sent = <String>[];
        final repository = FakeRemoteControlRepository()
          ..setThinkingLevelHandler = (level) async {
            sent.add(level);
            return 'effort-cmd-${sent.length}';
          };
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude', thinkingLevel: 'medium');
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();

        await openEffortSheet(tester);
        await landEffortSlider(tester, 'high');
        expect(sent, ['high']);
        expect(effortHeading(tester), 'Effort  High');

        // A real drag to the target level, while High is still pending.
        final levels = tester
            .widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel))
            .levels;
        final label = 'Effort  ${canopyEffortLabel(target)}';
        final rect = tester.getRect(
          find.byKey(const ValueKey('effort-slider')),
        );
        final start = Offset(rect.left + 2, rect.center.dy);
        final gesture = await tester.startGesture(start);
        await gesture.moveTo(start + const Offset(40, 0));
        await gesture.moveTo(start);
        await tester.pump();
        expect(effortHeading(tester), 'Effort  None', reason: 'drag is down');
        for (var x = rect.left + 2; x < rect.right; x += 2) {
          await gesture.moveTo(Offset(x, rect.center.dy));
          await tester.pump();
          if (effortHeading(tester) == label) break;
        }
        expect(effortHeading(tester), label);

        // The chat refuses High and returns to Medium under the drag.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'Effort refused',
                commandId: 'effort-cmd-1',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Effort refused'), findsOneWidget);
        expect(effortHeading(tester), label, reason: 'the drag is still down');
        expect(effortSliderValue(tester), levels.indexOf(target));

        await gesture.up();
        await tester.pumpAndSettle();
        expect(sent, ['high', target], reason: 'the release sends the label');
        expect(repository.lastSetThinkingLevel, target);
        expect(effortHeading(tester), label);
        expect(effortSliderValue(tester), levels.indexOf(target));

        await closeEffortSheet(tester);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('composer-thinking')),
            matching: find.text(canopyEffortLabel(target)),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    }

    // CAN-4436 internal review: the desktop switches the chat to another
    // model with the same levels while a drag on the old model is down. The
    // release of that drag must not send its level to the new model.
    for (final (name, start, toLevel) in [
      ('a new level', 'low', 'medium'),
      ('the same level', 'medium', 'medium'),
    ]) {
      testWidgets('a desktop model switch with the same levels and $name '
          'ends a drag, and its release sends nothing', (tester) async {
        usePhoneViewport(tester);
        const opus = ModelOption(
          id: 'claude-opus',
          label: 'Claude Opus 4.5',
          provider: 'claude',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
        );
        const catalog = [...models, opus];
        final sent = <String>[];
        final repository = FakeRemoteControlRepository()
          ..setThinkingLevelHandler = (level) async {
            sent.add(level);
            return 'effort-cmd-${sent.length}';
          };
        repository.snapshotBuilder = () => worktreeSnapshot(
          providerType: 'claude',
          thinkingLevel: start,
          availableModels: catalog,
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();

        await openEffortSheet(tester);
        CanopyEffortPanel panel() =>
            tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel));
        final levels = panel().levels;
        final gesture = await holdEffortDrag(tester, 'high');

        // The desktop projects the chat on Opus, with the same levels.
        repository.eventsController.add(
          RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteStateDeltaEvent(
                chatSummaries: [
                  worktreeSnapshot(
                    providerType: 'claude',
                    model: opus.id,
                    modelLabel: opus.label,
                    thinkingLevel: toLevel,
                    availableModels: catalog,
                  ).chatSummaries.single,
                ],
              ),
            ],
          ),
        );
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pump();
        await tester.pump();
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('composer-model')),
            matching: find.text(opus.label),
          ),
          findsOneWidget,
        );
        expect(panel().levels, levels, reason: 'Opus has the same levels');
        final label = 'Effort  ${canopyEffortLabel(toLevel)}';
        expect(effortHeading(tester), label, reason: 'Opus is shown');
        expect(effortSliderValue(tester), levels.indexOf(toLevel));

        final rect = tester.getRect(
          find.byKey(const ValueKey('effort-slider')),
        );
        await gesture.moveTo(Offset(rect.right - 4, rect.center.dy));
        await tester.pump();
        expect(effortHeading(tester), label);
        await gesture.up();
        await tester.pumpAndSettle();
        expect(sent, isEmpty, reason: 'the old drag sends nothing');
        expect(repository.lastSetThinkingLevel, isNull);
        expect(effortHeading(tester), label);
        expect(tester.takeException(), isNull);

        // The next drag sets Opus's level.
        final next = await holdEffortDrag(tester, 'max');
        await next.up();
        await tester.pumpAndSettle();
        expect(sent, ['max']);
        expect(effortHeading(tester), 'Effort  Max');
        expect(tester.takeException(), isNull);
      });
    }

    // CAN-4436 published review: the desktop closes the shown chat while a
    // drag is down, and the screen falls back to another chat with the same
    // model and levels. The old drag belongs to the closed chat, so its
    // release sends nothing; a new drag sets the fallback chat's level.
    testWidgets('a desktop close of the shown chat during a drag ends it, '
        'and the fallback chat takes only a new drag', (tester) async {
      usePhoneViewport(tester);
      RemoteChatSummary tab(
        String chatId,
        String title, {
        bool active = false,
      }) => RemoteChatSummary(
        chatId: chatId,
        scope: RemoteChatScope.worktree,
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        title: title,
        active: active,
        providerType: 'claude',
        model: 'claude-sonnet',
        modelLabel: 'Claude Sonnet 4.5',
        thinkingLevel: 'medium',
        providerAvailability: const ProviderAvailability(
          claude: true,
          codex: true,
        ),
        availableModels: models,
        modelCatalogProjected: true,
      );
      RemoteChatMessage answer(String chatId, String text) => RemoteChatMessage(
        messageId: 'm-$chatId',
        chatId: chatId,
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: text,
      );
      final sent = <String>[];
      final repository = FakeRemoteControlRepository()
        ..setThinkingLevelHandler = (level) async {
          sent.add(level);
          return 'effort-cmd-${sent.length}';
        };
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: [
          tab('chat-1', 'Chat A', active: true),
          tab('chat-2', 'Chat B'),
        ],
        chatMessages: [
          answer('chat-1', 'Answer in chat A'),
          answer('chat-2', 'Answer in chat B'),
        ],
      );
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        host(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Answer in chat A'), findsOneWidget);

      await openEffortSheet(tester);
      CanopyEffortPanel panel() =>
          tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel));
      final levels = panel().levels;
      final gesture = await holdEffortDrag(tester, 'high');

      // The desktop closes chat A; its authoritative tab list omits it.
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: 1,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              selectedChatOnly: true,
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              targetChatId: 'chat-2',
              targetChatScope: RemoteChatScope.worktree,
              chatSummaries: [tab('chat-2', 'Chat B', active: true)],
              chatMessages: [answer('chat-2', 'Answer in chat B')],
            ),
          ],
        ),
      );
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();
      await tester.pump();
      expect(
        vm
            .chatSummariesFor(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1')
            .map((summary) => summary.chatId),
        ['chat-2'],
      );
      expect(find.text('Answer in chat B'), findsOneWidget);
      expect(panel().levels, levels, reason: 'chat B has the same levels');

      final rect = tester.getRect(find.byKey(const ValueKey('effort-slider')));
      await gesture.moveTo(Offset(rect.right - 4, rect.center.dy));
      await tester.pump();
      await gesture.up();
      await tester.pumpAndSettle();
      expect(sent, isEmpty, reason: 'the old drag sends nothing');
      expect(repository.setThinkingLevelTargets, isEmpty);
      expect(
        effortHeading(tester),
        'Effort  Medium',
        reason: 'chat B is shown',
      );
      expect(tester.takeException(), isNull);

      // A new drag sets chat B's level.
      final next = await holdEffortDrag(tester, 'max');
      await next.up();
      await tester.pumpAndSettle();
      expect(sent, ['max']);
      expect(
        repository.setThinkingLevelTargets.map((target) => target.chatId),
        ['chat-2'],
      );
      expect(effortHeading(tester), 'Effort  Max');
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'composer uses provider and plan catalog glyphs without an effort icon',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude');
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        final model = find.byKey(const ValueKey('composer-model'));
        final glyphs = tester
            .widgetList<CanopyIcon>(
              find.descendant(of: model, matching: find.byType(CanopyIcon)),
            )
            .map((icon) => icon.glyph);
        expect(glyphs, contains(CanopyGlyph.claudeai));
        expect(glyphs, isNot(contains(CanopyGlyph.brain2)));
        final plan = find.byKey(const ValueKey('composer-plan'));
        await toggleComposerPlan(tester);
        await tester.pumpAndSettle();
        final icon = tester
            .widgetList<CanopyIcon>(
              find.descendant(of: plan, matching: find.byType(CanopyIcon)),
            )
            .first;
        expect(icon.glyph, CanopyGlyph.map);
        expect(icon.size, 14);
        expect(icon.tint, AppColors.of(tester.element(plan))['fg-attention']);
        expect(
          find.descendant(of: plan, matching: find.text('Plan')),
          findsOneWidget,
        );
      },
    );

    testWidgets('a projected model catalog drives the levels, '
        'reaching model-only tiers like ultra', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      const ultraModels = [
        ModelOption(
          id: 'claude-sonnet',
          label: 'Claude Sonnet 4.5',
          provider: 'claude',
          kind: 'model',
          available: true,
          thinkingLevels: ['off', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        ),
      ];
      repository.snapshotBuilder = () => worktreeSnapshot(
        providerType: 'claude',
        availableModels: ultraModels,
        thinkingLevel: 'max',
      );
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      // The Claude provider levels stop at max; the projected per-model
      // levels reach ultra.
      expect(find.text('Max'), findsOneWidget);
      await chooseComposerEffort(tester, 'ultra');
      expect(repository.lastSetThinkingLevel, 'ultra');
    });

    for (final (name, projected, title) in const [
      ('an absent catalog', false, 'No models available yet.'),
      ('a projected empty catalog', true, 'No models available'),
    ]) {
      testWidgets('$name shows its own empty picker state', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => worktreeSnapshot(
          providerType: 'claude',
          availableModels: const [],
          catalogProjected: projected,
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();

        expect(find.text(title), findsOneWidget);
        expect(
          find.text('Check model settings in the desktop app.'),
          projected ? findsOneWidget : findsNothing,
        );
        expect(find.textContaining('organization'), findsNothing);
      });
    }

    testWidgets('a chat locked to a harness opens on its tab', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () {
        final base = worktreeSnapshot(providerType: 'claude');
        return RemoteSessionSnapshot(
          workspaces: base.workspaces,
          worktrees: base.worktrees,
          standaloneChats: base.standaloneChats,
          chatMessages: base.chatMessages,
          chatSummaries: [
            RemoteChatSummary.fromJson({
              'chatId': 'chat-1',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Chat A',
              'active': true,
              'providerType': 'claude',
              'model': 'claude-sonnet',
              'modelLabel': 'Claude Sonnet 4.5',
              'executionHarness': 'claude',
              'providerAvailability': {'claude': true, 'codex': true},
              'availableModels': [
                {
                  'id': 'claude-sonnet',
                  'label': 'Claude Sonnet 4.5',
                  'provider': 'claude',
                  'source': 'claude',
                  'vendor': 'anthropic',
                },
                {
                  'id': 'gpt-5-codex',
                  'label': 'GPT-5 Codex',
                  'provider': 'codex',
                  'source': 'codex',
                  'vendor': 'openai',
                },
              ],
            }),
          ],
        );
      };
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        host(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('model-option-gpt-5-codex')),
        findsNothing,
      );
      await tester.tap(find.byKey(const ValueKey('model-picker-tab-all')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('model-option-gpt-5-codex')));
      await tester.pumpAndSettle();
      expect(repository.lastSetModel, isNull);
      expect(
        find.text(
          'This chat is running on Claude. Start a new chat to use Codex models.',
        ),
        findsWidgets,
      );
    });

    testWidgets('the model chip opens a picker that sends the selection', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude');
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      // Both catalog rows render in the sheet.
      expect(
        find.byKey(const ValueKey('model-option-gpt-5-codex')),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('model-option-gpt-5-codex')));
      await tester.pumpAndSettle();
      expect(repository.lastSetModel, 'gpt-5-codex');
    });

    group('Auto', () {
      RemoteSessionSnapshot routingSnapshot({
        bool supported = true,
        bool auto = false,
      }) {
        final base = worktreeSnapshot(providerType: 'claude');
        return RemoteSessionSnapshot(
          workspaces: base.workspaces,
          worktrees: base.worktrees,
          standaloneChats: base.standaloneChats,
          chatMessages: base.chatMessages,
          chatSummaries: [
            RemoteChatSummary.fromJson({
              'chatId': 'chat-1',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Chat A',
              'active': true,
              'providerType': 'claude',
              'model': 'claude-sonnet',
              'modelLabel': 'Claude Sonnet 4.5',
              'modelRoutingSupported': ?(supported ? true : null),
              'modelSelectionMode': ?(auto ? 'auto' : null),
              'providerAvailability': {'claude': true, 'codex': true},
              'availableModels': [
                for (final model in models)
                  {
                    'id': model.id,
                    'label': model.label,
                    'provider': model.provider,
                    'vendor': model.vendor,
                  },
              ],
            }),
          ],
        );
      }

      ModelRoutingAvailabilityController routing() =>
          ModelRoutingAvailabilityController(
            load: () async => ModelRoutingAvailability.available,
            accountScope: () => null,
          );

      testWidgets('a routing desktop offers Auto, which sends the selection '
          'mode and never a model', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = routingSnapshot;
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
            routing: routing(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('model-picker-auto')));
        await tester.pumpAndSettle();

        expect(repository.setAutoModelTargets.single.chatId, 'chat-1');
        expect(repository.lastSetModel, isNull);
        expect(find.text('Auto'), findsOneWidget);
      });

      testWidgets('a desktop without routing support hides Auto', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => routingSnapshot(supported: false);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
            routing: routing(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('model-picker-auto')), findsNothing);
      });

      testWidgets('an Auto chat reads Auto; picking a model ends Auto', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => routingSnapshot(auto: true);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
            routing: routing(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Auto'), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('model-option-gpt-5-codex')),
        );
        await tester.pumpAndSettle();

        expect(repository.lastSetModel, 'gpt-5-codex');
        expect(find.text('Auto'), findsNothing);
        expect(find.text('GPT-5 Codex'), findsOneWidget);
      });

      testWidgets('a rejected Auto returns the chip to the model', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = routingSnapshot;
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
            routing: routing(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('model-picker-auto')));
        await tester.pumpAndSettle();
        expect(find.text('Auto'), findsOneWidget);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'Model routing is unavailable.',
                commandId: 'fake-cmd-1',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Auto'), findsNothing);
        expect(find.text('Claude Sonnet 4.5'), findsAtLeastNWidgets(1));
      });
    });

    const cursorModel = ModelOption(
      id: 'cursor-default',
      label: 'Cursor',
      provider: 'cursor',
      kind: 'model',
      available: true,
    );

    testWidgets(
      'a Cursor row is disabled with no availability info, and stays disabled when the runtime is confirmed unavailable',
      (tester) async {
        // Regression coverage (CAN-3624): `ProviderAvailability`'s
        // native-auth providers (claude/codex/ollama) treat an omitted key
        // as optimistically available, but Cursor is a managed runtime that
        // must be explicitly confirmed — an omitted/false key, or a wholly
        // absent `providerAvailability` snapshot, must render (and stay) the
        // row disabled rather than selectable.
        usePhoneViewport(tester);
        const cases = [
          (
            providerAvailability: null,
            omit: true,
          ), // no providerAvailability object at all
          (
            providerAvailability: ProviderAvailability(claude: true),
            omit: false,
          ), // object present, cursor key omitted
          (
            providerAvailability: ProviderAvailability(
              claude: true,
              cursor: false,
            ),
            omit: false,
          ), // explicitly confirmed unavailable
        ];
        for (final testCase in cases) {
          final repository = FakeRemoteControlRepository();
          repository.snapshotBuilder = () => worktreeSnapshot(
            providerType: 'claude',
            availableModels: [...models, cursorModel],
            providerAvailability: testCase.providerAvailability,
            omitProviderAvailability: testCase.omit,
          );
          final vm = await connected(tester, repository);
          final worktree = vm.worktreesFor('ws-1').single;

          await tester.pumpWidget(
            host(vm, RemoteChatScreen.worktree(worktree: worktree)),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('composer-model')));
          await tester.pumpAndSettle();

          final cursorRow = find.byKey(
            const ValueKey('model-option-cursor-default'),
          );
          expect(cursorRow, findsOneWidget);
          expect(tester.widget<CanopyModelRow>(cursorRow).enabled, isFalse);
          await tester.tap(cursorRow, warnIfMissed: false);
          await tester.pumpAndSettle();
          expect(repository.lastSetModel, isNot('cursor-default'));
          expect(
            find.text('Connect Cursor in the desktop app to use it here.'),
            findsWidgets,
          );

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
        }
      },
    );

    testWidgets(
      'a Cursor row is selectable once the runtime is confirmed available',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => worktreeSnapshot(
          providerType: 'claude',
          availableModels: [...models, cursorModel],
          providerAvailability: const ProviderAvailability(
            claude: true,
            cursor: true,
          ),
        );
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          host(vm, RemoteChatScreen.worktree(worktree: worktree)),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();

        final cursorRow = find.byKey(
          const ValueKey('model-option-cursor-default'),
        );
        expect(tester.widget<CanopyModelRow>(cursorRow).enabled, isTrue);
        await tester.tap(cursorRow);
        await tester.pumpAndSettle();
        expect(repository.lastSetModel, 'cursor-default');
      },
    );

    testWidgets(
      'the picker renders exactly the projected catalog, filtered or not',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        // The desktop projection already drops policy-blocked models before
        // they reach `availableModels`, so mobile inherits the filtering for
        // free. This pins that inheritance: a catalog missing the blocked id
        // renders no row for it, while an unfiltered catalog still does.
        repository.snapshotBuilder = () => worktreeSnapshot(
          providerType: 'claude',
          availableModels: const [
            ModelOption(
              id: 'claude-sonnet',
              label: 'Claude Sonnet 4.5',
              provider: 'claude',
              kind: 'model',
              available: true,
            ),
            ollamaModel,
          ],
        );
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          host(vm, RemoteChatScreen.worktree(worktree: worktree)),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('model-option-claude-sonnet')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('model-option-gpt-5-codex')),
          findsNothing,
        );
        // Ollama is exempt from the org policy by design, so it survives a
        // filtered Claude/Codex catalog and stays selectable.
        final ollamaRow = find.byKey(
          const ValueKey('model-option-ollama:llama3'),
        );
        expect(ollamaRow, findsOneWidget);
        await tester.tap(ollamaRow);
        await tester.pumpAndSettle();
        expect(repository.lastSetModel, 'ollama:llama3');
      },
    );

    testWidgets(
      'a summary model absent from the catalog renders no checkmark',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        // The chat's persisted model was blocked between snapshots: the
        // summary still names it but the catalog no longer carries it.
        repository.snapshotBuilder = () => worktreeSnapshot(
          providerType: 'claude',
          model: 'blocked-model',
          modelLabel: 'Blocked Model',
          availableModels: const [
            ModelOption(
              id: 'claude-sonnet',
              label: 'Claude Sonnet 4.5',
              provider: 'claude',
              kind: 'model',
              available: true,
            ),
          ],
        );
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          host(vm, RemoteChatScreen.worktree(worktree: worktree)),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();

        // Renders without throwing, and marks nothing as selected.
        expect(
          find.byKey(const ValueKey('model-option-claude-sonnet')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('model-option-claude-sonnet')),
            matching: find.byIcon(Icons.check),
          ),
          findsNothing,
        );
      },
    );

    testWidgets('a rejected set-model reverts the chip and snackbars', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude');
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('model-option-gpt-5-codex')));
      await tester.pumpAndSettle();
      // Optimistically flipped.
      expect(find.text('GPT-5 Codex'), findsAtLeastNWidgets(1));

      // The host rejects the command because the model is blocked by the org
      // policy — a stale mobile snapshot can still offer a now-blocked model.
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'This model is blocked by your organization policy.',
              commandId: 'fake-cmd-1',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('This model is blocked by your organization policy.'),
        findsOneWidget,
      );
      // The optimistic override is cleared, so the chip shows the desktop's
      // real model again rather than staying stuck on the rejected one.
      expect(find.text('GPT-5 Codex'), findsNothing);
      expect(find.text('Claude Sonnet 4.5'), findsAtLeastNWidgets(1));
    });

    testWidgets('a catalog description moves from the row to its details', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => worktreeSnapshot(
        providerType: 'claude',
        availableModels: const [
          ModelOption(
            id: 'claude-sonnet',
            label: 'Claude Sonnet 4.5',
            provider: 'claude',
            kind: 'model',
            available: true,
            description: 'Balanced speed and capability.',
          ),
        ],
      );
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();

      // Compact rows carry no inline description.
      expect(find.text('Balanced speed and capability.'), findsNothing);
      await tester.longPress(
        find.byKey(const ValueKey('model-option-claude-sonnet')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Balanced speed and capability.'), findsOneWidget);
    });

    testWidgets('extra-charge models require confirmation before selection', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude');
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('model-option-premium-model')),
      );
      await tester.pumpAndSettle();

      expect(find.text('Extra charges may apply'), findsOneWidget);
      expect(find.text('Uses AI Credits.'), findsOneWidget);
      expect(repository.lastSetModel, isNull);

      await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
      await tester.pumpAndSettle();
      expect(repository.lastSetModel, 'premium-model');
    });

    testWidgets(
      'async command failure reverts the matching composer override',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude');
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          host(vm, RemoteChatScreen.worktree(worktree: worktree)),
        );
        await tester.pumpAndSettle();
        await toggleComposerPlan(tester);
        await tester.pumpAndSettle();
        expect(repository.lastSetPlanMode, isTrue);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The plan-mode change was rejected.',
                commandId: 'fake-cmd-1',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('The plan-mode change was rejected.'), findsOneWidget);

        repository.lastSetPlanMode = null;
        await toggleComposerPlan(tester);
        await tester.pump();
        // The failed optimistic true value was cleared, so toggling again sends
        // true rather than incorrectly flipping the stale override to false.
        expect(repository.lastSetPlanMode, isTrue);
      },
    );

    testWidgets('an empty command id reverts a disconnected model change', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [],
        standaloneChats: [
          RemoteStandaloneChat(
            localId: 'chat-arch',
            projectLocalId: 'ws-notes',
            title: 'Planning',
            providerType: 'claude',
            model: 'claude-sonnet',
            modelLabel: 'Claude Sonnet 4.5',
            availableModels: models,
          ),
        ],
      );
      final vm = await connected(tester, repository);
      final chat = vm.standaloneChatsFor('ws-notes').single;
      await tester.pumpWidget(
        host(vm, RemoteChatScreen.standalone(standaloneChat: chat)),
      );
      await tester.pumpAndSettle();

      await tester.runAsync(vm.disconnect);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('model-option-gpt-5-codex')));
      await tester.pumpAndSettle();

      expect(find.text('GPT-5 Codex'), findsNothing);
      expect(find.text('Claude Sonnet 4.5'), findsAtLeastNWidgets(1));
      expect(repository.lastSetModel, isNull);
    });

    testWidgets(
      'the first newer summary clears a completed unmatched override',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude');
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();

        await toggleComposerPlan(tester);
        await tester.pumpAndSettle();
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [RemoteCommandCompletedEvent(commandId: 'fake-cmd-1')],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();

        // The desktop applied the requested true value and changed it back
        // before the debounced summary was emitted, so the intermediate true
        // summary never arrives. The first post-completion summary is still
        // authoritative and must release the optimistic override.
        await tester.runAsync(vm.refresh);
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<ChatInput>(find.byType(ChatInput))
              .controls!
              .planMode
              ?.enabled,
          isFalse,
        );
      },
    );

    testWidgets(
      'a summary after an early completion clears the override once claimed',
      (tester) async {
        usePhoneViewport(tester);
        final submitResponse = Completer<String>();
        final repository = FakeRemoteControlRepository()
          ..setPlanModeHandler = (_) => submitResponse.future;
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude');
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();

        await toggleComposerPlan(tester);
        await tester.pump();
        expect(
          tester
              .widget<ChatInput>(find.byType(ChatInput))
              .controls!
              .planMode
              ?.enabled,
          isTrue,
        );

        // The terminal event wins the race with the submit response. A newer
        // authoritative summary then arrives before Mobile learns that the
        // command belongs to this client.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [RemoteCommandCompletedEvent(commandId: 'cmd-race')],
            nextCursor: 1,
          ),
        );
        await tester.pump();
        await tester.runAsync(vm.refresh);
        await tester.pump();

        submitResponse.complete('cmd-race');
        await tester.pumpAndSettle();

        expect(
          tester
              .widget<ChatInput>(find.byType(ChatInput))
              .controls!
              .planMode
              ?.enabled,
          isFalse,
        );
      },
    );

    testWidgets('a new remote session discards command-backed overrides', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude');
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;
      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await toggleComposerPlan(tester);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<ChatInput>(find.byType(ChatInput))
            .controls!
            .planMode
            ?.enabled,
        isTrue,
      );

      await tester.runAsync(vm.disconnect);
      await tester.runAsync(() => vm.connect('654321'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<ChatInput>(find.byType(ChatInput))
            .controls!
            .planMode
            ?.enabled,
        isFalse,
      );
    });

    for (final rejectOld in [true, false]) {
      testWidgets(
        'previous session composer rejection cannot change replacement '
        'controls ($rejectOld)',
        (tester) async {
          usePhoneViewport(tester);
          final oldSubmit = Completer<String>();
          var calls = 0;
          final repository = FakeRemoteControlRepository()
            ..setPlanModeHandler = (_) =>
                ++calls == 1 ? oldSubmit.future : Future.value('new-$calls');
          repository.snapshotBuilder = () =>
              worktreeSnapshot(providerType: 'claude');
          final vm = await connected(tester, repository);
          await tester.pumpWidget(
            host(
              vm,
              RemoteChatScreen.worktree(
                worktree: vm.worktreesFor('ws-1').single,
              ),
            ),
          );
          await tester.pumpAndSettle();
          await toggleComposerPlan(tester);
          await tester.pumpAndSettle();

          await tester.runAsync(vm.disconnect);
          await tester.runAsync(() => vm.connect('654321'));
          await tester.pumpAndSettle();
          bool? planEnabled() => tester
              .widget<ChatInput>(find.byType(ChatInput))
              .controls!
              .planMode
              ?.enabled;
          expect(planEnabled(), isFalse);

          // The old session's submission settles inside the replacement.
          if (rejectOld) {
            oldSubmit.completeError(
              const RemoteControlException('Old submit rejected'),
            );
          } else {
            oldSubmit.complete('old-plan');
          }
          await tester.pumpAndSettle();
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  commandId: 'old-plan',
                  message: 'Old command failed',
                ),
              ],
              nextCursor: 1,
            ),
          );
          await tester.pumpAndSettle();

          expect(find.text('Old submit rejected'), findsNothing);
          expect(find.text('Old command failed'), findsNothing);
          expect(planEnabled(), isFalse);
          expect(tester.takeException(), isNull);
        },
      );
    }

    for (final rejectOlder in [false, true]) {
      testWidgets(
        'older submit response cannot replace latest selection ($rejectOlder)',
        (tester) async {
          usePhoneViewport(tester);
          final first = Completer<String>();
          var calls = 0;
          final repository = FakeRemoteControlRepository()
            ..setPlanModeHandler = (_) =>
                ++calls == 1 ? first.future : Future.value('latest-$calls');
          repository.snapshotBuilder = () =>
              worktreeSnapshot(providerType: 'claude');
          final vm = await connected(tester, repository);
          await tester.pumpWidget(
            host(
              vm,
              RemoteChatScreen.worktree(
                worktree: vm.worktreesFor('ws-1').single,
              ),
            ),
          );
          await tester.pumpAndSettle();
          for (var i = 0; i < 3; i++) {
            await toggleComposerPlan(tester);
            await tester.pumpAndSettle();
          }
          if (rejectOlder) {
            first.completeError(
              const RemoteControlException('Old submit rejected'),
            );
          } else {
            first.complete('older');
          }
          await tester.pumpAndSettle();
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  commandId: 'older',
                  message: 'Old command failed',
                ),
              ],
              nextCursor: 1,
            ),
          );
          await tester.pumpAndSettle();
          expect(
            tester
                .widget<ChatInput>(find.byType(ChatInput))
                .controls!
                .planMode
                ?.enabled,
            isTrue,
          );
        },
      );
    }

    testWidgets('latest submit rejection returns to remote state', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final first = Completer<String>();
      final latest = Completer<String>();
      var calls = 0;
      var planMode = false;
      final repository = FakeRemoteControlRepository()
        ..setPlanModeHandler = (_) =>
            ++calls == 1 ? first.future : latest.future;
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude', planMode: planMode);
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        host(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
        ),
      );
      await tester.pumpAndSettle();
      for (var i = 0; i < 2; i++) {
        await toggleComposerPlan(tester);
        await tester.pumpAndSettle();
      }
      latest.completeError(
        const RemoteControlException('Latest submit rejected'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Latest submit rejected'), findsOneWidget);
      expect(
        tester
            .widget<ChatInput>(find.byType(ChatInput))
            .controls!
            .planMode
            ?.enabled,
        isFalse,
      );
      first.complete('older');
      await tester.pumpAndSettle();
      planMode = true;
      await vm.refresh();
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<ChatInput>(find.byType(ChatInput))
            .controls!
            .planMode
            ?.enabled,
        isTrue,
      );
    });

    for (final control in ['plan', 'fast', 'thinking']) {
      testWidgets('rapid $control changes resist intermediate remote state', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        var intermediate = false;
        repository.snapshotBuilder = () => worktreeSnapshot(
          providerType: 'codex',
          planMode: intermediate,
          fastMode: intermediate,
          thinkingLevel: intermediate ? 'high' : 'off',
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        // Return to the original value while both commands are pending.
        const taps = 2;
        for (final level in ['medium', 'off']) {
          switch (control) {
            case 'plan':
              await toggleComposerPlan(tester);
              await tester.pumpAndSettle();
            case 'fast':
              await toggleComposerFast(tester);
            default:
              await chooseComposerEffort(tester, level);
          }
        }
        final before = tester
            .widget<ChatInput>(find.byType(ChatInput))
            .controls!;
        intermediate = true;
        await vm.refresh();
        await tester.pumpAndSettle();
        final after = tester
            .widget<ChatInput>(find.byType(ChatInput))
            .controls!;
        if (control == 'plan') {
          expect(before.planMode?.enabled, isNotNull);
          expect(after.planMode?.enabled, before.planMode?.enabled);
        }
        if (control == 'fast') expect(after.speed, before.speed);
        if (control == 'thinking') {
          expect(after.effort?.level, before.effort?.level);
        }
        // A matching snapshot alone is insufficient. Completion must also
        // notify the screen so later desktop edits are visible again.
        intermediate = false;
        await vm.refresh();
        await tester.pumpAndSettle();
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [RemoteCommandCompletedEvent(commandId: 'fake-cmd-$taps')],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();
        intermediate = true;
        await vm.refresh();
        await tester.pumpAndSettle();
        final settled = tester
            .widget<ChatInput>(find.byType(ChatInput))
            .controls!;
        if (control == 'plan') expect(settled.planMode?.enabled, isTrue);
        if (control == 'fast') {
          expect(settled.speed, CanopyEffortSpeed.fast);
        }
        if (control == 'thinking') expect(settled.effort?.level, 'high');
      });
    }

    testWidgets('running worktree switches between Stop and Send with draft', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'codex', working: true);
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        host(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Follow up',
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pumpAndSettle();
      expect(repository.sendChatMessageCalls.single.text, 'Follow up');
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        '  \n ',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-stop')));
      await tester.pump();
      expect(repository.lastCancelTarget?.chatId, 'chat-1');
    });

    testWidgets('a running turn shows Stop, which cancels the run', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () =>
          worktreeSnapshot(providerType: 'claude', streaming: true);
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      // The streaming bubble animates forever, so pump (not pumpAndSettle).
      await tester.pump();
      await tester.pump();

      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      final stopAction = find.byKey(const ValueKey('composer-stop'));
      final stopIcon = tester.widget<SvgPicture>(
        find.descendant(of: stopAction, matching: find.byType(SvgPicture)),
      );
      final stopButton = tester.widget<IconButton>(
        find.descendant(of: stopAction, matching: find.byType(IconButton)),
      );
      final error = Theme.of(tester.element(stopAction)).colorScheme.error;
      expect(stopIcon.width, 16);
      expect(stopIcon.height, 16);
      expect(
        stopIcon.colorFilter,
        ColorFilter.mode(error.withValues(alpha: 0.7), BlendMode.srcIn),
      );
      expect(
        stopButton.style?.backgroundColor?.resolve({}),
        error.withValues(alpha: 0.1),
      );
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      // Send is hidden while a turn runs.
      expect(find.byKey(const ValueKey('composer-send')), findsNothing);

      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Next step',
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('composer-send')), findsOneWidget);
      expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('composer-draft')), '');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-stop')));
      await tester.pump();
      expect(repository.lastCancelTarget, isNotNull);
    });

    testWidgets('optimistic controls stay isolated when switching chat tabs', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: [
          for (final (index, title) in ['Chat A', 'Chat B'].indexed)
            RemoteChatSummary(
              chatId: 'chat-${index + 1}',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: title,
              active: index == 0,
              providerType: 'claude',
              model: 'claude-sonnet',
              modelLabel: 'Claude Sonnet 4.5',
              planMode: false,
              thinkingLevel: 'off',
              fastMode: false,
              availableModels: models,
              modelCatalogProjected: models.isNotEmpty,
            ),
        ],
      );
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await toggleComposerPlan(tester);
      await tester.pump();
      expect(repository.lastSetPlanMode, isTrue);

      repository.lastSetPlanMode = null;
      await tester.selectTabFromSheet('Chat B');
      await toggleComposerPlan(tester);
      await tester.pump();

      // Chat B starts from its own authoritative false value. If Chat A's
      // optimistic true leaked, this second toggle would submit false.
      expect(repository.lastSetPlanMode, isTrue);
    });

    testWidgets(
      'standalone chats show model + thinking (fast Codex-only), never plan',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        var model = 'claude-sonnet';
        repository.snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: const [],
          worktrees: const [],
          standaloneChats: [
            RemoteStandaloneChat(
              localId: 'chat-arch',
              projectLocalId: 'ws-notes',
              title: 'Planning',
              providerType: model == 'gpt-5-codex' ? 'codex' : 'claude',
              model: model,
              modelLabel: model == 'gpt-5-codex'
                  ? 'GPT-5 Codex'
                  : 'Claude Sonnet 4.5',
              availableModels: models,
            ),
          ],
        );
        final vm = await connected(tester, repository);
        final chat = vm.standaloneChatsFor('ws-notes').single;

        await tester.pumpWidget(
          host(vm, RemoteChatScreen.standalone(standaloneChat: chat)),
        );
        await tester.pumpAndSettle();

        // Cowork parity with the web composer: thinking is available, plan
        // never is, and fast appears only for Codex.
        expect(find.byKey(const ValueKey('composer-model')), findsOneWidget);
        expect(find.byKey(const ValueKey('composer-plan')), findsNothing);
        expect(find.byKey(const ValueKey('composer-thinking')), findsOneWidget);
        await openEffortSheet(tester);
        expect(find.byKey(const ValueKey('effort-fast-mode')), findsNothing);

        // A choice holds the level locally (no standalone setter command)
        // and carries it on the next send's options.
        await landEffortSlider(tester, 'medium');
        await closeEffortSheet(tester);
        expect(repository.lastSetThinkingLevel, isNull);
        expect(find.text('Medium'), findsOneWidget);

        await tester.enterText(find.byType(TextField), 'hello there');
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        final send = repository.sendChatMessageCalls.single;
        expect(send.options?.thinkingLevel, 'medium');
        // Claude chat: no fast mode on the wire.
        expect(send.options?.fastMode, isNull);

        model = 'gpt-5-codex';
        await tester.runAsync(vm.refresh);
        await tester.pump();
        expect(find.text('GPT-5 Codex'), findsOneWidget);
        // Codex standalone chats offer Fast mode.
        expect(
          tester
              .widget<ChatInput>(find.byType(ChatInput))
              .controls!
              .supportsFastMode,
          isTrue,
        );

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The desktop rejected the message.',
                commandId: 'fake-cmd',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pump();
        // The banner reports it; the not-sent row repeats it as its reason.
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('remote-command-failure')),
            matching: find.text('The desktop rejected the message.'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'standalone sends omit untouched thinking and fast, carry touched ones',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [
            RemoteStandaloneChat(
              localId: 'chat-codex',
              projectLocalId: 'ws-notes',
              title: 'Planning',
              providerType: 'codex',
              model: 'gpt-5-codex',
              modelLabel: 'GPT-5 Codex',
              availableModels: models,
            ),
          ],
        );
        final vm = await connected(tester, repository);
        final chat = vm.standaloneChatsFor('ws-notes').single;

        await tester.pumpWidget(
          host(vm, RemoteChatScreen.standalone(standaloneChat: chat)),
        );
        await tester.pumpAndSettle();

        Future<RemoteChatSendOptions?> send(String text) async {
          await tester.enterText(find.byType(TextField), text);
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();
          return repository.sendChatMessageCalls.last.options;
        }

        // Untouched chips send nothing, so the desktop keeps its own levels.
        final untouched = await send('first note');
        expect(untouched?.thinkingLevel, isNull);
        expect(untouched?.fastMode, isNull);

        // Touched chips ride the next send; no setter command goes out.
        await chooseComposerOption(tester, 'effort');
        await chooseComposerOption(tester, 'fast');
        expect(repository.lastSetThinkingLevel, isNull);
        expect(repository.lastSetFastMode, isNull);
        final touched = await send('second note');
        expect(touched?.thinkingLevel, 'medium');
        expect(touched?.fastMode, isTrue);
        expect(repository.sendChatMessageCalls, hasLength(2));
      },
    );

    testWidgets(
      'reports the visible chat to ActiveChatTracker and clears on dispose',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude');
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;
        final tracker = ActiveChatTracker();

        await tester.pumpWidget(
          Provider<ActiveChatTracker>.value(
            value: tracker,
            child: host(vm, RemoteChatScreen.worktree(worktree: worktree)),
          ),
        );
        await tester.pumpAndSettle();

        expect(tracker.activeChatId, 'chat-1');

        // Replace the tree with an empty widget to dispose the screen.
        await tester.pumpWidget(const SizedBox());
        expect(tracker.activeChatId, isNull);
      },
    );

    testWidgets(
      'an inactive screen releases the visible chat and pauses PR refresh '
      'until it is shown again',
      (tester) async {
        usePhoneViewport(tester);
        final prRefreshes = <RemotePrAction>[];
        final repository = FakeRemoteControlRepository()
          ..supportsPrActions = true
          ..prActionRunner =
              (
                action, {
                repoId,
                identity,
                confirmUnresolvedComments = false,
              }) async {
                prRefreshes.add(action);
                return const <String, dynamic>{};
              };
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude');
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;
        final tracker = ActiveChatTracker();
        final active = ValueNotifier<bool>(false);
        addTearDown(active.dispose);

        await tester.pumpWidget(
          Provider<ActiveChatTracker>.value(
            value: tracker,
            child: host(
              vm,
              ValueListenableBuilder<bool>(
                valueListenable: active,
                builder: (context, isActive, _) => RemoteChatScreen.worktree(
                  worktree: worktree,
                  isActive: isActive,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // Mounted but hidden, as a home-shell destination behind another tab.
        expect(tracker.activeChatId, isNull);
        expect(prRefreshes, isEmpty);

        active.value = true;
        await tester.pumpAndSettle();
        expect(tracker.activeChatId, 'chat-1');
        expect(prRefreshes, [RemotePrAction.refresh]);

        active.value = false;
        await tester.pumpAndSettle();
        expect(tracker.activeChatId, isNull);
        await tester.pump(const Duration(minutes: 2));
        expect(prRefreshes, [RemotePrAction.refresh]);

        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'reports a deep-linked chat while its summaries are still hydrating',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;
        final tracker = ActiveChatTracker();

        await tester.pumpWidget(
          Provider<ActiveChatTracker>.value(
            value: tracker,
            child: host(
              vm,
              RemoteChatScreen.worktree(
                worktree: worktree,
                initialChatId: 'chat-9',
              ),
            ),
          ),
        );
        await tester.pump();

        expect(tracker.activeChatId, 'chat-9');

        await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
      },
    );

    testWidgets(
      'tracks only the current chat route and restores the route underneath',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [
            RemoteStandaloneChat(
              localId: 'chat-1',
              projectLocalId: 'ws-1',
              title: 'First chat',
            ),
            RemoteStandaloneChat(
              localId: 'chat-2',
              projectLocalId: 'ws-1',
              title: 'Second chat',
            ),
          ],
        );
        final vm = await connected(tester, repository);
        final tracker = ActiveChatTracker();
        final navigatorKey = GlobalKey<NavigatorState>();

        await tester.pumpWidget(
          MultiProvider(
            providers: [
              Provider<ActiveChatTracker>.value(value: tracker),
              ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
              ChangeNotifierProvider<TurnFeedbackController>(
                create: (_) => TurnFeedbackController(
                  repository: MockTurnFeedbackRepository(),
                ),
              ),
            ],
            child: MaterialApp(
              navigatorKey: navigatorKey,
              home: RemoteChatScreen.standalone(
                standaloneChat: vm.standaloneChatById('chat-1')!,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tracker.activeChatId, 'chat-1');

        navigatorKey.currentState!.push(
          MaterialPageRoute<void>(
            builder: (_) => RemoteChatScreen.standalone(
              standaloneChat: vm.standaloneChatById('chat-2')!,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tracker.activeChatId, 'chat-2');

        navigatorKey.currentState!.pop();
        await tester.pumpAndSettle();
        expect(tracker.activeChatId, 'chat-1');

        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      },
    );

    testWidgets('initialChatId preselects the transcript chat', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: const [],
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
            order: 0,
          ),
          RemoteChatSummary(
            chatId: 'chat-2',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat B',
            active: false,
            order: 1,
          ),
        ],
        chatMessages: const [
          RemoteChatMessage(
            messageId: 'm-1',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Chat A message',
          ),
          RemoteChatMessage(
            messageId: 'm-2',
            chatId: 'chat-2',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Chat B message',
          ),
        ],
      );
      final vm = await connected(tester, repository);
      final worktree = vm.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        host(
          vm,
          RemoteChatScreen.worktree(
            worktree: worktree,
            initialChatId: 'chat-2',
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The transcript is bound to chat-2 (its seeded message renders),
      // not chat-1 (the summary-projected "active" chat).
      expect(find.text('Chat B message'), findsOneWidget);
      expect(find.text('Chat A message'), findsNothing);
    });

    testWidgets(
      'initialChatId survives an early build with no hydrated summaries yet',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        // The snapshot `connected()` resolves against has zero chat
        // summaries — mirrors the real race where a deep-linked
        // RemoteChatScreen mounts (from a push-notification tap) before the
        // desktop's hydrated chat-tab list has landed.
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        final vm = await connected(tester, repository);
        final worktree = vm.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-2',
            ),
          ),
        );
        await tester.pump();

        // Summaries haven't hydrated yet: the pending deep-linked selection
        // must not have been discarded, so neither seeded chat's message is
        // showing (the transcript is still in its loading/empty state).
        expect(find.text('Chat B message'), findsNothing);
        expect(find.text('Chat A message'), findsNothing);

        // The desktop's hydrated snapshot lands: chat-1 is the "active" tab
        // and chat-2 (the deep-linked chat) is also present.
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
              order: 0,
            ),
            RemoteChatSummary(
              chatId: 'chat-2',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat B',
              active: false,
              order: 1,
            ),
          ],
          chatMessages: [
            RemoteChatMessage(
              messageId: 'm-1',
              chatId: 'chat-1',
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Chat A message',
            ),
            RemoteChatMessage(
              messageId: 'm-2',
              chatId: 'chat-2',
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Chat B message',
            ),
          ],
        );
        await tester.runAsync(() => vm.refresh());
        await tester.pumpAndSettle();

        // The deep-linked chat wins over the desktop's "active" tab.
        expect(find.text('Chat B message'), findsOneWidget);
        expect(find.text('Chat A message'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'the working indicator holds from send until turn evidence arrives',
      (tester) async {
        // Regression: after a send the indicator flapped — briefly running
        // (optimistic), then idle (the user echo replaced the transcript
        // before any streaming row or worktree isStreaming projection
        // landed), then running again. The post-send bridge must hold the
        // indicator through that gap, then hand off cleanly.
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude');
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await viewModel.connect('123456');
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        );

        await tester.pumpWidget(
          host(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('composer-stop')), findsNothing);

        await tester.enterText(find.byType(TextField), 'Deploy the fix');
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();

        // Only the user echo has landed: nothing streams and the worktree
        // row still reads idle — exactly the state that used to flap.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage(
                  messageId: 'm-echo',
                  chatId: 'chat-1',
                  role: ChatRole.user,
                  status: ChatMessageStatus.complete,
                  scope: RemoteChatScope.worktree,
                  text: 'Deploy the fix',
                ),
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);

        expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);

        // A completed turn timer is evidence the turn ran AND finished: the
        // bridge releases and the indicator drops instead of pinning for the
        // full grace window.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage(
                  messageId: 'm-turn',
                  chatId: 'chat-1',
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  scope: RemoteChatScope.worktree,
                  text: 'Done.',
                  parts: [
                    ChatPart(
                      kind: 'turn_timer',
                      data: {
                        'startedAt': 1754000000000,
                        'completedAt': 1754000009000,
                      },
                    ),
                  ],
                ),
              ),
            ],
            nextCursor: 2,
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    group('voice dictation', () {
      Future<FakeRemoteControlRepository> pumpChat(
        WidgetTester tester,
        FakeSpeechRecognizer recognizer, {
        bool working = false,
      }) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: 'claude', working: working);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(
              worktree: vm.worktreesFor('ws-1').single,
              speechRecognizer: recognizer,
            ),
          ),
        );
        await tester.pumpAndSettle();
        return repository;
      }

      testWidgets('the mic sits between the toolbar and Send', (tester) async {
        await pumpChat(tester, FakeSpeechRecognizer());

        final mic = find.byKey(const ValueKey('composer-mic'));
        expect(mic, findsOneWidget);
        expect(find.byTooltip('Start voice dictation'), findsOneWidget);
        final micX = tester.getCenter(mic).dx;
        final thinkingX = tester
            .getCenter(find.byKey(const ValueKey('composer-thinking')))
            .dx;
        final sendX = tester
            .getCenter(find.byKey(const ValueKey('composer-send')))
            .dx;
        expect(micX, greaterThan(thinkingX));
        expect(micX, lessThan(sendX));
      });

      testWidgets('tapping the mic dictates into the draft at the cursor', (
        tester,
      ) async {
        final recognizer = FakeSpeechRecognizer();
        await pumpChat(tester, recognizer);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Please',
        );
        await tester.pump();

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();

        expect(recognizer.listenCalls, 1);
        expect(find.byTooltip('Stop dictation'), findsOneWidget);
        final micButton = tester.widget<IconButton>(
          find.descendant(
            of: find.byKey(const ValueKey('composer-mic')),
            matching: find.byType(IconButton),
          ),
        );
        final error = Theme.of(
          tester.element(find.byKey(const ValueKey('composer-mic'))),
        ).colorScheme.error;
        expect(
          micButton.style?.backgroundColor?.resolve({}),
          error.withValues(alpha: 0.1),
        );

        recognizer.emitInterim('run the');
        await tester.pump();
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          'Please run the',
        );

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();
        expect(recognizer.stopCalls, 1);
        recognizer.emitFinal('run the tests.');
        recognizer.emitDone();
        await tester.pump();
        expect(find.byTooltip('Start voice dictation'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          'Please run the tests.',
        );
      });

      testWidgets('a dictated draft is sent as voice input', (tester) async {
        final recognizer = FakeSpeechRecognizer();
        final repository = await pumpChat(tester, recognizer);

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();
        recognizer.emitFinal('Run the tests');
        recognizer.emitDone();
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();

        final call = repository.sendChatMessageCalls.single;
        expect(call.text, 'Run the tests');
        expect(call.options?.inputMode, 'voice');
      });

      testWidgets('a failed dictated send stays as a not-sent row to resend', (
        tester,
      ) async {
        final recognizer = FakeSpeechRecognizer();
        final repository = await pumpChat(tester, recognizer);
        repository.sendChatMessageHandler = () async =>
            throw const RemoteControlException('Send rejected');

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();
        recognizer.emitFinal('Retry this');
        recognizer.emitDone();
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();

        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          isEmpty,
        );
        expect(find.text('Not sent'), findsOneWidget);
        expect(find.text('Send rejected'), findsOneWidget);
        repository.sendChatMessageHandler = null;
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining('Resend'));
        await tester.pumpAndSettle();

        expect(repository.sendChatMessageCalls, hasLength(2));
        expect(
          repository.sendChatMessageCalls.every(
            (call) => call.options?.inputMode == 'voice',
          ),
          isTrue,
        );
        expect(
          repository.sendChatMessageCalls.last.options?.userMessageId,
          repository.sendChatMessageCalls.first.options?.userMessageId,
        );
      });

      testWidgets('a typed draft is sent without an input mode', (
        tester,
      ) async {
        final repository = await pumpChat(tester, FakeSpeechRecognizer());

        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Typed',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();

        expect(
          repository.sendChatMessageCalls.single.options?.inputMode,
          isNull,
        );
      });

      testWidgets('sending mid-dictation cancels the session', (tester) async {
        final recognizer = FakeSpeechRecognizer();
        final repository = await pumpChat(tester, recognizer);

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();
        recognizer.emitInterim('Run the tests');
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();

        expect(recognizer.cancelCalls, 1);
        expect(repository.sendChatMessageCalls.single.text, 'Run the tests');
        expect(
          repository.sendChatMessageCalls.single.options?.inputMode,
          'voice',
        );
        expect(find.byTooltip('Start voice dictation'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          isEmpty,
        );
      });

      testWidgets('switching chat tabs abandons an open session', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final recognizer = FakeSpeechRecognizer();
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
            ),
            RemoteChatSummary(
              chatId: 'chat-2',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat B',
            ),
          ],
          chatMessages: [],
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(
              worktree: vm.worktreesFor('ws-1').single,
              speechRecognizer: recognizer,
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();
        await tester.selectTabFromSheet('Chat B');

        expect(recognizer.cancelCalls, 1);
        recognizer.emitLateInterim('private words from chat A');
        await tester.pump();
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          isEmpty,
        );
      });

      testWidgets('a declined permission opens guidance', (tester) async {
        await pumpChat(tester, FakeSpeechRecognizer(available: false));

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();

        final dialog = find.byKey(const ValueKey('voice-dictation-dialog'));
        expect(dialog, findsOneWidget);
        expect(find.text('Allow microphone access'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('voice-dictation-close')));
        await tester.pumpAndSettle();
        expect(dialog, findsNothing);
        // The mic stays usable so a fixed permission can be retried.
        expect(find.byKey(const ValueKey('composer-mic')), findsOneWidget);
      });

      testWidgets('a transient failure keeps the words and says so', (
        tester,
      ) async {
        final recognizer = FakeSpeechRecognizer();
        await pumpChat(tester, recognizer);

        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();
        recognizer.emitInterim('so far');
        recognizer.emitError('error_network', permanent: false);
        await tester.pumpAndSettle();

        expect(
          find.text('Voice dictation stopped. Try again.'),
          findsOneWidget,
        );
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          'so far',
        );
      });

      testWidgets('the mic is held while a send is in flight', (tester) async {
        final recognizer = FakeSpeechRecognizer();
        final repository = await pumpChat(tester, recognizer);
        final release = Completer<RemoteChatSendResult>();
        repository.sendChatMessageHandler = () => release.future;
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Typed',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();

        final micButton = tester.widget<IconButton>(
          find.descendant(
            of: find.byKey(const ValueKey('composer-mic')),
            matching: find.byType(IconButton),
          ),
        );
        expect(micButton.onPressed, isNull);

        release.complete(
          const RemoteChatSendResult(commandId: 'c', chatId: 'chat-1'),
        );
        await tester.pumpAndSettle();
      });

      testWidgets('leaving the screen abandons an open session', (
        tester,
      ) async {
        final recognizer = FakeSpeechRecognizer();
        await pumpChat(tester, recognizer);
        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();

        expect(recognizer.cancelCalls, 1);
      });

      testWidgets('covering the chat route abandons an open session', (
        tester,
      ) async {
        final recognizer = FakeSpeechRecognizer();
        await pumpChat(tester, recognizer);
        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();

        final navigator = tester.state<NavigatorState>(find.byType(Navigator));
        unawaited(
          navigator.push(
            MaterialPageRoute<void>(
              builder: (_) => const Scaffold(body: Text('Away')),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(recognizer.cancelCalls, 1);
      });

      testWidgets('backgrounding the app abandons an open session', (
        tester,
      ) async {
        final recognizer = FakeSpeechRecognizer();
        await pumpChat(tester, recognizer);
        await tester.tap(find.byKey(const ValueKey('composer-mic')));
        await tester.pumpAndSettle();

        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await tester.pump();

        expect(recognizer.cancelCalls, 1);

        for (final state in [
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
      });
    });

    group('attachments', () {
      /// Connected worktree chat whose desktop announces `chat_attachments`,
      /// with a scripted picker behind the attach control.
      Future<(FakeRemoteControlRepository, FakeAttachmentPicker)>
      pumpAttachmentChat(
        WidgetTester tester, {
        bool supported = true,
        FakeAttachmentPicker? picker,
      }) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsChatAttachments = supported
          ..snapshotBuilder = () => worktreeSnapshot(providerType: 'claude');
        final resolvedPicker = picker ?? FakeAttachmentPicker();
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(
              worktree: vm.worktreesFor('ws-1').single,
              attachmentPicker: resolvedPicker,
            ),
          ),
        );
        await tester.pumpAndSettle();
        return (repository, resolvedPicker);
      }

      Future<void> attachFrom(WidgetTester tester, String sourceKey) async {
        await openComposerActions(tester);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(ValueKey(sourceKey)));
        await tester.pumpAndSettle();
      }

      testWidgets(
        'reconciles the attachment sources when session capability changes',
        (tester) async {
          final (repository, _) = await pumpAttachmentChat(
            tester,
            supported: false,
          );
          final vm = tester
              .element(find.byType(RemoteChatScreen))
              .read<RemoteControlViewModel>();
          expect(await composerAttachRowEnabled(tester), isNull);

          repository.supportsChatAttachments = true;
          await tester.runAsync(vm.refresh);
          await tester.pumpAndSettle();
          expect(await composerAttachRowEnabled(tester), isTrue);

          repository.supportsChatAttachments = false;
          await tester.runAsync(vm.refresh);
          await tester.pumpAndSettle();
          expect(await composerAttachRowEnabled(tester), isNull);
        },
      );

      testWidgets('recovers lost picker results on open and resume', (
        tester,
      ) async {
        final picker = FakeAttachmentPicker()
          ..lost = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('recovered.png'),
          ]);

        await pumpAttachmentChat(tester, picker: picker);

        expect(picker.recoverLostMediaCalls, 1);
        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
        expect(find.text('recovered.png'), findsOneWidget);

        picker.lost = AttachmentPickResult.cancelled;
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        for (final state in [
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
        await tester.pumpAndSettle();

        expect(picker.recoverLostMediaCalls, 2);
      });

      testWidgets(
        'attach then pick then send passes cloudAttachments and shows a chip on the sent bubble',
        (tester) async {
          final (repository, picker) = await pumpAttachmentChat(tester);
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');
          expect(
            find.byKey(const ValueKey('attachment-strip')),
            findsOneWidget,
          );

          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'what is this',
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();

          expect(
            repository
                .sendChatMessageCalls
                .single
                .options
                ?.attachments
                ?.single
                .filename,
            'photo.png',
          );
          expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
          expect(
            find.byKey(const ValueKey('message-attachment-fake-1')),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'previews the image on the sent bubble once its thumbnail lands',
        (tester) async {
          final (_, picker) = await pumpAttachmentChat(tester);
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png', bytes: tinyPngBytes),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');

          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();

          final chip = find.byKey(const ValueKey('message-attachment-fake-1'));
          expect(chip, findsOneWidget);
          // The retain decodes on the real event loop, so give it real time
          // and rebuild until it lands — the chip has to pick the preview up
          // on its own. Bounded so a genuine regression still fails fast
          // rather than hanging.
          final preview = find.descendant(
            of: chip,
            matching: find.byType(Image),
          );
          for (
            var attempt = 0;
            attempt < 50 && !tester.any(preview);
            attempt++
          ) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 10)),
            );
            await tester.pumpAndSettle();
          }

          expect(preview, findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('leaves an undecodable pick as a plain filename chip', (
        tester,
      ) async {
        final (_, picker) = await pumpAttachmentChat(tester);
        // The default fake pick is zero-filled: no preview, no exception,
        // and above all no failed send.
        picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
          FakeAttachmentPicker.file('photo.png'),
        ]);
        await attachFrom(tester, 'composer-action-attach-library');

        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)),
        );
        await tester.pumpAndSettle();

        final chip = find.byKey(const ValueKey('message-attachment-fake-1'));
        expect(chip, findsOneWidget);
        expect(
          find.descendant(of: chip, matching: find.byType(Image)),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('sends a ready attachment without draft text', (
        tester,
      ) async {
        final (repository, picker) = await pumpAttachmentChat(tester);
        picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
          FakeAttachmentPicker.file('photo.png'),
        ]);
        await attachFrom(tester, 'composer-action-attach-library');

        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();

        expect(repository.sendChatMessageCalls, hasLength(1));
        expect(repository.sendChatMessageCalls.single.text, isEmpty);
        expect(
          repository
              .sendChatMessageCalls
              .single
              .options
              ?.attachments
              ?.single
              .filename,
          'photo.png',
        );
        expect(
          find.byKey(const ValueKey('message-attachment-fake-1')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'an attachment send from an empty worktree mints the chat id before sending',
        (tester) async {
          usePhoneViewport(tester);
          final repository = FakeRemoteControlRepository()
            ..supportsChatAttachments = true
            ..snapshotBuilder = () =>
                worktreeSnapshot(providerType: 'claude', withChat: false);
          final picker = FakeAttachmentPicker();
          final vm = await connected(tester, repository);
          final worktree = vm.worktreesFor('ws-1').single;
          await tester.runAsync(() async {
            vm.ensureWorktreeState(
              workspaceLocalId: worktree.workspaceLocalId,
              worktreeLocalId: worktree.localId,
            );
            await Future<void>.delayed(const Duration(milliseconds: 20));
          });
          await tester.pumpWidget(
            host(
              vm,
              RemoteChatScreen.worktree(
                worktree: worktree,
                attachmentPicker: picker,
              ),
            ),
          );
          await tester.pumpAndSettle();
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          final input = tester.widget<ChatInput>(find.byType(ChatInput));
          final attachments =
              input.attachments!.listenable as ChatAttachmentController;
          await attachments.addFromPhotoLibrary();
          await tester.pumpAndSettle();

          tester.widget<ChatInput>(find.byType(ChatInput)).onSend();
          await tester.pumpAndSettle();

          expect(repository.createChatTabTargets, hasLength(1));
          final mintedChatId = repository.createChatTabTargets.single.chatId;
          expect(mintedChatId, isNotNull);
          expect(
            (repository.sendChatMessageCalls.single.target
                    as RemoteWorktreeChatTarget)
                .chatId,
            mintedChatId,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a rejected send restores the draft and the staged attachments',
        (tester) async {
          final (repository, picker) = await pumpAttachmentChat(tester);
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');
          repository.sendChatMessageHandler = () =>
              throw const RemoteControlException('Desktop offline');

          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'what is this',
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();

          expect(
            tester
                .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
                .controller!
                .text,
            'what is this',
          );
          expect(
            find.byKey(const ValueKey('attachment-strip')),
            findsOneWidget,
          );
          expect(find.text('Desktop offline'), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('a delayed command failure restores the staged attachments', (
        tester,
      ) async {
        final (repository, picker) = await pumpAttachmentChat(tester);
        picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
          FakeAttachmentPicker.file('photo.png'),
        ]);
        await attachFrom(tester, 'composer-action-attach-library');

        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'what is this',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The send failed later.',
                commandId: 'fake-cmd',
              ),
            ],
            nextCursor: 99,
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
        expect(find.text('photo.png'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'an immediate restore re-uploads attachments after the session changes',
        (tester) async {
          final (repository, picker) = await pumpAttachmentChat(tester);
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');

          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();
          final vm = tester
              .element(find.byType(RemoteChatScreen))
              .read<RemoteControlViewModel>();
          vm.markPendingChatAttachmentsForRestore('fake-cmd');

          await tester.runAsync(() async {
            await vm.disconnect();
            await vm.connect('654321');
          });
          await tester.pumpAndSettle();

          expect(repository.uploadCalls, hasLength(2));
          expect(find.text('photo.png'), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'a delayed command failure restores attachments after the screen is reopened',
        (tester) async {
          usePhoneViewport(tester);
          final repository = FakeRemoteControlRepository()
            ..supportsChatAttachments = true
            ..snapshotBuilder = () => worktreeSnapshot(providerType: 'claude');
          final picker = FakeAttachmentPicker();
          final vm = await connected(tester, repository);
          final worktree = vm.worktreesFor('ws-1').single;
          final showScreen = ValueNotifier(true);
          addTearDown(showScreen.dispose);
          await tester.pumpWidget(
            MultiProvider(
              providers: [
                ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
                ChangeNotifierProvider<TurnFeedbackController>(
                  create: (_) => TurnFeedbackController(
                    repository: MockTurnFeedbackRepository(),
                  ),
                ),
              ],
              child: MaterialApp(
                navigatorObservers: [appRouteObserver],
                theme: AppTheme.light,
                darkTheme: AppTheme.dark,
                home: ValueListenableBuilder<bool>(
                  valueListenable: showScreen,
                  builder: (_, visible, _) => visible
                      ? RemoteChatScreen.worktree(
                          worktree: worktree,
                          attachmentPicker: picker,
                        )
                      : const SizedBox.shrink(),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'what is this',
          );
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();

          showScreen.value = false;
          await tester.pumpAndSettle();
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  message: 'The send failed later.',
                  commandId: 'fake-cmd',
                ),
              ],
              nextCursor: 101,
            ),
          );
          await tester.pump();

          showScreen.value = true;
          await tester.pumpAndSettle();

          expect(
            find.byKey(const ValueKey('attachment-strip')),
            findsOneWidget,
          );
          expect(find.text('photo.png'), findsOneWidget);
          expect(tester.takeException(), isNull);
          showScreen.value = false;
          await tester.pump();
          vm.dispose();
        },
      );

      testWidgets(
        'an unmounted send failure restores each attachment once after reopening',
        (tester) async {
          usePhoneViewport(tester);
          final repository = FakeRemoteControlRepository()
            ..supportsChatAttachments = true
            ..snapshotBuilder = () => worktreeSnapshot(providerType: 'claude');
          final picker = FakeAttachmentPicker();
          final send = Completer<RemoteChatSendResult>();
          repository.sendChatMessageHandler = () => send.future;
          final vm = await connected(tester, repository);
          final worktree = vm.worktreesFor('ws-1').single;
          final showScreen = ValueNotifier(true);
          addTearDown(showScreen.dispose);
          await tester.pumpWidget(
            MultiProvider(
              providers: [
                ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
                ChangeNotifierProvider<TurnFeedbackController>(
                  create: (_) => TurnFeedbackController(
                    repository: MockTurnFeedbackRepository(),
                  ),
                ),
              ],
              child: MaterialApp(
                navigatorObservers: [appRouteObserver],
                theme: AppTheme.light,
                darkTheme: AppTheme.dark,
                home: ValueListenableBuilder<bool>(
                  valueListenable: showScreen,
                  builder: (_, visible, _) => visible
                      ? RemoteChatScreen.worktree(
                          worktree: worktree,
                          attachmentPicker: picker,
                        )
                      : const SizedBox.shrink(),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'what is this',
          );
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();

          showScreen.value = false;
          await tester.pumpAndSettle();
          send.completeError(
            const RemoteControlException('The send failed while away.'),
          );
          await tester.pump();

          showScreen.value = true;
          await tester.pumpAndSettle();

          final input = tester.widget<ChatInput>(find.byType(ChatInput));
          final attachments =
              input.attachments!.listenable as ChatAttachmentController;
          expect(attachments.drafts.map((draft) => draft.filename), [
            'photo.png',
          ]);
          expect(find.text('photo.png'), findsOneWidget);
          expect(tester.takeException(), isNull);
          showScreen.value = false;
          await tester.pump();
          vm.dispose();
        },
      );

      testWidgets(
        'a delayed failure restores after build and preserves the failed batch',
        (tester) async {
          final (repository, picker) = await pumpAttachmentChat(tester);
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            for (var i = 0; i < kChatAttachmentsMaxPerMessage - 1; i++)
              FakeAttachmentPicker.file('sent-$i.png'),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'send these',
          );
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();

          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('new-1.png'),
            FakeAttachmentPicker.file('new-2.png'),
          ]);
          await attachFrom(tester, 'composer-action-attach-library');
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  message: 'The send failed later.',
                  commandId: 'fake-cmd',
                ),
              ],
              nextCursor: 100,
            ),
          );
          await tester.pump();
          await tester.pumpAndSettle();

          final input = tester.widget<ChatInput>(find.byType(ChatInput));
          final attachments =
              input.attachments!.listenable as ChatAttachmentController;
          final drafts = attachments.drafts;
          expect(drafts.map((draft) => draft.filename), [
            for (var i = 0; i < kChatAttachmentsMaxPerMessage - 1; i++)
              'sent-$i.png',
            'new-1.png',
          ]);
          expect(
            find.text('Attach or mention up to 8 files per message.'),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'no attachment source rows when the desktop lacks the capability',
        (tester) async {
          await pumpAttachmentChat(tester, supported: false);
          expect(await composerAttachRowEnabled(tester), isNull);
          expect(find.byKey(const ValueKey('composer-send')), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('a permission-denied pick shows the sign-post message', (
        tester,
      ) async {
        final (_, picker) = await pumpAttachmentChat(tester);
        picker.next = const AttachmentPickResult(
          AttachmentPickerOutcome.permissionDenied,
        );
        await attachFrom(tester, 'composer-action-attach-camera');

        expect(
          find.text(
            'Allow camera and photo access in Settings to attach files.',
          ),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
        expect(tester.takeException(), isNull);
      });

      testWidgets('a failed upload says what went wrong', (tester) async {
        final (repository, picker) = await pumpAttachmentChat(tester);
        repository.uploadHandler = (_) => Future.error(
          const RemoteControlException('attachment is too large'),
        );
        picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
          FakeAttachmentPicker.file('photo.png'),
        ]);
        await attachFrom(tester, 'composer-action-attach-library');

        // The chip stays on the strip with Retry; the snackbar is what tells
        // the user why it is there.
        expect(find.text('Attach files of 10 MB or smaller.'), findsOneWidget);
        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('attachment-retry-att-1')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('leaving the screen discards staged uploads', (tester) async {
        final (repository, picker) = await pumpAttachmentChat(tester);
        picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
          FakeAttachmentPicker.file('photo.png'),
        ]);
        await attachFrom(tester, 'composer-action-attach-files');
        expect(repository.uploadCalls, hasLength(1));

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();

        expect(repository.deleteAttachmentCalls, ['fake-1']);
        expect(tester.takeException(), isNull);
      });
    });

    group('command suggestions', () {
      Future<RemoteControlViewModel> pumpWorktreeChat(
        WidgetTester tester,
        FakeRemoteControlRepository repository, {
        required String providerType,
      }) async {
        usePhoneViewport(tester);
        repository.snapshotBuilder = () =>
            worktreeSnapshot(providerType: providerType);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        return vm;
      }

      Future<void> typeDraft(WidgetTester tester, String text) async {
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.tap(field);
        await tester.enterText(field, text);
        await tester.pumpAndSettle();
      }

      testWidgets('slash shows built-in actions in a worktree Claude chat', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository();
        await pumpWorktreeChat(tester, repository, providerType: 'claude');

        await typeDraft(tester, '/');

        expect(
          find.byKey(const ValueKey('composer-command-list')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsOneWidget,
        );
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('a worktree with no chat yet shows its built-in actions', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsChatAttachments = true
          ..snapshotBuilder = () =>
              worktreeSnapshot(providerType: 'claude', withChat: false);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        // The desktop reports the worktree has no chats, so the composer can
        // send and mint the first one.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
          ),
        );
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pumpAndSettle();
        expect(
          tester.widget<ChatInput>(find.byType(ChatInput)).enabled,
          isTrue,
        );

        await typeDraft(tester, '/');

        expect(
          find.byKey(const ValueKey('composer-command-list')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('composer-command-attach')),
          findsOneWidget,
        );
        // The model, thinking, plan and fast controls need a chat.
        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsNothing,
        );
        // No chat means no known provider: host rows are not requested.
        expect(repository.slashCommandCalls, isEmpty);
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('dollar opens suggestions only in Codex chats', (
        tester,
      ) async {
        await pumpWorktreeChat(
          tester,
          FakeRemoteControlRepository(),
          providerType: 'codex',
        );
        await typeDraft(tester, r'$');
        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();

        await pumpWorktreeChat(
          tester,
          FakeRemoteControlRepository(),
          providerType: 'claude',
        );
        await typeDraft(tester, r'$');
        expect(
          find.byKey(const ValueKey('composer-command-list')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });

      TextEditingController draftController(WidgetTester tester) => tester
          .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
          .controller!;

      Future<void> setDraft(WidgetTester tester, String text, int caret) async {
        draftController(tester).value = TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: caret),
        );
        await tester.pumpAndSettle();
      }

      testWidgets('discovered rows filter and insert without sending', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository()
          ..slashCommands = [
            {
              'name': 'review',
              'description': 'Review the diff',
              'insertText': '/review ',
            },
            {'name': 'release', 'description': 'Cut a release'},
            {'name': 'model', 'description': 'Host row named like /model'},
          ];
        await pumpWorktreeChat(tester, repository, providerType: 'claude');

        await typeDraft(tester, 'Please check /');
        expect(repository.slashCommandCalls.single, {
          'type': 'portal.editor.list_slash_commands',
          'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
          'projectId': 'ws-1',
          'worktreeId': 'wt-1',
          'providerType': 'claude',
        });
        expect(find.text('Commands'), findsOneWidget);
        // Host rows follow the built-in actions in the capped list.
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('composer-command-skills-review')),
          48,
          scrollable: find.descendant(
            of: find.byKey(const ValueKey('composer-command-list')),
            matching: find.byType(Scrollable),
          ),
        );
        expect(find.text('Skills and commands'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('composer-command-skills-review')),
          findsOneWidget,
        );
        // A host row named like a built-in action is hidden.
        expect(
          find.byKey(const ValueKey('composer-command-skills-model')),
          findsNothing,
        );

        await setDraft(tester, 'Please check /rev now', 17);
        expect(
          find.byKey(const ValueKey('composer-command-skills-review')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('composer-command-skills-release')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsNothing,
        );

        await tester.tap(
          find.byKey(const ValueKey('composer-command-skills-review')),
        );
        await tester.pumpAndSettle();
        final draft = draftController(tester).value;
        expect(draft.text, 'Please check /review  now');
        expect(draft.selection, const TextSelection.collapsed(offset: 21));
        expect(
          find.byKey(const ValueKey('composer-command-list')),
          findsNothing,
        );
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('an older desktop keeps built-ins and offers Retry', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository()
          ..slashCommandsError = const RemoteControlException(
            'Unknown command',
          );
        await pumpWorktreeChat(tester, repository, providerType: 'claude');

        await typeDraft(tester, '/');
        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsOneWidget,
        );
        expect(find.text("Couldn't load commands"), findsOneWidget);

        repository
          ..slashCommandsError = null
          ..slashCommands = [
            {'name': 'review', 'description': 'Review the diff'},
          ];
        await tester.ensureVisible(
          find.byKey(const ValueKey('composer-command-retry')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-command-retry')));
        await tester.pumpAndSettle();
        expect(repository.slashCommandCalls, hasLength(2));
        expect(find.text("Couldn't load commands"), findsNothing);
        expect(
          find.byKey(const ValueKey('composer-command-skills-review')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('a desktop without an answer also offers Retry', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository()..slashCommands = null;
        await pumpWorktreeChat(tester, repository, providerType: 'claude');
        await typeDraft(tester, '/');
        expect(
          find.byKey(const ValueKey('composer-command-retry')),
          findsOneWidget,
        );
      });

      testWidgets('a standalone chat lists built-ins only', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [
            RemoteStandaloneChat(
              localId: 'chat-solo',
              projectLocalId: 'ws-notes',
              title: 'Notes',
              providerType: 'claude',
              model: 'claude-sonnet',
              modelLabel: 'Claude Sonnet 4.5',
              availableModels: models,
            ),
          ],
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.standalone(
              standaloneChat: vm.standaloneChatsFor('ws-notes').single,
            ),
          ),
        );
        await tester.pumpAndSettle();

        await typeDraft(tester, '/');
        expect(
          find.byKey(const ValueKey('composer-command-model')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('composer-command-plan')),
          findsNothing,
        );
        expect(find.text("Couldn't load commands"), findsNothing);
        expect(repository.slashCommandCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('built-in actions drive the existing controls', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository();
        await pumpWorktreeChat(tester, repository, providerType: 'claude');

        await typeDraft(tester, 'Ship it /pla');
        await tester.tap(find.byKey(const ValueKey('composer-command-plan')));
        await tester.pumpAndSettle();
        expect(repository.lastSetPlanMode, isTrue);
        expect(draftController(tester).text, 'Ship it ');

        await typeDraft(tester, '/thinking');
        await tester.tap(
          find.byKey(const ValueKey('composer-command-thinking')),
        );
        await tester.pumpAndSettle();
        expect(repository.lastSetThinkingLevel, isNull);
        await landEffortSlider(tester, 'medium');
        expect(repository.lastSetThinkingLevel, 'medium');
        await closeEffortSheet(tester);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('composer-thinking')),
            matching: find.text('Medium'),
          ),
          findsOneWidget,
        );

        // Fast mode is Codex-only, so the action explains why it is off.
        await typeDraft(tester, '/fa');
        expect(
          find.text('Speed options are available for Codex models.'),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const ValueKey('composer-command-fast')));
        await tester.pumpAndSettle();
        expect(repository.lastSetFastMode, isNull);
        expect(draftController(tester).text, '/fa');

        await typeDraft(tester, '/mod');
        await tester.tap(find.byKey(const ValueKey('composer-command-model')));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('model-option-gpt-5-codex')),
          findsOneWidget,
        );
        expect(draftController(tester).text, isEmpty);
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('at phone width and 2x text the list stays above Send', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository()
          ..slashCommands = [
            for (var i = 0; i < 8; i++)
              {
                'name': 'command-$i',
                'description':
                    'A long description that needs to be cut '
                    'to one line on a phone screen',
              },
          ];
        tester.platformDispatcher.textScaleFactorTestValue = 2;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await pumpWorktreeChat(tester, repository, providerType: 'claude');
        // A software keyboard of 336 logical pixels.
        tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
        addTearDown(tester.view.resetViewInsets);
        await tester.pumpAndSettle();

        await typeDraft(tester, '/');
        final list = tester.getRect(
          find.byKey(const ValueKey('composer-command-list')),
        );
        final composer = tester.getRect(
          find.byKey(const ValueKey('chat-composer')),
        );
        final send = tester.getRect(
          find.byKey(const ValueKey('composer-send')),
        );
        expect(list.width, lessThanOrEqualTo(390));
        expect(list.bottom, lessThanOrEqualTo(composer.top));
        expect(send.bottom, lessThanOrEqualTo(844 - 336));
        expect(list.top, greaterThanOrEqualTo(0));
        final row = tester.getSize(
          find.byKey(const ValueKey('composer-command-model')),
        );
        expect(row.height, greaterThanOrEqualTo(48));
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'folding keeps the draft and Send reachable with suggestions open',
        (tester) async {
          await pumpWorktreeChat(
            tester,
            FakeRemoteControlRepository(),
            providerType: 'claude',
          );
          await typeDraft(tester, '/');
          final state = tester.state(find.byType(RemoteChatScreen));
          for (final size in [
            const Size(890, 626),
            const Size(466, 678),
            const Size(678, 466),
            const Size(390, 844),
          ]) {
            tester.view.physicalSize = size * 3;
            tester.view.padding = const FakeViewPadding(
              top: 24 * 3,
              right: 64 * 3,
            );
            tester.view.viewInsets = const FakeViewPadding(bottom: 300 * 3);
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull, reason: '$size');
            expect(tester.state(find.byType(RemoteChatScreen)), same(state));
            expect(draftController(tester).text, '/');
            final send = find.byKey(const ValueKey('composer-send'));
            expect(send.hitTestable(), findsOneWidget);
            final bounds = tester.getRect(send);
            expect(bounds.right, lessThanOrEqualTo(size.width - 64));
            expect(bounds.bottom, lessThanOrEqualTo(size.height - 300));
          }
          await tester.tap(
            find.byKey(const ValueKey('composer-command-model')),
          );
          await tester.pumpAndSettle();
          expect(
            find.byKey(const ValueKey('model-option-gpt-5-codex')),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('the list cap follows a keyboard that opens under it', (
        tester,
      ) async {
        await pumpWorktreeChat(
          tester,
          FakeRemoteControlRepository(),
          providerType: 'claude',
        );
        await typeDraft(tester, '/');
        final list = find.byKey(const ValueKey('composer-command-list'));
        expect(tester.getSize(list).height, greaterThan(200));

        tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
        addTearDown(tester.view.resetViewInsets);
        await tester.pumpAndSettle();
        expect(
          tester.getSize(list).height,
          lessThanOrEqualTo((844 - 336) * 0.35 + 8),
        );
        expect(tester.takeException(), isNull);
      });

      for (final textScale in [1.0, 2.0]) {
        testWidgets(
          'with the keyboard open at ${textScale}x text the list leaves room '
          'for a failed transcript',
          (tester) async {
            usePhoneViewport(tester);
            tester.platformDispatcher.textScaleFactorTestValue = textScale;
            addTearDown(
              tester.platformDispatcher.clearTextScaleFactorTestValue,
            );
            // The Scaffold removes this inset from its body's MediaQuery.
            tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
            addTearDown(tester.view.resetViewInsets);
            final full = worktreeSnapshot(providerType: 'claude');
            final repository = _FailingTranscriptRepository()
              ..snapshotBuilder = () => RemoteSessionSnapshot(
                workspaces: full.workspaces,
                worktrees: full.worktrees,
                standaloneChats: full.standaloneChats,
                chatSummaries: full.chatSummaries,
              );
            final vm = await connected(tester, repository);
            await tester.pumpWidget(
              host(
                vm,
                RemoteChatScreen.worktree(
                  worktree: vm.worktreesFor('ws-1').single,
                ),
              ),
            );
            await tester.pump();
            await tester.pump(kRemoteHydrationRetryWindow);
            await tester.pumpAndSettle();
            expect(find.text('Transcript unavailable.'), findsOneWidget);

            await typeDraft(tester, '/');

            final list = tester.getRect(
              find.byKey(const ValueKey('composer-command-list')),
            );
            final composer = tester.getRect(
              find.byKey(const ValueKey('chat-composer')),
            );
            // At most 35% of the 508 points above the keyboard, plus the
            // list's 8 point top margin.
            expect(list.height, lessThanOrEqualTo((844 - 336) * 0.35 + 8));
            expect(list.bottom, lessThanOrEqualTo(composer.top));
            expect(composer.bottom, lessThanOrEqualTo(844 - 336));
            // The transcript between the app bar and the list keeps room,
            // and its Retry stays reachable.
            final appBar = tester.getRect(find.byType(CanopyAppBar));
            expect(list.top - appBar.bottom, greaterThanOrEqualTo(48));
            final retry = find.widgetWithText(FilledButton, 'Retry');
            await tester.ensureVisible(retry);
            await tester.pumpAndSettle();
            expect(retry.hitTestable(), findsOneWidget);
            expect(tester.takeException(), isNull);
          },
        );
      }
    });

    group('CAN-3922 action menu', () {
      Future<RemoteControlViewModel> pumpWorktree(
        WidgetTester tester, {
        FakeRemoteControlRepository? repository,
        bool attachments = true,
      }) async {
        usePhoneViewport(tester);
        final fake = (repository ?? FakeRemoteControlRepository())
          ..supportsChatAttachments = attachments;
        fake.snapshotBuilder ??= () => worktreeSnapshot(providerType: 'claude');
        final vm = await connected(tester, fake);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(
              worktree: vm.worktreesFor('ws-1').single,
              attachmentPicker: FakeAttachmentPicker(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        return vm;
      }

      Future<void> openActions(WidgetTester tester) async {
        await tester.tap(find.byTooltip('Add files and more'));
        await tester.pumpAndSettle();
      }

      testWidgets(
        'CAN-3922 a worktree chat lists the attachment sources, Plugins, and '
        'Plan mode in order',
        (tester) async {
          await pumpWorktree(tester);

          await openActions(tester);

          final rows = [
            'Take photo',
            'Photo library',
            'Files',
            'Plugins',
            'Plan mode',
          ].map((label) => tester.getTopLeft(find.text(label)).dy).toList();
          for (var i = 1; i < rows.length; i++) {
            expect(rows[i - 1], lessThan(rows[i]));
          }
          expect(find.text('Files and photos'), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 the + control leads the toolbar at the send size and '
        'replaces the attach control',
        (tester) async {
          await pumpWorktree(tester);

          final plus = find.byTooltip('Add files and more');
          expect(plus, findsOneWidget);
          expect(
            tester.getSize(plus),
            const Size.square(CanopyComposerAction.diameter),
          );
          expect(
            tester.getTopLeft(plus).dx,
            lessThan(
              tester
                  .getTopLeft(find.byKey(const ValueKey('composer-model')))
                  .dx,
            ),
          );
          expect(find.byKey(const ValueKey('composer-attach')), findsNothing);
          expect(
            find.byKey(const ValueKey('composer-attach-unavailable')),
            findsNothing,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 a standalone chat has no Plugins or Plan mode row',
        (tester) async {
          usePhoneViewport(tester);
          final repository = FakeRemoteControlRepository()
            ..supportsChatAttachments = true
            ..snapshotBuilder = () => const RemoteSessionSnapshot(
              workspaces: [],
              worktrees: [],
              standaloneChats: [
                RemoteStandaloneChat(
                  localId: 'chat-solo',
                  projectLocalId: 'ws-notes',
                  title: 'Notes',
                  providerType: 'claude',
                  model: 'claude-sonnet',
                  modelLabel: 'Claude Sonnet 4.5',
                  availableModels: models,
                ),
              ],
            );
          final vm = await connected(tester, repository);
          await tester.pumpWidget(
            host(
              vm,
              RemoteChatScreen.standalone(
                standaloneChat: vm.standaloneChatsFor('ws-notes').single,
              ),
            ),
          );
          await tester.pumpAndSettle();

          await openActions(tester);

          expect(find.text('Plugins'), findsNothing);
          expect(find.text('Plan mode'), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );

      const githubRef = {'marketplaceId': 'market', 'pluginName': 'github'};
      const catalog = {
        'collections': [
          {
            'id': 'c1',
            'name': 'Release kit',
            'description': 'Skills for shipping',
            'skillCount': 2,
            'pluginCount': 0,
            'mcpServerCount': 0,
          },
        ],
        'plugins': [
          {
            ...githubRef,
            'name': 'GitHub',
            'description': 'Pull requests and checks',
            'marketplaceName': 'Market',
            'claudeSupported': true,
            'codexSupported': true,
          },
        ],
        'skills': [
          {
            'sourceId': 'src',
            'skillName': 'notes',
            'name': 'Release notes',
            'description': 'Draft release notes',
            'source': 'Custom',
          },
        ],
        'mcpServers': [
          {
            'serverId': 'linear',
            'configId': 'default',
            'serverName': 'Linear',
            'configName': 'default',
            'description': 'Issues',
            'transport': 'http',
          },
        ],
      };
      const authPreference = {
        'target': {
          'kind': 'standalone',
          'serverId': 'linear',
          'configId': 'default',
        },
        'handler': 'oauth',
      };
      const projected = <String, Object?>{
        'collectionIds': ['c1'],
        'skillRefs': <Object?>[],
        'pluginRefs': <Object?>[],
        'mcpHttpAuthPreferences': [authPreference],
      };

      RemoteSessionSnapshot withSelections(
        Map<String, Object?>? detail, {
        String providerType = 'claude',
        String? model,
        List<ModelOption>? availableModels,
      }) {
        final base = worktreeSnapshot(
          providerType: providerType,
          model: model,
          availableModels: availableModels,
        );
        final summary = base.chatSummaries.single;
        return RemoteSessionSnapshot(
          workspaces: base.workspaces,
          worktrees: base.worktrees,
          standaloneChats: base.standaloneChats,
          chatSummaries: [
            RemoteChatSummary(
              chatId: summary.chatId,
              scope: summary.scope,
              workspaceLocalId: summary.workspaceLocalId,
              worktreeLocalId: summary.worktreeLocalId,
              title: summary.title,
              active: true,
              providerType: summary.providerType,
              model: summary.model,
              modelLabel: summary.modelLabel,
              thinkingLevel: summary.thinkingLevel,
              providerAvailability: summary.providerAvailability,
              availableModels: summary.availableModels,
              modelCatalogProjected: true,
              pluginSelectionsDetail: detail,
            ),
          ],
          chatMessages: base.chatMessages,
        );
      }

      TextEditingController draft(WidgetTester tester) => tester
          .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
          .controller!;

      Future<void> typeKeptDraft(WidgetTester tester) async {
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep this draft',
        );
        draft(tester).selection = const TextSelection(
          baseOffset: 5,
          extentOffset: 9,
        );
        await tester.pump();
      }

      Future<void> openPlugins(WidgetTester tester) async {
        await openActions(tester);
        await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
        await tester.pumpAndSettle();
      }

      Future<void> closeSheet(WidgetTester tester) async {
        Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
        await tester.pumpAndSettle();
      }

      Finder pluginSwitch(String id) =>
          find.byKey(ValueKey('composer-plugin-$id'));

      bool switchOn(WidgetTester tester, String id) =>
          tester.widget<SwitchListTile>(pluginSwitch(id)).value;

      bool switchEnabled(WidgetTester tester, String id) =>
          tester.widget<SwitchListTile>(pluginSwitch(id)).onChanged != null;

      Finder rowText(String id, String text) =>
          find.descendant(of: pluginSwitch(id), matching: find.text(text));

      Finder rowTitle(WidgetTester tester, String id, String text) =>
          find.descendant(
            of: find.byWidget(
              tester.widget<SwitchListTile>(pluginSwitch(id)).title!,
            ),
            matching: find.text(text),
          );

      testWidgets(
        'CAN-3922 the + sheet lists the attachment sources and stages a photo',
        (tester) async {
          final repository = FakeRemoteControlRepository();
          await pumpWorktree(tester, repository: repository);
          final picker =
              tester
                      .widget<RemoteChatScreen>(find.byType(RemoteChatScreen))
                      .attachmentPicker!
                  as FakeAttachmentPicker;
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await typeKeptDraft(tester);
          final before = draft(tester).value;

          await openActions(tester);
          expect(
            find.byKey(const ValueKey('composer-action-attach-camera')),
            findsOneWidget,
          );
          await tester.tap(
            find.byKey(const ValueKey('composer-action-attach-library')),
          );
          await tester.pumpAndSettle();

          expect(find.text('photo.png'), findsOneWidget);
          expect(draft(tester).value.text, before.text);
          expect(draft(tester).value.selection, before.selection);
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();
          expect(
            repository
                .sendChatMessageCalls
                .single
                .options
                ?.attachments
                ?.single
                .filename,
            'photo.png',
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 turning a plugin on sends the complete selection and '
        'updates the count',
        (tester) async {
          final repository = FakeRemoteControlRepository()
            ..pluginCatalog = catalog
            ..snapshotBuilder = () => withSelections(projected);
          await pumpWorktree(tester, repository: repository);
          await typeKeptDraft(tester);
          final before = draft(tester).value;

          await openActions(tester);
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('composer-action-plugins')),
              matching: find.text('1'),
            ),
            findsOneWidget,
          );
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pumpAndSettle();

          expect(repository.pluginCatalogCalls.single, {
            'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
            'projectId': 'ws-1',
            'worktreeId': 'wt-1',
            'providerType': 'claude',
          });
          for (final title in [
            'Collections',
            'Plugins',
            'Skills',
            'MCP servers',
          ]) {
            expect(
              find.descendant(
                of: find.byKey(const ValueKey('composer-plugins-sheet')),
                matching: find.text(title),
              ),
              // The sheet title also reads Plugins.
              findsNWidgets(title == 'Plugins' ? 2 : 1),
            );
          }
          expect(switchOn(tester, 'collection:c1'), isTrue);
          expect(switchOn(tester, 'plugin:market/github'), isFalse);

          await tester.tap(pluginSwitch('plugin:market/github'));
          await tester.pumpAndSettle();
          final call = repository.pluginSelectionCalls.single;
          expect(call.target.chatId, 'chat-1');
          expect(call.selections, {
            ...projected,
            'pluginRefs': [githubRef],
          });
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [RemoteCommandCompletedEvent(commandId: 'fake-cmd-1')],
              nextCursor: 1,
            ),
          );
          await tester.pumpAndSettle();
          expect(switchOn(tester, 'plugin:market/github'), isTrue);
          expect(find.textContaining('Could not change'), findsNothing);

          await closeSheet(tester);
          await openActions(tester);
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('composer-action-plugins')),
              matching: find.text('2'),
            ),
            findsOneWidget,
          );
          await closeSheet(tester);
          expect(draft(tester).value.text, before.text);
          expect(draft(tester).value.selection, before.selection);
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      for (final delayed in [false, true]) {
        testWidgets(
          'CAN-3922 a ${delayed ? 'delayed' : 'submit'} rejection reverts the '
          'toggle and shows an inline error',
          (tester) async {
            final repository = FakeRemoteControlRepository()
              ..pluginCatalog = catalog
              ..snapshotBuilder = (() => withSelections(projected))
              ..setPluginSelectionsHandler = (_) async => delayed
                  ? 'plugins-1'
                  : throw const RemoteControlException('Desktop offline');
            await pumpWorktree(tester, repository: repository);
            await typeKeptDraft(tester);
            final before = draft(tester).value;
            await openPlugins(tester);

            await tester.tap(pluginSwitch('collection:c1'));
            await tester.pumpAndSettle();
            if (delayed) {
              // Held while the desktop has not answered.
              expect(switchOn(tester, 'collection:c1'), isFalse);
              repository.eventsController.add(
                const RemotePortalEventBatch(
                  events: [
                    RemoteCommandFailedEvent(
                      message: 'Plugins are unavailable.',
                      commandId: 'plugins-1',
                    ),
                  ],
                  nextCursor: 1,
                ),
              );
              await tester.pumpAndSettle();
            }

            expect(switchOn(tester, 'collection:c1'), isTrue);
            expect(
              find.text('Could not change Release kit. Try again.'),
              findsOneWidget,
            );
            // CAN-3922: the error replaces the row's label, not a new line.
            expect(
              rowTitle(
                tester,
                'collection:c1',
                'Could not change Release kit. Try again.',
              ),
              findsOneWidget,
            );
            expect(rowText('collection:c1', 'Release kit'), findsNothing);
            expect(
              rowText('collection:c1', 'Skills for shipping'),
              findsOneWidget,
            );
            expect(
              rowText('plugin:market/github', 'Pull requests and checks'),
              findsOneWidget,
            );
            await closeSheet(tester);
            expect(draft(tester).value.text, before.text);
            expect(draft(tester).value.selection, before.selection);
            expect(tester.takeException(), isNull);
          },
        );
      }

      testWidgets(
        'CAN-3922 a sheet reopened while a removal saves shows the desktop '
        'answer, and the next toggle keeps a rejected removal out',
        (tester) async {
          var commands = 0;
          final repository = FakeRemoteControlRepository()
            ..pluginCatalog = catalog
            ..snapshotBuilder = (() => withSelections(projected))
            ..setPluginSelectionsHandler = (_) async => 'plugins-${++commands}';
          await pumpWorktree(tester, repository: repository);
          await openPlugins(tester);
          await tester.tap(pluginSwitch('collection:c1'));
          await tester.pumpAndSettle();
          expect(switchOn(tester, 'collection:c1'), isFalse);
          await closeSheet(tester);

          await openActions(tester);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  message: 'Plugins are unavailable.',
                  commandId: 'plugins-1',
                ),
              ],
              nextCursor: 1,
            ),
          );
          await tester.pumpAndSettle();
          expect(switchOn(tester, 'collection:c1'), isTrue);

          await tester.tap(pluginSwitch('plugin:market/github'));
          await tester.pumpAndSettle();
          expect(repository.pluginSelectionCalls.last.selections, {
            ...projected,
            'pluginRefs': [githubRef],
          });
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 a sheet whose chat closes saves nothing to the chat shown '
        'next',
        (tester) async {
          RemoteSessionSnapshot chats({required bool withFirst}) {
            final base = withSelections(projected);
            return RemoteSessionSnapshot(
              workspaces: base.workspaces,
              worktrees: base.worktrees,
              standaloneChats: base.standaloneChats,
              chatSummaries: [
                if (withFirst) ...base.chatSummaries,
                const RemoteChatSummary(
                  chatId: 'chat-2',
                  scope: RemoteChatScope.worktree,
                  workspaceLocalId: 'ws-1',
                  worktreeLocalId: 'wt-1',
                  title: 'Second chat',
                  providerType: 'claude',
                  pluginSelectionsDetail: {
                    'collectionIds': <Object?>[],
                    'skillRefs': <Object?>[],
                    'pluginRefs': <Object?>[],
                  },
                ),
              ],
              chatMessages: base.chatMessages,
            );
          }

          final repository = FakeRemoteControlRepository()
            ..pluginCatalog = catalog
            ..snapshotBuilder = () => chats(withFirst: true);
          final vm = await pumpWorktree(tester, repository: repository);
          await openPlugins(tester);
          expect(switchOn(tester, 'collection:c1'), isTrue);

          repository.snapshotBuilder = () => chats(withFirst: false);
          await tester.runAsync(vm.refresh);
          await tester.pumpAndSettle();
          await tester.tap(pluginSwitch('plugin:market/github'));
          await tester.pumpAndSettle();

          expect(repository.pluginSelectionCalls, isEmpty);
          expect(switchOn(tester, 'plugin:market/github'), isFalse);
          expect(
            find.text('Could not change GitHub. Try again.'),
            findsOneWidget,
          );
          expect(
            rowTitle(
              tester,
              'plugin:market/github',
              'Could not change GitHub. Try again.',
            ),
            findsOneWidget,
          );
          expect(rowText('plugin:market/github', 'GitHub'), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('CAN-3922 /plugins opens the plugins sheet without sending', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository()
          ..pluginCatalog = catalog;
        await pumpWorktree(tester, repository: repository);
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.tap(field);
        await tester.enterText(field, 'Ship it /plu');
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const ValueKey('composer-command-plugins')),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('composer-plugins-sheet')),
          findsOneWidget,
        );
        expect(draft(tester).text, 'Ship it ');
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('CAN-3922 Plan mode in the sheet toggles plan mode', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository();
        await pumpWorktree(tester, repository: repository);
        await typeKeptDraft(tester);
        final before = draft(tester).value;

        await openActions(tester);
        expect(
          tester
              .widget<Switch>(
                find.descendant(
                  of: find.byKey(const ValueKey('composer-action-plan')),
                  matching: find.byType(Switch),
                ),
              )
              .value,
          isFalse,
        );
        await tester.tap(find.byKey(const ValueKey('composer-action-plan')));
        await tester.pumpAndSettle();

        expect(repository.lastSetPlanMode, isTrue);
        expect(draft(tester).value.text, before.text);
        expect(draft(tester).value.selection, before.selection);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'CAN-3922 at eight attachments the attachment sources are disabled '
        'with the limit',
        (tester) async {
          await pumpWorktree(tester);
          final picker =
              tester
                      .widget<RemoteChatScreen>(find.byType(RemoteChatScreen))
                      .attachmentPicker!
                  as FakeAttachmentPicker;
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            for (var i = 0; i < kChatAttachmentsMaxPerMessage; i++)
              FakeAttachmentPicker.file('p$i.png'),
          ]);
          await openActions(tester);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-attach-files')),
          );
          await tester.pumpAndSettle();

          await openActions(tester);
          for (final key in composerAttachRowKeys) {
            expect(
              tester.widget<ListTile>(find.byKey(ValueKey(key))).enabled,
              isFalse,
            );
          }
          expect(find.text('Up to 8 attachments per message'), findsOneWidget);
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('extra.png'),
          ]);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-attach-files')),
          );
          await tester.pumpAndSettle();
          expect(find.byType(BottomSheet), findsOneWidget);
          expect(find.text('extra.png'), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );

      // Desktop sets these flags with the Plugins modal's provider rule
      // (`pluginSelectorScope.ts`): Claude and Ollama chats need a
      // Claude-native plugin; Codex chats also run Claude-compatible ones.
      const codexOnlyRef = {
        'marketplaceId': 'market',
        'pluginName': 'codex-tools',
      };
      const claudeOnlyRef = {
        'marketplaceId': 'market',
        'pluginName': 'claude-tools',
      };
      const legacyRef = {'marketplaceId': 'market', 'pluginName': 'legacy'};
      final providerCatalog = {
        ...catalog,
        'plugins': [
          {
            ...codexOnlyRef,
            'name': 'Codex tools',
            'description': 'Codex only',
            'marketplaceName': 'Market',
            'claudeSupported': false,
            'codexSupported': true,
          },
          {
            ...claudeOnlyRef,
            'name': 'Claude tools',
            'description': 'Claude only',
            'marketplaceName': 'Market',
            'claudeSupported': true,
            'codexSupported': false,
          },
          // An older desktop sends no provider flags.
          {
            ...legacyRef,
            'name': 'Legacy',
            'description': 'No provider flags',
            'marketplaceName': 'Market',
          },
        ],
      };
      const unsupportedReason = 'Unsupported by this provider';

      for (final (provider, model, blocked) in [
        ('claude', 'claude-sonnet', 'plugin:market/codex-tools'),
        ('ollama', ollamaModel.id, 'plugin:market/codex-tools'),
        ('codex', 'gpt-5-codex', 'plugin:market/claude-tools'),
        ('cursor', 'cursor-auto', null),
      ]) {
        testWidgets(
          'CAN-3922 a $provider chat turns on only the plugins its provider '
          'supports',
          (tester) async {
            final repository = FakeRemoteControlRepository()
              ..pluginCatalog = providerCatalog
              ..snapshotBuilder = () => withSelections(
                projected,
                providerType: provider,
                model: model,
                availableModels: [...models, ollamaModel],
              );
            await pumpWorktree(tester, repository: repository);
            await openPlugins(tester);
            expect(
              repository.pluginCatalogCalls.single['providerType'],
              provider,
            );

            for (final id in [
              'plugin:market/codex-tools',
              'plugin:market/claude-tools',
              'plugin:market/legacy',
            ]) {
              final unsupported = id == blocked;
              expect(switchOn(tester, id), isFalse, reason: id);
              expect(switchEnabled(tester, id), !unsupported, reason: id);
              expect(
                rowText(id, unsupportedReason),
                unsupported ? findsOneWidget : findsNothing,
                reason: id,
              );
            }
            if (blocked != null) {
              await tester.tap(pluginSwitch(blocked));
              await tester.pumpAndSettle();
              expect(repository.pluginSelectionCalls, isEmpty);
              expect(switchOn(tester, blocked), isFalse);
            }

            // A supported plugin, and one without flags, still turn on.
            final supported = provider == 'codex'
                ? codexOnlyRef
                : claudeOnlyRef;
            await tester.tap(
              pluginSwitch('plugin:market/${supported['pluginName']}'),
            );
            await tester.pumpAndSettle();
            expect(repository.pluginSelectionCalls.single.selections, {
              ...projected,
              'pluginRefs': [supported],
            });
            expect(find.textContaining('Could not change'), findsNothing);
            expect(tester.takeException(), isNull);
          },
        );
      }

      testWidgets(
        'CAN-3922 a selected plugin the provider does not support stays '
        'removable and cannot turn on again',
        (tester) async {
          final repository = FakeRemoteControlRepository()
            ..pluginCatalog = providerCatalog
            ..snapshotBuilder = () => withSelections({
              ...projected,
              'pluginRefs': [codexOnlyRef],
            });
          await pumpWorktree(tester, repository: repository);
          await openPlugins(tester);
          const id = 'plugin:market/codex-tools';
          expect(switchOn(tester, id), isTrue);
          expect(switchEnabled(tester, id), isTrue);
          expect(rowText(id, unsupportedReason), findsOneWidget);

          await tester.tap(pluginSwitch(id));
          await tester.pumpAndSettle();
          expect(repository.pluginSelectionCalls.single.selections, {
            ...projected,
            'pluginRefs': <Object?>[],
          });
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [RemoteCommandCompletedEvent(commandId: 'fake-cmd-1')],
              nextCursor: 1,
            ),
          );
          repository.snapshotBuilder = () => withSelections(projected);
          await tester.pumpAndSettle();
          expect(switchOn(tester, id), isFalse);
          expect(switchEnabled(tester, id), isFalse);

          await closeSheet(tester);
          await openPlugins(tester);
          expect(switchOn(tester, id), isFalse);
          expect(switchEnabled(tester, id), isFalse);
          await tester.tap(pluginSwitch(id));
          await tester.pumpAndSettle();
          expect(repository.pluginSelectionCalls, hasLength(1));
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 at 390 px and 2x text both sheets keep 48 px rows',
        (tester) async {
          tester.view.physicalSize = const Size(390, 844);
          tester.view.devicePixelRatio = 1;
          tester.platformDispatcher.textScaleFactorTestValue = 2;
          addTearDown(tester.view.reset);
          addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
          final repository = FakeRemoteControlRepository()
            ..supportsChatAttachments = true
            ..pluginCatalog = {
              ...catalog,
              'plugins': [
                {
                  ...githubRef,
                  'name':
                      'GitHub pull requests, issues, checks, and release '
                      'automation for every repository',
                  'description': 'A long description ' * 6,
                },
              ],
            }
            ..snapshotBuilder = () => withSelections(projected);
          final vm = await connected(tester, repository);
          await tester.pumpWidget(
            host(
              vm,
              RemoteChatScreen.worktree(
                worktree: vm.worktreesFor('ws-1').single,
                attachmentPicker: FakeAttachmentPicker(),
              ),
            ),
          );
          await tester.pumpAndSettle();

          await openActions(tester);
          for (final id in [
            'attach-camera',
            'attach-library',
            'attach-files',
            'plugins',
            'plan',
          ]) {
            final row = find.byKey(ValueKey('composer-action-$id'));
            expect(tester.getSize(row).height, greaterThanOrEqualTo(48));
            expect(tester.getRect(row).right, lessThanOrEqualTo(390));
          }
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pumpAndSettle();
          final row = pluginSwitch('plugin:market/github');
          await tester.scrollUntilVisible(
            row,
            48,
            scrollable: find.descendant(
              of: find.byKey(const ValueKey('composer-plugins-list')),
              matching: find.byType(Scrollable),
            ),
          );
          expect(tester.getSize(row).height, greaterThanOrEqualTo(48));
          expect(
            find.textContaining('release automation for every repository'),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3922 a malformed projected selection keeps the + sheet usable '
        'and writes no plugins',
        (tester) async {
          final repository = FakeRemoteControlRepository()
            ..pluginCatalog = catalog
            ..snapshotBuilder = () =>
                withSelections(const {'pluginRefs': 'oops'});
          await pumpWorktree(tester, repository: repository);

          await openActions(tester);
          expect(tester.takeException(), isNull);
          expect(
            find.byKey(const ValueKey('composer-action-attach-library')),
            findsOneWidget,
          );
          await closeSheet(tester);

          await openPlugins(tester);
          expect(find.text("Couldn't load plugins."), findsOneWidget);
          expect(pluginSwitch('plugin:market/github'), findsNothing);
          await closeSheet(tester);

          await openActions(tester);
          await tester.tap(find.byKey(const ValueKey('composer-action-plan')));
          await tester.pumpAndSettle();
          expect(repository.lastSetPlanMode, isTrue);
          expect(repository.pluginSelectionCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('CAN-3922 a new chat sets plugins before its first message', (
        tester,
      ) async {
        final repository = FakeRemoteControlRepository()
          ..pluginCatalog = catalog
          ..snapshotBuilder = () => withSelections(null);
        final vm = await pumpWorktree(tester, repository: repository);
        await tester.startNewChatFromSheet();
        await tester.pumpAndSettle();
        final mintedId = repository.createChatTabTargets.single.chatId!;

        // Until the desktop projects the tab its selection is unknown, so
        // the sheet waits for it and nothing can be written.
        await openActions(tester);
        await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.text("Couldn't load plugins."), findsNothing);
        expect(pluginSwitch('plugin:market/github'), findsNothing);
        expect(repository.pluginSelectionCalls, isEmpty);

        repository.snapshotBuilder = () {
          final base = withSelections(null);
          return RemoteSessionSnapshot(
            workspaces: base.workspaces,
            worktrees: base.worktrees,
            standaloneChats: base.standaloneChats,
            chatSummaries: [
              ...base.chatSummaries,
              RemoteChatSummary(
                chatId: mintedId,
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'New chat',
                providerType: 'claude',
              ),
            ],
            chatMessages: base.chatMessages,
          );
        };
        await tester.runAsync(vm.refresh);
        await tester.pumpAndSettle();

        await tester.tap(pluginSwitch('plugin:market/github'));
        await tester.pumpAndSettle();
        final call = repository.pluginSelectionCalls.single;
        expect(call.target.chatId, mintedId);
        expect(call.selections, {
          'collectionIds': <Object?>[],
          'skillRefs': <Object?>[],
          'pluginRefs': [githubRef],
        });
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      group('CAN-3922 a worktree before its first message', () {
        RemoteSessionSnapshot noTabs({RemoteChatSummary? created}) {
          final base = worktreeSnapshot(providerType: 'claude');
          return RemoteSessionSnapshot(
            workspaces: base.workspaces,
            worktrees: base.worktrees,
            standaloneChats: base.standaloneChats,
            chatSummaries: [?created],
            chatMessages: const [],
          );
        }

        RemoteChatSummary createdTab(
          String chatId, {
          String providerType = 'claude',
          Map<String, Object?>? selections,
        }) => RemoteChatSummary(
          chatId: chatId,
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'New chat',
          providerType: providerType,
          pluginSelectionsDetail: selections,
        );

        /// Opens a worktree whose desktop reports no chat tabs, with a typed
        /// draft and one staged photo.
        Future<RemoteControlViewModel> pumpEmpty(
          WidgetTester tester,
          FakeRemoteControlRepository repository, {
          Map<String, dynamic> pluginCatalog = catalog,
        }) async {
          repository
            ..pluginCatalog = pluginCatalog
            ..snapshotBuilder = noTabs;
          final vm = await pumpWorktree(tester, repository: repository);
          repository.eventsController.add(
            const RemotePortalEventBatch(
              nextCursor: 1,
              events: [
                RemoteStateSnapshotEvent(
                  scope: 'worktree',
                  targetWorkspaceLocalId: 'ws-1',
                  targetWorktreeLocalId: 'wt-1',
                ),
              ],
            ),
          );
          await tester.runAsync(() => Future<void>.delayed(Duration.zero));
          await tester.pumpAndSettle();
          final picker =
              tester
                      .widget<RemoteChatScreen>(find.byType(RemoteChatScreen))
                      .attachmentPicker!
                  as FakeAttachmentPicker;
          picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('photo.png'),
          ]);
          await openActions(tester);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-attach-library')),
          );
          await tester.pumpAndSettle();
          await typeKeptDraft(tester);
          expect(repository.createChatTabTargets, isEmpty);
          return vm;
        }

        /// The desktop lists the tab the composer action created.
        Future<void> project(
          WidgetTester tester,
          RemoteControlViewModel vm,
          FakeRemoteControlRepository repository,
          String chatId, {
          String providerType = 'claude',
          Map<String, Object?>? selections,
        }) async {
          repository.snapshotBuilder = () => noTabs(
            created: createdTab(
              chatId,
              providerType: providerType,
              selections: selections,
            ),
          );
          await tester.runAsync(vm.refresh);
          await tester.pumpAndSettle();
        }

        /// Replaces the paired session, as a reconnect does.
        Future<void> replaceSession(
          WidgetTester tester,
          RemoteControlViewModel vm,
        ) async {
          await tester.runAsync(vm.disconnect);
          await tester.runAsync(() => vm.connect('654321'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
        }

        Future<void> tapPlugins(WidgetTester tester) async {
          await openActions(tester);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
        }

        void expectDraftKept(WidgetTester tester) {
          expect(draft(tester).text, 'Keep this draft');
          expect(find.text('photo.png'), findsOneWidget);
        }

        testWidgets(
          'CAN-3922 lists the attachment sources, Plugins, and Plan mode',
          (tester) async {
            await pumpEmpty(tester, FakeRemoteControlRepository());

            await openActions(tester);

            final rows = [
              'Take photo',
              'Photo library',
              'Files',
              'Plugins',
              'Plan mode',
            ].map((label) => tester.getTopLeft(find.text(label)).dy).toList();
            for (var i = 1; i < rows.length; i++) {
              expect(rows[i - 1], lessThan(rows[i]));
            }
            expect(tester.takeException(), isNull);
          },
        );

        testWidgets(
          'CAN-3922 Plugins creates the first chat tab and saves to it',
          (tester) async {
            final repository = FakeRemoteControlRepository();
            final vm = await pumpEmpty(tester, repository);

            await openActions(tester);
            await tester.tap(
              find.byKey(const ValueKey('composer-action-plugins')),
            );
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 300));
            final created = repository.createChatTabTargets.single;
            final chatId = created.chatId!;
            expect(chatId, isNotEmpty);
            expect(created.worktreeLocalId, 'wt-1');
            // The selection is unknown until the desktop lists the tab.
            expect(pluginSwitch('plugin:market/github'), findsNothing);

            await project(tester, vm, repository, chatId);
            await tester.tap(pluginSwitch('plugin:market/github'));
            await tester.pumpAndSettle();

            final call = repository.pluginSelectionCalls.single;
            expect(call.target.chatId, chatId);
            expect(call.selections, {
              'collectionIds': <Object?>[],
              'skillRefs': <Object?>[],
              'pluginRefs': [githubRef],
            });
            await closeSheet(tester);
            expect(repository.createChatTabTargets, hasLength(1));
            expect(repository.sendChatMessageCalls, isEmpty);
            expectDraftKept(tester);
            expect(tester.takeException(), isNull);
          },
        );

        testWidgets(
          'CAN-3922 Plan mode creates the first chat tab and turns plan mode '
          'on',
          (tester) async {
            final repository = FakeRemoteControlRepository();
            final vm = await pumpEmpty(tester, repository);

            await openActions(tester);
            await tester.tap(
              find.byKey(const ValueKey('composer-action-plan')),
            );
            await tester.pumpAndSettle();
            final chatId = repository.createChatTabTargets.single.chatId!;
            // No setter reaches a chat the desktop has not created yet.
            expect(repository.setPlanModeTargets, isEmpty);

            await project(tester, vm, repository, chatId);

            expect(repository.lastSetPlanMode, isTrue);
            expect(repository.setPlanModeTargets.single.chatId, chatId);
            expect(repository.createChatTabTargets, hasLength(1));
            expect(repository.sendChatMessageCalls, isEmpty);
            expectDraftKept(tester);
            expect(tester.takeException(), isNull);
          },
        );

        for (final (provider, blocked, allowed) in [
          ('claude', 'codex-tools', claudeOnlyRef),
          ('codex', 'claude-tools', codexOnlyRef),
        ]) {
          testWidgets(
            'CAN-3922 Plugins on the first $provider chat turns on only what '
            'its provider supports',
            (tester) async {
              final repository = FakeRemoteControlRepository();
              final vm = await pumpEmpty(
                tester,
                repository,
                pluginCatalog: providerCatalog,
              );

              await tapPlugins(tester);
              final chatId = repository.createChatTabTargets.single.chatId!;
              await project(
                tester,
                vm,
                repository,
                chatId,
                providerType: provider,
              );

              final blockedId = 'plugin:market/$blocked';
              expect(switchEnabled(tester, blockedId), isFalse);
              expect(rowText(blockedId, unsupportedReason), findsOneWidget);
              await tester.tap(pluginSwitch(blockedId));
              await tester.pumpAndSettle();
              expect(repository.pluginSelectionCalls, isEmpty);
              expect(switchOn(tester, blockedId), isFalse);

              await tester.tap(
                pluginSwitch('plugin:market/${allowed['pluginName']}'),
              );
              await tester.pumpAndSettle();
              final call = repository.pluginSelectionCalls.single;
              expect(call.target.chatId, chatId);
              expect(call.selections, {
                'collectionIds': <Object?>[],
                'skillRefs': <Object?>[],
                'pluginRefs': [allowed],
              });
              expect(tester.takeException(), isNull);
            },
          );
        }

        testWidgets(
          'CAN-3922 Plugins on the first chat keeps a selected plugin its '
          'provider cannot use removable, and it stays off after reopening',
          (tester) async {
            final repository = FakeRemoteControlRepository()
              ..setPluginSelectionsHandler = (_) async => 'plugins-1';
            final vm = await pumpEmpty(
              tester,
              repository,
              pluginCatalog: providerCatalog,
            );
            const id = 'plugin:market/codex-tools';
            const held = {
              'collectionIds': <Object?>[],
              'skillRefs': <Object?>[],
              'pluginRefs': [codexOnlyRef],
            };
            const removed = {
              'collectionIds': <Object?>[],
              'skillRefs': <Object?>[],
              'pluginRefs': <Object?>[],
            };

            await tapPlugins(tester);
            final chatId = repository.createChatTabTargets.single.chatId!;
            await project(tester, vm, repository, chatId, selections: held);
            expect(switchOn(tester, id), isTrue);
            expect(switchEnabled(tester, id), isTrue);
            expect(rowText(id, unsupportedReason), findsOneWidget);

            await tester.tap(pluginSwitch(id));
            await tester.pumpAndSettle();
            final call = repository.pluginSelectionCalls.single;
            expect(call.target.chatId, chatId);
            expect(call.selections, removed);
            repository.eventsController.add(
              const RemotePortalEventBatch(
                events: [RemoteCommandCompletedEvent(commandId: 'plugins-1')],
                nextCursor: 2,
              ),
            );
            await project(tester, vm, repository, chatId, selections: removed);
            expect(switchOn(tester, id), isFalse);
            expect(switchEnabled(tester, id), isFalse);
            await tester.tap(pluginSwitch(id));
            await tester.pumpAndSettle();
            expect(repository.pluginSelectionCalls, hasLength(1));

            await closeSheet(tester);
            await openPlugins(tester);
            expect(switchOn(tester, id), isFalse);
            expect(switchEnabled(tester, id), isFalse);
            expect(repository.createChatTabTargets, hasLength(1));
            expect(tester.takeException(), isNull);
          },
        );

        testWidgets(
          'CAN-3922 a session replaced while Plan mode creates the first '
          'chat reports it, and Plan mode works once the new session lists '
          'the tab',
          (tester) async {
            final repository = FakeRemoteControlRepository();
            final vm = await pumpEmpty(tester, repository);
            final submission = Completer<void>();
            repository.beforeCreateChatTabReturns = () => submission.future;

            await openActions(tester);
            await tester.tap(
              find.byKey(const ValueKey('composer-action-plan')),
            );
            await tester.pump();
            final chatId = repository.createChatTabTargets.single.chatId!;
            await replaceSession(tester, vm);
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 300));

            // The action ends while the old create is still unanswered.
            expect(submission.isCompleted, isFalse);
            expect(find.text('The chat could not be created.'), findsOneWidget);
            expect(repository.setPlanModeTargets, isEmpty);
            submission.complete();
            await tester.pumpAndSettle();
            expect(repository.setPlanModeTargets, isEmpty);
            // The snackbar times out before the user retries.
            await tester.pump(const Duration(seconds: 5));
            await tester.pumpAndSettle();

            // The desktop had received the create; the new session lists it.
            await project(tester, vm, repository, chatId);
            await openActions(tester);
            await tester.tap(
              find.byKey(const ValueKey('composer-action-plan')),
            );
            await tester.pumpAndSettle();

            expect(repository.setPlanModeTargets.single.chatId, chatId);
            expect(repository.lastSetPlanMode, isTrue);
            expect(repository.createChatTabTargets, hasLength(1));
            expect(repository.sendChatMessageCalls, isEmpty);
            expectDraftKept(tester);
            expect(tester.takeException(), isNull);
          },
        );

        for (final unanswered in [false, true]) {
          testWidgets('CAN-3922 a session replaced before the desktop '
              '${unanswered ? 'answers' : 'lists'} the first chat ends the '
              'Plugins wait, and Retry saves to the same tab', (tester) async {
            final repository = FakeRemoteControlRepository();
            final vm = await pumpEmpty(tester, repository);
            final submission = Completer<void>();
            if (unanswered) {
              repository.beforeCreateChatTabReturns = () => submission.future;
            }

            await tapPlugins(tester);
            final chatId = repository.createChatTabTargets.single.chatId!;
            expect(find.byType(CircularProgressIndicator), findsOneWidget);

            await replaceSession(tester, vm);
            expect(find.text("Couldn't load plugins."), findsOneWidget);
            expect(find.byType(CircularProgressIndicator), findsNothing);
            if (unanswered) {
              // The old session's create answers late and changes nothing.
              expect(submission.isCompleted, isFalse);
              repository.beforeCreateChatTabReturns = null;
              submission.complete();
              await tester.pumpAndSettle();
              expect(find.text("Couldn't load plugins."), findsOneWidget);
              expect(repository.pluginSelectionCalls, isEmpty);
            }

            await tester.tap(
              find.byKey(const ValueKey('composer-plugins-retry')),
            );
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 300));
            expect(
              repository.createChatTabTargets.map((target) => target.chatId),
              [chatId, chatId],
            );
            await project(tester, vm, repository, chatId);
            await tester.tap(pluginSwitch('plugin:market/github'));
            await tester.pumpAndSettle();

            final call = repository.pluginSelectionCalls.single;
            expect(call.target.chatId, chatId);
            expect(call.selections, {
              'collectionIds': <Object?>[],
              'skillRefs': <Object?>[],
              'pluginRefs': [githubRef],
            });
            await closeSheet(tester);
            expect(repository.sendChatMessageCalls, isEmpty);
            expectDraftKept(tester);
            expect(tester.takeException(), isNull);
          });
        }

        testWidgets('CAN-3922 typing /plan offers Plan mode', (tester) async {
          await pumpEmpty(tester, FakeRemoteControlRepository());
          final field = find.byKey(const ValueKey('composer-draft'));
          await tester.tap(field);
          await tester.enterText(field, '/pla');
          await tester.pumpAndSettle();

          expect(
            find.byKey(const ValueKey('composer-command-plan')),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        });

        testWidgets(
          'CAN-3922 a rejected first chat writes nothing and keeps the draft '
          'and attachments',
          (tester) async {
            final repository = FakeRemoteControlRepository();
            await pumpEmpty(tester, repository);

            await openActions(tester);
            await tester.tap(
              find.byKey(const ValueKey('composer-action-plan')),
            );
            await tester.pumpAndSettle();
            repository.eventsController.add(
              RemotePortalEventBatch(
                nextCursor: 2,
                events: [
                  RemoteCommandFailedEvent(
                    message: 'The tab could not be created.',
                    commandId: repository.createChatTabCommandIds.single,
                  ),
                ],
              ),
            );
            await tester.runAsync(() => Future<void>.delayed(Duration.zero));
            await tester.pumpAndSettle();

            expect(repository.setPlanModeTargets, isEmpty);
            expect(repository.pluginSelectionCalls, isEmpty);
            expect(find.text('The chat could not be created.'), findsOneWidget);
            expectDraftKept(tester);
            expect(tester.takeException(), isNull);
          },
        );

        testWidgets(
          'CAN-3922 a first chat rejected before its create returns writes '
          'nothing and keeps the draft and attachments',
          (tester) async {
            final repository = FakeRemoteControlRepository();
            await pumpEmpty(tester, repository);
            final submission = Completer<void>();
            repository.beforeCreateChatTabReturns = () => submission.future;

            await openActions(tester);
            await tester.tap(
              find.byKey(const ValueKey('composer-action-plan')),
            );
            await tester.pumpAndSettle();
            // The rejection arrives before the create's submit response, so
            // it is replayed while the command registers.
            repository.eventsController.add(
              RemotePortalEventBatch(
                nextCursor: 2,
                events: [
                  RemoteCommandFailedEvent(
                    message: 'The tab could not be created.',
                    commandId: repository.createChatTabCommandIds.single,
                  ),
                ],
              ),
            );
            await tester.runAsync(() => Future<void>.delayed(Duration.zero));
            await tester.pump();
            submission.complete();
            await tester.pumpAndSettle();

            expect(repository.setPlanModeTargets, isEmpty);
            expect(repository.pluginSelectionCalls, isEmpty);
            expect(find.text('The chat could not be created.'), findsOneWidget);
            expectDraftKept(tester);
            expect(tester.takeException(), isNull);
          },
        );
      });

      testWidgets('CAN-3922 typing /plugins offers the Plugins action', (
        tester,
      ) async {
        await pumpWorktree(tester);
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

    group('CAN-3925 Portal inventory', () {
      const review = {
        'name': 'review',
        'description': 'Review the diff',
        'insertText': '/review ',
        'section': 'discovered',
        'entryId': 'entry:command/review',
      };
      const releaseNotes = {
        'name': 'release-notes',
        'description': 'Draft release notes',
        'section': 'available',
        'entryId': 'entry:skill/release-notes',
        'requiresResolution': true,
      };
      const catalog = {
        'collections': [
          {'id': 'c1', 'name': 'Release kit', 'description': 'Shipping'},
        ],
        'plugins': [
          {
            'marketplaceId': 'market',
            'pluginName': 'github',
            'name': 'GitHub',
            'description': 'Pull requests and checks',
            'claudeSupported': true,
            'codexSupported': true,
          },
        ],
        'skills': <Object?>[],
        'mcpServers': <Object?>[],
      };
      const githubRef = {'marketplaceId': 'market', 'pluginName': 'github'};
      const kitOnly = <String, Object?>{
        'collectionIds': ['c1'],
        'skillRefs': <Object?>[],
        'pluginRefs': <Object?>[],
      };
      const withGithub = <String, Object?>{
        'collectionIds': ['c1'],
        'skillRefs': <Object?>[],
        'pluginRefs': [githubRef],
      };
      // The release notes row once its plugin is on.
      const enabledReleaseNotes = {
        'name': 'release-notes',
        'description': 'Draft release notes',
        'insertText': '/release-notes ',
        'section': 'discovered',
        'entryId': 'entry:skill/release-notes',
      };

      FakeRemoteControlRepository capable() => FakeRemoteControlRepository()
        ..supportsInvocableInventory = true
        ..invocables = [review, releaseNotes]
        ..pluginCatalog = catalog;

      RemoteSessionSnapshot standaloneSnapshot({
        String providerType = 'claude',
        String? model,
        Map<String, Object?>? selections,
      }) => RemoteSessionSnapshot(
        workspaces: const [],
        worktrees: const [],
        standaloneChats: [
          RemoteStandaloneChat.fromJson({
            'localId': 'chat-solo',
            'projectLocalId': 'ws-notes',
            'title': 'Notes',
            'providerType': providerType,
            'model':
                model ??
                (providerType == 'codex' ? 'gpt-5-codex' : 'claude-sonnet'),
            'pluginSelectionsDetail': ?selections,
          }),
        ],
      );

      // The worktree chat as the desktop projects it with [selections].
      RemoteSessionSnapshot worktreeWithSelections(
        Map<String, Object?> selections,
      ) {
        final base = worktreeSnapshot(providerType: 'claude');
        final summary = base.chatSummaries.single;
        return base.copyWith(
          chatSummaries: [
            RemoteChatSummary(
              chatId: summary.chatId,
              scope: summary.scope,
              workspaceLocalId: summary.workspaceLocalId,
              worktreeLocalId: summary.worktreeLocalId,
              title: summary.title,
              active: true,
              providerType: summary.providerType,
              model: summary.model,
              modelLabel: summary.modelLabel,
              availableModels: summary.availableModels,
              modelCatalogProjected: true,
              pluginSelectionsDetail: selections,
            ),
          ],
        );
      }

      Future<RemoteControlViewModel> pumpWorktree(
        WidgetTester tester,
        FakeRemoteControlRepository repository, {
        String providerType = 'claude',
      }) async {
        usePhoneViewport(tester);
        repository.snapshotBuilder ??= () =>
            worktreeSnapshot(providerType: providerType);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        return vm;
      }

      Future<RemoteControlViewModel> pumpStandalone(
        WidgetTester tester,
        FakeRemoteControlRepository repository, {
        String providerType = 'claude',
        Map<String, Object?>? selections,
      }) async {
        usePhoneViewport(tester);
        repository.snapshotBuilder ??= () => standaloneSnapshot(
          providerType: providerType,
          selections: selections,
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.standalone(
              standaloneChat: vm.standaloneChatsFor('ws-notes').single,
            ),
          ),
        );
        await tester.pumpAndSettle();
        return vm;
      }

      TextEditingController draft(WidgetTester tester) => tester
          .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
          .controller!;

      Future<void> typeDraft(WidgetTester tester, String text) async {
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.tap(field);
        await tester.enterText(field, text);
        await tester.pumpAndSettle();
      }

      Future<void> scrollTo(WidgetTester tester, String key) =>
          tester.scrollUntilVisible(
            find.byKey(ValueKey(key)),
            48,
            scrollable: find.descendant(
              of: find.byKey(const ValueKey('composer-command-list')),
              matching: find.byType(Scrollable),
            ),
          );

      Future<void> openActions(WidgetTester tester) async {
        await tester.tap(find.byTooltip('Add files and more'));
        await tester.pumpAndSettle();
      }

      Finder pluginsCount(String count) => find.descendant(
        of: find.byKey(const ValueKey('composer-action-plugins')),
        matching: find.text(count),
      );

      Finder pluginSwitch(String id) =>
          find.byKey(ValueKey('composer-plugin-$id'));

      Future<void> closeSheet(WidgetTester tester) async {
        Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
        await tester.pumpAndSettle();
      }

      List<Map<String, dynamic>> calls(
        FakeRemoteControlRepository repository,
        String type,
      ) => [
        for (final call in repository.invocableCalls)
          if (call['type'] == type) call,
      ];

      testWidgets('CAN-3925 a capable host lists Available to enable last in a '
          'worktree chat', (tester) async {
        final repository = capable();
        await pumpWorktree(tester, repository);

        await typeDraft(tester, '/');

        expect(repository.slashCommandCalls, isEmpty);
        expect(repository.invocableCalls, hasLength(1));
        await scrollTo(tester, 'composer-command-available-release-notes');
        expect(repository.invocableCalls.single, {
          'type': 'portal.editor.list_invocables',
          'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
          'payload': {
            'target': {
              'kind': 'worktree',
              'projectId': 'ws-1',
              'worktreeId': 'wt-1',
              'chatId': 'chat-1',
            },
          },
        });
        final skills = tester.getTopLeft(find.text('Skills and commands'));
        final available = tester.getTopLeft(find.text('Available to enable'));
        expect(skills.dy, lessThan(available.dy));
        expect(
          find.byKey(const ValueKey('composer-command-skills-review')),
          findsOneWidget,
        );
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'CAN-3925 an available row resolves, inserts the returned text, and '
        'the chat shows the new selection',
        (tester) async {
          final repository = capable()
            ..resolveInvocableHandler = (payload) async =>
                const RemotePortalCommandResult(
                  commandId: 'resolve-1',
                  result: {
                    'insertText': '/release-kit:release-notes ',
                    'invocationKey': 'release-kit:release-notes',
                  },
                );
          final vm = await pumpWorktree(tester, repository);

          await typeDraft(tester, 'Write /rel');
          expect(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
            findsOneWidget,
          );
          await tester.tap(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
          );
          await tester.pumpAndSettle();

          expect(calls(repository, 'portal.editor.resolve_invocable'), [
            {
              'type': 'portal.editor.resolve_invocable',
              'target': {'workspaceLocalId': 'ws-1', 'worktreeLocalId': 'wt-1'},
              'payload': {
                'target': {
                  'kind': 'worktree',
                  'projectId': 'ws-1',
                  'worktreeId': 'wt-1',
                  'chatId': 'chat-1',
                },
                'entryId': 'entry:skill/release-notes',
              },
            },
          ]);
          expect(draft(tester).text, 'Write /release-kit:release-notes ');
          expect(
            find.byKey(const ValueKey('composer-command-list')),
            findsNothing,
          );

          // The desktop re-projects the chat with the enabled item.
          repository.snapshotBuilder = () => worktreeWithSelections(kitOnly);
          await tester.runAsync(vm.refresh);
          await tester.pumpAndSettle();
          await openActions(tester);
          expect(pluginsCount('1'), findsOneWidget);
          await closeSheet(tester);

          // The next list reflects the new selection.
          await typeDraft(tester, '/');
          expect(
            calls(repository, 'portal.editor.list_invocables'),
            hasLength(2),
          );
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3925 a resolve failure shows the error and keeps the draft',
        (tester) async {
          final repository = capable()
            ..resolveInvocableHandler = (_) async =>
                throw const RemoteControlException('Not available.');
          await pumpWorktree(tester, repository);

          await typeDraft(tester, 'Write /rel');
          final before = draft(tester).value;
          expect(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
            findsOneWidget,
          );
          await tester.tap(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
          );
          await tester.pumpAndSettle();

          expect(
            find.text(
              'Could not enable that item. Try again or use the Plugins '
              'picker.',
            ),
            findsOneWidget,
          );
          expect(draft(tester).value, before);
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('CAN-3925 an older host keeps discovered slash commands in a '
          'worktree chat', (tester) async {
        final repository = capable()
          ..supportsInvocableInventory = false
          ..slashCommands = [
            {'name': 'review', 'description': 'Review the diff'},
          ];
        await pumpWorktree(tester, repository);

        await typeDraft(tester, '/rev');

        expect(repository.invocableCalls, isEmpty);
        expect(
          repository.slashCommandCalls.single['type'],
          'portal.editor.list_slash_commands',
        );
        expect(
          find.byKey(const ValueKey('composer-command-skills-review')),
          findsOneWidget,
        );
        expect(find.text('Available to enable'), findsNothing);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'CAN-3925 a capable host lists host rows in a standalone chat',
        (tester) async {
          final repository = capable();
          await pumpStandalone(tester, repository);

          await typeDraft(tester, '/');
          expect(repository.invocableCalls, hasLength(1));
          await scrollTo(tester, 'composer-command-available-release-notes');

          expect(repository.invocableCalls.single, {
            'type': 'portal.editor.list_invocables',
            'target': {'standaloneChatLocalId': 'chat-solo'},
            'payload': {
              'target': {
                'kind': 'standalone',
                'projectLocalId': 'ws-notes',
                'chatId': 'chat-solo',
              },
            },
          });
          expect(
            find.byKey(const ValueKey('composer-command-skills-review')),
            findsOneWidget,
          );
          expect(
            find.byKey(const ValueKey('composer-command-model')),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
        },
      );

      // Like the desktop, which lists the chat's own harness and rejects a
      // request for another provider.
      FakeRemoteControlRepository harnessChecking() {
        RemotePortalCommandResult answer(
          Map<String, dynamic> payload,
          Map<String, dynamic> result,
        ) => switch (payload['providerType']) {
          null || 'claude' => RemotePortalCommandResult(
            commandId: 'answer',
            result: result,
          ),
          _ => const RemotePortalCommandResult(
            commandId: 'rejected',
            error: 'providerType does not match the chat.',
          ),
        };
        final repository = capable();
        repository.listInvocablesHandler = (payload) async => answer(payload, {
          'commands': [review, releaseNotes],
          'stale': false,
          'rebuilding': false,
        });
        repository.resolveInvocableHandler = (payload) async =>
            answer(payload, {
              'insertText': '/release-kit:release-notes ',
              'invocationKey': 'release-kit:release-notes',
            });
        return repository;
      }

      for (final standalone in [false, true]) {
        testWidgets(
          'CAN-3925 an Ollama ${standalone ? 'standalone' : 'worktree'} chat '
          'lists and resolves rows for the harness the desktop picks',
          (tester) async {
            final repository = harnessChecking();
            if (standalone) {
              await pumpStandalone(
                tester,
                repository
                  ..snapshotBuilder = () => standaloneSnapshot(
                    providerType: 'ollama',
                    model: ollamaModel.id,
                  ),
              );
            } else {
              repository.snapshotBuilder = () => worktreeSnapshot(
                providerType: 'ollama',
                model: ollamaModel.id,
                modelLabel: ollamaModel.label,
                availableModels: [...models, ollamaModel],
              );
              await pumpWorktree(tester, repository);
            }

            await typeDraft(tester, 'Write /rel');
            final available = find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            );
            expect(available, findsOneWidget);
            await tester.tap(available);
            await tester.pumpAndSettle();

            expect(repository.invocableCalls.map((call) => call['type']), [
              'portal.editor.list_invocables',
              'portal.editor.resolve_invocable',
            ]);
            for (final call in repository.invocableCalls) {
              expect(call['payload'], isNot(contains('providerType')));
            }
            expect(draft(tester).text, 'Write /release-kit:release-notes ');
            expect(
              find.text(
                'Could not enable that item. Try again or use the Plugins '
                'picker.',
              ),
              findsNothing,
            );
            expect(tester.takeException(), isNull);
          },
        );
      }

      testWidgets(r'CAN-3925 dollar opens host rows only in a Codex '
          'standalone chat', (tester) async {
        await pumpStandalone(tester, capable(), providerType: 'codex');
        await typeDraft(tester, r'$rev');
        expect(
          find.byKey(const ValueKey('composer-command-skills-review')),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();

        final claude = capable();
        await pumpStandalone(tester, claude);
        await typeDraft(tester, r'$rev');
        expect(
          find.byKey(const ValueKey('composer-command-list')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'CAN-3925 a standalone Plugins row counts the projected selection and '
        'a turned-on plugin persists after reopening',
        (tester) async {
          final repository = capable();
          await pumpStandalone(tester, repository, selections: kitOnly);
          await typeDraft(tester, 'Keep this draft');
          final before = draft(tester).value;

          await openActions(tester);
          expect(pluginsCount('1'), findsOneWidget);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pumpAndSettle();
          expect(repository.pluginCatalogCalls.single, {
            'target': {'standaloneChatLocalId': 'chat-solo'},
            'projectId': 'ws-notes',
            'providerType': 'claude',
          });
          expect(
            tester.widget<SwitchListTile>(pluginSwitch('collection:c1')).value,
            isTrue,
          );

          await tester.tap(pluginSwitch('plugin:market/github'));
          await tester.pumpAndSettle();
          final call = repository.pluginSelectionCalls.single;
          expect(call.target, isA<RemoteStandaloneChatTarget>());
          expect(call.target.chatId, 'chat-solo');
          expect(call.selections, {
            ...kitOnly,
            'pluginRefs': [githubRef],
          });
          // The desktop commits the selection and re-projects the chat.
          final saved = {
            ...kitOnly,
            'pluginRefs': [githubRef],
          };
          repository.snapshotBuilder = () =>
              standaloneSnapshot(selections: saved);
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [RemoteCommandCompletedEvent(commandId: 'fake-cmd-1')],
              nextCursor: 1,
            ),
          );
          await tester.pumpAndSettle();
          expect(
            tester
                .widget<SwitchListTile>(pluginSwitch('plugin:market/github'))
                .value,
            isTrue,
          );
          await closeSheet(tester);
          expect(draft(tester).value.text, before.text);

          // Leave, then reopen the chat from a fresh session snapshot.
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
          final reopened = await connected(tester, repository);
          await tester.pumpWidget(
            host(
              reopened,
              RemoteChatScreen.standalone(
                standaloneChat: reopened.standaloneChatsFor('ws-notes').single,
              ),
            ),
          );
          await tester.pumpAndSettle();
          await openActions(tester);
          expect(pluginsCount('2'), findsOneWidget);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pumpAndSettle();
          expect(
            tester
                .widget<SwitchListTile>(pluginSwitch('plugin:market/github'))
                .value,
            isTrue,
          );
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3925 an older host keeps standalone chats on built-ins without '
        'Plugins',
        (tester) async {
          final repository = capable()..supportsInvocableInventory = false;
          await pumpStandalone(tester, repository, selections: kitOnly);

          await typeDraft(tester, '/');
          expect(
            find.byKey(const ValueKey('composer-command-model')),
            findsOneWidget,
          );
          expect(find.text('Skills and commands'), findsNothing);
          // Without the Plugins row a standalone chat has nothing to add, so
          // the `+` button is hidden.
          await typeDraft(tester, '');
          expect(find.byTooltip('Add files and more'), findsNothing);
          expect(find.text('Plugins'), findsNothing);
          expect(repository.invocableCalls, isEmpty);
          expect(repository.slashCommandCalls, isEmpty);
          expect(repository.pluginCatalogCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );

      for (final standalone in [false, true]) {
        testWidgets('CAN-3925 a Plugins change lists the rows again in a '
            '${standalone ? 'standalone' : 'worktree'} chat', (tester) async {
          final repository = capable()
            ..setPluginSelectionsHandler = (_) async => 'plugins-1';
          final vm = standalone
              ? await pumpStandalone(tester, repository, selections: kitOnly)
              : await pumpWorktree(
                  tester,
                  repository
                    ..snapshotBuilder = () => worktreeWithSelections(kitOnly),
                );
          await typeDraft(tester, '/rel');
          expect(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
            findsOneWidget,
          );
          await typeDraft(tester, '');

          // Turning the plugin on moves its row out of Available to enable.
          repository.invocables = [review, enabledReleaseNotes];
          await openActions(tester);
          await tester.tap(
            find.byKey(const ValueKey('composer-action-plugins')),
          );
          await tester.pumpAndSettle();
          await tester.tap(pluginSwitch('plugin:market/github'));
          await tester.pumpAndSettle();
          expect(repository.pluginSelectionCalls.single.selections, withGithub);
          // The desktop commits the selection and re-projects the chat.
          repository.snapshotBuilder = standalone
              ? () => standaloneSnapshot(selections: withGithub)
              : () => worktreeWithSelections(withGithub);
          repository.eventsController.add(
            const RemotePortalEventBatch(
              events: [RemoteCommandCompletedEvent(commandId: 'plugins-1')],
              nextCursor: 1,
            ),
          );
          await tester.pumpAndSettle();
          await tester.runAsync(vm.refresh);
          await tester.pumpAndSettle();
          await closeSheet(tester);

          await typeDraft(tester, '/rel');
          expect(
            calls(repository, 'portal.editor.list_invocables'),
            hasLength(2),
          );
          expect(
            find.byKey(const ValueKey('composer-command-skills-release-notes')),
            findsOneWidget,
          );
          expect(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
            findsNothing,
          );
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(tester.takeException(), isNull);
        });
      }

      testWidgets(
        'CAN-3925 a list answered after a new pairing with the same session '
        'id is dropped',
        (tester) async {
          final stale = Completer<RemotePortalCommandResult>();
          final repository = capable()
            ..listInvocablesHandler = (_) => stale.future;
          final vm = await pumpWorktree(tester, repository);
          final field = find.byKey(const ValueKey('composer-draft'));
          await tester.tap(field);
          await tester.enterText(field, '/rel');
          await tester.pump();
          expect(repository.invocableCalls, hasLength(1));

          // Pair again; the server keeps its session id.
          repository
            ..listInvocablesHandler = null
            ..invocables = [review, enabledReleaseNotes];
          await tester.runAsync(() => vm.connect('654321'));
          await tester.pump();
          stale.complete(
            const RemotePortalCommandResult(
              commandId: 'stale',
              result: {
                'commands': [review, releaseNotes],
                'stale': false,
                'rebuilding': false,
              },
            ),
          );
          await tester.pumpAndSettle();

          expect(
            calls(repository, 'portal.editor.list_invocables'),
            hasLength(2),
          );
          expect(
            find.byKey(const ValueKey('composer-command-skills-release-notes')),
            findsOneWidget,
          );
          expect(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
            findsNothing,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'CAN-3925 a resolve answered after a new pairing with the same '
        'session id leaves the draft unchanged',
        (tester) async {
          final pending = Completer<RemotePortalCommandResult>();
          final repository = capable()
            ..resolveInvocableHandler = (_) => pending.future;
          final vm = await pumpWorktree(tester, repository);
          await typeDraft(tester, 'Write /rel');
          final before = draft(tester).value;
          await tester.tap(
            find.byKey(
              const ValueKey('composer-command-available-release-notes'),
            ),
          );
          await tester.pump();
          expect(calls(repository, 'portal.editor.resolve_invocable'), [
            isNotNull,
          ]);

          // Pair again; the server keeps its session id.
          await tester.runAsync(() => vm.connect('654321'));
          await tester.pump();
          pending.complete(
            const RemotePortalCommandResult(
              commandId: 'resolve-1',
              result: {
                'insertText': '/release-kit:release-notes ',
                'invocationKey': 'release-kit:release-notes',
              },
            ),
          );
          await tester.pumpAndSettle();

          expect(draft(tester).value, before);
          expect(find.textContaining('Could not enable'), findsNothing);
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );
    });

    group('effort data from the desktop projection', () {
      /// A worktree chat built from raw wire JSON, so these cases exercise
      /// the real parser and the desktop's exact field shapes.
      RemoteSessionSnapshot wireSnapshot(Map<String, dynamic> summary) =>
          RemoteSessionSnapshot(
            workspaces: const [],
            worktrees: const [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: const [],
            chatSummaries: [
              RemoteChatSummary.fromJson({
                'chatId': 'chat-1',
                'scope': 'worktree',
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'title': 'Chat A',
                'active': true,
                'providerAvailability': {
                  'claude': true,
                  'codex': true,
                  'cursor': true,
                },
                ...summary,
              }),
            ],
          );

      Future<FakeRemoteControlRepository> pumpWire(
        WidgetTester tester,
        Map<String, dynamic> summary,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = (() => wireSnapshot(summary));
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        return repository;
      }

      Future<void> typeDraft(WidgetTester tester, String text) async {
        final field = find.byKey(const ValueKey('composer-draft'));
        await tester.tap(field);
        await tester.enterText(field, text);
        await tester.pumpAndSettle();
      }

      final trigger = find.byKey(const ValueKey('composer-thinking'));

      for (final (name, row) in const [
        (
          'canonical levels',
          {
            'supportedThinkingLevels': [
              'off',
              'low',
              'medium',
              'high',
              'xhigh',
              'max',
              'ultra',
            ],
            'thinkingLevels': [
              'off',
              'medium',
              'high',
              'xhigh',
              'max',
              'ultra',
            ],
          },
        ),
        (
          'legacy levels',
          {
            'thinkingLevels': ['off', 'low', 'medium', 'high'],
          },
        ),
      ]) {
        testWidgets('CAN4436 red: a desktop chat set to low shows Low from '
            '$name', (tester) async {
          final repository = await pumpWire(tester, {
            'providerType': 'claude',
            'model': 'opus[1m]',
            'modelLabel': 'Opus 5',
            'thinkingLevel': 'low',
            'availableModels': [
              {
                'id': 'opus[1m]',
                'label': 'Opus 5',
                'provider': 'claude',
                'kind': 'model',
                ...row,
              },
            ],
          });

          expect(
            find.descendant(of: trigger, matching: find.text('Low')),
            findsOneWidget,
          );
          expect(repository.lastSetThinkingLevel, isNull);
          expect(tester.takeException(), isNull);
        });
      }

      for (final (name, provider, row) in const [
        (
          'a canonical empty set over legacy levels',
          'claude',
          {
            'id': 'sonnet-no-think',
            'label': 'Sonnet',
            'provider': 'claude',
            'kind': 'model',
            'supportedThinkingLevels': <String>[],
            'thinkingLevels': ['off', 'medium', 'high'],
          },
        ),
        (
          'a Cursor row from an older host',
          'cursor',
          {
            'id': 'cursor-composer',
            'label': 'Composer',
            'provider': 'cursor',
            'kind': 'model',
            'thinkingLevels': <String>[],
          },
        ),
        // Claude and Codex fall back to nonempty provider levels, so only an
        // authoritative empty legacy set hides their effort.
        (
          'an empty legacy set on a Claude row',
          'claude',
          {
            'id': 'sonnet-legacy',
            'label': 'Sonnet',
            'provider': 'claude',
            'kind': 'model',
            'thinkingLevels': <String>[],
          },
        ),
        (
          'an empty legacy set on a Codex row',
          'codex',
          {
            'id': 'gpt-legacy',
            'label': 'GPT',
            'provider': 'codex',
            'kind': 'model',
            'thinkingLevels': <String>[],
          },
        ),
      ]) {
        testWidgets('CAN4436 red: $name hides effort and sends no level', (
          tester,
        ) async {
          final repository = await pumpWire(tester, {
            'providerType': provider,
            'model': row['id'],
            'modelLabel': row['label'],
            'thinkingLevel': 'off',
            'availableModels': [row],
          });

          expect(trigger, findsNothing);
          await typeDraft(tester, '/thinking');
          expect(
            find.byKey(const ValueKey('composer-command-thinking')),
            findsNothing,
          );
          await typeDraft(tester, 'keep going');
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();
          expect(
            repository.sendChatMessageCalls.single.options?.thinkingLevel,
            isNull,
          );
          expect(repository.lastSetThinkingLevel, isNull);
          expect(tester.takeException(), isNull);
        });
      }

      testWidgets('CAN4436 red: an Ultra fast chat shows its speed and '
          '/fast leaves it unchanged', (tester) async {
        final repository = await pumpWire(tester, {
          'providerType': 'codex',
          'model': 'gpt-5-codex',
          'modelLabel': 'GPT-5 Codex',
          'thinkingLevel': 'high',
          'fastMode': false,
          'speed': 'ultrafast',
          'availableModels': [
            {
              'id': 'gpt-5-codex',
              'label': 'GPT-5 Codex',
              'provider': 'codex',
              'kind': 'model',
              'thinkingLevels': ['off', 'medium', 'high', 'xhigh'],
            },
          ],
        });

        await typeDraft(tester, '/fast');
        final command = find.byKey(const ValueKey('composer-command-fast'));
        if (tester.any(command)) {
          await tester.tap(command);
          await tester.pumpAndSettle();
        }
        expect(repository.lastSetFastMode, isNull);

        final semantics = tester.ensureSemantics();
        expect(
          tester.getSemantics(trigger).label,
          contains('ultra fast mode on'),
        );
        semantics.dispose();
        expect(tester.takeException(), isNull);
      });

      List<String> sheetLevels(WidgetTester tester) => tester
          .widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel))
          .levels;

      for (final (name, model, provider, row, levels) in const [
        (
          'a Claude 5 chat offers None through Ultra',
          'opus[1m]',
          'claude',
          {
            'supportedThinkingLevels': [
              'off',
              'low',
              'medium',
              'high',
              'xhigh',
              'max',
              'ultra',
            ],
            'thinkingLevels': [
              'off',
              'medium',
              'high',
              'xhigh',
              'max',
              'ultra',
            ],
          },
          ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        ),
        (
          'a gpt-6-astra chat offers Low through Ultra without None',
          'gpt-6-astra',
          'codex',
          {
            'supportedThinkingLevels': [
              'low',
              'medium',
              'high',
              'xhigh',
              'max',
              'ultra',
            ],
            'thinkingLevels': ['medium', 'high', 'xhigh', 'max', 'ultra'],
          },
          ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        ),
        (
          'an older host that sends only thinkingLevels keeps them',
          'opus-legacy',
          'claude',
          {
            'thinkingLevels': [
              'off',
              'medium',
              'high',
              'xhigh',
              'max',
              'ultra',
            ],
          },
          ['off', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        ),
      ]) {
        testWidgets(name, (tester) async {
          final repository = await pumpWire(tester, {
            'providerType': provider,
            'model': model,
            'modelLabel': model,
            'thinkingLevel': 'high',
            'availableModels': [
              {
                'id': model,
                'label': model,
                'provider': provider,
                'kind': 'model',
                ...row,
              },
            ],
          });
          await openEffortSheet(tester);
          expect(sheetLevels(tester), levels);
          await landEffortSlider(tester, 'ultra');
          expect(repository.lastSetThinkingLevel, 'ultra');
          expect(tester.takeException(), isNull);
        });
      }

      for (final (provider, levels) in const [
        ('claude', ['off', 'medium', 'high', 'xhigh', 'max']),
        ('codex', ['off', 'medium', 'high', 'xhigh']),
      ]) {
        testWidgets('a $provider row without level data offers the provider '
            'levels', (tester) async {
          final repository = await pumpWire(tester, {
            'providerType': provider,
            'model': 'model-no-levels',
            'modelLabel': 'Model',
            'thinkingLevel': 'high',
            'availableModels': [
              {
                'id': 'model-no-levels',
                'label': 'Model',
                'provider': provider,
                'kind': 'model',
              },
            ],
          });
          await typeDraft(tester, '/thinking');
          expect(
            find.byKey(const ValueKey('composer-command-thinking')),
            findsOneWidget,
          );
          await typeDraft(tester, '');
          await openEffortSheet(tester);
          expect(sheetLevels(tester), levels);
          await landEffortSlider(tester, 'xhigh');
          expect(repository.lastSetThinkingLevel, 'xhigh');
          expect(tester.takeException(), isNull);
        });
      }

      testWidgets('a Codex-harness chat uses Codex levels for a gateway row', (
        tester,
      ) async {
        await pumpWire(tester, {
          'providerType': 'claude',
          'model': 'gateway-model',
          'modelLabel': 'Gateway model',
          'executionHarness': 'codex',
          'availableModels': [
            {
              'id': 'gateway-model',
              'label': 'Gateway model',
              'provider': 'claude',
              'kind': 'model',
            },
          ],
        });
        await openEffortSheet(tester);
        expect(sheetLevels(tester), ['off', 'medium', 'high', 'xhigh']);
      });

      testWidgets('a Codex-harness gateway chat opens dollar suggestions', (
        tester,
      ) async {
        final repository = await pumpWire(tester, {
          'providerType': 'claude',
          'model': 'gateway-model',
          'modelLabel': 'Gateway model',
          'executionHarness': 'codex',
          'availableModels': [
            {
              'id': 'gateway-model',
              'label': 'Gateway model',
              'provider': 'claude',
              'kind': 'model',
            },
          ],
        });
        repository.slashCommands = [
          {'name': 'review', 'description': 'Review the diff'},
        ];
        await typeDraft(tester, r'Use $rev');
        final row = find.byKey(
          const ValueKey('composer-command-skills-review'),
        );
        expect(row, findsOneWidget);
        await tester.tap(row);
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          r'Use $review ',
        );
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });

      testWidgets('viewing an Ultra fast chat changes nothing, even when '
          'Ultra fast arrives while the sheet is open', (tester) async {
        var speed = 'fast';
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = (() => wireSnapshot({
            'providerType': 'codex',
            'model': 'gpt-5-codex',
            'modelLabel': 'GPT-5 Codex',
            'thinkingLevel': 'high',
            'fastMode': speed == 'fast',
            'speed': speed,
            'availableModels': [
              {
                'id': 'gpt-5-codex',
                'label': 'GPT-5 Codex',
                'provider': 'codex',
                'kind': 'model',
              },
            ],
          }));
        usePhoneViewport(tester);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        await openEffortSheet(tester);
        final toggle = find.byKey(const ValueKey('effort-fast-mode'));
        expect(
          find.descendant(of: toggle, matching: find.byType(IconButton)),
          findsOneWidget,
        );

        speed = 'ultrafast';
        await tester.runAsync(vm.refresh);
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: toggle, matching: find.byType(IconButton)),
          findsNothing,
          reason: 'Ultra fast is read-only at once',
        );
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        await closeEffortSheet(tester);
        expect(repository.lastSetFastMode, isNull);
        expect(repository.lastSetThinkingLevel, isNull);
        expect(
          tester
              .widget<CanopyIcon>(
                find.byKey(const ValueKey('effort-trigger-bolt')),
              )
              .tint,
          AppColors.of(tester.element(trigger))['fg-special'],
        );

        // An untouched send carries no speed or level either.
        await tester.enterText(find.byType(TextField), 'keep going');
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();
        final options = repository.sendChatMessageCalls.single.options;
        expect(options?.thinkingLevel, isNull);
        expect(options?.fastMode, isNull);
        expect(repository.lastSetFastMode, isNull);
        expect(tester.takeException(), isNull);
      });

      testWidgets('Ultra fast from the desktop wins over a pending Fast '
          'choice, and nothing can step it down', (tester) async {
        var speed = 'standard';
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = (() => wireSnapshot({
            'providerType': 'codex',
            'model': 'gpt-5-codex',
            'modelLabel': 'GPT-5 Codex',
            'thinkingLevel': 'high',
            'fastMode': speed == 'fast',
            'speed': speed,
            'availableModels': [
              {
                'id': 'gpt-5-codex',
                'label': 'GPT-5 Codex',
                'provider': 'codex',
                'kind': 'model',
              },
            ],
          }));
        usePhoneViewport(tester);
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pumpAndSettle();
        ComposerControlsData controls() =>
            tester.widget<ChatInput>(find.byType(ChatInput)).controls!;

        // Turn Fast on. The desktop does not complete the command yet.
        await openEffortSheet(tester);
        final toggle = find.byKey(const ValueKey('effort-fast-mode'));
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(repository.setFastModeCommandIds, hasLength(1));
        expect(repository.lastSetFastMode, isTrue);
        expect(controls().speed, CanopyEffortSpeed.fast);
        // A callback that a route can still hold after the next projection.
        final heldToggle = controls().onToggleFast;

        // The desktop projects Ultra fast while the command is pending.
        speed = 'ultrafast';
        await tester.runAsync(vm.refresh);
        await tester.pumpAndSettle();
        expect(
          controls().speed,
          CanopyEffortSpeed.ultraFast,
          reason: 'Ultra fast wins over the pending Fast choice at once',
        );
        expect(
          find.descendant(of: toggle, matching: find.byType(IconButton)),
          findsNothing,
          reason: 'the open sheet shows Ultra fast read-only',
        );

        // The open sheet, the held callback and /fast change nothing.
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        heldToggle();
        await tester.pumpAndSettle();
        await closeEffortSheet(tester);
        await typeDraft(tester, '/fast');
        final command = find.byKey(const ValueKey('composer-command-fast'));
        if (tester.any(command)) {
          await tester.tap(command);
          await tester.pumpAndSettle();
        }
        expect(repository.setFastModeCommandIds, hasLength(1));
        expect(repository.lastSetFastMode, isTrue);

        // The late completion and a newer projection settle the choice.
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandCompletedEvent(
                commandId: repository.setFastModeCommandIds.single,
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();
        await tester.runAsync(vm.refresh);
        await tester.pumpAndSettle();
        expect(controls().speed, CanopyEffortSpeed.ultraFast);
        heldToggle();
        await tester.pumpAndSettle();
        expect(repository.setFastModeCommandIds, hasLength(1));
        expect(tester.takeException(), isNull);
      });
    });

    testWidgets(
      'standalone sends carry the shown level for the current model',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: const [],
          worktrees: const [],
          standaloneChats: [
            RemoteStandaloneChat(
              localId: 'chat-notes',
              projectLocalId: 'ws-notes',
              title: 'Planning',
              providerType: 'claude',
              model: 'claude-max',
              modelLabel: 'Claude Max',
              availableModels: ModelOption.listFromJson([
                {
                  'id': 'claude-max',
                  'label': 'Claude Max',
                  'provider': 'claude',
                  'kind': 'model',
                  'supportedThinkingLevels': ['off', 'medium', 'high', 'max'],
                },
                {
                  'id': 'codex-high',
                  'label': 'Codex High',
                  'provider': 'codex',
                  'kind': 'model',
                  'supportedThinkingLevels': ['off', 'medium', 'high'],
                },
                {
                  'id': 'cursor-composer',
                  'label': 'Cursor Composer',
                  'provider': 'cursor',
                  'kind': 'model',
                  'supportedThinkingLevels': <String>[],
                },
              ]),
              providerAvailability: const ProviderAvailability(
                claude: true,
                codex: true,
                cursor: true,
              ),
            ),
          ],
        );
        final vm = await connected(tester, repository);
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.standalone(
              standaloneChat: vm.standaloneChatsFor('ws-notes').single,
            ),
          ),
        );
        await tester.pumpAndSettle();

        Future<RemoteChatSendOptions?> send(String text) async {
          await tester.enterText(find.byType(TextField), text);
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pumpAndSettle();
          return repository.sendChatMessageCalls.last.options;
        }

        Future<void> pickModel(String id) async {
          await tester.tap(find.byKey(const ValueKey('composer-model')));
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(ValueKey('model-option-$id')));
          await tester.pumpAndSettle();
        }

        await chooseComposerEffort(tester, 'max');
        await pickModel('codex-high');
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('composer-thinking')),
            matching: find.text('High'),
          ),
          findsOneWidget,
        );
        expect((await send('first'))?.thinkingLevel, 'high');

        await pickModel('cursor-composer');
        expect(find.byKey(const ValueKey('composer-thinking')), findsNothing);
        expect((await send('second'))?.thinkingLevel, isNull);
        expect(repository.lastSetThinkingLevel, isNull);
        expect(tester.takeException(), isNull);
      },
    );
  });
}

final class _FailingTranscriptRepository extends FakeRemoteControlRepository {
  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    throw const RemoteControlException('Transcript unavailable.');
  }
}
