import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/start_screen.dart';
import 'package:mobile/data/services/start_screen_preference_store.dart';

/// Holds the saved preference and a single startup navigation request.
final class StartScreenController extends ChangeNotifier {
  StartScreenController({
    required this.store,
    StartScreen initialScreen = StartScreen.newChat,
  }) : _screen = initialScreen,
       _initialScreen = initialScreen;

  final StartScreenPreferenceStore store;
  final StartScreen _initialScreen;
  StartScreen _screen;
  bool _initialScreenTaken = false;
  bool _saving = false;
  bool _saveFailed = false;

  StartScreen get screen => _screen;
  bool get saving => _saving;
  bool get saveFailed => _saveFailed;

  /// Load before mounting the shell so it never flashes the wrong screen.
  static Future<StartScreenController> restore(
    StartScreenPreferenceStore store,
  ) async {
    StartScreen initialScreen;
    try {
      initialScreen = await store.read();
    } catch (_) {
      initialScreen = StartScreen.newChat;
    }
    return StartScreenController(store: store, initialScreen: initialScreen);
  }

  /// Rebuilt shells and later preference edits must not repeat startup routing.
  StartScreen? takeInitialScreen() {
    if (_initialScreenTaken) return null;
    _initialScreenTaken = true;
    return _initialScreen;
  }

  Future<void> setScreen(StartScreen screen) async {
    if (_saving || screen == _screen) return;
    final previous = _screen;
    _screen = screen;
    _saving = true;
    _saveFailed = false;
    notifyListeners();
    try {
      await store.write(screen);
    } catch (_) {
      _screen = previous;
      _saveFailed = true;
    } finally {
      _saving = false;
      notifyListeners();
    }
  }
}
