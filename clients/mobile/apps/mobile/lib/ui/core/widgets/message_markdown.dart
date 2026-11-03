/// Lightweight markdown for chat transcript messages.
///
/// A deliberate, conservative subset of what the shared web transcript
/// renderer supports (`packages/ui-shared/src/components/Markdown.tsx`):
/// fenced code blocks, inline code, ATX headings, bullet/numbered lists,
/// blockquotes, GFM pipe tables, `**bold**`, `*italic*`, and `[text](href)`
/// links. Images use caller-supplied bytes and never read sources directly.
/// Raw HTML is never parsed, underscore emphasis is ignored (agent output is full of
/// `snake_case` identifiers), and the transcript link policy is a
/// deliberately NARROWED port of web's `isNavigableTranscriptHref`: only
/// fully-qualified http(s)/mailto targets are navigable (web also allows
/// irc/xmpp and fragments, which are useless on mobile) — filesystem paths
/// and other schemes render as inert styled text, never as tappable links.
library;

import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/widgets/message_markdown_image.dart';

export 'message_markdown_image.dart'
    show MessageImageResolver, MessageImageTap, MessageImageFailure;

/// One inline run with its resolved emphasis.
class MessageSpan {
  const MessageSpan(
    this.text, {
    this.bold = false,
    this.italic = false,
    this.code = false,
    this.linkHref,
  });

  final String text;
  final bool bold;
  final bool italic;
  final bool code;

  /// Raw link target for `[text](href)` spans; null for non-links.
  final String? linkHref;

  /// Transcript link policy: navigable only for fully-qualified safe
  /// schemes. Everything else stays inert.
  bool get linkNavigable {
    final href = linkHref;
    if (href == null) return false;
    final uri = Uri.tryParse(href.trim());
    if (uri == null) return false;
    return switch (uri.scheme.toLowerCase()) {
      'http' || 'https' => uri.host.isNotEmpty,
      'mailto' => uri.path.isNotEmpty,
      _ => false,
    };
  }
}

/// An image node, including when it is the only span in a paragraph.
final class MessageImage extends MessageSpan {
  const MessageImage(super.text, {required this.source, this.title});

  final String source;
  final String? title;
}

/// Block-level structure of a message.
sealed class MessageBlock {
  const MessageBlock();
}

final class MessageParagraph extends MessageBlock {
  const MessageParagraph(this.spans);
  final List<MessageSpan> spans;
}

final class MessageHeading extends MessageBlock {
  const MessageHeading(this.level, this.spans);
  final int level;
  final List<MessageSpan> spans;
}

final class MessageCodeBlock extends MessageBlock {
  const MessageCodeBlock(this.code, {this.language});
  final String code;
  final String? language;
}

final class MessageListItem extends MessageBlock {
  const MessageListItem(this.spans, {required this.marker});

  /// The rendered bullet/number prefix (`•` or `3.`).
  final String marker;
  final List<MessageSpan> spans;
}

final class MessageQuote extends MessageBlock {
  const MessageQuote(this.spans);
  final List<MessageSpan> spans;
}

/// A GFM pipe table. Every row has exactly `header.length` cells; short
/// rows are padded with empty cells and long rows are truncated, matching
/// the GFM spec (and the desktop renderer).
final class MessageTable extends MessageBlock {
  const MessageTable({
    required this.header,
    required this.alignments,
    required this.rows,
  });

  final List<List<MessageSpan>> header;

  /// Per-column alignment from the delimiter row (`:--`, `:-:`, `--:`).
  final List<TextAlign> alignments;
  final List<List<List<MessageSpan>>> rows;
}

