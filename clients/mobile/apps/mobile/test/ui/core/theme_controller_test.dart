import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/ui/core/theme_controller.dart';

void main() {
  group('ThemeController', () {
    test('exposes the initial mode', () {
      final controller = ThemeController(
        store: InMemoryThemePreferenceStore(),
        initialMode: ThemeMode.dark,
      );
      expect(controller.mode, ThemeMode.dark);
    });

    test('setMode updates the mode, notifies, and persists', () async {
      final store = InMemoryThemePreferenceStore();
      final controller = ThemeController(store: store);
      var notifications = 0;
      controller.addListener(() => notifications++);

      await controller.setMode(ThemeMode.light);

      expect(controller.mode, ThemeMode.light);
      expect(notifications, 1);
      expect(await store.read(), ThemeMode.light);
    });

    test('setMode keeps the UI update when persistence fails', () async {
      final controller = ThemeController(
        store: _ThrowingThemePreferenceStore(),
      );
      var notifications = 0;
      controller.addListener(() => notifications++);

      await controller.setMode(ThemeMode.dark);

      expect(controller.mode, ThemeMode.dark);
      expect(notifications, 1);
    });

    test(
      'setMode to the current mode is a no-op (no notify, no write)',
      () async {
        final store = InMemoryThemePreferenceStore(initialMode: ThemeMode.dark);
        final controller = ThemeController(
          store: store,
          initialMode: ThemeMode.dark,
        );
        var notifications = 0;
        controller.addListener(() => notifications++);

        await controller.setMode(ThemeMode.dark);

        expect(notifications, 0);
        expect(controller.mode, ThemeMode.dark);
      },
    );
  });
}

final class _ThrowingThemePreferenceStore implements ThemePreferenceStore {
  @override
  Future<ThemeMode> read() async => ThemeMode.system;

  @override
  Future<void> write(ThemeMode mode) async {
    throw StateError('write failed');
  }
}
