import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';

void main() {
  const productionUrl = 'https://code.example.com';
  const stagingUrl = 'https://staging.example.com';

  group('ApiEnvironmentController', () {
    test('defaults to production when no preference exists', () async {
      final controller = await ApiEnvironmentController.load(
        productionBaseUrl: productionUrl,
        stagingBaseUrl: stagingUrl,
        store: InMemoryApiEnvironmentPreferenceStore(),
      );

      expect(controller.value, ApiEnvironment.production);
      expect(controller.activeBaseUrl, productionUrl);
    });

    test('uses the requested default when no preference exists', () async {
      final controller = await ApiEnvironmentController.load(
        productionBaseUrl: productionUrl,
        stagingBaseUrl: stagingUrl,
        defaultEnvironment: ApiEnvironment.staging,
        store: InMemoryApiEnvironmentPreferenceStore(),
      );

      expect(controller.value, ApiEnvironment.staging);
      expect(controller.activeBaseUrl, stagingUrl);
    });

    test('loads and persists the staging selection', () async {
      final store = InMemoryApiEnvironmentPreferenceStore(
        ApiEnvironment.staging,
      );
      final controller = await ApiEnvironmentController.load(
        productionBaseUrl: productionUrl,
        stagingBaseUrl: stagingUrl,
        store: store,
      );

      expect(controller.value, ApiEnvironment.staging);
      expect(controller.activeBaseUrl, stagingUrl);

      await controller.select(ApiEnvironment.production);

      expect(store.environment, ApiEnvironment.production);
      expect(controller.activeBaseUrl, productionUrl);
    });

    test(
      'falls back to production when stored staging is unavailable',
      () async {
        final controller = await ApiEnvironmentController.load(
          productionBaseUrl: productionUrl,
          stagingBaseUrl: '',
          store: InMemoryApiEnvironmentPreferenceStore(ApiEnvironment.staging),
        );

        expect(controller.value, ApiEnvironment.production);
      },
    );

    test('rejects selecting an unconfigured environment', () async {
      final controller = await ApiEnvironmentController.load(
        productionBaseUrl: productionUrl,
        stagingBaseUrl: '',
        store: InMemoryApiEnvironmentPreferenceStore(),
      );

      expect(() => controller.select(ApiEnvironment.staging), throwsStateError);
      expect(controller.value, ApiEnvironment.production);
    });
  });
}
