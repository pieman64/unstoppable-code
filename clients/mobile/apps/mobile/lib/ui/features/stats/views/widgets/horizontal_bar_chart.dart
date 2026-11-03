import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/stats/views/widgets/stats_palette.dart';

/// One category row for a [HorizontalBarChart].
class HorizontalBarDatum {
  const HorizontalBarDatum({required this.label, required this.value});

  final String label;
  final double value;
}

/// Horizontal bar chart for a flat category breakdown (e.g. tool categories).
/// Height scales with the row count. Renders a value label to the right of
/// each labeled bar.
class HorizontalBarChart extends StatelessWidget {
  const HorizontalBarChart({
    super.key,
    required this.data,
    required this.valueFormatter,
  });

  final List<HorizontalBarDatum> data;
  final String Function(num) valueFormatter;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final maxValue = data.fold<double>(
      0,
      (max, datum) => datum.value > max ? datum.value : max,
    );
    final safeMax = maxValue <= 0 ? 1.0 : maxValue;
    final labelStyle = theme.textTheme.labelMedium;
    final valueStyle = theme.textTheme.labelMedium?.copyWith(
      fontWeight: AppTypography.emphasisWeight,
      fontVariations: AppTypography.emphasisVariations,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < data.length; i++)
          Builder(
            builder: (context) {
              final widthFactor = (data[i].value / safeMax)
                  .clamp(0.0, 1.0)
                  .toDouble();
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    SizedBox(
                      width: 96,
                      child: Text(
                        data[i].label,
                        style: labelStyle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(3),
                        child: SizedBox(
                          height: 10,
                          child: Stack(
                            fit: StackFit.expand,
                            children: [
                              ColoredBox(
                                color:
                                    theme.colorScheme.surfaceContainerHighest,
                              ),
                              FractionallySizedBox(
                                alignment: Alignment.centerLeft,
                                widthFactor: widthFactor,
                                child: ColoredBox(
                                  color: statsSeriesColor(i, theme.brightness),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(valueFormatter(data[i].value), style: valueStyle),
                  ],
                ),
              );
            },
          ),
      ],
    );
  }
}
