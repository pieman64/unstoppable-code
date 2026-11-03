import 'package:flutter/material.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/widgets/message_bubble_surface.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/chat_glyph.dart';

/// A user message a fired watcher posted: the user bubble on the info tint,
/// with the watcher title above [child] (desktop `WatcherFiredTitle` and
/// `BUBBLE_INFO_SURFACE_CLASS`). A merged message's title opens a sheet with
/// each watcher it carries, where desktop shows a hover tooltip.
class WatcherMessageBubble extends StatelessWidget {
  const WatcherMessageBubble({
    super.key,
    required this.messageId,
    required this.watcherFired,
    this.child,
  });

  final String messageId;
  final ChatWatcherFiredInfo watcherFired;

  /// The message's visible content, when it has any.
  final Widget? child;

  @override
  Widget build(BuildContext context) => MessageBubbleSurface(
    key: ValueKey('watcher-bubble-$messageId'),
    color: AppColors.of(context)['bg-info-subtle'],
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _WatcherFiredTitle(messageId: messageId, watcherFired: watcherFired),
        ?child,
      ],
    ),
  );
}

class _WatcherFiredTitle extends StatelessWidget {
  const _WatcherFiredTitle({
    required this.messageId,
    required this.watcherFired,
  });

  final String messageId;
  final ChatWatcherFiredInfo watcherFired;

  @override
  Widget build(BuildContext context) {
    final ink = StatusColors.of(context).unread;
    final merged = watcherFired.isMerged;
    final title = merged
        ? watcherFired.kind
        : '${watcherFired.kind} watcher has fired';
    final row = Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          ChatIcon(glyph: ChatGlyph.watcher, size: 14, color: ink),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              title,
              style: AppTypography.compactLabel.copyWith(color: ink),
            ),
          ),
        ],
      ),
    );
    if (!merged) {
      return Semantics(
        key: ValueKey('watcher-title-$messageId'),
        container: true,
        label: title,
        excludeSemantics: true,
        child: row,
      );
    }
    void open() => _showWatcherDetails(context, watcherFired);
    return Semantics(
      key: ValueKey('watcher-title-$messageId'),
      container: true,
      button: true,
      label: title,
      onTap: open,
      excludeSemantics: true,
      child: InkWell(
        onTap: open,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
          child: Align(alignment: Alignment.centerLeft, child: row),
        ),
      ),
    );
  }
}

Future<void> _showWatcherDetails(
  BuildContext context,
  ChatWatcherFiredInfo watcherFired,
) => showModalBottomSheet<void>(
  context: context,
  showDragHandle: true,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (_) => SafeArea(child: _WatcherDetails(watcherFired: watcherFired)),
);

class _WatcherDetails extends StatelessWidget {
  const _WatcherDetails({required this.watcherFired});

  final ChatWatcherFiredInfo watcherFired;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final ink = StatusColors.of(context).unread;
    final entries = watcherFired.combinedWatchers ?? const [];
    return ListView(
      key: const ValueKey('watcher-details-sheet'),
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      children: [
        Text(
          watcherFired.kind,
          style: AppTypography.title.copyWith(color: colors.foreground),
        ),
        for (final (index, entry) in entries.indexed) ...[
          if (index > 0) Divider(height: 1, color: colors.border),
          Padding(
            key: ValueKey('watcher-details-entry-$index'),
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${entry.kind} watcher has fired',
                  style: AppTypography.compactLabel.copyWith(color: ink),
                ),
                const SizedBox(height: 2),
                Text(
                  entry.text,
                  style: AppTypography.body.copyWith(
                    color: colors.foregroundSecondary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