final RegExp _headingPattern = RegExp(r'^(#{1,6})\s+(.*)$');
final RegExp _bulletPattern = RegExp(r'^\s{0,3}[-*+]\s+(.*)$');
final RegExp _numberedPattern = RegExp(r'^\s{0,3}(\d{1,3})[.)]\s+(.*)$');
final RegExp _quotePattern = RegExp(r'^>\s?(.*)$');
final RegExp _fencePattern = RegExp(r'^\s{0,3}(`{3,})\s*([A-Za-z0-9_+-]*)\s*$');
final RegExp _tableDelimiterCell = RegExp(r'^:?-+:?$');
const int _maxTableColumns = 32;
const int _maxTableCells = 512;

/// Splits one pipe-table row into trimmed cells, dropping the optional
/// leading/trailing bars; `\|` yields a literal pipe. Returns null for a
/// line with no pipe at all (which is what ends a table). Single linear pass,
/// so a pathological line of pipes costs its own length and nothing more.
List<String>? _splitTableCells(String line) {
  var text = line.trim();
  if (!text.contains('|')) return null;
  if (text.startsWith('|')) text = text.substring(1);
  if (text.endsWith('|') && !text.endsWith(r'\|')) {
    text = text.substring(0, text.length - 1);
  }
  final cells = <String>[];
  final buffer = StringBuffer();
  for (var i = 0; i < text.length; i++) {
    final char = text[i];
    if (char == r'\' && i + 1 < text.length && text[i + 1] == '|') {
      buffer.write('|');
      i++;
      continue;
    }
    if (char == '|') {
      cells.add(buffer.toString().trim());
      buffer.clear();
      continue;
    }
    buffer.write(char);
  }
  cells.add(buffer.toString().trim());
  return cells;
}

TextAlign _tableAlignment(String delimiter) {
  final leading = delimiter.startsWith(':');
  final trailing = delimiter.endsWith(':');
  if (leading && trailing) return TextAlign.center;
  if (trailing) return TextAlign.right;
  return TextAlign.left;
}

// Inline scans are length-bounded so a pathological single line (e.g. 6,000
// unmatched `[` at the wire cap) cannot backtrack quadratically; labels or
// snippets longer than the caps simply render as plain text.
final RegExp _codeSpan = RegExp(r'`([^`\n]{1,400})`');
final RegExp _linkOrImageSpan = RegExp(
  // `[` is excluded from the label class so a run of unmatched brackets
  // fails at length 0 per position instead of backtracking through the cap.
  r'(!?)\[([^\[\]\n]{0,400})\]\(([^)\s]{1,1000})(?:[ \t]+"([^"\n]{0,400})")?\)',
);
final RegExp _boldSpan = RegExp(r'\*\*([^*\n]{1,400})\*\*');
final RegExp _italicSpan = RegExp(r'\*([^*\s][^*\n]{0,400}?)\*');

