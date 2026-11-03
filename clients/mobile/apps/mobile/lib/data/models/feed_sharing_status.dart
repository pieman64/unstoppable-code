/// One kind of the viewer's work, as `GET .../data-sharing` reports it for an
/// organization. This is recent positive evidence, not the viewer's settings:
/// [unknown] proves neither that sharing is off nor that work is missing.
enum FeedSharingState {
  shared,
  private,
  unknown,
  prohibited;

  static FeedSharingState fromWire(Object? value) => switch (value) {
    'shared' => shared,
    'private' => private,
    'prohibited' => prohibited,
    _ => unknown,
  };
}

/// The viewer's data-sharing evidence for the kinds of work Activity shows.
final class FeedSharingStatus {
  const FeedSharingStatus({
    required this.metadata,
    required this.plans,
    required this.summaries,
  });

  factory FeedSharingStatus.fromJson(Map<String, dynamic> json) {
    final scopes = json['scopes'] as Map<String, dynamic>? ?? const {};
    return FeedSharingStatus(
      metadata: FeedSharingState.fromWire(scopes['metadata']),
      plans: FeedSharingState.fromWire(scopes['plans']),
      summaries: FeedSharingState.fromWire(scopes['summaries']),
    );
  }

  /// Work stats: every Activity card needs them.
  final FeedSharingState metadata;
  final FeedSharingState plans;

  /// Work recaps.
  final FeedSharingState summaries;
}
