import 'dart:async';
import 'dart:convert';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/chat_search_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/reduced_motion.dart';
import '../../../support/remote_session_fake_server.dart';
import '../../../support/rebuild_counter.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_archive_row.dart';

final class _RetryableSnapshotRepository extends FakeRemoteControlRepository {
  var failNextSnapshot = true;

  @override
  Future<RemoteConnection> connect(String pairingCode) async =>
      RemoteConnection(deviceLabel: 'Test Desktop', pairedAt: DateTime(2026));

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    snapshotFetches += 1;
    if (failNextSnapshot) {
      failNextSnapshot = false;
      throw const RemoteControlException('snapshot unavailable');
    }
    return const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-recovered',
          name: 'Recovered workspace',
          rootPath: '~/code/recovered',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [],
      standaloneChats: [],
    );
  }
}

/// Counts restore probes and can hand back a stale-but-revivable session, so
/// the lifecycle tests can assert what a foreground actually does (CAN-2651).
final class _LifecycleRestoreRepository extends FakeRemoteControlRepository {
  _LifecycleRestoreRepository({this.connectionStatus});

  final RemotePortalConnectionStatus? connectionStatus;
  int restoreCalls = 0;

  @override
  Future<RemoteConnection?> restoreSession() async {
    restoreCalls += 1;
    if (connectionStatus == null) return null;
    return RemoteConnection(
      deviceLabel: 'Test Desktop',
      pairedAt: DateTime(2026),
      connectionStatus: connectionStatus,
    );
  }
}

/// Answers the first [unreachableProbes] session probes as unreachable, then
/// restores a live session.
final class _UnreachableRestoreRepository extends FakeRemoteControlRepository {
  _UnreachableRestoreRepository({required this.unreachableProbes});

  final int unreachableProbes;
  int probeCalls = 0;

  @override
  Future<RemoteSessionProbe> probeSession() async {
    probeCalls += 1;
    // A real probe spends frames on the network; the form must survive them.
    await Future<void>.delayed(const Duration(milliseconds: 200));
    if (probeCalls <= unreachableProbes) {
      return (outcome: RemoteSessionProbeOutcome.unknown, connection: null);
    }
    return (
      outcome: RemoteSessionProbeOutcome.renderable,
      connection: RemoteConnection(
        deviceLabel: 'Test Desktop',
        pairedAt: DateTime(2026),
        connectionStatus: RemotePortalConnectionStatus.active,
      ),
    );
  }
}

/// Restores straight into a connected session with a chosen device label and
/// liveness, so the app bar title can be exercised per connection status
/// without driving the six-digit pairing form first.
final class _TitleRepository extends FakeRemoteControlRepository {
  _TitleRepository({
    this.deviceLabel = 'MacBook-Pro.local',
    this.connectionStatus,
    this.lastSeenAt,
  });

  final String deviceLabel;
  final RemotePortalConnectionStatus? connectionStatus;
  final DateTime? lastSeenAt;

  @override
  Future<RemoteConnection?> restoreSession() async => RemoteConnection(
    deviceLabel: deviceLabel,
    pairedAt: DateTime(2026),
    connectionStatus: connectionStatus,
    lastSeenAt: lastSeenAt,
  );
}

/// The pairing instructions the connect form must render, in order. Step 1
/// names the desktop app by the product name it actually ships under
/// (`Unstoppable Code`), not the short name the mobile app uses for itself.
final List<String> _pairingSteps = <String>[
  'Open ${Brand.productDisplayName} on your computer',
  'Click Remote Control in the account menu',
  'Click Enable Remote Control — your 6-digit code appears',
];

