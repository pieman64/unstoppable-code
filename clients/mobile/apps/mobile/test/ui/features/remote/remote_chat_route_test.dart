import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_route.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/workspace_context_fixture.dart';

const _organizationA = WorkspaceContext.organization(workspaceContextOrgA);

void main() {
  group('remoteChatRoute', () {
    late RemoteControlViewModel viewModel;
    late ValueNotifier<WorkspaceContext> selected;
    final navigatorKey = GlobalKey<NavigatorState>();

    setUp(() {
      viewModel = RemoteControlViewModel(
        repository: FakeRemoteControlRepository(),
      );
      selected = ValueNotifier(_organizationA);
    });

    tearDown(() {
      selected.dispose();
      viewModel.dispose();
    });

    Widget app({bool provideContext = true}) {
      final home = ChangeNotifierProvider<RemoteControlViewModel>.value(
        value: viewModel,
        child: const Text('shell'),
      );
      final materialApp = MaterialApp(navigatorKey: navigatorKey, home: home);
      if (!provideContext) return materialApp;
      return ValueListenableBuilder<WorkspaceContext>(
        valueListenable: selected,
        builder: (_, workspaceContext, child) =>
            Provider<WorkspaceContext>.value(
              value: workspaceContext,
              child: child,
            ),
        child: materialApp,
      );
    }

    BuildContext shellContext(WidgetTester tester) =>
        tester.element(find.text('shell', skipOffstage: false));

    Future<void> settle(WidgetTester tester) async {
      await tester.pump();
      await tester.pumpAndSettle();
    }

    testWidgets(
      'CAN-4429 a context change closes the chat and the screens it opened',
      (tester) async {
        await tester.pumpWidget(app());
        var closed = false;
        navigatorKey.currentState!
            .push(remoteChatRoute(shellContext(tester), const Text('chat A')))
            .whenComplete(() => closed = true);
        await settle(tester);
        navigatorKey.currentState!.push(
          MaterialPageRoute<void>(builder: (_) => const Text('diff A')),
        );
        await settle(tester);

        selected.value = const WorkspaceContext.personal();
        await settle(tester);

        expect(find.text('chat A'), findsNothing);
        expect(find.text('diff A'), findsNothing);
        expect(find.text('shell'), findsOneWidget);
        expect(closed, isTrue);
      },
    );

    testWidgets(
      'CAN-4429 keeps a chat opened in the new context before the old chat '
      'closes',
      (tester) async {
        await tester.pumpWidget(app());
        var closedA = false;
        navigatorKey.currentState!
            .push(remoteChatRoute(shellContext(tester), const Text('chat A')))
            .whenComplete(() => closedA = true);
        await settle(tester);

        // A notification opens a Personal chat from the live context before
        // the provided value updates and the old chat's cleanup runs.
        selected.value = const WorkspaceContext.personal();
        navigatorKey.currentState!.push(
          remoteChatRoute(
            shellContext(tester),
            const Text('chat Personal'),
            workspaceContext: const WorkspaceContext.personal(),
          ),
        );
        await settle(tester);

        expect(find.text('chat A', skipOffstage: false), findsNothing);
        expect(find.text('chat Personal'), findsOneWidget);
        expect(closedA, isTrue);
      },
    );

    testWidgets(
      'CAN-4429 a chat opened in the new context does not leave the old '
      "chat's screens beneath it",
      (tester) async {
        final repository = FakeRemoteControlRepository();
        viewModel.dispose();
        viewModel = RemoteControlViewModel(repository: repository);
        await tester.pumpWidget(app());
        navigatorKey.currentState!.push(
          remoteChatRoute(shellContext(tester), const Text('chat A')),
        );
        await settle(tester);
        // Changed files pushes its diff as a plain route above the chat.
        navigatorKey.currentState!.push(
          MaterialPageRoute<void>(builder: (_) => const Text('diff A')),
        );
        await settle(tester);

        // A membership reload changes the live context, and a notification
        // for a Personal chat opens it before the next frame.
        selected.value = const WorkspaceContext.personal();
        navigatorKey.currentState!.push(
          remoteChatRoute(
            shellContext(tester),
            const Text('chat Personal'),
            workspaceContext: const WorkspaceContext.personal(),
          ),
        );
        await settle(tester);
        expect(find.text('chat Personal'), findsOneWidget);

        navigatorKey.currentState!.pop();
        await settle(tester);

        expect(find.text('diff A', skipOffstage: false), findsNothing);
        expect(find.text('chat A', skipOffstage: false), findsNothing);
        expect(find.text('shell'), findsOneWidget);
        expect(repository.disconnectCalls, 0);
      },
    );

    testWidgets('CAN-4429 a host without a provided context keeps the chat', (
      tester,
    ) async {
      await tester.pumpWidget(app(provideContext: false));
      navigatorKey.currentState!.push(
        remoteChatRoute(shellContext(tester), const Text('chat')),
      );
      await settle(tester);

      expect(find.text('chat'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
