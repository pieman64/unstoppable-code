import 'dart:math' as math;

import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/foundation.dart' show precisionErrorTolerance;
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart' show nearEqual;
import 'package:flutter/rendering.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/features/feed/view_models/feed_sharing_guidance.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_card.dart';
import 'package:mobile/ui/features/feed/views/feed_reader_anchor_policy.dart';
import 'package:mobile/ui/features/feed/views/widgets/feed_filter_sheet.dart';
import 'package:mobile/ui/features/feed/views/widgets/feed_sharing_notice.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/organizations/views/widgets/org_lapse_state_view.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';

/// The activity-feed screen.
///
/// Reads [FeedViewModel] from the widget tree (injected via [ChangeNotifierProvider]
/// in main).  Uses [ListenableBuilder] so the scaffold itself never rebuilds —
/// only the body region re-renders on state changes.
class FeedScreen extends StatefulWidget {
  const FeedScreen({
    super.key,
    this.notice,
    this.organizationName,
    this.onViewPersonal,
  });

  /// An optional notice from the host shell, shown first above the feed. It
  /// sizes itself, including its bottom gap, and may render nothing.
  final Widget? notice;

  /// The selected team's name, for the sharing notice.
  final String? organizationName;

  /// Selects Personal Activity from the sharing notice; null when the account
  /// has no Personal organization.
  final VoidCallback? onViewPersonal;

