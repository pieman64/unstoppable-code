/// Wire model for app-wide feedback reports (`/api/v1/feedback/reports`).
/// Mirrors `apps/web/src/lib/feedback/feedback-contracts.ts`.
library;

enum FeedbackReportType { bug, idea }

String feedbackReportTypeWire(FeedbackReportType type) => switch (type) {
  FeedbackReportType.bug => 'bug',
  FeedbackReportType.idea => 'idea',
};

/// Matches `MAX_FEEDBACK_DESCRIPTION_LENGTH` on the server.
const int maxFeedbackDescriptionLength = 20000;

final class FeedbackReportResult {
  const FeedbackReportResult({
    required this.issueIdentifier,
    required this.issueUrl,
  });

  final String issueIdentifier;
  final String issueUrl;

  factory FeedbackReportResult.fromJson(Map<String, dynamic> json) {
    final identifier = json['issueIdentifier'];
    final url = json['issueUrl'];
    return FeedbackReportResult(
      issueIdentifier: identifier is String ? identifier : '',
      issueUrl: url is String ? url : '',
    );
  }
}
