import 'dart:async';

import 'package:mobile/main.dart' show refreshActivityFeed;
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/home/views/activity_refresh_binding.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/data/services/workspace_context_store.dart';
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/push_tap_binding.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

import '../../../support/account_organizations_fixture.dart';
import '../../../support/fake_remote_control_repository.dart';
import '../../../support/foreground_push_fixture.dart';
import '../../../support/workspace_context_fixture.dart';

void main() {
  group('PushTapBinding', () {
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    PushMessageCoordinator buildCoordinator([FakePushMessaging? messaging]) {
      final coordinator = PushMessageCoordinator(
        messaging: messaging ?? FakePushMessaging(),
      );
      unawaited(coordinator.start());
      return coordinator;
    }

    test('defaults the hydration timeout to 10 seconds for cold starts', () {
      final binding = PushTapBinding(
        coordinator: buildCoordinator(),
        child: const SizedBox.shrink(),
      );
      expect(binding.hydrationTimeout, const Duration(seconds: 10));
    });

    Widget buildSubject({
      required RemoteControlViewModel viewModel,
      required HomeTabController tabController,
      required PushMessageCoordinator coordinator,
      WorkspaceContext Function()? workspaceContext,
      bool Function()? personalActivityAvailable,
    }) {
      return MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
          ),
          ChangeNotifierProvider<HomeTabController>.value(value: tabController),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          home: PushTapBinding(
            coordinator: coordinator,
            workspaceContext: workspaceContext,
            personalActivityAvailable: personalActivityAvailable,
            child: const Scaffold(body: SizedBox()),
          ),
        ),
      );
    }

    testWidgets('falls back to the feed tab when disconnected', (tester) async {
      usePhoneViewport(tester);
      // Left disconnected: the fake repository's default restoreSession()
      // resolves null (no server-side pairing to restore).
      final viewModel = RemoteControlViewModel(
        repository: FakeRemoteControlRepository(),
      );
      addTearDown(viewModel.dispose);
      final tabController = HomeTabController(tabs: organizationHomeTabs)
        ..select(HomeTab.account);
      final coordinator = buildCoordinator();
      addTearDown(() => unawaited(coordinator.dispose()));

      await tester.pumpWidget(
        buildSubject(
          viewModel: viewModel,
          tabController: tabController,
          coordinator: coordinator,
        ),
      );
      await tester.pumpAndSettle();

      coordinator.requestOpen(
        const PushMessage(data: {'worktreeId': 'nope', 'clientChatId': 'nope'}),
      );
      await tester.pumpAndSettle();

      expect(tabController.value, HomeTab.activity);
      expect(coordinator.pendingTap.value, isNull);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'the feed fallback sends a user with no organization to Remote, never '
      'to whichever tab happens to sit at index 0 of the layout (CAN-2576)',
      (tester) async {
        usePhoneViewport(tester);
        final viewModel = RemoteControlViewModel(
          repository: FakeRemoteControlRepository(),
        );
        addTearDown(viewModel.dispose);
        // This shell has no Activity tab.
        final tabController = HomeTabController(tabs: noOrganizationHomeTabs)
          ..select(HomeTab.account);
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));

        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();

        coordinator.requestOpen(
          const PushMessage(
            data: {'worktreeId': 'nope', 'clientChatId': 'nope'},
          ),
        );
        await tester.pumpAndSettle();

        // Remote, not Account: there is no feed to show, and this is a Remote
        // Control notification, so the tap lands somewhere actionable instead
        // of appearing to do nothing. Remote is chosen by identity — neither
        // the shell's first tab (Cloud chats since CAN-3143) nor its landing
        // tab — see `_showFeed`.
        expect(tabController.value, HomeTab.remote);
        // Still consumed: an unroutable tap must not stay pending forever.
        expect(coordinator.pendingTap.value, isNull);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'a Personal feed fallback reads Personal Activity availability when the '
      'tap lands (CAN-3715)',
      (tester) async {
        usePhoneViewport(tester);
        final viewModel = RemoteControlViewModel(
          repository: FakeRemoteControlRepository(),
        );
        addTearDown(viewModel.dispose);
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.account);
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));
        var available = false;

        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
            workspaceContext: () => const WorkspaceContext.personal(),
            personalActivityAvailable: () => available,
          ),
        );
        await tester.pumpAndSettle();

        coordinator.requestOpen(
          const PushMessage(data: {'worktreeId': 'nope', 'clientChatId': 'a'}),
        );
        await tester.pumpAndSettle();
        expect(tabController.value, HomeTab.remote);

        // The Personal organization loads without rebuilding the binding.
        tabController.select(HomeTab.account);
        available = true;
        coordinator.requestOpen(
          const PushMessage(data: {'worktreeId': 'nope', 'clientChatId': 'b'}),
        );
        await tester.pumpAndSettle();
        expect(tabController.value, HomeTab.activity);
        expect(coordinator.pendingTap.value, isNull);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'without Personal Activity availability a Personal feed fallback lands '
      'on Remote',
      (tester) async {
        usePhoneViewport(tester);
        final viewModel = RemoteControlViewModel(
          repository: FakeRemoteControlRepository(),
        );
        addTearDown(viewModel.dispose);
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.account);
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));

        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
            workspaceContext: () => const WorkspaceContext.personal(),
          ),
        );
        await tester.pumpAndSettle();

        coordinator.requestOpen(
          const PushMessage(data: {'worktreeId': 'nope', 'clientChatId': 'a'}),
        );
        await tester.pumpAndSettle();

        expect(tabController.value, HomeTab.remote);
        expect(coordinator.pendingTap.value, isNull);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('waits for an in-flight restore before resolving a push tap', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = _RestoringRepository();
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      unawaited(viewModel.restoreIfIdle());

      final tabController = HomeTabController(tabs: organizationHomeTabs)
        ..select(HomeTab.account);
      final coordinator = buildCoordinator();
      addTearDown(() => unawaited(coordinator.dispose()));

      await tester.pumpWidget(
        buildSubject(
          viewModel: viewModel,
          tabController: tabController,
          coordinator: coordinator,
        ),
      );
      await tester.pump();
      expect(viewModel.isRestoring, isTrue);

      const message = PushMessage(
        data: {'worktreeId': 'wt-1', 'clientChatId': 'chat-9'},
      );
      coordinator.requestOpen(message);
      await tester.pump();

      expect(coordinator.pendingTap.value, same(message));
      expect(tabController.value, HomeTab.account);
      expect(find.byType(RemoteChatScreen), findsNothing);

      repository.completeRestore();
      await tester.pumpAndSettle();

      expect(find.byType(RemoteChatScreen), findsOneWidget);
      expect(coordinator.pendingTap.value, isNull);
      await tester.pumpWidget(const SizedBox());
      viewModel.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets('feed fallback pops stacked routes so the shell is visible', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = RemoteControlViewModel(
        repository: FakeRemoteControlRepository(),
      );
      addTearDown(viewModel.dispose);
      final tabController = HomeTabController(tabs: organizationHomeTabs)
        ..select(HomeTab.account);
      final coordinator = buildCoordinator();
      addTearDown(() => unawaited(coordinator.dispose()));

      await tester.pumpWidget(
        buildSubject(
          viewModel: viewModel,
          tabController: tabController,
          coordinator: coordinator,
        ),
      );
      await tester.pumpAndSettle();

      // A screen pushed above the shell (an open chat, settings) hides a
      // bare tab switch entirely — the fallback must return to the shell.
      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      unawaited(
        navigator.push(
          MaterialPageRoute<void>(
            builder: (_) => const Scaffold(key: Key('stacked-route')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('stacked-route')), findsOneWidget);

      coordinator.requestOpen(
        const PushMessage(data: {'worktreeId': 'nope', 'clientChatId': 'nope'}),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('stacked-route')), findsNothing);
      expect(tabController.value, HomeTab.activity);
      expect(coordinator.pendingTap.value, isNull);
      expect(tester.takeException(), isNull);
    });

    for (final stacked in [false, true]) {
      testWidgets(
        'a feed fallback reloads Activity (CAN-3715, stacked route: $stacked)',
        (tester) async {
          usePhoneViewport(tester);
          final viewModel = RemoteControlViewModel(
            repository: FakeRemoteControlRepository(),
          );
          addTearDown(viewModel.dispose);
          // Already on Activity: reselection must still reload it.
          final tabController = HomeTabController(
            tabs: organizationHomeTabs,
            initialTab: HomeTab.activity,
          );
          final feed = _CountingFeedRepository();
          final coordinator = buildCoordinator();
          addTearDown(() => unawaited(coordinator.dispose()));

          await tester.pumpWidget(
            MultiProvider(
              providers: [
                ChangeNotifierProvider<RemoteControlViewModel>.value(
                  value: viewModel,
                ),
                ChangeNotifierProvider<HomeTabController>.value(
                  value: tabController,
                ),
                // Eager, as FeedScreen reads it at once in the real shell.
                ChangeNotifierProvider<FeedViewModel>(
                  lazy: false,
                  create: (_) => FeedViewModel(repository: feed)..loadFeed(),
                ),
              ],
              child: MaterialApp(
                home: PushTapBinding(
                  coordinator: coordinator,
                  child: const ActivityRefreshBinding(
                    refresh: refreshActivityFeed,
                    child: Scaffold(body: SizedBox()),
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(feed.calls, 1);
          if (stacked) {
            final navigator = tester.state<NavigatorState>(
              find.byType(Navigator),
            );
            unawaited(
              navigator.push(
                MaterialPageRoute<void>(
                  builder: (_) => const Scaffold(key: Key('stacked-route')),
                ),
              ),
            );
            await tester.pumpAndSettle();
          }

          coordinator.requestOpen(
            const PushMessage(
              data: {'worktreeId': 'nope', 'clientChatId': 'nope'},
            ),
          );
          await tester.pumpAndSettle();

          expect(find.byKey(const Key('stacked-route')), findsNothing);
          expect(tabController.value, HomeTab.activity);
          expect(feed.calls, 2);
          expect(tester.takeException(), isNull);
        },
      );
    }

    group('CAN-4429 workspace context', () {
      Future<(RemoteControlViewModel, List<WorkspaceContext>)> pumpScoped(
        WidgetTester tester,
        PushMessageCoordinator coordinator,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () =>
              RemoteSessionSnapshot.fromJson(workspaceContextShellState());
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(viewModel.dispose);
        await tester.runAsync(() => viewModel.connect('123456'));
        final selected = <WorkspaceContext>[];
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              Provider<WorkspaceContext>.value(
                value: const WorkspaceContext.personal(),
              ),
              ChangeNotifierProvider<RemoteControlViewModel>.value(
                value: viewModel,
              ),
              ChangeNotifierProvider<HomeTabController>(
                create: (_) => HomeTabController(tabs: organizationHomeTabs),
              ),
              ChangeNotifierProvider<TurnFeedbackController>(
                create: (_) => TurnFeedbackController(
                  repository: MockTurnFeedbackRepository(),
                ),
              ),
            ],
            child: MaterialApp(
              home: PushTapBinding(
                coordinator: coordinator,
                selectWorkspaceContext: (context) async {
                  selected.add(context);
                  return WorkspaceContextSelection.saved;
                },
                child: const Scaffold(body: SizedBox()),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final navigator = tester.state<NavigatorState>(find.byType(Navigator));
        unawaited(
          navigator.push(
            MaterialPageRoute<void>(
              builder: (_) => const Scaffold(key: Key('personal-route')),
            ),
          ),
        );
        await tester.pumpAndSettle();
        return (viewModel, selected);
      }

      testWidgets(
        'a chat owned by another context switches to it, then opens',
        (tester) async {
          final coordinator = buildCoordinator();
          addTearDown(() => unawaited(coordinator.dispose()));
          final (_, selected) = await pumpScoped(tester, coordinator);

          coordinator.requestOpen(
            const PushMessage(data: {'clientChatId': 'chat-acme'}),
          );
          await tester.pumpAndSettle();

          expect(selected, [
            const WorkspaceContext.organization(workspaceContextOrgA),
          ]);
          // The Personal route closed; the organization chat opened.
          expect(find.byKey(const Key('personal-route')), findsNothing);
          expect(find.byType(RemoteChatScreen), findsOneWidget);
          expect(coordinator.pendingTap.value, isNull);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );

      testWidgets('a chat in the current context keeps the context', (
        tester,
      ) async {
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));
        final (_, selected) = await pumpScoped(tester, coordinator);

        coordinator.requestOpen(
          const PushMessage(data: {'clientChatId': 'chat-loose'}),
        );
        await tester.pumpAndSettle();

        expect(selected, isEmpty);
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        expect(
          find.byKey(const Key('personal-route'), skipOffstage: false),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox());
      });

      group('with the real AuthViewModel', () {
        Future<AuthViewModel> signIn(
          WidgetTester tester,
          Future<List<OrganizationSummary>> Function() loadOrganizations, {
          WorkspaceContextStore? store,
        }) async {
          final auth = AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
            loadOrganizations: teamsOnly(loadOrganizations),
            workspaceContextStore: store,
          );
          addTearDown(auth.dispose);
          await tester.runAsync(
            () => auth.signIn(email: 'a@b.dev', password: 'password'),
          );
          return auth;
        }

        Future<RemoteControlViewModel> pumpWithAuth(
          WidgetTester tester,
          PushMessageCoordinator coordinator,
          AuthViewModel auth, {
          Map<String, dynamic> Function() shellState =
              workspaceContextShellState,
          FakeRemoteControlRepository? repository,
        }) async {
          usePhoneViewport(tester);
          repository = (repository ?? FakeRemoteControlRepository())
            ..snapshotBuilder = () =>
                RemoteSessionSnapshot.fromJson(shellState());
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          addTearDown(viewModel.dispose);
          await tester.runAsync(() => viewModel.connect('123456'));
          await tester.pumpWidget(
            MultiProvider(
              providers: [
                ChangeNotifierProvider<AuthViewModel>.value(value: auth),
                workspaceContextProvider(),
                ChangeNotifierProvider<RemoteControlViewModel>.value(
                  value: viewModel,
                ),
                ChangeNotifierProvider<HomeTabController>(
                  create: (_) => HomeTabController(tabs: organizationHomeTabs),
                ),
                ChangeNotifierProvider<TurnFeedbackController>(
                  create: (_) => TurnFeedbackController(
                    repository: MockTurnFeedbackRepository(),
                  ),
                ),
              ],
              child: MaterialApp(
                home: PushTapBinding(
                  coordinator: coordinator,
                  selectWorkspaceContext: auth.selectWorkspaceContext,
                  workspaceContext: () => auth.workspaceContext,
                  child: const Scaffold(body: SizedBox()),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          return viewModel;
        }

        testWidgets(
          'a refused switch keeps the context, opens nothing and offers Retry',
          (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            var loadFails = true;
            // The membership load fails, so the account lists no
            // organizations and refuses the switch to the chat's owner.
            final auth = await signIn(tester, () async {
              if (loadFails) throw StateError('offline');
              return workspaceContextOrganizations();
            });
            expect(auth.organizations, isEmpty);
            await pumpWithAuth(tester, coordinator, auth);

            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-acme'}),
            );
            await tester.pumpAndSettle();

            expect(auth.workspaceContext, const WorkspaceContext.personal());
            expect(find.byType(RemoteChatScreen), findsNothing);
            expect(
              find.text("Couldn't switch context. Try again."),
              findsOneWidget,
            );
            expect(coordinator.pendingTap.value, isNull);

            // Memberships load again; Retry switches first, then opens.
            loadFails = false;
            await tester.runAsync(auth.reloadOrganizations);
            await tester.tap(find.text('Retry'));
            await tester.pumpAndSettle();

            expect(
              auth.workspaceContext,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );
            expect(find.byType(RemoteChatScreen), findsOneWidget);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          },
        );

        testWidgets(
          'a failed save still switches and opens the chat in its context',
          (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            final auth = await signIn(
              tester,
              () async => workspaceContextOrganizations(),
              store: _FailingContextStore(),
            );
            await pumpWithAuth(tester, coordinator, auth);

            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-acme'}),
            );
            await tester.pumpAndSettle();

            expect(
              auth.workspaceContext,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );
            expect(find.byType(RemoteChatScreen), findsOneWidget);
            expect(
              find.text("Couldn't switch context. Try again."),
              findsNothing,
            );
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          },
        );

        testWidgets(
          'a newer choice made while the switch saves keeps the chat closed',
          (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            final store = _HeldFirstWriteContextStore();
            final auth = await signIn(
              tester,
              () async => workspaceContextOrganizations(),
              store: store,
            );
            await pumpWithAuth(tester, coordinator, auth);

            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-acme'}),
            );
            await tester.pumpAndSettle();
            expect(
              auth.workspaceContext,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );
            expect(find.byType(RemoteChatScreen), findsNothing);

            // The user picks Personal before the switch's save lands.
            unawaited(
              auth.selectWorkspaceContext(const WorkspaceContext.personal()),
            );
            await tester.pumpAndSettle();
            store.releaseFirstWrite();
            await tester.pumpAndSettle();

            expect(auth.workspaceContext, const WorkspaceContext.personal());
            expect(find.byType(RemoteChatScreen), findsNothing);
            expect(
              await store.read(auth.user!.id),
              const WorkspaceContext.personal(),
            );
            expect(coordinator.pendingTap.value, isNull);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          },
        );

        testWidgets(
          'losing the owner while the switch saves keeps the chat closed',
          (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            final store = _HeldFirstWriteContextStore();
            var memberships = workspaceContextOrganizations();
            final auth = await signIn(
              tester,
              () async => memberships,
              store: store,
            );
            await pumpWithAuth(tester, coordinator, auth);

            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-acme'}),
            );
            await tester.pumpAndSettle();
            expect(
              auth.workspaceContext,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );

            // The user leaves the owner before the switch's save lands.
            memberships = [
              for (final org in memberships)
                if (org.id != workspaceContextOrgA) org,
            ];
            await tester.runAsync(auth.reloadOrganizations);
            await tester.pumpAndSettle();
            store.releaseFirstWrite();
            await tester.pumpAndSettle();

            expect(auth.workspaceContext, const WorkspaceContext.personal());
            expect(find.byType(RemoteChatScreen), findsNothing);
            expect(
              find.text("Couldn't switch context. Try again."),
              findsOneWidget,
            );
            expect(
              await store.read(auth.user!.id),
              const WorkspaceContext.personal(),
            );
            expect(coordinator.pendingTap.value, isNull);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          },
        );

        testWidgets(
          'a failed reload while the switch saves keeps the chat closed '
          'and the choice for the next load',
          (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            final store = _HeldFirstWriteContextStore();
            var loadFails = false;
            final auth = await signIn(tester, () async {
              if (loadFails) throw StateError('offline');
              return workspaceContextOrganizations();
            }, store: store);
            await pumpWithAuth(tester, coordinator, auth);

            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-acme'}),
            );
            await tester.pumpAndSettle();
            expect(
              auth.workspaceContext,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );

            // Memberships fail to load before the switch's save lands.
            loadFails = true;
            await tester.runAsync(auth.reloadOrganizations);
            await tester.pumpAndSettle();
            store.releaseFirstWrite();
            await tester.pumpAndSettle();

            expect(auth.organizationsLoadFailed, isTrue);
            expect(auth.workspaceContext, const WorkspaceContext.personal());
            expect(find.byType(RemoteChatScreen), findsNothing);
            expect(
              find.text("Couldn't switch context. Try again."),
              findsOneWidget,
            );
            expect(coordinator.pendingTap.value, isNull);

            // The next load restores the saved owner; Retry then opens.
            loadFails = false;
            await tester.runAsync(auth.reloadOrganizations);
            await tester.pumpAndSettle();
            expect(
              auth.workspaceContext,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );
            await tester.tap(find.text('Retry'));
            await tester.pumpAndSettle();

            expect(find.byType(RemoteChatScreen), findsOneWidget);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          },
        );

        // Desktop B, paired after desktop A, with its own organization A
        // project and none of desktop A's chats.
        Map<String, dynamic> desktopB() => _withProject(
          const {
            'workspaces': <Object?>[],
            'worktrees': <Object?>[],
            'standaloneChats': <Object?>[],
            'chatSummaries': <Object?>[],
          },
          localId: 'ws-b',
          owner: const {
            'type': 'organization',
            'organizationId': workspaceContextOrgA,
            'projectId': 'project-b',
          },
        );

        for (final (kind, chatId) in [
          ('standalone', 'chat-acme'),
          ('worktree', 'tab-acme'),
        ]) {
          testWidgets(
            'a re-pair while the switch saves keeps the earlier desktop\'s '
            '$kind chat closed',
            (tester) async {
              final coordinator = buildCoordinator();
              addTearDown(() => unawaited(coordinator.dispose()));
              final store = _HeldFirstWriteContextStore();
              final auth = await signIn(
                tester,
                () async => workspaceContextOrganizations(),
                store: store,
              );
              var desktop = workspaceContextShellState();
              final repository = FakeRemoteControlRepository();
              final viewModel = await pumpWithAuth(
                tester,
                coordinator,
                auth,
                shellState: () => desktop,
                repository: repository,
              );
              final pairing = viewModel.sessionGeneration;

              coordinator.requestOpen(
                PushMessage(data: {'clientChatId': chatId}),
              );
              await tester.pumpAndSettle();
              expect(
                auth.workspaceContext,
                const WorkspaceContext.organization(workspaceContextOrgA),
              );

              // The user pairs desktop B before the switch's save lands.
              desktop = desktopB();
              await tester.runAsync(viewModel.disconnect);
              await tester.runAsync(() => viewModel.connect('654321'));
              await tester.pumpAndSettle();
              expect(viewModel.sessionGeneration, isNot(pairing));
              expect(viewModel.status, RemoteConnectionStatus.connected);
              store.releaseFirstWrite();
              await tester.pumpAndSettle();

              expect(find.byType(RemoteChatScreen), findsNothing);
              expect(
                repository.requestChatTranscriptTargets.map((t) => t.chatId),
                isNot(contains(chatId)),
              );
              expect(coordinator.pendingTap.value, isNull);
              expect(tester.takeException(), isNull);
              await tester.pumpWidget(const SizedBox());
            },
          );
        }

        testWidgets(
          'a tap for the new desktop made while a stale switch saves opens',
          (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            final store = _HeldFirstWriteContextStore();
            final auth = await signIn(
              tester,
              () async => workspaceContextOrganizations(),
              store: store,
            );
            var desktop = workspaceContextShellState();
            final viewModel = await pumpWithAuth(
              tester,
              coordinator,
              auth,
              shellState: () => desktop,
            );

            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-acme'}),
            );
            await tester.pumpAndSettle();
            desktop = desktopB();
            await tester.runAsync(viewModel.disconnect);
            await tester.runAsync(() => viewModel.connect('654321'));
            await tester.pumpAndSettle();
            // Desktop B's own chat is tapped while the stale switch saves.
            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-ws-b'}),
            );
            await tester.pumpAndSettle();
            store.releaseFirstWrite();
            await tester.pumpAndSettle();

            final screen = tester.widget<RemoteChatScreen>(
              find.byType(RemoteChatScreen),
            );
            expect(screen.standaloneChat?.localId, 'chat-ws-b');
            expect(coordinator.pendingTap.value, isNull);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          },
        );

        // The context provider updates on the next frame, as the shell
        // reads it; a tap handled before it must follow the live context.
        WorkspaceContext? providedContext(WidgetTester tester) => tester
            .element(find.byType(PushTapBinding))
            .read<WorkspaceContext?>();

        testWidgets(
          'a tap that arrives before the frame after losing the owner '
          'keeps the chat closed',
          (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            var memberships = workspaceContextOrganizations();
            final auth = await signIn(tester, () async => memberships);
            await tester.runAsync(
              () => auth.selectWorkspaceContext(
                const WorkspaceContext.organization(workspaceContextOrgA),
              ),
            );
            await pumpWithAuth(tester, coordinator, auth);
            expect(
              providedContext(tester),
              const WorkspaceContext.organization(workspaceContextOrgA),
            );

            // The user leaves the owner; the tap arrives before a frame.
            memberships = [
              for (final org in memberships)
                if (org.id != workspaceContextOrgA) org,
            ];
            await tester.runAsync(auth.reloadOrganizations);
            expect(auth.workspaceContext, const WorkspaceContext.personal());
            expect(
              providedContext(tester),
              const WorkspaceContext.organization(workspaceContextOrgA),
            );
            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-acme'}),
            );
            await tester.pumpAndSettle();

            expect(auth.workspaceContext, const WorkspaceContext.personal());
            expect(find.byType(RemoteChatScreen), findsNothing);
            expect(
              find.text("Couldn't switch context. Try again."),
              findsOneWidget,
            );
            expect(coordinator.pendingTap.value, isNull);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          },
        );

        testWidgets('a tap that arrives before the frame after a newer choice '
            'switches back to the owner, then opens', (tester) async {
          final coordinator = buildCoordinator();
          addTearDown(() => unawaited(coordinator.dispose()));
          final auth = await signIn(
            tester,
            () async => workspaceContextOrganizations(),
          );
          await tester.runAsync(
            () => auth.selectWorkspaceContext(
              const WorkspaceContext.organization(workspaceContextOrgA),
            ),
          );
          await pumpWithAuth(tester, coordinator, auth);
          expect(
            providedContext(tester),
            const WorkspaceContext.organization(workspaceContextOrgA),
          );

          // The user picks Personal; the tap arrives before a frame.
          await tester.runAsync(
            () =>
                auth.selectWorkspaceContext(const WorkspaceContext.personal()),
          );
          expect(
            providedContext(tester),
            const WorkspaceContext.organization(workspaceContextOrgA),
          );
          coordinator.requestOpen(
            const PushMessage(data: {'clientChatId': 'chat-acme'}),
          );
          await tester.pumpAndSettle();

          expect(find.byType(RemoteChatScreen), findsOneWidget);
          expect(
            auth.workspaceContext,
            const WorkspaceContext.organization(workspaceContextOrgA),
          );
          expect(coordinator.pendingTap.value, isNull);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        });
        group('a chat whose owner is unresolved', () {
          Future<AuthViewModel> signInTo(
            WidgetTester tester,
            WorkspaceContext context,
          ) async {
            final auth = await signIn(
              tester,
              () async => workspaceContextOrganizations(),
            );
            await tester.runAsync(() => auth.selectWorkspaceContext(context));
            return auth;
          }

          void expectClosedWithRetry(
            WidgetTester tester,
            AuthViewModel auth,
            PushMessageCoordinator coordinator,
            WorkspaceContext context,
          ) {
            expect(auth.workspaceContext, context);
            expect(find.byType(RemoteChatScreen), findsNothing);
            expect(
              find.text("Couldn't switch context. Try again."),
              findsOneWidget,
            );
            expect(coordinator.pendingTap.value, isNull);
            expect(tester.takeException(), isNull);
          }

          testWidgets(
            'stays closed in Personal when its project is missing, then '
            'Retry opens it once the owner resolves',
            (tester) async {
              final coordinator = buildCoordinator();
              addTearDown(() => unawaited(coordinator.dispose()));
              final auth = await signInTo(
                tester,
                const WorkspaceContext.personal(),
              );
              var shellState = workspaceContextShellState();
              final viewModel = await pumpWithAuth(
                tester,
                coordinator,
                auth,
                shellState: () => shellState,
              );

              coordinator.requestOpen(
                const PushMessage(data: {'clientChatId': 'chat-orphan'}),
              );
              await tester.pumpAndSettle();

              expectClosedWithRetry(
                tester,
                auth,
                coordinator,
                const WorkspaceContext.personal(),
              );

              // The desktop now reports the project, owned by organization A.
              shellState = _withProject(
                workspaceContextShellState(),
                localId: 'ws-missing',
                owner: {
                  'type': 'organization',
                  'organizationId': workspaceContextOrgA,
                },
              );
              await tester.runAsync(viewModel.refresh);
              await tester.tap(find.text('Retry'));
              await tester.pumpAndSettle();

              expect(
                auth.workspaceContext,
                const WorkspaceContext.organization(workspaceContextOrgA),
              );
              expect(find.byType(RemoteChatScreen), findsOneWidget);
              expect(tester.takeException(), isNull);
              await tester.pumpWidget(const SizedBox());
            },
          );

          testWidgets(
            'stays closed in an organization when its project is missing',
            (tester) async {
              final coordinator = buildCoordinator();
              addTearDown(() => unawaited(coordinator.dispose()));
              final auth = await signInTo(
                tester,
                const WorkspaceContext.organization(workspaceContextOrgA),
              );
              await pumpWithAuth(tester, coordinator, auth);

              coordinator.requestOpen(
                const PushMessage(data: {'clientChatId': 'chat-orphan'}),
              );
              await tester.pumpAndSettle();

              expectClosedWithRetry(
                tester,
                auth,
                coordinator,
                const WorkspaceContext.organization(workspaceContextOrgA),
              );
              await tester.pumpWidget(const SizedBox());
            },
          );

          testWidgets('stays closed when its project owner is malformed, for '
              'standalone and worktree chats', (tester) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            final auth = await signInTo(
              tester,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );
            // An organization owner without an id belongs to no context.
            await pumpWithAuth(
              tester,
              coordinator,
              auth,
              shellState: () => _withProject(
                workspaceContextShellState(),
                localId: 'ws-malformed',
                owner: {'type': 'organization'},
              ),
            );

            for (final chatId in ['chat-ws-malformed', 'tab-ws-malformed']) {
              coordinator.requestOpen(
                PushMessage(data: {'clientChatId': chatId}),
              );
              await tester.pumpAndSettle();

              expectClosedWithRetry(
                tester,
                auth,
                coordinator,
                const WorkspaceContext.organization(workspaceContextOrgA),
              );
            }
            await tester.pumpWidget(const SizedBox());
          });

          testWidgets(
            'a project without an owner field still opens in Personal',
            (tester) async {
              final coordinator = buildCoordinator();
              addTearDown(() => unawaited(coordinator.dispose()));
              final auth = await signInTo(
                tester,
                const WorkspaceContext.organization(workspaceContextOrgA),
              );
              await pumpWithAuth(
                tester,
                coordinator,
                auth,
                shellState: () => workspaceContextShellState(withOwners: false),
              );

              coordinator.requestOpen(
                const PushMessage(data: {'clientChatId': 'chat-acme'}),
              );
              await tester.pumpAndSettle();

              expect(auth.workspaceContext, const WorkspaceContext.personal());
              expect(find.byType(RemoteChatScreen), findsOneWidget);
              expect(tester.takeException(), isNull);
              await tester.pumpWidget(const SizedBox());
            },
          );

          testWidgets('a projectless chat still opens in Personal', (
            tester,
          ) async {
            final coordinator = buildCoordinator();
            addTearDown(() => unawaited(coordinator.dispose()));
            final auth = await signInTo(
              tester,
              const WorkspaceContext.organization(workspaceContextOrgA),
            );
            await pumpWithAuth(tester, coordinator, auth);

            coordinator.requestOpen(
              const PushMessage(data: {'clientChatId': 'chat-loose'}),
            );
            await tester.pumpAndSettle();

            expect(auth.workspaceContext, const WorkspaceContext.personal());
            expect(find.byType(RemoteChatScreen), findsOneWidget);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
          });
        });
      });
    });

    testWidgets('navigates to the worktree chat screen when connected', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [
          RemoteWorkspace(
            localId: 'ws-1',
            name: 'acme',
            type: RemoteWorkspaceType.singleRepo,
          ),
        ],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      // Connect via runAsync for consistency with this suite's established
      // pattern for driving a RemoteControlViewModel under testWidgets (see
      // remote_chat_screen_test.dart, where it's required because that
      // repository's Future.delayed latency never resolves under FakeAsync
      // without it). This fixture's FakeRemoteControlRepository has no
      // artificial latency, so a direct await would likely also work here —
      // runAsync is kept for uniformity with the rest of the suite, not
      // because this specific call is known to hang without it.
      await tester.runAsync(() => viewModel.connect('123456'));

      final tabController = HomeTabController(tabs: organizationHomeTabs)
        ..select(HomeTab.account);
      viewModel.setRemoteVisible(false);
      final coordinator = buildCoordinator();
      addTearDown(() => unawaited(coordinator.dispose()));

      await tester.pumpWidget(
        buildSubject(
          viewModel: viewModel,
          tabController: tabController,
          coordinator: coordinator,
        ),
      );
      await tester.pumpAndSettle();

      coordinator.requestOpen(
        const PushMessage(data: {'worktreeId': 'wt-1', 'clientChatId': 'c9'}),
      );
      await tester.pumpAndSettle();

      expect(find.byType(RemoteChatScreen), findsOneWidget);
      expect(tabController.value, HomeTab.account);
      final fetchesBeforePause = repository.snapshotFetches;
      await viewModel.setHooksPaused(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        paused: true,
      );
      await tester.pump(const Duration(seconds: 2));
      // The desktop's hook events update the drawer; the overview carries
      // no hooks, so a pause reads none (CAN-4875).
      expect(repository.snapshotFetches, fetchesBeforePause);
      Navigator.of(tester.element(find.byType(RemoteChatScreen))).pop();
      await tester.pumpAndSettle();
      final fetchesAfterPop = repository.snapshotFetches;
      await viewModel.setHooksPaused(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        paused: false,
      );
      await tester.pump(const Duration(seconds: 2));
      expect(repository.snapshotFetches, fetchesAfterPop);
      expect(coordinator.pendingTap.value, isNull);
      await tester.pumpWidget(const SizedBox());
      viewModel.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'finds a hidden standalone chat before the overview throttle expires',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'ws-1',
              name: 'acme',
              type: RemoteWorkspaceType.singleRepo,
            ),
          ],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: const Duration(milliseconds: 1200),
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.runAsync(viewModel.refresh);
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.account);
        viewModel.setRemoteVisible(false);
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));
        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();

        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'ws-1',
              name: 'acme',
              type: RemoteWorkspaceType.singleRepo,
            ),
          ],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [
            RemoteStandaloneChat(
              localId: 'new-chat',
              projectLocalId: 'ws-1',
              title: 'New chat',
            ),
          ],
        );
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'overview',
                  'removed': [
                    {'entityType': 'standalone_chat', 'localId': 'old-chat'},
                  ],
                },
              },
            ],
          }),
        );
        await tester.pump();
        expect(repository.snapshotFetches, 2);

        coordinator.requestOpen(
          const PushMessage(data: {'clientChatId': 'new-chat'}),
        );
        await tester.pump(const Duration(seconds: 9));
        await tester.pump();

        expect(find.byType(RemoteChatScreen), findsOneWidget);
        expect(repository.snapshotFetches, 3);
        expect(tabController.value, HomeTab.account);
        expect(coordinator.pendingTap.value, isNull);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        viewModel.dispose();
        await tester.pumpAndSettle();
      },
    );

    for (final capable in [false, true]) {
      testWidgets(
        'hydrates server-id push taps with negotiated summaries: $capable',
        (tester) async {
          usePhoneViewport(tester);
          final repository = _PushHydratingRepository()
            ..supportsForegroundChat = capable
            ..supportsWorktreeChatSummariesScope = capable;
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => viewModel.connect('123456'));

          final tabController = HomeTabController(tabs: organizationHomeTabs)
            ..select(HomeTab.account);
          final coordinator = buildCoordinator();
          addTearDown(() => unawaited(coordinator.dispose()));

          await tester.pumpWidget(
            buildSubject(
              viewModel: viewModel,
              tabController: tabController,
              coordinator: coordinator,
            ),
          );
          await tester.pumpAndSettle();

          coordinator.requestOpen(
            const PushMessage(
              data: {
                'worktreeId': 'server-worktree-uuid',
                'clientChatId': 'chat-9',
              },
            ),
          );
          await tester.pumpAndSettle();

          expect(repository.requestWorktreeStateCalls, capable ? 0 : 1);
          expect(
            repository.requestWorktreeChatSummariesStateCalls,
            capable ? 1 : 0,
          );
          expect(viewModel.worktreeForChatId('chat-9')?.localId, 'wt-1');
          expect(find.byType(RemoteChatScreen), findsOneWidget);
          expect(coordinator.pendingTap.value, isNull);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
          viewModel.dispose();
        },
      );
    }

    testWidgets(
      'a re-pair while a tap waits for hydration drops the tap at once',
      (tester) async {
        usePhoneViewport(tester);
        var desktop = workspaceContextShellState();
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson(desktop);
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        addTearDown(viewModel.dispose);
        await tester.runAsync(() => viewModel.connect('123456'));
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.remote);
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));
        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();

        // Desktop A has not hydrated this chat yet, so the tap waits.
        coordinator.requestOpen(
          const PushMessage(data: {'clientChatId': 'chat-later'}),
        );
        await tester.pumpAndSettle();
        expect(repository.requestWorktreeStateCalls, greaterThan(0));
        expect(coordinator.pendingTap.value, isNotNull);

        // The user pairs another desktop from Remote meanwhile.
        desktop = {
          'workspaces': <Object?>[],
          'worktrees': <Object?>[],
          'standaloneChats': <Object?>[],
        };
        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pumpAndSettle();

        expect(coordinator.pendingTap.value, isNull);
        await tester.pump(const Duration(seconds: 11));
        await tester.pumpAndSettle();
        expect(tabController.value, HomeTab.remote);
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );

    testWidgets(
      'a tap arriving while an earlier tap is still being handled is not lost',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'ws-1',
              name: 'acme',
              type: RemoteWorkspaceType.singleRepo,
            ),
          ],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));

        // Start above 0 so the fallback branch below is observably the one
        // that ran, not just the controller's default.
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.account);
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));

        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();

        // First tap targets a worktree that doesn't exist (resolves to the
        // feed fallback). Second tap is requested synchronously, before the
        // first tap's `await viewModel.restoreIfIdle()` has had a chance to
        // resume (every `await`, even on an already-completed Future, yields
        // at least one microtask turn) — so it lands in [PushTapBinding]'s
        // `pendingTap` listener while `_handling` is still true for the
        // first tap, and the listener invocation for it is swallowed by the
        // guard. The `finally` block's message-identity check must then
        // notice the slot no longer holds the first tap's message and
        // re-enter handling for the second one, rather than clearing it
        // unconditionally and losing it. If that fix regresses, only the
        // fallback tab flips and RemoteChatScreen is never pushed.
        coordinator.requestOpen(
          const PushMessage(
            data: {'worktreeId': 'missing', 'clientChatId': 'missing'},
          ),
        );
        coordinator.requestOpen(
          const PushMessage(data: {'worktreeId': 'wt-1', 'clientChatId': 'c9'}),
        );
        // The first tap now waits through the bounded hydration window before
        // falling back; advance that timer so handling can continue to the
        // second tap.
        await tester.pump(const Duration(seconds: 10));
        await tester.pumpAndSettle();

        // Both taps' effects are observed: the first tap's fallback ran...
        expect(tabController.value, HomeTab.activity);
        // ...and the second tap's navigation also ran, rather than being
        // discarded by the first tap's unconditional clearPendingTap().
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        expect(coordinator.pendingTap.value, isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'a tap remains pending when the binding is disposed during resolution',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'ws-1',
              name: 'acme',
              type: RemoteWorkspaceType.singleRepo,
            ),
          ],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        addTearDown(viewModel.dispose);

        final tabController = HomeTabController(tabs: organizationHomeTabs);
        final coordinator = buildCoordinator();
        addTearDown(() => unawaited(coordinator.dispose()));

        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();

        const message = PushMessage(
          data: {'worktreeId': 'missing', 'clientChatId': 'missing'},
        );
        coordinator.requestOpen(message);
        await tester.pump();

        // Replace the authenticated subtree while deep-link hydration is
        // still waiting. The old binding must not consume the tap on exit.
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(kRemoteHydrationTimeout);

        expect(coordinator.pendingTap.value, same(message));
        expect(tester.takeException(), isNull);
      },
    );

    group('through the native notification paths (CAN-3642)', () {
      Future<RemoteControlViewModel> connected(WidgetTester tester) async {
        final viewModel = RemoteControlViewModel(
          repository: Can3642Repository(),
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        return viewModel;
      }

      void deliverForeground(FakePushMessaging messaging) {
        for (final push in can3642Pushes) {
          messaging.emitForegroundMessage(push);
        }
      }

      testWidgets(
        'a cold-start launch opens its chat once the shell mounts, unmoved '
        'by foreground pushes',
        (tester) async {
          usePhoneViewport(tester);
          final messaging = FakePushMessaging()
            ..initialMessage = const PushMessage(
              data: {'worktreeId': 'wt-1', 'clientChatId': can3642ChatId},
            );
          final coordinator = buildCoordinator(messaging);
          addTearDown(() => unawaited(coordinator.dispose()));
          await tester.pump();
          deliverForeground(messaging);
          await tester.pump();
          expect(
            coordinator.pendingTap.value?.data['clientChatId'],
            can3642ChatId,
          );

          // The shell mounts after auth/session restore.
          final viewModel = await connected(tester);
          final tabController = HomeTabController(tabs: organizationHomeTabs)
            ..select(HomeTab.account);
          await tester.pumpWidget(
            buildSubject(
              viewModel: viewModel,
              tabController: tabController,
              coordinator: coordinator,
            ),
          );
          await tester.pumpAndSettle();

          expect(find.byType(RemoteChatScreen), findsOneWidget);
          expect(coordinator.pendingTap.value, isNull);
          deliverForeground(messaging);
          await tester.pumpAndSettle();
          expect(find.byType(RemoteChatScreen), findsOneWidget);
          expect(find.byType(SnackBar), findsNothing);
          expect(coordinator.pendingTap.value, isNull);
          await tester.pumpWidget(const SizedBox.shrink());
          viewModel.dispose();
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('an empty cold-start read navigates nowhere', (tester) async {
        usePhoneViewport(tester);
        final messaging = FakePushMessaging();
        final coordinator = buildCoordinator(messaging);
        addTearDown(() => unawaited(coordinator.dispose()));
        final viewModel = await connected(tester);
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.account);
        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();
        deliverForeground(messaging);
        await tester.pumpAndSettle();

        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(tabController.value, HomeTab.account);
        expect(coordinator.pendingTap.value, isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        viewModel.dispose();
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'a background tap opens its chat while foreground pushes do nothing',
        (tester) async {
          usePhoneViewport(tester);
          final messaging = FakePushMessaging();
          final coordinator = buildCoordinator(messaging);
          addTearDown(() => unawaited(coordinator.dispose()));
          final viewModel = await connected(tester);
          final tabController = HomeTabController(tabs: organizationHomeTabs)
            ..select(HomeTab.account);
          await tester.pumpWidget(
            buildSubject(
              viewModel: viewModel,
              tabController: tabController,
              coordinator: coordinator,
            ),
          );
          await tester.pumpAndSettle();

          deliverForeground(messaging);
          await tester.pumpAndSettle();
          expect(find.byType(RemoteChatScreen), findsNothing);
          expect(tabController.value, HomeTab.account);

          messaging.emitNotificationOpened(
            const PushMessage(
              data: {'worktreeId': 'wt-1', 'clientChatId': can3642ChatId},
            ),
          );
          deliverForeground(messaging);
          await tester.pumpAndSettle();
          expect(find.byType(RemoteChatScreen), findsOneWidget);
          expect(coordinator.pendingTap.value, isNull);

          // Leaving the chat and more foreground pushes reopen nothing.
          Navigator.of(tester.element(find.byType(RemoteChatScreen))).pop();
          await tester.pumpAndSettle();
          deliverForeground(messaging);
          await tester.pump(const Duration(seconds: 7));
          await tester.pumpAndSettle();
          expect(find.byType(RemoteChatScreen), findsNothing);
          expect(find.byType(SnackBar), findsNothing);
          await tester.pumpWidget(const SizedBox.shrink());
          viewModel.dispose();
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('a pipeline notification tap lands on the feed', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final messaging = FakePushMessaging();
        final coordinator = buildCoordinator(messaging);
        addTearDown(() => unawaited(coordinator.dispose()));
        final viewModel = await connected(tester);
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.account);
        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();

        messaging.emitNotificationOpened(can3642Pushes.first);
        // The unresolved chat id waits through the bounded hydration window.
        await tester.pump(const Duration(seconds: 10));
        await tester.pumpAndSettle();

        expect(tabController.value, HomeTab.activity);
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(coordinator.pendingTap.value, isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        viewModel.dispose();
        expect(tester.takeException(), isNull);
      });

      testWidgets('a tap after sign-out and sign-in still navigates', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final messaging = FakePushMessaging();
        final coordinator = buildCoordinator(messaging);
        addTearDown(() => unawaited(coordinator.dispose()));
        final viewModel = await connected(tester);
        final tabController = HomeTabController(tabs: organizationHomeTabs)
          ..select(HomeTab.account);
        await tester.pumpWidget(
          buildSubject(
            viewModel: viewModel,
            tabController: tabController,
            coordinator: coordinator,
          ),
        );
        await tester.pumpAndSettle();

        // Stream cancellation needs a real async zone (see dispose above).
        await tester.runAsync(coordinator.stop);
        messaging.emitNotificationOpened(
          const PushMessage(data: {'worktreeId': 'wt-1', 'clientChatId': 'x'}),
        );
        deliverForeground(messaging);
        await tester.pumpAndSettle();
        expect(find.byType(RemoteChatScreen), findsNothing);
        expect(tabController.value, HomeTab.account);

        await tester.runAsync(coordinator.start);
        deliverForeground(messaging);
        messaging.emitNotificationOpened(
          const PushMessage(
            data: {'worktreeId': 'wt-1', 'clientChatId': can3642ChatId},
          ),
        );
        // The restarted subscription lives in the real zone.
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pumpAndSettle();
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        expect(coordinator.pendingTap.value, isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        viewModel.dispose();
        expect(tester.takeException(), isNull);
      });
    });
  });
}

final class _RestoringRepository extends FakeRemoteControlRepository {
  final Completer<RemoteConnection?> _restore = Completer<RemoteConnection?>();

  _RestoringRepository() {
    snapshotBuilder = () => const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-1',
          name: 'acme',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
      ],
      standaloneChats: [],
    );
  }

  @override
  Future<RemoteConnection?> restoreSession() => _restore.future;

  void completeRestore() {
    _restore.complete(
      RemoteConnection(deviceLabel: 'Test Desktop', pairedAt: DateTime(2026)),
    );
  }
}

