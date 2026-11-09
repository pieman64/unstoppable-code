import 'package:mobile/data/models/start_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

abstract interface class StartScreenPreferenceStore {
  Future<StartScreen> read();
  Future<void> write(StartScreen screen);
}

/// A device-local preference, independent of the signed-in account.
final class SharedPrefsStartScreenPreferenceStore
    implements StartScreenPreferenceStore {
  static const _key = 'canopy.start_screen';

  @override
  Future<StartScreen> read() async {
    final prefs = await SharedPreferences.getInstance();
    return switch (prefs.getString(_key)) {
      'projects' => StartScreen.projects,
      _ => StartScreen.newChat,
    };
  }

  @override
  Future<void> write(StartScreen screen) async {
    final prefs = await SharedPreferences.getInstance();
    final saved = await prefs.setString(_key, screen.name);
    if (!saved) throw StateError('Could not save start screen');
  }
}
