import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/notification_preferences.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';

void main() {
  group('NotificationsViewModel', () {
    NotificationsViewModel build() => NotificationsViewModel(
      repository: MockNotificationPreferencesRepository(latency: Duration.zero),
      isConfigured: () => true,
    );

    test('load populates pushEnabled from the repository', () async {
      final vm = build();

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.pushEnabled, isTrue);
      expect(vm.error, isNull);
    });

    test('load reflects a previously persisted false value', () async {
      final repository = MockNotificationPreferencesRepository(
        latency: Duration.zero,
      );
      await repository.update(pushEnabled: false);
      final vm = NotificationsViewModel(
        repository: repository,
        isConfigured: () => true,
      );

      await vm.load();

      expect(vm.pushEnabled, isFalse);
      expect(vm.error, isNull);
    });

    test(
      'setPushEnabled optimistically flips, persists, and notifies',
      () async {
        final repository = MockNotificationPreferencesRepository(
          latency: Duration.zero,
        );
        final vm = NotificationsViewModel(
          repository: repository,
          isConfigured: () => true,
        );
        await vm.load();
        expect(vm.pushEnabled, isTrue);
        var notified = 0;
        vm.addListener(() => notified++);

        final future = vm.setPushEnabled(false);
        // The flip is optimistic: it happens synchronously, before the
        // repository call resolves.
        expect(vm.pushEnabled, isFalse);
        expect(vm.isMutating, isTrue);

        await future;

        expect(vm.pushEnabled, isFalse);
        expect(vm.isMutating, isFalse);
        expect(vm.error, isNull);
        expect(notified, 2);
        expect((await repository.load()).pushEnabled, isFalse);
      },
    );

    test('setPushEnabled is a no-op when the value is unchanged', () async {
      final vm = build();
      await vm.load();
      var notified = 0;
      vm.addListener(() => notified++);

      await vm.setPushEnabled(true);

      expect(notified, 0);
      expect(vm.isMutating, isFalse);
    });

    test(
      'setPushEnabled reverts and records the error when the update fails',
      () async {
        final vm = NotificationsViewModel(
          repository: _FailingNotificationPreferencesRepository(),
          isConfigured: () => true,
        );

        await vm.setPushEnabled(false);

        expect(vm.pushEnabled, isTrue);
        expect(vm.isMutating, isFalse);
        expect(vm.error, isNotNull);
      },
    );

    test('load failure sets error without throwing', () async {
      final vm = NotificationsViewModel(
        repository: _FailingNotificationPreferencesRepository(),
        isConfigured: () => true,
      );

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.error, isNotNull);
    });

    test(
      'load is a no-op when not configured (e.g. reviewer demo mode)',
      () async {
        final repository = MockNotificationPreferencesRepository(
          latency: Duration.zero,
        );
        final vm = NotificationsViewModel(
          repository: repository,
          isConfigured: () => false,
        );

        await vm.load();

        expect(repository.loadCount, 0);
        expect(vm.pushEnabled, isTrue);
        expect(vm.isLoading, isFalse);
        expect(vm.error, isNull);
      },
    );

    test('setPushEnabled only flips locally when not configured '
        '(e.g. reviewer demo mode)', () async {
      final repository = MockNotificationPreferencesRepository(
        latency: Duration.zero,
      );
      final vm = NotificationsViewModel(
        repository: repository,
        isConfigured: () => false,
      );
      var notified = 0;
      vm.addListener(() => notified++);

      await vm.setPushEnabled(false);

      expect(vm.pushEnabled, isFalse);
      expect(vm.isMutating, isFalse);
      expect(vm.error, isNull);
      expect(notified, 1);
      expect(repository.updateCount, 0);
    });
  });
}

/// Always throws on [load] and [update], simulating a network failure.
final class _FailingNotificationPreferencesRepository
    implements NotificationPreferencesRepository {
  @override
  Future<NotificationPreferences> load() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('load request failed');
  }

  @override
  Future<NotificationPreferences> update({required bool pushEnabled}) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('update request failed');
  }
}
