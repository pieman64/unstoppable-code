import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/models/remote_overview_sections.dart';

/// One compact, deduplicated worktree queue pinned above the workspace
/// navigator.
///
/// The desktop Overview groups the same worktree under several categories.
/// On a phone that pushed Browse below the fold and made tasks appear to be
/// separate destinations, so each worktree renders once with every
/// applicable signal on the row.
///
/// Only rows that genuinely need the user are pinned. Merely-working rows
/// (streaming agent, running pipeline) were first split into their own "In
/// progress" group so activity was not presented as an ask (CAN-2808), and
/// are now not pinned at all — they need nothing from the user, and their
/// status still renders on the row inside its project.
class AttentionSections extends StatelessWidget {
  const AttentionSections({
    super.key,
    required this.data,
    required this.rowBuilder,
  });

  final AttentionSectionsData data;
  final Widget Function(AttentionEntry) rowBuilder;

  /// One cap for the queue, not one cap per signal category.
  static const int visibleRowCap = 4;

  @override
  Widget build(BuildContext context) {
    final attention = data.attentionEntries;
    if (attention.isEmpty) return const SizedBox.shrink();

    // A one-child Column rather than the group alone: `attention-sections` is
    // the block-level hook automation and the retained CAN-2808 capture
    // select, and a widget cannot carry two keys.
    return Column(
      key: const ValueKey('attention-sections'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _AttentionGroup(
          key: const ValueKey('attention-group'),
          label: 'Needs attention',
          semanticsLabel: 'Needs attention',
          expanderKey: const ValueKey('attention-more'),
          entries: attention,
          rowBuilder: rowBuilder,
        ),
      ],
    );
  }
}

/// One labeled queue with its own row cap and expander.
class _AttentionGroup extends StatefulWidget {
  const _AttentionGroup({
    super.key,
    required this.label,
    required this.semanticsLabel,
    required this.expanderKey,
    required this.entries,
    required this.rowBuilder,
  });

  final String label;
  final String semanticsLabel;
  final Key expanderKey;
  final List<AttentionEntry> entries;
  final Widget Function(AttentionEntry) rowBuilder;

  @override
  State<_AttentionGroup> createState() => _AttentionGroupState();
}

class _AttentionGroupState extends State<_AttentionGroup> {
  bool _expanded = false;

  @override
  void didUpdateWidget(covariant _AttentionGroup oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_expanded && widget.entries.length <= AttentionSections.visibleRowCap) {
      _expanded = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final entries = widget.entries;
    final visible = _expanded
        ? entries
        : entries.take(AttentionSections.visibleRowCap).toList();
    final overflow = entries.length - visible.length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(
              widget.label,
              semanticsLabel: widget.semanticsLabel,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
            const SizedBox(width: 8),
            _CountPill(count: entries.length),
          ],
        ),
        const SizedBox(height: 4),
        for (final entry in visible)
          KeyedSubtree(
            key: ValueKey(
              'attention-row-${entry.worktree.workspaceLocalId}-${entry.worktree.localId}',
            ),
            child: widget.rowBuilder(entry),
          ),
        if (entries.length > AttentionSections.visibleRowCap)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              key: widget.expanderKey,
              onPressed: () => setState(() => _expanded = !_expanded),
              child: Text(_expanded ? 'Show less' : '+$overflow more'),
            ),
          ),
      ],
    );
  }
}

class _CountPill extends StatelessWidget {
  const _CountPill({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        '$count',
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
