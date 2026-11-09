import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/email_auth_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/workspace_context_store.dart';

/// Coarse authentication lifecycle used by the root auth gate.
enum AuthStatus {
  /// Startup: still checking for a persisted session.
  unknown,

  /// No valid session — show the sign-in screen.
  unauthenticated,

  /// Saved credentials could not be checked; offer recovery, not sign-in.
  validationFailed,

  /// A sign-in request is in flight.
  authenticating,

  /// OAuth completed but the account needs a second factor — show the TOTP
  /// entry screen.
  twoFactorPending,

  /// A valid session exists — show the app.
  authenticated,
}

/// Owns authentication state for the app and drives the root auth gate.
final class AuthViewModel extends ChangeNotifier {
  AuthViewModel({
    required this.repository,
    this.loadOrganizations,
    this.workspaceContextStore,
    this.beforeSignOut,
    this.sessionValidationTimeout = const Duration(seconds: 30),
    this.organizationLoadTimeout = const Duration(seconds: 30),
  });

  final AuthRepository repository;

  final Duration sessionValidationTimeout;
  int _authGeneration = 0;
  bool _restoring = false;
  bool _revalidatingAuthenticationFailure = false;
  bool _disposed = false;

  bool _isCurrent(int generation) =>
      !_disposed && generation == _authGeneration;

  @override
  void dispose() {
    _disposed = true;
    ++_authGeneration;
    ++_orgLoadGeneration;
    super.dispose();
  }

  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  /// Loads the signed-in user's team organizations and Personal organization
  /// id (real mode only); empty in mock mode, where the data screens ignore
  /// the org id. Loading never picks an organization; see [workspaceContext].
  final Future<AccountOrganizations> Function()? loadOrganizations;

  /// Saves each account's chosen [workspaceContext]; null keeps the choice in
  /// memory only.
  final WorkspaceContextStore? workspaceContextStore;

  /// Runs while the current bearer token is still available, before the auth
  /// repository clears its session.
  final Future<void> Function()? beforeSignOut;

  /// Upper bound on a single organization load.
  ///
  /// `ApiClient` sets no request timeout, so without this a stalled socket
  /// would leave [isLoadingOrganizations] true forever — and the retry
  /// affordance it hides is the only control on that screen.
  final Duration organizationLoadTimeout;

  AuthStatus _status = AuthStatus.unknown;
  AuthUser? _user;
  List<OrganizationSummary> _organizations = const [];
  String? _personalOrganizationId;
  String? _activeOrgId;

  /// The account whose saved context has been applied, so a later
  /// organization load keeps the live choice instead of re-reading it.
  String? _contextAccountId;
  Future<void> _contextWrites = Future.value();
  int _pendingContextWrites = 0;

  /// Counts accepted selections, so an older one can tell it was replaced.
  int _contextSelections = 0;
  bool _organizationsLoadFailed = false;
  bool _isLoadingOrganizations = false;
  int _orgLoadGeneration = 0;
  int? _lastOrgLoadStatusCode;
  String? _errorMessage;
  String? _pendingChallenge;
  String? _pendingVerifier;
  bool _emailEntryAvailable = false;
  int _emailEntryGeneration = 0;
  bool _upgradingGuest = false;

  /// Current lifecycle state.  Starts at [AuthStatus.unknown] until [restore].
  AuthStatus get status => _status;

  /// The signed-in user, or `null` when not authenticated.
  AuthUser? get user => _user;

  /// True while the session is a guest's (CAN-2872). A guest is
  /// [AuthStatus.authenticated] but has no organizations and no sign-in
  /// method; signing in from here keeps their chats.
  bool get isGuest => _user?.isAnonymous ?? false;

  /// True for a signed-in account, false for a guest or while signed out.
  /// Account-only services, such as push registration and notification
  /// preferences, follow this rather than [status].
  bool get hasAccount => _status == AuthStatus.authenticated && !isGuest;

  bool get emailEntryAvailable => _emailEntryAvailable;

  EmailAuthRepository? get emailAuthRepository => switch (repository) {
    final EmailAuthRepository emailRepository => emailRepository,
    _ => null,
  };

