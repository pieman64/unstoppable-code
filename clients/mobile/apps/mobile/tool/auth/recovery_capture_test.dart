// CAN-2859: deterministic offline startup, real auth gate, fake HTTP and storage.
// AUTH_STAGE=before/after flutter test tool/auth/recovery_capture_test.dart --update-goldens
// Captures both themes with bundled fonts; no network or live accounts.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/session_store.dart';
import 'package:mobile/main.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final stage = Platform.environment['AUTH_STAGE'] ?? 'after';
  setUpAll(() async {
    for (final (family, folder) in [
      ('Inter', 'inter'),
      // Button styles without a family use the test harness fallback.
      ('Roboto', 'inter'),
      ('JetBrainsMono', 'jetbrains-mono'),
    ]) {
      final assetFamily = family == 'Roboto' ? 'Inter' : family;
      final loader = FontLoader(family);
      for (final suffix in ['', '-Italic']) {
        loader.addFont(
          rootBundle.load(
            'assets/fonts/$folder/${assetFamily}Variable$suffix.ttf',
          ),
        );
      }
      await loader.load();
    }
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
  });
  for (final dark in [false, true]) {
    testWidgets('offline recovery ${dark ? 'dark' : 'light'}', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final store = InMemorySessionStore(initialToken: 'saved-token');
      final auth = AuthViewModel(
        repository: HttpAuthRepository(
          sessionStore: store,
          service: AuthApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: MockClient(
                (_) async => throw http.ClientException('offline'),
              ),
            ),
          ),
        ),
      );
      addTearDown(auth.dispose);
      await auth.restore();
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: auth,
          child: MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const AuthGate(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(Scaffold).last,
        matchesGoldenFile(
          '../../../../.playwright/can-2859/offline-$stage-${dark ? 'dark' : 'light'}.png',
        ),
      );
      expect(tester.takeException(), isNull);
    });
  }
}
