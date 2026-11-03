/// A laid-out row: its top relative to the viewport top, and its height.
typedef AnchorRowLayout = ({double top, double height});

/// The reader's row and where its top sits in the viewport.
typedef ReaderAnchor = ({String messageId, double viewportOffset});

/// The row to hold in place while rows above it change, chosen from
/// [layoutOf]'s measurements of the transcript before the change.
///
/// That is the first row of [currentIds] on screen. When every row the
/// reader can see is gone from [previousIds]' replacement, the first
/// surviving row after them takes the place of the first one, so the reader
/// lands next to what they were reading. Null when no row qualifies.
ReaderAnchor? selectReaderAnchor({
  required Iterable<String> currentIds,
  required Iterable<String> previousIds,
  required AnchorRowLayout? Function(String messageId) layoutOf,
  required double viewportExtent,
}) {
  double? visibleTop(String messageId) {
    final row = layoutOf(messageId);
    if (row == null || row.top + row.height <= 0 || row.top >= viewportExtent) {
      return null;
    }
    return row.top;
  }

  for (final messageId in currentIds) {
    final top = visibleTop(messageId);
    if (top != null) return (messageId: messageId, viewportOffset: top);
  }
  final surviving = currentIds.toSet();
  double? readerTop;
  for (final messageId in previousIds) {
    readerTop ??= visibleTop(messageId);
    if (readerTop != null && surviving.contains(messageId)) {
      return (messageId: messageId, viewportOffset: readerTop);
    }
  }
  return null;
}
