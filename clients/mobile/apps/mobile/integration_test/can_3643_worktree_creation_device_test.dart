// CAN-3643 device verification: a worktree created from the Remote tab keeps
// going across a real app background, whose foreground re-reads the same
// pairing's metadata. Run one scenario per invocation from apps/mobile with
// the native lifecycle driver (see test_driver/remote_hydration_lifecycle.dart
// for the host environment):
//
//   flutter drive --driver=test_driver/remote_hydration_lifecycle.dart \
//     --target=integration_test/can_3643_worktree_creation_device_test.dart \
//     --dart-define=CAN3643_SCENARIO=resume --dart-define=CAN3643_THEME=dark \
//     -d <device-id>
//
// Scenarios:
//  * resume: the create is pending while the app goes Home and returns. The
//    desktop then reserves the worktree, finishes its git setup, and the draft
//    is sent to the new worktree.
//  * retry: the accepted create outlives its wait without an id. After a
//    background, the desktop completes it, and Retry reconciles the original
//    create instead of submitting another.
//  * new-pairing: the phone disconnects and pairs again (same server session
//    id) before the old create returns. The old result must not bind; Retry
//    creates a worktree on the new pairing.
//
// The Remote screen stays mounted under the chat, so the app's real lifecycle
// reaches the view model the way it does in production. The repository is
// the in-repo fake: no desktop or network. Lifecycle events, metadata reads,
// create calls and checkpoints are reported as response data; the final
// screenshot lands in build/promo_screenshots.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const _scenario = String.fromEnvironment('CAN3643_SCENARIO');
const _theme = String.fromEnvironment('CAN3643_THEME', defaultValue: 'light');
const _draft = 'Fix the login redirect';

RemoteWorktree _worktree(
  String id,
  String branch, [
  RemoteWorktreeSetupPhase phase = RemoteWorktreeSetupPhase.idle,
]) => RemoteWorktree(
  localId: id,
  workspaceLocalId: 'ws-app',
  branch: branch,
  setupPhase: phase,
);

final class _Trace with WidgetsBindingObserver {
  final stopwatch = Stopwatch()..start();
  final events = <Map<String, Object?>>[];

  void record(String event, [Map<String, Object?> data = const {}]) => events
      .add({'event': event, 'ms': stopwatch.elapsedMilliseconds, ...data});

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      record('lifecycle', {'state': state.name});

  int? lastMs(String state) =>
      events
              .where((e) => e['event'] == 'lifecycle' && e['state'] == state)
              .lastOrNull?['ms']
          as int?;
}

