import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/guest_draft_hand_off.dart'
    show adoptGuestDraftsOnSignIn;
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';

AuthUser _user(String id, {bool anonymous = false}) => AuthUser(
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

// CAN-2872: the app-level wiring between the draft scope's hand-off and the
// guest the session signed in from.
void main() {
  String scopeOf(String id) => '${AppConfig.environment.name}:$id';
  const chat = CloudChatDraftTarget('chat-1');

  Future<AuthViewModel> signedInFromGuest() async {
    final repo = _Repo();
    final auth = AuthViewModel(repository: repo, guestSessions: repo);
    await auth.continueAsGuest();
    await auth.signInWithSocial(SocialProvider.google);
    expect(auth.signedInFromGuestId, 'guest');
    return auth;
  }

  test('carries the guest drafts into the account it signed in to', () async {
    final auth = await signedInFromGuest();
    final guest = InMemoryChatDraftStore()..setDraft(chat, 'half a message');
    final account = InMemoryChatDraftStore();

    await adoptGuestDraftsOnSignIn(
      auth,
      (store: guest, scope: scopeOf('guest')),
      (store: account, scope: scopeOf('member')),
    );

    expect(account.draftFor(chat), 'half a message');
    expect(guest.draftFor(chat), 'half a message');
  });

  test('leaves any other account change alone', () async {
    final auth = await signedInFromGuest();
    final other = InMemoryChatDraftStore()..setDraft(chat, 'not a guest');
    final account = InMemoryChatDraftStore();

    await adoptGuestDraftsOnSignIn(
      auth,
      (store: other, scope: scopeOf('someone-else')),
      (store: account, scope: scopeOf('member')),
    );

    expect(account.draftFor(chat), '');
    expect(other.draftFor(chat), 'not a guest');
  });
}

final class _Repo implements AuthRepository, GuestSessionRepository {
  @override
  Future<bool> guestSessionAvailable() async => true;

  @override
  Future<AuthSession> continueAsGuest() async =>
      AuthSession(token: 'g', user: _user('guest', anonymous: true));

  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => AuthSession(token: 'm', user: _user('member'));

  @override
  Future<void> signOut() async {}

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async =>
      SocialSignInSuccess(AuthSession(token: 'm', user: _user('member')));

  @override
  Future<SocialSignInResult?> signInWithApple() =>
      signInWithSocial(SocialProvider.apple);

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async => AuthSession(token: 'm', user: _user('member'));
}