  Future<void> loadEmailEntry() async {
    if (_disposed) return;
    final generation = ++_emailEntryGeneration;
    final enabled = await emailAuthRepository?.emailAuthAvailable() ?? false;
    if (_disposed || generation != _emailEntryGeneration) return;
    _emailEntryAvailable = enabled;
    notifyListeners();
  }

  /// True while a sign-in is in flight: the signed-out flow, or a guest
  /// signing in, which stays [AuthStatus.authenticated] so the app behind the
  /// sign-in screen is kept.
  bool get isSigningIn =>
      _status == AuthStatus.authenticating || _upgradingGuest;

  /// The active organization id, or null in Personal and for accounts with
  /// no organization.
  String? get activeOrgId => _activeOrgId;

  /// The selected workspace context (CAN-4429). Personal unless the user
  /// chose an organization they still belong to; a fresh account starts in
  /// Personal, never in the first organization listed.
  WorkspaceContext get workspaceContext => switch (_activeOrgId) {
    null => const WorkspaceContext.personal(),
    final organizationId => WorkspaceContext.organization(organizationId),
  };

  /// The team organizations the signed-in user belongs to (empty in mock
  /// mode). Never includes the Personal organization.
  List<OrganizationSummary> get organizations => _organizations;

  /// The account's Personal organization id, or null when it has none.
  /// Personal Activity reads this organization's feed (CAN-3715); it is never
  /// the [activeOrgId].
  String? get personalOrganizationId => _personalOrganizationId;

  /// True when Personal is selected and the account has a Personal
  /// organization, so Activity shows the viewer's own work.
  bool get isPersonalActive =>
      _activeOrgId == null && _personalOrganizationId != null;

  /// The summary row for [activeOrgId], or null when there is no active org or
  /// its row has not loaded yet. Carries the org's name and the viewer's role,
  /// which is what org-scoped screens need to word a permission- or
  /// billing-dependent message.
  OrganizationSummary? get activeOrganization {
    final id = _activeOrgId;
    if (id == null) return null;
    for (final org in _organizations) {
      if (org.id == id) return org;
    }
    return null;
  }

  /// True when the most recent organization load threw, leaving membership
  /// unknown rather than known-empty.
  ///
  /// [activeOrgId] is null in both cases, but they are different situations: a
  /// genuine individual account has no organization, while a failed load may be
  /// hiding one. Callers must not offer to create an organization on this
  /// path — the user could end up with a duplicate of an org they already own.
  bool get organizationsLoadFailed => _organizationsLoadFailed;

  /// True while an organization load is in flight, so a retry affordance can
  /// show progress and refuse to stack duplicate requests.
  bool get isLoadingOrganizations => _isLoadingOrganizations;

  /// Human-readable message from the most recent failed [signIn], else `null`.
  String? get errorMessage => _errorMessage;

  /// Checks for a persisted session on startup.
  Future<void> restore() async {
    if (_restoring || _disposed) return;
    final generation = ++_authGeneration;
    _restoring = true;
    _status = AuthStatus.unknown;
    notifyListeners();
    try {
      final session = await repository.restoreSession().timeout(
        sessionValidationTimeout,
      );
      if (!_isCurrent(generation)) return;
      await _applySession(session);
    } catch (_) {
      if (!_isCurrent(generation)) return;
      _status = AuthStatus.validationFailed;
    } finally {
      if (_isCurrent(generation)) {
        _restoring = false;
        notifyListeners();
      }
    }
  }

  /// Drops the last sign-in error, so a screen opened later starts clean.
  void clearError() {
    if (_errorMessage == null) return;
    _errorMessage = null;
    notifyListeners();
  }

  /// Authenticates with email and password.
  Future<void> signIn({required String email, required String password}) async {
    final generation = ++_authGeneration;
    _status = AuthStatus.authenticating;
    _errorMessage = null;
    notifyListeners();
    try {
      final session = await repository.signIn(email: email, password: password);
      if (!_isCurrent(generation)) return;
      _user = session.user;
      await _loadOrgs();
      if (!_isCurrent(generation)) return;
      _status = AuthStatus.authenticated;
    } on SessionValidationException {
      if (!_isCurrent(generation)) return;
      _pendingChallenge = null;
      _pendingVerifier = null;
      _status = AuthStatus.validationFailed;
    } on AuthException catch (e) {
      if (!_isCurrent(generation)) return;
      _errorMessage = e.message;
      _status = AuthStatus.unauthenticated;
    } catch (_) {
      if (!_isCurrent(generation)) return;
      _errorMessage = 'Something went wrong. Please try again.';
      _status = AuthStatus.unauthenticated;
    } finally {
      notifyListeners();
    }
  }

