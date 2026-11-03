import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/summary.dart';
import 'background_tray_header.dart';
import 'background_tray_activity_row.dart';

class BackgroundTrayList extends StatefulWidget {
  const BackgroundTrayList({
    super.key,
    required this.summary,
    required this.now,
    this.onOpenAgent,
  });
  final BackgroundTraySummary summary;
  final int now;
  final ValueChanged<BackgroundTrayAgentTarget>? onOpenAgent;

  @override
  State<BackgroundTrayList> createState() => _BackgroundTrayListState();
}

class _BackgroundTrayListState extends State<BackgroundTrayList> {
  final _scroll = ScrollController();
  final _viewport = GlobalKey();
  final _rowKeys = <(Type, String), GlobalKey>{};
  (Type, String)? _open;
  bool _above = false;
  bool _below = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_updateEdges);
  }

  @override
  void didUpdateWidget(BackgroundTrayList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final live = {
      for (final group in widget.summary.groups)
        for (final item in group.items) (item.runtimeType, item.id),
    };
    _rowKeys.removeWhere((key, _) => !live.contains(key));
    if (!live.contains(_open)) _open = null;
  }

  void _updateEdges() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    final above = position.extentBefore > 1;
    final below = position.extentAfter > 1;
    if (_above != above || _below != below) {
      setState(() {
        _above = above;
        _below = below;
      });
    }
  }

  void _toggle((Type, String) id) {
    setState(() => _open = _open == id ? null : id);
    if (_open != id) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _open != id || !_scroll.hasClients) return;
      final row = _rowKeys[id]?.currentContext?.findRenderObject();
      final viewport = _viewport.currentContext?.findRenderObject();
      if (row is! RenderBox || viewport is! RenderBox || !row.attached) return;
      final top = row.localToGlobal(Offset.zero, ancestor: viewport).dy;
      final inset = widget.summary.showsGroupLabels ? 32.0 : 0.0;
      final bottom = top + row.size.height;
      final delta =
          top < inset || row.size.height > viewport.size.height - inset
          ? top - inset
          : bottom > viewport.size.height
          ? bottom - viewport.size.height
          : 0.0;
      final offset = (_scroll.offset + delta).clamp(
        _scroll.position.minScrollExtent,
        _scroll.position.maxScrollExtent,
      );
      if (MediaQuery.disableAnimationsOf(context)) {
        _scroll.jumpTo(offset);
      } else {
        _scroll.animateTo(
          offset,
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (_) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _updateEdges();
        });
        return false;
      },
      child: Stack(
        key: _viewport,
        children: [
          CustomScrollView(
            key: const ValueKey('background-tray-rows'),
            controller: _scroll,
            primary: false,
            shrinkWrap: true,
            slivers: [
              for (final group in widget.summary.groups)
                SliverMainAxisGroup(
                  slivers: [
                    if (widget.summary.showsGroupLabels)
                      SliverPersistentHeader(
                        pinned: true,
                        delegate: _GroupLabel(group.kind.label, colors),
                      ),
                    SliverList.list(
                      children: [
                        for (final item in group.items) _row(item, colors),
                      ],
                    ),
                  ],
                ),
            ],
          ),
          if (_above)
            Positioned(
              top: widget.summary.showsGroupLabels ? 32 : 0,
              left: 0,
              right: 0,
              child: _fade(colors, true),
            ),
          if (_below)
            Positioned(
              bottom: 0,
              left: 0,
              right: 0,
              child: _fade(colors, false),
            ),
        ],
      ),
    );
  }

  Widget _fade(AppColors colors, bool top) => IgnorePointer(
    child: Container(
      height: 16,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: top ? Alignment.topCenter : Alignment.bottomCenter,
          end: top ? Alignment.bottomCenter : Alignment.topCenter,
          colors: [colors['bg-depth'], colors['bg-depth'].withValues(alpha: 0)],
        ),
      ),
    ),
  );

  Widget _row(BackgroundTrayItem item, AppColors colors) {
    final id = (item.runtimeType, item.id);
    final key = _rowKeys.putIfAbsent(id, GlobalKey.new);
    final open = _open == id;
    if (item is! BackgroundTrayRun) {
      return BackgroundTrayActivityRow(
        key: key,
        item: item,
        now: widget.now,
        open: open,
        onToggle: () => _toggle(id),
        onOpenAgent: widget.onOpenAgent,
      );
    }
    final kind = switch (item.kind) {
      BackgroundTrayRunKind.pipeline => BackgroundTrayKind.pipeline,
      BackgroundTrayRunKind.github => BackgroundTrayKind.github,
      BackgroundTrayRunKind.githubPr => BackgroundTrayKind.githubPr,
    };
    final detail = [
      item.question,
      item.note,
      item.repository,
      item.statusLabel,
    ].whereType<String>().where((s) => s.isNotEmpty).join('\n');
    final canInspect = detail.isNotEmpty;
    return Column(
      key: key,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          button: canInspect,
          expanded: canInspect ? open : null,
          child: InkWell(
            onTap: canInspect ? () => _toggle(id) : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 44),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                child: Row(
                  children: [
                    if (canInspect) ...[
                      CanopyIcon(
                        glyph: open
                            ? CanopyGlyph.chevronDownSmall
                            : CanopyGlyph.chevronRightSmall,
                        size: 14,
                        tint: colors.foregroundMuted,
                      ),
                      const SizedBox(width: 4),
                    ],
                    CanopyIcon(
                      glyph: backgroundTrayGlyph(kind),
                      size: 14,
                      tint: colors.foregroundSecondary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        item.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.bodySmall.copyWith(
                          color: colors.foregroundSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (open && canInspect)
          Padding(
            key: ValueKey('background-tray-inspector-${item.id}'),
            padding: const EdgeInsets.fromLTRB(30, 0, 8, 12),
            child: Text(
              detail,
              style: AppTypography.bodySmall.copyWith(
                color: colors.foregroundMuted,
              ),
            ),
          ),
      ],
    );
  }
}

class _GroupLabel extends SliverPersistentHeaderDelegate {
  _GroupLabel(this.label, this.colors);
  final String label;
  final AppColors colors;

  @override
  double get minExtent => 32;
  @override
  double get maxExtent => 32;
  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) => Semantics(
    header: true,
    child: ColoredBox(
      color: colors['bg-depth'],
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Align(
          alignment: Alignment.centerLeft,
          child: Text(
            label,
            style: AppTypography.compactLabel.copyWith(
              color: colors.foregroundMuted,
            ),
          ),
        ),
      ),
    ),
  );
  @override
  bool shouldRebuild(_GroupLabel oldDelegate) =>
      oldDelegate.label != label || oldDelegate.colors != colors;
}