final class _PushHydratingRepository extends FakeRemoteControlRepository {
  _PushHydratingRepository() {
    snapshotBuilder = () => const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-1',
          name: 'acme',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
      ],
      standaloneChats: [],
    );
  }

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    requestWorktreeStateCalls += 1;
    _emitSummaries('worktree', workspaceLocalId, worktreeLocalId);
  }

  @override
  Future<void> requestWorktreeChatSummariesState() async {
    requestWorktreeChatSummariesStateCalls++;
    _emitSummaries('worktree_chat_summaries', 'ws-1', 'wt-1');
  }

  void _emitSummaries(
    String scope,
    String workspaceLocalId,
    String worktreeLocalId,
  ) {
    eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateSnapshotEvent(
            scope: scope,
            targetWorkspaceLocalId: scope == 'worktree'
                ? workspaceLocalId
                : null,
            targetWorktreeLocalId: scope == 'worktree' ? worktreeLocalId : null,
            chatSummaries: const [
              RemoteChatSummary(
                chatId: 'chat-9',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Hydrated chat',
                active: true,
              ),
            ],
          ),
        ],
        nextCursor: 1,
      ),
    );
  }
}

/// Fails every write, like a device that cannot save preferences.
final class _FailingContextStore implements WorkspaceContextStore {
  @override
  Future<WorkspaceContext?> read(String accountId) async => null;