  /// Runs the OAuth flow for [provider]. A cancelled flow returns to the
  /// sign-in screen without an error; a 2FA-gated account moves to
  /// [AuthStatus.twoFactorPending] to collect a code.
  Future<void> signInWithSocial(SocialProvider provider) =>
      _runSocialSignIn(() => repository.signInWithSocial(provider));

  /// Runs the native "Sign in with Apple" flow (on-device authorization
  /// sheet), with [signInWithSocial]'s status transitions.
  Future<void> signInWithApple() =>
      _runSocialSignIn(repository.signInWithApple);

  /// Email password proof feeds the same validated session/factor lifecycle.
  Future<void> acceptEmailSignIn(SocialSignInResult result) =>
      _runSocialSignIn(() async => result);

  /// An email exchange can save credentials before validation becomes
  /// unavailable. Preserve the same recovery/guest reconciliation as OAuth.
  Future<void> handleEmailSignInFailure(Object error) =>
      _runSocialSignIn(() => Future<SocialSignInResult?>.error(error));

  /// Shared by the social and Apple flows. A guest signing in (CAN-2872) stays
  /// [AuthStatus.authenticated] as the guest until the new session arrives, so
  /// a cancel or failure returns to the guest's app rather than to a sign-in
  /// screen with the guest's session still stored. The repository's code
  /// exchange carries the guest's bearer, which is what merges the guest into
  /// the account server-side.
  Future<void> _runSocialSignIn(
    Future<SocialSignInResult?> Function() signIn,
  ) async {
    final generation = ++_authGeneration;
    final upgrading = isGuest && _status == AuthStatus.authenticated;
    if (upgrading) {
      _upgradingGuest = true;
    } else {
      _status = AuthStatus.authenticating;
    }
    _errorMessage = null;
    notifyListeners();
    try {
      final result = await signIn();
      if (!_isCurrent(generation)) return;
      switch (result) {
        case null:
          _status = _signedOutStatus;
        case SocialSignInSuccess(:final session):
          // The guest's app stays up until now; the launch view covers the
          // account's organization load, as `authenticating` does for a
          // signed-out sign-in, so no organization-less shell flashes.
          if (upgrading) _status = AuthStatus.unknown;
          await _applyAuthenticated(session);
        case SocialSignInTwoFactorRequired(:final challenge, :final verifier):
          _pendingChallenge = challenge;
          _pendingVerifier = verifier;
          _status = AuthStatus.twoFactorPending;
      }
    } on SessionValidationException {
      if (!_isCurrent(generation)) return;
      _pendingChallenge = null;
      _pendingVerifier = null;
      _status = AuthStatus.validationFailed;
    } on AuthException catch (e) {
      if (!_isCurrent(generation)) return;
      _errorMessage = e.message;
      await _settleFailedSignIn(upgrading: upgrading, generation: generation);
    } catch (_) {
      if (!_isCurrent(generation)) return;
      _errorMessage = 'Something went wrong. Please try again.';
      await _settleFailedSignIn(upgrading: upgrading, generation: generation);
    } finally {
      if (upgrading) _upgradingGuest = false;
      notifyListeners();
    }
  }

  Future<void> _settleFailedSignIn({
    required bool upgrading,
    required int generation,
  }) async {
    if (upgrading) {
      await _settleGuestUpgrade(generation);
    } else {
      _status = AuthStatus.unauthenticated;
    }
  }

  /// Works out where a guest stands after a sign-in that did not complete,
  /// instead of assuming the guest is still there. A failure after the code
  /// exchange has already merged the guest away server-side, and may have left
  /// the account's session stored, or none. The guest stays only while their
  /// own session still validates.
  Future<void> _settleGuestUpgrade(int generation) async {
    final guestId = _user?.id;
    final AuthSession? session;
    try {
      session = await repository.restoreSession().timeout(
        sessionValidationTimeout,
      );
    } catch (_) {
      if (_isCurrent(generation)) _status = AuthStatus.validationFailed;
      return;
    }
    if (!_isCurrent(generation)) return;
    final user = session?.user;
    if (user != null && user.isAnonymous && user.id == guestId) {
      _status = AuthStatus.authenticated;
      return;
    }
    _status = AuthStatus.unknown;
    await _applySession(session);
  }

