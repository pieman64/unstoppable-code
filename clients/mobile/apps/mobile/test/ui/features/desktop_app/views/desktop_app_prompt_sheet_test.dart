import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_presentation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/desktop_app/views/desktop_app_prompt_sheet.dart';

const _heading = 'Get the desktop app';

void main() {
  Future<DesktopAppPromptChoice?> openAndAct(
    WidgetTester tester,
    Future<void> Function() act, {
    ThemeData? theme,
    double textScale = 1,
    double bottomInset = 0,
  }) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    tester.view.viewPadding = FakeViewPadding(bottom: bottomInset * 3);
    tester.view.padding = FakeViewPadding(bottom: bottomInset * 3);
    addTearDown(tester.view.reset);
    DesktopAppPromptChoice? choice;
    await tester.pumpWidget(
      MaterialApp(
        theme: theme ?? AppTheme.light,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                choice = await showDesktopAppPromptSheet(context);
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await act();
    await tester.pumpAndSettle();
    return choice;
  }

  testWidgets('explains the desktop app and offers three actions', (
    tester,
  ) async {
    await openAndAct(tester, () async {});
    expect(find.text(_heading), findsOneWidget);
    expect(find.textContaining('your phone stays in sync'), findsOneWidget);
    expect(find.text('Share link'), findsOneWidget);
    expect(find.text('Copy link'), findsOneWidget);
    expect(find.text('Not now'), findsOneWidget);
  });

  for (final (key, expected) in [
    ('desktop-app-prompt-copy', DesktopAppPromptAction.copy),
    ('desktop-app-prompt-not-now', DesktopAppPromptAction.notNow),
  ]) {
    testWidgets('$key returns ${expected.name}', (tester) async {
      final choice = await openAndAct(
        tester,
        () => tester.tap(find.byKey(ValueKey(key))),
      );
      expect(choice?.action, expected);
    });
  }

  testWidgets('Share link returns the button position for the iPad popover', (
    tester,
  ) async {
    late Rect button;
    final choice = await openAndAct(tester, () async {
      final share = find.byKey(const ValueKey('desktop-app-prompt-share'));
      button = tester.getRect(share);
      await tester.tap(share);
    });
    expect(choice?.action, DesktopAppPromptAction.share);
    expect(choice?.shareOrigin, button);
  });

  testWidgets('tapping outside returns dismissed', (tester) async {
    final choice = await openAndAct(
      tester,
      () => tester.tapAt(const Offset(10, 10)),
    );
    expect(choice?.action, DesktopAppPromptAction.dismissed);
  });

  testWidgets('system back returns dismissed', (tester) async {
    final choice = await openAndAct(tester, () async {
      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      await navigator.maybePop();
    });
    expect(choice?.action, DesktopAppPromptAction.dismissed);
  });

  for (final (name, theme) in [
    ('light', AppTheme.light),
    ('dark', AppTheme.dark),
  ]) {
    testWidgets('meets accessibility guidelines in $name theme', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await openAndAct(tester, () async {}, theme: theme);
      expect(
        tester.getSemantics(find.text(_heading)),
        matchesSemantics(label: _heading, isHeader: true),
      );
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await expectLater(tester, meetsGuideline(textContrastGuideline));
      handle.dispose();
    });

    testWidgets('fits a phone at large text in $name theme', (tester) async {
      await openAndAct(tester, () async {}, theme: theme, textScale: 2);
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.text('Not now'),
        100,
        scrollable: find.descendant(
          of: find.byKey(const ValueKey('desktop-app-prompt-sheet')),
          matching: find.byType(Scrollable),
        ),
      );
      expect(find.text('Not now').hitTestable(), findsOneWidget);
    });
  }

  testWidgets('keeps Not now above the system navigation area', (tester) async {
    final choice = await openAndAct(tester, () async {
      final action = find.byKey(const ValueKey('desktop-app-prompt-not-now'));
      expect(tester.takeException(), isNull);
      expect(tester.getRect(action).bottom, lessThanOrEqualTo(844 - 48));
      expect(action.hitTestable(), findsOneWidget);
      await tester.tap(action);
    }, bottomInset: 48);
    expect(choice?.action, DesktopAppPromptAction.notNow);
  });

  testWidgets('every action is at least 48 dp tall', (tester) async {
    await openAndAct(tester, () async {});
    for (final key in [
      'desktop-app-prompt-share',
      'desktop-app-prompt-copy',
      'desktop-app-prompt-not-now',
    ]) {
      expect(
        tester.getSize(find.byKey(ValueKey(key))).height,
        greaterThanOrEqualTo(48),
      );
    }
  });

  testWidgets('reading order is heading, explanation, then the actions', (
    tester,
  ) async {
    await openAndAct(tester, () async {});
    double top(Finder finder) => tester.getTopLeft(finder).dy;
    expect(
      top(find.text(_heading)),
      lessThan(top(find.textContaining('your phone stays in sync'))),
    );
    expect(
      top(find.textContaining('your phone stays in sync')),
      lessThan(top(find.text('Share link'))),
    );
    expect(top(find.text('Share link')), lessThan(top(find.text('Copy link'))));
    expect(top(find.text('Copy link')), lessThan(top(find.text('Not now'))));
  });
}