/// Parses [text] into blocks. Never throws; unrecognized structure falls
/// back to plain paragraphs, and an unclosed fence (a streaming message cut
/// mid-block) treats the remainder as code.
List<MessageBlock> parseMessageMarkdown(String text) {
  final blocks = <MessageBlock>[];
  final paragraph = <String>[];

  void flushParagraph() {
    if (paragraph.isEmpty) return;
    blocks.add(MessageParagraph(parseMessageSpans(paragraph.join('\n'))));
    paragraph.clear();
  }

  final lines = text.split('\n');
  var index = 0;
  while (index < lines.length) {
    final line = lines[index];
    final fence = _fencePattern.firstMatch(line);
    if (fence != null) {
      flushParagraph();
      final fenceLength = fence.group(1)!.length;
      final language = fence.group(2);
      final closingFence = RegExp(
        r'^\s{0,3}`{'
        '$fenceLength'
        r',}\s*$',
      );
      final code = <String>[];
      index++;
      while (index < lines.length && !closingFence.hasMatch(lines[index])) {
        code.add(lines[index]);
        index++;
      }
      index++; // Skip the closing fence (or run past the end when unclosed).
      blocks.add(
        MessageCodeBlock(
          code.join('\n'),
          language: language != null && language.isNotEmpty ? language : null,
        ),
      );
      continue;
    }
    if (line.trim().isEmpty) {
      flushParagraph();
      index++;
      continue;
    }
    if (_headingPattern.firstMatch(line) case final match?) {
      flushParagraph();
      blocks.add(
        MessageHeading(
          match.group(1)?.length ?? 1,
          parseMessageSpans(match.group(2) ?? ''),
        ),
      );
      index++;
      continue;
    }
    if (_quotePattern.firstMatch(line) case final match?) {
      flushParagraph();
      blocks.add(MessageQuote(parseMessageSpans(match.group(1) ?? '')));
      index++;
      continue;
    }
    if (_bulletPattern.firstMatch(line) case final match?) {
      flushParagraph();
      blocks.add(
        MessageListItem(parseMessageSpans(match.group(1) ?? ''), marker: '•'),
      );
      index++;
      continue;
    }
    if (_numberedPattern.firstMatch(line) case final match?) {
      flushParagraph();
      blocks.add(
        MessageListItem(
          parseMessageSpans(match.group(2) ?? ''),
          marker: '${match.group(1)}.',
        ),
      );
      index++;
      continue;
    }
    // A table needs a header row AND a delimiter row with the same cell
    // count; a lone pipe line (prose with `|`, or a streaming message cut
    // after the header) stays a paragraph rather than becoming a half table.
    final headerCells = _splitTableCells(line);
    if (headerCells != null && index + 1 < lines.length) {
      final delimiter = _splitTableCells(lines[index + 1]);
      if (delimiter != null &&
          delimiter.length == headerCells.length &&
          delimiter.every(_tableDelimiterCell.hasMatch)) {
        if (headerCells.length > _maxTableColumns) {
          paragraph.add(line);
          index++;
          continue;
        }
        flushParagraph();
        final width = headerCells.length;
        List<List<MessageSpan>> normalize(List<String> cells) => [
          for (var i = 0; i < width; i++)
            i < cells.length
                ? parseMessageSpans(cells[i])
                : const <MessageSpan>[],
        ];
        final rows = <List<List<MessageSpan>>>[];
        var cellCount = width;
        index += 2;
        while (index < lines.length) {
          final cells = _splitTableCells(lines[index]);
          if (cells == null) break;
          if (cellCount + width > _maxTableCells) break;
          rows.add(normalize(cells));
          cellCount += width;
          index++;
        }
        blocks.add(
          MessageTable(
            header: normalize(headerCells),
            alignments: delimiter.map(_tableAlignment).toList(),
            rows: rows,
          ),
        );
        continue;
      }
    }
    paragraph.add(line);
    index++;
  }
  flushParagraph();
  return blocks;
}

/// Parses inline emphasis inside one block. Code wins over images and links,
/// then bold, then italic. Nesting renders flat for the transcript subset.
List<MessageSpan> parseMessageSpans(String text) {
  return _splitBy(
    _codeSpan,
    text,
    (match) => [MessageSpan(match.group(1) ?? '', code: true)],
    (plain) {
      return _splitBy(
        _linkOrImageSpan,
        plain,
        (match) => [
          if (match.group(1) == '!')
            MessageImage(
              match.group(2) ?? '',
              source: match.group(3)!,
              title: match.group(4),
            )
          else if (match.group(2)!.isNotEmpty)
            MessageSpan(match.group(2)!, linkHref: match.group(3))
          else
            MessageSpan(match.group(0)!),
        ],
        (rest) {
          return _splitBy(
            _boldSpan,
            rest,
            (match) => [MessageSpan(match.group(1) ?? '', bold: true)],
            (rest2) {
              return _splitBy(
                _italicSpan,
                rest2,
                (match) => [MessageSpan(match.group(1) ?? '', italic: true)],
                (leaf) => leaf.isEmpty ? const [] : [MessageSpan(leaf)],
              );
            },
          );
        },
      );
    },
  );
}

