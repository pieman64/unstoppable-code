import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/views/widgets/turn_feedback_sheet.dart';

/// Phone-width viewport. Wider viewports hide the RenderFlex overflow a real
/// phone would show.
void _usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

/// Hosts a button that opens the sheet and reports what it resolves to.
Widget _host(ValueChanged<TurnFeedbackDetail?> onResult) => MaterialApp(
  theme: AppTheme.light,
  home: Builder(
    builder: (context) => Scaffold(
      body: ElevatedButton(
        onPressed: () async {
          final result = await showTurnFeedbackSheet(context);
          onResult(result);
        },
        child: const Text('open'),
      ),
    ),
  ),
);

Widget _submittingHost({
  required Future<bool> Function(TurnFeedbackDetail detail) onSubmit,
}) => MaterialApp(
  theme: AppTheme.light,
  home: Builder(
    builder: (context) => Scaffold(
      body: ElevatedButton(
        onPressed: () => showTurnFeedbackSheet(context, onSubmit: onSubmit),
        child: const Text('open'),
      ),
    ),
  ),
);

void main() {
  testWidgets('renders all eight reason chips with their exact labels', (
    tester,
  ) async {
    _usePhoneViewport(tester);

    await tester.pumpWidget(_host((_) {}));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    for (final reason in TurnFeedbackReason.values) {
      expect(
        find.widgetWithText(ChoiceChip, turnFeedbackReasonLabel(reason)),
        findsOneWidget,
      );
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('focuses the comment field on open', (tester) async {
    _usePhoneViewport(tester);

    await tester.pumpWidget(_host((_) {}));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    final editableText = tester.widget<EditableText>(find.byType(EditableText));
    expect(tester.binding.focusManager.primaryFocus, editableText.focusNode);
    expect(tester.takeException(), isNull);
  });

  testWidgets('returns the selected reason on submit', (tester) async {
    _usePhoneViewport(tester);
    TurnFeedbackDetail? result;

    await tester.pumpWidget(_host((r) => result = r));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Got stuck or went in circles'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('turn-feedback-submit')));
    await tester.pumpAndSettle();

    expect(result?.reason, TurnFeedbackReason.gotStuck);
    expect(tester.takeException(), isNull);
  });

  testWidgets('re-tapping the selected chip clears it', (tester) async {
    _usePhoneViewport(tester);
    TurnFeedbackDetail? result;

    await tester.pumpWidget(_host((r) => result = r));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    // Type a comment so Submit stays enabled once the reason is cleared —
    // otherwise the disabled-button case (covered separately below) would
    // make this test pass vacuously without the tap ever reaching `_submit`.
    await tester.enterText(find.byType(TextField), 'still confusing');
    await tester.tap(find.text('Got stuck or went in circles'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Got stuck or went in circles'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('turn-feedback-submit')));
    await tester.pumpAndSettle();

    expect(result?.reason, isNull);
    expect(result?.comment, 'still confusing');
    expect(tester.takeException(), isNull);
  });

  testWidgets('skip returns null', (tester) async {
    _usePhoneViewport(tester);
    TurnFeedbackDetail? result;
    var resolved = false;

    await tester.pumpWidget(
      _host((r) {
        result = r;
        resolved = true;
      }),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Skip'));
    await tester.pumpAndSettle();

    expect(resolved, isTrue);
    expect(result, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('submit is disabled with neither a reason nor a comment', (
    tester,
  ) async {
    _usePhoneViewport(tester);

    await tester.pumpWidget(_host((_) {}));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    final button = tester.widget<FilledButton>(
      find.byKey(const ValueKey('turn-feedback-submit')),
    );
    expect(button.onPressed, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a rejected submit keeps the sheet open and preserves input', (
    tester,
  ) async {
    _usePhoneViewport(tester);
    TurnFeedbackDetail? submitted;

    await tester.pumpWidget(
      _submittingHost(
        onSubmit: (detail) async {
          submitted = detail;
          return false;
        },
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Got stuck or went in circles'));
    await tester.enterText(find.byType(TextField), 'It repeated the same step');
    await tester.tap(find.byKey(const ValueKey('turn-feedback-submit')));
    await tester.pumpAndSettle();

    expect(submitted?.reason, TurnFeedbackReason.gotStuck);
    expect(submitted?.comment, 'It repeated the same step');
    expect(find.text('What went wrong?'), findsOneWidget);
    expect(find.text('It repeated the same step'), findsOneWidget);
    expect(
      tester
          .widget<ChoiceChip>(
            find.widgetWithText(ChoiceChip, 'Got stuck or went in circles'),
          )
          .selected,
      isTrue,
    );
    expect(
      find.text('Could not submit feedback. Please try again.'),
      findsOneWidget,
    );

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('an onSubmit that THROWS is treated exactly like a rejection, '
      'not left with every control disabled', (tester) async {
    _usePhoneViewport(tester);

    // The same wedge the stalled-store test above pins, reached by the one
    // path `_submit` did not cover: `await onSubmit(detail)` sat outside any
    // try, so a throw skipped both `setState` calls and left `_submitting`
    // true forever -- TextField, Skip and Submit all disabled, the modal
    // barrier the only exit, and the typed comment destroyed on the way out.
    //
    // Latent rather than live: `TurnFeedbackController.setRating` returns a
    // bool today. It is guarded anyway because the callback's TYPE is what a
    // future caller reads, and nothing in `Future<bool> Function(...)`
    // forbids throwing.
    await tester.pumpWidget(
      _submittingHost(
        onSubmit: (detail) async => throw Exception('submit exploded'),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Got stuck or went in circles'));
    await tester.enterText(find.byType(TextField), 'It repeated the same step');
    await tester.tap(find.byKey(const ValueKey('turn-feedback-submit')));
    await tester.pumpAndSettle();

    expect(find.text('What went wrong?'), findsOneWidget);
    expect(
      find.text('It repeated the same step'),
      findsOneWidget,
      reason: 'the typed comment survives a throwing submit',
    );
    expect(
      find.text('Could not submit feedback. Please try again.'),
      findsOneWidget,
    );
    expect(
      tester.widget<TextField>(find.byType(TextField)).enabled,
      isTrue,
      reason: 'the controls are re-enabled, so Submit can be retried',
    );

    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const ValueKey('turn-feedback-submit')),
          )
          .onPressed,
      isNotNull,
      reason:
          'Submit is retryable, which a permanently _submitting sheet is '
          'not',
    );

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('a stalled outbox store does not strand the sheet with every '
      'control disabled and only the barrier to escape', (tester) async {
    _usePhoneViewport(tester);

    // The blocking `onSubmit` this sheet gained disables the text field, Skip
    // and Submit while the write is in flight, leaving the modal barrier as
    // the only exit -- and taking the barrier drops the typed comment with no
    // error and nothing to retry. That is only safe while the write is
    // BOUNDED. `attachDetail`'s request is; the store leg in front of it was
    // not, so a wedged `SharedPreferences` (healthy network, healthy server)
    // stranded the sheet for the process lifetime.
    final repository = HttpTurnFeedbackRepository(
      service: TurnFeedbackApiService(
        apiClient: ApiClient(
          baseUrl: 'https://api.test',
          httpClient: MockClient(
            (_) async => http.Response(jsonEncode(<String, dynamic>{}), 200),
          ),
        ),
      ),
      outbox: _StallingOutboxStore(),
      accountId: () => 'acct-a',
      storeTimeout: const Duration(milliseconds: 200),
    );

    await tester.pumpWidget(
      _submittingHost(
        onSubmit: (detail) async {
          final result = await repository.attachDetail(
            clientUserMessageId: 'msg-1',
            clientChatId: 'chat-1',
            feedbackId: 'fb-1',
            reason: detail.reason,
            comment: detail.comment,
          );
          return result.synced || !result.dropped;
        },
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'it repeated itself');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('turn-feedback-submit')));
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField)).enabled,
      isFalse,
      reason: 'the controls do disable while the submit is in flight',
    );

    // Well past every store touch the write makes. Unbounded, the sheet is
    // still sitting here with the field disabled.
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();

    expect(
      find.text('What went wrong?'),
      findsNothing,
      reason:
          'the write resolved, so the sheet closed on its own rather than '
          'leaving the barrier as the only way out',
    );
    expect(tester.takeException(), isNull);
  });
}

final class _StallingOutboxStore implements FeedbackOutboxStore {
  @override
  Future<List<FeedbackOutboxEntry>> read() =>
      Completer<List<FeedbackOutboxEntry>>().future;

  @override
  Future<void> write(List<FeedbackOutboxEntry> entries) =>
      Completer<void>().future;
}
