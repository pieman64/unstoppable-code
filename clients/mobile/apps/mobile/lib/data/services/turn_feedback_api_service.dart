import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the turn-feedback endpoints (`/api/v1/feedback/turns**`).
///
/// These are the same endpoints the desktop app writes to. Mobile reaches them
/// with its Better Auth session bearer, which the server accepts through
/// `getCurrentFeedbackPrincipal`.
final class TurnFeedbackApiService {
  const TurnFeedbackApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Records (or re-records) the rating for one completed assistant turn.
  ///
  /// [eventType] must be one of the server's closed
  /// `TELEMETRY_EVENT_TYPES` values (`packages/protocol/src/telemetry/index.ts`)
  /// — the same value desktop sends for the chat's scope (`'worktree_chat'`
  /// for a worktree chat, `'standalone_chat'` for a cowork/standalone chat).
  /// An unrecognized value is silently dropped server-side, so callers must
  /// not invent a mobile-specific one.
  Future<TurnFeedbackSummary> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    String? provider,
    String? model,
    String? chatMode,
    String? appVersion,
    String? eventType,
  }) async {
    // Absent context is omitted rather than sent as null: the server drops
    // unknown values but a null would still occupy the column.
    final body = <String, dynamic>{
      'clientUserMessageId': clientUserMessageId,
      'clientChatId': clientChatId,
      'rating': turnFeedbackRatingWire(rating),
      'provider': ?provider,
      'model': ?model,
      'chatMode': ?chatMode,
      'appVersion': ?appVersion,
      'eventType': ?eventType,
    };
    final json = await apiClient.postJson('/api/v1/feedback/turns', body: body);
    return TurnFeedbackSummary.fromJson(json);
  }

  /// Amends an existing rating with the thumbs-down reason and/or comment.
  /// Skipping the sheet simply never calls this, so skip cannot undo a rating.
  Future<void> attachDetail({
    required String feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) async {
    await apiClient.patchJson(
      '/api/v1/feedback/turns/${Uri.encodeComponent(feedbackId)}',
      body: <String, dynamic>{
        if (reason != null) 'reason': turnFeedbackReasonWire(reason),
        if (comment != null && comment.isNotEmpty) 'comment': comment,
      },
    );
  }

  /// Retracts a rating the user cleared by tapping the selected thumb again.
  ///
  /// [feedbackId] is percent-encoded rather than interpolated raw: it is a
  /// server-supplied value, and a stray `/` or `?` in one would silently
  /// address a different request than the one intended.
  Future<void> clear(String feedbackId) => apiClient.delete(
    '/api/v1/feedback/turns/${Uri.encodeComponent(feedbackId)}',
  );

  /// The caller's own ratings for one chat, so reopening rehydrates them.
  ///
  /// Decoded row by row: `TurnFeedbackSummary.fromJson` throws a
  /// [FormatException] on an unrecognized `rating` or a missing id, and
  /// mapping the whole array at once let one such row discard every OTHER
  /// rating in the chat. Skipping the bad row degrades to "that one turn shows
  /// no rating" instead, matching `FeedbackOutboxEntry.fromJson`'s rule that
  /// one bad row cannot take the rest down with it.
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId) async {
    final json = await apiClient.getJson(
      '/api/v1/feedback/turns',
      query: <String, String>{'clientChatId': clientChatId},
    );
    final rows = json['feedback'];
    if (rows is! List) return const <TurnFeedbackSummary>[];
    final summaries = <TurnFeedbackSummary>[];
    for (final row in rows) {
      if (row is! Map<String, dynamic>) continue;
      try {
        summaries.add(TurnFeedbackSummary.fromJson(row));
      } on FormatException {
        continue;
      }
    }
    return summaries;
  }
}
