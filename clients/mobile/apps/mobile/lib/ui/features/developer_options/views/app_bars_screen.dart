import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

/// Scrollable reference for floating app chrome and its three content slots.
class AppBarsScreen extends StatelessWidget {
  const AppBarsScreen({super.key});

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      leading: CanopyIconButton(
        glyph: CanopyGlyph.arrowLeft,
        tooltip: 'Back',
        onPressed: () => Navigator.of(context).pop(),
      ),
      content: const Text('App bars'),
      trailing: MenuAnchor(
        builder: (context, controller, child) => CanopyIconButton(
          glyph: CanopyGlyph.dotGrid1x3Horizontal,
          tooltip: 'Preview options',
          onPressed: () =>
              controller.isOpen ? controller.close() : controller.open(),
        ),
        menuChildren: [
          MenuItemButton(onPressed: () {}, child: const Text('Example action')),
        ],
      ),
    ),
    body: Builder(
      builder: (context) => ListView(
        key: const ValueKey('app-bar-preview-list'),
        padding:
            CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(16),
        children: [
          const Text('Centered content, leading and trailing actions'),
          const SizedBox(height: 8),
          const Text(
            'Scroll to see content pass beneath the fading background and blur. '
            'The first and last items remain clear of system controls.',
          ),
          const SizedBox(height: 16),
          for (var i = 1; i <= 24; i++)
            Card(
              child: ListTile(
                title: Text('Preview row $i'),
                subtitle: const Text('Edge-to-edge scrolling'),
              ),
            ),
        ],
      ),
    ),
  );
}
