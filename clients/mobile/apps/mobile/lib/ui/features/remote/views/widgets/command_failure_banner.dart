import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';

/// Compact notice for a desktop command that failed.
///
/// Desktop failures can carry the full process output — a rejected
/// `git commit` echoes the whole commit message plus every hook's log — so
/// the notice shows only the first line, capped at two lines. Tapping it
/// opens the complete, selectable text in a scrollable sheet.
class CommandFailureBanner extends StatelessWidget {
  const CommandFailureBanner({
    super.key,
    required this.message,
    required this.onDismiss,
    this.borderRadius = BorderRadius.zero,
  });

  final String message;
  final VoidCallback onDismiss;
  final BorderRadius borderRadius;

  /// First non-blank line of [message], or the trimmed message when it has
  /// no line breaks.
  static String summaryOf(String message) {
    for (final line in message.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.isNotEmpty) return trimmed;
    }
    return message.trim();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    return Material(
      key: const ValueKey('remote-command-failure'),
      color: colors.background,
      borderRadius: borderRadius,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => showCommandFailureDetails(context, message),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 4, 4),
          child: Row(
            children: [
              CanopyIcon(
                glyph: CanopyGlyph.exclamationTriangle,
                size: 18,
                tint: StatusColors.of(context).destructive,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  summaryOf(message),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.foreground,
                  ),
                ),
              ),
              IconButton(
                key: const ValueKey('remote-command-failure-dismiss'),
                tooltip: 'Dismiss',
                onPressed: onDismiss,
                color: colors.foregroundSecondary,
                icon: const Icon(Icons.close, size: 18),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Opens the full text of a command failure in a scrollable bottom sheet.
Future<void> showCommandFailureDetails(BuildContext context, String message) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (sheetContext) => _CommandFailureDetails(message: message),
  );
}

class _CommandFailureDetails extends StatelessWidget {
  const _CommandFailureDetails({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ConstrainedBox(
      key: const ValueKey('remote-command-failure-details'),
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.75,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Command failed',
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                TextButton(
                  key: const ValueKey('remote-command-failure-copy'),
                  onPressed: () async {
                    final messenger = ScaffoldMessenger.maybeOf(context);
                    await Clipboard.setData(ClipboardData(text: message));
                    messenger?.showSnackBar(
                      const SnackBar(content: Text('Copied')),
                    );
                  },
                  child: const Text('Copy'),
                ),
              ],
            ),
          ),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: SelectableText(message.trim(), style: AppTypography.code),
            ),
          ),
        ],
      ),
    );
  }
}
