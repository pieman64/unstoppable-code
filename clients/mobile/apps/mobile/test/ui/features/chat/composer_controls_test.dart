import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/chat/widgets/new_chat_draft_pill.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';

import '../../../support/composer_driver.dart';

const _claude5 = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const _ultraFastHelp =
    'Fastest replies. Higher speeds may use more of your subscription '
    'allowance. Change it in the desktop app.';
const _urlLauncher = MethodChannel('plugins.flutter.io/url_launcher');

void main() {
  ComposerControlsData data({
    PlanModeControl? planMode,
    bool supportsFastMode = false,
    String providerType = 'claude',
    String level = 'off',
    List<String>? levels = _claude5,
    ValueChanged<String>? onSelectLevel,
    Future<bool> Function(String level)? selectLevel,
    CanopyEffortSpeed speed = CanopyEffortSpeed.regular,
    VoidCallback? onToggleFast,
    ValueChanged<String>? onSelectModel = _selectModel,
    String modelId = 'm1',
    String? chatId,
    String? lockedHarness,
    String? modelHarness,
  }) {
    return ComposerControlsData(
      providerType: providerType,
      lockedHarness: lockedHarness,
      modelLabel: 'Model',
      selectedModelId: modelId,
      availableModels: [
        ModelOption(
          id: 'm1',
          label: 'Model',
          provider: 'claude',
          harness: modelHarness,
          kind: 'model',
          available: true,
        ),
        ModelOption(
          id: 'm2',
          label: 'Other model',
          provider: 'claude',
          kind: 'model',
          available: true,
        ),
      ],
      providerAvailability: null,
      planMode: planMode,
      effort: levels == null
          ? null
          : EffortControl(
              level: level,
              levels: levels,
              chatId: chatId,
              onSelect:
                  selectLevel ??
                  (next) async {
                    onSelectLevel?.call(next);
                    return true;
                  },
            ),
      speed: speed,
      supportsFastMode: supportsFastMode,
      isRunning: false,
      onSelectModel: onSelectModel,
      onToggleFast: onToggleFast ?? () {},
      onStop: () {},
      catalogStatus: ModelCatalogStatus.loaded,
    );
  }

  Future<void> pump(
    WidgetTester tester,
    ComposerControlsData d, {
    ThemeData? theme,
    double textScale = 1,
  }) {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    return tester.pumpWidget(
      MaterialApp(
        theme: theme ?? AppTheme.light,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomLeft,
            child: ComposerToolbar(data: d),
          ),
        ),
      ),
    );
  }

  final trigger = find.byKey(const ValueKey('composer-thinking'));
  final sheet = find.byKey(const ValueKey('composer-effort-sheet'));
  final slider = find.byKey(const ValueKey('effort-slider'));

  Text headingOf(WidgetTester tester, String key) => tester.widget<Text>(
    find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(Text)),
  );
  String headingText(WidgetTester tester) =>
      headingOf(tester, 'effort-level').textSpan!.toPlainText();

  testWidgets('effort control is hidden when the model does not think', (
    tester,
  ) async {
    await pump(tester, data(levels: null));
    expect(trigger, findsNothing);
  });

  testWidgets('plan chip is hidden when no plan control is supplied', (
    tester,
  ) async {
    await pump(tester, data());
    expect(find.byKey(const ValueKey('composer-plan')), findsNothing);
  });

  testWidgets('the toolbar leaves plan mode to the + menu and context row', (
    tester,
  ) async {
    for (final enabled in [false, true]) {
      await pump(
        tester,
        data(
          planMode: PlanModeControl(enabled: enabled, onToggle: () {}),
        ),
      );
      expect(find.byKey(const ValueKey('composer-plan')), findsNothing);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('the trigger names the level with the desktop labels', (
    tester,
  ) async {
    for (final (level, label) in const [
      ('off', 'None'),
      ('low', 'Low'),
      ('medium', 'Medium'),
      ('high', 'High'),
      ('xhigh', 'Extra High'),
      ('max', 'Max'),
      ('ultra', 'Ultra'),
    ]) {
      await pump(tester, data(level: level));
      expect(
        find.descendant(of: trigger, matching: find.text(label)),
        findsOneWidget,
        reason: level,
      );
    }
  });

  testWidgets('the trigger opens the sheet; a drag previews and commits once', (
    tester,
  ) async {
    final selected = <String>[];
    await pump(tester, data(level: 'low', onSelectLevel: selected.add));

    await tester.tap(trigger);
    await tester.pumpAndSettle();
    expect(sheet, findsOneWidget);
    expect(headingText(tester), 'Effort  Low');
    expect(tester.widget<Slider>(slider).divisions, _claude5.length - 1);

    // Drag from the thumb to the far end; the heading follows the drag.
    final rect = tester.getRect(slider);
    final gesture = await tester.startGesture(
      Offset(rect.left + 30, rect.center.dy),
    );
    await gesture.moveTo(Offset(rect.center.dx, rect.center.dy));
    await tester.pump();
    expect(selected, isEmpty, reason: 'a drag only previews');
    expect(headingText(tester), isNot('Effort  Low'));
    await gesture.moveTo(Offset(rect.right - 4, rect.center.dy));
    await tester.pump();
    expect(headingText(tester), 'Effort  Ultra');
    await gesture.up();
    await tester.pumpAndSettle();
    expect(selected, ['ultra'], reason: 'the drag lands once');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a landed level stays shown until the host applies it', (
    tester,
  ) async {
    // The host applies the pick, which reaches the sheet a frame later.
    var level = 'low';
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => Align(
              alignment: Alignment.bottomLeft,
              child: ComposerToolbar(
                data: data(
                  level: level,
                  onSelectLevel: (next) => setState(() => level = next),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await openEffortSheet(tester);
    final rect = tester.getRect(slider);
    final gesture = await tester.startGesture(
      Offset(rect.left + 30, rect.center.dy),
    );
    await gesture.moveTo(Offset(rect.right - 4, rect.center.dy));
    await tester.pump();
    await gesture.up();
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
      expect(headingText(tester), 'Effort  Ultra', reason: 'frame $frame');
      expect(
        tester.widget<Slider>(slider).value,
        _claude5.length - 1,
        reason: 'frame $frame',
      );
    }
    await tester.pumpAndSettle();
    expect(level, 'ultra');
    expect(headingText(tester), 'Effort  Ultra');
  });

  testWidgets('only the latest refused level shows the host level again', (
    tester,
  ) async {
    // CAN-4436 review: the host level never changes here, as when a refusal
    // lands in the same frame as the choice. A superseded choice settles
    // after its successor and must not drop the newer preview.
    final answers = <Completer<bool>>[];
    await pump(
      tester,
      data(
        level: 'low',
        selectLevel: (_) {
          final answer = Completer<bool>();
          answers.add(answer);
          return answer.future;
        },
      ),
    );
    await openEffortSheet(tester);
    Future<void> refuse(int index) async {
      answers[index].complete(false);
      await tester.pumpAndSettle();
    }

    await landEffortSlider(tester, 'high');
    await landEffortSlider(tester, 'max');
    await refuse(0);
    expect(headingText(tester), 'Effort  Max', reason: 'High was superseded');

    await landEffortSlider(tester, 'high');
    await refuse(1);
    expect(headingText(tester), 'Effort  High', reason: 'Max was superseded');

    // The same level again: the earlier High's refusal is still stale.
    await landEffortSlider(tester, 'high');
    await refuse(2);
    expect(headingText(tester), 'Effort  High');

    // A drag that starts while High is pending keeps its own preview.
    final drag = tester.widget<Slider>(slider);
    drag.onChangeStart!(drag.value);
    drag.onChanged!(_claude5.indexOf('medium').toDouble());
    await tester.pump();
    await refuse(3);
    expect(headingText(tester), 'Effort  Medium');
    expect(answers, hasLength(4), reason: 'the drag has not landed');

    drag.onChangeEnd!(_claude5.indexOf('medium').toDouble());
    await tester.pumpAndSettle();
    await refuse(4);
    expect(headingText(tester), 'Effort  Low');
    expect(tester.widget<Slider>(slider).value, _claude5.indexOf('low'));
    expect(tester.takeException(), isNull);
  });

  // CAN-4436 published review: the host changes its level or its levels while
  // a real drag is in progress, as when an older pending choice is rolled
  // back. The heading must name the level that the release sends.
  group('host data that changes during a drag', () {
    late String chat;
    late String model;
    late String level;
    late List<String>? levels;
    late StateSetter setHost;
    late List<String> selected;

    Future<void> pumpHost(WidgetTester tester, {required String start}) async {
      chat = 'chat-1';
      model = 'm1';
      level = start;
      levels = _claude5;
      selected = [];
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                setHost = setState;
                return Align(
                  alignment: Alignment.bottomLeft,
                  child: ComposerToolbar(
                    data: data(
                      chatId: chat,
                      modelId: model,
                      level: level,
                      levels: levels,
                      onSelectLevel: selected.add,
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      );
      await openEffortSheet(tester);
    }

    // Starts a real drag at None and moves it until the heading names
    // [target].
    Future<TestGesture> dragTo(WidgetTester tester, String target) async {
      final rect = tester.getRect(slider);
      final start = Offset(rect.left + 2, rect.center.dy);
      final gesture = await tester.startGesture(start);
      await gesture.moveTo(start + const Offset(40, 0));
      await gesture.moveTo(start);
      await tester.pump();
      expect(headingText(tester), 'Effort  None', reason: 'the drag is down');
      for (var x = rect.left + 2; x < rect.right; x += 2) {
        await gesture.moveTo(Offset(x, rect.center.dy));
        await tester.pump();
        if (headingText(tester) == 'Effort  ${canopyEffortLabel(target)}') {
          return gesture;
        }
      }
      fail('the drag never reached $target');
    }

    Future<void> changeHost(
      WidgetTester tester, {
      String? toChat,
      String? toModel,
      String? toLevel,
      List<String>? toLevels,
      bool hide = false,
    }) async {
      setHost(() {
        chat = toChat ?? chat;
        model = toModel ?? model;
        level = toLevel ?? level;
        levels = hide ? null : toLevels ?? levels;
      });
      // The sheet sees host data a frame after the toolbar does.
      await tester.pump();
      await tester.pump();
    }

    for (final target in ['max', 'high']) {
      testWidgets('a rollback to Medium keeps a drag on $target', (
        tester,
      ) async {
        // High is the older pending choice that the host shows. The drag on
        // High is a retry of the choice that the host is about to roll back.
        await pumpHost(tester, start: 'high');
        final gesture = await dragTo(tester, target);
        await changeHost(tester, toLevel: 'medium');
        final label = 'Effort  ${canopyEffortLabel(target)}';
        expect(headingText(tester), label, reason: 'the drag is still down');
        expect(tester.widget<Slider>(slider).value, _claude5.indexOf(target));

        await gesture.up();
        await tester.pumpAndSettle();
        expect(selected, [target], reason: 'the release sends what it shows');
        expect(headingText(tester), label);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a press that holds the thumb keeps its level', (tester) async {
      // The slider's sequence for a press on its thumb without a move: start
      // and end on the thumb's value, with no change between them.
      await pumpHost(tester, start: 'high');
      final held = tester.widget<Slider>(slider);
      held.onChangeStart!(held.value);
      await changeHost(tester, toLevel: 'medium');
      expect(headingText(tester), 'Effort  High', reason: 'the press is down');
      expect(tester.widget<Slider>(slider).value, _claude5.indexOf('high'));

      held.onChangeEnd!(held.value);
      await tester.pumpAndSettle();
      expect(selected, ['high'], reason: 'the release sends what it shows');
      expect(headingText(tester), 'Effort  High');
    });

    testWidgets('a drag back to the rolled-back level sends nothing', (
      tester,
    ) async {
      await pumpHost(tester, start: 'high');
      final gesture = await dragTo(tester, 'medium');
      await changeHost(tester, toLevel: 'medium');
      expect(headingText(tester), 'Effort  Medium');
      await gesture.up();
      await tester.pumpAndSettle();
      expect(selected, isEmpty, reason: 'the host is already on Medium');
      expect(headingText(tester), 'Effort  Medium');
    });

    testWidgets('new levels end the drag, and its release sends nothing', (
      tester,
    ) async {
      await pumpHost(tester, start: 'off');
      final gesture = await dragTo(tester, 'ultra');
      await changeHost(tester, toLevels: const ['off', 'low', 'medium']);
      expect(headingText(tester), 'Effort  None');
      expect(tester.widget<Slider>(slider).value, 0);

      // Moves after the change do not start a new preview.
      final rect = tester.getRect(slider);
      await gesture.moveTo(Offset(rect.right - 4, rect.center.dy));
      await tester.pump();
      expect(headingText(tester), 'Effort  None');
      await gesture.up();
      await tester.pumpAndSettle();
      expect(selected, isEmpty, reason: 'None was shown; nothing was chosen');
      expect(headingText(tester), 'Effort  None');

      // The next drag works on the new levels.
      final next = await dragTo(tester, 'medium');
      await next.up();
      await tester.pumpAndSettle();
      expect(selected, ['medium']);
      expect(tester.takeException(), isNull);
    });

    // CAN-4436 internal and published reviews: the desktop switches the chat
    // to another model, or closes the chat so that the screen shows another
    // one, with the same levels while a drag is down. The drag belongs to the
    // old chat and model, so its release must not send its level to the new
    // one.
    for (final (name, start, toLevel) in [
      ('a new level', 'low', 'medium'),
      ('the same level', 'medium', 'medium'),
    ]) {
      for (final change in ['model', 'chat']) {
        testWidgets('a $change switch with the same levels and $name ends the '
            'drag, and its release sends nothing', (tester) async {
          await pumpHost(tester, start: start);
          final gesture = await dragTo(tester, 'high');
          await changeHost(
            tester,
            toChat: change == 'chat' ? 'chat-2' : null,
            toModel: change == 'model' ? 'm2' : null,
            toLevel: toLevel,
          );
          expect(
            levels,
            _claude5,
            reason: 'the new $change has the same levels',
          );
          final label = 'Effort  ${canopyEffortLabel(toLevel)}';
          expect(
            headingText(tester),
            label,
            reason: 'the new $change is shown',
          );
          expect(
            tester.widget<Slider>(slider).value,
            _claude5.indexOf(toLevel),
          );

          // Moves after the switch do not start a new preview.
          final rect = tester.getRect(slider);
          await gesture.moveTo(Offset(rect.right - 4, rect.center.dy));
          await tester.pump();
          expect(headingText(tester), label);
          await gesture.up();
          await tester.pumpAndSettle();
          expect(selected, isEmpty, reason: 'the old drag sends nothing');
          expect(headingText(tester), label);
          expect(tester.takeException(), isNull);

          // The next drag works on the new $change.
          final next = await dragTo(tester, 'max');
          await next.up();
          await tester.pumpAndSettle();
          expect(selected, ['max']);
          expect(headingText(tester), 'Effort  Max');
          expect(tester.takeException(), isNull);
        });
      }
    }

    testWidgets('a model without effort closes the sheet under a drag', (
      tester,
    ) async {
      await pumpHost(tester, start: 'off');
      final gesture = await dragTo(tester, 'max');
      await changeHost(tester, hide: true);
      await gesture.up();
      await tester.pumpAndSettle();
      expect(sheet, findsNothing);
      expect(trigger, findsNothing);
      expect(selected, isEmpty);
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets('opening and dismissing the sheet changes nothing', (
    tester,
  ) async {
    final selected = <String>[];
    var toggles = 0;
    await pump(
      tester,
      data(
        level: 'high',
        onSelectLevel: selected.add,
        supportsFastMode: true,
        onToggleFast: () => toggles++,
      ),
    );
    await openEffortSheet(tester);
    // Landing on the current level is not a change.
    await landEffortSlider(tester, 'high');
    await closeEffortSheet(tester);
    expect(sheet, findsNothing);
    expect(selected, isEmpty);
    expect(toggles, 0);
  });

  testWidgets('the sheet follows the host data while it is open', (
    tester,
  ) async {
    await pump(tester, data(level: 'medium'));
    await openEffortSheet(tester);
    expect(headingText(tester), 'Effort  Medium');

    await pump(tester, data(level: 'max'));
    await tester.pumpAndSettle();
    expect(headingText(tester), 'Effort  Max');

    // A model without effort closes the sheet.
    await pump(tester, data(levels: null));
    await tester.pumpAndSettle();
    expect(sheet, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a single level shows its name without a slider', (tester) async {
    await pump(tester, data(level: 'high', levels: const ['high']));
    await openEffortSheet(tester);
    expect(headingText(tester), 'Effort  High');
    expect(slider, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('level names take the desktop effort colors', (tester) async {
    await pump(tester, data(level: 'off'));
    await openEffortSheet(tester);
    final colors = AppColors.of(tester.element(sheet));
    Color? tint() => (headingOf(tester, 'effort-level').textSpan! as TextSpan)
        .children!
        .last
        .style
        ?.color;
    expect(tint(), colors.foregroundSecondary);
    for (final (level, role) in const [
      ('low', 'fg-secondary'),
      ('medium', 'fg-positive'),
      ('high', 'fg-accent'),
      ('xhigh', 'fg-attention'),
      ('max', 'fg-destructive'),
      ('ultra', 'fg-special'),
    ]) {
      await pump(tester, data(level: level));
      await tester.pumpAndSettle();
      expect(tint(), colors[role], reason: level);
    }
  });

  group('Fast mode', () {
    testWidgets('lives in the sheet only when the model offers it', (
      tester,
    ) async {
      await pump(tester, data(providerType: 'codex'));
      await openEffortSheet(tester);
      expect(find.byKey(const ValueKey('effort-fast-mode')), findsNothing);
      expect(find.byKey(const ValueKey('composer-fast')), findsNothing);
      await closeEffortSheet(tester);

      var toggles = 0;
      await pump(
        tester,
        data(supportsFastMode: true, onToggleFast: () => toggles++),
      );
      expect(find.byKey(const ValueKey('composer-fast')), findsNothing);
      await toggleComposerFast(tester);
      expect(toggles, 1);
    });

    testWidgets('the trigger leads with a bolt while Fast mode is on', (
      tester,
    ) async {
      final bolt = find.byKey(const ValueKey('effort-trigger-bolt'));
      await pump(tester, data(supportsFastMode: true));
      expect(bolt, findsNothing);

      await pump(
        tester,
        data(supportsFastMode: true, speed: CanopyEffortSpeed.fast),
      );
      final colors = AppColors.of(tester.element(trigger));
      expect(bolt, findsOneWidget);
      expect(tester.widget<CanopyIcon>(bolt).tint, colors.foregroundSecondary);
      expect(
        tester.getRect(bolt).right,
        lessThan(tester.getRect(find.text('None')).left),
      );
    });

    testWidgets('Fast help makes no fixed usage claim', (tester) async {
      await pump(
        tester,
        data(supportsFastMode: true, speed: CanopyEffortSpeed.fast),
      );
      await openEffortSheet(tester);
      expect(
        headingOf(tester, 'effort-speed').textSpan!.toPlainText(),
        'Speed  Fast',
      );
      // Rates vary by provider and plan, so no multiplier is universal.
      expect(find.text('Faster replies'), findsOneWidget);
      expect(find.textContaining('usage'), findsNothing);
    });

    testWidgets('Ultra fast is purple and read-only', (tester) async {
      var toggles = 0;
      await pump(
        tester,
        data(
          supportsFastMode: true,
          speed: CanopyEffortSpeed.ultraFast,
          onToggleFast: () => toggles++,
        ),
      );
      final colors = AppColors.of(tester.element(trigger));
      expect(
        tester
            .widget<CanopyIcon>(
              find.byKey(const ValueKey('effort-trigger-bolt')),
            )
            .tint,
        colors['fg-special'],
      );
      await openEffortSheet(tester);
      expect(
        headingOf(tester, 'effort-speed').textSpan!.toPlainText(),
        'Speed  Ultra fast',
      );
      expect(find.text(_ultraFastHelp), findsOneWidget);
      final toggle = find.byKey(const ValueKey('effort-fast-mode'));
      expect(
        find.descendant(of: toggle, matching: find.byType(IconButton)),
        findsNothing,
      );
      expect(
        tester
            .widget<CanopyIcon>(
              find.descendant(of: toggle, matching: find.byType(CanopyIcon)),
            )
            .tint,
        colors['fg-special'],
      );
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(toggles, 0);
    });

    testWidgets('Ultra fast help names the subscription allowance and links '
        "the provider's guidance", (tester) async {
      final launched = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        _urlLauncher,
        (call) async {
          if (call.method != 'launch') return null;
          final arguments = call.arguments as Map<Object?, Object?>;
          launched.add(arguments['url']! as String);
          return true;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          _urlLauncher,
          null,
        ),
      );
      await pump(
        tester,
        data(supportsFastMode: true, speed: CanopyEffortSpeed.ultraFast),
      );
      await openEffortSheet(tester);
      // docs/ux-writing.md: no fixed multiplier, plus the provider's guidance.
      expect(find.text(_ultraFastHelp), findsOneWidget);
      expect(find.textContaining('more usage'), findsNothing);
      final learnMore = find.bySemanticsLabel('Learn more about speed usage');
      expect(learnMore, findsOneWidget);
      expect(tester.getSize(learnMore).height, greaterThanOrEqualTo(48));
      await tester.tap(learnMore);
      await tester.pumpAndSettle();
      expect(launched, [
        'https://learn.chatgpt.com/docs/agent-configuration/speed',
      ]);
      expect(sheet, findsOneWidget, reason: 'the link keeps the sheet open');
      expect(tester.takeException(), isNull);
    });
  });

  group('accessibility and layout', () {
    // Real glyph widths, so text-scale layout matches a device.
    setUpAll(() async {
      final bytes = ByteData.sublistView(
        await File('assets/fonts/inter/InterVariable.ttf').readAsBytes(),
      );
      await (FontLoader('Inter')..addFont(Future.value(bytes))).load();
    });

    testWidgets('the trigger and slider announce the level and speed', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await pump(
        tester,
        data(
          level: 'xhigh',
          supportsFastMode: true,
          speed: CanopyEffortSpeed.fast,
        ),
      );
      expect(
        tester.getSemantics(trigger),
        matchesSemantics(
          label: 'Effort, current level Extra High, fast mode on',
          isButton: true,
          hasEnabledState: true,
          isEnabled: true,
          hasTapAction: true,
        ),
      );
      await pump(
        tester,
        data(
          level: 'high',
          supportsFastMode: true,
          speed: CanopyEffortSpeed.ultraFast,
        ),
      );
      expect(
        tester.getSemantics(trigger).label,
        'Effort, current level High, ultra fast mode on',
      );
      await pump(tester, data(level: 'off', supportsFastMode: true));
      expect(tester.getSemantics(trigger).label, 'Effort, current level None');

      await openEffortSheet(tester);
      final node = find.semantics
          .byFlag(SemanticsFlag.isSlider)
          .evaluate()
          .single;
      expect(node.value, 'None');
      expect(node.increasedValue, 'Low');
      expect(
        node.getSemanticsData().hasAction(SemanticsAction.increase),
        isTrue,
      );
      semantics.dispose();
    });

    testWidgets('sheet targets are at least 48px', (tester) async {
      await pump(tester, data(supportsFastMode: true));
      await openEffortSheet(tester);
      expect(
        tester.getSize(find.byType(Slider)).height,
        greaterThanOrEqualTo(48),
      );
      expect(
        tester.getSize(find.byKey(const ValueKey('effort-fast-mode'))),
        const Size.square(48),
      );
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    });

    for (final (textScale, dark) in const [
      (1.0, false),
      (1.0, true),
      (2.0, false),
      (2.0, true),
    ]) {
      testWidgets('the trigger is a 48px target beside the row controls '
          'at ${textScale}x text (${dark ? 'dark' : 'light'})', (tester) async {
        final draft = TextEditingController();
        addTearDown(draft.dispose);
        final semantics = tester.ensureSemantics();
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(textScale)),
              child: child!,
            ),
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: ChatInput(
                  controller: draft,
                  sending: false,
                  onSend: () {},
                  controls: data(
                    level: 'xhigh',
                    supportsFastMode: true,
                    speed: CanopyEffortSpeed.fast,
                    planMode: PlanModeControl(enabled: false, onToggle: () {}),
                  ),
                ),
              ),
            ),
          ),
        );
        final target = tester.getRect(trigger);
        expect(target.width, greaterThanOrEqualTo(48));
        expect(target.height, greaterThanOrEqualTo(48));
        final node = tester.getSemantics(trigger).rect;
        expect(node.width, greaterThanOrEqualTo(48));
        expect(node.height, greaterThanOrEqualTo(48));
        for (final other in const [
          'composer-draft',
          'composer-model',
          'composer-send',
        ]) {
          final rect = tester.getRect(find.byKey(ValueKey(other)));
          expect(
            target.overlaps(rect),
            isFalse,
            reason: 'the trigger overlaps $other',
          );
        }

        // The send circle stays concentric with the composer's corner, and
        // the visible chips share its bottom edge (and center line at 1x).
        final shell = find.byKey(const ValueKey('chat-composer'));
        final decoration =
            tester.widget<Container>(shell).decoration! as BoxDecoration;
        final radius = (decoration.borderRadius! as BorderRadius).bottomRight.x;
        final send = tester.getRect(
          find.byKey(const ValueKey('composer-send')),
        );
        expect(
          tester.getRect(shell).right - send.center.dx,
          closeTo(radius, 0.01),
        );
        expect(
          tester.getRect(shell).bottom - send.center.dy,
          closeTo(radius, 0.01),
        );
        final chip = tester.getRect(
          find.descendant(of: trigger, matching: find.byType(TextButton)),
        );
        final model = tester.getRect(
          find.byKey(const ValueKey('composer-model')),
        );
        for (final rect in [chip, model]) {
          expect(rect.bottom, closeTo(send.bottom, 0.01));
          if (textScale == 1) {
            expect(rect.center.dy, closeTo(send.center.dy, 0.01));
          }
        }

        // The whole target opens the sheet, including its edge above the chip.
        await tester.tapAt(target.topCenter + const Offset(0, 2));
        await tester.pumpAndSettle();
        expect(sheet, findsOneWidget);
        semantics.dispose();
      });
    }

    for (final dark in [false, true]) {
      testWidgets('Extra High with Fast stays readable at 2x text '
          '(${dark ? 'dark' : 'light'})', (tester) async {
        final draft = TextEditingController();
        addTearDown(draft.dispose);
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: ChatInput(
                  controller: draft,
                  sending: false,
                  onSend: () {},
                  controls: data(
                    level: 'xhigh',
                    supportsFastMode: true,
                    speed: CanopyEffortSpeed.fast,
                    planMode: PlanModeControl(enabled: false, onToggle: () {}),
                  ),
                ),
              ),
            ),
          ),
        );
        final label = find.descendant(
          of: trigger,
          matching: find.text('Extra High'),
        );
        final paragraph = tester.renderObject<RenderParagraph>(label);
        expect(paragraph.didExceedMaxLines, isFalse);
        expect(
          tester.getRect(label).right,
          lessThanOrEqualTo(tester.getRect(trigger).right),
        );
        expect(tester.getSize(trigger).width, greaterThanOrEqualTo(48));
        expect(tester.takeException(), isNull);

        await openEffortSheet(tester);
        expect(headingText(tester), 'Effort  Extra High');
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('commands', () {
    Future<void> pumpInput(
      WidgetTester tester,
      TextEditingController draft,
      ComposerControlsData controls,
    ) => tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: ChatInput(
              controller: draft,
              sending: false,
              onSend: () {},
              controls: controls,
              commands: const ComposerCommandSource(scope: 'chat'),
            ),
          ),
        ),
      ),
    );

    Future<void> type(WidgetTester tester, String text) async {
      await tester.tap(find.byKey(const ValueKey('composer-draft')));
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        text,
      );
      await tester.pumpAndSettle();
    }

    for (final (name, provider, lockedHarness, modelHarness, opens) in const [
      ('captured Codex harness', 'claude', 'codex', null, true),
      ('catalog Codex harness', 'claude', null, 'codex', true),
      ('captured Claude harness', 'codex', 'claude', 'codex', false),
      ('catalog Claude harness', 'codex', null, 'claude', false),
      ('legacy Codex provider', 'codex', null, null, true),
      ('legacy Claude provider', 'claude', null, null, false),
    ]) {
      testWidgets('dollar suggestions follow the $name', (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final draft = TextEditingController();
        addTearDown(draft.dispose);
        await pumpInput(
          tester,
          draft,
          data(
            providerType: provider,
            lockedHarness: lockedHarness,
            modelHarness: modelHarness,
          ),
        );
        await type(tester, r'Use $');
        expect(
          find.byKey(const ValueKey('composer-command-list')),
          opens ? findsOneWidget : findsNothing,
        );
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('/model follows the model chip while the host holds it', (
      tester,
    ) async {
      final draft = TextEditingController();
      addTearDown(draft.dispose);

      await pumpInput(tester, draft, data());
      await type(tester, '/');
      expect(
        find.byKey(const ValueKey('composer-command-model')),
        findsOneWidget,
      );

      await pumpInput(tester, draft, data(onSelectModel: null));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('composer-command-model')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('composer-command-fast')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('/thinking opens the live Effort sheet', (tester) async {
      final draft = TextEditingController();
      addTearDown(draft.dispose);
      final selected = <String>[];
      await pumpInput(
        tester,
        draft,
        data(level: 'medium', onSelectLevel: selected.add),
      );
      await type(tester, 'Plan it /thi');
      await tester.tap(find.byKey(const ValueKey('composer-command-thinking')));
      await tester.pumpAndSettle();
      expect(sheet, findsOneWidget);
      expect(draft.text, 'Plan it ');
      expect(headingText(tester), 'Effort  Medium');

      await landEffortSlider(tester, 'max');
      expect(selected, ['max']);
      // The host's answer reaches the open sheet.
      await pumpInput(
        tester,
        draft,
        data(level: 'max', onSelectLevel: selected.add),
      );
      await tester.pumpAndSettle();
      expect(headingText(tester), 'Effort  Max');
      expect(tester.takeException(), isNull);
    });

    testWidgets('/thinking is absent when the model does not think', (
      tester,
    ) async {
      final draft = TextEditingController();
      addTearDown(draft.dispose);
      await pumpInput(tester, draft, data(levels: null));
      await type(tester, '/thi');
      expect(
        find.byKey(const ValueKey('composer-command-thinking')),
        findsNothing,
      );
    });

    testWidgets('/fast toggles Fast mode, except during Ultra fast', (
      tester,
    ) async {
      final draft = TextEditingController();
      addTearDown(draft.dispose);
      var toggles = 0;
      await pumpInput(
        tester,
        draft,
        data(supportsFastMode: true, onToggleFast: () => toggles++),
      );
      await type(tester, '/fast');
      await tester.tap(find.byKey(const ValueKey('composer-command-fast')));
      await tester.pumpAndSettle();
      expect(toggles, 1);

      await pumpInput(
        tester,
        draft,
        data(
          supportsFastMode: true,
          speed: CanopyEffortSpeed.ultraFast,
          onToggleFast: () => toggles++,
        ),
      );
      await type(tester, '/fast');
      expect(
        find.text('Ultra fast is on. Change it in the desktop app.'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('composer-command-fast')));
      await tester.pumpAndSettle();
      expect(toggles, 1);
      expect(draft.text, '/fast');
    });
  });

  for (final height in [800.0, 120.0]) {
    testWidgets('a header sits above the composer box and keeps the toolbar '
        'at height $height (CAN-2932)', (tester) async {
      tester.view.physicalSize = Size(360, height);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: ChatInput(
                controller: controller,
                sending: false,
                onSend: () {},
                controls: data(supportsFastMode: true),
                header: NewChatDraftPill(
                  key: const ValueKey('new-chat-project-pill'),
                  icon: const CanopyIcon(glyph: CanopyGlyph.folderFilled),
                  label: 'canopy',
                  semanticLabel: 'Project, canopy',
                  onPressed: () {},
                ),
              ),
            ),
          ),
        ),
      );

      final header = find.byKey(const ValueKey('new-chat-project-pill'));
      final box = find.byKey(const ValueKey('chat-composer'));
      expect(
        tester.getBottomLeft(header).dy,
        lessThanOrEqualTo(tester.getTopLeft(box).dy),
      );
      expect(tester.getSize(header).height, greaterThanOrEqualTo(48));
      expect(find.byType(ComposerToolbar), findsOneWidget);
      expect(find.text('canopy'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}

void _selectModel(String _) {}
