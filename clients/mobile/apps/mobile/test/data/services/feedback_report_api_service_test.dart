import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/feedback_report.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_report_api_service.dart';

void main() {
  test('submit posts the report with attachDiagnostics false', () async {
    late http.Request captured;
    final service = FeedbackReportApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'reportId': 'r-1',
              'issueIdentifier': 'CAN-9999',
              'issueUrl': 'https://linear.app/x/issue/CAN-9999',
            }),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      ),
    );

    final result = await service.submit(
      type: FeedbackReportType.bug,
      description: 'The activity list scrolls to the top on every refresh.',
      context: <String, dynamic>{'platform': 'ios', 'appVersion': '1.4.0+137'},
    );

    expect(captured.url.path, '/api/v1/feedback/reports');
    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body['type'], 'bug');
    // Mobile has no diagnostics collector, and the wire key is
    // `attachDiagnostics` — the UD Fastly WAF blocks the literal
    // `includeDiagnostics` key at the edge.
    expect(body['attachDiagnostics'], isFalse);
    expect(body['context'], containsPair('platform', 'ios'));
    expect(result.issueIdentifier, 'CAN-9999');
  });

  test('a rejected report surfaces the server message', () async {
    final service = FeedbackReportApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient(
          (request) async => http.Response(
            jsonEncode(<String, dynamic>{
              'error': 'Feedback submission is not currently available.',
            }),
            503,
            headers: <String, String>{'content-type': 'application/json'},
          ),
        ),
      ),
    );

    await expectLater(
      service.submit(
        type: FeedbackReportType.idea,
        description: 'Add a dark app icon.',
        context: const <String, dynamic>{},
      ),
      throwsA(isA<ApiException>()),
    );
  });
}