// The host driver backgrounds and restores the app over adb or simctl.
Future<void> _requestBackground(int seconds) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('http://127.0.0.1:18766/background?seconds=$seconds'),
    );
    final response = await request.close().timeout(const Duration(seconds: 20));
    final body = await response.transform(utf8.decoder).join();
    if (response.statusCode != 200) throw StateError(body);
  } finally {
    client.close(force: true);
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('CAN-3643 $_scenario $_theme', (tester) async {
    if (!const {'resume', 'retry', 'new-pairing'}.contains(_scenario) ||
        !const {'light', 'dark'}.contains(_theme)) {
      fail(
        'Set CAN3643_SCENARIO to resume, retry or new-pairing and '
        'CAN3643_THEME to light or dark',
      );
    }
    final trace = _Trace()..record('start', {'pid': pid});
    binding.addObserver(trace);
    addTearDown(() => binding.removeObserver(trace));

    final worktrees = [_worktree('wt-1', 'feature/oauth')];
    final createResult = Completer<RemoteWorktreeCreateResult>();
    var metadataReads = 0;
    final repository = FakeRemoteControlRepository()
      ..connectedSessionId = 'session-1'
      ..snapshotBuilder = (() => RemoteSessionSnapshot(
        workspaces: const [
          RemoteWorkspace(
            localId: 'ws-app',
            order: 0,
            name: 'acme-web',
            type: RemoteWorkspaceType.singleRepo,
          ),
        ],
        worktrees: List.of(worktrees),
        standaloneChats: const [],
      ))
      ..createWorktreeHandler = (() => createResult.future)
      ..sessionMetadataBuilder = () {
        // Each read is a new metadata object for the same pairing.
        metadataReads += 1;
        return RemoteConnection(
          deviceLabel: 'Test Desktop',
          pairedAt: DateTime(2026),
          sessionId: 'session-1',
          lastSeenAt: DateTime.now().toUtc(),
        );
      };
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      worktreeCreateRecoveryInterval: const Duration(milliseconds: 500),
      worktreeCreateTimeout: _scenario == 'retry'
          ? const Duration(seconds: 3)
          : kRemoteWorktreeCreateTimeout,
    );
    await vm.connect('123456');
    final pairing = vm.sessionGeneration;

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: _theme == 'dark' ? ThemeMode.dark : ThemeMode.light,
          home: const RemoteScreen(),
        ),
      ),
    );

    final checkpoints = <Map<String, Object?>>[];
    String? draft() => tester
        .widgetList<TextField>(find.byKey(const ValueKey('composer-draft')))
        .firstOrNull
        ?.controller
        ?.text;
    bool canSend() =>
        tester
            .widgetList<CanopyComposerAction>(
              find.byKey(const ValueKey('composer-send')),
            )
            .firstOrNull
            ?.onPressed !=
        null;
    bool shows(String text) => find.textContaining(text).evaluate().isNotEmpty;
    void checkpoint(String name) {
      checkpoints.add({
        'name': name,
        'ms': trace.stopwatch.elapsedMilliseconds,
        'pairing': vm.sessionGeneration,
        'metadataReads': metadataReads,
        'createCalls': repository.createWorktreeCalls.length,
        'draft': draft(),
        'canSend': canSend(),
        'creating': shows('Creating worktree…'),
        'settingUp': shows('Setting up worktree…'),
        'sessionChanged': shows('session changed'),
        'stillCreating': shows('still being created'),
      });
      // Merge: takeScreenshot keeps its captures in the same map.
      binding.reportData = {
        ...?binding.reportData,
        'scenario': _scenario,
        'theme': _theme,
        'events': trace.events,
        'checkpoints': checkpoints,
      };
    }

    Future<void> frames(Duration duration) async {
      // Frames run in real time; a pump while paused would never return.
      final end = trace.stopwatch.elapsed + duration;
      while (trace.stopwatch.elapsed < end) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> until(String what, bool Function() done) async {
      final deadline = trace.stopwatch.elapsed + const Duration(seconds: 20);
      while (!done()) {
        if (trace.stopwatch.elapsed > deadline) fail('Timed out: $what');
        await tester.pump(const Duration(milliseconds: 100));
      }
      trace.record('reached', {'what': what});
    }

    Future<void> backgroundFor(int seconds) async {
      final pausedBefore = trace.lastMs('paused');
      final resumedBefore = trace.lastMs('resumed');
      final readsBefore = metadataReads;
      await _requestBackground(seconds);
      trace.record('background-requested', {'seconds': seconds});
      final deadline =
          trace.stopwatch.elapsed + Duration(seconds: seconds + 60);
      while (trace.stopwatch.elapsed < deadline) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        final paused = trace.lastMs('paused');
        final resumed = trace.lastMs('resumed');
        if (paused != null &&
            paused != pausedBefore &&
            resumed != null &&
            resumed != resumedBefore &&
            resumed > paused) {
          trace.record('cycle-complete', {
            'awayMs': resumed - paused,
            'pid': pid,
          });
          await until('metadata re-read', () => metadataReads > readsBefore);
          return;
        }
      }
      fail('The app did not go to the background and return');
    }

    await frames(const Duration(seconds: 1));
    await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
    await frames(const Duration(seconds: 1));
    expect(find.byType(RemoteChatScreen), findsOneWidget);
    final screen = tester.state(find.byType(RemoteChatScreen));
    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      _draft,
    );
    await frames(const Duration(milliseconds: 500));
    checkpoint('pending-draft');
    expect(repository.createWorktreeCalls, hasLength(1));
    expect(canSend(), isFalse);

    switch (_scenario) {
      case 'resume':
        await backgroundFor(5);
        checkpoint('returned');
        expect(vm.sessionGeneration, pairing);
        expect(draft(), _draft);

        worktrees.add(
          _worktree(
            'wt-2',
            'canopy/otter',
            RemoteWorktreeSetupPhase.gitPending,
          ),
        );
        createResult.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-2',
          ),
        );
        await until('setting up', () => shows('Setting up worktree…'));
        await frames(const Duration(seconds: 2));
        checkpoint('setting-up');
        expect(shows('session changed'), isFalse);
        expect(canSend(), isFalse);
        expect(draft(), _draft);

        worktrees[1] = _worktree('wt-2', 'canopy/otter');
        await until('ready', canSend);
        checkpoint('ready');
        expect(tester.state(find.byType(RemoteChatScreen)), same(screen));
        expect(find.text('canopy/otter'), findsOneWidget);
        expect(draft(), _draft);

        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await until('sent', () => repository.sendChatMessageCalls.isNotEmpty);
        checkpoint('sent');
        final sent = repository.sendChatMessageCalls.single;
        expect(sent.text, _draft);
        expect(
          sent.target,
          isA<RemoteWorktreeChatTarget>().having(
            (target) => target.worktreeLocalId,
            'worktreeLocalId',
            'wt-2',
          ),
        );
      case 'retry':
        createResult.complete(
          const RemoteWorktreeCreateResult(commandId: 'cmd-create'),
        );
        await until('still running', () => shows('still being created'));
        checkpoint('still-running');
        await backgroundFor(5);
        checkpoint('returned');
        expect(vm.sessionGeneration, pairing);

        worktrees.add(_worktree('wt-2', 'canopy/otter'));
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandCompletedEvent(
                commandId: 'cmd-create',
                result: {'id': 'wt-2'},
              ),
            ],
            nextCursor: 1,
          ),
        );
        await frames(const Duration(milliseconds: 500));
        await tester.tap(find.text('Retry'));
        await until('ready', canSend);
        checkpoint('ready');
        expect(find.text('canopy/otter'), findsOneWidget);
        expect(draft(), _draft);
      case 'new-pairing':
        await vm.disconnect();
        await vm.connect('654321');
        await frames(const Duration(milliseconds: 500));
        expect(vm.sessionGeneration, greaterThan(pairing));
        expect(vm.connection?.sessionId, 'session-1');

        worktrees.add(_worktree('wt-old', 'canopy/old'));
        createResult.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-old',
            worktreeLocalId: 'wt-old',
          ),
        );
        await until('old result rejected', () => shows('session changed'));
        checkpoint('old-rejected');
        expect(find.text('canopy/old'), findsNothing);

        repository.createWorktreeHandler = () async {
          worktrees.add(_worktree('wt-new', 'canopy/new'));
          return const RemoteWorktreeCreateResult(
            commandId: 'cmd-new',
            worktreeLocalId: 'wt-new',
          );
        };
        await tester.tap(find.text('Retry'));
        await until('ready', canSend);
        checkpoint('ready');
        expect(find.text('canopy/new'), findsOneWidget);
        expect(find.text('canopy/old'), findsNothing);
        expect(draft(), _draft);
        expect(repository.createWorktreeCalls, hasLength(2));
    }
    expect(tester.state(find.byType(RemoteChatScreen)), same(screen));
    if (_scenario != 'new-pairing') {
      expect(repository.createWorktreeCalls, hasLength(1));
    }

    if (Platform.isAndroid) {
      await binding.convertFlutterSurfaceToImage();
      await tester.pump(const Duration(milliseconds: 300));
    }
    await binding.takeScreenshot(
      'can3643-device-$_scenario-$_theme-${Platform.operatingSystem}',
    );
    checkpoint('done');
    await tester.pumpWidget(const SizedBox());
    vm.dispose();
  }, timeout: const Timeout(Duration(minutes: 4)));
}
