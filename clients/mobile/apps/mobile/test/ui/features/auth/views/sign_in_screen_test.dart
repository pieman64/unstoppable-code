import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/oauth_authenticator.dart';
import 'package:mobile/data/services/session_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/sign_in_screen.dart';

// Golden: the Unstoppable sign-in button runs the browser OAuth flow through
// the real auth repository; success stores the session token, and cancel,
// two-factor and provider failures leave the user signed out.
void main() {
  group('SignInScreen', () {
    // Reviewer demo mode is a global runtime flag; keep it off between tests so
    // one test's activation never leaks into the next.
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

    for (final outcome in [
      'success',
      'cancel',
      'two_factor_required',
      'provider_unavailable',
    ]) {
      testWidgets('Unstoppable button completes the $outcome browser flow', (
        tester,
      ) async {
        final store = InMemorySessionStore();
        final browser = _UnstoppableBrowser(outcome);
        final requests = <http.Request>[];
        final auth = AuthViewModel(
          repository: HttpAuthRepository(
            sessionStore: store,
            oauthAuthenticator: browser,
            service: AuthApiService(
              apiClient: ApiClient(
                baseUrl: 'https://production.test',
                tokenProvider: () => store.currentToken,
                httpClient: MockClient((request) async {
                  requests.add(request);
                  if (request.url.path == '/api/mobile/oauth-token') {
                    return http.Response(
                      jsonEncode({'token': 'ud-session'}),
                      200,
                    );
                  }
                  return http.Response(
                    jsonEncode({
                      'user': {'id': 'ud-user', 'email': 'user@example.com'},
                    }),
                    200,
                  );
                }),
              ),
            ),
          ),
        );
        addTearDown(auth.dispose);
        await tester.pumpWidget(
          ChangeNotifierProvider.value(
            value: auth,
            child: MaterialApp(
              theme: AppTheme.light,
              home: const SignInScreen(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final button = find.widgetWithText(
          FilledButton,
          'Continue with Unstoppable',
        );
        expect(button, findsOneWidget);
        await tester.ensureVisible(button);
        await tester.tap(button);
        await tester.pumpAndSettle();
        expect(
          browser.start!.queryParameters['provider'],
          'unstoppable-domains',
        );
        expect(browser.start!.queryParameters['code_challenge'], hasLength(43));
        if (outcome == 'success') {
          expect(auth.status, AuthStatus.authenticated);
          expect(store.currentToken, 'ud-session');
          expect(requests.map((r) => r.url.path), [
            '/api/mobile/oauth-token',
            '/api/auth/get-session',
          ]);
        } else {
          expect(store.currentToken, isNull);
          expect(requests, isEmpty);
          expect(
            auth.status,
            outcome == 'two_factor_required'
                ? AuthStatus.twoFactorPending
                : AuthStatus.unauthenticated,
          );
          if (outcome == 'provider_unavailable') {
            expect(
              find.text(
                'This sign-in method is currently unavailable. Please try another method.',
              ),
              findsOneWidget,
            );
          }
        }
        expect(tester.takeException(), isNull);
      });
    }
  });
}

final class _UnstoppableBrowser implements OAuthAuthenticator {
  _UnstoppableBrowser(this.outcome);
  final String outcome;
  Uri? start;
  @override
  Future<String?> authenticate({
    required String authorizeUrl,
    required String callbackUrl,
  }) async {
    start = Uri.parse(authorizeUrl);
    if (outcome == 'cancel') return null;
    return Uri.parse(callbackUrl)
        .replace(
          queryParameters: outcome == 'success'
              ? {'code': 'ud-code'}
              : {
                  'error': outcome,
                  if (outcome == 'two_factor_required')
                    'challenge': 'ud-challenge',
                },
        )
        .toString();
  }
}
