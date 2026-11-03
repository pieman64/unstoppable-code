import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/feedback_report.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_report_api_service.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/settings/views/widgets/feedback_report_sheet.dart';

void _usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

Widget _host(FeedbackReportRepository repository) => MultiProvider(
  providers: [Provider<FeedbackReportRepository>.value(value: repository)],
  child: MaterialApp(
    theme: AppTheme.light,
    home: const Scaffold(body: SendFeedbackTile()),
  ),
);

void main() {
  testWidgets('both type options render and Bug is preselected', (
    tester,
  ) async {
    _usePhoneViewport(tester);
    await tester.pumpWidget(
      _host(MockFeedbackReportRepository(latency: Duration.zero)),
    );
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();

    expect(find.text('Bug'), findsOneWidget);
    expect(find.text('Idea'), findsOneWidget);
    // Bug's helper copy is visible by default, which only happens if Bug is
    // the preselected segment.
    expect(
      find.text('Something is broken or not working as expected.'),
      findsOneWidget,
    );
    final segmented = tester.widget<SegmentedButton<FeedbackReportType>>(
      find.byType(SegmentedButton<FeedbackReportType>),
    );
    expect(segmented.selected, {FeedbackReportType.bug});
    expect(tester.takeException(), isNull);
  });

  testWidgets('Submit is disabled while the description is empty', (
    tester,
  ) async {
    _usePhoneViewport(tester);
    await tester.pumpWidget(
      _host(MockFeedbackReportRepository(latency: Duration.zero)),
    );
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();

    FilledButton submitButton() => tester.widget<FilledButton>(
      find.byKey(const ValueKey('feedback-report-submit')),
    );
    expect(submitButton().onPressed, isNull);

    await tester.enterText(
      find.byKey(const ValueKey('feedback-report-description')),
      'Activity list jumps to the top on refresh.',
    );
    await tester.pump();

    expect(submitButton().onPressed, isNotNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a successful submit pops the sheet and shows a confirmation '
      'containing the returned issue identifier', (tester) async {
    _usePhoneViewport(tester);
    await tester.pumpWidget(
      _host(MockFeedbackReportRepository(latency: Duration.zero)),
    );
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('feedback-report-description')),
      'Activity list jumps to the top on refresh.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('feedback-report-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('feedback-report-sheet')), findsNothing);
    // MockFeedbackReportRepository's fixed success identifier.
    expect(find.textContaining('CAN-0000'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed submit keeps the sheet and the typed text', (
    tester,
  ) async {
    _usePhoneViewport(tester);
    final repository = MockFeedbackReportRepository(
      latency: Duration.zero,
      failSubmits: true,
    );

    await tester.pumpWidget(_host(repository));
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('feedback-report-description')),
      'Activity list jumps to the top on refresh.',
    );
    // A pump between typing and tapping is required: entering text marks the
    // Submit button dirty via the controller listener, but that rebuild
    // (which flips `onPressed` from null to the handler) only lands on the
    // next pumped frame — tapping immediately would hit the still-disabled
    // button from the prior frame.
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('feedback-report-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('feedback-report-sheet')), findsOneWidget);
    expect(
      find.text('Activity list jumps to the top on refresh.'),
      findsOneWidget,
    );
    expect(find.textContaining('try again'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a second Submit after the failure succeeds and pops', (
    tester,
  ) async {
    _usePhoneViewport(tester);
    final repository = MockFeedbackReportRepository(
      latency: Duration.zero,
      failSubmits: true,
    );

    await tester.pumpWidget(_host(repository));
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('feedback-report-description')),
      'Activity list jumps to the top on refresh.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('feedback-report-submit')));
    await tester.pumpAndSettle();

    // First submit failed; sheet is still open with the error shown.
    expect(find.textContaining('try again'), findsOneWidget);

    repository.failSubmits = false;
    await tester.tap(find.byKey(const ValueKey('feedback-report-submit')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('feedback-report-sheet')), findsNothing);
    expect(find.textContaining('CAN-0000'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a submit whose request never answers still reaches a retryable '
      'error with the typed text intact', (tester) async {
    // The reviewer's probe for the missing liveness bound. `dart:io`'s
    // HttpClient has no in-flight request timeout, so a half-open socket (a
    // cellular/Wi-Fi handoff) leaves this sheet spinning forever: Cancel
    // disabled, the field disabled, Submit disabled, and no error. The only
    // exit is the modal barrier, which disposes the controller and destroys
    // the user's typed report with no error and no retry.
    //
    // Ten simulated minutes is far past the repository's 30-second default
    // bound, so this asserts the bound EXISTS rather than any particular
    // value. Deliberately built without naming `requestTimeout` so the probe
    // exercises the default a real user gets.
    _usePhoneViewport(tester);
    final never = Completer<http.Response>();
    addTearDown(() => never.complete(http.Response('{}', 200)));
    final repository = HttpFeedbackReportRepository(
      service: FeedbackReportApiService(
        apiClient: ApiClient(
          baseUrl: 'https://api.test',
          httpClient: MockClient((_) => never.future),
        ),
      ),
    );

    await tester.pumpWidget(_host(repository));
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('feedback-report-description')),
      'Activity list jumps to the top on refresh.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('feedback-report-submit')));
    await tester.pump();

    // Mid-flight: the sheet is legitimately busy.
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('feedback-report-description')),
          )
          .enabled,
      isFalse,
    );

    await tester.pump(const Duration(minutes: 10));
    await tester.pump();

    // The bound fired: the sheet is interactive again, the typed text
    // survived, and the error is the retryable generic one --
    // `presentableErrorMessage` returns null for a TimeoutException (it is not
    // an ApiException), so `_genericSubmitErrorMessage` is what renders.
    expect(find.byKey(const ValueKey('feedback-report-sheet')), findsOneWidget);
    expect(find.textContaining('try again'), findsOneWidget);
    expect(
      find.text('Activity list jumps to the top on refresh.'),
      findsOneWidget,
    );
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('feedback-report-description')),
          )
          .enabled,
      isTrue,
    );
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const ValueKey('feedback-report-submit')),
          )
          .onPressed,
      isNotNull,
      reason: 'the user must be able to retry the submit',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('an empty issue identifier is not presented as a named success', (
    tester,
  ) async {
    _usePhoneViewport(tester);
    await tester.pumpWidget(_host(_EmptyIdentifierRepository()));
    await tester.tap(find.text('Send feedback'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('feedback-report-description')),
      'Something happened.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('feedback-report-submit')));
    await tester.pumpAndSettle();

    // A malformed "success" (empty identifier) is treated like a failure:
    // the sheet stays open with a retryable error rather than popping and
    // naming an empty issue.
    expect(find.byKey(const ValueKey('feedback-report-sheet')), findsOneWidget);
    expect(find.textContaining('try again'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a source is sent in the report context and the outcome is '
      'reported', (tester) async {
    _usePhoneViewport(tester);
    final repository = _RecordingFeedbackRepository();
    FeedbackSheetOutcome? outcome;
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          Provider<FeedbackReportRepository>.value(value: repository),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  outcome = await showFeedbackReportSheet(
                    context,
                    source: 'satisfaction_prompt',
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('feedback-report-description')),
      'Too slow to reconnect.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('feedback-report-submit')));
    await tester.pumpAndSettle();

    expect(repository.contexts.single['source'], 'satisfaction_prompt');
    expect(outcome, FeedbackSheetOutcome.submitted);
  });

  testWidgets('cancelling reports a dismissed outcome', (tester) async {
    _usePhoneViewport(tester);
    FeedbackSheetOutcome? outcome;
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          Provider<FeedbackReportRepository>.value(
            value: _RecordingFeedbackRepository(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  outcome = await showFeedbackReportSheet(context);
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(outcome, FeedbackSheetOutcome.dismissed);
  });
}

/// Always "succeeds" with an empty identifier, exercising the defensive
/// guard against `FeedbackReportResult.fromJson`'s missing-field fallback.
final class _EmptyIdentifierRepository implements FeedbackReportRepository {
  @override
  Future<FeedbackReportResult> submit({
    required FeedbackReportType type,
    required String description,
    required Map<String, dynamic> context,
  }) async => const FeedbackReportResult(issueIdentifier: '', issueUrl: '');
}

final class _RecordingFeedbackRepository implements FeedbackReportRepository {
  final List<Map<String, dynamic>> contexts = [];

  @override
  Future<FeedbackReportResult> submit({
    required FeedbackReportType type,
    required String description,
    required Map<String, dynamic> context,
  }) async {
    contexts.add(context);
    return const FeedbackReportResult(
      issueIdentifier: 'CAN-1',
      issueUrl: 'https://linear.app/x/CAN-1',
    );
  }
}
