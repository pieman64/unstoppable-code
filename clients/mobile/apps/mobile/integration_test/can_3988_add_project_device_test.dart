// CAN-3988 device verification: add a project to the paired desktop by git
// URL from the Remote Control project list. Runs the real view model, clone
// coordinator, sheet and list on a device, against the in-repo fake
// repository: no desktop or network. Run from apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3988_add_project_device_test.dart \
//     --dart-define=CAN3988_THEME=dark -d <device-id>
//
// One flow covers both entry points, the on-phone URL check (no command
// sent), the busy submit and its hand-off to a pending row, a completion
// event that arrives before the submit answer, a missed completion resolved
// through the command status endpoint, replacement by the real project, a
// desktop failure with Dismiss, an unconfirmed result, and a clone held
// while the desktop reconnects. Checkpoints are reported as response data;
// screenshots land in build/promo_screenshots. Add
// --dart-define=CAN3988_SCREENSHOTS=false when screen recording.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const _theme = String.fromEnvironment('CAN3988_THEME', defaultValue: 'light');
// Screenshots freeze the recorded Flutter surface between captures on Android,
// so screen-recording runs turn them off.
const _screenshots = bool.fromEnvironment(
  'CAN3988_SCREENSHOTS',
  defaultValue: true,
);
const _failure =
    'Failed to clone the repository. Check the URL and access, then try again.';

