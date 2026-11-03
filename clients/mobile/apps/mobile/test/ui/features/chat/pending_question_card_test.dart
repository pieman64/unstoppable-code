import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';

void main() {
  const request = AskUserQuestionState(
    requestId: 'req-1',
    questions: [
      AskUserQuestion(
        id: 'q1',
        question: 'Deploy now?',
        options: ['Yes', 'No'],
        allowOther: true,
      ),
    ],
  );

  Future<void> pump(
    WidgetTester tester, {
    required void Function(List<AskUserQuestionAnswer>) onSubmit,
    VoidCallback? onDismiss,
  }) {
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PendingQuestionCard(
            request: request,
            onSubmit: onSubmit,
            onDismiss: onDismiss ?? () {},
          ),
        ),
      ),
    );
  }

  testWidgets('submit stays disabled until an option is picked', (
    tester,
  ) async {
    await pump(tester, onSubmit: (_) {});
    final submit = find.byKey(const ValueKey('question-submit-req-1'));
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    await tester.tap(find.text('Yes'));
    await tester.pump();
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
  });

  testWidgets('submit reports the selected option', (tester) async {
    List<AskUserQuestionAnswer>? submitted;
    await pump(tester, onSubmit: (answers) => submitted = answers);
    await tester.tap(find.text('No'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('question-submit-req-1')));
    await tester.pump();

    expect(submitted, hasLength(1));
    expect(submitted!.single.questionId, 'q1');
    expect(submitted!.single.selectedOptions, ['No']);
    expect(submitted!.single.freeformText, isNull);
  });

  testWidgets('Other reveals a text field and submits freeform text', (
    tester,
  ) async {
    List<AskUserQuestionAnswer>? submitted;
    await pump(tester, onSubmit: (answers) => submitted = answers);
    await tester.tap(find.text('Other'));
    await tester.pump();
    final field = find.byKey(const ValueKey('question-other-field-req-1-0'));
    expect(field, findsOneWidget);
    await tester.enterText(field, 'Tomorrow');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('question-submit-req-1')));
    await tester.pump();

    expect(submitted!.single.selectedOptions, isEmpty);
    expect(submitted!.single.freeformText, 'Tomorrow');
  });

  testWidgets('picking Other after a concrete option drops the option', (
    tester,
  ) async {
    List<AskUserQuestionAnswer>? submitted;
    await pump(tester, onSubmit: (answers) => submitted = answers);
    await tester.tap(find.text('Yes'));
    await tester.pump();
    await tester.tap(find.text('Other'));
    await tester.pump();
    final field = find.byKey(const ValueKey('question-other-field-req-1-0'));
    await tester.enterText(field, 'Later');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('question-submit-req-1')));
    await tester.pump();

    expect(submitted!.single.selectedOptions, isEmpty);
    expect(submitted!.single.freeformText, 'Later');
  });

  testWidgets(
    'picking a concrete option after Other drops the freeform answer',
    (tester) async {
      List<AskUserQuestionAnswer>? submitted;
      await pump(tester, onSubmit: (answers) => submitted = answers);
      await tester.tap(find.text('Other'));
      await tester.pump();
      final field = find.byKey(const ValueKey('question-other-field-req-1-0'));
      await tester.enterText(field, 'Later');
      await tester.pump();
      await tester.tap(find.text('Yes'));
      await tester.pump();
      expect(
        find.byKey(const ValueKey('question-other-field-req-1-0')),
        findsNothing,
      );
      await tester.tap(find.byKey(const ValueKey('question-submit-req-1')));
      await tester.pump();

      expect(submitted!.single.selectedOptions, ['Yes']);
      expect(submitted!.single.freeformText, isNull);
    },
  );

  testWidgets('dismiss calls back', (tester) async {
    var dismissed = false;
    await pump(tester, onSubmit: (_) {}, onDismiss: () => dismissed = true);
    await tester.tap(find.byKey(const ValueKey('question-dismiss-req-1')));
    expect(dismissed, isTrue);
  });
}
