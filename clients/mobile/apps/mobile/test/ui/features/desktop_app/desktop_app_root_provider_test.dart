import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/main.dart' show buildRootProviders;
import 'package:mobile/ui/core/chat/chat_prompt_host.dart';
import 'package:mobile/ui/features/desktop_app/views/desktop_app_prompt_host.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_host.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
import 'package:provider/provider.dart';

/// Cloud chats are pushed on the ROOT navigator, above the shell, so the
/// controller must be a root provider like the satisfaction prompt's.
void main() {
  setUp(() {
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: '',
        stagingBaseUrl: '',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
  });

  testWidgets('buildRootProviders supplies the desktop app prompt', (
    tester,
  ) async {
    DesktopAppPromptController? found;
    await tester.pumpWidget(
      MultiProvider(
        providers: buildRootProviders(),
        child: MaterialApp(
          home: Builder(
            builder: (context) {
              found = context.read<DesktopAppPromptController>();
              return const ChatPromptHost(
                isQuiet: true,
                child: SizedBox(key: ValueKey('chat-body')),
              );
            },
          ),
        ),
      ),
    );
    expect(found, isNotNull);
    expect(find.byType(DesktopAppPromptHost), findsOneWidget);
    expect(find.byType(SatisfactionPromptHost), findsOneWidget);
    expect(find.byKey(const ValueKey('chat-body')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('separate provider roots own separate desktop controllers', (
    tester,
  ) async {
    final controllers = <DesktopAppPromptController>[];
    for (var i = 0; i < 2; i++) {
      await tester.pumpWidget(
        MultiProvider(
          key: ValueKey(i),
          providers: buildRootProviders(),
          child: Builder(
            builder: (context) {
              controllers.add(context.read<DesktopAppPromptController>());
              return const SizedBox();
            },
          ),
        ),
      );
    }
    expect(identical(controllers[0], controllers[1]), isFalse);
  });
}