  @override
  State<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<FeedScreen> {
  // The primary scroll controller of the screen's Scaffold, which scrolls
  // the list to its top on a status bar tap.
  final _scroll = _ListEndController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Read (not watch): the [ListenableBuilder] below is what subscribes to the
    // view model and rebuilds the body. Watching here would additionally rebuild
    // the whole Scaffold/AppBar — which read nothing reactive — on every notify.
    final viewModel = context.read<FeedViewModel>();
    // Read (not watch) the members view model too: it only supplies the actor
    // picker's member list when the filter sheet is opened, so the screen does
    // not need to rebuild when its state changes. Personal Activity has no
    // members, so it mounts none and the sheet offers no member filter.
    final membersViewModel = context.read<MembersViewModel?>();

    final scaffold = CanopyScaffold(
      appBar: CanopyAppBar(
        leading: Align(
          alignment: Alignment.centerLeft,
          child: HomeMenuButton.maybeOf(context, designSystem: true),
        ),
        actionExtent: 96,
        content: const Text('Timeline'),
        trailing: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            // Only the filter icon reacts to filter changes; the rest of the
            // app bar stays static (see the read-not-watch note above).
            ListenableBuilder(
              listenable: viewModel,
              builder: (context, _) => Semantics(
                toggled: viewModel.hasActiveFilters,
                child: Badge(
                  key: const ValueKey('activity-filter-indicator'),
                  isLabelVisible: viewModel.hasActiveFilters,
                  child: CanopyIconButton(
                    glyph: CanopyGlyph.filter1,
                    tooltip: 'Filter activity',
                    onPressed: () => showFeedFilterSheet(
                      context,
                      viewModel,
                      membersViewModel,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
      body: ListenableBuilder(
        listenable: viewModel,
        builder: (context, _) {
          final items = viewModel.items;
          final lapse = viewModel.planLapse;
          if (lapse != null) {
            // The org lost its team features. Retry can never succeed, so
            // the screen offers the billing remedy instead.
            return OrgLapseStateView(lapse: lapse);
          }
          // A reload of a known empty feed keeps the list (and its pull
          // gesture); only a first load for these filters shows a spinner.
          if (items.isEmpty && viewModel.isLoading && !viewModel.hasLoaded) {
            return const Center(child: CircularProgressIndicator());
          }
          if (items.isEmpty && viewModel.error != null) {
            return StateMessageView(
              glyph: CanopyGlyph.warningSign,
              title: 'Could not load activity',
              // Server-authored 4xx copy only; never the exception itself,
              // whose toString() embeds the whole raw response body.
              message: viewModel.errorMessage,
              onRetry: viewModel.loadFeed,
            );
          }

          // Rows stay readable while a reload runs or after it fails; one
          // scroll view keeps pull-to-refresh on short and empty lists.
          final header = <Widget>[
            ?widget.notice,
            if (viewModel.error != null)
              _gap(
                InlineNotice(
                  key: const ValueKey('feed-refresh-failed'),
                  glyph: CanopyGlyph.warningSign,
                  state: 'Could not refresh activity.',
                  explanation: viewModel.errorMessage,
                  actions: [
                    (
                      label: 'Retry',
                      glyph: CanopyGlyph.arrowRotateClockwise,
                      onPressed: viewModel.loadFeed,
                    ),
                  ],
                ),
              ),
            if (viewModel.sharingGuidance case final guidance
                when guidance != FeedSharingGuidance.none)
              _gap(
                FeedSharingNotice(
                  guidance: guidance,
                  organizationName: widget.organizationName,
                  onViewPersonal: widget.onViewPersonal,
                ),
              ),
          ];
          return _FeedList(
            viewModel: viewModel,
            header: header,
            controller: _scroll,
          );
        },
      ),
    );
    return PrimaryScrollController(controller: _scroll, child: scaffold);
  }
}

Widget _gap(Widget child) =>
    Padding(padding: const EdgeInsets.only(bottom: 8), child: child);

/// The header, rows and footer in one scroll view.
///
/// A refresh or Load more must not move the rows a reader sees. Scroll
/// offsets therefore start at the first row the reader sees in full below
/// the app bar. Rows before it lay out upward from it, so rows added,
/// changed or removed above it do not push it. The start moves to the
/// reader's row when the rows change and after a scroll ends. At the top,
/// offsets start at the header, so new rows show first. The scroll ends
/// where the content ends; see [_ListEndPosition].
class _FeedList extends StatefulWidget {
  const _FeedList({
    required this.viewModel,
    required this.header,
    required this.controller,
  });

  final FeedViewModel viewModel;
  final List<Widget> header;
  final _ListEndController controller;

  @override
  State<_FeedList> createState() => _FeedListState();
}

class _FeedListState extends State<_FeedList> {
  static const _headerKey = ValueKey('feed-header');
  static const _rowsKey = ValueKey('feed-rows');

  final _rowKeys = <String, GlobalKey>{};
  List<FeedItem> _shown = const [];

  /// The ID of the row that scroll offsets start at; null for the header.
  String? _start;

  /// Moves the start of the scroll offsets to the reader's row (see
  /// [feedReaderAnchor]), and keeps that row where it is on screen. Runs in
  /// build, so the rows still have their last layout and the new rows lay out
  /// from the new start in the same frame. Each move is a correction, so that
  /// layout checks the new offset against the ends even when the extents stay
  /// the same.
  void _startAtReader() {
    final scroll = widget.controller;
    if (!scroll.hasClients) return;
    final position = scroll.position;
    if (!position.hasContentDimensions) return;
    final anchor = feedReaderAnchor(
      shown: _shown,
      current: widget.viewModel.items,
      start: _start,
      pixels: position.pixels,
      minScrollExtent: position.minScrollExtent,
      top: CanopyScaffold.contentPaddingOf(context).top,
      revealOffsetOf: _revealOffsetOf,
    );
    if (anchor == null) return;
    position.correctBy(anchor.correction);
    _start = anchor.start;
  }

  /// The scroll offset that reveals the row's top, from its last layout; the
  /// scroll may have moved since. Null when the row has no layout.
  double? _revealOffsetOf(String id) {
    final box = _rowKeys[id]?.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return null;
    return RenderAbstractViewport.of(box).getOffsetToReveal(box, 0).offset;
  }

  Widget _row(FeedItem item) => KeyedSubtree(
    key: _rowKeys.putIfAbsent(item.id, GlobalKey.new),
    child: _gap(FeedCard(item: item)),
  );

  @override
  Widget build(BuildContext context) {
    _startAtReader();
    final viewModel = widget.viewModel;
    final items = _shown = viewModel.items;
    final ids = {for (final item in items) item.id};
    _rowKeys.removeWhere((id, _) => !ids.contains(id));
    final start = items.indexWhere((item) => item.id == _start);
    final above = start < 0 ? const <FeedItem>[] : items.sublist(0, start);
    final rows = start < 0 ? items : items.sublist(start);
    final inset = CanopyScaffold.contentPaddingOf(context);
    final sides = EdgeInsets.only(
      left: inset.left + 16,
      right: inset.right + 16,
    );
    return NotificationListener<ScrollEndNotification>(
      onNotification: (notification) {
        // The next build moves the start to the row the reader stopped on.
        if (notification.depth == 0) setState(() {});
        return false;
      },
      child: RefreshIndicator(
        edgeOffset: inset.top,
        onRefresh: viewModel.loadFeed,
        child: CustomScrollView(
          controller: widget.controller,
          physics: const AlwaysScrollableScrollPhysics(),
          center: start < 0 ? _headerKey : _rowsKey,
          slivers: [
            SliverPadding(
              key: _headerKey,
              padding: sides.copyWith(top: inset.top + 8),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: widget.header,
                ),
              ),
            ),
            // The rows before the start lay out upward, nearest first.
            SliverPadding(
              padding: sides,
              sliver: SliverList.builder(
                itemCount: above.length,
                itemBuilder: (context, i) => _row(above[above.length - 1 - i]),
              ),
            ),
            SliverPadding(
              key: _rowsKey,
              padding: sides,
              sliver: SliverList.builder(
                itemCount: rows.length,
                itemBuilder: (context, i) => _row(rows[i]),
              ),
            ),
            SliverPadding(
              key: widget.controller.endKey,
              padding: sides.copyWith(bottom: inset.bottom + 8),
              sliver: SliverList.list(
                children: [
                  if (items.isEmpty)
                    const StateMessageView(
                      glyph: CanopyGlyph.arrowInbox,
                      title: 'No activity yet',
                      scrollable: false,
                    ),
                  if (viewModel.hasMore) _LoadMoreFooter(viewModel: viewModel),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Creates the [_ListEndPosition] of the feed list.
///
/// Its offsets count from the top of the list, as for any list, so a status
/// bar tap reaches the top. The position's offsets start at the start row,
/// so its top can be below 0.
final class _ListEndController extends ScrollController {
  /// The key of the sliver after the rows.
  final endKey = GlobalKey();

  /// The scroll offset of the end of the content: the extent of the start
  /// sliver and the slivers after it, from the current layout.
  double? _contentEnd() {
    final viewport = endKey.currentContext?.findRenderObject()?.parent;
    if (viewport is! RenderViewport) return null;
    var end = 0.0;
    for (
      var sliver = viewport.center;
      sliver != null;
      sliver = viewport.childAfter(sliver)
    ) {
      final geometry = sliver.geometry;
      if (geometry == null) return null;
      end += geometry.scrollExtent;
    }
    return end;
  }

  @override
  double get offset => position.pixels - position.minScrollExtent;

  @override
  void jumpTo(double value) {
    for (final position in positions) {
      position.jumpTo(position.minScrollExtent + value);
    }
  }

  @override
  Future<void> animateTo(
    double offset, {
    required Duration duration,
    required Curve curve,
  }) async {
    await Future.wait([
      for (final position in positions.whereType<_ListEndPosition>())
        position.animateFromTop(offset, duration: duration, curve: curve),
    ]);
  }

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) => _ListEndPosition(
    physics: physics,
    context: context,
    oldPosition: oldPosition,
    contentEnd: _contentEnd,
  );
}

/// A scroll position that stops where the content ends.
///
/// A viewport never reports a max scroll extent below 0, the offset that puts
/// its center sliver at the top. When the rows from the start row down are
/// shorter than the viewport, the reader could then scroll the last row up
/// and leave empty space below it.
final class _ListEndPosition extends ScrollPositionWithSingleContext {
  // Offsets depend on the start row, so a remounted list starts at the top.
  _ListEndPosition({
    required super.physics,
    required super.context,
    super.oldPosition,
    required this.contentEnd,
  }) : super(keepScrollOffset: false);

  final double? Function() contentEnd;

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    final end = contentEnd();
    return super.applyContentDimensions(
      minScrollExtent,
      end == null
          ? maxScrollExtent
          : math.max(minScrollExtent, end - viewportDimension),
    );
  }

  @override
  bool correctForNewDimensions(
    ScrollMetrics oldPosition,
    ScrollMetrics newPosition,
  ) {
    // Moving the start row changes the offsets, so the physics no longer
    // keeps a resting position within the ends when rows go. Stop at the end
    // in this layout, before the frame paints the space past it.
    if (activity!.velocity == 0 &&
        !oldPosition.outOfRange &&
        newPosition.outOfRange) {
      correctPixels(
        newPosition.pixels.clamp(
          newPosition.minScrollExtent,
          newPosition.maxScrollExtent,
        ),
      );
      return false;
    }
    return super.correctForNewDimensions(oldPosition, newPosition);
  }

  @override
  double setPixels(double newPixels) {
    final overscroll = super.setPixels(newPixels);
    // The top is below 0 while offsets start at a row, and a drag or fling
    // that ends there can stop a rounding error short of it. Rest exactly
    // at the top, so new rows show first and a pull refreshes.
    if ((pixels - minScrollExtent).abs() < precisionErrorTolerance) {
      correctPixels(minScrollExtent);
    }
    return overscroll;
  }

  /// Animates to [offset] from the top. The motion ends at the top while the
  /// start row moves, so a refresh that lands midway does not interrupt it.
  Future<void> animateFromTop(
    double offset, {
    required Duration duration,
    required Curve curve,
  }) {
    final from = pixels - minScrollExtent;
    if ((offset - from).abs() <= physics.toleranceFor(this).distance) {
      jumpTo(minScrollExtent + offset);
      return Future<void>.value();
    }
    final activity = _StartRowScrollActivity(
      this,
      from: from,
      to: offset,
      end: (position) => position.minScrollExtent + offset,
      duration: duration,
      curve: curve,
      vsync: context.vsync,
    );
    beginActivity(activity);
    return activity.done;
  }

  /// Animates to [to], as any scroll position does. The motion keeps its
  /// distance over the rows while the start row moves, so a keyboard page or
  /// a reveal that a refresh lands during ends where it would have.
  @override
  Future<void> animateTo(
    double to, {
    required Duration duration,
    required Curve curve,
  }) {
    if (nearEqual(to, pixels, physics.toleranceFor(this).distance)) {
      jumpTo(to);
      return Future<void>.value();
    }
    final activity = _StartRowScrollActivity(
      this,
      from: pixels,
      to: to,
      duration: duration,
      curve: curve,
      vsync: context.vsync,
    );
    beginActivity(activity);
    return activity.done;
  }
}

/// Drives a [_ListEndPosition] through an animation that the start row can
/// move under.
///
/// A move of the start row shifts the offsets under the rows. The rest of the
/// motion shifts with them, so the rows keep their place in that frame and
/// move on smoothly. With an [end] that follows the content, such as the top
/// when rows arrive above, the rest of the motion also stretches or shrinks
/// to reach it.
final class _StartRowScrollActivity extends DrivenScrollActivity {
  _StartRowScrollActivity(
    this._position, {
    required double from,
    required double to,
    double Function(ScrollMetrics position)? end,
    required super.duration,
    required super.curve,
    required super.vsync,
  }) : _to = to,
       _followEnd = end,
       _value = from,
       _pixels = _position.pixels,
       _end = end?.call(_position) ?? to,
       super(_position, from: from, to: to);

  /// The position that the motion moves. A scroll view replaces its position
  /// when its dependencies, such as the theme, change, and the new position
  /// takes the motion over.
  ScrollPositionWithSingleContext _position;
  final double _to;
  final double Function(ScrollMetrics position)? _followEnd;

  /// The animation value of the last move.
  double _value;

  /// The pixels after the last move.
  double _pixels;

  /// The pixels where the motion ends.
  double _end;

  /// The rest of the motion for each unit of the rest of the animation.
  double _scale = 1;

  @override
  double get velocity => super.velocity * _scale;

  @override
  void updateDelegate(ScrollActivityDelegate value) {
    super.updateDelegate(value);
    if (value is ScrollPositionWithSingleContext) _position = value;
  }

  @override
  bool applyMoveTo(double value) {
    final pixels = _position.pixels;
    // Anything else that moved the pixels since the last move shifted the
    // offsets under the rows.
    final end = _followEnd?.call(_position) ?? _end + pixels - _pixels;
    final rest = _value - _to;
    if ((pixels - end - (_pixels - _end)).abs() >= precisionErrorTolerance &&
        rest.abs() >= precisionErrorTolerance) {
      _scale = (pixels - end) / rest;
    }
    _end = end;
    _value = value;
    final applied = super.applyMoveTo(end + (value - _to) * _scale);
    _pixels = _position.pixels;
    return applied;
  }
}

/// The end of a page with more behind it: an explicit Load more, its progress,
/// or an append-specific retry. Earlier rows stay in place throughout.
class _LoadMoreFooter extends StatelessWidget {
  const _LoadMoreFooter({required this.viewModel});

  final FeedViewModel viewModel;

  @override
  Widget build(BuildContext context) {
    final Widget child;
    if (viewModel.isLoadingMore) {
      child = const Padding(
        padding: EdgeInsets.all(12),
        child: SizedBox.square(
          dimension: 24,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            semanticsLabel: 'Loading more activity',
          ),
        ),
      );
    } else if (viewModel.loadMoreError != null) {
      child = InlineNotice(
        key: const ValueKey('feed-load-more-failed'),
        glyph: CanopyGlyph.warningSign,
        state: 'Could not load more activity.',
        actions: [
          (
            label: 'Retry',
            glyph: CanopyGlyph.arrowRotateClockwise,
            onPressed: viewModel.loadMore,
          ),
        ],
      );
    } else {
      child = OutlinedButton(
        key: const ValueKey('feed-load-more'),
        onPressed: viewModel.loadMore,
        child: const Text('Load more'),
      );
    }
    return Center(child: child);
  }
}
