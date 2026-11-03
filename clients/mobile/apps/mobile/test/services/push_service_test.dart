import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/device_registration.dart';
import 'package:mobile/data/repositories/device_repository.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/services/push_service.dart';

void main() {
  group('PushService', () {
    late FakePushMessaging messaging;
    late MockDeviceRepository deviceRepository;

    PushService build({
      PushPermissionStatus permissionResult = PushPermissionStatus.granted,
      String? token = 'tok',
      bool isPushConfigured = true,
      bool Function()? isPushConfiguredOverride,
      Duration repositoryLatency = Duration.zero,
      Object? getTokenError,
      int getTokenFailuresRemaining = 0,
      Object? deleteTokenError,
      int initialTokenRetryAttempts = 3,
      Duration initialTokenRetryDelay = Duration.zero,
    }) {
      messaging = FakePushMessaging(
        permissionResult: permissionResult,
        token: token,
        getTokenError: getTokenError,
        getTokenFailuresRemaining: getTokenFailuresRemaining,
        deleteTokenError: deleteTokenError,
      );
      deviceRepository = MockDeviceRepository(latency: repositoryLatency);
      return PushService(
        messaging: messaging,
        deviceRepository: deviceRepository,
        platform: DevicePlatform.ios,
        isPushConfigured: isPushConfiguredOverride ?? () => isPushConfigured,
        initialTokenRetryAttempts: initialTokenRetryAttempts,
        initialTokenRetryDelay: initialTokenRetryDelay,
      );
    }

    test('onAuthenticated no-ops when push is not configured', () async {
      final service = build(isPushConfigured: false);

      await service.onAuthenticated();

      expect(messaging.requestPermissionCallCount, 0);
      expect(messaging.getTokenCallCount, 0);
      expect(deviceRepository.registeredTokens, isEmpty);
    });

    test('registers the token when permission is granted', () async {
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
      );

      await service.onAuthenticated();

      expect(deviceRepository.registeredTokens, ['tok']);
    });

    test('does not register when permission is denied', () async {
      final service = build(
        permissionResult: PushPermissionStatus.denied,
        token: 'tok',
      );

      await service.onAuthenticated();

      expect(messaging.getTokenCallCount, 0);
      expect(deviceRepository.registeredTokens, isEmpty);
    });

    test('a token refresh re-registers the new token', () async {
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
      );
      await service.onAuthenticated();

      messaging.emitTokenRefresh('tok2');
      await pumpEventQueue();

      expect(deviceRepository.registeredTokens, ['tok', 'tok2']);
      expect(deviceRepository.unregisteredTokens, ['tok']);
    });

    test('retries the initial iOS token when APNS is not ready', () async {
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
        getTokenError: StateError('apns-token-not-set'),
        getTokenFailuresRemaining: 1,
      );

      await service.onAuthenticated();

      expect(messaging.getTokenCallCount, 2);
      expect(deviceRepository.registeredTokens, ['tok']);
    });

    test(
      'keeps refresh handling when the initial iOS token is unavailable',
      () async {
        final service = build(
          permissionResult: PushPermissionStatus.granted,
          token: 'tok',
          getTokenError: StateError('apns-token-not-set'),
          getTokenFailuresRemaining: 2,
          initialTokenRetryAttempts: 1,
        );

        await service.onAuthenticated();
        messaging.emitTokenRefresh('tok2');
        await pumpEventQueue();

        expect(messaging.getTokenCallCount, 2);
        expect(deviceRepository.registeredTokens, ['tok2']);
      },
    );

    test('a token refresh no-ops when push becomes unconfigured', () async {
      var isPushConfigured = true;
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
        isPushConfiguredOverride: () => isPushConfigured,
      );
      await service.onAuthenticated();

      isPushConfigured = false;
      messaging.emitTokenRefresh('tok2');
      await pumpEventQueue();

      expect(deviceRepository.registeredTokens, ['tok']);
    });

    test(
      'onSignedOut deletes the local token even without process state',
      () async {
        final service = build(token: 'stale-tok');

        await service.onSignedOut(null);

        expect(messaging.deleteTokenCallCount, 1);
        expect(deviceRepository.unregisteredTokens, isEmpty);
      },
    );

    test(
      'onSignedOut unregisters tracked tokens when local deletion throws',
      () async {
        final service = build(
          permissionResult: PushPermissionStatus.granted,
          token: 'tok',
          deleteTokenError: StateError('delete failed'),
        );
        await service.onAuthenticated();

        await service.onSignedOut(null);

        expect(messaging.deleteTokenCallCount, 1);
        expect(deviceRepository.unregisteredTokens, ['tok']);
      },
    );

    test('onSignedOut unregisters the last token and stops refresh '
        'handling', () async {
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
      );
      await service.onAuthenticated();

      await service.onSignedOut(null);

      expect(deviceRepository.unregisteredTokens, ['tok']);
      expect(messaging.deleteTokenCallCount, 1);

      // A later refresh emit does nothing — the subscription was cancelled.
      messaging.emitTokenRefresh('tok2');
      await pumpEventQueue();

      expect(deviceRepository.registeredTokens, ['tok']);
    });

    test('onSignedOut deletes local token without unregistering when '
        'push becomes unconfigured', () async {
      var isPushConfigured = true;
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
        isPushConfiguredOverride: () => isPushConfigured,
      );
      await service.onAuthenticated();

      isPushConfigured = false;
      await service.onSignedOut(null);

      expect(messaging.deleteTokenCallCount, 1);
      expect(deviceRepository.unregisteredTokens, isEmpty);
    });

    test(
      'onSignedOut revokes an in-flight registration after it completes',
      () async {
        final service = build(
          permissionResult: PushPermissionStatus.granted,
          token: 'tok',
          repositoryLatency: const Duration(milliseconds: 10),
        );

        final authFuture = service.onAuthenticated();
        await Future<void>.delayed(Duration.zero);

        await service.onSignedOut(null);
        await authFuture;

        expect(deviceRepository.registeredTokens, ['tok']);
        expect(deviceRepository.unregisteredTokens, ['tok']);
        expect(messaging.deleteTokenCallCount, 1);
      },
    );

    test('onAppResumed registers a token when permission was granted '
        'after sign-in', () async {
      final service = build(
        permissionResult: PushPermissionStatus.denied,
        token: 'tok',
      );
      await service.onAuthenticated();
      expect(deviceRepository.registeredTokens, isEmpty);

      // The user enables notifications in OS settings, which backgrounds the
      // app; returning to it resumes.
      messaging.permissionResult = PushPermissionStatus.granted;
      await service.onAppResumed();

      expect(deviceRepository.registeredTokens, ['tok']);
    });

    test('onAppResumed re-registers after the initial token was '
        'unavailable', () async {
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
        getTokenError: StateError('apns-token-not-set'),
        getTokenFailuresRemaining: 4,
        initialTokenRetryAttempts: 3,
      );
      await service.onAuthenticated();
      expect(deviceRepository.registeredTokens, isEmpty);

      await service.onAppResumed();

      expect(deviceRepository.registeredTokens, ['tok']);
    });

    test('onAppResumed leaves an already-registered token alone', () async {
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
      );
      await service.onAuthenticated();
      expect(deviceRepository.registeredTokens, ['tok']);

      await service.onAppResumed();

      expect(deviceRepository.registeredTokens, ['tok']);
      expect(messaging.requestPermissionCallCount, 1);
    });

    test('onAppResumed does not register while signed out', () async {
      final service = build(
        permissionResult: PushPermissionStatus.granted,
        token: 'tok',
      );

      await service.onAppResumed();

      expect(messaging.requestPermissionCallCount, 0);
      expect(deviceRepository.registeredTokens, isEmpty);
    });

    test('onAppResumed does not register after sign-out', () async {
      final service = build(
        permissionResult: PushPermissionStatus.denied,
        token: 'tok',
      );
      await service.onAuthenticated();
      await service.onSignedOut(null);

      messaging.permissionResult = PushPermissionStatus.granted;
      await service.onAppResumed();

      expect(deviceRepository.registeredTokens, isEmpty);
    });

    test('onAppResumed no-ops when push is not configured', () async {
      final service = build(isPushConfigured: false);
      await service.onAuthenticated();

      await service.onAppResumed();

      expect(messaging.requestPermissionCallCount, 0);
      expect(deviceRepository.registeredTokens, isEmpty);
    });

    test('onAppResumed keeps doing nothing while permission stays '
        'denied', () async {
      final service = build(
        permissionResult: PushPermissionStatus.denied,
        token: 'tok',
      );
      await service.onAuthenticated();

      await service.onAppResumed();

      expect(messaging.getTokenCallCount, 0);
      expect(deviceRepository.registeredTokens, isEmpty);
    });
  });
}
