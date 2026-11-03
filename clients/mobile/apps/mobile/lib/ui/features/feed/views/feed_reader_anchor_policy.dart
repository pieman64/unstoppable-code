import 'package:mobile/data/protocol/generated/feed.dart';

/// A new start for the feed list's scroll offsets: the row they start at
/// (null for the header), and the scroll correction that keeps the reader's
/// rows where they are on screen.
typedef FeedReaderAnchor = ({String? start, double correction});

/// Where the feed list's scroll offsets start after its rows change.
///
/// That is the first of the [shown] rows, in order, that [current] still
/// holds with the same occurredAt and that the reader sees in full below
/// [top]: its offset to reveal, from [revealOffsetOf], less [pixels] is at
/// least [top]. Rows without a measurement are skipped. At the top
/// ([pixels] at most [minScrollExtent]), offsets start at the header. When
/// no row qualifies and [start] is gone from [current], they start at the
/// header again, which keeps the distance from the top.
///
/// Null when the start stays [start].
FeedReaderAnchor? feedReaderAnchor({
  required List<FeedItem> shown,
  required List<FeedItem> current,
  required String? start,
  required double pixels,
  required double minScrollExtent,
  required double top,
  required double? Function(String id) revealOffsetOf,
}) {
  if (pixels <= minScrollExtent) {
    return start == null ? null : (start: null, correction: -minScrollExtent);
  }
  final occurredAt = {for (final item in current) item.id: item.occurredAt};
  for (final item in shown) {
    if (occurredAt[item.id] != item.occurredAt) continue;
    final reveal = revealOffsetOf(item.id);
    if (reveal == null || reveal - pixels < top) continue;
    return item.id == start ? null : (start: item.id, correction: -reveal);
  }
  if (start != null && !occurredAt.containsKey(start)) {
    return (start: null, correction: -minScrollExtent);
  }
  return null;
}
