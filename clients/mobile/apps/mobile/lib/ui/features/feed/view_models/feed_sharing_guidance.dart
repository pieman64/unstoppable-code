import 'package:mobile/data/models/feed_sharing_status.dart';

/// What Activity can honestly say about the viewer's own sharing with a team
/// organization. Mirrors the web's `feed-activity` opt-in resolver.
enum FeedSharingGuidance {
  /// Every allowed kind of work is already shared, or policy alone explains
  /// the gap. Policy never produces an invitation to share.
  none,

  /// The organization prohibits work stats, which every card needs.
  managed,

  /// An allowed kind of work is not known to be shared. The copy invites the
  /// viewer to review sharing without claiming what is missing.
  offer,
}

FeedSharingGuidance resolveFeedSharingGuidance(FeedSharingStatus status) {
  if (status.metadata == FeedSharingState.prohibited) {
    return FeedSharingGuidance.managed;
  }
  final allowed = [
    status.metadata,
    status.plans,
    status.summaries,
  ].where((state) => state != FeedSharingState.prohibited);
  return allowed.any((state) => state != FeedSharingState.shared)
      ? FeedSharingGuidance.offer
      : FeedSharingGuidance.none;
}
