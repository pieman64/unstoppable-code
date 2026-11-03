import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/space_notifications_api_service.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/space_notification_menu.dart';
import 'package:mobile/ui/features/remote/view_models/space_notifications_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/overview_snapshot_fixture.dart';
import '../../../support/reduced_motion.dart';

/// The notification-space routes, answered from memory. Each PATCH waits on
/// [patchGate] when one is set, so a test can look at the pending state.
final class _SpaceServer {
  final requests = <http.Request>[];
  final overrides = <String, String?>{};
  final revisions = <String, int>{};
  Completer<void>? patchGate;

  Map<String, Object?> _snapshot(String spaceId) => {
    'spaceId': spaceId,
    'revision': revisions[spaceId] ?? 0,
    'override': overrides[spaceId],
    'effectiveLevel': overrides[spaceId] ?? 'all',
    'writesEnabled': true,
    'transitions': <Object?>[],
    'nextRevision': null,
  };

  Future<http.Response> handle(http.Request request) async {
    requests.add(request);
    final spaceId = Uri.decodeComponent(request.url.pathSegments.last);
    if (request.method == 'PATCH') {
      await patchGate?.future;
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      overrides[spaceId] = body['override'] as String?;
      revisions[spaceId] = (revisions[spaceId] ?? 0) + 1;
    }
    return http.Response(jsonEncode(_snapshot(spaceId)), 200);
  }

  List<http.Request> get patches =>
      requests.where((request) => request.method == 'PATCH').toList();
}

Map<String, dynamic> _worktree({String? spaceId}) => {
  ...overviewWorktree(),
  'notificationSpaceId': ?spaceId,
};

Map<String, dynamic> _entryChat({String? spaceId}) => {
  'localId': 'chat-1',
  'projectLocalId': 'ws-1',
  'title': 'Research notes',
  'workEntryId': 'entry-1',
  'workEntryNotificationSpaceId': ?spaceId,
};

