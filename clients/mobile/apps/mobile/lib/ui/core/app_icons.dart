import 'package:flutter/material.dart';

/// Icons that carry one meaning across the app.
///
/// Use these instead of picking a Material icon at the call site, so a
/// concept looks the same on every screen and changes in one place.
abstract final class AppIcons {
  /// The one share glyph: three connected nodes, matching the desktop and
  /// web share icon.
  static const IconData share = Icons.share_outlined;
}
