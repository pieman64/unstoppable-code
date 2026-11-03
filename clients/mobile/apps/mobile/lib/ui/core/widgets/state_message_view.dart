import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';

/// The app's single empty/error/blocked state presentation: a large muted
/// CanopyGlyph, a title, optional supporting copy, and up to two
/// actions.
///
/// Replaces the private `_ErrorState` classes that were copy-pasted across
/// stats, members, sub-teams, org settings, member detail, and the feed. Keep
/// per-screen wording in the caller (glyph + title); the layout lives here.
///
/// The body is scroll-wrapped the way [StatsEmptyState] is, so an enclosing
/// [RefreshIndicator] can still be triggered by an over-drag while this view
/// fills the viewport.
class StateMessageView extends StatelessWidget {
  const StateMessageView({
    required this.glyph,
    required this.title,
    this.message,
    this.actionLabel,
    this.onAction,
    this.onRetry,
    this.retryLabel = 'Retry',
    this.scrollable = true,
    super.key,
  });

  /// Leading CanopyGlyph, sized 48 and tinted `onSurfaceVariant`.
  final CanopyGlyph glyph;

  /// Short headline, e.g. 'Could not load stats'.
  final String title;

  /// Optional supporting sentence(s) under the title.
  final String? message;

  /// Label for the primary action. Ignored unless [onAction] is also set.
  final String? actionLabel;

  /// Primary action, e.g. opening the billing page. Omit to render no button.
  final VoidCallback? onAction;

  /// Retry affordance, rendered when no primary action is supplied.
  final Future<void> Function()? onRetry;

  /// Label for the retry affordance.
  final String retryLabel;

  /// Whether to fill and scroll-wrap the available height.
  ///
  /// True (the default) is for a view that owns the whole body region, so an
  /// enclosing [RefreshIndicator] still gets an over-drag to react to. Set
  /// false when this view is one child among many inside an existing scroll
  /// view — there the incoming height constraint is unbounded and the
  /// fill-the-viewport wrapper cannot be laid out.
  final bool scrollable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final actionLabel = this.actionLabel;
    final onAction = this.onAction;
    final onRetry = this.onRetry;
    final message = this.message;

    final children = <Widget>[
      CanopyIcon(
        glyph: glyph,
        size: 48,
        tint: theme.colorScheme.onSurfaceVariant,
      ),
      const SizedBox(height: 16),
      Text(
        title,
        style: theme.textTheme.titleMedium,
        textAlign: TextAlign.center,
      ),
      if (message != null && message.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text(
          message,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
          textAlign: TextAlign.center,
        ),
      ],
      if (onAction != null && actionLabel != null) ...[
        const SizedBox(height: 24),
        FilledButton.tonal(onPressed: onAction, child: Text(actionLabel)),
      ] else if (onRetry != null) ...[
        const SizedBox(height: 24),
        FilledButton.tonal(onPressed: () => onRetry(), child: Text(retryLabel)),
      ],
    ];

    final content = Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: children),
      ),
    );

    if (!scrollable) return content;

    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: content,
        ),
      ),
    );
  }
}
