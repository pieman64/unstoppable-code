import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_mini_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

class MiniButtonsScreen extends StatefulWidget {
  const MiniButtonsScreen({super.key});

  @override
  State<MiniButtonsScreen> createState() => _MiniButtonsScreenState();
}

class _MiniButtonsScreenState extends State<MiniButtonsScreen> {
  int _presses = 0;

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: const Text('Mini buttons'),
    ),
    body: Builder(
      builder: (context) => ListView(
        padding:
            CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(16),
        children: [
          const Text('Small icon-and-text actions with 48px touch targets.'),
          const SizedBox(height: 16),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: CanopyMiniButton(
              key: const ValueKey('mini-button-enabled'),
              glyph: CanopyGlyph.play,
              label: 'Run',
              semanticsLabel: 'Run a pipeline',
              onPressed: () => setState(() => _presses++),
            ),
          ),
          const SizedBox(height: 16),
          const Text('Disabled'),
          const Align(
            alignment: AlignmentDirectional.centerStart,
            child: CanopyMiniButton(
              key: ValueKey('mini-button-disabled'),
              glyph: CanopyGlyph.play,
              label: 'Run',
              onPressed: null,
            ),
          ),
          const SizedBox(height: 16),
          Text('Button presses: $_presses'),
        ],
      ),
    ),
  );
}
