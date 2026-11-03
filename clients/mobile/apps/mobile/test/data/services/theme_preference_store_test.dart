import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('InMemoryThemePreferenceStore', () {
    test('defaults to system, and round-trips a written mode', () async {
      final store = InMemoryThemePreferenceStore();
      expect(await store.read(), ThemeMode.system);

      await store.write(ThemeMode.dark);
      expect(await store.read(), ThemeMode.dark);
    });

    test('honors an initial mode', () async {
      final store = InMemoryThemePreferenceStore(initialMode: ThemeMode.light);
      expect(await store.read(), ThemeMode.light);
    });
  });

  group('SharedPrefsThemePreferenceStore', () {
    test('reads system when nothing is persisted', () async {
      SharedPreferences.setMockInitialValues({});
      expect(await SharedPrefsThemePreferenceStore().read(), ThemeMode.system);
    });

    test('persists across instances', () async {
      SharedPreferences.setMockInitialValues({});
      await SharedPrefsThemePreferenceStore().write(ThemeMode.dark);
      // A fresh instance reads the persisted value.
      expect(await SharedPrefsThemePreferenceStore().read(), ThemeMode.dark);
    });

    test('an unrecognized persisted value decodes to system', () async {
      SharedPreferences.setMockInitialValues({
        'canopy.theme_mode': 'not-a-real-mode',
      });
      expect(await SharedPrefsThemePreferenceStore().read(), ThemeMode.system);
    });
  });
}
