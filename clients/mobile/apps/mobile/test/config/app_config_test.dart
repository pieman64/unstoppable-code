import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/data/services/browser_capabilities.dart';

void main() {
  group('AppConfig', () {
    setUp(() {
      DemoMode.enabled.value = false;
      AppConfig.configureEnvironmentController(
        ApiEnvironmentController(
          productionBaseUrl: 'https://production.test',
          stagingBaseUrl: 'https://staging.test',
          initialEnvironment: ApiEnvironment.production,
          preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
        ),
      );
    });
    tearDown(() => DemoMode.enabled.value = false);

    test('apiBaseUrl is empty while reviewer demo mode is active', () {
      expect(AppConfig.apiBaseUrl, 'https://production.test');

      DemoMode.enabled.value = true;

      expect(AppConfig.apiBaseUrl, isEmpty);
      expect(AppConfig.hasAuthApiConfig, isFalse);
    });

    test('uses the staging server only while staging is active', () async {
      expect(AppConfig.usesStagingServer, isFalse);

      await AppConfig.selectEnvironment(ApiEnvironment.staging);

      expect(AppConfig.usesStagingServer, isTrue);
    });

    test('never uses the staging server in reviewer demo mode', () async {
      await AppConfig.selectEnvironment(ApiEnvironment.staging);

      DemoMode.enabled.value = true;

      expect(AppConfig.usesStagingServer, isFalse);
    });

    test('apiBaseUrl follows the selected fixed environment', () async {
      await AppConfig.selectEnvironment(ApiEnvironment.staging);

      expect(AppConfig.environment, ApiEnvironment.staging);
      expect(AppConfig.apiBaseUrl, 'https://staging.test');
      expect(AppConfig.hasAuthApiConfig, isTrue);
    });

    test('Android release uses the production HTTPS App Link callback', () {
      expect(
        AppConfig.oauthCallbackUrlFor(
          platform: TargetPlatform.android,
          releaseMode: true,
          authTabSupported: true,
          apiBaseUrlOverride: 'https://app.unstoppable.ai',
        ),
        'https://app.unstoppable.ai/api/mobile/oauth-app-callback',
      );
    });

    test('Android release uses the staging HTTPS App Link callback', () {
      expect(
        AppConfig.oauthCallbackUrlFor(
          platform: TargetPlatform.android,
          releaseMode: true,
          authTabSupported: true,
          apiBaseUrlOverride: 'https://code.ud-staging.com',
        ),
        'https://code.ud-staging.com/api/mobile/oauth-app-callback',
      );
    });

    test('Android debug and profile builds retain the custom callback', () {
      expect(
        AppConfig.oauthCallbackUrlFor(
          platform: TargetPlatform.android,
          releaseMode: false,
          authTabSupported: true,
          apiBaseUrlOverride: 'https://code.ud-staging.com',
        ),
        'unstoppable-code://auth',
      );
    });

    test('iOS release retains the custom callback', () {
      expect(
        AppConfig.oauthCallbackUrlFor(
          platform: TargetPlatform.iOS,
          releaseMode: true,
          authTabSupported: true,
          apiBaseUrlOverride: 'https://app.unstoppable.ai',
        ),
        'unstoppable-code://auth',
      );
    });

    test('the retired production host is no longer an App Link host', () {
      // New builds must fall through to the custom scheme rather than minting
      // an HTTPS callback the manifest no longer claims. The web host remains
      // temporarily available only for already-shipped clients.
      const retiredProductionHost = 'code.unstoppabledomains.com';
      expect(
        AppConfig.oauthCallbackUrlFor(
          platform: TargetPlatform.android,
          releaseMode: true,
          authTabSupported: true,
          apiBaseUrlOverride: 'https://$retiredProductionHost',
        ),
        'unstoppable-code://auth',
      );
    });

    test('unknown Android release hosts retain the custom callback', () {
      expect(
        AppConfig.oauthCallbackUrlFor(
          platform: TargetPlatform.android,
          releaseMode: true,
          authTabSupported: true,
          apiBaseUrlOverride: 'https://preview.example.test',
        ),
        'unstoppable-code://auth',
      );
    });

    test('Android release retains the custom callback when the browser cannot '
        'return an HTTPS Auth Tab redirect', () {
      // A browser without Auth Tab support (e.g. Chrome < 141) never hands
      // the claimed HTTPS link back to the app, dead-ending sign-in on the
      // web fallback page. The custom scheme works on every browser.
      expect(
        AppConfig.oauthCallbackUrlFor(
          platform: TargetPlatform.android,
          releaseMode: true,
          authTabSupported: false,
          apiBaseUrlOverride: 'https://code.ud-staging.com',
        ),
        'unstoppable-code://auth',
      );
    });
  });

  group('AppConfig.resolveOauthCallbackUrl', () {
    setUp(() {
      DemoMode.enabled.value = false;
      AppConfig.configureEnvironmentController(
        ApiEnvironmentController(
          productionBaseUrl: 'https://app.unstoppable.ai',
          stagingBaseUrl: 'https://code.ud-staging.com',
          initialEnvironment: ApiEnvironment.production,
          preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
        ),
      );
    });

    test(
      'claims the HTTPS App Link when the browser supports Auth Tab',
      () async {
        final capabilities = _RecordingCapabilities(supported: true);

        final url = await AppConfig.resolveOauthCallbackUrl(
          capabilities,
          platform: TargetPlatform.android,
          releaseMode: true,
        );

        expect(url, 'https://app.unstoppable.ai/api/mobile/oauth-app-callback');
        expect(capabilities.probeCount, 1);
      },
    );

    test('falls back to the custom scheme when Auth Tab is missing', () async {
      final capabilities = _RecordingCapabilities(supported: false);

      final url = await AppConfig.resolveOauthCallbackUrl(
        capabilities,
        platform: TargetPlatform.android,
        releaseMode: true,
      );

      expect(url, 'unstoppable-code://auth');
      expect(capabilities.probeCount, 1);
    });

    test('does not probe the browser on iOS', () async {
      final capabilities = _RecordingCapabilities(supported: true);

      final url = await AppConfig.resolveOauthCallbackUrl(
        capabilities,
        platform: TargetPlatform.iOS,
        releaseMode: true,
      );

      expect(url, 'unstoppable-code://auth');
      expect(capabilities.probeCount, 0);
    });

    test('does not probe the browser in debug and profile builds', () async {
      final capabilities = _RecordingCapabilities(supported: true);

      final url = await AppConfig.resolveOauthCallbackUrl(
        capabilities,
        platform: TargetPlatform.android,
        releaseMode: false,
      );

      expect(url, 'unstoppable-code://auth');
      expect(capabilities.probeCount, 0);
    });
  });
}

/// [BrowserCapabilities] that answers with a fixed [supported] value and counts
/// how many times it was asked, so tests can assert the probe is skipped when
/// the build could not use an HTTPS callback anyway.
class _RecordingCapabilities implements BrowserCapabilities {
  _RecordingCapabilities({required this.supported});

  final bool supported;
  int probeCount = 0;

  @override
  Future<bool> supportsHttpsAuthTabRedirect() async {
    probeCount++;
    return supported;
  }
}
