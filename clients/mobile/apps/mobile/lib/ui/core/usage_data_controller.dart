import 'package:flutter/foundation.dart';
import 'package:mobile/data/services/usage_data_preference_store.dart';

/// App-global holder for the member's usage-data choices (Settings → App →
/// Crash reports / Usage analytics), persisted via a
/// [UsageDataPreferenceStore].
///
/// `main()` reads the choices with [load] before Firebase and PostHog start,
/// so the first launch applies them before either SDK sends anything, then
/// wires [onCrashReportsChanged] and [onAnalyticsChanged] to the SDKs. A
/// toggle applies in memory and to the SDK at once, then persists.
final class UsageDataController extends ChangeNotifier {
  UsageDataController({required this.store});

  /// The persistence backend the choices are written to.
  final UsageDataPreferenceStore store;

  UsageDataPreferences _preferences = const UsageDataPreferences();

  /// Whether [load] failed, so a choice in memory may be a fail-closed
  /// placeholder rather than the member's.
  bool _loadFailed = false;

  /// Which choices the member set since a failed [load]; the rest are
  /// placeholders that a later successful read replaces.
  bool _crashReportsChosen = false;
  bool _analyticsChosen = false;

  /// Serializes writes so a quick second toggle can't overtake the first.
  Future<void> _writes = Future<void>.value();

  /// Applies a crash-reports change to the crash SDK. Set once it starts.
  void Function(bool enabled)? onCrashReportsChanged;

  /// Applies a usage-analytics change to the analytics SDK. Set once it
  /// starts.
  void Function(bool enabled)? onAnalyticsChanged;

  bool get crashReportsEnabled => _preferences.crashReportsEnabled;

  /// Whether [crashReportsEnabled] is the member's choice rather than a
  /// fail-closed placeholder from a failed [load].
  bool get crashReportsChoiceKnown => !_loadFailed || _crashReportsChosen;

  bool get analyticsEnabled => _preferences.analyticsEnabled;

  /// Reads the persisted choices. A store that can't be read at all keeps
  /// both off for this session, since the member's opt-out may be what
  /// failed to load; Settings shows them off, and a toggle persists only the
  /// choice it changed.
  Future<void> load() async {
    try {
      _preferences = await store.read();
      _loadFailed = false;
    } catch (_) {
      _loadFailed = true;
      _preferences = const UsageDataPreferences(
        crashReportsEnabled: false,
        analyticsEnabled: false,
      );
    }
    notifyListeners();
  }

  Future<void> setCrashReportsEnabled(bool enabled) async {
    if (enabled == crashReportsEnabled) return;
    _preferences = _preferences.copyWith(crashReportsEnabled: enabled);
    _crashReportsChosen = true;
    onCrashReportsChanged?.call(enabled);
    notifyListeners();
    await _persist();
  }

  Future<void> setAnalyticsEnabled(bool enabled) async {
    if (enabled == analyticsEnabled) return;
    _preferences = _preferences.copyWith(analyticsEnabled: enabled);
    _analyticsChosen = true;
    onAnalyticsChanged?.call(enabled);
    notifyListeners();
    await _persist();
  }

  /// Persists the choices, one write at a time.
  Future<void> _persist() => _writes = _writes.then((_) => _write());

  /// After a failed [load], re-reads first and adopts the stored value of
  /// each choice the member hasn't set since, so a fail-closed placeholder is
  /// never written as their choice; if the store still can't be read,
  /// nothing is written.
  Future<void> _write() async {
    try {
      if (_loadFailed) {
        _adopt(await store.read());
      }
      await store.write(_preferences);
    } catch (_) {
      // The choice already applies in memory and to the SDK. Persistence
      // failures should not surface as unhandled async exceptions from UI
      // handlers.
    }
  }

  void _adopt(UsageDataPreferences stored) {
    _loadFailed = false;
    final crashReports = _crashReportsChosen
        ? crashReportsEnabled
        : stored.crashReportsEnabled;
    final analytics = _analyticsChosen
        ? analyticsEnabled
        : stored.analyticsEnabled;
    final crashChanged = crashReports != crashReportsEnabled;
    final analyticsChanged = analytics != analyticsEnabled;
    // A crash-reports placeholder the store confirms off is now the member's
    // choice: apply it again so reports kept for the placeholder are deleted.
    if (!_crashReportsChosen && !crashReports) {
      onCrashReportsChanged?.call(false);
    }
    if (!crashChanged && !analyticsChanged) return;
    _preferences = UsageDataPreferences(
      crashReportsEnabled: crashReports,
      analyticsEnabled: analytics,
    );
    if (crashChanged) onCrashReportsChanged?.call(crashReports);
    if (analyticsChanged) onAnalyticsChanged?.call(analytics);
    notifyListeners();
  }
}