RemoteWorkspace _project(String id, String name, int order) => RemoteWorkspace(
  localId: id,
  order: order,
  name: name,
  type: RemoteWorkspaceType.singleRepo,
);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('CAN-3988 add project by git URL ($_theme)', (tester) async {
    if (!const {'light', 'dark'}.contains(_theme)) {
      fail('Set CAN3988_THEME to light or dark');
    }
    final stopwatch = Stopwatch()..start();
    final checkpoints = <Map<String, Object?>>[];
    final projects = <RemoteWorkspace>[];
    final repository = FakeRemoteControlRepository()
      ..snapshotBuilder = (() => RemoteSessionSnapshot(
        workspaces: List.of(projects),
        worktrees: const [],
        standaloneChats: const [],
      ));
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
          ),
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
    if (_screenshots && Platform.isAndroid) {
      await binding.convertFlutterSurfaceToImage();
    }

    final urlField = find.byKey(const ValueKey('add-project-url'));
    final submit = find.byKey(const ValueKey('add-project-submit'));
    bool shows(String text) => find.text(text).evaluate().isNotEmpty;
    bool hasKey(String key) => find.byKey(ValueKey(key)).evaluate().isNotEmpty;

    /// Pumps frames for [duration]; pending rows animate, so never settle.
    Future<void> frames([
      Duration duration = const Duration(milliseconds: 600),
    ]) async {
      final end = stopwatch.elapsed + duration;
      while (stopwatch.elapsed < end) {
        await tester.pump(const Duration(milliseconds: 16));
      }
    }

    /// Pumps until [condition] holds, failing after [timeout].
    Future<void> until(
      String what,
      bool Function() condition, {
      Duration timeout = const Duration(seconds: 15),
    }) async {
      final end = stopwatch.elapsed + timeout;
      while (!condition()) {
        if (stopwatch.elapsed > end) fail('Timed out waiting for $what');
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    Future<void> checkpoint(String name, {String? screenshot}) async {
      checkpoints.add({
        'name': name,
        'ms': stopwatch.elapsedMilliseconds,
        'cloneCommands': repository.createProjectCalls.length,
        'statusReads': repository.commandStatusReads.length,
        'rows': [
          for (final clone in viewModel.projectClones)
            '${clone.name}:${clone.phase.name}',
        ],
        'projects': [for (final project in projects) project.localId],
      });
      if (_screenshots && screenshot != null) {
        await frames(const Duration(milliseconds: 400));
        await binding.takeScreenshot(
          'can-3988-android-$screenshot-device-$_theme',
        );
      }
    }

    Future<void> openSheet(String entry) async {
      await tester.tap(find.byKey(ValueKey(entry)));
      await frames();
      expect(hasKey('add-project-sheet'), isTrue);
    }

    Future<void> submitUrl(String url) async {
      await tester.enterText(urlField, url);
      await tester.tap(submit);
      await frames(const Duration(milliseconds: 200));
    }

    void deliver(Map<String, Object?> event) => repository.eventsController.add(
      RemotePortalEventBatch.fromJson({
        'events': [event],
        'nextCursor': 1,
      }),
    );

    // 1. Empty state entry and the on-phone URL check.
    await frames();
    expect(shows('No projects yet'), isTrue);
    await openSheet('add-project-empty');
    await submitUrl('github.com/acme/widgets');
    expect(
      shows(
        'Enter a remote git URL, like https://github.com/org/repo.git or '
        'git@github.com:org/repo.git.',
      ),
      isTrue,
    );
    expect(repository.createProjectCalls, isEmpty);
    await checkpoint('invalid-url-rejected', screenshot: 'sheet-invalid');

    // 2. A busy submit hands off to a pending row.
    final firstAnswer = Completer<RemotePortalCommandResult>();
    repository.createProjectHandler = (_) => firstAnswer.future;
    await submitUrl('https://github.com/acme/widgets.git');
    expect(shows('Adding…'), isTrue);
    await tester.tap(submit, warnIfMissed: false);
    await frames(const Duration(milliseconds: 200));
    expect(repository.createProjectCalls, hasLength(1));
    await checkpoint('submit-busy', screenshot: 'sheet-busy');
    firstAnswer.complete(const RemotePortalCommandResult(commandId: 'clone-a'));
    await until('the sheet to close', () => !hasKey('add-project-sheet'));
    expect(shows('widgets'), isTrue);
    expect(shows('Cloning…'), isTrue);
    expect(shows('No projects yet'), isFalse);
    await checkpoint('pending-row', screenshot: 'pending-cloning');

    // 3. Header entry; the completion event arrives before the submit answer.
    repository.createProjectHandler = (_) async {
      projects.add(_project('ws-api', 'api', 0));
      deliver({
        'type': 'portal.command.completed',
        'payload': {
          'commandId': 'clone-b',
          'result': {'workspaceId': 'ws-api'},
        },
      });
      await Future<void>.delayed(const Duration(milliseconds: 200));
      return const RemotePortalCommandResult(commandId: 'clone-b');
    };
    await openSheet('add-project-header');
    await submitUrl('git@github.com:acme/api.git');
    await until('api to replace its row', () => hasKey('workspace-ws-api'));
    expect(
      viewModel.projectClones.map((clone) => clone.name),
      isNot(contains('api')),
    );
    await checkpoint('early-completion-replaced');

    // 4. A missed completion resolves through the command status endpoint.
    repository.commandStatusHandler = (commandId) async {
      if (commandId == 'clone-a') {
        projects.add(_project('ws-widgets', 'widgets', 1));
        return BrowserPortalCommandStatusResponse(
          commandId: commandId,
          status: BrowserPortalCommandStatus.completed,
          result: const {'workspaceId': 'ws-widgets'},
        );
      }
      return BrowserPortalCommandStatusResponse(
        commandId: commandId,
        status: BrowserPortalCommandStatus.delivered,
      );
    };
    await until(
      'widgets to replace its row',
      () => hasKey('workspace-ws-widgets'),
    );
    expect(viewModel.projectClones, isEmpty);
    expect(find.text('widgets'), findsOneWidget);
    await checkpoint('status-completion-replaced', screenshot: 'populated');

    // 5. A desktop failure shows its message with Dismiss only.
    repository.createProjectHandler = (_) async =>
        const RemotePortalCommandResult(commandId: 'clone-c', error: _failure);
    await openSheet('add-project-header');
    await submitUrl('https://github.com/acme/private.git');
    await until('the failed row', () => shows(_failure));
    expect(shows('Retry'), isFalse);
    await checkpoint('failed-row', screenshot: 'failed');
    await tester.tap(find.text('Dismiss'));
    await frames();
    expect(shows(_failure), isFalse);

    // 6. A dropped connection asks the user to check Projects.
    repository.createProjectHandler = (_) async =>
        throw http.ClientException('Connection closed');
    await openSheet('add-project-header');
    await submitUrl('https://github.com/acme/docs.git');
    const unconfirmed =
        "Couldn't confirm that the clone finished. Check Projects before "
        'trying again.';
    await until('the unconfirmed row', () => shows(unconfirmed));
    await checkpoint('unknown-row', screenshot: 'unknown');
    await tester.tap(find.text('Dismiss'));
    await frames();

    // 7. A clone held while the desktop reconnects says so.
    repository.createProjectHandler = (_) async =>
        const RemotePortalCommandResult(
          commandId: 'clone-e',
          queuedWhileReconnecting: true,
        );
    await openSheet('add-project-header');
    await submitUrl('https://github.com/acme/site.git');
    await until(
      'the queued row',
      () => shows("Waiting for the desktop… The clone starts when it's back."),
    );
    await checkpoint('queued-row', screenshot: 'queued');

    // One command per deliberate submit; the invalid URL sent none.
    expect(repository.createProjectCalls, hasLength(5));
    expect(tester.takeException(), isNull);
    binding.reportData = {...?binding.reportData, 'checkpoints': checkpoints};

    await tester.pumpWidget(const SizedBox.shrink());
    viewModel.dispose();
  });
}
