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
import 'package:mobile/ui/features/auth/views/two_factor_screen.dart';
import 'package:mobile/data/services/pkce.dart';

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
                  if (request.url.path == '/api/mobile/email-auth') {
                    return http.Response('{"enabled":false}', 200);
                  }
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
            '/api/mobile/email-auth',
            '/api/mobile/oauth-token',
            '/api/auth/get-session',
          ]);
        } else {
          expect(store.currentToken, isNull);
          expect(requests.map((r) => r.url.path), ['/api/mobile/email-auth']);
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

    for (final availability in ['disabled', 'old-server', 'offline']) {
      testWidgets('email $availability preserves social and reviewer access', (
        tester,
      ) async {
        final auth = AuthViewModel(
          repository: HttpAuthRepository(
            sessionStore: InMemorySessionStore(),
            service: AuthApiService(
              apiClient: ApiClient(
                baseUrl: 'https://production.test',
                httpClient: MockClient((request) async {
                  if (availability == 'offline') {
                    throw http.ClientException('offline');
                  }
                  return availability == 'old-server'
                      ? http.Response('{}', 404)
                      : http.Response('{"enabled":false}', 200);
                }),
              ),
            ),
          ),
        );
        addTearDown(auth.dispose);
        await tester.pumpWidget(
          ChangeNotifierProvider.value(
            value: auth,
            child: const MaterialApp(home: SignInScreen()),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Continue with email'), findsNothing);
        expect(find.text('Continue with Google'), findsOneWidget);
        // Reviewer mode uses its existing local mock repository, independent
        // of server rollout/availability. No public auth bypass is introduced.
        DemoMode.enabled.value = true;
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('reviewerSignInButton')), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    for (final flow in [
      'success',
      'verification',
      'pending-signin',
      'reset',
      'two-factor',
      'validation-failure',
    ]) {
      testWidgets(
        'native email $flow completes PKCE through the auth lifecycle',
        (tester) async {
          tester.view.physicalSize = const Size(390, 844);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final store = InMemorySessionStore();
          final requests = <http.Request>[];
          var verified = flow != 'verification' && flow != 'pending-signin';
          String? challenge;
          String? factorVerifier;
          final auth = AuthViewModel(
            repository: HttpAuthRepository(
              sessionStore: store,
              service: AuthApiService(
                apiClient: ApiClient(
                  baseUrl: 'https://production.test',
                  tokenProvider: () => store.currentToken,
                  httpClient: MockClient((request) async {
                    requests.add(request);
                    final body = request.body.isEmpty
                        ? <String, dynamic>{}
                        : jsonDecode(request.body) as Map<String, dynamic>;
                    switch (request.url.path) {
                      case '/api/mobile/email-auth':
                        return http.Response('{"enabled":true}', 200);
                      case '/api/auth/sign-up/email':
                        expectSync(body['name'], '');
                        expectSync(body['email'], 'email@example.test');
                        return http.Response('{"token":null,"user":{}}', 200);
                      case '/api/auth/email-otp/verify-email':
                        verified = true;
                        return http.Response(
                          '{"status":true,"token":null,"user":{}}',
                          200,
                        );
                      case '/api/auth/email-otp/request-password-reset':
                        expectSync(body, {'email': 'email@example.test'});
                        return http.Response('{"success":true}', 200);
                      case '/api/auth/email-otp/reset-password':
                        expectSync(body, {
                          'email': 'email@example.test',
                          'otp': '012345',
                          'password': 'Replacement password 821!',
                        });
                        return http.Response('{"success":true}', 200);
                      case '/api/mobile/email-auth/sign-in':
                        expectSync(body.keys.toSet(), {
                          'email',
                          'password',
                          'code_challenge',
                          'code_challenge_method',
                        });
                        expectSync(body['code_challenge_method'], 'S256');
                        challenge = body['code_challenge'] as String;
                        expectSync(challenge, hasLength(43));
                        if (!verified) {
                          return http.Response(
                            '{"verification_required":true}',
                            200,
                          );
                        }
                        return http.Response(
                          flow == 'two-factor'
                              ? '{"two_factor_required":true,"challenge":"factor-challenge"}'
                              : '{"code":"email-code"}',
                          200,
                        );
                      case '/api/mobile/two-factor/verify':
                        expectSync(body['challenge'], 'factor-challenge');
                        expectSync(body['code'], 'backup-code-A9');
                        factorVerifier = body['code_verifier'] as String;
                        expectSync(
                          Pkce.deriveCodeChallenge(factorVerifier!),
                          challenge,
                        );
                        return http.Response('{"code":"factor-code"}', 200);
                      case '/api/mobile/oauth-token':
                        expectSync(
                          body['code'],
                          flow == 'two-factor' ? 'factor-code' : 'email-code',
                        );
                        final verifier = body['code_verifier'] as String;
                        expectSync(
                          Pkce.deriveCodeChallenge(verifier),
                          challenge,
                        );
                        if (factorVerifier != null) {
                          expectSync(verifier, factorVerifier);
                        }
                        return http.Response(
                          jsonEncode({
                            'token': 'email-token',
                            if (flow == 'two-factor')
                              'twoFactorProof': 'factor-proof',
                          }),
                          200,
                        );
                      case '/api/auth/get-session':
                        expectSync(
                          request.headers['authorization'],
                          'Bearer email-token',
                        );
                        if (flow == 'validation-failure') {
                          return http.Response('{}', 503);
                        }
                        return http.Response(
                          jsonEncode({
                            'user': {
                              'id': 'email-user',
                              'email': 'email@example.test',
                              'emailVerified': true,
                              'twoFactorEnabled': flow == 'two-factor',
                            },
                          }),
                          200,
                        );
                      default:
                        throw StateError(
                          'Unexpected auth request: ${request.url.path}',
                        );
                    }
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
                home: ListenableBuilder(
                  listenable: auth,
                  builder: (_, _) => auth.status == AuthStatus.twoFactorPending
                      ? const TwoFactorScreen()
                      : const SignInScreen(),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final entry = find.text('Continue with email');
          await tester.ensureVisible(entry);
          await tester.tap(entry);
          await tester.pumpAndSettle();
          if (flow == 'verification') {
            await tester.tap(find.text('Create an account'));
            await tester.pumpAndSettle();
          } else if (flow == 'reset') {
            await tester.tap(find.text('Forgot password?'));
            await tester.pumpAndSettle();
          }
          await tester.enterText(
            find.byKey(const Key('emailAddress')),
            'email@example.test',
          );
          if (flow != 'reset') {
            await tester.enterText(
              find.byKey(const Key('emailPassword')),
              'A local password 832!',
            );
          }
          await tester.ensureVisible(find.byKey(const Key('emailSubmit')));
          await tester.tap(find.byKey(const Key('emailSubmit')));
          await tester.pumpAndSettle();
          if (flow == 'verification' ||
              flow == 'pending-signin' ||
              flow == 'reset') {
            expect(store.currentToken, isNull);
            await tester.enterText(
              find.byKey(const Key('emailCode')),
              '012345',
            );
            await tester.pumpAndSettle();
            if (flow == 'reset') {
              expect(
                requests.any((r) => r.url.path.endsWith('/reset-password')),
                isFalse,
              );
              await tester.enterText(
                find.byKey(const Key('emailNewPassword')),
                'Replacement password 821!',
              );
              await tester.ensureVisible(find.byKey(const Key('emailSubmit')));
              await tester.tap(find.byKey(const Key('emailSubmit')));
              await tester.pumpAndSettle();
            }
          }
          if (flow == 'two-factor') {
            expect(store.currentToken, isNull);
            expect(auth.status, AuthStatus.twoFactorPending);
            await tester.enterText(find.byType(TextField), 'backup-code-A9');
            await tester.tap(find.text('Verify'));
            await tester.pumpAndSettle();
            expect(store.currentTwoFactorProof, 'factor-proof');
          }
          if (flow == 'verification' || flow == 'pending-signin') {
            expect(
              jsonDecode(
                requests
                    .singleWhere(
                      (request) => request.url.path.endsWith('/verify-email'),
                    )
                    .body,
              ),
              {'email': 'email@example.test', 'otp': '012345'},
            );
          }
          expect(
            auth.status,
            flow == 'validation-failure'
                ? AuthStatus.validationFailed
                : AuthStatus.authenticated,
          );
          expect(store.currentToken, 'email-token');
          expect(
            requests.where((r) => r.url.path == '/api/mobile/oauth-token'),
            hasLength(1),
          );
          expect(tester.takeException(), isNull);
        },
      );
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
