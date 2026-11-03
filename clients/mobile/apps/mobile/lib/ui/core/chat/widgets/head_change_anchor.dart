import 'package:mobile/ui/core/chat/widgets/head_change_anchor_policy.dart';

/// The pending anchor that keeps the reader's row in place while rows above
/// it change: older history prepended, or a cached head replaced.
///
/// The feed restores [messageId]'s row to [viewportOffset] over the frames
/// after a change, starting from [pixels] shifted by the scroll extent added
/// since [maxScrollExtent]. A restore whose [version] is stale stops.
class HeadChangeAnchor {
  String? messageId;
  double? viewportOffset;
  double? pixels;
  double? maxScrollExtent;
  int version = 0;
  bool restoreScheduled = false;

  /// Captures the anchor for a change from [previousIds] to [currentIds]
  /// before the new rows are laid out, so [layoutOf] still measures the
  /// reader's viewport. [scroll] is null while the feed has no position.
  ///
  /// A change can land while the previous one is still being restored — a
  /// bounded snapshot shortens the list, and the older page that this pulls
  /// into range arrives a frame later. The restore in flight then restarts
  /// for both changes, keeping its row and target when that row survives,
  /// since the viewport may not have reached that target yet.
  void captureAcrossChange({
    required ({double pixels, double maxScrollExtent, double viewportExtent})?
    scroll,
    required List<String> currentIds,
    required List<String> previousIds,
    required AnchorRowLayout? Function(String messageId) layoutOf,
  }) {
    final pendingMessageId = restoreScheduled ? messageId : null;
    final pendingViewportOffset = viewportOffset;
    version += 1;
    restoreScheduled = false;
    messageId = null;
    viewportOffset = null;
    if (scroll != null) {
      pixels = scroll.pixels;
      maxScrollExtent = scroll.maxScrollExtent;
      final anchor = selectReaderAnchor(
        currentIds: currentIds,
        previousIds: previousIds,
        layoutOf: layoutOf,
        viewportExtent: scroll.viewportExtent,
      );
      messageId = anchor?.messageId;
      viewportOffset = anchor?.viewportOffset;
    }
    final startPixels = pixels;
    if (pendingMessageId != null &&
        pendingViewportOffset != null &&
        startPixels != null &&
        currentIds.contains(pendingMessageId)) {
      messageId = pendingMessageId;
      viewportOffset = pendingViewportOffset;
      // Measure from where that row would sit at its target now, so the
      // first approximate jump starts from the reader's place.
      final top = layoutOf(pendingMessageId)?.top;
      if (top != null) pixels = startPixels + top - pendingViewportOffset;
    }
  }

  /// Drops the anchor and stops any restore in flight.
  void clear() {
    version += 1;
    restoreScheduled = false;
    messageId = null;
    viewportOffset = null;
    pixels = null;
    maxScrollExtent = null;
  }
}
