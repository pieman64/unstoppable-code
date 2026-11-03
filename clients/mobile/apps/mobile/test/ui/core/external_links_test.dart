import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/ui/core/external_links.dart';

void main() {
  group('orgBillingUrl', () {
    test('builds the web billing settings path for an org', () {
      // Pinned against `organizationBillingPath` in
      // packages/protocol/src/billing/index.ts, which Dart cannot import.
      expect(
        orgBillingUrl('org-123'),
        '${AppConfig.apiBaseUrl}/organization/org-123/settings?tab=billing',
      );
    });

    test('percent-encodes the org id', () {
      expect(
        orgBillingUrl('org/with spaces&more'),
        '${AppConfig.apiBaseUrl}'
        '/organization/org%2Fwith%20spaces%26more/settings?tab=billing',
      );
    });

    test('keeps the query on the settings page, not the org segment', () {
      final url = orgBillingUrl('org-123');
      expect(url.indexOf('?'), url.indexOf('/settings') + '/settings'.length);
      expect(url.split('?').last, 'tab=billing');
    });
  });

  group('desktopDownloadUrl', () {
    void configure(ApiEnvironment environment) =>
        AppConfig.configureEnvironmentController(
          ApiEnvironmentController(
            productionBaseUrl: 'https://production.test',
            stagingBaseUrl: 'https://staging.test',
            initialEnvironment: environment,
            preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
          ),
        );

    // Pinned against `DOWNLOAD_URL` in apps/web/src/lib/marketing-links.ts,
    // which Dart cannot import.
    test('is the web download page on the production origin', () {
      configure(ApiEnvironment.production);
      expect(desktopDownloadUrl(), 'https://production.test/download');
    });

    test('follows the current environment', () {
      configure(ApiEnvironment.staging);
      expect(desktopDownloadUrl(), 'https://staging.test/download');
    });
  });

  group('openExternalUrl', () {
    test('is a no-op for an unparseable target rather than throwing', () async {
      // No platform channel is registered in a unit test, so a real launch
      // would throw. A malformed URL must not even get that far.
      await expectLater(openExternalUrl('   '), completes);
      await expectLater(openExternalUrl('::::'), completes);
    });
  });
}