List<MessageSpan> _splitBy(
  RegExp pattern,
  String text,
  List<MessageSpan> Function(RegExpMatch match) onMatch,
  List<MessageSpan> Function(String plain) onPlain,
) {
  final spans = <MessageSpan>[];
  var cursor = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.addAll(onPlain(text.substring(cursor, match.start)));
    }
    spans.addAll(onMatch(match));
    cursor = match.end;
  }
  if (cursor < text.length) spans.addAll(onPlain(text.substring(cursor)));
  return spans;
}

/// True when [blocks] carry no markdown structure at all — the renderer then
/// emits one plain [Text] identical to the raw message, keeping the common
/// case cheap (and widget-test `find.text` compatible).
bool messageIsPlainText(List<MessageBlock> blocks) =>
    blocks.length == 1 &&
    blocks.single is MessageParagraph &&
    (blocks.single as MessageParagraph).spans.length == 1 &&
    (blocks.single as MessageParagraph).spans.single is! MessageImage &&
    !(blocks.single as MessageParagraph).spans.single.bold &&
    !(blocks.single as MessageParagraph).spans.single.italic &&
    !(blocks.single as MessageParagraph).spans.single.code &&
    (blocks.single as MessageParagraph).spans.single.linkHref == null;

/// Renders a chat message body with the transcript markdown subset.
class MessageMarkdown extends StatefulWidget {
  const MessageMarkdown({
    super.key,
    required this.text,
    this.style,
    this.selectable = false,
    this.imageResolver,
    this.onImageTap,
  });

  final String text;

  /// Base style for prose; emphasis and code derive from it.
  final TextStyle? style;

  /// Whether rendered message text can be selected and copied.
  final bool selectable;

  /// Absent in chat: images render only their alt text, with no I/O.
  final MessageImageResolver? imageResolver;
  final MessageImageTap? onImageTap;

  @override
  State<MessageMarkdown> createState() => _MessageMarkdownState();
}

class _MessageMarkdownState extends State<MessageMarkdown> {
  /// Parse result and tap recognizers are memoized per [MessageMarkdown.text]
  /// and rebuilt ONLY when it changes:
  ///
  ///  * the chat screen rebuilds on every streaming delta, so re-parsing per
  ///    frame would make one pathological message a per-frame cost;
  ///  * a recognizer disposed mid-gesture (pointer-down before a rebuild,
  ///    pointer-up after) silently swallows the tap — recognizers must keep
  ///    their identity across rebuilds and are disposed only in [dispose]
  ///    or when the text they belong to is replaced.
  late List<MessageBlock> _blocks;

  /// Keyed by span IDENTITY (spans are created once per parse and reused
  /// across builds), so the allocation and consumption sites cannot drift
  /// the way a positional cursor could.
  final Map<MessageSpan, TapGestureRecognizer> _recognizers = Map.identity();

  @override
  void initState() {
    super.initState();
    _reparse();
  }

