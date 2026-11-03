import 'package:flutter/widgets.dart';

/// The feed's own controller. Its positions can lay a transcript out on its
/// newest content during the layout that first shows it, so the frame a chat
/// opens on already holds its latest rows rather than the top of its history.
final class LatestFirstScrollController extends ScrollController {
  LatestFirstScrollController({required this.landedSlack});

  /// Distance from the newest content that counts as being on it.
  final double landedSlack;

  bool _landOnLatestPending = false;

  /// Makes the next layout settle on the newest content.
  void landOnLatestInNextLayout() {
    if (!hasClients) {
      _landOnLatestPending = true;
      return;
    }
    for (final position in positions) {
      if (position is _LatestFirstScrollPosition) {
        position.landOnLatestInNextLayout();
      }
    }
  }

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) {
    final position = _LatestFirstScrollPosition(
      physics: physics,
      context: context,
      initialPixels: initialScrollOffset,
      keepScrollOffset: keepScrollOffset,
      oldPosition: oldPosition,
      debugLabel: debugLabel,
      landedSlack: landedSlack,
    );
    if (_landOnLatestPending) {
      _landOnLatestPending = false;
      position.landOnLatestInNextLayout();
    }
    return position;
  }
}

/// A position that, once asked, corrects itself onto the extent it measures
/// while the viewport is still laying out. The viewport lays the list out
/// again at the corrected offset in the same frame, and a lazy list builds
/// the rows up to there, so its extent becomes exact once it reaches the
/// last row.
///
/// A position resting on the newest content stays there the same way when
/// the content changes under it: a transcript replaced, or a row that grows
/// or shrinks. No frame paints the old offset, and no physics correction
/// starts from an extent that was only an estimate.
final class _LatestFirstScrollPosition extends ScrollPositionWithSingleContext {
  _LatestFirstScrollPosition({
    required super.physics,
    required super.context,
    super.initialPixels,
    super.keepScrollOffset,
    super.oldPosition,
    super.debugLabel,
    required this.landedSlack,
  });

  final double landedSlack;

  /// Corrections allowed for one layout, well inside the viewport's own
  /// limit on layout cycles. The post-frame landing finishes anything left.
  static const int _maxCorrections = 4;

  int _correctionsLeft = 0;

  /// Corrections made to keep a resting position on the newest content
  /// since the last layout that settled.
  int _restingCorrections = 0;

  void landOnLatestInNextLayout() => _correctionsLeft = _maxCorrections;

  /// Runs before the idle activity reacts to the new extent, so the physics
  /// never see an out-of-range position to animate back from. A reader's
  /// drag, a flick, or the animation to the latest content owns the position
  /// while it runs.
  @override
  bool correctForNewDimensions(
    ScrollMetrics oldPosition,
    ScrollMetrics newPosition,
  ) {
    // A position moved since the last layout, by a drag released within one
    // frame say, is no longer resting where the newest content was. Later
    // passes of this layout continue the correction the first one began.
    final restingOnNewest =
        _restingCorrections > 0 ||
        ((oldPosition.maxScrollExtent - oldPosition.pixels).abs() <=
                landedSlack &&
            (newPosition.pixels - oldPosition.pixels).abs() <= landedSlack);
    if (!restingOnNewest ||
        activity!.isScrolling ||
        _restingCorrections >= _maxCorrections) {
      return super.correctForNewDimensions(oldPosition, newPosition);
    }
    final newest = newPosition.maxScrollExtent;
    if (newPosition.pixels == newest) return true;
    _restingCorrections += 1;
    correctPixels(newest);
    return false;
  }

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    if (!super.applyContentDimensions(minScrollExtent, maxScrollExtent)) {
      return false;
    }
    _restingCorrections = 0;
    if (_correctionsLeft <= 0) return true;
    if ((pixels - maxScrollExtent).abs() <= landedSlack) {
      _correctionsLeft = 0;
      return true;
    }
    _correctionsLeft -= 1;
    correctBy(maxScrollExtent - pixels);
    return false;
  }
}
