import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists the user's selected [ThemeMode] (System / Light / Dark).
///
/// Mirrors the `SessionStore` shape: an interface with a real
/// (`shared_preferences`-backed) implementation and an in-memory implementation
/// for tests and the mock path. Theme choice is a non-sensitive local
/// preference, so it lives in plain preferences rather than the secure keychain
/// used for the auth token.
abstract interface class ThemePreferenceStore {
  /// Reads the persisted mode, defaulting to [ThemeMode.system] when unset or
  /// unrecognized.
  Future<ThemeMode> read();

  /// Persists [mode].
  Future<void> write(ThemeMode mode);
}

String _encode(ThemeMode mode) => switch (mode) {
  ThemeMode.system => 'system',
  ThemeMode.light => 'light',
  ThemeMode.dark => 'dark',
};

/// Maps a persisted string back to a [ThemeMode]. Unknown or null values fall
/// back to [ThemeMode.system] so a corrupt or future value never throws.
ThemeMode _decode(String? value) => switch (value) {
  'light' => ThemeMode.light,
  'dark' => ThemeMode.dark,
  _ => ThemeMode.system,
};

/// [ThemePreferenceStore] backed by `shared_preferences`.
final class SharedPrefsThemePreferenceStore implements ThemePreferenceStore {
  static const String _key = 'canopy.theme_mode';

  @override
  Future<ThemeMode> read() async {
    final prefs = await SharedPreferences.getInstance();
    return _decode(prefs.getString(_key));
  }

  @override
  Future<void> write(ThemeMode mode) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, _encode(mode));
  }
}

/// In-memory [ThemePreferenceStore] for tests and the mock path.
final class InMemoryThemePreferenceStore implements ThemePreferenceStore {
  InMemoryThemePreferenceStore({ThemeMode initialMode = ThemeMode.system})
    : _mode = initialMode;

  ThemeMode _mode;

  @override
  Future<ThemeMode> read() async => _mode;

  @override
  Future<void> write(ThemeMode mode) async {
    _mode = mode;
  }
}
