import 'package:flutter/material.dart';
import 'package:mobile/ui/core/dimens.dart';

/// The geometry of Remote Control's two-line worktree row. Hosts supply
/// status and metadata widgets without coupling the row to their wire model.
class WorkspaceNavigationRow extends StatelessWidget {
  const WorkspaceNavigationRow({
    super.key,
    required this.title,
    required this.metadata,
    this.leading,
    this.titleSignals = const SizedBox.shrink(),
    this.onTap,
    this.centerLeading = false,
  });
  final String title;
  final Widget metadata, titleSignals;
  final Widget? leading;
  final VoidCallback? onTap;
  final bool centerLeading;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return MergeSemantics(
      child: Semantics(
        button: onTap != null,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 56),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppDimens.navRowLeadingInset,
                8,
                4,
                8,
              ),
              child: Row(
                crossAxisAlignment: centerLeading
                    ? CrossAxisAlignment.center
                    : CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    key: const ValueKey('worktree-leading'),
                    width: AppDimens.navRowLeadingSize,
                    height:
                        MediaQuery.textScalerOf(
                          context,
                        ).scale(theme.textTheme.bodyLarge?.fontSize ?? 16) *
                        (theme.textTheme.bodyLarge?.height ?? 1.5),
                    child: Center(child: leading),
                  ),
                  const SizedBox(width: AppDimens.navRowLeadingGap),
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                title,
                                key: const ValueKey('worktree-title'),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodyLarge,
                              ),
                            ),
                            titleSignals,
                          ],
                        ),
                        const SizedBox(height: 2),
                        metadata,
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
