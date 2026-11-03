import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_sheet.dart';

void main() {
  Future<SatisfactionPromptChoice?> openAndAct(
    WidgetTester tester,
    Future<void> Function() act,
  ) async {
    SatisfactionPromptChoice? choice;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                choice = await showSatisfactionPromptSheet(context);
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

  testWidgets('shows the question and three actions', (tester) async {
    await openAndAct(tester, () async {});
    expect(find.text('Are you enjoying the app?'), findsOneWidget);
    expect(find.byKey(const ValueKey('satisfaction-prompt-yes')), findsOne);
    expect(find.byKey(const ValueKey('satisfaction-prompt-no')), findsOne);
    expect(find.byKey(const ValueKey('satisfaction-prompt-not-now')), findsOne);
  });

  for (final (key, expected) in [
    ('satisfaction-prompt-yes', SatisfactionPromptChoice.yes),
    ('satisfaction-prompt-no', SatisfactionPromptChoice.no),
    ('satisfaction-prompt-not-now', SatisfactionPromptChoice.notNow),
  ]) {
    testWidgets('$key returns $expected', (tester) async {
      final choice = await openAndAct(
        tester,
        () => tester.tap(find.byKey(ValueKey(key))),
      );
      expect(choice, expected);
    });
  }

  testWidgets('tapping outside returns dismissed', (tester) async {
    final choice = await openAndAct(
      tester,
      () => tester.tapAt(const Offset(10, 10)),
    );
    expect(choice, SatisfactionPromptChoice.dismissed);
  });

  testWidgets('meets accessibility guidelines', (tester) async {
    final handle = tester.ensureSemantics();
    await openAndAct(tester, () async {});
    expect(
      tester.getSemantics(find.text('Are you enjoying the app?')),
      matchesSemantics(label: 'Are you enjoying the app?', isHeader: true),
    );
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
    handle.dispose();
  });

  testWidgets('focus order is heading, Yes, Not really, Not now', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await openAndAct(tester, () async {});
    double top(String text) => tester.getTopLeft(find.text(text)).dy;
    expect(top('Are you enjoying the app?'), lessThan(top('Yes')));
    expect(top('Yes'), lessThan(top('Not really')));
    expect(top('Not really'), lessThan(top('Not now')));
    handle.dispose();
  });
}