  @override
  Future<void> write(String accountId, WorkspaceContext context) async =>
      throw StateError('disk full');
}

/// Holds the first write until [releaseFirstWrite], like a slow disk.
final class _HeldFirstWriteContextStore implements WorkspaceContextStore {
  final Map<String, WorkspaceContext> _saved = {};
  final Completer<void> _firstWrite = Completer<void>();
  bool _held = false;

  void releaseFirstWrite() => _firstWrite.complete();

  @override
  Future<WorkspaceContext?> read(String accountId) async => _saved[accountId];

  @override
  Future<void> write(String accountId, WorkspaceContext context) async {
    if (!_held) {
      _held = true;
      await _firstWrite.future;
    }
    _saved[accountId] = context;
  }
}

/// [state] plus project [localId] with [owner], one worktree chat
/// (`tab-<localId>`) and one standalone chat (`chat-<localId>`) in it.
Map<String, dynamic> _withProject(
  Map<String, dynamic> state, {
  required String localId,
  required Map<String, dynamic> owner,
}) => {
  ...state,
  'workspaces': [
    ...state['workspaces'] as List<Object?>,
    {
      'localId': localId,
      'name': 'Project $localId',
      'type': 'single-repo',
      'order': 9,
      'owner': owner,
    },
  ],
  'worktrees': [
    ...state['worktrees'] as List<Object?>,
    {
      'localId': 'wt-$localId',
      'workspaceLocalId': localId,
      'branch': 'task-$localId',
      'label': 'Task $localId',
      'lastActivityAt': '2026-10-18T07:00:00Z',
    },
  ],
  'standaloneChats': [
    ...state['standaloneChats'] as List<Object?>,
    {
      'localId': 'chat-$localId',
      'projectLocalId': localId,
      'title': 'Chat $localId',
      'lastMessageAt': '2026-10-18T07:30:00Z',
    },
  ],
  'chatSummaries': [
    ...state['chatSummaries'] as List<Object?>,
    {
      'chatId': 'tab-$localId',
      'scope': 'worktree',
      'worktreeLocalId': 'wt-$localId',
      'title': 'Task $localId chat',
      'lastMessageAt': '2026-10-18T07:00:00Z',
    },
  ],
};

final class _CountingFeedRepository implements FeedRepository {
  int calls = 0;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async {
    calls++;
    return const FeedPageResponse(items: []);
  }

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}
