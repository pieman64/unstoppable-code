import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';

/// Consistent, scrollable layout for local design references. Inherits the
/// app's appearance and accessibility text scale without changing either.
class TypographyPreviewPage extends StatelessWidget {
  const TypographyPreviewPage({
    super.key,
    required this.title,
    required this.children,
  });
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(automaticallyImplyLeading: true, content: Text(title)),
    body: Builder(
      builder: (context) => ListView(
        key: const ValueKey('design-reference-list'),
        padding:
            CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(16),
        children: [
          Text(
            'Uses the current appearance and system text size.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 16),
          for (final child in children) ...[child, const SizedBox(height: 16)],
        ],
      ),
    ),
  );
}

class TypographyPreviewCard extends StatelessWidget {
  const TypographyPreviewCard({
    super.key,
    required this.title,
    required this.child,
    this.description,
  });
  final String title;
  final String? description;
  final Widget child;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          if (description case final text?) ...[
            const SizedBox(height: 4),
            Text(
              text,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 12),
          child,
        ],
      ),
    ),
  );
}