  /// Where a cancelled sign-in lands: nothing was exchanged, so a guest's
  /// session is still stored and the guest goes back to their app.
  AuthStatus get _signedOutStatus =>
      isGuest ? AuthStatus.authenticated : AuthStatus.unauthenticated;

  /// Re-resolves the active organization and notifies listeners. Used after an
  /// authenticated but org-less user gains an organization (e.g. by accepting
  /// an invitation from the no-organization screen), so the auth gate can
  /// advance from the no-organization screen into the app shell once an org
  /// exists.
  Future<void> refreshActiveOrg() => _reloadOrganizationsForUser();

  /// Re-runs the org loader and reconciles the active selection after the
  /// signed-in user changes their org membership (create / rename / leave /
  /// delete from the Members screen). Keeps the current org if the user still
  /// belongs to it, otherwise falls back to Personal. Callers should
  /// [switchOrg] to a freshly created org after this resolves.
  Future<void> reloadOrganizations() => _reloadOrganizationsForUser();

  /// Confirms whether a resource-level 401/403 means the saved session is
  /// actually gone. A valid or temporarily unreachable session stays signed
  /// in so the resource can keep offering Retry; only an authoritative null
  /// response clears the session.
  Future<void> revalidateSessionAfterAuthenticationFailure() async {
    // A guest's sign-in keeps the status authenticated, and the exchange
    // ends the guest's session server-side, so the guest's own requests can
    // fail mid sign-in. Checking then would race the sign-in for the session
    // store; the sign-in settles the session itself.
    if (_disposed ||
        _status != AuthStatus.authenticated ||
        _upgradingGuest ||
        _revalidatingAuthenticationFailure) {
      return;
    }
    final generation = _authGeneration;
    _revalidatingAuthenticationFailure = true;
    try {
      final session = await repository.restoreSession().timeout(
        sessionValidationTimeout,
      );
      if (!_isCurrent(generation) || _status != AuthStatus.authenticated) {
        return;
      }
      if (session == null) await signOut();
    } catch (_) {
      // Validation is unavailable; retain the current session and retry UI.
    } finally {
      if (!_disposed) _revalidatingAuthenticationFailure = false;
    }
  }

  /// Resource-level 401s require an authoritative session check. A valid or
  /// temporarily unreachable session leaves organization retry available.
  Future<void> _reloadOrganizationsForUser() async {
    final authGeneration = _authGeneration;
    final orgGeneration = _orgLoadGeneration + 1;
    await _loadOrgs();
    if (!_isCurrent(authGeneration) || orgGeneration != _orgLoadGeneration) {
      return;
    }
    if (_lastOrgLoadStatusCode == 401) {
      try {
        final session = await repository.restoreSession().timeout(
          sessionValidationTimeout,
        );
        if (!_isCurrent(authGeneration) ||
            orgGeneration != _orgLoadGeneration) {
          return;
        }
        if (session == null) {
          await signOut();
          return;
        }
      } catch (_) {
        // Validation is unavailable; retain the current session and retry UI.
      }
    }
    notifyListeners();
  }

  /// Submits a TOTP or backup [code] for an [AuthStatus.twoFactorPending] flow.
  /// On success the app becomes authenticated; on an invalid code the screen
  /// stays open with an [errorMessage] so the user can retry. The status stays
  /// [AuthStatus.twoFactorPending] throughout, so the TOTP screen owns its own
  /// in-flight indicator.
  Future<void> verifyTwoFactor(String code) async {
    final generation = ++_authGeneration;
    final challenge = _pendingChallenge;
    final verifier = _pendingVerifier;
    if (challenge == null || verifier == null) {
      cancelTwoFactor();
      return;
    }
    _errorMessage = null;
    notifyListeners();
    try {
      final session = await repository.completeTwoFactor(
        challenge: challenge,
        verifier: verifier,
        code: code,
      );
      if (!_isCurrent(generation)) return;
      await _applyAuthenticated(session);
    } on SessionValidationException {
      if (!_isCurrent(generation)) return;
      _pendingChallenge = null;
      _pendingVerifier = null;
      _status = AuthStatus.validationFailed;
    } on AuthException catch (e) {
      if (!_isCurrent(generation)) return;
      _errorMessage = e.message;
    } catch (_) {
      if (!_isCurrent(generation)) return;
      _errorMessage = 'Something went wrong. Please try again.';
    } finally {
      notifyListeners();
    }
  }

