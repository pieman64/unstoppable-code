import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

/// Interactive reference for the shared icon-button sizes and states.
class IconButtonsScreen extends StatefulWidget {
  const IconButtonsScreen({super.key});

  @override
  State<IconButtonsScreen> createState() => _IconButtonsScreenState();
}

class _IconButtonsScreenState extends State<IconButtonsScreen> {
  int _presses = 0;

  @override
  Widget build(BuildContext context) {
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Icon buttons'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(16),
          children: [
            const Text(
              'Transparent at rest. Tap to see the rounded ripple. '
              'Both sizes have a 48px touch target.',
            ),
            const SizedBox(height: 16),
            for (final size in CanopyIconButtonSize.values) ...[
              Text(size == CanopyIconButtonSize.small ? 'Small' : 'Medium'),
              Row(
                children: [
                  CanopyIconButton(
                    key: ValueKey('icon-button-${size.name}'),
                    glyph: CanopyGlyph.plusSmall,
                    tooltip: 'Add (${size.name})',
                    size: size,
                    onPressed: () => setState(() => _presses++),
                  ),
                  CanopyIconButton(
                    glyph: CanopyGlyph.settingsGear2,
                    tooltip: 'Settings (${size.name})',
                    size: size,
                    onPressed: () => setState(() => _presses++),
                  ),
                  CanopyIconButton(
                    glyph: CanopyGlyph.trashCan,
                    tooltip: 'Delete unavailable (${size.name})',
                    size: size,
                    onPressed: null,
                  ),
                  const Text('Disabled'),
                ],
              ),
              const SizedBox(height: 16),
            ],
            Text('Button presses: $_presses'),
          ],
        ),
      ),
    );
  }
}
