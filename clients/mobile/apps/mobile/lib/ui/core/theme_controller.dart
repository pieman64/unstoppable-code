import 'package:flutter/material.dart';
import 'package:mobile/data/services/theme_preference_store.dart';

/// App-global holder for the selected [ThemeMode], persisted via a
/// [ThemePreferenceStore]. Provided above [MaterialApp] so changing the mode
/// re-themes the whole app; the initial value is loaded before `runApp` so the
/// first frame already reflects the persisted choice (no theme flash).
final class ThemeController extends ChangeNotifier {
  ThemeController({
    required this.store,
    ThemeMode initialMode = ThemeMode.system,
  }) : _mode = initialMode;

  /// The persistence backend the selected mode is written to.
  final ThemePreferenceStore store;
  ThemeMode _mode;

  /// The active theme mode.
  ThemeMode get mode => _mode;

  /// Selects [mode]: updates the app immediately, then persists. A no-op when
  /// [mode] is already active.
  Future<void> setMode(ThemeMode mode) async {
    if (mode == _mode) return;
    _mode = mode;
    notifyListeners();
    try {
      await store.write(mode);
    } catch (_) {
      // The theme has already been applied in memory. Persistence failures
      // should not surface as unhandled async exceptions from UI handlers.
    }
  }
}