  /// Abandons a pending 2FA flow and returns to the sign-in screen, or to the
  /// app for a guest. A code that verified but whose session then failed has
  /// already merged the guest away, so a guest's session is checked again.
  void cancelTwoFactor() {
    final generation = ++_authGeneration;
    _pendingChallenge = null;
    _pendingVerifier = null;
    _errorMessage = null;
    _status = _signedOutStatus;
    notifyListeners();
    if (!isGuest) return;
    _upgradingGuest = true;
    unawaited(
      _settleGuestUpgrade(generation).whenComplete(() {
        _upgradingGuest = false;
        notifyListeners();
      }),
    );
  }

  Future<void> _applyAuthenticated(AuthSession session) async {
    final generation = _authGeneration;
    _user = session.user;
    await _loadOrgs();
    if (!_isCurrent(generation)) return;
    _pendingChallenge = null;
    _pendingVerifier = null;
    _status = AuthStatus.authenticated;
  }

  /// Clears the session and returns to the sign-in screen.
  Future<void> signOut() async {
    ++_authGeneration;
    ++_orgLoadGeneration;
    _restoring = false;
    _isLoadingOrganizations = false;
    try {
      await beforeSignOut?.call();
    } catch (_) {
      // Best-effort cleanup must not block clearing the auth session.
    }
    await repository.signOut();
    _user = null;
    _organizations = const [];
    _personalOrganizationId = null;
    _activeOrgId = null;
    _contextAccountId = null;
    _organizationsLoadFailed = false;
    _lastOrgLoadStatusCode = null;
    _errorMessage = null;
    _status = AuthStatus.unauthenticated;
    notifyListeners();
  }

  Future<void> _applySession(AuthSession? session) async {
    final generation = _authGeneration;
    if (session != null) {
      _user = session.user;
      await _loadOrgs();
      if (!_isCurrent(generation)) return;
      _status = AuthStatus.authenticated;
    } else {
      _user = null;
      _organizations = const [];
      _personalOrganizationId = null;
      _activeOrgId = null;
      _contextAccountId = null;
      _organizationsLoadFailed = false;
      _status = AuthStatus.unauthenticated;
    }
  }

  /// Loads the account's contexts and reconciles the active selection: the
  /// account's saved context on its first load, then the live choice. Either
  /// falls back to Personal once the user no longer belongs to that
  /// organization. List order is never a preference
  /// (docs/shared-resource-authorization.md).
  Future<void> _loadOrgs() async {
    final loader = loadOrganizations;
    // A guest has no organizations to load (CAN-2872); its shell asks for none.
    if (loader == null || isGuest) {
      _organizations = const [];
      _personalOrganizationId = null;
      _activeOrgId = null;
      _organizationsLoadFailed = false;
      return;
    }
    // Retry is tappable while a load is already in flight, so results are
    // matched to the request that started LAST rather than the one that happens
    // to finish last: a slow earlier failure must not overwrite a newer success.
    final generation = ++_orgLoadGeneration;
    _lastOrgLoadStatusCode = null;
    _setLoadingOrganizations(true);
    try {
      final account = await loader().timeout(organizationLoadTimeout);
      if (generation != _orgLoadGeneration) return;
      final orgs = account.organizations;
      final accountId = _user?.id;
      final restoring = accountId != _contextAccountId;
      final desired = restoring
          ? (await _readSavedContext(accountId))?.organizationId
          : _activeOrgId;
      if (generation != _orgLoadGeneration) return;
      final isMember = desired != null && orgs.any((o) => o.id == desired);
      _organizations = orgs;
      _personalOrganizationId = account.personalOrganizationId;
      _organizationsLoadFailed = false;
      _contextAccountId = accountId;
      _activeOrgId = isMember ? desired : null;
      // The user left or lost the selected organization: remember Personal.
      if (!restoring && desired != null && !isMember) {
        unawaited(_saveContext(const WorkspaceContext.personal()));
      }
    } catch (error) {
      if (generation != _orgLoadGeneration) return;
      // An empty list and a thrown load both leave no active org, but only the
      // former means "this account has no organization" — see
      // [organizationsLoadFailed].
      _organizations = const [];
      _personalOrganizationId = null;
      _activeOrgId = null;
      // The next successful load restores the saved choice again.
      _contextAccountId = null;
      _organizationsLoadFailed = true;
      _lastOrgLoadStatusCode = error is ApiException ? error.statusCode : null;
    } finally {
      if (generation == _orgLoadGeneration) _setLoadingOrganizations(false);
    }
  }

