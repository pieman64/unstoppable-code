import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/widgets/thinking_row.dart';
import 'package:mobile/ui/core/chat/widgets/tool_call_row.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';

/// A subagent (`agent`) part, mirroring the shared desktop/web
/// `AgentBlockCard`: an `Agent · type` header with a description preview, a
/// spinner while it runs, and an expanded panel with its configuration,
/// usage, the agent's own replies and tool rows (nested agents included),
/// and its result and prompt. Expansion state is local and collapsed by
/// default.
class AgentCard extends StatefulWidget {
  const AgentCard({super.key, required this.part});

  final ChatPart part;

  @override
  State<AgentCard> createState() => _AgentCardState();
}

/// Below this panel width, nested levels indent less.
const double _compactWidth = 280;

/// Results of the [parts]' tool calls that arrive as separate `tool_result`
/// parts, keyed by tool-use id, so each pairs with its `tool_use` row as in
/// the shared card. Only ids with a `tool_use` among [parts] are paired.
Map<String, ToolCallResult> pairedToolResults(List<ChatPart> parts) {
  final calls = {
    for (final part in parts)
      if (part.kind == 'tool_use') ?part.toolUseId,
  };
  return {
    for (final part in parts)
      if (part.kind == 'tool_result' &&
          calls.contains(part.toolUseId) &&
          (part.toolOutput != null || part.isToolError))
        part.toolUseId!: (
          content: part.toolOutput ?? 'Error',
          isError: part.isToolError,
        ),
  };
}

class _AgentCardState extends State<AgentCard> {
  bool _expanded = false, _showResult = false, _showPrompt = false;

  Map<String, dynamic> get _data => widget.part.data ?? const {};
  String? _string(String key) => switch (_data[key]) {
    final String value when value.trim().isNotEmpty => value,
    _ => null,
  };

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final destructive = StatusColors.of(context).destructive;
    final muted = colors.foregroundSecondary;
    final small = AppTypography.bodySmall.copyWith(color: muted);
    final type = _string('subagentType') ?? 'Agent';
    final description = _string('description');
    final prompt = _string('prompt');
    final result = _string('result');
    final running = _data['isRunning'] == true;
    final failed = _data['isError'] == true;
    final background = _data['runInBackground'] == true;
    final preview = description == null
        ? null
        : description.length > 80
        ? '${description.substring(0, 80)}…'
        : description;
    final label = type.trim().toLowerCase() == 'agent'
        ? 'Agent'
        : 'Agent · $type';

