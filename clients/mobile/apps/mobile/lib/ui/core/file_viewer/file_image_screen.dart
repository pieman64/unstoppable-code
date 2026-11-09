import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Full-screen zoom for an image that is already loaded, so opening it
/// never reads the file again (CAN-5130). Close and system back return to
/// the document underneath.
class FileImageScreen extends StatelessWidget {
  const FileImageScreen({super.key, required this.bytes, required this.label});

  final Uint8List bytes;
  final String label;

  static const maxScale = 6.0;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: CanopyIconButton(
          glyph: CanopyGlyph.crossMedium,
          tooltip: 'Close image',
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        content: Text(label),
      ),
      body: Builder(
        builder: (context) => Padding(
          padding: CanopyScaffold.contentPaddingOf(context, includeFade: false),
          child: InteractiveViewer(
            key: const ValueKey('file-image-zoom'),
            maxScale: maxScale,
            child: Center(
              child: Image.memory(
                bytes,
                fit: BoxFit.contain,
                semanticLabel: label,
                errorBuilder: (context, error, stackTrace) => Text(
                  "Couldn't show this image.",
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.foregroundSecondary,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
