import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/oauth_authenticator.dart';
import 'package:mobile/data/services/session_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/sign_in_screen.dart';

void main() {
  group('SignInScreen', () {
    Widget buildSubject({
      Duration latency = const Duration(milliseconds: 50),
      ThemeData? theme,
      double textScale = 1,
    }) {
      return ChangeNotifierProvider<AuthViewModel>(
        create: (_) =>
            AuthViewModel(repository: MockAuthRepository(latency: latency)),
        child: MaterialApp(
          theme: theme ?? AppTheme.light,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: const SignInScreen(),
        ),
      );
    }

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
    // Defensive backstop: each test that sets debugDefaultTargetPlatformOverride
    // resets it itself in a try/finally (Flutter's invariant checker runs the
    // moment the test body returns, before this tearDown would fire), but this
    // still guards against a future test that forgets to.
    tearDown(() => debugDefaultTargetPlatformOverride = null);

    Future<void> revealReviewerForm(WidgetTester tester) async {
      for (var i = 0; i < DemoMode.activationTapCount; i++) {
        await tester.tap(find.byKey(const Key('signInLogo')));
        await tester.pump();
      }
      await tester.pumpAndSettle();
    }

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

    for (final platform in [TargetPlatform.iOS, TargetPlatform.android]) {
      testWidgets(
        'Unstoppable fits a small ${platform.name} screen with large text',
        (tester) async {
          debugDefaultTargetPlatformOverride = platform;
          try {
            tester.view.physicalSize = const Size(320, 568);
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.reset);
            await tester.pumpWidget(
              ChangeNotifierProvider<AuthViewModel>(
                create: (_) => AuthViewModel(repository: MockAuthRepository()),
                child: MaterialApp(
                  theme: AppTheme.light,
                  builder: (context, child) => MediaQuery(
                    data: MediaQuery.of(
                      context,
                    ).copyWith(textScaler: TextScaler.linear(1.5)),
                    child: child!,
                  ),
                  home: const SignInScreen(),
                ),
              ),
            );
            await tester.pumpAndSettle();
            final button = find.byKey(const Key('signInUnstoppable'));
            await tester.ensureVisible(button);
            expect(button.hitTestable(), findsOneWidget);
            expect(tester.takeException(), isNull);
          } finally {
            debugDefaultTargetPlatformOverride = null;
          }
        },
      );
    }

    testWidgets('renders Google + GitHub buttons and no password form', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(
        find.widgetWithText(FilledButton, 'Continue with Google'),
        findsOneWidget,
      );
      expect(
        find.widgetWithText(FilledButton, 'Continue with GitHub'),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('welcomes new users as well as returning ones', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Sign in or create an account'), findsOneWidget);
      expect(
        find.text(
          "Your agents run in the cloud, so you don't need a computer.",
        ),
        findsOneWidget,
      );
      expect(
        find.text(
          'New to ${Brand.displayName}? Continuing creates your account.',
        ),
        findsOneWidget,
      );
      expect(
        find.text('Access your organization activity and stats.'),
        findsNothing,
      );
    });

    for (final (name, theme) in [
      ('light', AppTheme.light),
      ('dark', AppTheme.dark),
    ]) {
      testWidgets('the welcome fits a phone at large text in $name theme', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(390 * 3, 844 * 3);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildSubject(theme: theme, textScale: 2));
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        expect(find.text('Sign in or create an account'), findsOneWidget);
      });
    }

    testWidgets('shows a spinner while a social sign-in is in flight', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(latency: const Duration(milliseconds: 200)),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.widgetWithText(FilledButton, 'Continue with Google'),
      );
      await tester.pump(); // begin the async flow without settling it

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle(); // drain the mock timer
    });

    testWidgets('logo taps do not activate reviewer mode while signing in', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(latency: const Duration(milliseconds: 200)),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.widgetWithText(FilledButton, 'Continue with Google'),
      );
      await tester.pump(); // begin the async flow without settling it

      for (var i = 0; i < DemoMode.activationTapCount; i++) {
        await tester.tap(find.byKey(const Key('signInLogo')));
        await tester.pump();
      }

      expect(DemoMode.enabled.value, isFalse);
      expect(find.byKey(const Key('reviewerEmailField')), findsNothing);

      await tester.pumpAndSettle(); // drain the mock timer
    });

    testWidgets(
      'tapping the logo 5x reveals the reviewer email/password form',
      (tester) async {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();
        expect(find.byType(TextField), findsNothing);

        await revealReviewerForm(tester);

        expect(find.byKey(const Key('reviewerEmailField')), findsOneWidget);
        expect(find.byKey(const Key('reviewerPasswordField')), findsOneWidget);
        // The OAuth buttons are replaced by the reviewer form.
        expect(
          find.widgetWithText(FilledButton, 'Continue with Google'),
          findsNothing,
        );
      },
    );

    testWidgets('semantic logo taps reveal the reviewer form', (tester) async {
      final semantics = tester.ensureSemantics();
      try {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        final logo = find.semantics.byLabel('Sign-in logo');
        for (var i = 0; i < DemoMode.activationTapCount; i++) {
          tester.semantics.tap(logo);
          await tester.pump();
        }
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('reviewerEmailField')), findsOneWidget);
        expect(find.byKey(const Key('reviewerPasswordField')), findsOneWidget);
      } finally {
        semantics.dispose();
      }
    });

    testWidgets('fewer than 5 taps does not reveal the form', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      for (var i = 0; i < DemoMode.activationTapCount - 1; i++) {
        await tester.tap(find.byKey(const Key('signInLogo')));
        await tester.pump();
      }
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsNothing);
    });

    // The logo target must be hit-testable on the very first frame. `Image.asset`
    // resolves asynchronously, so a height-only image reports a zero-width box
    // until the PNG decodes — and a zero-width box fails hit-testing outright,
    // which silently swallowed every gesture aimed at the logo.
    testWidgets('the logo touch target is sized before the image decodes', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pump(); // one frame only: the asset has NOT decoded yet

      final size = tester.getSize(find.byKey(const Key('signInLogo')));
      expect(size.width, greaterThan(0));
      expect(
        size.width,
        SignInScreen.logoSize + SignInScreen.logoTouchPadding * 2,
      );
      expect(
        size.height,
        SignInScreen.logoSize + SignInScreen.logoTouchPadding * 2,
      );
    });

    // Regression: the picker used to run off a raw pointer timer that lived
    // outside the gesture arena, so a hold fired the picker *and* the tap
    // recognizer. Aborting a hold therefore counted as a logo tap, and five
    // abandoned hold attempts silently tripped the reviewer tap gesture
    // instead — which is what made the hold feel broken and unreachable.
    testWidgets('long-pressing the logo never counts as a reviewer tap', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final logo = find.byKey(const Key('signInLogo'));
      for (var i = 0; i < DemoMode.activationTapCount; i++) {
        final gesture = await tester.startGesture(tester.getCenter(logo));
        await tester.pump(
          SignInScreen.environmentPickerHoldDuration +
              const Duration(milliseconds: 50),
        );
        await gesture.up();
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('apiEnvironmentPicker')), findsOneWidget);
        Navigator.of(tester.element(logo)).pop();
        await tester.pumpAndSettle();
      }

      expect(DemoMode.enabled.value, isFalse);
      expect(find.byKey(const Key('reviewerEmailField')), findsNothing);
    });

    // A press that is too long to be a tap but too short to reach the hold
    // threshold must do nothing at all. Otherwise someone repeatedly reaching
    // for the hidden environment gesture and letting go early is silently
    // walked into the reviewer form instead.
    testWidgets('an abandoned hold does not count toward the reviewer taps', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final logo = find.byKey(const Key('signInLogo'));
      // Between maxReviewerTapDuration (400ms) and the 700ms hold threshold.
      const Duration abandonedHold = Duration(milliseconds: 500);
      expect(abandonedHold, greaterThan(SignInScreen.maxReviewerTapDuration));
      expect(
        abandonedHold,
        lessThan(SignInScreen.environmentPickerHoldDuration),
      );

      for (var i = 0; i < DemoMode.activationTapCount * 2; i++) {
        final gesture = await tester.startGesture(tester.getCenter(logo));
        await tester.pump(abandonedHold);
        await gesture.up();
        await tester.pumpAndSettle();
      }

      expect(DemoMode.enabled.value, isFalse);
      expect(find.byKey(const Key('reviewerEmailField')), findsNothing);
      expect(find.byKey(const Key('apiEnvironmentPicker')), findsNothing);
    });

    testWidgets('holding the logo opens the environment picker', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final logo = find.byKey(const Key('signInLogo'));
      final gesture = await tester.startGesture(tester.getCenter(logo));
      await tester.pump(
        SignInScreen.environmentPickerHoldDuration -
            const Duration(milliseconds: 1),
      );
      expect(find.byKey(const Key('apiEnvironmentPicker')), findsNothing);

      await tester.pump(const Duration(milliseconds: 1));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('apiEnvironmentPicker')), findsOneWidget);
      await gesture.up();

      await tester.tap(find.byKey(const Key('stagingEnvironmentOption')));
      await tester.pumpAndSettle();

      expect(AppConfig.environment, ApiEnvironment.staging);
      expect(find.byKey(const Key('stagingEnvironmentBadge')), findsOneWidget);
      expect(DemoMode.enabled.value, isFalse);
    });

    testWidgets(
      'debug-configured picker can switch from staging to production',
      (tester) async {
        AppConfig.configureEnvironmentController(
          ApiEnvironmentController(
            productionBaseUrl: 'https://production.test',
            stagingBaseUrl: 'https://staging.test',
            initialEnvironment: ApiEnvironment.staging,
            preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
          ),
        );
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        final logo = find.byKey(const Key('signInLogo'));
        final gesture = await tester.startGesture(tester.getCenter(logo));
        await tester.pump(SignInScreen.environmentPickerHoldDuration);
        await tester.pumpAndSettle();
        await gesture.up();

        expect(
          find.byKey(const Key('productionEnvironmentOption')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('stagingEnvironmentOption')),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const Key('productionEnvironmentOption')));
        await tester.pumpAndSettle();

        expect(AppConfig.environment, ApiEnvironment.production);
        expect(AppConfig.apiBaseUrl, 'https://production.test');
        expect(find.byKey(const Key('stagingEnvironmentBadge')), findsNothing);
      },
    );

    testWidgets('the reviewer form back button returns to OAuth-only', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();
      await revealReviewerForm(tester);
      expect(find.byKey(const Key('reviewerEmailField')), findsOneWidget);

      await tester.tap(find.byKey(const Key('reviewerBackButton')));
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsNothing);
      expect(
        find.widgetWithText(FilledButton, 'Continue with Google'),
        findsOneWidget,
      );
    });

    testWidgets('submitting the reviewer form starts an email sign-in', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(latency: const Duration(milliseconds: 200)),
      );
      await tester.pumpAndSettle();
      await revealReviewerForm(tester);

      await tester.enterText(
        find.byKey(const Key('reviewerEmailField')),
        'appreview@example.com',
      );
      await tester.enterText(
        find.byKey(const Key('reviewerPasswordField')),
        'password',
      );
      await tester.tap(find.byKey(const Key('reviewerSignInButton')));
      await tester.pump(); // begin the async sign-in without settling

      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle(); // drain the mock timer
    });

    testWidgets('reviewer form fits a phone-width viewport without overflow', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();
      await revealReviewerForm(tester);

      expect(tester.takeException(), isNull);
    });

    testWidgets('shows the Apple button on iOS', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      try {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('signInApple')), findsOneWidget);
      } finally {
        // Flutter's test-invariant checker asserts foundation debug vars are
        // back to default the moment this test body returns, which is before
        // any tearDown()/addTearDown() callback runs — so this must be reset
        // synchronously here (matching the Flutter SDK's own convention).
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('hides the Apple button on Android', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        expect(find.byKey(const Key('signInApple')), findsNothing);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('hides the Apple button in reviewer/demo mode on iOS', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      try {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();
        await revealReviewerForm(tester);

        expect(find.byKey(const Key('signInApple')), findsNothing);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('tapping the Apple button starts a sign-in', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      try {
        await tester.pumpWidget(
          buildSubject(latency: const Duration(milliseconds: 200)),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const Key('signInApple')));
        await tester.pump(); // begin the async flow without settling it

        expect(find.byType(CircularProgressIndicator), findsOneWidget);

        await tester.pumpAndSettle(); // drain the mock timer
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
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