    final header = Semantics(
      button: true,
      expanded: _expanded,
      child: InkWell(
        key: const ValueKey('agent-card-header'),
        onTap: () => setState(() => _expanded = !_expanded),
        borderRadius: BorderRadius.circular(AppRadii.sm),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(
            children: [
              CanopyIcon(
                glyph: CanopyGlyph.agent,
                size: 16,
                tint: failed ? destructive : muted,
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: small,
                ),
              ),
              if (background) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: _Badge(text: 'background', color: muted),
                ),
              ],
              if (preview != null && (!_expanded || prompt == null)) ...[
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: Text(
                    preview,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.bodySmall.copyWith(
                      color: muted.withValues(alpha: 0.8),
                    ),
                  ),
                ),
              ] else
                const Spacer(),
              if (running) ...[
                const SizedBox(width: 6),
                const ThinkingSpinner(
                  key: ValueKey('agent-card-running'),
                  size: 12,
                ),
              ],
              if (failed) ...[
                const SizedBox(width: 6),
                Text(
                  'error',
                  style: AppTypography.bodySmall.copyWith(color: destructive),
                ),
              ],
              const SizedBox(width: 4),
              Icon(
                _expanded ? Icons.remove : Icons.add,
                size: 12,
                color: muted,
              ),
            ],
          ),
        ),
      ),
    );
    if (!_expanded) return header;
    // Each nested card narrows the panel. Below a phone-width threshold a
    // level indents less, so every retained depth keeps room for its header.
    return LayoutBuilder(
      builder: (context, constraints) => _expandedCard(
        header,
        compact: constraints.maxWidth < _compactWidth,
        muted: muted,
        small: small,
        destructive: destructive,
        description: description,
        prompt: prompt,
        result: result,
        running: running,
        failed: failed,
      ),
    );
  }

  Widget _expandedCard(
    Widget header, {
    required bool compact,
    required Color muted,
    required TextStyle small,
    required Color destructive,
    required String? description,
    required String? prompt,
    required String? result,
    required bool running,
    required bool failed,
  }) {
    final colors = AppColors.of(context);
    final parts = [
      for (final raw in _data['subBlocks'] as List? ?? const [])
        if (raw is Map<String, dynamic>) ChatPart.fromJson(raw),
    ];
    final results = pairedToolResults(parts);
    final subBlocks = [
      for (final part in parts)
        if (part.kind != 'tool_result' || !results.containsKey(part.toolUseId))
          part,
    ];
    final omitted = switch (_data['omittedSubBlocks']) {
      final num n => n.toInt(),
      _ => 0,
    };
    final configuration = [
      if (_string('model') case final model?) 'Model: $model',
      if (_string('reasoningEffort') case final effort?)
        'Effort: ${effort[0].toUpperCase()}${effort.substring(1)}',
    ];
    final usage = _usageCells(_data['usage']);
    final divider = BorderSide(color: colors.border);
    Widget section(Widget child, {bool top = true}) => Container(
      width: double.infinity,
      padding: EdgeInsets.symmetric(horizontal: compact ? 6 : 10, vertical: 6),
      decoration: BoxDecoration(border: top ? Border(top: divider) : null),
      child: child,
    );
    Widget toggle(String text, VoidCallback onTap, Key key) => InkWell(
      key: key,
      onTap: onTap,
      child: section(
        Text(text, style: AppTypography.compactLabel.copyWith(color: muted)),
      ),
    );
    final sections = <Widget>[
      if (configuration.isNotEmpty)
        Wrap(
          spacing: 12,
          children: [for (final c in configuration) Text(c, style: small)],
        ),
      if (usage.isNotEmpty)
        Wrap(
          key: const ValueKey('agent-card-usage'),
          spacing: 12,
          children: [for (final cell in usage) Text(cell, style: small)],
        ),
      if (_data['subBlocksTruncated'] == true)
        Text(
          omitted == 0
              ? "Earlier items aren't available here"
              : omitted == 1
              ? "1 earlier item isn't available here"
              : "$omitted earlier items aren't available here",
          key: const ValueKey('agent-card-truncated'),
          style: small,
        ),
      if (subBlocks.isNotEmpty)
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final (i, sub) in subBlocks.indexed)
              _SubBlock(
                key: ValueKey('agent-sub-$i'),
                part: sub,
                result: results[sub.toolUseId],
                running: running,
              ),
          ],
        )
      else if (running && description != null)
        Text(description, style: small),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        header,
        Container(
          key: const ValueKey('agent-card-panel'),
          margin: EdgeInsets.only(left: compact ? 6 : 22, top: 2, bottom: 4),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadii.sm),
            border: Border.all(color: colors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final (i, child) in sections.indexed)
                section(child, top: i > 0),
              if (result != null) ...[
                toggle(
                  _showResult ? 'Hide result' : 'Show result',
                  () => setState(() => _showResult = !_showResult),
                  const ValueKey('agent-card-result-toggle'),
                ),
                if (_showResult)
                  section(
                    SelectableText(
                      result,
                      style: AppTypography.bodySmall.copyWith(
                        color: failed ? destructive : muted,
                      ),
                    ),
                  ),
              ],
              if (prompt != null) ...[
                toggle(
                  _showPrompt ? 'Hide prompt' : 'Show prompt',
                  () => setState(() => _showPrompt = !_showPrompt),
                  const ValueKey('agent-card-prompt-toggle'),
                ),
                if (_showPrompt) section(SelectableText(prompt, style: small)),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// The desktop card's usage cells: output, tool uses, duration, model.
List<String> _usageCells(Object? value) {
  if (value is! Map) return const [];
  num count(String key) => switch (value[key]) {
    final num n when n.isFinite => n,
    _ => 0,
  };
  final output = count('outputTokens');
  final tools = count('toolUses').toInt();
  final duration = count('durationMs');
  final model = value['model'];
  return [
    if (output > 0) '${formatCompact(output)} output',
    if (tools > 0) tools == 1 ? '1 tool use' : '$tools tool uses',
    if (duration > 0) formatDuration(duration),
    if (model is String && model.isNotEmpty) model,
  ];
}

class _SubBlock extends StatelessWidget {
  const _SubBlock({
    super.key,
    required this.part,
    required this.running,
    this.result,
  });

  final ChatPart part;
  final bool running;

  /// The paired result from a separate `tool_result` part, if any.
  final ToolCallResult? result;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return switch (part.kind) {
      'text' => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: MessageMarkdown(
          text: part.data?['text'] as String? ?? '',
          style: AppTypography.bodySmall.copyWith(color: colors.foreground),
          selectable: true,
        ),
      ),
      'thinking' => ThinkingRow(part: part),
      'tool_use' => ToolCallRow(
        part: part,
        result: result ?? embeddedToolResult(part),
        pending: running,
      ),
      // A result whose call is not in this card shows its output, as the
      // shared card's standalone result part does.
      'tool_result' when part.toolOutput != null => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: SelectableText(
          part.toolOutput!,
          maxLines: 6,
          style: AppTypography.bodySmall.copyWith(
            color: part.isToolError
                ? StatusColors.of(context).destructive
                : colors.foregroundSecondary,
          ),
        ),
      ),
      'agent' => AgentCard(part: part),
      _ => const SizedBox.shrink(),
    };
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: AppTypography.bodySmall.copyWith(color: color),
    ),
  );
}
