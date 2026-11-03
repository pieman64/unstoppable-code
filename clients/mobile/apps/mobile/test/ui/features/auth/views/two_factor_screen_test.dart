import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/auth_session.dart';
import 'package:mobile/data/models/auth_user.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/two_factor_screen.dart';

void main() {
  Future<AuthViewModel> pendingViewModel(_RecordingRepository repo) async {
    final vm = AuthViewModel(repository: repo);
    await vm.signInWithSocial(SocialProvider.google); // -> twoFactorPending
    return vm;
  }

  Future<void> pumpScreen(WidgetTester tester, AuthViewModel vm) {
    return tester.pumpWidget(
      ChangeNotifierProvider<AuthViewModel>.value(
        value: vm,
        child: const MaterialApp(home: TwoFactorScreen()),
      ),
    );
  }

  testWidgets('submitting a code drives verifyTwoFactor', (tester) async {
    final repo = _RecordingRepository();
    await pumpScreen(tester, await pendingViewModel(repo));

    await tester.enterText(find.byType(TextField), '123456');
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    expect(repo.submittedCodes, ['123456']);
  });

  testWidgets('accepts a backup-code format, not just 6 digits', (
    tester,
  ) async {
    final repo = _RecordingRepository();
    await pumpScreen(tester, await pendingViewModel(repo));

    await tester.enterText(find.byType(TextField), 'abcde-fghij');
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    expect(repo.submittedCodes, ['abcde-fghij']);
  });

  testWidgets('shows the error message from a failed verification', (
    tester,
  ) async {
    final repo = _RecordingRepository(valid: false);
    await pumpScreen(tester, await pendingViewModel(repo));

    await tester.enterText(find.byType(TextField), '000000');
    await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
    await tester.pumpAndSettle();

    expect(
      find.text('That code was not valid. Please try again.'),
      findsOneWidget,
    );
  });

  testWidgets('cancel returns the flow to unauthenticated', (tester) async {
    final repo = _RecordingRepository();
    final vm = await pendingViewModel(repo);
    await pumpScreen(tester, vm);

    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pump();

    expect(vm.status, AuthStatus.unauthenticated);
  });
}

/// [AuthRepository] that reports a 2FA challenge and records the codes submitted
/// to [completeTwoFactor], succeeding unless constructed with `valid: false`.
class _RecordingRepository implements AuthRepository {
  _RecordingRepository({this.valid = true});

  final bool valid;
  final List<String> submittedCodes = [];

  @override
  Future<AuthSession?> restoreSession() async => null;

  @override
  Future<AuthSession> signIn({
    required String email,
    required String password,
  }) async => throw UnimplementedError();

  @override
  Future<void> signOut() async {}

  @override
  Future<SocialSignInResult?> signInWithSocial(SocialProvider provider) async =>
      const SocialSignInTwoFactorRequired(
        challenge: 'chal-xyz',
        verifier: 'verifier-1',
      );

  @override
  Future<SocialSignInResult?> signInWithApple() => throw UnimplementedError();

  @override
  Future<AuthSession> completeTwoFactor({
    required String challenge,
    required String verifier,
    required String code,
  }) async {
    submittedCodes.add(code);
    if (!valid) {
      throw const AuthException('That code was not valid. Please try again.');
    }
    return AuthSession(
      token: 'sess-tok',
      user: AuthUser(
        id: '1',
        email: '2fa@canopy.dev',
        emailVerified: true,
        name: 'Two Factor',
        image: null,
        role: 'DEVELOPER',
        status: 'ACTIVE',
        twoFactorEnabled: true,
        createdAt: '',
        updatedAt: '',
      ),
    );
  }
}
