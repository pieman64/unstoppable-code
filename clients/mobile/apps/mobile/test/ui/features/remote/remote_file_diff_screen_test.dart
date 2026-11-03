import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_diff_cache.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_activity_load_tracker.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_file_diff_screen.dart';

import '../../../support/changed_files_fixture.dart';
import '../../../support/fake_remote_control_repository.dart';

const _patch =
    'diff --git a/lib/a.dart b/lib/a.dart\n'
    '--- a/lib/a.dart\n'
    '+++ b/lib/a.dart\n'
    '@@ -1,3 +1,3 @@\n'
    ' void main() {\n'
    "-  print('old');\n"
    "+  print('new');\n"
    ' }\n';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  group('Remote file diff screen', () {
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget host(RemoteControlViewModel viewModel, Widget screen) =>
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>(
              create: (_) => viewModel,
            ),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(theme: AppTheme.light, home: screen),
        );

    RemoteSessionSnapshot snapshot({
      bool withChangedFiles = true,
      bool revisioned = true,
    }) => RemoteSessionSnapshot(
      workspaces: const [],
      worktrees: const [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
      ],
      standaloneChats: const [],
      chatSummaries: const [
        RemoteChatSummary(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat A',
          active: true,
        ),
      ],
      chatMessages: const [],
      raw: withChangedFiles
          ? {
              'changedFiles': {
                'wt-1': {
                  'worktreeLocalId': 'wt-1',
                  if (revisioned) 'revision': 'revision-1',
                  'uncommitted': [
                    {'filePath': 'lib/u.dart', 'status': 'modified'},
                  ],
                  'committed': [
                    {
                      'filePath': 'lib/a.dart',
                      'status': 'modified',
                      'repoId': 'api',
                      'repoName': 'api',
                      'insertions': 1,
                      'deletions': 1,
                    },
                  ],
                },
              },
            }
          : const {},
    );

    /// Lets in-flight repository futures complete, then advances past the
    /// drawer and tab animations with bounded pumps.
    Future<void> settleReads(WidgetTester tester) async {
      await tester.runAsync(() async {
        for (var i = 0; i < 4; i++) {
          await Future<void>.delayed(Duration.zero);
        }
      });
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<RemoteControlViewModel> openFilesTab(
      WidgetTester tester,
      FakeRemoteControlRepository repository, {
      bool withChangedFiles = true,
      bool restoreSession = false,
      bool persistDiffs = false,
      bool swipeOpen = false,
      bool settle = true,
      bool revisioned = true,
    }) async {
      usePhoneViewport(tester);
      repository.snapshotBuilder = () =>
          snapshot(withChangedFiles: withChangedFiles, revisioned: revisioned);
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        fileDiffCache: persistDiffs
            ? RemoteFileDiffCache(maxEntries: 32, persist: true)
            : null,
      );
      await tester.runAsync(
        () => restoreSession ? vm.restoreIfIdle() : vm.connect('123456'),
      );
      final worktree = vm.worktreesFor('ws-1').single;
      await tester.pumpWidget(
        host(vm, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      if (swipeOpen) {
        await tester.dragFrom(const Offset(389, 400), const Offset(-300, 0));
      } else {
        await tester.tap(find.byKey(const ValueKey('open-activity')));
      }
      await tester.pumpAndSettle();
      await tester.tap(find.text('Files'));
      // A loading Files tab animates its spinner until its result settles.
      settle ? await tester.pumpAndSettle() : await settleReads(tester);
      return vm;
    }

    for (final swipeOpen in [false, true]) {
      testWidgets(
        'opening Files via ${swipeOpen ? 'swipe' : 'icon'} hydrates activity after foreground-only chat '
        'loading leaves a warm cache without changed files',
        (tester) async {
          final repository = _ForegroundActivityRepository();
          repository.readFileDiffHandler = (path, source) async =>
              RemoteFileDiff(
                filePath: path,
                patch: '@@ -1 +1 @@\n-old\n+new\n',
              );
          await openFilesTab(
            tester,
            repository,
            withChangedFiles: false,
            swipeOpen: swipeOpen,
            // The read after the projection's snapshot runs where the
            // session connected.
            settle: false,
          );
          await tester.pumpAndSettle();

          expect(find.text('No changed files.'), findsNothing);
          expect(find.text('hydrated.dart'), findsOneWidget);
          expect(repository.requestWorktreeStateCalls, 1);
          await tester.tap(find.text('hydrated.dart'));
          await tester.pumpAndSettle();
          expect(find.text('+new'), findsOneWidget);
          expect(
            repository.readFileDiffCalls.single.source,
            RemoteDiffSource.uncommitted,
          );
          expect(tester.takeException(), isNull);
        },
      );
    }

    testWidgets('tapping a committed file reads its committed diff and '
        'renders colored lines', (tester) async {
      final repository = FakeRemoteControlRepository();
      repository.readFileDiffHandler = (path, source) async =>
          const RemoteFileDiff(
            filePath: 'lib/a.dart',
            patch: _patch,
            repoId: 'api',
            rangeLabel: 'main..HEAD',
            insertions: 1,
            deletions: 1,
          );
      await openFilesTab(tester, repository);

      await tester.tap(find.text('a.dart'));
      await tester.pumpAndSettle();

      expect(find.byType(RemoteFileDiffScreen), findsOneWidget);
      final call = repository.readFileDiffCalls.single;
      expect(call.workspaceLocalId, 'ws-1');
      expect(call.worktreeLocalId, 'wt-1');
      expect(call.path, 'lib/a.dart');
      expect(call.repoId, 'api');
      expect(call.source, RemoteDiffSource.committed);

      // Header: file name in the app bar, range label in the body.
      expect(find.text('a.dart'), findsOneWidget);
      expect(find.textContaining('main..HEAD'), findsOneWidget);

      // Body: add/del lines keep their markers and take status colors.
      Color? colorOf(String text) {
        final widget = tester.widget<Text>(find.text(text));
        return widget.style?.color;
      }

      expect(colorOf("-  print('old');"), StatusColors.light.destructive);
      expect(colorOf("+  print('new');"), StatusColors.light.success);
      expect(find.text('@@ -1,3 +1,3 @@'), findsOneWidget);
      // Per-file headers repeat what the screen header already says.
      expect(find.text('diff --git a/lib/a.dart b/lib/a.dart'), findsNothing);
      expect(find.text('--- a/lib/a.dart'), findsNothing);
      expect(find.text('+++ b/lib/a.dart'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Files tab updates when changed files arrive after its eager '
        'cache read', (tester) async {
      final repository = FakeRemoteControlRepository();
      await openFilesTab(
        tester,
        repository,
        withChangedFiles: false,
        settle: false,
      );

      // CAN-3644: the eager read is no proof of an empty worktree.
      expect(find.text('No changed files.'), findsNothing);
      expect(find.text('Loading changed files…'), findsOneWidget);
      repository.worktreeStateSlices = {
        'wt-1': {
          'changedFiles': {
            'wt-1': {
              'uncommitted': [
                {'filePath': 'lib/arrived_later.dart', 'status': 'modified'},
              ],
              'committed': [],
            },
          },
        },
      };
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
          nextCursor: 7,
        ),
      );
      await tester.runAsync(() async {
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pumpAndSettle();

      expect(find.text('No changed files.'), findsNothing);
      expect(find.text('arrived_later.dart'), findsOneWidget);
    });

    // CAN-3644: the eager cache read settles before the requested projection
    // lands. Until the read that follows the worktree snapshot settles, the
    // tab is loading, not a confirmed empty worktree. Pumps are bounded: the
    // loading spinner animates until the files arrive.
    for (final swipeOpen in [false, true]) {
      for (final empty in [false, true]) {
        testWidgets(
          'CAN3644 delayed Files via ${swipeOpen ? 'edge swipe' : 'toolbar'} '
          'loads until the projected ${empty ? 'empty' : 'populated'} '
          'result settles',
          (tester) async {
            usePhoneViewport(tester);
            // A current host: the chat opens through foreground hydration,
            // and only the drawer asks the desktop to project the worktree.
            final repository = FakeRemoteControlRepository()
              ..supportsForegroundChat = true;
            repository.snapshotBuilder = () =>
                snapshot(withChangedFiles: false);
            final vm = RemoteControlViewModel(
              repository: repository,
              stateRefreshDebounce: Duration.zero,
            );
            await tester.runAsync(() => vm.connect('123456'));
            final worktree = vm.worktreesFor('ws-1').single;
            await tester.pumpWidget(
              host(vm, RemoteChatScreen.worktree(worktree: worktree)),
            );
            await tester.pumpAndSettle();
            if (swipeOpen) {
              await tester.dragFrom(
                const Offset(389, 400),
                const Offset(-300, 0),
              );
            } else {
              await tester.tap(find.byKey(const ValueKey('open-activity')));
            }
            await settleReads(tester);
            await tester.tap(find.text('Files'));
            await settleReads(tester);

            expect(repository.requestWorktreeStateCalls, 1);
            expect(find.text('No changed files.'), findsNothing);
            expect(find.text('Loading changed files…'), findsOneWidget);

            // The desktop's projection lands, but the read that follows it
            // has not answered yet.
            final gate = Completer<void>();
            repository.worktreeStateSlicesGate = gate;
            repository.worktreeStateSlices = {
              'wt-1': {
                'changedFiles': {
                  'wt-1': {
                    'uncommitted': [
                      if (!empty)
                        {'filePath': 'lib/arrived.dart', 'status': 'modified'},
                    ],
                    'committed': [],
                  },
                },
              },
            };
            final readsBefore = repository.fetchWorktreeStateSlicesCalls;
            repository.eventsController.add(
              const RemotePortalEventBatch(
                events: [
                  RemoteStateSnapshotEvent(
                    scope: 'worktree',
                    targetWorkspaceLocalId: 'ws-1',
                    targetWorktreeLocalId: 'wt-1',
                  ),
                ],
                nextCursor: 7,
              ),
            );
            await settleReads(tester);
            expect(repository.fetchWorktreeStateSlicesCalls, readsBefore + 1);
            expect(find.text('Loading changed files…'), findsOneWidget);
            expect(find.text('No changed files.'), findsNothing);

            gate.complete();
            await settleReads(tester);

            expect(find.text('Loading changed files…'), findsNothing);
            if (empty) {
              expect(find.text('No changed files.'), findsOneWidget);
            } else {
              expect(find.text('No changed files.'), findsNothing);
              expect(find.text('arrived.dart'), findsOneWidget);
            }
            expect(tester.takeException(), isNull);
          },
        );
      }
    }

    Future<void> openFixtureFiles(WidgetTester tester) async {
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await settleReads(tester);
      await tester.tap(find.text('Files'));
      await settleReads(tester);
    }

    testWidgets('CAN3644 a failed projection offers Retry instead of an '
        'empty list, and Retry reloads', (tester) async {
      usePhoneViewport(tester);
      final repository = ChangedFilesFixtureRepository()
        ..projectionError = changedFilesProjectionError;
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(changedFilesHost(vm));
      await settleReads(tester);
      await openFixtureFiles(tester);

      expect(find.text('No changed files.'), findsNothing);
      expect(
        find.text("Couldn't load changed files. Try again."),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('retry-changed-files')));
      await settleReads(tester);
      expect(repository.requestWorktreeStateCalls, 2);
      expect(find.text('Loading changed files…'), findsOneWidget);

      repository.landProjection('wt-1', changedFilesFirstProjection);
      await settleReads(tester);
      expect(find.text('invoice_total.dart'), findsOneWidget);
      expect(find.text('Loading changed files…'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    testWidgets('CAN3644 a reopened drawer keeps cached files while the '
        'refresh is outstanding', (tester) async {
      usePhoneViewport(tester);
      final repository = ChangedFilesFixtureRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(changedFilesHost(vm));
      await settleReads(tester);
      await openFixtureFiles(tester);
      repository.landProjection('wt-1', changedFilesFirstProjection);
      await settleReads(tester);
      expect(find.text('tax_rules.dart'), findsOneWidget);

      Navigator.of(tester.element(find.byType(Drawer))).pop();
      await settleReads(tester);
      await tester.dragFrom(const Offset(389, 400), const Offset(-300, 0));
      await settleReads(tester);
      await tester.tap(find.text('Files'));
      await settleReads(tester);
      expect(find.text('tax_rules.dart'), findsOneWidget);
      expect(find.text('Checking for changes…'), findsOneWidget);

      repository.landProjection('wt-1', changedFilesSecondProjection);
      await settleReads(tester);
      expect(find.text('currency_format.dart'), findsOneWidget);
      expect(find.text('tax_rules.dart'), findsNothing);
      expect(find.text('Checking for changes…'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    // A chat opened on an older host requests the worktree without a Files
    // load. Its projection lands while the chat transcript still loads. The
    // read after the landing is a server-cache read, so it goes out at once
    // (CAN-4875), and the request stays pending until it answers. Files
    // opened meanwhile joins that request: the read settles it, and no
    // deadline or Retry is needed.
    for (final empty in [false, true]) {
      testWidgets('CAN3644 Files opened after the worktree projection landed '
          'settles ${empty ? 'empty' : 'populated'} on the read after it', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => snapshot(withChangedFiles: false);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        final worktree = vm.worktreesFor('ws-1').single;
        await tester.pumpWidget(
          host(
            vm,
            RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-1',
            ),
          ),
        );
        await settleReads(tester);
        expect(repository.requestWorktreeStateCalls, 1);
        expect(repository.requestChatTranscriptCalls, greaterThan(0));

        repository.worktreeStateSlices = {
          'wt-1': {
            'changedFiles': {
              'wt-1': {
                'uncommitted': [
                  if (!empty)
                    {'filePath': 'lib/projected.dart', 'status': 'modified'},
                ],
                'committed': [],
              },
            },
          },
        };
        final readsBefore = repository.fetchWorktreeStateSlicesCalls;
        final read = repository.worktreeStateSlicesGate = Completer<void>();
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
            nextCursor: 7,
          ),
        );
        await settleReads(tester);
        // The read does not wait for the chat transcript.
        expect(repository.fetchWorktreeStateSlicesCalls, readsBefore + 1);

        await tester.tap(find.byKey(const ValueKey('open-activity')));
        await settleReads(tester);
        await tester.tap(find.text('Files'));
        await settleReads(tester);
        // The load joined the pending request.
        expect(repository.requestWorktreeStateCalls, 1);

        // The read after the landing answers.
        repository.worktreeStateSlicesGate = null;
        read.complete();
        await settleReads(tester);
        expect(repository.fetchWorktreeStateSlicesCalls, readsBefore + 1);

        void expectSettled() {
          expect(find.text('Loading changed files…'), findsNothing);
          expect(find.text('Checking for changes…'), findsNothing);
          expect(
            find.text('Changed files took too long to load. Try again.'),
            findsNothing,
          );
          if (empty) {
            expect(find.text('No changed files.'), findsOneWidget);
          } else {
            expect(find.text('projected.dart'), findsOneWidget);
          }
        }

        expectSettled();
        await tester.pump(kRemoteHydrationTimeout);
        await settleReads(tester);
        expectSettled();
        expect(tester.takeException(), isNull);
      });
    }

    // A refreshing read after a landing lets the engine finish the request
    // while Files still loads. Reopening the drawer sends a new request; an
    // eager read before its projection must keep the held list and loading.
    for (final eager in ['empty', 'different']) {
      testWidgets('CAN3644 a reopening after a refreshing read keeps the held '
          'files until its own projection settles ($eager eager roster)', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = ChangedFilesFixtureRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(changedFilesHost(vm));
        await settleReads(tester);
        await openFixtureFiles(tester);
        repository.landProjection('wt-1', changedFilesFirstProjection);
        await settleReads(tester);
        expect(find.text('tax_rules.dart'), findsOneWidget);

        Future<void> reopen() async {
          Navigator.of(tester.element(find.byType(Drawer))).pop();
          await settleReads(tester);
          await openFixtureFiles(tester);
        }

        void expectHeld() {
          expect(find.text('No changed files.'), findsNothing);
          expect(find.text('release_notes.md'), findsNothing);
          expect(find.text('tax_rules.dart'), findsOneWidget);
          expect(find.text('Checking for changes…'), findsOneWidget);
        }

        await reopen();
        repository.worktreeStateSlicesRefreshing = true;
        repository.landProjection('wt-1', changedFilesSecondProjection);
        await settleReads(tester);
        expect(repository.requestWorktreeStateCalls, 2);
        expectHeld();

        repository
          ..worktreeStateSlicesRefreshing = false
          ..cacheFiles(
            'wt-1',
            eager == 'empty' ? const [] : changedFilesOtherWorktree,
          );
        await reopen();
        expect(repository.requestWorktreeStateCalls, 3);
        expectHeld();

        repository.landProjection('wt-1', changedFilesSecondProjection);
        await settleReads(tester);
        expect(find.text('currency_format.dart'), findsOneWidget);
        expect(find.text('tax_rules.dart'), findsNothing);
        expect(find.text('Checking for changes…'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        vm.dispose();
      });
    }

    // The server cache can change before a reopened drawer's projection
    // lands. Its eager answer confirms nothing: the shown list and its scroll
    // position stay through the refresh, a timeout and Retry, until the read
    // after the projection replaces them.
    for (final eager in ['empty', 'different']) {
      testWidgets('CAN3644 an eager $eager roster keeps the cached files and '
          'scroll position until the projected roster settles', (tester) async {
        usePhoneViewport(tester);
        final repository = ChangedFilesFixtureRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(changedFilesHost(vm));
        await settleReads(tester);
        await openFixtureFiles(tester);
        repository.landProjection('wt-1', changedFilesLongProjection);
        await settleReads(tester);
        expect(find.text('rule_00.dart'), findsOneWidget);

        final roster = eager == 'empty'
            ? const <Map<String, dynamic>>[]
            : changedFilesSecondProjection;
        repository.cacheFiles('wt-1', roster);
        Navigator.of(tester.element(find.byType(Drawer))).pop();
        await settleReads(tester);
        await tester.tap(find.byKey(const ValueKey('open-activity')));
        await settleReads(tester);
        await tester.tap(find.text('Files'));
        await settleReads(tester);
        expect(find.text('Checking for changes…'), findsOneWidget);
        expect(find.text('rule_00.dart'), findsOneWidget);

        final list = find.byKey(const ValueKey('changed-files-list'));
        ScrollPosition position() => tester
            .state<ScrollableState>(
              find.descendant(of: list, matching: find.byType(Scrollable)),
            )
            .position;
        await tester.drag(list, const Offset(0, -600));
        await settleReads(tester);
        final offset = position().pixels;
        expect(offset, greaterThan(0));

        void expectCachedList() {
          expect(find.text('No changed files.'), findsNothing);
          expect(find.text('currency_format.dart'), findsNothing);
          expect(position().pixels, offset);
          expect(find.textContaining('rule_'), findsWidgets);
        }

        expectCachedList();
        await tester.pump(kRemoteHydrationTimeout);
        await settleReads(tester);
        expect(
          find.text('Changed files took too long to load. Try again.'),
          findsOneWidget,
        );
        expectCachedList();

        await tester.tap(find.byKey(const ValueKey('retry-changed-files')));
        await settleReads(tester);
        expect(find.text('Checking for changes…'), findsOneWidget);
        expectCachedList();

        repository.landProjection('wt-1', roster);
        await settleReads(tester);
        expect(find.text('Checking for changes…'), findsNothing);
        expect(find.textContaining('rule_'), findsNothing);
        if (eager == 'empty') {
          expect(find.text('No changed files.'), findsOneWidget);
        } else {
          expect(find.text('currency_format.dart'), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        vm.dispose();
      });
    }

    // A replaced session forgets the previous one's loads. While Files stays
    // open, the new session must start its own bounded load rather than
    // spin with nothing requested. With [serverCached] the relay still holds
    // the old projection, which shows as a cached list until confirmed.
    for (final serverCached in [false, true]) {
      for (final outcome in ['settles', 'fails', 'times out']) {
        testWidgets('CAN3644 Files left open across a reconnect '
            '${serverCached ? 'with a server-cached list ' : ''}reloads and '
            '$outcome within the deadline', (tester) async {
          usePhoneViewport(tester);
          final repository = ChangedFilesFixtureRepository();
          final vm = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => vm.connect('123456'));
          await tester.pumpWidget(changedFilesHost(vm));
          await settleReads(tester);
          await openFixtureFiles(tester);
          repository.landProjection('wt-1', changedFilesFirstProjection);
          await settleReads(tester);
          expect(find.text('tax_rules.dart'), findsOneWidget);

          await tester.runAsync(vm.disconnect);
          await settleReads(tester);
          expect(find.text(kChangedFilesOffline), findsOneWidget);
          expect(
            find.byKey(const ValueKey('retry-changed-files')),
            findsNothing,
          );
          expect(find.text('No changed files.'), findsNothing);

          if (!serverCached) repository.worktreeStateSlices.remove('wt-1');
          // The new session reads nothing before its projection lands, so a
          // server-cached list stays hidden until confirmed (CAN-4875).
          void expectLoading() {
            expect(find.text('Loading changed files…'), findsOneWidget);
            expect(find.text('tax_rules.dart'), findsNothing);
          }

          final requests = repository.requestWorktreeStateCalls;
          if (outcome == 'fails') {
            repository.projectionError = changedFilesProjectionError;
          }
          await tester.runAsync(() => vm.connect('123456'));
          await settleReads(tester);
          expect(find.byType(Drawer), findsOneWidget);

          switch (outcome) {
            case 'settles':
              expectLoading();
              // Another worktree's projection cannot answer this load.
              repository.landProjection('wt-2', changedFilesOtherWorktree);
              await settleReads(tester);
              expectLoading();
              repository.landProjection('wt-1', changedFilesSecondProjection);
              await settleReads(tester);
              expect(find.text('currency_format.dart'), findsOneWidget);
              expect(find.text('tax_rules.dart'), findsNothing);
              expect(find.text('Loading changed files…'), findsNothing);
              expect(find.text('Checking for changes…'), findsNothing);
            case 'fails':
              expect(
                find.text("Couldn't load changed files. Try again."),
                findsOneWidget,
              );
            case 'times out':
              expectLoading();
              await tester.pump(kRemoteHydrationTimeout);
              await settleReads(tester);
              expect(
                find.text('Changed files took too long to load. Try again.'),
                findsOneWidget,
              );
          }
          expect(find.text('No changed files.'), findsNothing);
          // The open drawer asked the new session for one fresh projection.
          expect(repository.requestWorktreeStateCalls, requests + 1);

          if (outcome != 'settles') {
            await tester.tap(find.byKey(const ValueKey('retry-changed-files')));
            await settleReads(tester);
            expect(repository.requestWorktreeStateCalls, requests + 2);
            expectLoading();
            repository.landProjection('wt-1', changedFilesSecondProjection);
            await settleReads(tester);
            expect(find.text('currency_format.dart'), findsOneWidget);
          }
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
          vm.dispose();
        });
      }
    }

    // Without a connection a projection cannot be requested, so the offline
    // state must not offer a Retry that does nothing. Recovery is the
    // existing one: reconnecting reloads the Files tab left open.
    testWidgets('CAN3644 offline Files offers no Retry, and a reconnect with '
        'the drawer open restores a working Retry', (tester) async {
      usePhoneViewport(tester);
      final repository = ChangedFilesFixtureRepository()
        ..projectionError = changedFilesProjectionError;
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(changedFilesHost(vm));
      await settleReads(tester);
      await openFixtureFiles(tester);
      final retry = find.byKey(const ValueKey('retry-changed-files'));
      expect(find.text(kChangedFilesLoadFailed), findsOneWidget);
      expect(retry, findsOneWidget);

      await tester.runAsync(vm.disconnect);
      await settleReads(tester);
      final requests = repository.requestWorktreeStateCalls;
      expect(retry, findsNothing);
      expect(
        find.descendant(
          of: find.byType(TabBarView),
          matching: find.byWidgetPredicate(
            (widget) => widget is ButtonStyleButton && widget.enabled,
          ),
        ),
        findsNothing,
      );
      expect(find.text(kChangedFilesOffline), findsOneWidget);
      expect(
        kChangedFilesOffline,
        'Not connected to your desktop. Go back and reconnect to load '
        'changed files.',
      );
      expect(find.text('No changed files.'), findsNothing);
      expect(find.text('Loading changed files…'), findsNothing);
      expect(repository.requestWorktreeStateCalls, requests);

      repository.projectionError = changedFilesProjectionError;
      await tester.runAsync(() => vm.connect('123456'));
      await settleReads(tester);
      expect(find.byType(Drawer), findsOneWidget);
      expect(repository.requestWorktreeStateCalls, requests + 1);
      expect(find.text(kChangedFilesLoadFailed), findsOneWidget);
      expect(find.text(kChangedFilesOffline), findsNothing);

      await tester.tap(retry);
      await settleReads(tester);
      expect(repository.requestWorktreeStateCalls, requests + 2);
      expect(find.text('Loading changed files…'), findsOneWidget);
      repository.landProjection('wt-1', changedFilesSecondProjection);
      await settleReads(tester);
      expect(find.text('currency_format.dart'), findsOneWidget);
      expect(find.text('No changed files.'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    testWidgets('CAN3644 another worktree\'s projection does not settle the '
        'open worktree', (tester) async {
      usePhoneViewport(tester);
      final repository = ChangedFilesFixtureRepository();
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(changedFilesHost(vm));
      await settleReads(tester);
      await openFixtureFiles(tester);

      // Switch to the second worktree's chat while the first still loads.
      await tester.pumpWidget(changedFilesHost(vm, worktreeLocalId: 'wt-2'));
      await settleReads(tester);
      await openFixtureFiles(tester);
      repository.landProjection('wt-1', changedFilesFirstProjection);
      await settleReads(tester);
      expect(find.text('invoice_total.dart'), findsNothing);
      expect(find.text('No changed files.'), findsNothing);
      expect(find.text('Loading changed files…'), findsOneWidget);

      repository.landProjection('wt-2', changedFilesOtherWorktree);
      await settleReads(tester);
      expect(find.text('release_notes.md'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    for (final swipeOpen in [false, true]) {
      testWidgets(
        'reopening via ${swipeOpen ? 'swipe' : 'icon'} re-projects changed files the agent '
        'made after the first worktree hydration',
        (tester) async {
          final repository = _ProjectingActivityRepository();
          await openFilesTab(tester, repository, withChangedFiles: false);
          await tester.runAsync(() async {
            for (var i = 0; i < 3; i++) {
              await Future<void>.delayed(Duration.zero);
            }
          });
          await tester.pumpAndSettle();
          expect(find.text('No changed files.'), findsOneWidget);
          expect(repository.requestWorktreeStateCalls, 1);

          // The drawer closes, the agent edits a file on the desktop. The overview
          // totals update live, but the server's cached roster only changes when
          // the desktop is asked to project the worktree again.
          Navigator.of(tester.element(find.byType(Drawer))).pop();
          await tester.pumpAndSettle();
          repository.desktopChangedFiles = [
            {'filePath': 'lib/edited.dart', 'status': 'modified'},
          ];

          expect(repository.requestWorktreeStateCalls, 1);
          if (swipeOpen) {
            await tester.dragFrom(
              const Offset(389, 400),
              const Offset(-300, 0),
            );
          } else {
            await tester.tap(find.byKey(const ValueKey('open-activity')));
          }
          await tester.runAsync(() async {
            for (var i = 0; i < 3; i++) {
              await Future<void>.delayed(Duration.zero);
            }
          });
          await tester.pumpAndSettle();
          await tester.tap(find.text('Files'));
          await tester.pumpAndSettle();

          expect(repository.requestWorktreeStateCalls, 2);
          expect(find.text('No changed files.'), findsNothing);
          expect(find.text('edited.dart'), findsOneWidget);
        },
      );
    }

    testWidgets(
      'same roster revision refreshes a patch after a same-size edit',
      (tester) async {
        final repository = FakeRemoteControlRepository();
        var patch = '@@ -1 +1 @@\n+old text\n';
        repository.readFileDiffHandler = (path, source) async =>
            RemoteFileDiff(filePath: path, patch: patch);
        await openFilesTab(tester, repository);
        await tester.tap(find.text('u.dart'));
        await tester.pumpAndSettle();
        expect(find.text('+old text'), findsOneWidget);
        await tester.pageBack();
        await tester.pumpAndSettle();
        // Neither the revision, row status nor line counts change.
        patch = '@@ -1 +1 @@\n+new text\n';
        await tester.tap(find.text('u.dart'));
        await tester.pumpAndSettle();
        expect(find.text('+new text'), findsOneWidget);
        expect(find.text('+old text'), findsNothing);
        expect(repository.readFileDiffCalls, hasLength(2));
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'reopening renders cached diff and marks it stale until revalidated',
      (tester) async {
        final repository = FakeRemoteControlRepository();
        final refreshed = Completer<RemoteFileDiff>();
        var reads = 0;
        repository.readFileDiffHandler = (path, source) async {
          reads += 1;
          if (reads == 1) {
            return RemoteFileDiff(
              filePath: path,
              patch: '@@ -1 +1 @@\n+cached\n',
            );
          }
          return refreshed.future;
        };
        await openFilesTab(tester, repository, revisioned: false);

        await tester.tap(find.text('u.dart'));
        await tester.pumpAndSettle();
        expect(find.text('+cached'), findsOneWidget);
        await tester.pageBack();
        await tester.pumpAndSettle();

        await tester.tap(find.text('u.dart'));
        // Two pumps: one schedules the pushed route, one builds its first
        // frame. The cached patch is visible while the second read is pending.
        await tester.pump();
        await tester.pump();
        expect(find.text('+cached'), findsOneWidget);
        expect(find.text('Cached diff. Checking for changes…'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(repository.readFileDiffCalls, hasLength(2));

        refreshed.complete(
          const RemoteFileDiff(
            filePath: 'lib/u.dart',
            patch: '@@ -1 +1 @@\n+fresh!\n',
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('+fresh!'), findsOneWidget);
        expect(find.text('Cached diff. Checking for changes…'), findsNothing);
        expect(find.text('+cached'), findsNothing);
      },
    );

    testWidgets(
      'cold start shows the cached patch while revalidating the same roster revision',
      (tester) async {
        final firstRepo = _PersistentDiffRepository();
        firstRepo.readFileDiffHandler = (path, source) async =>
            RemoteFileDiff(filePath: path, patch: '@@ -1 +1 @@\n+cold cache\n');
        final first = await openFilesTab(tester, firstRepo, persistDiffs: true);
        await tester.tap(find.text('u.dart'));
        await tester.pumpAndSettle();
        await tester.pump();
        await first.fileDiffCache.flush();
        await tester.pumpWidget(const SizedBox());

        final secondRepo = _PersistentDiffRepository();
        final pending = Completer<RemoteFileDiff>();
        secondRepo.readFileDiffHandler = (path, source) => pending.future;
        final second = await openFilesTab(
          tester,
          secondRepo,
          restoreSession: true,
          persistDiffs: true,
        );
        await tester.tap(find.text('u.dart'));
        await tester.pump();
        // Isolate decoding runs outside the widget test's fake clock.
        await tester.runAsync(
          () => second.fileDiffCache.restoreSession('session-1'),
        );
        await tester.pumpAndSettle();
        expect(find.text('+cold cache'), findsOneWidget);
        expect(secondRepo.readFileDiffCalls, hasLength(1));
        expect(find.text('Cached diff. Checking for changes…'), findsOneWidget);
        pending.complete(
          const RemoteFileDiff(
            filePath: 'lib/u.dart',
            patch: '@@ -1 +1 @@\n+new result\n',
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('+new result'), findsOneWidget);
        expect(find.text('+cold cache'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'a failed revalidation keeps a stale notice and disconnect hides cached content immediately',
      (tester) async {
        final repository = FakeRemoteControlRepository();
        repository.readFileDiffHandler = (path, source) async =>
            RemoteFileDiff(filePath: path, patch: '@@ -1 +1 @@\n+cached\n');
        final vm = await openFilesTab(tester, repository, revisioned: false);
        await tester.tap(find.text('u.dart'));
        await tester.pumpAndSettle();
        await tester.pageBack();
        await tester.pumpAndSettle();
        repository.readFileDiffHandler = (path, source) async =>
            throw const RemoteControlException('Offline');
        await tester.tap(find.text('u.dart'));
        await tester.pumpAndSettle();
        expect(find.text('+cached'), findsOneWidget);
        expect(
          find.text('Cached diff. Could not refresh. Reopen to retry.'),
          findsOneWidget,
        );
        await tester.runAsync(vm.disconnect);
        await tester.pumpAndSettle();
        expect(find.text('+cached'), findsNothing);
      },
    );

    testWidgets('session reset discards an in-flight diff before caching it', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      final pending = Completer<RemoteFileDiff>();
      repository.readFileDiffHandler = (path, source) => pending.future;
      final vm = await openFilesTab(tester, repository);

      await tester.tap(find.text('u.dart'));
      await tester.pump();
      await tester.pump();
      expect(repository.readFileDiffCalls, hasLength(1));

      final generation = vm.sessionGeneration;
      await tester.runAsync(vm.disconnect);
      expect(vm.sessionGeneration, generation + 1);
      expect(vm.fileDiffCache.length, 0);

      pending.complete(
        const RemoteFileDiff(
          filePath: 'lib/u.dart',
          patch: '@@ -0,0 +1 @@\n+stale\n',
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(vm.fileDiffCache.length, 0);
      expect(find.text('+stale'), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(
        find.text('The remote session ended. Go back and reconnect.'),
        findsOneWidget,
      );
    });

    testWidgets('an uncommitted file is read from the working tree', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      repository.readFileDiffHandler = (path, source) async =>
          RemoteFileDiff(filePath: path, patch: '@@ -1 +1 @@\n-a\n+b\n');
      await openFilesTab(tester, repository);

      await tester.tap(find.text('u.dart'));
      await tester.pumpAndSettle();

      final call = repository.readFileDiffCalls.single;
      expect(call.path, 'lib/u.dart');
      expect(call.repoId, isNull);
      expect(call.source, RemoteDiffSource.uncommitted);
      expect(find.text('+b'), findsOneWidget);
    });

    testWidgets('shows the failure and retries on tap', (tester) async {
      final repository = FakeRemoteControlRepository();
      var attempts = 0;
      repository.readFileDiffHandler = (path, source) async {
        attempts += 1;
        if (attempts == 1) {
          throw const RemoteControlException('Desktop is offline.');
        }
        return RemoteFileDiff(filePath: path, patch: '@@ -1 +1 @@\n+ok\n');
      };
      await openFilesTab(tester, repository);

      await tester.tap(find.text('u.dart'));
      await tester.pumpAndSettle();

      expect(find.text('Desktop is offline.'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('file-diff-retry')));
      await tester.pumpAndSettle();

      expect(attempts, 2);
      expect(find.text('Desktop is offline.'), findsNothing);
      expect(find.text('+ok'), findsOneWidget);
    });

    testWidgets('an empty patch shows a placeholder instead of a blank page', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      await openFilesTab(tester, repository);

      await tester.tap(find.text('u.dart'));
      await tester.pumpAndSettle();

      expect(find.text('No changes to show.'), findsOneWidget);
    });

    testWidgets('a very large patch is truncated with a notice', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      final lines = List.generate(
        kRemoteFileDiffMaxLines + 50,
        (i) => '+line $i',
      );
      repository.readFileDiffHandler = (path, source) async => RemoteFileDiff(
        filePath: path,
        patch: '@@ -0,0 +1,${lines.length} @@\n${lines.join('\n')}\n',
      );
      await openFilesTab(tester, repository);

      await tester.tap(find.text('u.dart'));
      await tester.pumpAndSettle();

      expect(
        find.text('Showing the first $kRemoteFileDiffMaxLines lines.'),
        findsOneWidget,
      );
    });

    testWidgets('a very long diff line is bounded with a notice', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      final longLine = '+${'x' * (kRemoteFileDiffMaxCharactersPerLine + 100)}';
      repository.readFileDiffHandler = (path, source) async =>
          RemoteFileDiff(filePath: path, patch: '@@ -0,0 +1 @@\n$longLine\n');
      await openFilesTab(tester, repository);

      await tester.tap(find.text('u.dart'));
      await tester.pumpAndSettle();

      final renderedLine = tester.widget<Text>(
        find.byWidgetPredicate(
          (widget) =>
              widget is Text && (widget.data?.startsWith('+xxx') ?? false),
        ),
      );
      expect(renderedLine.data, hasLength(kRemoteFileDiffMaxCharactersPerLine));
      expect(renderedLine.data, endsWith('…'));
      expect(
        find.text(
          'Some lines were shortened to '
          '$kRemoteFileDiffMaxCharactersPerLine characters.',
        ),
        findsOneWidget,
      );
    });
  });
}

// A foreground chat fills the server cache with chat/worktree entities but
// never projects changed_files. A cache read is settled (not refreshing) in
// this state; only the explicit full-worktree request materializes the roster.
final class _ForegroundActivityRepository extends FakeRemoteControlRepository {
  _ForegroundActivityRepository() {
    supportsForegroundChat = true;
  }

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await super.requestWorktreeState(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
    worktreeStateSlices[worktreeLocalId] = {
      'changedFiles': {
        worktreeLocalId: {
          'uncommitted': [
            {'filePath': 'lib/hydrated.dart', 'status': 'modified'},
          ],
          'committed': [],
        },
      },
    };
    // The desktop announces the projection with a worktree snapshot.
    eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateSnapshotEvent(
            scope: 'worktree',
            targetWorkspaceLocalId: workspaceLocalId,
            targetWorktreeLocalId: worktreeLocalId,
          ),
        ],
        nextCursor: 10 + requestWorktreeStateCalls,
      ),
    );
  }
}

// Mirrors the live transport: the server cache holds whatever roster the
// desktop last projected, and only a worktree state request re-projects it
// (answered by a worktree-scoped snapshot event).
final class _ProjectingActivityRepository extends FakeRemoteControlRepository {
  _ProjectingActivityRepository() {
    supportsForegroundChat = true;
  }

  List<Map<String, dynamic>> desktopChangedFiles = [];

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await super.requestWorktreeState(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
    worktreeStateSlices[worktreeLocalId] = {
      'changedFiles': {
        worktreeLocalId: {
          'uncommitted': [...desktopChangedFiles],
          'committed': const <Map<String, dynamic>>[],
        },
      },
    };
    eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateSnapshotEvent(
            scope: 'worktree',
            targetWorkspaceLocalId: workspaceLocalId,
            targetWorktreeLocalId: worktreeLocalId,
          ),
        ],
        nextCursor: 10 + requestWorktreeStateCalls,
      ),
    );
  }
}

final class _PersistentDiffRepository extends FakeRemoteControlRepository {
  @override
  Future<RemoteConnection?> restoreSession() => connect('ignored');
  @override
  Future<RemoteConnection> connect(String pairingCode) async =>
      RemoteConnection(
        deviceLabel: 'Test Desktop',
        pairedAt: DateTime(2026),
        sessionId: 'session-1',
      );
}