  @override
  void didUpdateWidget(MessageMarkdown oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) _reparse();
  }

  void _reparse() {
    _blocks = parseMessageMarkdown(widget.text);
    for (final recognizer in _recognizers.values) {
      recognizer.dispose();
    }
    _recognizers.clear();
    for (final block in _blocks) {
      for (final span in _spansOf(block)) {
        if (span.linkHref case final href? when span.linkNavigable) {
          _recognizers[span] = TapGestureRecognizer()
            ..onTap = () => _openLink(href);
        }
      }
    }
  }

  static List<MessageSpan> _spansOf(MessageBlock block) => switch (block) {
    MessageParagraph(:final spans) => spans,
    MessageHeading(:final spans) => spans,
    MessageListItem(:final spans) => spans,
    MessageQuote(:final spans) => spans,
    MessageTable(:final header, :final rows) => [
      for (final cell in header) ...cell,
      for (final row in rows)
        for (final cell in row) ...cell,
    ],
    MessageCodeBlock() => const [],
  };

  @override
  void dispose() {
    for (final recognizer in _recognizers.values) {
      recognizer.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final base = widget.style ?? theme.textTheme.bodyMedium;
    if (widget.text.isEmpty || messageIsPlainText(_blocks)) {
      // Fast path: the message had no markdown — render it verbatim.
      if (widget.selectable) {
        return SelectableText(
          widget.text,
          style: base,
          scrollPhysics: const NeverScrollableScrollPhysics(),
        );
      }
      return Text(widget.text, style: base);
    }

    final children = <Widget>[];
    for (var i = 0; i < _blocks.length; i++) {
      if (i > 0) children.add(const SizedBox(height: 6));
      children.add(_blockWidget(theme, colors, base, _blocks[i]));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: children,
    );
  }

  Widget _blockWidget(
    ThemeData theme,
    AppColors colors,
    TextStyle? base,
    MessageBlock block,
  ) {
    switch (block) {
      case MessageParagraph(:final spans):
        return _richText(theme, colors, base, spans);
      case MessageHeading(:final level, :final spans):
        final scale = switch (level) {
          1 => 1.25,
          2 => 1.15,
          _ => 1.05,
        };
        return _richText(
          theme,
          colors,
          base?.copyWith(
            fontSize: (base.fontSize ?? 14) * scale,
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
          spans,
        );
      case MessageCodeBlock(:final code):
        final style = base?.copyWith(
          fontFamily: AppTypography.monoFamily,
          fontSize: AppTypography.code.fontSize,
          height: AppTypography.code.height,
          fontWeight: AppTypography.regularWeight,
          fontVariations: AppTypography.regularVariations,
          color: colors.foreground.withValues(alpha: 0.8),
        );
        return Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          // Desktop `prose-pre`: fg-primary at 6% behind fg-primary at 80%.
          decoration: BoxDecoration(
            color: colors.foreground.withValues(alpha: 0.06),
            borderRadius: BorderRadius.circular(6),
          ),
          child: widget.selectable
              ? SelectableText(
                  code,
                  style: style,
                  scrollPhysics: const NeverScrollableScrollPhysics(),
                )
              : Text(code, style: style),
        );
      case MessageListItem(:final marker, :final spans):
        return Padding(
          padding: const EdgeInsets.only(left: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 20, child: Text('$marker ', style: base)),
              Expanded(child: _richText(theme, colors, base, spans)),
            ],
          ),
        );
      case MessageQuote(:final spans):
        return Container(
          padding: const EdgeInsets.only(left: 10),
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(
                color: theme.colorScheme.outlineVariant,
                width: 3,
              ),
            ),
          ),
          child: _richText(
            theme,
            colors,
            base?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            spans,
          ),
        );
      case MessageTable():
        return _table(theme, colors, base, block);
    }
  }

  /// Desktop `prose` table look: emphasised header, one hairline under the
  /// header and between body rows, no vertical rules, no fill. Layout ports
  /// web's `prose-table:block w-full overflow-x-auto` decision for narrow
  /// columns — cells wrap first and the table fills the column; only when
  /// even the wrapped minimum is wider than the column does it scroll
  /// horizontally in place instead of being clipped.
  Widget _table(
    ThemeData theme,
    AppColors colors,
    TextStyle? base,
    MessageTable table,
  ) {
    final headerStyle = base?.copyWith(
      fontWeight: AppTypography.emphasisWeight,
      fontVariations: AppTypography.emphasisVariations,
    );
    Widget cell(List<MessageSpan> spans, TextStyle? style, int column) =>
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: _richText(
            theme,
            colors,
            style,
            spans,
            textAlign: table.alignments[column],
            // On Android/Fuchsia, selectable text eagerly wins horizontal
            // drags and prevents the enclosing table scroller from panning.
            selectable: false,
            imageWrapper: (child) =>
                MessageMarkdownImageThumbnail(child: child),
          ),
        );
    final cells = [
      for (var i = 0; i < table.header.length; i++)
        cell(table.header[i], headerStyle, i),
      for (final row in table.rows)
        for (var i = 0; i < row.length; i++) cell(row[i], base, i),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final grid = MessageTableGrid(
          columns: table.header.length,
          availableWidth: constraints.maxWidth,
          dividerColor: colors.border,
          children: cells,
        );
        if (!constraints.maxWidth.isFinite) return grid;
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: grid,
        );
      },
    );
  }

  Widget _richText(
    ThemeData theme,
    AppColors colors,
    TextStyle? base,
    List<MessageSpan> spans, {
    TextAlign? textAlign,
    bool? selectable,
    Widget Function(Widget)? imageWrapper,
  }) {
    if (spans.length == 1 &&
        spans.single is MessageImage &&
        widget.imageResolver != null) {
      return _imageWidget(spans.single as MessageImage, base, imageWrapper);
    }
    final textSpan = TextSpan(
      children: [
        for (final span in spans)
          _inline(theme, colors, base, span, imageWrapper: imageWrapper),
      ],
    );
    if (widget.imageResolver != null &&
        spans.any((span) => span is MessageImage)) {
      final text = Text.rich(textSpan, style: base, textAlign: textAlign);
      return (selectable ?? widget.selectable)
          ? SelectionArea(child: text)
          : text;
    }
    if (selectable ?? widget.selectable) {
      return SelectableText.rich(
        textSpan,
        style: base,
        textAlign: textAlign,
        scrollPhysics: const NeverScrollableScrollPhysics(),
      );
    }
    return Text.rich(textSpan, style: base, textAlign: textAlign);
  }

  InlineSpan _inline(
    ThemeData theme,
    AppColors colors,
    TextStyle? base,
    MessageSpan span, {
    Widget Function(Widget)? imageWrapper,
  }) {
    if (span is MessageImage) {
      if (widget.imageResolver == null) {
        return TextSpan(text: span.text.isEmpty ? 'Image' : span.text);
      }
      return WidgetSpan(child: _imageWidget(span, base, imageWrapper));
    }
    if (span.code) {
      // Desktop `prose-code:fg-accent`: accent mono text, no tinted box.
      return TextSpan(
        text: span.text,
        style: base?.copyWith(
          fontFamily: AppTypography.monoFamily,
          fontSize: (base.fontSize ?? 14) - 1,
          color: colors['fg-accent'],
        ),
      );
    }
    if (span.linkHref != null) {
      final recognizer = _recognizers[span];
      if (recognizer != null) {
        return TextSpan(
          text: span.text,
          recognizer: recognizer,
          // Desktop `prose-a:fg-accent`.
          style: base?.copyWith(
            color: colors['fg-accent'],
            decoration: TextDecoration.underline,
            decorationColor: colors['fg-accent'],
          ),
        );
      }
      // Non-navigable target (filesystem path, unknown scheme): inert,
      // subtly underlined so the author's link intent stays visible.
      return TextSpan(
        text: span.text,
        style: base?.copyWith(
          decoration: TextDecoration.underline,
          decorationStyle: TextDecorationStyle.dotted,
        ),
      );
    }
    return TextSpan(
      text: span.text,
      style: base?.copyWith(
        fontWeight: span.bold ? AppTypography.emphasisWeight : null,
        fontVariations: span.bold ? AppTypography.emphasisVariations : null,
        fontStyle: span.italic ? FontStyle.italic : null,
      ),
    );
  }

  Widget _imageWidget(
    MessageImage image,
    TextStyle? style,
    Widget Function(Widget)? imageWrapper,
  ) {
    final child = MessageMarkdownImage(
      source: image.source,
      alt: image.text,
      resolver: widget.imageResolver!,
      onTap: widget.onImageTap,
      style: style,
    );
    return imageWrapper?.call(child) ?? child;
  }

  void _openLink(String href) {
    // Fire-and-forget; a failed launch (no handler installed) is a no-op.
    openExternalUrl(href).ignore();
  }
}

