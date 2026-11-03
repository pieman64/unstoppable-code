import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'dart:math' as math;
import 'package:mobile/ui/core/theme.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';

import '../../../support/remote_session_fake_server.dart';

void main() {
  group('ConnectDesktopView', () {
    Widget buildSubject({
      double textScale = 1.0,
      TargetPlatform? platform,
      ThemeData? theme,
    }) => ChangeNotifierProvider<RemoteControlViewModel>(
      create: (_) => RemoteControlViewModel(
        repository: MockRemoteControlRepository(latency: Duration.zero),
      ),
      child: MaterialApp(
        theme:
            theme ?? (platform == null ? null : ThemeData(platform: platform)),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child ?? const SizedBox.shrink(),
        ),
        home: const Scaffold(body: ConnectDesktopView()),
      ),
    );

    testWidgets(
      'does not raise the keyboard on its own — this view is built whenever '
      'the shell is, including on a tab the user is not looking at',
      (tester) async {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        expect(tester.testTextInput.isVisible, isFalse);
      },
    );

    testWidgets('tapping the code field still focuses it', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();

      expect(tester.testTextInput.isVisible, isTrue);
    });

    // The digit cells are painted over a hidden field, so the thing that can
    // silently break is hit testing rather than anything visible. These sweep
    // the accessibility range because the strip grows with the text scaler
    // while the field's own decorator does not: left alone it sits at ~48pt,
    // and everything below that stops responding — a quarter of the control at
    // 1.35, two thirds at 3.0, on this screen's only input.
    for (final double scale in const [1.0, 1.35, 2.0, 3.0]) {
      testWidgets('the whole code strip is tappable at text scale $scale', (
        tester,
      ) async {
        await tester.pumpWidget(buildSubject(textScale: scale));
        await tester.pumpAndSettle();

        // At large scales the strip sits below the fold of this bare host.
        await tester.ensureVisible(find.byType(TextField));
        await tester.pumpAndSettle();
        final Rect strip = tester.getRect(find.byType(TextField));

        // Near the bottom edge, which is the part that goes dead first.
        await tester.tapAt(
          Offset(strip.center.dx, strip.top + strip.height * 0.9),
        );
        await tester.pumpAndSettle();

        expect(
          tester.testTextInput.isVisible,
          isTrue,
          reason: 'a tap near the bottom of the code strip did nothing',
        );
      });
    }

    testWidgets('the hidden field covers the full height of the cells', (
      tester,
    ) async {
      // The regression this guards is the field staying at its decorator's
      // ~48pt minimum while the cells grow, so compare the two directly rather
      // than trusting a tap that might land in the overlap.
      await tester.pumpWidget(buildSubject(textScale: 2.0));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byType(TextField));
      await tester.pumpAndSettle();

      final double fieldHeight = tester.getRect(find.byType(TextField)).height;

      expect(
        fieldHeight,
        greaterThan(60),
        reason:
            'the field did not grow with the cells, so its lower part is inert',
      );
    });

    testWidgets('a typed digit renders in its own cell', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Digits outside 1-3, because the step markers render those and would
      // match the finder.
      await tester.enterText(find.byType(TextField), '47');
      await tester.pumpAndSettle();

      // The cells are the only place a digit is visible — the field's own text
      // is transparent — so this is what proves the strip tracks the value.
      expect(find.text('4'), findsOneWidget);
      expect(find.text('7'), findsOneWidget);
      expect(find.text('5'), findsNothing);
    });

    for (final TargetPlatform platform in const [
      TargetPlatform.iOS,
      TargetPlatform.android,
    ]) {
      testWidgets('a long-press offers Paste on $platform', (tester) async {
        // The code is usually already on the clipboard from the desktop, and
        // the field is non-empty exactly when a rejected code needs replacing.
        // Both `enableInteractiveSelection: false` and
        // `EmptyTextSelectionControls` silently remove the menu in that state.
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async => switch (call.method) {
            'Clipboard.hasStrings' => {'value': true},
            'Clipboard.getData' => {'text': '123456'},
            _ => null,
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            null,
          ),
        );

        await tester.pumpWidget(buildSubject(platform: platform));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), '000000');
        await tester.pumpAndSettle();

        await tester.longPress(find.byType(TextField));
        await tester.pumpAndSettle();

        expect(find.text('Paste'), findsOneWidget);
      });
    }

    testWidgets('the Connect label fits its button at large text', (
      tester,
    ) async {
      // A fixed-height button clamps the label from about text scale 2.5, and
      // FilledButton's Material does not clip — the word paints outside the
      // pill instead of throwing, so nothing else would catch it.
      await tester.pumpWidget(buildSubject(textScale: 3.0));
      await tester.pumpAndSettle();

      final Finder button = find.widgetWithText(FilledButton, 'Connect');
      final RenderParagraph label = tester.renderObject<RenderParagraph>(
        find.descendant(of: button, matching: find.byType(RichText)),
      );

      expect(
        tester.getRect(button).height,
        greaterThanOrEqualTo(label.getMaxIntrinsicHeight(double.infinity)),
        reason: 'the Connect label is taller than the button drawing it',
      );
    });

    for (final double width in const [320.0, 375.0, 390.0]) {
      testWidgets('a digit fits its cell at ${width}pt and text scale 3', (
        tester,
      ) async {
        // Unlike the Connect button, a cell cannot grow — each is `Expanded`
        // at a sixth of a fixed row — so a scaled digit outgrows its box and
        // `RenderParagraph` clips it without throwing. Silent, like the
        // button's own clamp was.
        tester.view.physicalSize = Size(width * 3, 900 * 3);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildSubject(textScale: 3.0));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), '478947');
        await tester.pumpAndSettle();

        final RenderParagraph glyph = tester.renderObject<RenderParagraph>(
          find
              .descendant(
                of: find.text('4').first,
                matching: find.byType(RichText),
              )
              .first,
        );

        // Comparing painted rects would not catch this: without a FittedBox
        // the paragraph is *clamped* to the cell and clips its glyph inside,
        // so the rect still looks like it fits. Laying out at the natural
        // width is what says the digit is scaled rather than cut.
        expect(
          glyph.size.width,
          greaterThanOrEqualTo(
            glyph.getMaxIntrinsicWidth(double.infinity) - 0.5,
          ),
          reason: 'the digit is clamped by its cell and clipped, not scaled',
        );
      });
    }

    testWidgets('the resting placeholder clears 3:1 against its cell', (
      tester,
    ) async {
      // The dot and the cell edge are the only "a code goes here" signal, and
      // the alpha is a value chosen on this screen rather than a brand token,
      // so the ratio is ours to hold. Reads the colour the widget actually
      // paints — retyping the alpha here would assert arithmetic, not code.
      double luminance(Color c) {
        double channel(double v) => v <= 0.03928
            ? v / 12.92
            : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
        return 0.2126 * channel(c.r) +
            0.7152 * channel(c.g) +
            0.0722 * channel(c.b);
      }

      for (final ThemeData theme in [AppTheme.light, AppTheme.dark]) {
        await tester.pumpWidget(buildSubject(theme: theme));
        await tester.pumpAndSettle();

        // Scoped to the cells: the step markers are circular Containers too,
        // and matching one of those measured a constant ratio no matter what
        // this alpha was set to.
        final Iterable<Container> dots = tester
            .widgetList<Container>(
              find.descendant(
                of: find.byType(AnimatedContainer),
                matching: find.byType(Container),
              ),
            )
            .where(
              (c) =>
                  c.decoration is BoxDecoration &&
                  (c.decoration! as BoxDecoration).shape == BoxShape.circle &&
                  (c.decoration! as BoxDecoration).color != null,
            );
        expect(dots, isNotEmpty, reason: 'no placeholder dot rendered');

        // Both halves come from the tree. Retyping the fill would measure a
        // pair that is never painted, and could stay green while the shipped
        // dot fails — the same trap this test already sprang twice.
        final Color fill =
            (tester
                        .widgetList<AnimatedContainer>(
                          find.byType(AnimatedContainer),
                        )
                        .first
                        .decoration!
                    as BoxDecoration)
                .color!;
        final Color painted = Color.alphaBlend(
          (dots.first.decoration! as BoxDecoration).color!,
          fill,
        );
        final double a = luminance(painted);
        final double b = luminance(fill);
        final double ratio = (math.max(a, b) + 0.05) / (math.min(a, b) + 0.05);

        expect(
          ratio,
          greaterThanOrEqualTo(3.0),
          reason: 'the placeholder dot is below the 3:1 non-text minimum',
        );
      }
    });

    testWidgets('exposes one labelled text field, error included', (
      tester,
    ) async {
      // Pins the three pieces that are load-bearing: the single labelled
      // field carrying the error as its hint, the live region that announces
      // it, and the `ExcludeSemantics` over the cells. All three fail if
      // `InputDecoration.errorText` is reinstated, the wrapper moves, or the
      // cells start contributing semantics of their own.
      final SemanticsHandle handle = tester.ensureSemantics();

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // One node, not two: an earlier revision wrapped the whole Stack, which
      // announced as a second text field holding no value and no actions.
      expect(find.bySemanticsLabel('6-digit code'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '000000');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel('6-digit code'), findsOneWidget);
      // Asserted with the cells filled, not empty: `IgnorePointer` stopped
      // suppressing semantics in Flutter 3.8, so without the
      // `ExcludeSemantics` each filled cell contributes a bare digit node and
      // a screen reader reads six stray zeroes around the field. An empty
      // field looks identical either way, which is what made an earlier
      // version of this assertion unfalsifiable.
      expect(find.bySemanticsLabel('0'), findsNothing);
      expect(
        tester.getSemantics(find.byType(TextField)),
        // `isSemantics`, not `matchesSemantics`: the action set varies with
        // selection state and is not what this pins.
        isSemantics(
          isTextField: true,
          isFocused: true,
          // The name has to survive a non-empty field: it rode on `hintText`
          // once, which only announces while the field is empty.
          label: '6-digit code',
          value: '000000',
          hint:
              'That code was not recognized. Check your desktop and try again.',
        ),
      );

      // The message is announced, not merely present — Material used to give
      // this for free through `InputDecoration.errorText`.
      expect(
        tester.getSemantics(
          find.text(
            'That code was not recognized. Check your desktop and try again.',
          ),
        ),
        isSemantics(
          isLiveRegion: true,
          label:
              'That code was not recognized. Check your desktop and try again.',
        ),
      );

      // Disposed here rather than in a tearDown: the framework checks for
      // live handles before tearDowns run.
      handle.dispose();
    });

    testWidgets(
      'tapping outside dismisses the keyboard, which is the only way out: an '
      'iOS number pad has no return key and the code is incomplete',
      (tester) async {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();
        await tester.tap(find.byType(TextField));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), '123');
        await tester.pumpAndSettle();
        expect(tester.testTextInput.isVisible, isTrue);

        await tester.tapAt(const Offset(20, 20));
        await tester.pumpAndSettle();

        expect(tester.testTextInput.isVisible, isFalse);
      },
    );
  });

  // CAN-4426: a code entered while no desktop can take it. The real
  // repository runs over a synthetic Portal server that answers the connect
  // route's no-eligible-desktop 404.
  group('no desktop can take the code', () {
    const productionMessage =
        'Open ${Brand.productDisplayName} on your computer, turn on Remote '
        'Control, then enter the new code.';
    const stagingHint =
        'This phone uses the staging server. Use staging in the desktop app '
        'too.';

    void useEnvironment(ApiEnvironment environment) {
      ApiEnvironmentController controller(ApiEnvironment value) =>
          ApiEnvironmentController(
            productionBaseUrl: 'https://production.test',
            stagingBaseUrl: 'https://staging.test',
            initialEnvironment: value,
            preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
          );
      AppConfig.configureEnvironmentController(controller(environment));
      addTearDown(
        () => AppConfig.configureEnvironmentController(
          controller(ApiEnvironment.production),
        ),
      );
    }

    Future<void> submitCode(
      WidgetTester tester, {
      ThemeData? theme,
      double textScale = 1.0,
    }) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final server = FakePortalSessionServer();
      addTearDown(server.close);
      await tester.pumpWidget(
        ChangeNotifierProvider<RemoteControlViewModel>(
          create: (_) =>
              RemoteControlViewModel(repository: server.repository()),
          child: MaterialApp(
            theme: theme ?? AppTheme.light,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(textScale)),
              child: child ?? const SizedBox.shrink(),
            ),
            home: const Scaffold(body: ConnectDesktopView()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '123456');
      await tester.pumpAndSettle();
      final connect = find.widgetWithText(FilledButton, 'Connect');
      await tester.ensureVisible(connect);
      await tester.pumpAndSettle();
      await tester.tap(connect);
      await tester.pumpAndSettle();
      // Dismiss the keyboard so the message is laid out as the user reads it.
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
    }

    testWidgets('production says what to do on the desktop', (tester) async {
      useEnvironment(ApiEnvironment.production);
      await submitCode(tester);

      expect(find.text(productionMessage), findsOneWidget);
      expect(find.textContaining('No pending'), findsNothing);
      expect(find.textContaining('staging'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('staging adds the environment hint', (tester) async {
      useEnvironment(ApiEnvironment.staging);
      await submitCode(tester);

      expect(find.text('$productionMessage\n$stagingHint'), findsOneWidget);
      expect(find.textContaining('No pending'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    for (final (themeName, theme) in [
      ('light', AppTheme.light),
      ('dark', AppTheme.dark),
    ]) {
      for (final textScale in const [1.0, 2.0]) {
        testWidgets(
          'the staging message fits 390pt ($themeName, text x$textScale)',
          (tester) async {
            useEnvironment(ApiEnvironment.staging);
            await submitCode(tester, theme: theme, textScale: textScale);

            expect(tester.takeException(), isNull);
            final message = find.textContaining(stagingHint);
            await tester.ensureVisible(message);
            await tester.pumpAndSettle();
            final rect = tester.getRect(message);
            expect(rect.left, greaterThanOrEqualTo(0));
            expect(rect.right, lessThanOrEqualTo(390));
          },
        );
      }
    }
  });
}
