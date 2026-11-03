import 'dart:convert';

import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists [SatisfactionState] across launches.
///
/// Mirrors `ThemePreferenceStore`: an interface with a real
/// (`shared_preferences`-backed) implementation and an in-memory one for
/// tests. The state holds counters and dates only, never user content.
abstract interface class SatisfactionPromptStore {
  /// Never throws: missing, corrupt, or unknown-version values read as
  /// [SatisfactionState.initial].
  Future<SatisfactionState> read();

  /// May throw; callers treat a failed write as best-effort.
  Future<void> write(SatisfactionState state);
}

final class SharedPrefsSatisfactionPromptStore
    implements SatisfactionPromptStore {
  static const String key = 'mobile.satisfaction_prompt_v1';

  @override
  Future<SatisfactionState> read() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(key);
      if (raw == null) return SatisfactionState.initial;
      return SatisfactionState.fromJson(jsonDecode(raw)) ??
          SatisfactionState.initial;
    } catch (_) {
      return SatisfactionState.initial;
    }
  }

  @override
  Future<void> write(SatisfactionState state) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(key, jsonEncode(state.toJson()));
  }
}

final class InMemorySatisfactionPromptStore implements SatisfactionPromptStore {
  InMemorySatisfactionPromptStore({
    SatisfactionState initial = SatisfactionState.initial,
  }) : _state = initial;

  SatisfactionState _state;

  /// When non-null, [write] throws this instead of storing.
  Object? failWritesWith;

  SatisfactionState get current => _state;

  @override
  Future<SatisfactionState> read() async => _state;

  @override
  Future<void> write(SatisfactionState state) async {
    final failure = failWritesWith;
    if (failure != null) throw failure;
    _state = state;
  }
}
