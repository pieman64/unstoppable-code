import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/core/design-system/shimmer/shimmer_text.dart';
import 'package:mobile/ui/core/chat/widgets/step_chevron.dart';
import 'package:mobile/ui/core/chat/widgets/step_words.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';

export 'package:mobile/ui/core/chat/view_models/tool_call_display.dart'
    show ToolCallResult, embeddedToolResult;

/// A single tool call rendered as a flat transcript row, mirroring the shared
/// desktop/web `ToolCallCard`: a fixed icon slot, a friendly `verb + target`
/// label with an optional monospace detail in a lighter ink, words that
/// shimmer while the call runs (desktop `StepRow`), "Failed" said in words
/// rather than color, and a chevron that opens an indented panel showing the
/// tool input and its Result/Error output. Expansion state is local and
/// collapsed by default.
class ToolCallRow extends StatefulWidget {
  const ToolCallRow({
    super.key,
    required this.part,
    this.result,
    this.pending = false,
  });

  final ChatPart part;
  final ToolCallResult? result;

  /// True while the owning turn still streams and no result has landed —
  /// shimmers the label.
  final bool pending;

  @override
  State<ToolCallRow> createState() => _ToolCallRowState();
}

class _ToolCallRowState extends State<ToolCallRow> {
  bool _expanded = false;

  bool get _hasDetailPanel {
    final input = widget.part.toolInput;
    return (input != null && input.isNotEmpty) || widget.result != null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = StatusColors.of(context);
    final label = toolCallLabel(widget.part);
    final result = widget.result;
    final colors = AppColors.of(context);
    final isError = result?.isError ?? false;
    final iconColor = colors.foregroundSecondary;
    final mutedText = theme.textTheme.labelMedium?.copyWith(
      color: colors.foregroundSecondary,
    );
    final running = widget.pending && result == null;

    final words = StepWords(
      words: Text(
        label.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: mutedText,
      ),
      detail: switch (label.detail) {
        final detail? => Text(
          detail,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: mutedText?.copyWith(
            color: colors.foregroundMuted,
            fontFamily: AppTypography.monoFamily,
          ),
        ),
        null => null,
      },
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          button: _hasDetailPanel,
          expanded: _hasDetailPanel ? _expanded : null,
          child: InkWell(
            onTap: _hasDetailPanel
                ? () => setState(() => _expanded = !_expanded)
                : null,
            borderRadius: BorderRadius.circular(6),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 16,
                    height: 16,
                    child: isComputerUseTool(widget.part)
                        ? CanopyIcon(
                            glyph: CanopyGlyph.cursorClick,
                            size: 14,
                            tint: iconColor,
                          )
                        : Icon(
                            toolFamilyIcon(widget.part.toolFamily),
                            size: 14,
                            color: iconColor,
                          ),
                  ),
                  const SizedBox(width: 6),
                  // The words stay whole and the detail ends in "…" first,
                  // as on desktop; both stay inside the row on phone widths.
                  Flexible(child: running ? Shimmer(child: words) : words),
                  if (isError) ...[
                    const SizedBox(width: 6),
                    Text(
                      'Failed',
                      key: const ValueKey('tool-call-failed'),
                      style: mutedText?.copyWith(color: colors.foregroundMuted),
                    ),
                  ],
                  if (!running && _hasDetailPanel) ...[
                    const SizedBox(width: 4),
                    StepChevron(open: _expanded),
                  ],
                ],
              ),
            ),
          ),
        ),
        if (_expanded && _hasDetailPanel)
          Container(
            key: const ValueKey('tool-call-detail'),
            margin: const EdgeInsets.only(left: 22, top: 2, bottom: 4),
            decoration: BoxDecoration(
              border: Border.all(color: theme.colorScheme.outlineVariant),
              borderRadius: BorderRadius.circular(6),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (widget.part.toolInput case final input?
                    when input.isNotEmpty)
                  _DetailText(text: input),
                if (result != null) ...[
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      border: Border(
                        top: BorderSide(
                          color: theme.colorScheme.outlineVariant,
                        ),
                      ),
                    ),
                    child: Text(
                      result.isError ? 'Error' : 'Result',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontWeight: AppTypography.emphasisWeight,
                        fontVariations: AppTypography.emphasisVariations,
                      ),
                    ),
                  ),
                  _DetailText(
                    text: result.content,
                    color: result.isError ? status.destructive : null,
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _DetailText extends StatefulWidget {
  const _DetailText({required this.text, this.color});

  final String text;
  final Color? color;

  @override
  State<_DetailText> createState() => _DetailTextState();
}

class _DetailTextState extends State<_DetailText> {
  /// Lines shown before the "Show more" affordance. Producer-side truncation
  /// caps a part at 4000 chars, which could otherwise render a 2000+ px
  /// panel inside the transcript.
  static const int _collapsedMaxLines = 16;

  bool _showAll = false;
  late bool _overflows;

  @override
  void initState() {
    super.initState();
    _overflows = _computeOverflows();
  }

  @override
  void didUpdateWidget(_DetailText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) {
      // New content: recompute once (not per build — expanded panels rebuild
      // with the streaming transcript) and drop the previous expansion.
      _overflows = _computeOverflows();
      _showAll = false;
    }
  }

  // Newline count catches structured output; the length guard catches a
  // single-line blob that soft-wraps past the cap.
  bool _computeOverflows() =>
      widget.text.length > 1200 ||
      '\n'.allMatches(widget.text).length + 1 > _collapsedMaxLines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Deliberately not scrollable: a nested vertical scrollable would win
    // the gesture arena and stop drags over the panel from scrolling the
    // transcript. Long content is bounded with maxLines + "Show more"
    // instead, so the parent keeps the drag and the transcript stays
    // navigable.
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: double.infinity,
            child: Text(
              widget.text,
              maxLines: _showAll ? null : _collapsedMaxLines,
              overflow: _showAll ? null : TextOverflow.ellipsis,
              style: AppTypography.code.copyWith(
                color: widget.color ?? theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          if (_overflows && !_showAll)
            Semantics(
              button: true,
              child: InkWell(
                onTap: () => setState(() => _showAll = true),
                child: ConstrainedBox(
                  // Accessible tap target — a bare text row is ~14 px tall.
                  constraints: const BoxConstraints(minHeight: 44),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Show more',
                      key: const ValueKey('tool-call-show-more'),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.primary,
                        fontWeight: AppTypography.emphasisWeight,
                        fontVariations: AppTypography.emphasisVariations,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
