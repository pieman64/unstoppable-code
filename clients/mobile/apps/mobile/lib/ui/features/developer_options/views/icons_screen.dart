import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_icon_gallery.dart';

/// Gallery of the icons available from the mobile Canopy design system.
class IconsScreen extends StatelessWidget {
  const IconsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Icons'),
      ),
      body: Builder(
        builder: (context) => CanopyIconGallery(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(16),
        ),
      ),
    );
  }
}
