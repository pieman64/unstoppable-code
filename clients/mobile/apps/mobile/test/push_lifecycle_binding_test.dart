import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/device_registration.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/device_repository.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/main.dart';
import 'package:mobile/services/push_service.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:provider/provider.dart';

/// Counts outbox replays performed by the lifecycle binding.
final class _CountingTurnFeedbackRepository implements TurnFeedbackRepository {
  int flushOutboxCalls = 0;

  @override
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId) async =>
      const [];

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) async => const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1');

  @override
  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) async => const TurnFeedbackWriteResult(synced: true);

  @override
  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  }) async => const TurnFeedbackWriteResult(synced: true);

  @override
  Future<List<TurnFeedbackReplayedRating>> flushOutbox() async {
    flushOutboxCalls += 1;
    return const <TurnFeedbackReplayedRating>[];
  }
}

/// Covers the wiring that reconnects an app-lifecycle resume to
/// [PushService.onAppResumed], and the auth-transition wiring that keeps
/// [TurnFeedbackController] from leaking one account's cached ratings into
/// another. The retry rules themselves live in
/// `test/services/push_service_test.dart`; this file only proves the binding
/// actually delivers the resume/reset, which is the link that was missing
/// entirely.
void main() {
  late FakePushMessaging messaging;
  late MockDeviceRepository deviceRepository;
  late PushService pushService;
  late AuthViewModel auth;
  late TurnFeedbackController turnFeedbackController;
  late _CountingTurnFeedbackRepository turnFeedbackRepository;

  /// Builds the fakes and service and pumps the binding. Everything is
  /// constructed here, inside the testWidgets body, rather than in setUp:
  /// PushService's initial registration-queue future would otherwise be
  /// created outside the fake-async zone, and continuations chained onto it
  /// land on the real microtask loop, which testWidgets never drains.
  /// (MockDeviceRepository's default 400ms latency is a real timer with the
  /// same problem, hence Duration.zero; MockAuthRepository gets the same
  /// treatment for the same reason.)
  Future<void> pumpBinding(
    WidgetTester tester, {
    _GuestAuthRepository? guestRepository,
  }) async {
    messaging = FakePushMessaging(
      permissionResult: PushPermissionStatus.denied,
      token: 'tok',
    );
    deviceRepository = MockDeviceRepository(latency: Duration.zero);
    pushService = PushService(
      messaging: messaging,
      deviceRepository: deviceRepository,
      platform: DevicePlatform.ios,
      isPushConfigured: () => true,
      initialTokenRetryDelay: Duration.zero,
    );
    auth = AuthViewModel(
      repository: guestRepository ?? MockAuthRepository(latency: Duration.zero),
      guestSessions: guestRepository,
    );
    final notifications = NotificationsViewModel(
      repository: MockNotificationPreferencesRepository(),
      isConfigured: () => false,
    );
    turnFeedbackRepository = _CountingTurnFeedbackRepository();
    turnFeedbackController = TurnFeedbackController(
      repository: turnFeedbackRepository,
    );
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AuthViewModel>.value(value: auth),
          ChangeNotifierProvider<NotificationsViewModel>.value(
            value: notifications,
          ),
          Provider<PushService>.value(value: pushService),
          ChangeNotifierProvider<TurnFeedbackController>.value(
            value: turnFeedbackController,
          ),
        ],
        child: const MaterialApp(
          home: PushLifecycleBinding(child: SizedBox.shrink()),
        ),
      ),
    );
  }

  testWidgets('a resume registers a token granted while backgrounded', (
    tester,
  ) async {
    await pumpBinding(tester);
    // Sign-in happened while permission was still denied, so nothing
    // registered — the state a user lands in after declining the prompt.
    await pushService.onAuthenticated();
    expect(deviceRepository.registeredTokens, isEmpty);

    // Enabling notifications in OS settings backgrounds the app; coming
    // back is a paused -> resumed transition. (A bare `resumed` is also a
    // no-op dispatch in tests, since the binding already starts resumed.)
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    messaging.permissionResult = PushPermissionStatus.granted;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(deviceRepository.registeredTokens, ['tok']);
  });

  testWidgets('a resume does not register while signed out', (tester) async {
    await pumpBinding(tester);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    messaging.permissionResult = PushPermissionStatus.granted;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(deviceRepository.registeredTokens, isEmpty);
  });

  testWidgets('a resume flushes any turn feedback queued while offline', (
    tester,
  ) async {
    await pumpBinding(tester);
    expect(turnFeedbackRepository.flushOutboxCalls, 0);

    // A queued offline rating must not wait for the next cold start — every
    // foreground return should replay it.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(turnFeedbackRepository.flushOutboxCalls, 1);

    // And again on a second foreground return, not just the first.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(turnFeedbackRepository.flushOutboxCalls, 2);
  });

  testWidgets('signing back in flushes the outbox, without waiting for the '
      'next foreground resume', (tester) async {
    // A retryable 401 is the headline reason an entry is queued at all, so
    // the moment the user's session is restored is the natural drain point.
    // Relying on `didChangeAppLifecycleState(resumed)` alone leaves a
    // session-expired rating sitting unsent for as long as the app stays in
    // the foreground.
    await pumpBinding(tester);
    expect(turnFeedbackRepository.flushOutboxCalls, 0);

    await tester.runAsync(
      () => auth.signIn(email: 'account-a@example.com', password: 'password'),
    );
    await tester.pump();
    expect(auth.status, AuthStatus.authenticated);

    expect(turnFeedbackRepository.flushOutboxCalls, 1);
  });

  // CAN-2872: "Continue as guest" must not prompt for notification permission;
  // the guest's sign-in, which keeps the status at authenticated, is the
  // transition that registers push.
  testWidgets('a guest is not registered for push until they sign in', (
    tester,
  ) async {
    final repository = _GuestAuthRepository();
    await pumpBinding(tester, guestRepository: repository);

    await tester.runAsync(auth.continueAsGuest);
    await tester.pump();
    expect(auth.isGuest, isTrue);
    expect(messaging.requestPermissionCallCount, 0);
    expect(turnFeedbackRepository.flushOutboxCalls, 0);

    await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));
    await tester.pump();
    expect(auth.isGuest, isFalse);
    expect(auth.status, AuthStatus.authenticated);
    expect(messaging.requestPermissionCallCount, 1);
    expect(turnFeedbackRepository.flushOutboxCalls, 1);
  });

  testWidgets('a resume after disposal does not throw', (tester) async {
    await pumpBinding(tester);
    await pushService.onAuthenticated();

    await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    messaging.permissionResult = PushPermissionStatus.granted;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(deviceRepository.registeredTokens, isEmpty);
    expect(turnFeedbackRepository.flushOutboxCalls, 0);
  });

  testWidgets(
    'a sign-out clears locally rated turns before another account signs in',
    (tester) async {
      await pumpBinding(tester);
      await tester.runAsync(
        () => auth.signIn(email: 'account-a@example.com', password: 'password'),
      );
      await tester.pump();
      expect(auth.status, AuthStatus.authenticated);

      await tester.runAsync(
        () => turnFeedbackController.setRating(
          chatId: 'chat-1',
          clientUserMessageId: 'msg-1',
          rating: TurnFeedbackRating.up,
        ),
      );
      expect(
        turnFeedbackController.entryFor('chat-1', 'msg-1')?.rating,
        TurnFeedbackRating.up,
      );

      await tester.runAsync(() => auth.signOut());
      await tester.pump();
      expect(auth.status, AuthStatus.unauthenticated);
      expect(turnFeedbackController.entryFor('chat-1', 'msg-1'), isNull);

      await tester.runAsync(
        () => auth.signIn(email: 'account-b@example.com', password: 'password'),
      );
      await tester.pump();
      expect(auth.status, AuthStatus.authenticated);
      expect(turnFeedbackController.entryFor('chat-1', 'msg-1'), isNull);
    },
  );

  testWidgets('the signed-in account scope includes the API environment and is '
      'cleared on sign-out', (tester) async {
    ApiEnvironmentController environmentController(
      ApiEnvironment initialEnvironment,
    ) => ApiEnvironmentController(
      productionBaseUrl: 'https://production.test',
      stagingBaseUrl: 'https://staging.test',
      initialEnvironment: initialEnvironment,
      preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
    );
    AppConfig.configureEnvironmentController(
      environmentController(ApiEnvironment.production),
    );
    addTearDown(
      () => AppConfig.configureEnvironmentController(
        environmentController(ApiEnvironment.production),
      ),
    );
    await pumpBinding(tester);
    // Nothing signed in yet: the outbox must refuse to flush at all.
    expect(signedInAccountId, isNull);

    await tester.runAsync(
      () => auth.signIn(email: 'account-a@example.com', password: 'password'),
    );
    await tester.pump();
    expect(auth.status, AuthStatus.authenticated);
    // Environment is part of the durable identity: production user 7 and
    // staging user 7 are unrelated principals even though their numeric ids
    // happen to match.
    expect(signedInAccountId, 'production:${auth.user?.id}');
    expect(signedInAccountId, isNotNull);

    // Read the environment live rather than waiting for another auth
    // notification. ApiClient switches origins immediately too, so the replay
    // guard must change in the same instant.
    await AppConfig.selectEnvironment(ApiEnvironment.staging);
    expect(signedInAccountId, 'staging:${auth.user?.id}');

    await tester.runAsync(() => auth.signOut());
    await tester.pump();
    expect(auth.status, AuthStatus.unauthenticated);
    // Cleared, so a queued entry cannot go out under the next account.
    expect(signedInAccountId, isNull);
  });
}

AuthUser _pushTestUser(String id, {bool anonymous = false}) => AuthUser(
  id: id,
  email: '$id@example.com',
  emailVerified: !anonymous,
  name: id,
  image: null,
  role: 'DEVELOPER',
  status: 'ACTIVE',
  twoFactorEnabled: false,
  createdAt: '',
  updatedAt: '',
  isAnonymous: anonymous,
);

/// Starts a guest session, then signs in as a member.
final class _GuestAuthRepository
    implements AuthRepository, GuestSessionRepository {
  @override
  Future<bool> guestSessionAvailable() async => true;

  @override
  Future<AuthSession> continueAsGuest() async => AuthSession(
    token: 'guest-tok',
    user: _pushTestUser('guest', anonymous: true),
  );

  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => AuthSession(token: 'real-tok', user: _pushTestUser('member'));

  @override
  Future<void> signOut() async {}

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async =>
      SocialSignInSuccess(
        AuthSession(token: 'real-tok', user: _pushTestUser('member')),
      );

  @override
  Future<SocialSignInResult?> signInWithApple() =>
      signInWithSocial(SocialProvider.apple);

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async => AuthSession(token: 'real-tok', user: _pushTestUser('member'));
}
