import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The two fixed API origins a distributed mobile build may use.
///
/// This intentionally is not a free-form URL setting: release builds may switch
/// between the known production and staging services, but must never send auth
/// tokens to an operator-entered host.
enum ApiEnvironment {
  production('Production'),
  staging('Staging');

  const ApiEnvironment(this.label);

  final String label;
}

abstract interface class ApiEnvironmentPreferenceStore {
  Future<ApiEnvironment?> read();

  Future<void> write(ApiEnvironment environment);
}

/// Persists the selected API environment across app launches.
final class SharedPrefsApiEnvironmentPreferenceStore
    implements ApiEnvironmentPreferenceStore {
  static const String preferenceKey = 'mobile.api_environment';

  @override
  Future<ApiEnvironment?> read() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(preferenceKey);
    return ApiEnvironment.values.cast<ApiEnvironment?>().firstWhere(
      (environment) => environment?.name == stored,
      orElse: () => null,
    );
  }

  @override
  Future<void> write(ApiEnvironment environment) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(preferenceKey, environment.name);
  }
}

/// Test-friendly in-memory preference store.
final class InMemoryApiEnvironmentPreferenceStore
    implements ApiEnvironmentPreferenceStore {
  InMemoryApiEnvironmentPreferenceStore([this.environment]);

  ApiEnvironment? environment;

  @override
  Future<ApiEnvironment?> read() async => environment;

  @override
  Future<void> write(ApiEnvironment environment) async {
    this.environment = environment;
  }
}

/// Owns the selected environment and the two build-injected, fixed origins.
final class ApiEnvironmentController extends ValueNotifier<ApiEnvironment> {
  ApiEnvironmentController({
    required this.productionBaseUrl,
    required this.stagingBaseUrl,
    required ApiEnvironment initialEnvironment,
    required this.preferenceStore,
  }) : super(
         _availableInitialEnvironment(
           initialEnvironment,
           productionBaseUrl: productionBaseUrl,
           stagingBaseUrl: stagingBaseUrl,
         ),
       );

  static Future<ApiEnvironmentController> load({
    required String productionBaseUrl,
    required String stagingBaseUrl,
    ApiEnvironment defaultEnvironment = ApiEnvironment.production,
    ApiEnvironmentPreferenceStore? store,
  }) async {
    final resolvedStore = store ?? SharedPrefsApiEnvironmentPreferenceStore();
    final stored = await resolvedStore.read();
    return ApiEnvironmentController(
      productionBaseUrl: productionBaseUrl,
      stagingBaseUrl: stagingBaseUrl,
      initialEnvironment: stored ?? defaultEnvironment,
      preferenceStore: resolvedStore,
    );
  }

  final String productionBaseUrl;
  final String stagingBaseUrl;
  final ApiEnvironmentPreferenceStore preferenceStore;

  String get activeBaseUrl => baseUrlFor(value);

  String baseUrlFor(ApiEnvironment environment) => switch (environment) {
    ApiEnvironment.production => productionBaseUrl,
    ApiEnvironment.staging => stagingBaseUrl,
  };

  bool isAvailable(ApiEnvironment environment) =>
      baseUrlFor(environment).isNotEmpty;

  Future<void> select(ApiEnvironment environment) async {
    if (environment == value) return;
    if (!isAvailable(environment)) {
      throw StateError('${environment.label} API is not configured.');
    }
    await preferenceStore.write(environment);
    value = environment;
  }

  static ApiEnvironment _availableInitialEnvironment(
    ApiEnvironment requested, {
    required String productionBaseUrl,
    required String stagingBaseUrl,
  }) {
    final requestedUrl = switch (requested) {
      ApiEnvironment.production => productionBaseUrl,
      ApiEnvironment.staging => stagingBaseUrl,
    };
    if (requestedUrl.isNotEmpty) return requested;
    if (productionBaseUrl.isNotEmpty) return ApiEnvironment.production;
    if (stagingBaseUrl.isNotEmpty) return ApiEnvironment.staging;
    return ApiEnvironment.production;
  }
}
