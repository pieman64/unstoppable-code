import 'package:mobile/ui/features/desktop_app/views/desktop_app_prompt_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/desktop_app_prompt_store.dart';
import 'package:mobile/services/link_sharer.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
import 'package:mobile/app/desktop_app_prompt_binding.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import '../support/fake_remote_control_repository.dart';

final class _NoShare implements LinkSharer {
  @override
  Future<void> share({
    required String text,
    String? subject,
    Rect? origin,
  }) async {}
}

void main() {
  late DesktopAppPromptController desktopApp;
  late InMemoryDesktopAppPromptStore store;

  setUp(() {
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: 'https://production.test',
        stagingBaseUrl: 'https://staging.test',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
    store = InMemoryDesktopAppPromptStore();
    desktopApp = DesktopAppPromptController(
      store: store,
      isActive: () => true,
      downloadUrl: () => 'https://production.test/download',
      sharer: _NoShare(),
      showPrompt: showDesktopAppPromptSheet,
    );
  });

  Future<AuthViewModel> pumpBinding(WidgetTester tester) async {
    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    addTearDown(auth.dispose);
    await tester.runAsync(
      () => auth.signIn(email: 'a@b.dev', password: 'password'),
    );
    final remote = RemoteControlViewModel(
      repository: FakeRemoteControlRepository(),
    );
    addTearDown(remote.dispose);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<DesktopAppPromptController>.value(
            value: desktopApp,
          ),
          ChangeNotifierProvider<AuthViewModel>.value(value: auth),
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
        ],
        child: const DesktopAppPromptBinding(child: SizedBox()),
      ),
    );
    // The shell starts the pairing probe; here the test does.
    await tester.runAsync(remote.restoreIfIdle);
    await tester.pumpAndSettle();
    return auth;
  }

  testWidgets('publishes the signed-in account and its missing desktop', (
    tester,
  ) async {
    await pumpBinding(tester);
    expect(desktopApp.canOffer, isTrue);
    expect(await desktopApp.claimSuccessfulTurn(), isTrue);
  });

  testWidgets('keys the account by environment and user id', (tester) async {
    final auth = AuthViewModel(
      repository: MockAuthRepository(latency: Duration.zero),
    );
    addTearDown(auth.dispose);
    await tester.runAsync(
      () => auth.signIn(email: 'a@b.dev', password: 'password'),
    );
    final userId = auth.user?.id;
    expect(userId, isNotNull);
    await store.markDismissed('production:$userId');

    await pumpBinding(tester);

    expect(desktopApp.canOffer, isTrue);
    expect(await desktopApp.claimSuccessfulTurn(), isFalse);
  });

  testWidgets('leaving the shell clears the account', (tester) async {
    await pumpBinding(tester);
    expect(desktopApp.canOffer, isTrue);

    await tester.pumpWidget(const SizedBox());
    await tester.pump();

    expect(desktopApp.canOffer, isFalse);
  });
}
