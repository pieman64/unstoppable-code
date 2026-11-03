// CAN-2859 manual Android emulator harness. Build with:
// flutter build apk --debug --target=tool/auth/emulator_verification.dart
// --dart-define=AUTH_TEST_ORIGIN=http://10.0.2.2:8789
// Uses production repository, secure storage, view model, auth gate and recovery
// screen. Only the backend and authenticated destination are test fixtures.
// Storage has a separate namespace and never reads/writes the user's session.
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/session_store.dart';
import 'package:mobile/main.dart' show AuthGate;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      storageNamespace: 'can2859_verification',
      preferencesKeyPrefix: 'can2859_',
    ),
  );
  final store = SecureSessionStore(storage: storage);
  if (await storage.read(key: 'fixture_seeded') == null) {
    await store.save(
      'can2859-test-token',
      twoFactorProof: 'can2859-test-proof',
    );
    await storage.write(key: 'fixture_seeded', value: 'true');
  }
  final auth = AuthViewModel(
    repository: HttpAuthRepository(
      sessionStore: store,
      service: AuthApiService(
        apiClient: ApiClient(
          baseUrl: const String.fromEnvironment(
            'AUTH_TEST_ORIGIN',
            defaultValue: 'http://10.0.2.2:8789',
          ),
          tokenProvider: () => store.currentToken,
          twoFactorProofProvider: () => store.currentTwoFactorProof,
        ),
      ),
    ),
  );
  runApp(
    ChangeNotifierProvider.value(
      value: auth,
      child: MaterialApp(
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        home: Consumer<AuthViewModel>(
          builder: (context, auth, child) {
            if (auth.status != AuthStatus.authenticated) {
              return const AuthGate();
            }
            return Scaffold(
              body: SafeArea(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('Session verified', key: ValueKey('verified')),
                      Text('Token retained: ${store.currentToken != null}'),
                      Text(
                        '2FA proof retained: ${store.currentTwoFactorProof != null}',
                      ),
                      FilledButton(
                        onPressed: auth.restore,
                        child: const Text('Recheck session'),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    ),
  );
  await auth.restore();
}