void main() {
  group('RemoteScreen', () {
    // Fixture worktrees include busy/running rows whose always-on spinners
    // would keep pumpAndSettle from settling.
    useReducedMotion();

    // Phone-width viewport so any RenderFlex overflow surfaces as a real
    // exception instead of being hidden by an oversized test surface. Extra
    // tall so every lazily-built list row — including the ones pushed down
    // by the pinned attention block — is laid out for the assertions.
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 3600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget buildSubject({RemoteControlRepository? repository}) {
      return ChangeNotifierProvider<RemoteControlViewModel>(
        create: (_) => RemoteControlViewModel(
          repository:
              repository ?? MockRemoteControlRepository(latency: Duration.zero),
        ),
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const RemoteScreen(),
        ),
      );
    }

    for (final screen in <Widget>[
      const RemoteScreen(),
      const ChatSearchScreen(),
      const ConnectDesktopView(),
      const WorkspacesListView(),
      WorktreeArchiveRow(
        worktree: const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
        onTap: () {},
      ),
    ]) {
      testWidgets(
        '${screen.runtimeType} ignores unrelated transcript updates',
        (tester) async {
          usePhoneViewport(tester);
          final repo = FakeRemoteControlRepository()
            ..snapshotBuilder = () => const RemoteSessionSnapshot(
              workspaces: [
                RemoteWorkspace(
                  localId: 'ws-1',
                  name: 'Repository',
                  rootPath: '/repo',
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
          final vm = RemoteControlViewModel(repository: repo);
          addTearDown(vm.dispose);
          addTearDown(repo.eventsController.close);
          await vm.connect('123456');
          await tester.pumpWidget(
            ChangeNotifierProvider.value(
              value: vm,
              child: MaterialApp(
                theme: AppTheme.light,
                home: Scaffold(body: screen),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final counter = RebuildCounter();
          repo.eventsController.add(
            RemotePortalEventBatch(
              nextCursor: 1,
              events: [
                RemoteChatMessageEvent(
                  chatId: 'other',
                  scope: RemoteChatScope.standalone,
                  message: RemoteChatMessage(
                    messageId: 'm-1',
                    chatId: 'other',
                    role: ChatRole.assistant,
                    status: ChatMessageStatus.complete,
                    text: 'An unrelated update',
                    occurredAt: DateTime(2026),
                  ),
                ),
              ],
            ),
          );
          await tester.pump();
          await tester.pump();
          expect(
            vm.messagesFor(const RemoteStandaloneChatTarget(chatId: 'other')),
            hasLength(1),
          );
          expect(counter.of(screen.runtimeType), 0);
          expect(counter.of(CanopyAppBar), 0);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }

    testWidgets(
      'paired screen recovers from a temporary event gate without a code',
      (tester) async {
        var eventReads = 0;
        var available = false;
        final client = MockClient((request) async {
          if (request.url.path.endsWith('/session')) {
            return http.Response(
              jsonEncode({
                'session': {
                  'id': 'sess-1',
                  'status': 'active',
                  'connectionStatus': 'active',
                  'clientName': 'Test Desktop',
                },
              }),
              200,
            );
          }
          if (request.url.path.endsWith('/state')) {
            return http.Response('{"state":{},"eventCursor":0}', 200);
          }
          eventReads++;
          if (!available) return http.Response('{}', 404);
          return http.Response(
            '{"events":[],"nextCursor":7,"connectionStatus":"inactive"}',
            200,
          );
        });
        final api = ApiClient(
          baseUrl: 'https://example.test',
          tokenProvider: () => 'token',
          httpClient: client,
        );
        final repo = HttpRemoteControlRepository(
          recoveryClientFactory: () => client,
          service: RemoteControlApiService(apiClient: api),
          eventStream: PortalEventStream(
            baseUrl: 'https://example.test$portalBrowserBasePath',
            headersProvider: api.buildHeaders,
            clientFactory: () => client,
          ),
        );
        await tester.pumpWidget(buildSubject(repository: repo));
        await tester.pump();
        await tester.pump();
        expect(eventReads, 2);
        expect(find.byType(ConnectDesktopView), findsNothing);
        available = true;
        // The first reconnect step is at most 4 seconds.
        await tester.pump(const Duration(seconds: 4));
        await tester.pump();
        expect(eventReads, greaterThan(2));
        expect(find.byType(ConnectDesktopView), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(seconds: 2));
      },
    );

    /// [buildSubject] with the chrome `HomeShell` really wraps this tab in: a
    /// [Scaffold] whose `bottomNavigationBar` is a [NavigationBar]. Layout
    /// assertions need this — the bare host overstates the usable height.
    Widget buildShellSubject({
      RemoteControlRepository? repository,
      double textScale = 1.0,
    }) {
      return ChangeNotifierProvider<RemoteControlViewModel>(
        create: (_) => RemoteControlViewModel(
          repository:
              repository ?? MockRemoteControlRepository(latency: Duration.zero),
        ),
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: child ?? const SizedBox.shrink(),
          ),
          home: Scaffold(
            body: const RemoteScreen(),
            bottomNavigationBar: NavigationBar(
              selectedIndex: 0,
              destinations: const [
                NavigationDestination(
                  icon: Icon(Icons.forum),
                  label: 'Activity',
                ),
                NavigationDestination(
                  icon: Icon(Icons.group),
                  label: 'Members',
                ),
              ],
            ),
          ),
        ),
      );
    }

    Future<void> enterCodeAndConnect(WidgetTester tester, String code) async {
      await tester.enterText(find.byType(TextField), code);
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
      await tester.pumpAndSettle();
    }

    testWidgets('CAN-3102 expanding nine worktrees warms one summary batch', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..supportsWorktreeChatSummariesScope = true
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            {
              'localId': 'ws-1',
              'name': 'Nine worktrees',
              'type': 'single-repo',
            },
          ],
          'worktrees': [
            for (var i = 0; i < 9; i++)
              {
                'localId': 'wt-$i',
                'workspaceLocalId': 'ws-1',
                'branch': 'task-$i',
              },
          ],
          'standaloneChats': [],
        });
      repository.requestWorktreeChatSummariesHandler = () async {
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree_chat_summaries',
                chatSummaries: [
                  RemoteChatSummary(
                    chatId: 'chat-8',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-8',
                    title: 'Ninth chat',
                  ),
                ],
              ),
            ],
            nextCursor: 1,
          ),
        );
      };
      await tester.pumpWidget(buildSubject(repository: repository));
      await tester.pumpAndSettle();
      await enterCodeAndConnect(tester, '123456');
      expect(repository.requestWorktreeStateCalls, 0);
      await tester.tap(find.text('Nine worktrees'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 1));
      expect(repository.requestWorktreeStateCalls, 0);
      expect(repository.requestWorktreeChatSummariesStateCalls, 1);
      await tester.tap(find.text('Nine worktrees'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nine worktrees'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 1));
      expect(repository.requestWorktreeChatSummariesStateCalls, 1);
      await tester.tap(find.byTooltip('Remote options'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Search chats'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('chat-search-field')),
        'Ninth',
      );
      await tester.pumpAndSettle();
      expect(find.text('Ninth chat'), findsOneWidget);
      expect(repository.requestWorktreeChatSummariesStateCalls, 1);
      expect(repository.requestWorktreeStateCalls, 0);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('shows the chat search action when the desktop announces the '
        'summaries scope', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..supportsWorktreeChatSummariesScope = true;
      await tester.pumpWidget(buildSubject(repository: repository));
      await tester.pumpAndSettle();
      await enterCodeAndConnect(tester, '123456');

      expect(find.byTooltip('Search chats'), findsNothing);
      await tester.tap(find.byTooltip('Remote options'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Search chats'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatSearchScreen), findsOneWidget);

      // Expire any prefetch watchdogs armed by the connected list.
      await tester.pump(const Duration(minutes: 2));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('hides the chat search action without the capability', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        buildSubject(repository: FakeRemoteControlRepository()),
      );
      await tester.pumpAndSettle();
      await enterCodeAndConnect(tester, '123456');

      await tester.tap(find.byTooltip('Remote options'));
      await tester.pumpAndSettle();
      expect(find.text('Search chats'), findsNothing);

      await tester.pump(const Duration(minutes: 2));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows the connect form while disconnected', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Remote Control'), findsOneWidget);
      expect(find.text('Connect to your desktop'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the connect form names where the desktop shows the code', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // The pairing code is generated on the desktop, never here, so the form
      // has to name the exact place it appears instead of only asserting that
      // a code exists somewhere (CAN-2579). All three steps are pinned: step 1
      // names the desktop app, and it must use the full product name the
      // desktop ships under rather than the short name mobile calls itself.
      for (final step in _pairingSteps) {
        expect(find.text(step), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('fits the steps, the field and Connect above the bottom nav', (
      tester,
    ) async {
      // 375x667 logical — the smallest screen the app targets — measured in
      // the real shell. `buildSubject` hosts RemoteScreen bare, which hands it
      // the status-bar strip and the ~80pt NavigationBar that production
      // spends on chrome; measuring against the raw viewport would validate
      // roughly 100pt of room the user does not have.
      //
      // Content the user must scroll to reach is the bug this screen is
      // fixing, so the assertion covers the primary action too, not just the
      // steps: adding instructions above the field must not push Connect off.
      tester.view.physicalSize = const Size(1125, 2001);
      tester.view.devicePixelRatio = 3.0;
      tester.view.padding = const FakeViewPadding(top: 60);
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildShellSubject());
      await tester.pumpAndSettle();

      final double fold = tester.getRect(find.byType(NavigationBar)).top;

      // Measured against the instruction region's own scroll viewport, not
      // just the nav bar. `getRect` reports global geometry and knows nothing
      // about the enclosing clip, so a step can sit well above the fold while
      // being scrolled out of sight — which is exactly how a build that hid
      // steps 2 and 3 behind the pinned field passed an earlier version of
      // this test.
      final Finder form = find.descendant(
        of: find.byType(ConnectDesktopView),
        matching: find.byType(SingleChildScrollView),
      );
      final double formBottom = tester.getRect(form).bottom;

      // Nothing to scroll: on the smallest supported phone the whole form has
      // to be readable where it lands, not one gesture away. `.first` picks
      // the form's own Scrollable — the code field contributes a second one.
      //
      // This currently clears by only a few points, so a failure here most
      // likely means the form grew rather than that the layout broke; the
      // per-step clip assertions below carry more slack and are the sharper
      // signal for a real layout regression.
      expect(
        tester
            .state<ScrollableState>(
              find
                  .descendant(of: form, matching: find.byType(Scrollable))
                  .first,
            )
            .position
            .maxScrollExtent,
        0,
        reason: 'the form does not fit without scrolling',
      );
      for (final step in _pairingSteps) {
        expect(find.text(step), findsOneWidget);
        expect(
          tester.getRect(find.text(step)).bottom,
          lessThanOrEqualTo(formBottom),
          reason: 'step "$step" is clipped by the scroll viewport',
        );
        expect(
          tester.getRect(find.text(step)).bottom,
          lessThanOrEqualTo(fold),
          reason: 'step "$step" is below the fold',
        );
      }
      expect(
        tester.getRect(find.byType(TextField)).bottom,
        lessThanOrEqualTo(fold),
        reason: 'the code field is below the fold',
      );
      expect(
        tester.getRect(find.widgetWithText(FilledButton, 'Connect')).bottom,
        lessThanOrEqualTo(fold),
        reason: 'the Connect button is below the fold',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('keeps Connect above the fold once an error grows the field', (
      tester,
    ) async {
      // A rejected code adds `errorText` under the field, growing the pinned
      // region at the tightest real viewport. That is the one axis that can
      // push Connect back under the nav bar without any copy changing.
      tester.view.physicalSize = const Size(1125, 2001);
      tester.view.devicePixelRatio = 3.0;
      tester.view.padding = const FakeViewPadding(top: 60);
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildShellSubject());
      await tester.pumpAndSettle();
      await enterCodeAndConnect(tester, '000000');

      expect(find.textContaining('was not recognized'), findsOneWidget);
      expect(
        tester.getRect(find.widgetWithText(FilledButton, 'Connect')).bottom,
        lessThanOrEqualTo(tester.getRect(find.byType(NavigationBar)).top),
        reason: 'the Connect button is below the fold in the error state',
      );
      expect(tester.takeException(), isNull);
    });

    // The layout has no text-size special cases left, but it did once, and the
    // estimate behind them was wrong in a band no default-scale test could
    // see. Sweep the accessibility range so a future one cannot hide either.
    for (final double scale in const [1.35, 2.0, 3.0]) {
      testWidgets('keeps the whole form reachable at text scale $scale', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(1125, 2001);
        tester.view.devicePixelRatio = 3.0;
        tester.view.padding = const FakeViewPadding(top: 60);
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildShellSubject(textScale: scale));
        await tester.pumpAndSettle();

        // Scrolling here is expected and fine; disappearing is not.
        for (final step in _pairingSteps) {
          expect(find.text(step), findsOneWidget);
        }
        expect(find.byType(TextField), findsOneWidget);
        expect(find.widgetWithText(FilledButton, 'Connect'), findsOneWidget);

        // The teeth: the steps and the primary action must share one
        // scrollable, so a single gesture reaches everything. An earlier
        // revision scrolled the steps inside their own region while the
        // action sat pinned outside it — which let the steps clip against a
        // fixed block with no affordance, invisible to any assertion that
        // only checks presence or reachability.
        // `lastOrNull`, not `last`: when this regresses, Connect has no
        // Scrollable ancestor at all, and `last` would throw a bare
        // "Bad state: No element" that buries the reason below.
        Element? scrollableFor(Finder target) => find
            .ancestor(of: target, matching: find.byType(Scrollable))
            .evaluate()
            .lastOrNull;
        final Element? stepScrollable = scrollableFor(
          find.text(_pairingSteps.last),
        );
        final Element? actionScrollable = scrollableFor(
          find.widgetWithText(FilledButton, 'Connect'),
        );
        expect(
          actionScrollable,
          isNotNull,
          reason: 'Connect is not inside any scrollable',
        );
        expect(
          identical(stepScrollable, actionScrollable),
          isTrue,
          reason: 'the steps and Connect are not in the same scrollable',
        );

        await tester.scrollUntilVisible(
          find.widgetWithText(FilledButton, 'Connect'),
          120,
          scrollable: find
              .descendant(
                of: find.byType(ConnectDesktopView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('survives a viewport too short for the whole form', (
      tester,
    ) async {
      // 667x375 landscape with a numeric keypad up leaves roughly 157pt for
      // the whole view — less than the code field and Connect button need on
      // their own. Everything must stay reachable by scrolling rather than
      // collapsing or throwing.
      tester.view.physicalSize = const Size(2001, 1125);
      tester.view.devicePixelRatio = 3.0;
      tester.view.viewInsets = const FakeViewPadding(bottom: 162 * 3);
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildShellSubject());
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      for (final step in _pairingSteps) {
        expect(find.text(step), findsOneWidget);
      }
      expect(find.widgetWithText(FilledButton, 'Connect'), findsOneWidget);
    });

    testWidgets('does not raise the keyboard over the steps on first view', (
      tester,
    ) async {
      // The code only exists on the desktop, so the field cannot be usefully
      // typed into on arrival. Autofocusing it would raise the keyboard over
      // the steps that explain where to get the code.
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final EditableText field = tester.widget<EditableText>(
        find.descendant(
          of: find.byType(TextField),
          matching: find.byType(EditableText),
        ),
      );
      expect(field.focusNode.hasFocus, isFalse);
      expect(tester.takeException(), isNull);
    });

    testWidgets('focuses the field again after a rejected code', (
      tester,
    ) async {
      // By the retry the user has a code in hand and wants to retype it, not
      // re-read the steps — so the keyboard should be waiting. Only the first
      // view withholds focus.
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await enterCodeAndConnect(tester, '000000');

      final EditableText field = tester.widget<EditableText>(
        find.descendant(
          of: find.byType(TextField),
          matching: find.byType(EditableText),
        ),
      );
      expect(find.textContaining('was not recognized'), findsOneWidget);
      expect(field.focusNode.hasFocus, isTrue);
      // Selected as well as focused, so the next keystroke replaces the
      // rejected code instead of the user backspacing six times.
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller?.selection,
        const TextSelection(baseOffset: 0, extentOffset: 6),
        reason: 'the rejected code should be selected, not just focused',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('keeps the code location visible after a rejected code', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await enterCodeAndConnect(tester, '000000');

      // A rejected code is exactly when the user needs to re-read where the
      // real one comes from, so the steps must survive the error state.
      expect(find.textContaining('was not recognized'), findsOneWidget);
      for (final step in _pairingSteps) {
        expect(find.text(step), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('a valid code connects and lists workspaces', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await enterCodeAndConnect(tester, '123456');

      // Connected AppBar title plus the mock workspaces. The title names the
      // paired desktop rather than the tab, so the generic word is gone.
      expect(find.text('Remote'), findsNothing);
      expect(find.text("Alex's MacBook Pro"), findsOneWidget);
      // Pinned attention rows also name their workspace, so match the
      // workspace names inside the project headers.
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('workspace-ws-app')),
          matching: find.text('acme-web'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('workspace-ws-platform')),
          matching: find.text('platform'),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);

      // Expire the chat-tab prefetch watchdogs the connected list armed so
      // no timer is pending at teardown.
      await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    });

    // The paired device used to be announced twice: a generic `Remote` app bar
    // title, and a full-width card directly under it repeating the device name
    // and its connection status. The two are now one two-line title, which
    // buys back a row of vertical space on every connected frame.
    group('the app bar title', () {
      final deviceName = find.byKey(const ValueKey('remote-device-name'));
      final deviceStatus = find.byKey(const ValueKey('remote-device-status'));

      Widget buildTitleSubject(
        _TitleRepository repository, {
        double textScale = 1.0,
      }) {
        return ChangeNotifierProvider<RemoteControlViewModel>(
          create: (_) => RemoteControlViewModel(repository: repository),
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(textScale)),
              child: child ?? const SizedBox.shrink(),
            ),
            home: const RemoteScreen(),
          ),
        );
      }

      testWidgets('stacks the device name over its connection status', (
        tester,
      ) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          buildTitleSubject(
            _TitleRepository(
              connectionStatus: RemotePortalConnectionStatus.active,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(tester.widget<Text>(deviceName).data, 'MacBook-Pro.local');
        expect(tester.widget<Text>(deviceStatus).data, 'Connected');
        // Two lines, not two columns: the status sits *below* the name.
        expect(
          tester.getTopLeft(deviceStatus).dy,
          greaterThan(tester.getTopLeft(deviceName).dy),
        );
        // ...and the card that used to repeat both is gone.
        expect(
          find.byKey(const ValueKey('remote-connected-device')),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('spends the status line on why the data is stale', (
        tester,
      ) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          buildTitleSubject(
            _TitleRepository(
              connectionStatus: RemotePortalConnectionStatus.inactive,
              lastSeenAt: DateTime.now().subtract(const Duration(hours: 2)),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          tester.widget<Text>(deviceStatus).data,
          'Cached data · Last seen 2h ago',
        );
        // A degraded line must not read as quiet housekeeping.
        expect(
          tester.widget<Text>(deviceStatus).style?.color,
          StatusColors.light.warning,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets('keeps the status line quiet while healthy', (tester) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          buildTitleSubject(
            _TitleRepository(
              connectionStatus: RemotePortalConnectionStatus.active,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          tester.widget<Text>(deviceStatus).style?.color,
          isNot(StatusColors.light.warning),
        );
        expect(tester.takeException(), isNull);
      });

      // The degraded banner never carried its own trailing space — the
      // connected card's `SizedBox` below it did. Removing that card must not
      // silently collapse the banner onto the first section label.
      testWidgets('keeps the degraded banner off the first section label', (
        tester,
      ) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          buildTitleSubject(
            _TitleRepository(
              connectionStatus: RemotePortalConnectionStatus.inactive,
            ),
          ),
        );
        await tester.pumpAndSettle();

        final bannerBottom = tester
            .getRect(find.byType(RemoteDegradedBanner))
            .bottom;
        final labelTop = tester.getRect(find.text('Projects')).top;
        expect(labelTop - bannerBottom, greaterThanOrEqualTo(8.0));
        expect(tester.takeException(), isNull);
      });

      // CAN-4426: the offline banner names the desktop, so a metadata-only
      // rename must reach it alongside the title. Liveness, link state and
      // the shell collections stay equal across the refresh.
      testWidgets('renames the offline desktop in the title and the banner', (
        tester,
      ) async {
        usePhoneViewport(tester);
        const renamed = 'MacBook-Pro-of-Stanislav-Havrosh-Long.local';
        final repository = _TitleRepository(
          connectionStatus: RemotePortalConnectionStatus.inactive,
        );
        await tester.pumpWidget(buildTitleSubject(repository));
        await tester.pumpAndSettle();
        expect(tester.widget<Text>(deviceName).data, 'MacBook-Pro.local');
        expect(
          find.textContaining('MacBook-Pro.local is offline.'),
          findsOneWidget,
        );

        repository.sessionMetadataBuilder = () => RemoteConnection(
          deviceLabel: renamed,
          pairedAt: DateTime(2026),
          connectionStatus: RemotePortalConnectionStatus.inactive,
        );
        final viewModel = Provider.of<RemoteControlViewModel>(
          tester.element(find.byType(RemoteScreen)),
          listen: false,
        );
        await viewModel.onAppForegrounded();
        await tester.pumpAndSettle();

        expect(tester.widget<Text>(deviceName).data, renamed);
        expect(find.textContaining('$renamed is offline.'), findsOneWidget);
        expect(
          find.textContaining('MacBook-Pro.local is offline.'),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });

      // The title slot is bounded by the two action slots, which the old
      // full-width card was not. A hostname longer than that gap must
      // ellipsize rather than overflow or push the actions off screen.
      testWidgets('ellipsizes a device name longer than the title slot', (
        tester,
      ) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(
          buildTitleSubject(
            _TitleRepository(
              deviceLabel: 'MacBook-Pro-of-Stanislav-Havrosh-Long.local',
              connectionStatus: RemotePortalConnectionStatus.active,
            ),
          ),
        );
        await tester.pumpAndSettle();

        final name = tester.widget<Text>(deviceName);
        expect(name.maxLines, 1);
        expect(name.overflow, TextOverflow.ellipsis);
        expect(tester.takeException(), isNull);
      });

      // Migrated from the connected card this title replaced: the status label
      // used to escape its container at accessibility text scales because a
      // non-flex child is laid out with unbounded main-axis constraints, which
      // makes `overflow: ellipsis` unreachable. Geometry, not `takeException`,
      // because unrelated widgets have their own overflows at these scales.
      for (final double scale in const [1.35, 2.0, 3.0]) {
        testWidgets('stays inside the app bar at text scale $scale', (
          tester,
        ) async {
          usePhoneViewport(tester);
          await tester.pumpWidget(
            buildTitleSubject(
              _TitleRepository(
                connectionStatus: RemotePortalConnectionStatus.inactive,
                lastSeenAt: DateTime.now().subtract(const Duration(hours: 2)),
              ),
              textScale: scale,
            ),
          );
          await tester.pumpAndSettle();

          final barRect = tester.getRect(find.byType(CanopyAppBar));
          for (final line in [deviceName, deviceStatus]) {
            final lineRect = tester.getRect(line);
            expect(
              lineRect.right,
              lessThanOrEqualTo(barRect.right),
              reason:
                  'the title escaped the app bar at text scale $scale — it '
                  'must ellipsize inside the slot, not overflow it',
            );
            expect(
              lineRect.bottom,
              lessThanOrEqualTo(barRect.bottom),
              reason:
                  'the title overflowed the app bar height at text scale '
                  '$scale',
            );
          }
          while (tester.takeException() != null) {}
        });
      }
    });

    testWidgets('lists standalone chats without matching workspace rows', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [
            RemoteStandaloneChat(
              localId: 'chat-1',
              projectLocalId: 'chat-project-1',
              title: 'Standalone planning chat',
            ),
          ],
        );
      await tester.pumpWidget(buildSubject(repository: repository));
      await tester.pumpAndSettle();

      await enterCodeAndConnect(tester, '123456');

      expect(find.text('Standalone planning chat'), findsOneWidget);
      expect(find.text('No projects yet'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('retries the snapshot without redeeming the pairing again', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = _RetryableSnapshotRepository();
      await tester.pumpWidget(buildSubject(repository: repository));
      await tester.pumpAndSettle();

      await enterCodeAndConnect(tester, '123456');

      expect(find.text('Could not load projects'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(
        repository.resumeEventsCalls,
        0,
        reason: 'a cold snapshot failure has no safe event cursor to resume',
      );

      await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
      await tester.pumpAndSettle();

      expect(find.text('Recovered workspace'), findsOneWidget);
      expect(repository.snapshotFetches, 2);
      expect(repository.resumeEventsCalls, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a rejected code shows an inline error', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await enterCodeAndConnect(tester, '000000');

      // Still on the connect form, now with the repository's inline message.
      expect(find.byType(TextField), findsOneWidget);
      expect(find.textContaining('was not recognized'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('offers one overflow disconnect action', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await enterCodeAndConnect(tester, '123456');
      final workspaceHeader = find.descendant(
        of: find.byKey(const ValueKey('workspace-ws-app')),
        matching: find.text('acme-web'),
      );
      expect(workspaceHeader, findsOneWidget);

      expect(find.text('Disconnect'), findsNothing);
      await tester.tap(find.byTooltip('Remote options'));
      await tester.pumpAndSettle();
      expect(find.text('New task'), findsNothing);
      expect(find.byKey(const ValueKey('remote-new-task')), findsNothing);
      expect(find.text('Disconnect'), findsOneWidget);
      await tester.tap(find.text('Disconnect'));
      await tester.pumpAndSettle();

      expect(find.text('Connect to your desktop'), findsOneWidget);
      expect(workspaceHeader, findsNothing);
      expect(find.text('acme-web'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    // CAN-3624: the real repository over a synthetic Portal server. Desktop A
    // is paired and asleep; the account's current-session read returns
    // whichever other row is current, which proves nothing about A.
    group('a sleeping desktop keeps its pairing (CAN-3624)', () {
      late FakePortalSessionServer server;

      Future<void> pumpPairedToSleepingA(WidgetTester tester) async {
        usePhoneViewport(tester);
        server = FakePortalSessionServer()
          ..addSession(id: 'sess-a', clientName: 'Desktop A', eventCursor: 40);
        await tester.pumpWidget(
          ChangeNotifierProvider<RemoteControlViewModel>(
            create: (_) => RemoteControlViewModel(
              repository: server.repository(),
              stateRefreshDebounce: Duration.zero,
            ),
            child: MaterialApp(
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              home: const RemoteScreen(),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Desktop A workspace'), findsOneWidget);

        server.sleep('sess-a');
        await tester.pump();
        await tester.pump();
        expect(find.byType(RemoteDegradedBanner), findsOneWidget);
      }

      Future<void> foregroundThenPullToRefresh(WidgetTester tester) async {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        if (find.byType(RefreshIndicator).evaluate().isNotEmpty) {
          await tester.fling(
            find.byType(RefreshIndicator),
            const Offset(0, 320),
            1200,
          );
        }
        await tester.pump(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));
      }

      Future<void> unmount(WidgetTester tester) async {
        server.close();
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(minutes: 1));
      }

      void expectStillShowingSleepingA() {
        expect(find.byType(ConnectDesktopView), findsNothing);
        expect(find.text('Desktop A'), findsOneWidget);
        expect(find.text('Desktop A workspace'), findsOneWidget);
        expect(find.text('Desktop B workspace'), findsNothing);
        expect(find.byType(RemoteDegradedBanner), findsOneWidget);
      }

      testWidgets('another desktop awaiting its code does not end it', (
        tester,
      ) async {
        await pumpPairedToSleepingA(tester);
        server.addSession(
          id: 'sess-b',
          clientName: 'Desktop B',
          status: 'pending_auth',
          connectionStatus: 'pending',
        );

        await foregroundThenPullToRefresh(tester);

        expect(
          server.requests,
          contains('POST $portalBrowserBasePath/sessions/sess-a/commands'),
        );
        expect(server.endRequests, isEmpty);
        expect(server.requestsFor('sess-b'), isEmpty);
        expectStillShowingSleepingA();
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });

      testWidgets('another active desktop does not replace it', (tester) async {
        await pumpPairedToSleepingA(tester);
        server.addSession(id: 'sess-b', clientName: 'Desktop B');

        await foregroundThenPullToRefresh(tester);

        expect(
          server.requests,
          contains('POST $portalBrowserBasePath/sessions/sess-a/commands'),
        );
        expect(server.endRequests, isEmpty);
        expect(server.requestsFor('sess-b'), isEmpty);
        expectStillShowingSleepingA();
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });

      testWidgets('its own ended row shows the pairing form locally', (
        tester,
      ) async {
        await pumpPairedToSleepingA(tester);
        server.currentSessionOverride = () =>
            (status: 200, body: const {'session': null});

        await foregroundThenPullToRefresh(tester);

        expect(find.byType(ConnectDesktopView), findsOneWidget);
        expect(
          find.text(
            'The desktop is no longer connected. Connect it again to continue.',
          ),
          findsOneWidget,
        );
        expect(find.text('Desktop A workspace'), findsNothing);
        expect(server.endRequests, isEmpty);
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });

      testWidgets('Disconnect ends it on the server once', (tester) async {
        await pumpPairedToSleepingA(tester);

        await tester.tap(find.byTooltip('Remote options'));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.tap(find.text('Disconnect'));
        // The menu action runs once its route has popped; the screen repaints
        // after the end request settles.
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pump();

        expect(find.text('Connect to your desktop'), findsOneWidget);
        expect(server.endRequests, [
          'POST $portalBrowserBasePath/sessions/sess-a/end',
        ]);
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });
    });

    // CAN-4426: leaving a paired desktop that went offline. The real
    // repository runs over a synthetic Portal server.
    group('leaving an offline desktop (CAN-4426)', () {
      late FakePortalSessionServer server;
      late RemoteControlViewModel viewModel;
      late DateTime now;

      Widget host({Key? screenKey}) =>
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
            child: MaterialApp(
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              home: RemoteScreen(key: screenKey),
            ),
          );

      Future<void> pumpPairedToOfflineA(WidgetTester tester) async {
        usePhoneViewport(tester);
        now = DateTime(2026, 10, 17, 12);
        server = FakePortalSessionServer()
          ..addSession(id: 'sess-a', clientName: 'Desktop A', eventCursor: 40);
        viewModel = RemoteControlViewModel(
          repository: server.repository(),
          stateRefreshDebounce: Duration.zero,
          // The restore throttle reads this clock; fake test time does not
          // advance the wall clock.
          clock: () => now,
        );
        await tester.pumpWidget(host());
        await tester.pump();
        await tester.pump();
        expect(find.text('Desktop A workspace'), findsOneWidget);

        server.sleep('sess-a');
        await tester.pump();
        await tester.pump();
        expect(find.byType(RemoteDegradedBanner), findsOneWidget);
      }

      /// Taps the overflow Disconnect. The menu runs its action once it has
      /// closed, so the frame after this one is the first that can respond.
      Future<void> tapDisconnect(WidgetTester tester) async {
        await tester.tap(find.byTooltip('Remote options'));
        await tester.pump(const Duration(milliseconds: 500));
        await tester.tap(find.text('Disconnect'));
        await tester.pump();
      }

      /// A background and foreground in the platform's lifecycle order.
      void foreground(WidgetTester tester) {
        for (final state in const [
          AppLifecycleState.inactive,
          AppLifecycleState.hidden,
          AppLifecycleState.paused,
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
      }

      Future<void> unmount(WidgetTester tester) async {
        server.close();
        await tester.pumpWidget(const SizedBox.shrink());
        viewModel.dispose();
        await tester.pump(const Duration(minutes: 1));
      }

      testWidgets('the desktop coming back clears the banner by itself', (
        tester,
      ) async {
        await pumpPairedToOfflineA(tester);

        // The desktop comes back. After its paced retry, the event stream
        // polls again and the desktop's next heartbeat answers that poll.
        server.heartbeat('sess-a');
        server.restoreDelivery();
        await tester.pump();
        server.heartbeat('sess-a');
        await tester.pump();
        await tester.pump();

        expect(find.byType(RemoteDegradedBanner), findsNothing);
        expect(find.text('Desktop A workspace'), findsOneWidget);
        expect(server.endRequests, isEmpty);
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });

      testWidgets('Disconnect shows the pairing form on the next frame', (
        tester,
      ) async {
        await pumpPairedToOfflineA(tester);
        final endGate = server.endGate = Completer<void>();

        await tapDisconnect(tester);
        await tester.pump();

        // The end request is still waiting for the server.
        expect(server.endRequests, [
          'POST $portalBrowserBasePath/sessions/sess-a/end',
        ]);
        expect(endGate.isCompleted, isFalse);
        expect(find.byType(ConnectDesktopView), findsOneWidget);
        expect(find.text('Desktop A workspace'), findsNothing);
        expect(find.byType(RemoteDegradedBanner), findsNothing);

        endGate.complete();
        await tester.pump();
        await tester.pump();
        expect(find.byType(ConnectDesktopView), findsOneWidget);
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });

      testWidgets('a restore does not reattach the session it disconnected', (
        tester,
      ) async {
        await pumpPairedToOfflineA(tester);
        final endGate = server.endGate = Completer<void>();

        await tapDisconnect(tester);
        await tester.pump();
        // The end request never reaches the server, so the row stays
        // restorable there.
        endGate.completeError(http.ClientException('Connection reset'));
        await tester.pump();
        await tester.pump();
        expect(server.row('sess-a').connectionStatus, 'inactive');
        expect(find.byType(ConnectDesktopView), findsOneWidget);

        // Every restore trigger goes through the same probe: a foreground...
        now = now.add(const Duration(seconds: 6));
        foreground(tester);
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(ConnectDesktopView), findsOneWidget);
        expect(find.text('Desktop A workspace'), findsNothing);

        // ...and a remount of the Remote tab.
        now = now.add(const Duration(seconds: 6));
        await tester.pumpWidget(host(screenKey: const ValueKey('remount')));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.byType(ConnectDesktopView), findsOneWidget);
        expect(find.text('Desktop A workspace'), findsNothing);
        expect(find.byType(RemoteDegradedBanner), findsNothing);
        expect(server.requestsFor('sess-a').last, contains('/end'));
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });

      testWidgets('a new pairing survives the old end request', (tester) async {
        await pumpPairedToOfflineA(tester);
        final endGate = server.endGate = Completer<void>();
        server
          ..addSession(id: 'sess-b', clientName: 'Desktop B')
          ..connectResponse = (code) => (
            status: 200,
            body: const {'sessionId': 'sess-b', 'status': 'active'},
          );

        await tapDisconnect(tester);
        await tester.pump();
        await tester.enterText(find.byType(TextField), '123456');
        await tester.pump();
        await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
        await tester.pump();
        // The code waits for the end request, which could otherwise land on a
        // session the desktop re-armed and end the new pairing.
        expect(
          server.requests,
          isNot(contains('POST $portalBrowserBasePath/connect')),
        );
        expect(find.byType(ConnectDesktopView), findsNothing);

        endGate.complete();
        for (var frame = 0; frame < 5; frame += 1) {
          await tester.pump(const Duration(milliseconds: 100));
        }

        expect(find.text('Desktop B workspace'), findsOneWidget);
        expect(find.text('Desktop B'), findsOneWidget);
        expect(find.byType(ConnectDesktopView), findsNothing);
        expect(server.requestsFor('sess-b'), isNot(contains(endsWith('/end'))));
        expect(tester.takeException(), isNull);
        await unmount(tester);
      });
    });

    group('lifecycle + degraded connection (CAN-2651)', () {
      Widget buildWithRepository(
        RemoteControlRepository repository, {
        DateTime Function()? clock,
      }) {
        return ChangeNotifierProvider<RemoteControlViewModel>(
          create: (_) =>
              RemoteControlViewModel(repository: repository, clock: clock),
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: const RemoteScreen(),
          ),
        );
      }

      testWidgets('a foreground while disconnected re-probes the session', (
        tester,
      ) async {
        // The view model is created once at the app root and nothing about
        // the pairing is persisted locally, so without this a single unlucky
        // cold start stranded the user on the pairing form for the whole
        // process lifetime.
        usePhoneViewport(tester);
        final repository = _LifecycleRestoreRepository();
        // The probe throttle reads the injected clock, which fake test time
        // does not advance.
        var now = DateTime(2026, 8, 1, 12);
        await tester.pumpWidget(
          buildWithRepository(repository, clock: () => now),
        );
        await tester.pumpAndSettle();

        expect(repository.restoreCalls, 1);
        expect(find.byType(ConnectDesktopView), findsOneWidget);

        // Past the ~5s probe throttle.
        now = now.add(const Duration(seconds: 6));
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();

        expect(repository.restoreCalls, 2);
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'a stale session renders the workspace list behind a degraded banner',
        (tester) async {
          usePhoneViewport(tester);
          final repository = _LifecycleRestoreRepository(
            connectionStatus: RemotePortalConnectionStatus.inactive,
          );
          await tester.pumpWidget(buildWithRepository(repository));
          await tester.pumpAndSettle();

          // Not the six-digit form: the cached shell stays, matching web.
          expect(find.byType(ConnectDesktopView), findsNothing);
          expect(find.byType(RemoteDegradedBanner), findsOneWidget);
          // Pairing identity is not liveness: the app bar title must agree
          // with the degraded banner instead of claiming it is Connected.
          expect(find.text('Connected'), findsNothing);
          expect(find.textContaining('Cached data'), findsOneWidget);
          // ...and the banner must agree with the title. An `inactive` desktop
          // is not reconnecting, and saying so beside a stale-data title is
          // worse than either message alone.
          expect(find.text('Desktop is reconnecting…'), findsNothing);
          // CAN-4426: the phone cannot bring an offline desktop back, so the
          // banner names it and says what to do there instead of offering an
          // action that only ends the pairing.
          expect(
            find.text(
              'Test Desktop is offline. Open ${Brand.productDisplayName} on '
              'that computer to reconnect. Showing cached data.',
            ),
            findsOneWidget,
          );
          expect(
            find.byKey(const ValueKey('remote-degraded-connect-device')),
            findsNothing,
          );
          expect(
            find.descendant(
              of: find.byType(RemoteDegradedBanner),
              matching: find.byType(TextButton),
            ),
            findsNothing,
          );
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('a reconnecting desktop shows the banner without an action', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = _LifecycleRestoreRepository(
          connectionStatus: RemotePortalConnectionStatus.reconnecting,
        );
        await tester.pumpWidget(buildWithRepository(repository));
        await tester.pumpAndSettle();

        expect(find.byType(ConnectDesktopView), findsNothing);
        expect(find.text('Desktop is reconnecting…'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('remote-degraded-connect-device')),
          findsNothing,
        );
        expect(
          find.descendant(
            of: find.byType(RemoteDegradedBanner),
            matching: find.byType(TextButton),
          ),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      });

      testWidgets(
        'a resume that cannot reconnect says so over the cached list',
        (tester) async {
          // CAN-3557: the desktop is fine, but this phone's own connection has
          // not come back, so the list on screen is a cache.
          usePhoneViewport(tester);
          final repository = _LifecycleRestoreRepository(
            connectionStatus: RemotePortalConnectionStatus.active,
          )..autoLive = false;
          await tester.pumpWidget(buildWithRepository(repository));
          await tester.pumpAndSettle();
          repository.eventsLiveController.add(true);
          await tester.pumpAndSettle();
          expect(find.text('Connected'), findsOneWidget);

          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.paused,
          );
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.resumed,
          );
          await tester.pump(const Duration(seconds: 3));

          expect(find.text('Connected'), findsNothing);
          expect(find.text('Cached data'), findsOneWidget);
          expect(find.text('Reconnecting…'), findsOneWidget);
          // The pairing is fine; dropping back to pairing is not the remedy.
          expect(
            find.byKey(const ValueKey('remote-degraded-connect-device')),
            findsNothing,
          );

          await tester.pump(const Duration(seconds: 30));
          expect(find.text('Reconnecting…'), findsNothing);
          expect(
            find.text("Can't reach the server. Showing cached data."),
            findsOneWidget,
          );

          repository.eventsLiveController.add(true);
          await tester.pumpAndSettle();
          expect(find.byType(RemoteDegradedBanner), findsNothing);
          expect(find.text('Connected'), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets(
        'an unreachable cold start says it is retrying and keeps the form',
        (tester) async {
          // CAN-3557: reopening the app during a network blip used to land on
          // a silent pairing form. Retries now restore the live pairing, and
          // must not wipe a code the user is part-way through typing.
          usePhoneViewport(tester);
          var now = DateTime(2026, 10, 2, 12);
          final repository = _UnreachableRestoreRepository(
            unreachableProbes: 2,
          );
          await tester.pumpWidget(
            buildWithRepository(repository, clock: () => now),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 200));

          expect(find.byType(ConnectDesktopView), findsOneWidget);
          expect(
            find.text("Can't reach the server · Retrying…"),
            findsOneWidget,
          );
          await tester.enterText(find.byType(TextField), '12');

          // The first retry still cannot reach the server.
          now = now.add(const Duration(seconds: 5));
          await tester.pump(const Duration(seconds: 5));
          await tester.pump(const Duration(milliseconds: 100));
          await tester.pump(const Duration(milliseconds: 100));
          expect(repository.probeCalls, 2);
          expect(find.byType(ConnectDesktopView), findsOneWidget);
          expect(
            tester.widget<TextField>(find.byType(TextField)).controller?.text,
            '12',
          );

          // The second retry restores the pairing.
          now = now.add(const Duration(seconds: 10));
          await tester.pump(const Duration(seconds: 10));
          await tester.pump(const Duration(milliseconds: 200));
          await tester.pumpAndSettle();
          expect(repository.probeCalls, 3);
          expect(find.byType(ConnectDesktopView), findsNothing);
          expect(find.text('Connected'), findsOneWidget);
          expect(tester.takeException(), isNull);
        },
      );

      testWidgets('a live session shows no degraded banner', (tester) async {
        usePhoneViewport(tester);
        final repository = _LifecycleRestoreRepository(
          connectionStatus: RemotePortalConnectionStatus.active,
        );
        await tester.pumpWidget(buildWithRepository(repository));
        await tester.pumpAndSettle();

        expect(find.byType(RemoteDegradedBanner), findsNothing);
        expect(find.text('Connected'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    });
  });
}
