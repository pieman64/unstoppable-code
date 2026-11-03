import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/developer_options/views/typography_preview_widgets.dart';

class TypographyScreen extends StatelessWidget {
  const TypographyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final styles = {
      'heading': AppTypography.heading,
      'title': AppTypography.title,
      'section label': AppTypography.sectionLabel,
      'compact label': AppTypography.compactLabel,
      'large body': AppTypography.bodyLarge,
      'body': AppTypography.body,
      'small body': AppTypography.bodySmall,
      'code': AppTypography.code,
    };
    return TypographyPreviewPage(
      title: 'Typography',
      children: [
        Text('Product styles', style: text.headlineSmall),
        const Text(
          'Sizes and line heights are in logical pixels before system scaling.',
        ),
        for (final entry in styles.entries) _specimen(entry.key, entry.value),
        TypographyPreviewCard(
          title: 'Interface examples',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const TextField(
                decoration: InputDecoration(
                  labelText: 'Message',
                  hintText: 'Describe your task',
                ),
              ),
              const SizedBox(height: 12),
              Tooltip(
                message: 'Regular weight tooltip',
                child: FilledButton(
                  onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Preview action')),
                  ),
                  child: const Text('Preview action'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _specimen(String name, TextStyle style) {
    final size = style.fontSize!;
    final line = size * (style.height ?? 1);
    final weight =
        style.fontVariations?.firstWhere((v) => v.axis == 'wght').value ?? 400;
    return TypographyPreviewCard(
      key: ValueKey('text-style-$name'),
      title: name,
      description:
          '${size.toStringAsFixed(0)} / ${line.toStringAsFixed(0)} · Weight ${weight.toInt()}',
      child: Text('Design\nAa 0123', style: style),
    );
  }
}
