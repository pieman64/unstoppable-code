import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/feedback_report.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_report_api_service.dart';

HttpFeedbackReportRepository _build(
  http.Client client, {
  Duration? requestTimeout,
}) => HttpFeedbackReportRepository(
  service: FeedbackReportApiService(
    apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
  ),
  requestTimeout: requestTimeout ?? const Duration(seconds: 30),
);

void main() {
  group('HttpFeedbackReportRepository', () {
    test('a request that never answers is abandoned rather than held '
        'forever', () async {
      // The liveness bound. `ApiClient` sets no timeout and `dart:io`'s
      // HttpClient has no in-flight default, so without this the submit hangs
      // until the OS tears the socket down -- and the sheet holding the user's
      // only copy of the report hangs with it.
      final never = Completer<http.Response>();
      addTearDown(() => never.complete(http.Response('{}', 200)));
      final repo = _build(
        MockClient((_) => never.future),
        requestTimeout: Duration.zero,
      );

      await expectLater(
        repo.submit(
          type: FeedbackReportType.bug,
          description: 'The activity list scrolls to the top on refresh.',
          context: const <String, dynamic>{},
        ),
        throwsA(isA<TimeoutException>()),
      );
    });

    test('a TimeoutException has no server-authored copy, so the sheet falls '
        'back to its own retryable sentence', () async {
      // Pins the reason expiry needs no new copy: it is not an ApiException,
      // so `presentableErrorMessage` returns null and the sheet's generic
      // retryable message is what renders.
      final never = Completer<http.Response>();
      addTearDown(() => never.complete(http.Response('{}', 200)));
      final repo = _build(
        MockClient((_) => never.future),
        requestTimeout: Duration.zero,
      );

      Object? caught;
      try {
        await repo.submit(
          type: FeedbackReportType.idea,
          description: 'Add a dark app icon.',
          context: const <String, dynamic>{},
        );
      } on Object catch (error) {
        caught = error;
      }

      expect(caught, isA<TimeoutException>());
      expect(presentableErrorMessage(caught), isNull);
    });

    test('a request that answers within the bound is unaffected', () async {
      final repo = _build(
        MockClient(
          (_) async => http.Response(
            '{"reportId":"r-1","issueIdentifier":"CAN-4242",'
            '"issueUrl":"https://linear.app/x/issue/CAN-4242"}',
            200,
            headers: <String, String>{'content-type': 'application/json'},
          ),
        ),
      );

      final result = await repo.submit(
        type: FeedbackReportType.bug,
        description: 'Something broke.',
        context: const <String, dynamic>{},
      );

      expect(result.issueIdentifier, 'CAN-4242');
    });
  });
}
