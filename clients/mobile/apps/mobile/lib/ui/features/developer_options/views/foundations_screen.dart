import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Live brand colors; changing the app appearance changes this reference too.
class ColorsScreen extends StatelessWidget {
  const ColorsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final primitives = Theme.of(context).brightness == Brightness.dark
        ? Brand.darkPrimitives
        : Brand.lightPrimitives;
    return DefaultTabController(
      length: 2,
      child: CanopyScaffold(
        appBar: CanopyAppBar(
          automaticallyImplyLeading: true,
          content: const Text('Colors'),
        ),
        body: Builder(
          builder: (context) => Padding(
            padding: CanopyScaffold.contentPaddingOf(context),
            child: Column(
              children: [
                const TabBar(
                  tabs: [
                    Tab(text: 'Semantic'),
                    Tab(text: 'Primitives'),
                  ],
                ),
                Expanded(
                  child: TabBarView(
                    children: [
                      _ColorList(colors: AppColors.of(context).values),
                      _ColorList(colors: primitives),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ColorList extends StatelessWidget {
  const _ColorList({required this.colors});

  final Map<String, Color> colors;

  @override
  Widget build(BuildContext context) {
    final entries = colors.entries.toList();
    return ListView.builder(
      padding: EdgeInsets.zero,
      itemCount: entries.length,
      itemBuilder: (context, index) {
        final entry = entries[index];
        final argb = entry.value.toARGB32();
        final rgb = (argb & 0xffffff)
            .toRadixString(16)
            .padLeft(6, '0')
            .toUpperCase();
        final opacity = ((argb >> 24) / 255 * 100).toStringAsFixed(1);
        return ListTile(
          leading: Container(
            key: ValueKey('swatch-${entry.key}'),
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: entry.value,
              borderRadius: BorderRadius.circular(AppRadii.md),
              border: Border.all(color: AppColors.of(context).border),
            ),
          ),
          title: Text(entry.key),
          subtitle: Text('#$rgb · $opacity% opacity'),
        );
      },
    );
  }
}

class RadiiScreen extends StatelessWidget {
  const RadiiScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Corner radii'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(16),
          children: [
            Text(
              'Shared with desktop. Values use logical pixels. '
              'Brand default: ${AppRadii.defaultRadius.toStringAsFixed(0)}.',
            ),
            const SizedBox(height: 16),
            for (final entry in AppRadii.values.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Row(
                  children: [
                    Container(
                      key: ValueKey(entry.key),
                      width: 88,
                      height: 64,
                      decoration: BoxDecoration(
                        color: colors['bg-accent-muted'],
                        border: Border.all(color: colors['line-accent']),
                        borderRadius: BorderRadius.circular(entry.value),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(entry.key),
                          Text(
                            entry.value == AppRadii.full
                                ? 'Pill / circle'
                                : '${entry.value.toStringAsFixed(0)} logical pixels',
                            style: TextStyle(color: colors.foregroundSecondary),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