  void _setLoadingOrganizations(bool loading) {
    if (_isLoadingOrganizations == loading) return;
    _isLoadingOrganizations = loading;
    notifyListeners();
  }

  /// Switches the active organization to [orgId], re-scoping the data screens.
  /// A no-op unless [orgId] is a different org the user actually belongs to.
  void switchOrg(String orgId) {
    if (orgId == _activeOrgId) return;
    unawaited(selectWorkspaceContext(WorkspaceContext.organization(orgId)));
  }

  /// Selects [context] at once and saves it for this account. Completes with
  /// [WorkspaceContextSelection.refused], changing nothing, when [context]
  /// names an organization the user does not belong to. Completes with
  /// [WorkspaceContextSelection.unsaved] when the save failed; the selection
  /// then lasts until restart and the previously saved choice stays in place.
  /// Completes with [WorkspaceContextSelection.superseded] when a newer
  /// selection was made before this save finished.
  Future<WorkspaceContextSelection> selectWorkspaceContext(
    WorkspaceContext context,
  ) async {
    final organizationId = context.organizationId;
    if (organizationId != null &&
        !_organizations.any((o) => o.id == organizationId)) {
      return WorkspaceContextSelection.refused;
    }
    final selection = ++_contextSelections;
    if (organizationId != _activeOrgId) {
      _activeOrgId = organizationId;
      notifyListeners();
    }
    final saved = await _saveContext(context);
    if (selection != _contextSelections) {
      return WorkspaceContextSelection.superseded;
    }
    return saved
        ? WorkspaceContextSelection.saved
        : WorkspaceContextSelection.unsaved;
  }

  Future<WorkspaceContext?> _readSavedContext(String? accountId) async {
    final store = workspaceContextStore;
    if (store == null || accountId == null) return null;
    // Read after queued saves land, and again if a choice was made during the
    // read, so a restore never replaces a newer choice with an older one.
    // It waits only while a save is pending, never on an idle chain.
    for (;;) {
      final writes = _contextWrites;
      if (_pendingContextWrites > 0) await writes;
      WorkspaceContext? saved;
      try {
        saved = await store.read(accountId);
      } catch (_) {
        // An unreadable preference starts in Personal without erasing it.
        saved = null;
      }
      if (identical(writes, _contextWrites)) return saved;
    }
  }

  /// Writes run one at a time, so the latest selection is the one that lands
  /// last even when an earlier write is slow.
  Future<bool> _saveContext(WorkspaceContext context) {
    final store = workspaceContextStore;
    final accountId = _user?.id;
    if (store == null || accountId == null) return Future.value(true);
    _pendingContextWrites++;
    final write = _contextWrites.then((_) => store.write(accountId, context));
    _contextWrites = write
        .catchError((Object _) {})
        .whenComplete(() => _pendingContextWrites--);
    return write.then((_) => true, onError: (Object _) => false);
  }

  /// Applies an updated display [name] to the cached user after a profile edit,
  /// so account UI reflects it without re-fetching the session.
  void applyProfileName(String name) {
    final user = _user;
    if (user == null) return;
    _user = AuthUser(
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: name,
      image: user.image,
      role: user.role,
      status: user.status,
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      isAnonymous: user.isAnonymous,
    );
    notifyListeners();
  }
}