void main() {
  useReducedMotion();
  setUpAll(() => SharedPreferences.setMockInitialValues({}));

  void usePhoneViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  Future<(RemoteControlViewModel, _SpaceServer)> pumpList(
    WidgetTester tester, {
    bool enabled = true,
    String? worktreeSpaceId = 'space-wt-1',
    String? entrySpaceId = 'space-entry-1',
    SpaceNotificationsRepository? repository,
    ThemeData? theme,
  }) async {
    usePhoneViewport(tester);
    final repo = FakeRemoteControlRepository()
      ..spaceNotificationSettingsEnabled = enabled
      ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
        'workspaces': [overviewWorkspace()],
        'worktrees': [_worktree(spaceId: worktreeSpaceId)],
        'standaloneChats': [_entryChat(spaceId: entrySpaceId)],
      });
    final vm = RemoteControlViewModel(repository: repo);
    addTearDown(vm.dispose);
    addTearDown(repo.eventsController.close);
    await vm.connect('123456');
    final server = _SpaceServer();
    final notifications = SpaceNotificationsViewModel(
      repository:
          repository ??
          HttpSpaceNotificationsRepository(
            service: SpaceNotificationsApiService(
              apiClient: ApiClient(
                baseUrl: 'https://api.test',
                httpClient: MockClient(server.handle),
              ),
            ),
          ),
      sessionChanges: vm,
      sessionScope: () => vm.sessionGeneration,
    );
    addTearDown(notifications.dispose);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
          ChangeNotifierProvider<SpaceNotificationsViewModel>.value(
            value: notifications,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: theme ?? AppTheme.light,
          home: const Scaffold(body: WorkspacesListView()),
        ),
      ),
    );
    await tester.tap(find.text('Repository'));
    await tester.pumpAndSettle();
    return (vm, server);
  }

  Future<void> flushHydrationWatchdogs(WidgetTester tester) =>
      tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));

  /// The one semantics node offering the custom action [label].
  SemanticsNode actionNode(String label) {
    final id = CustomSemanticsAction.getIdentifier(
      CustomSemanticsAction(label: label),
    );
    return find.semantics
        .byPredicate(
          (node) =>
              node.getSemanticsData().customSemanticsActionIds?.contains(id) ??
              false,
        )
        .evaluate()
        .single;
  }

  /// Whether assistive technology reads the choice as checked.
  bool isChecked(WidgetTester tester, String key) => isSemantics(
    isChecked: true,
  ).matches(tester.getSemantics(find.byKey(ValueKey(key))), {});

  testWidgets(
    'worktree long press opens Notifications and saves only after the ack',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final (_, server) = await pumpList(tester);
      await tester.longPress(find.byKey(const ValueKey('worktree-ws-1-wt-1')));
      await tester.pumpAndSettle();
      // Routine action and the existing destructive one share the menu.
      expect(
        find.byKey(const ValueKey('archive-worktree-wt-1')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('space-notify-open-wt-1')));
      await tester.pumpAndSettle();

      expect(server.requests.single.method, 'GET');
      expect(
        server.requests.single.url.path,
        '/api/v1/notification-spaces/space-wt-1',
      );
      expect(find.text('Notifications'), findsOneWidget);
      expect(find.text('koala'), findsWidgets);
      for (final label in ['All activity', 'Needs my attention', 'Mute']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(isChecked(tester, 'space-notify-all-space-wt-1'), isTrue);
      expect(isChecked(tester, 'space-notify-mute-space-wt-1'), isFalse);

      server.patchGate = Completer<void>();
      await tester.tap(
        find.byKey(const ValueKey('space-notify-mute-space-wt-1')),
      );
      await tester.pump();
      expect(server.patches, hasLength(1));
      expect(jsonDecode(server.patches.single.body), {
        'expectedRevision': 0,
        'override': 'mute',
      });
      // The sheet keeps its look and height: no status line, no greyed
      // choices, and a spinner in the pending choice's fixed slot.
      expect(
        find.byKey(const ValueKey('space-notify-status-space-wt-1')),
        findsNothing,
      );
      expect(
        tester
            .widget<RadioListTile<SpaceNotificationChoice>>(
              find.byKey(const ValueKey('space-notify-attention-space-wt-1')),
            )
            .enabled,
        isTrue,
      );
      expect(
        find.byKey(const ValueKey('space-notify-pending-mute-space-wt-1')),
        findsOneWidget,
      );
      expect(isChecked(tester, 'space-notify-all-space-wt-1'), isTrue);
      expect(isChecked(tester, 'space-notify-mute-space-wt-1'), isFalse);
      // A second tap while saving sends nothing.
      await tester.tap(
        find.byKey(const ValueKey('space-notify-attention-space-wt-1')),
      );
      await tester.pump();
      expect(server.patches, hasLength(1));

      server.patchGate!.complete();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('space-notify-pending-mute-space-wt-1')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('space-notify-status-space-wt-1')),
        findsNothing,
      );
      expect(isChecked(tester, 'space-notify-mute-space-wt-1'), isTrue);
      expect(isChecked(tester, 'space-notify-all-space-wt-1'), isFalse);
      expect(tester.takeException(), isNull);
      semantics.dispose();
      await flushHydrationWatchdogs(tester);
    },
  );

  testWidgets('the worktree accessibility action reaches Notifications', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await pumpList(tester);
    final node = actionNode('Worktree actions');
    node.owner!.performAction(
      node.id,
      SemanticsAction.customAction,
      CustomSemanticsAction.getIdentifier(
        const CustomSemanticsAction(label: 'Worktree actions'),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('space-notify-open-wt-1')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    semantics.dispose();
    await flushHydrationWatchdogs(tester);
  });

  for (final (name, enabled, spaceId) in [
    ('the session switch is off', false, 'space-wt-1'),
    ('the worktree has no notification space', true, null),
  ]) {
    testWidgets('no Notifications entry when $name', (tester) async {
      await pumpList(tester, enabled: enabled, worktreeSpaceId: spaceId);
      await tester.longPress(find.byKey(const ValueKey('worktree-ws-1-wt-1')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('archive-worktree-wt-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('space-notify-open-wt-1')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });
  }

  testWidgets('a Work Entry row long press opens its notification choices', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final (_, server) = await pumpList(tester);
    expect(
      actionNode('Notifications').getSemanticsData().label,
      contains('Research notes'),
    );
    await tester.longPress(find.text('Research notes'));
    await tester.pumpAndSettle();

    expect(
      server.requests.single.url.path,
      '/api/v1/notification-spaces/space-entry-1',
    );
    expect(
      find.byKey(const ValueKey('space-notify-sheet-space-entry-1')),
      findsOneWidget,
    );
    expect(isChecked(tester, 'space-notify-all-space-entry-1'), isTrue);
    await tester.tap(
      find.byKey(const ValueKey('space-notify-attention-space-entry-1')),
    );
    await tester.pumpAndSettle();
    expect(jsonDecode(server.patches.single.body), {
      'expectedRevision': 0,
      'override': 'attention',
    });
    expect(isChecked(tester, 'space-notify-attention-space-entry-1'), isTrue);
    expect(tester.takeException(), isNull);
    semantics.dispose();
    await flushHydrationWatchdogs(tester);
  });

  for (final (name, enabled, spaceId) in [
    ('the session switch is off', false, 'space-entry-1'),
    ('the entry has no notification space', true, null),
  ]) {
    testWidgets('a Work Entry row offers no notification choices when $name', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final (_, server) = await pumpList(
        tester,
        enabled: enabled,
        entrySpaceId: spaceId,
      );
      final tile = tester.widget<ListTile>(
        find.ancestor(
          of: find.text('Research notes'),
          matching: find.byType(ListTile),
        ),
      );
      expect(tile.onLongPress, isNull);
      expect(
        find.semantics.byPredicate(
          (node) =>
              node.getSemanticsData().customSemanticsActionIds?.isNotEmpty ==
                  true &&
              node.getSemanticsData().label.contains('Research notes'),
        ),
        findsNothing,
      );
      expect(server.requests, isEmpty);
      expect(tester.takeException(), isNull);
      semantics.dispose();
      await flushHydrationWatchdogs(tester);
    });
  }

  testWidgets('a failed first read shows how to retry with nothing checked', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await pumpList(
      tester,
      repository: _FailingRepository(),
      theme: AppTheme.dark,
    );
    await tester.longPress(find.text('Research notes'));
    await tester.pumpAndSettle();
    expect(
      find.text('Couldn’t load. Reopen this menu to try again.'),
      findsOneWidget,
    );
    for (final choice in ['all', 'attention', 'mute']) {
      expect(isChecked(tester, 'space-notify-$choice-space-entry-1'), isFalse);
    }
    expect(tester.takeException(), isNull);
    semantics.dispose();
    await flushHydrationWatchdogs(tester);
  });
}

final class _FailingRepository implements SpaceNotificationsRepository {
  @override
  Future<Never> load(String spaceId) async =>
      throw const SpaceNotificationsException(
        SpaceNotificationsFailure.ambiguous,
      );

  @override
  Future<Never> save(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  }) async => throw const SpaceNotificationsException(
    SpaceNotificationsFailure.ambiguous,
  );
}
