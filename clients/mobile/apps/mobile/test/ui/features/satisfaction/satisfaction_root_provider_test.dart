import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/main.dart'
    show buildCloudChatModels, buildRootProviders, buildSharedShellProviders;
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:provider/provider.dart';

/// Chat screens are pushed on the ROOT navigator, above anything
/// `buildSharedShellProviders()` supplies, so the controller must be a root
/// provider — the same reason `TurnFeedbackController` lives there.
void main() {
  setUp(() {
    // Empty base URLs => every repository builder in main.dart resolves to
    // its Mock* implementation, so nothing here touches the network.
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: '',
        stagingBaseUrl: '',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
  });

  testWidgets('buildRootProviders supplies the satisfaction controller', (
    tester,
  ) async {
    SatisfactionPromptController? found;
    await tester.pumpWidget(
      MultiProvider(
        providers: buildRootProviders(),
        child: MaterialApp(
          home: Builder(
            builder: (context) {
              found = context.read<SatisfactionPromptController>();
              return const SizedBox();
            },
          ),
        ),
      ),
    );
    expect(found, isNotNull);
  });

  group('production chat view models report successful turns', () {
    testWidgets('the shell Remote Control view model', (tester) async {
      RemoteControlViewModel? remote;
      await tester.pumpWidget(
        MultiProvider(
          providers: buildSharedShellProviders(),
          child: MaterialApp(
            home: Builder(
              builder: (context) {
                remote = context.read<RemoteControlViewModel>();
                return const SizedBox();
              },
            ),
          ),
        ),
      );
      expect(remote?.onSuccessfulTurn, isNotNull);
    });

    testWidgets('the cloud chat session', (tester) async {
      final models = buildCloudChatModels();
      addTearDown(() {
        models.session.dispose();
        models.list.dispose();
      });
      expect(models.session.onSuccessfulTurn, isNotNull);
    });
  });
}