/// Lays out table cells (row-major, [columns] per row) with the CSS
/// automatic table algorithm, which is what gives the desktop transcript its
/// look: every column gets at least its longest unbreakable word, columns
/// share the remaining width in proportion to how much their content wants,
/// and a table that fits unwrapped fills the column like `w-full`. Only when
/// even the fully wrapped minimum is wider than [availableWidth] does the grid
/// grow past it, so the enclosing horizontal scroll view can pan it; cells
/// then keep their natural width (capped at [availableWidth]) rather than
/// wrapping inside a table that scrolls anyway.
///
/// Flutter's own [Table] cannot express this: its shrink pass takes equal
/// pixel amounts from flexible columns (re-applying the remaining deficit in
/// rounds), which pins a short column at one word per line while a long
/// column keeps slack.
class MessageTableGrid extends MultiChildRenderObjectWidget {
  const MessageTableGrid({
    super.key,
    required this.columns,
    required this.availableWidth,
    required this.dividerColor,
    required super.children,
  });

  final int columns;

  /// Width of the enclosing column, or infinity when it is unbounded.
  final double availableWidth;

  /// Hairline drawn under every row except the last.
  final Color dividerColor;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderMessageTableGrid(
        columns: columns,
        availableWidth: availableWidth,
        dividerColor: dividerColor,
      );

