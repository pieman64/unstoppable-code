import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/session_store.dart';
import 'package:mobile/main.dart';
import 'package:mobile/ui/core/launch_view.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

void main() {
  for (final resume in [false, true]) {
    testWidgets(
      'saved credentials recover via ${resume ? 'foreground' : 'retry'}',
      (tester) async {
        final store = InMemorySessionStore(initialToken: 'saved-token');
        var offline = true;
        var requests = 0;
        final authorizationHeaders = <String?>[];
        final auth = AuthViewModel(
          repository: HttpAuthRepository(
            sessionStore: store,
            service: AuthApiService(
              apiClient: ApiClient(
                baseUrl: 'https://api.test',
                tokenProvider: () => store.currentToken,
                httpClient: MockClient((request) async {
                  requests++;
                  authorizationHeaders.add(request.headers['Authorization']);
                  if (offline) throw http.ClientException('offline');
                  return http.Response('{"user":{"id":"1"}}', 200);
                }),
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
              home: Consumer<AuthViewModel>(
                builder: (context, value, child) =>
                    value.status == AuthStatus.authenticated
                    ? const Scaffold(body: Text('Session restored'))
                    : const AuthGate(),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('session-retry')), findsOneWidget);
        offline = false;
        if (resume) {
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.paused,
          );
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.resumed,
          );
        } else {
          await tester.tap(find.byKey(const ValueKey('session-retry')));
        }
        await tester.pumpAndSettle();
        expect(
          auth.status,
          AuthStatus.authenticated,
          reason: 'requests=$requests',
        );
        expect(find.text('Session restored'), findsOneWidget);
        expect(store.currentToken, 'saved-token');
        expect(requests, 2);
        expect(authorizationHeaders, everyElement('Bearer saved-token'));
      },
    );
  }

  testWidgets('offline startup retries saved session without sign-in', (
    tester,
  ) async {
    final store = InMemorySessionStore(initialToken: 'saved-token');
    var offline = true;
    final auth = AuthViewModel(
      repository: HttpAuthRepository(
        sessionStore: store,
        service: AuthApiService(
          apiClient: ApiClient(
            baseUrl: 'https://api.test',
            httpClient: MockClient((_) async {
              if (offline) throw http.ClientException('offline');
              return http.Response('null', 200);
            }),
          ),
        ),
      ),
    );
    addTearDown(auth.dispose);
    await auth.restore();
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: auth,
        child: const MaterialApp(home: AuthGate()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text("Couldn't verify your session"), findsOneWidget);
    expect(store.currentToken, 'saved-token');
    offline = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    // Only the authoritative null response now permits sign-in.
    expect(auth.status, AuthStatus.unauthenticated);
    expect(store.currentToken, isNull);
    expect(find.text("Couldn't verify your session"), findsNothing);
  });

  testWidgets('one startup 401 does not replace a valid session with sign-in', (
    tester,
  ) async {
    final store = InMemorySessionStore(initialToken: 'saved-token');
    var requests = 0;
    final auth = AuthViewModel(
      repository: HttpAuthRepository(
        sessionStore: store,
        service: AuthApiService(
          apiClient: ApiClient(
            baseUrl: 'https://api.test',
            tokenProvider: () => store.currentToken,
            httpClient: MockClient((_) async {
              requests += 1;
              if (requests == 1) return http.Response('null', 401);
              return http.Response('{"user":{"id":"1"}}', 200);
            }),
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
          home: Consumer<AuthViewModel>(
            builder: (context, value, child) =>
                value.status == AuthStatus.authenticated
                ? const Scaffold(body: Text('Session restored'))
                : const AuthGate(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(requests, 2);
    expect(auth.status, AuthStatus.authenticated);
    expect(store.currentToken, 'saved-token');
    expect(find.text('Session restored'), findsOneWidget);
    expect(find.text('Continue with Google'), findsNothing);
  });

  testWidgets('a signed-in account waits for its draft store to open', (
    tester,
  ) async {
    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    addTearDown(auth.dispose);
    final holder = ChatDraftStoreHolder();
    addTearDown(holder.dispose);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: auth),
          ChangeNotifierProvider.value(value: holder),
        ],
        child: const MaterialApp(home: AuthGate()),
      ),
    );
    unawaited(auth.signIn(email: 'test@example.com', password: 'password'));
    await tester.pump(const Duration(milliseconds: 10));
    await tester.pump();
    expect(auth.status, AuthStatus.authenticated);
    expect(find.byType(LaunchView), findsOneWidget);
  });
}
