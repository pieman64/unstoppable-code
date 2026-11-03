import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/developer_options/views/typography_preview_widgets.dart';

class FontsScreen extends StatefulWidget {
  const FontsScreen({super.key});

  @override
  State<FontsScreen> createState() => _FontsScreenState();
}

class _FontsScreenState extends State<FontsScreen> {
  static const _defaultSample = 'The quick brown fox\nAa Bb 0123456789';
  String _sample = '';

  @override
  Widget build(BuildContext context) => TypographyPreviewPage(
    title: 'Fonts',
    children: [
      TextField(
        key: const ValueKey('font-sample-input'),
        decoration: const InputDecoration(
          labelText: 'Sample text',
          hintText: 'Type to preview both fonts',
          helperText: 'Leave empty to use the example.',
        ),
        onChanged: (value) => setState(() => _sample = value),
      ),
      for (final (name, family, description) in [
        ('Inter', AppTypography.sansFamily, '4.001 · Interface text'),
        (
          'JetBrains Mono',
          AppTypography.monoFamily,
          '2.304 · Code and technical text',
        ),
      ])
        TypographyPreviewCard(
          title: name,
          description:
              '$description\nBundled for offline use · Normal and italic',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (label, style) in [
                ('Regular · 400', AppTypography.regular),
                ('Emphasis · 450', AppTypography.emphasis),
                (
                  'Italic · 400',
                  AppTypography.regular.copyWith(fontStyle: FontStyle.italic),
                ),
                (
                  'Italic emphasis · 450',
                  AppTypography.emphasis.copyWith(fontStyle: FontStyle.italic),
                ),
              ]) ...[
                Text(label, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 4),
                Text(
                  _sample.isEmpty ? _defaultSample : _sample,
                  key: ValueKey('$family-$label'),
                  style: style.copyWith(
                    fontFamily: family,
                    fontSize: 20,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 16),
              ],
            ],
          ),
        ),
      const Text(
        'Regular text uses weight 400. Emphasis uses the variable font’s 450 weight, including headings and bold markdown.',
      ),
    ],
  );
}
