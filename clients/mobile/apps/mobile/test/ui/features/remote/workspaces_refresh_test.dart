import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';

import '../../../support/fake_remote_control_repository.dart';

/// Connects successfully and serves one snapshot, then fails every subsequent
/// [fetchSnapshot] — modelling a live transport that drops mid-session so the
/// connected pull-to-refresh failure path can be exercised.
final class _RefreshFailsRepository extends FakeRemoteControlRepository {
  bool _servedFirstSnapshot = false;

  @override
  Future<RemoteConnection> connect(String pairingCode) async =>
      RemoteConnection(deviceLabel: 'Test Desktop', pairedAt: DateTime(2026));

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    if (_servedFirstSnapshot) {
      throw const RemoteControlException('refresh failed');
    }
    _servedFirstSnapshot = true;
    return const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-1',
          name: 'acme-web',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [],
      standaloneChats: [],
    );
  }
}

void main() {
  group('WorkspacesListView pull-to-refresh failure', () {
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    testWidgets('pull refresh retries an accepted empty chat index', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..supportsWorktreeChatSummariesScope = true;
      final vm = RemoteControlViewModel(repository: repo);
      await vm.connect('123456');
      vm.ensureChatSummariesIndex();
      repo.eventsController.add(
        const RemotePortalEventBatch(
          events: [RemoteStateSnapshotEvent(scope: 'worktree_chat_summaries')],
          nextCursor: 1,
        ),
      );
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: vm,
          child: MaterialApp(theme: AppTheme.light, home: const RemoteScreen()),
        ),
      );
      await tester.pumpAndSettle();
      expect(repo.requestWorktreeChatSummariesStateCalls, 1);
      await tester.fling(
        find.byType(RefreshIndicator),
        const Offset(0, 320),
        1200,
      );
      await tester.pumpAndSettle();
      expect(repo.requestWorktreeChatSummariesStateCalls, 2);
      expect(repo.requestWorktreeStateCalls, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    testWidgets('surfaces a retryable SnackBar when a refresh fails', (
      tester,
    ) async {
      usePhoneViewport(tester);

      final vm = RemoteControlViewModel(repository: _RefreshFailsRepository());
      await vm.connect('123456');
      expect(vm.isConnected, isTrue);

      await tester.pumpWidget(
        ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: vm,
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: const RemoteScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('acme-web'), findsOneWidget);

      // Trigger pull-to-refresh; the second fetchSnapshot throws.
      await tester.fling(
        find.byType(RefreshIndicator),
        const Offset(0, 320),
        1200,
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Could not refresh projects'), findsOneWidget);
      expect(find.widgetWithText(SnackBarAction, 'Retry'), findsOneWidget);
      // The view model recorded the error but stayed connected (list intact).
      expect(vm.isConnected, isTrue);
      expect(vm.error, isNotNull);
      expect(find.text('acme-web'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'an empty snapshot still syncing shows the syncing state, not empty',
      (tester) async {
        usePhoneViewport(tester);

        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [],
          refreshing: true,
        );
        final vm = RemoteControlViewModel(repository: repository);
        await vm.connect('123456');

        await tester.pumpWidget(
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: vm,
            child: MaterialApp(
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              home: const RemoteScreen(),
            ),
          ),
        );
        await tester.pump();

        expect(find.text('Syncing with your desktop…'), findsOneWidget);
        expect(find.text('No projects yet'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  });
}
