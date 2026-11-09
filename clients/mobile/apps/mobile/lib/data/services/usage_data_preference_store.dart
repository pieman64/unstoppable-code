import 'package:shared_preferences/shared_preferences.dart';

/// The member's usage-data choices on this device. Both default on; turning
/// one off stops that flow. Mobile does not read the organization policy.
final class UsageDataPreferences {
  const UsageDataPreferences({
    this.crashReportsEnabled = true,
    this.analyticsEnabled = true,
  });

  /// Whether crash reports are sent (Firebase Crashlytics).
  final bool crashReportsEnabled;

  /// Whether anonymous product analytics are sent (PostHog).
  final bool analyticsEnabled;

  UsageDataPreferences copyWith({
    bool? crashReportsEnabled,
    bool? analyticsEnabled,
  }) => UsageDataPreferences(
    crashReportsEnabled: crashReportsEnabled ?? this.crashReportsEnabled,
    analyticsEnabled: analyticsEnabled ?? this.analyticsEnabled,
  );
}

/// Persists [UsageDataPreferences].
///
/// Mirrors [ThemePreferenceStore]: an interface with a
/// `shared_preferences`-backed implementation and an in-memory one for tests
/// and the mock path. These are non-sensitive local choices, so they live in
/// plain preferences rather than the secure keychain.
abstract interface class UsageDataPreferenceStore {
  /// Reads the persisted choices; an unset value reads as on, the same as a
  /// first launch. Throws when the store itself can't be read.
  Future<UsageDataPreferences> read();

  /// Persists [preferences].
  Future<void> write(UsageDataPreferences preferences);
}

/// [UsageDataPreferenceStore] backed by `shared_preferences`.
final class SharedPrefsUsageDataPreferenceStore
    implements UsageDataPreferenceStore {
  static const String _crashReportsKey = 'canopy.usage_data.crash_reports';
  static const String _analyticsKey = 'canopy.usage_data.analytics';

  @override
  Future<UsageDataPreferences> read() async {
    final prefs = await SharedPreferences.getInstance();
    return UsageDataPreferences(
      crashReportsEnabled: prefs.getBool(_crashReportsKey) ?? true,
      analyticsEnabled: prefs.getBool(_analyticsKey) ?? true,
    );
  }

  @override
  Future<void> write(UsageDataPreferences preferences) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_crashReportsKey, preferences.crashReportsEnabled);
    await prefs.setBool(_analyticsKey, preferences.analyticsEnabled);
  }
}

/// In-memory [UsageDataPreferenceStore] for tests and the mock path.
final class InMemoryUsageDataPreferenceStore
    implements UsageDataPreferenceStore {
  InMemoryUsageDataPreferenceStore({
    UsageDataPreferences initial = const UsageDataPreferences(),
  }) : _preferences = initial;

  UsageDataPreferences _preferences;

  @override
  Future<UsageDataPreferences> read() async => _preferences;

  @override
  Future<void> write(UsageDataPreferences preferences) async {
    _preferences = preferences;
  }
}
