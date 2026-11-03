import 'package:flutter/material.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/brain_icon.dart';

/// Flat "Thinking" row with the brand brain glyph, mirroring the shared
/// desktop/web `CollapsibleBlock`: collapsed to the label plus an
/// 80-character preview, whether the turn is live or finished, until the user
/// taps it. Expansion is local state, so streamed reasoning neither resets
/// nor forces it.
class ThinkingRow extends StatefulWidget {
  const ThinkingRow({super.key, required this.part});

  final ChatPart part;

  @override
  State<ThinkingRow> createState() => _ThinkingRowState();
}

class _ThinkingRowState extends State<ThinkingRow> {
  /// Desktop `max-h-75`: longer reasoning scrolls inside the panel.
  static const double _panelMaxHeight = 300;

  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final muted = colors.foregroundSecondary;
    final text = widget.part.thinkingText;
    final expanded = _expanded && text != null;
    final preview = text == null
        ? null
        : text.length > 80
        ? '${text.substring(0, 80)}…'
        : text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          container: true,
          button: text != null,
          expanded: text == null ? null : expanded,
          child: InkWell(
            onTap: text == null
                ? null
                : () => setState(() => _expanded = !_expanded),
            borderRadius: BorderRadius.circular(AppRadii.sm),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  SizedBox(
                    width: 16,
                    height: 16,
                    child: Center(child: BrainIcon(size: 14, color: muted)),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'Thinking',
                    style: AppTypography.bodySmall.copyWith(color: muted),
                  ),
                  if (!expanded && preview != null) ...[
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.bodySmall.copyWith(color: muted),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
        if (expanded)
          // Desktop's `<pre>` panel: indented under the label, tinted,
          // bordered and rounded, plain monospace that keeps line breaks.
          Padding(
            padding: const EdgeInsets.only(left: 22, top: 2, bottom: 4),
            child: Container(
              key: const ValueKey('thinking-panel'),
              constraints: const BoxConstraints(maxHeight: _panelMaxHeight),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: colors.foreground.withValues(alpha: 0.02),
                border: Border.all(color: colors.border),
                borderRadius: BorderRadius.circular(AppRadii.sm),
              ),
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                child: SizedBox(
                  width: double.infinity,
                  child: Text(
                    text,
                    style: AppTypography.code.copyWith(color: muted),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
