import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_scope.dart';
import 'package:provider/provider.dart';
import '../../../../support/conversation_v2_fixtures.dart';
import '../../../../support/fake_cloud_chat_repository.dart';
import '../view_models/cloud_chat_test_support.dart'
    show FakeRepository, idle, accepted;

void main() {
  testWidgets(
    'root pushed route reads the same model; sign-out clears pending state',
    (tester) async {
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
      );
      final repository = FakeRepository();
      late CloudChatViewModel model;
      CloudChatViewModel? pushed;
      unawaited(auth.signIn(email: 'test@example.com', password: 'password'));
      await tester.pumpWidget(
        ChangeNotifierProvider<AuthViewModel>.value(
          value: auth,
          child: CloudChatScope(
            create: () => (
              session: model = CloudChatViewModel(
                repository: repository,
                openStream: (_, {after}) => const Stream.empty(),
              ),
              list: CloudChatsViewModel(repository: repository),
            ),
            child: MaterialApp(
              home: Builder(
                builder: (context) => TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (context) {
                        pushed = context.read<CloudChatViewModel>();
                        return const Scaffold(body: Text('Cloud route'));
                      },
                    ),
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      model.open('chat', cursorEpoch: 'epoch');
      model.send(
        clientRequestId: 'request',
        payload: const CloudSendPayload(text: 'hello'),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(pushed, same(model));
      expect(model.state!.outbox.length, 1);
      unawaited(auth.signOut());
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();
      expect(model.state, isNull);
      repository.bootstraps.single.complete(idle);
      await tester.pump();
      expect(model.state, isNull);
      expect(repository.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
      expect(model.isDisposed, isTrue);
      auth.dispose();
    },
  );

  testWidgets(
    'scope provides the list model to pushed routes and resets it on sign-out',
    (tester) async {
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
      );
      final repository = FakeCloudChatRepository(
        workspaces: [sampleWorkspace()],
      );
      late CloudChatsViewModel list;
      CloudChatsViewModel? pushed;
      unawaited(auth.signIn(email: 'test@example.com', password: 'password'));
      await tester.pumpWidget(
        ChangeNotifierProvider<AuthViewModel>.value(
          value: auth,
          child: CloudChatScope(
            create: () => (
              session: CloudChatViewModel(
                repository: repository,
                openStream: (_, {after}) => const Stream.empty(),
              ),
              list: list = CloudChatsViewModel(repository: repository),
            ),
            child: MaterialApp(
              home: Builder(
                builder: (context) => TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (context) {
                        pushed = context.read<CloudChatsViewModel>();
                        return const Scaffold(body: Text('Cloud route'));
                      },
                    ),
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await list.load();
      expect(list.cloudAvailable, isTrue);
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(pushed, same(list));
      unawaited(auth.signOut());
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();
      expect(list.workspaces, isEmpty);
      expect(list.cloudAvailable, isNull);
      await tester.pumpWidget(const SizedBox());
      expect(list.isDisposed, isTrue);
      auth.dispose();
    },
  );

  testWidgets('cloud 401 triggers one authoritative session check', (
    tester,
  ) async {
    final authRepository = _CountingAuthRepository();
    final auth = AuthViewModel(repository: authRepository);
    await auth.signIn(email: 'test@example.com', password: 'password');
    final repository = FakeCloudChatRepository()
      ..listError = const CloudApiException(
        statusCode: 401,
        message: 'Authentication required',
      );
    late CloudChatsViewModel list;

    await tester.pumpWidget(
      ChangeNotifierProvider<AuthViewModel>.value(
        value: auth,
        child: CloudChatScope(
          create: () => (
            session: CloudChatViewModel(
              repository: repository,
              openStream: (_, {after}) => const Stream.empty(),
            ),
            list: list = CloudChatsViewModel(repository: repository),
          ),
          child: const MaterialApp(home: SizedBox()),
        ),
      ),
    );

    await list.load();
    await tester.pump();

    expect(authRepository.restoreCalls, 1);
    expect(auth.status, AuthStatus.authenticated);

    await tester.pumpWidget(const SizedBox());
    auth.dispose();
  });

  testWidgets('chat bootstrap 401 triggers authoritative session check', (
    tester,
  ) async {
    final authRepository = _CountingAuthRepository();
    final auth = AuthViewModel(repository: authRepository);
    await auth.signIn(email: 'test@example.com', password: 'password');
    final repository = FakeCloudChatRepository()
      ..bootstrapErrors['chat-1'] = const CloudApiException(
        statusCode: 401,
        message: 'Authentication required',
      );
    late CloudChatViewModel session;

    await tester.pumpWidget(
      ChangeNotifierProvider<AuthViewModel>.value(
        value: auth,
        child: CloudChatScope(
          create: () => (
            session: session = CloudChatViewModel(
              repository: repository,
              openStream: (_, {after}) => const Stream.empty(),
            ),
            list: CloudChatsViewModel(repository: repository),
          ),
          child: const MaterialApp(home: SizedBox()),
        ),
      ),
    );

    session.open('chat-1', cursorEpoch: 'session-1');
    await tester.pump();
    await tester.pump();

    expect(authRepository.restoreCalls, 1);
    expect(auth.status, AuthStatus.authenticated);

    await tester.pumpWidget(const SizedBox());
    auth.dispose();
  });

  testWidgets('model-selection 403 triggers authoritative session check', (
    tester,
  ) async {
    final authRepository = _CountingAuthRepository();
    final auth = AuthViewModel(repository: authRepository);
    await auth.signIn(email: 'test@example.com', password: 'password');
    final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()])
      ..setModelError = const CloudApiException(
        statusCode: 403,
        message: 'Model policy rejected the session',
      );
    late CloudChatsViewModel list;

    await tester.pumpWidget(
      ChangeNotifierProvider<AuthViewModel>.value(
        value: auth,
        child: CloudChatScope(
          create: () => (
            session: CloudChatViewModel(
              repository: repository,
              openStream: (_, {after}) => const Stream.empty(),
            ),
            list: list = CloudChatsViewModel(repository: repository),
          ),
          child: const MaterialApp(home: SizedBox()),
        ),
      ),
    );
    await list.load();

    await expectLater(
      list.setModel('chat-1', 'claude-opus-5'),
      throwsA(isA<CloudApiException>()),
    );
    await tester.pump();

    expect(authRepository.restoreCalls, 1);
    expect(auth.status, AuthStatus.authenticated);

    await tester.pumpWidget(const SizedBox());
    auth.dispose();
  });

  testWidgets(
    'app lifecycle observer reconciles before resuming backgrounded sends',
    (tester) async {
      final repository = FakeRepository();
      // Lifecycle dispatch itself is tested here; cursor and transport behavior
      // use the typed fake stream in the view-model suite.
      final model = CloudChatViewModel(
        repository: repository,
        openStream: (_, {after}) => const Stream.empty(),
      );
      model.open('chat', cursorEpoch: 'epoch');
      await tester.pump(); // Discovery binds before the history request.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      repository.bootstraps.last.complete(idle);
      await tester.pump();
      model.send(
        clientRequestId: 'a',
        payload: const CloudSendPayload(text: 'hello'),
      );
      expect(repository.posts, isEmpty);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(repository.bootstraps.length, 2);
      expect(repository.posts, isEmpty);
      repository.bootstraps.last.complete(idle);
      await tester.pump();
      expect(repository.posts.length, 1);
      model.dispose();
      repository.posts.single.result.complete(accepted('a'));
      await tester.pump();
    },
  );

  group('an accepted turn copies the saved model mode into the list', () {
    final autoChat = sampleWorkspace(
      chats: [copyChat(sampleChat(), modelAuto: true)],
    );

    Future<CloudChatsViewModel> pumpScope(
      WidgetTester tester, {
      required CloudChatRepository session,
      required CloudChatRepository list,
      required void Function(CloudChatViewModel) onSession,
      CloudStreamOpener? openStream,
    }) async {
      final auth = AuthViewModel(repository: _CountingAuthRepository());
      addTearDown(auth.dispose);
      await auth.signIn(email: 'test@example.com', password: 'password');
      late CloudChatsViewModel listModel;
      await tester.pumpWidget(
        ChangeNotifierProvider<AuthViewModel>.value(
          value: auth,
          child: CloudChatScope(
            create: () {
              final model = CloudChatViewModel(
                repository: session,
                // An open stream keeps the conversation attached.
                openStream:
                    openStream ??
                    (_, {after}) => StreamController<Never>().stream,
                observeLifecycle: false,
              );
              onSession(model);
              return (
                session: model,
                list: listModel = CloudChatsViewModel(repository: list),
              );
            },
            child: const MaterialApp(home: SizedBox()),
          ),
        ),
      );
      await listModel.load();
      return listModel;
    }

    testWidgets('from a message response', (tester) async {
      final repository = FakeRepository();
      late CloudChatViewModel model;
      final list = await pumpScope(
        tester,
        session: repository,
        list: FakeCloudChatRepository(workspaces: [autoChat]),
        onSession: (value) => model = value,
      );
      model.open('chat-1', cursorEpoch: 'old-epoch');
      await tester.pump();
      repository.bootstraps.single.complete(idle);
      await tester.pump();
      model.send(
        clientRequestId: 'r1',
        payload: const CloudSendPayload(text: 'hello'),
      );
      await tester.pump();
      repository.posts.single.result.complete(
        PostTurnResult.fromJson({
          'message': {
            'id': 'user-r1',
            'clientRequestId': 'r1',
            'role': 'USER',
            'text': 'hello',
            'cost': {'kind': 'pending'},
            'costBilledViaLlmProxy': false,
            'createdAtMs': 100,
            'artifacts': <Object>[],
          },
          'replayed': false,
          'streamAfter': '10',
          'modelDefinitionId': 'claude-opus-5',
          'modelSelectionMode': 'manual',
        }),
      );
      await tester.pump();

      expect(list.chatById('chat-1')?.modelAuto, isFalse);
      expect(list.chatById('chat-1')?.modelDefinitionId, 'claude-opus-5');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('from a conversation turn', (tester) async {
      final repository = FakeCloudChatRepository(workspaces: [autoChat])
        ..conversation = v2Snapshot()
        ..acceptedTurnFields = {
          'modelDefinitionId': 'claude-opus-5',
          'modelSelectionMode': 'manual',
        };
      late CloudChatViewModel model;
      final list = await pumpScope(
        tester,
        session: repository,
        list: repository,
        onSession: (value) => model = value,
      );
      model.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump(const Duration(milliseconds: 400));
      model.send(
        clientRequestId: 'r1',
        payload: const CloudSendPayload(text: 'hello'),
      );
      await tester.pump(const Duration(milliseconds: 400));

      expect(repository.conversationSends, hasLength(1));
      expect(list.chatById('chat-1')?.modelAuto, isFalse);
      expect(list.chatById('chat-1')?.modelDefinitionId, 'claude-opus-5');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('from a conversation turn the stream already settled', (
      tester,
    ) async {
      final repository = FakeCloudChatRepository(workspaces: [autoChat])
        ..conversation = v2Snapshot()
        ..conversationSendCompleter = Completer<void>()
        ..acceptedTurnFields = {
          'modelDefinitionId': 'claude-opus-5',
          'modelSelectionMode': 'manual',
        };
      final stream = StreamController<CloudSseFrame>(sync: true);
      addTearDown(stream.close);
      late CloudChatViewModel model;
      final list = await pumpScope(
        tester,
        session: repository,
        list: repository,
        onSession: (value) => model = value,
        openStream: (_, {after}) => stream.stream,
      );
      model.open('chat-1', cursorEpoch: 'session-1');
      await tester.pump(const Duration(milliseconds: 400));
      model.send(
        clientRequestId: 'r1',
        payload: const CloudSendPayload(text: 'hello'),
      );
      await tester.pump();
      stream.add(
        CloudSseFrame(
          event: 'conversation.changed',
          id: 'opaque/1',
          data: jsonEncode({
            'protocolVersion': 2,
            'sessionId': 'session-1',
            'previousStateVersion': '0',
            'stateVersion': '1',
            'changes': [
              {'type': 'message.upsert', 'message': v2Message(id: 'user-r1')},
              {'type': 'turn.upsert', 'turn': v2Turn(status: 'COMPLETED')},
            ],
          }),
        ),
      );
      await tester.pump();
      expect(model.state!.outbox, isEmpty);
      repository.conversationSendCompleter!.complete();
      await tester.pump();

      expect(list.chatById('chat-1')?.modelAuto, isFalse);
      expect(list.chatById('chat-1')?.modelDefinitionId, 'claude-opus-5');
      await tester.pumpWidget(const SizedBox());
    });
  });
}

final class _CountingAuthRepository implements AuthRepository {
  AuthSession? _session = const AuthSession(
    token: 'token',
    user: AuthUser(
      id: 'user-1',
      email: 'test@example.com',
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
  int restoreCalls = 0;

  @override
  Future<AuthSession?> restoreSession() {
    restoreCalls++;
    return Future.value(_session);
  }

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) => Future.value(_session!);

  @override
  Future<void> signOut() async => _session = null;

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