  @override
  void updateRenderObject(
    BuildContext context,
    RenderMessageTableGrid renderObject,
  ) {
    renderObject
      ..columns = columns
      ..availableWidth = availableWidth
      ..dividerColor = dividerColor;
  }
}

class _TableCellParentData extends ContainerBoxParentData<RenderBox> {}

/// Render object behind [MessageTableGrid]; public only so the widget's
/// `updateRenderObject` signature can name it.
class RenderMessageTableGrid extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _TableCellParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _TableCellParentData> {
  RenderMessageTableGrid({
    required int columns,
    required double availableWidth,
    required Color dividerColor,
  }) : this._(columns, availableWidth, dividerColor);

  RenderMessageTableGrid._(
    this._columns,
    this._availableWidth,
    this._dividerColor,
  );

  int _columns;
  set columns(int value) {
    if (value == _columns) return;
    _columns = value;
    markNeedsLayout();
  }

  double _availableWidth;
  set availableWidth(double value) {
    if (value == _availableWidth) return;
    _availableWidth = value;
    markNeedsLayout();
  }

  Color _dividerColor;
  set dividerColor(Color value) {
    if (value == _dividerColor) return;
    _dividerColor = value;
    markNeedsPaint();
  }

  /// Bottom edge of each row after layout, for the divider hairlines.
  List<double> _rowBottoms = const [];

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _TableCellParentData) {
      child.parentData = _TableCellParentData();
    }
  }

  /// Per-column minimum (longest unbreakable word) and maximum (unwrapped)
  /// content widths.
  (List<double>, List<double>) _measureColumns(List<RenderBox> cells) {
    final minWidths = List<double>.filled(_columns, 0);
    final maxWidths = List<double>.filled(_columns, 0);
    for (var i = 0; i < cells.length; i++) {
      final column = i % _columns;
      minWidths[column] = math.max(
        minWidths[column],
        cells[i].getMinIntrinsicWidth(double.infinity),
      );
      maxWidths[column] = math.max(
        maxWidths[column],
        cells[i].getMaxIntrinsicWidth(double.infinity),
      );
    }
    return (minWidths, maxWidths);
  }

  static double _sum(List<double> values) =>
      values.fold(0.0, (total, value) => total + value);

  List<double> _columnWidths(List<RenderBox> cells) {
    final (minWidths, maxWidths) = _measureColumns(cells);
    final minTotal = _sum(minWidths);
    final maxTotal = _sum(maxWidths);
    final target = _availableWidth.isFinite ? _availableWidth : maxTotal;
    if (maxTotal <= target) {
      // Fits unwrapped: fill the column, sharing the slack by content.
      final extra = target - maxTotal;
      return [
        for (var c = 0; c < _columns; c++)
          maxWidths[c] +
              (maxTotal > 0
                  ? extra * maxWidths[c] / maxTotal
                  : extra / _columns),
      ];
    }
    if (minTotal >= target) {
      // Cannot fit even fully wrapped, so it scrolls. Wrapping "0.4 ms"
      // into two lines would help nothing then, so cells keep their natural
      // width — capped at the column width so one prose cell cannot become
      // a single endless line.
      return [
        for (var c = 0; c < _columns; c++)
          math.max(minWidths[c], math.min(maxWidths[c], target)),
      ];
    }
    final ratio = (target - minTotal) / (maxTotal - minTotal);
    return [
      for (var c = 0; c < _columns; c++)
        minWidths[c] + (maxWidths[c] - minWidths[c]) * ratio,
    ];
  }

  @override
  double computeMinIntrinsicWidth(double height) =>
      _sum(_measureColumns(getChildrenAsList()).$1);

  @override
  double computeMaxIntrinsicWidth(double height) =>
      _sum(_measureColumns(getChildrenAsList()).$2);

  @override
  double computeMinIntrinsicHeight(double width) =>
      computeMaxIntrinsicHeight(width);

  @override
  double computeMaxIntrinsicHeight(double width) {
    final cells = getChildrenAsList();
    final widths = _columnWidths(cells);
    var height = 0.0;
    for (var start = 0; start < cells.length; start += _columns) {
      var rowHeight = 0.0;
      for (var c = 0; c < _columns && start + c < cells.length; c++) {
        rowHeight = math.max(
          rowHeight,
          cells[start + c].getMaxIntrinsicHeight(widths[c]),
        );
      }
      height += rowHeight;
    }
    return height;
  }

  @override
  Size computeDryLayout(covariant BoxConstraints constraints) {
    final cells = getChildrenAsList();
    final widths = _columnWidths(cells);
    var height = 0.0;
    for (var start = 0; start < cells.length; start += _columns) {
      var rowHeight = 0.0;
      for (var c = 0; c < _columns && start + c < cells.length; c++) {
        rowHeight = math.max(
          rowHeight,
          cells[start + c]
              .getDryLayout(BoxConstraints.tightFor(width: widths[c]))
              .height,
        );
      }
      height += rowHeight;
    }
    return constraints.constrain(Size(_sum(widths), height));
  }

  @override
  void performLayout() {
    final cells = getChildrenAsList();
    final widths = _columnWidths(cells);
    final rowBottoms = <double>[];
    var top = 0.0;
    for (var start = 0; start < cells.length; start += _columns) {
      var rowHeight = 0.0;
      var left = 0.0;
      for (var c = 0; c < _columns && start + c < cells.length; c++) {
        final cell = cells[start + c];
        cell.layout(
          BoxConstraints.tightFor(width: widths[c]),
          parentUsesSize: true,
        );
        (cell.parentData as _TableCellParentData).offset = Offset(left, top);
        rowHeight = math.max(rowHeight, cell.size.height);
        left += widths[c];
      }
      top += rowHeight;
      rowBottoms.add(top);
    }
    _rowBottoms = rowBottoms;
    size = constraints.constrain(Size(_sum(widths), top));
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);

  @override
  void paint(PaintingContext context, Offset offset) {
    defaultPaint(context, offset);
    if (_rowBottoms.length < 2) return;
    final paint = Paint()
      ..color = _dividerColor
      ..strokeWidth = 1;
    for (final bottom in _rowBottoms.take(_rowBottoms.length - 1)) {
      final y = offset.dy + bottom - 0.5;
      context.canvas.drawLine(
        Offset(offset.dx, y),
        Offset(offset.dx + size.width, y),
        paint,
      );
    }
  }
}
