import 'package:shared_preferences/shared_preferences.dart';

/// Remembers, per account on this device, that the "Get the desktop app"
/// prompt was closed, so it never opens on its own again (CAN-4424).
///
/// Accounts are identified by an environment-qualified scope such as
/// `production:7`: the same numeric id on another server is another account.
/// Signing out leaves the flag in place, so the same account signing back in
/// stays dismissed.
abstract interface class DesktopAppPromptStore {
  /// Never throws: a missing or unreadable value reads as not dismissed.
  Future<bool> isDismissed(String accountScope);

  /// May throw; callers treat a failed write as best-effort.
  Future<void> markDismissed(String accountScope);
}

final class SharedPrefsDesktopAppPromptStore implements DesktopAppPromptStore {
  static const String _keyPrefix = 'mobile.desktop_app_prompt_v1.';

  static String keyFor(String accountScope) => '$_keyPrefix$accountScope';

  @override
  Future<bool> isDismissed(String accountScope) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(keyFor(accountScope)) ?? false;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> markDismissed(String accountScope) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(keyFor(accountScope), true);
  }
}

final class InMemoryDesktopAppPromptStore implements DesktopAppPromptStore {
  InMemoryDesktopAppPromptStore({Set<String> dismissed = const {}})
    : _dismissed = {...dismissed};

  final Set<String> _dismissed;

  /// When non-null, [markDismissed] throws this instead of storing.
  Object? failWritesWith;

  @override
  Future<bool> isDismissed(String accountScope) async =>
      _dismissed.contains(accountScope);

  @override
  Future<void> markDismissed(String accountScope) async {
    final failure = failWritesWith;
    if (failure != null) throw failure;
    _dismissed.add(accountScope);
  }
}
