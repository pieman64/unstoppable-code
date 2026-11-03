import 'package:mobile/data/models/feedback_report.dart';
import 'package:mobile/data/services/api_client.dart';

/// Files an app-wide feedback report, which the server turns into a tracked
/// issue. Mobile never attaches diagnostics: it has no bundle collector.
final class FeedbackReportApiService {
  const FeedbackReportApiService({required this.apiClient});

  final ApiClient apiClient;

  Future<FeedbackReportResult> submit({
    required FeedbackReportType type,
    required String description,
    required Map<String, dynamic> context,
  }) async {
    final json = await apiClient.postJson(
      '/api/v1/feedback/reports',
      body: <String, dynamic>{
        'type': feedbackReportTypeWire(type),
        'description': description,
        'attachDiagnostics': false,
        'context': context,
      },
    );
    return FeedbackReportResult.fromJson(json);
  }
}
