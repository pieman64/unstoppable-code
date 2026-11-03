import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/chat/views/chat_draft_store_scope.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_cloud_chat_repository.dart';

final class _CountingStore extends ChatDraftStateStore {
  int flushes = 0;

  @override
  Future<bool> flush() async {
    flushes++;
    return true;
  }
}

/// Signs in as the user whose id is the email's local part.
final class _AccountsAuthRepository implements AuthRepository {
  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => AuthSession(
    token: 'token-$email',
    user: AuthUser(
      id: email.split('@').first,
      email: email,
      emailVerified: true,
      name: 'Test',
      image: null,
      role: 'DEVELOPER',
      status: 'ACTIVE',
      twoFactorEnabled: false,
      createdAt: '',
      updatedAt: '',
    ),
  );

  @override
  Future<void> signOut() async {}

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) =>
      throw UnimplementedError();

  @override
  Future<SocialSignInResult?> signInWithApple() => throw UnimplementedError();

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) => throw UnimplementedError();
}

void main() {
  late AuthViewModel auth;
  late CloudChatViewModel cloud;

  setUp(() {
    auth = AuthViewModel(repository: _AccountsAuthRepository());
    cloud = CloudChatViewModel(
      repository: FakeCloudChatRepository(workspaces: [sampleWorkspace()]),
      openStream: (_, {after}) => const Stream.empty(),
      observeLifecycle: false,
    );
  });

  tearDown(() {
    cloud.dispose();
    auth.dispose();
  });

  String scopeOf(String userId) => '${AppConfig.environment.name}:$userId';

  Widget subject({
    required Future<ChatDraftStore> Function(String accountScope) open,
    Widget home = const SizedBox(),
    FutureOr<void> Function(
      ({ChatDraftStore store, String scope}) previous,
      ({ChatDraftStore store, String scope}) next,
    )?
    onHandOff,
  }) => MultiProvider(
    providers: [
      ChangeNotifierProvider<AuthViewModel>.value(value: auth),
      ChangeNotifierProvider<CloudChatViewModel>.value(value: cloud),
    ],
    child: ChatDraftStoreScope(
      account: auth,
      accountScope: () {
        final userId = auth.status == AuthStatus.authenticated
            ? auth.user?.id
            : null;
        return userId == null ? null : scopeOf(userId);
      },
      open: open,
      onAttach: cloud.attachDraftStore,
      onDetach: cloud.detachDraftStore,
      onHandOff: onHandOff,
      child: MaterialApp(home: home),
    ),
  );

  ChatDraftStore? storeAt(WidgetTester tester, Finder finder) =>
      maybeChatDraftStore(tester.element(finder));

  testWidgets('opens the signed-in account store for pushed routes too', (
    tester,
  ) async {
    final store = _CountingStore();
    final opened = <String>[];
    ChatDraftStore? pushed;
    await tester.pumpWidget(
      subject(
        open: (scope) async {
          opened.add(scope);
          return store;
        },
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (context) {
                  pushed = maybeChatDraftStore(context);
                  return const Text('pushed');
                },
              ),
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    );
    expect(storeAt(tester, find.text('Open')), isNull);
    expect(opened, isEmpty);

    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(opened, [scopeOf('user-a')]);
    expect(storeAt(tester, find.text('Open')), same(store));

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('pushed'), findsOneWidget);
    expect(pushed, same(store));
  });

  testWidgets('an account change detaches the old store and opens another', (
    tester,
  ) async {
    final stores = {'user-a': _CountingStore(), 'user-b': _CountingStore()};
    await tester.pumpWidget(
      subject(open: (scope) async => stores[scope.split(':').last]!),
    );
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), same(stores['user-a']));

    await auth.signOut();
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), isNull);
    expect(stores['user-a']!.flushes, greaterThanOrEqualTo(1));

    await auth.signIn(email: 'user-b@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), same(stores['user-b']));

    // The cloud session now mirrors its sends into the new account's store
    // only.
    cloud.open('chat-1', cursorEpoch: 'session-1');
    cloud.send(
      clientRequestId: 'r1',
      payload: const CloudSendPayload(text: 'hello'),
    );
    expect(stores['user-b']!.unsentFor('cloud'), hasLength(1));
    expect(stores['user-a']!.unsentFor('cloud'), isEmpty);
    cloud.close();
  });

  // CAN-2872: a guest's drafts follow them into the account they sign in to,
  // including through the signed-out gap of two-factor entry.
  testWidgets('hands the previous store to the next before it attaches', (
    tester,
  ) async {
    final stores = {'user-a': _CountingStore(), 'user-b': _CountingStore()};
    final handOffs = <(String, String, bool)>[];
    await tester.pumpWidget(
      subject(
        open: (scope) async => stores[scope.split(':').last]!,
        onHandOff: (previous, next) {
          handOffs.add((
            previous.scope,
            next.scope,
            identical(previous.store, stores['user-a']) &&
                identical(next.store, stores['user-b']),
          ));
        },
      ),
    );
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(handOffs, isEmpty);

    await auth.signOut();
    await tester.pumpAndSettle();
    final flushesBefore = stores['user-a']!.flushes;
    await auth.signIn(email: 'user-b@example.com', password: 'pw');
    await tester.pumpAndSettle();

    expect(handOffs, [(scopeOf('user-a'), scopeOf('user-b'), true)]);
    expect(stores['user-a']!.flushes, flushesBefore + 1);
    expect(storeAt(tester, find.byType(SizedBox)), same(stores['user-b']));
  });

  testWidgets('awaits adoption and ignores an account that left during it', (
    tester,
  ) async {
    final pending = Completer<void>();
    final stores = {
      'user-a': _CountingStore(),
      'user-b': _CountingStore(),
      'user-c': _CountingStore(),
    };
    await tester.pumpWidget(
      subject(
        open: (scope) async => stores[scope.split(':').last]!,
        onHandOff: (_, _) => pending.future,
      ),
    );
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pumpAndSettle();
    await auth.signIn(email: 'user-b@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), isNull);
    await auth.signIn(email: 'user-c@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), same(stores['user-c']));
    pending.complete();
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), same(stores['user-c']));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failing hand-off still attaches the next store', (
    tester,
  ) async {
    final stores = {'user-a': _CountingStore(), 'user-b': _CountingStore()};
    await tester.pumpWidget(
      subject(
        open: (scope) async => stores[scope.split(':').last]!,
        onHandOff: (_, _) => throw StateError('hand-off failed'),
      ),
    );
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pumpAndSettle();
    await auth.signIn(email: 'user-b@example.com', password: 'pw');
    await tester.pumpAndSettle();

    expect(storeAt(tester, find.byType(SizedBox)), same(stores['user-b']));
  });

  testWidgets('a store that opens after its account left is not used', (
    tester,
  ) async {
    final slow = Completer<ChatDraftStore>();
    final fast = _CountingStore();
    await tester.pumpWidget(
      subject(
        open: (scope) =>
            scope.endsWith('user-a') ? slow.future : Future.value(fast),
      ),
    );
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pump();
    await auth.signOut();
    await auth.signIn(email: 'user-b@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), same(fast));

    final late = _CountingStore();
    slow.complete(late);
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), same(fast));
    expect(late.flushes, 1);
  });

  testWidgets('falls back to an in-memory store when opening fails', (
    tester,
  ) async {
    await tester.pumpWidget(
      subject(open: (_) async => throw const FileSystemExceptionStub()),
    );
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pumpAndSettle();
    expect(
      storeAt(tester, find.byType(SizedBox)),
      isA<InMemoryChatDraftStore>(),
    );
  });

  testWidgets('falls back to an in-memory store when opening hangs', (
    tester,
  ) async {
    final hung = Completer<ChatDraftStore>();
    await tester.pumpWidget(subject(open: (_) => hung.future));
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pump();
    expect(storeAt(tester, find.byType(SizedBox)), isNull);

    await tester.pump(const Duration(seconds: 3));
    final fallback = storeAt(tester, find.byType(SizedBox));
    expect(fallback, isA<InMemoryChatDraftStore>());

    // A store that opens after the timeout is flushed and never used.
    final late = _CountingStore();
    hung.complete(late);
    await tester.pumpAndSettle();
    expect(storeAt(tester, find.byType(SizedBox)), same(fallback));
    expect(late.flushes, 1);
  });

  testWidgets('flushes when the app goes inactive', (tester) async {
    final store = _CountingStore();
    await tester.pumpWidget(subject(open: (_) async => store));
    await auth.signIn(email: 'user-a@example.com', password: 'pw');
    await tester.pumpAndSettle();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    expect(store.flushes, 1);
  });

  testWidgets('maybeChatDraftStore is null without a holder', (tester) async {
    ChatDraftStore? seen = InMemoryChatDraftStore();
    await tester.pumpWidget(
      Builder(
        builder: (context) {
          seen = maybeChatDraftStore(context);
          return const SizedBox();
        },
      ),
    );
    expect(seen, isNull);
  });
}

final class FileSystemExceptionStub implements Exception {
  const FileSystemExceptionStub();
}
