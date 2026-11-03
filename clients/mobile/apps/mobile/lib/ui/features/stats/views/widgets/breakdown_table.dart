import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';

/// One right-aligned numeric column in a [BreakdownTable]. [valueForRow] maps a
/// row index to its formatted cell text.
class BreakdownColumn {
  const BreakdownColumn({required this.header, required this.valueForRow});

  final String header;
  final String Function(int rowIndex) valueForRow;
}

/// Generic `[key | numeric columns...]` table. The first column is the
/// left-aligned [keyHeader]/[rowKeys]; every [columns] entry renders as a
/// right-aligned numeric column.
class BreakdownTable extends StatelessWidget {
  const BreakdownTable({
    super.key,
    required this.keyHeader,
    required this.rowKeys,
    required this.columns,
  });

  final String keyHeader;
  final List<String> rowKeys;
  final List<BreakdownColumn> columns;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final headerStyle = theme.textTheme.labelSmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
      fontWeight: AppTypography.emphasisWeight,
      fontVariations: AppTypography.emphasisVariations,
    );
    final cellStyle = theme.textTheme.bodySmall;

    TableRow buildRow(List<Widget> cells) => TableRow(children: cells);

    Widget keyCell(String text, TextStyle? style) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Text(
        text,
        style: style,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
    );

    Widget numCell(String text, TextStyle? style) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Text(text, style: style, textAlign: TextAlign.right),
    );

    return Table(
      columnWidths: {
        0: const FlexColumnWidth(2),
        for (var i = 0; i < columns.length; i++)
          i + 1: const FlexColumnWidth(1),
      },
      children: [
        buildRow([
          keyCell(keyHeader, headerStyle),
          for (final column in columns) numCell(column.header, headerStyle),
        ]),
        for (var r = 0; r < rowKeys.length; r++)
          buildRow([
            keyCell(rowKeys[r], cellStyle),
            for (final column in columns)
              numCell(column.valueForRow(r), cellStyle),
          ]),
      ],
    );
  }
}
