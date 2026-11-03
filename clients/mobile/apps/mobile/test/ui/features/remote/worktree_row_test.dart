import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_row.dart';

import 'package:mobile/data/models/remote_portal_event.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/merge_queue_fixture.dart';
import '../../../support/overview_snapshot_fixture.dart';

void main() {
  for (final dark in [false, true]) {
    testWidgets(
      'question icon is vertically centered and title dot is amber ($dark)',
      (tester) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const Scaffold(
              body: WorktreeRow(
                needsAnswer: true,
                worktree: RemoteWorktree(
                  localId: 'sturgeon',
                  workspaceLocalId: 'ws',
                  branch: 'feature/question',
                  hasUnread: true,
                  insertions: 230,
                  deletions: 8,
                ),
              ),
            ),
          ),
        );
        expect(
          tester.getCenter(find.byKey(const ValueKey('worktree-leading'))).dy,
          closeTo(tester.getCenter(find.byType(WorktreeRow)).dy, 0.1),
        );
        final dot = find.descendant(
          of: find.byKey(const ValueKey('worktree-attention')),
          matching: find.byType(Container),
        );
        expect(dot, findsOneWidget);
        expect(
          (tester.widget<Container>(dot).decoration as BoxDecoration).color,
          (dark ? StatusColors.dark : StatusColors.light).warning,
        );
        expect(
          tester.getCenter(dot).dy,
          closeTo(
            tester.getCenter(find.byKey(const ValueKey('worktree-title'))).dy,
            0.1,
          ),
        );
      },
    );
  }

  testWidgets(
    'merge phases replace idle PR state and clear after completion or failure',
    (tester) async {
      Future<void> show(
        Map<String, dynamic> progress, {
        String state = 'open',
      }) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            home: Scaffold(
              body: WorktreeRow(
                worktree: RemoteWorktree.fromJson({
                  'localId': 'wt-1',
                  'workspaceLocalId': 'ws-1',
                  'branch': 'feature/merge',
                  'lastKnownPrStatus': {
                    'repos': [
                      {
                        'status': {'state': state, 'prNumber': 42},
                      },
                    ],
                  },
                  ...progress,
                }),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
      }

      for (final phase in {
        'queued': 'Merge queued',
        'checking_mergeability': 'Checking mergeability',
        'waiting_mergeability': 'Waiting for GitHub',
        'merging': 'Merging pull request',
        'refreshing_pr_status': 'Refreshing PR status',
      }.entries) {
        await show({'mergingPr': true, 'mergePrPhase': phase.key});
        expect(find.byTooltip(phase.value), findsOneWidget);
        expect(tester.hasRunningAnimations, isTrue);
        expect(find.byType(ThinkingSpinner), findsOneWidget);
        expect(
          find.textContaining(phase.value, findRichText: true),
          findsOneWidget,
        );
      }
      await show({'mergingPr': false, 'mergePrPhase': null}, state: 'merged');
      expect(find.byType(ThinkingSpinner), findsNothing);
      expect(find.byTooltip('Done'), findsOneWidget);
      await show({'mergingPr': false, 'mergePrPhase': null});
      expect(find.byType(ThinkingSpinner), findsNothing);
      expect(find.byTooltip('Done'), findsNothing);
      await show({});
      expect(find.byType(ThinkingSpinner), findsNothing);
    },
  );

  for (final split in [false, true]) {
    testWidgets(
      'split=$split pushed overview changes the visible PR before a refetch',
      (tester) async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = initialOverview;
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            home: Scaffold(
              body: ListenableBuilder(
                listenable: vm,
                builder: (context, _) => vm.allWorktrees.isEmpty
                    ? const SizedBox.shrink()
                    : WorktreeRow(worktree: vm.allWorktrees.single),
              ),
            ),
          ),
        );
        expect(
          find.textContaining('PR #3061', findRichText: true),
          findsOneWidget,
        );
        if (split) {
          repository.eventsController.add(overviewBatch(entities: []));
          await tester.pump();
        }
        repository.eventsController.add(
          overviewBatch(
            eventId: split ? 'overview-1:chunk-1' : 'overview-1',
            type: split ? 'portal.state.delta' : 'portal.state.snapshot',
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(
          find.textContaining('PR merged', findRichText: true),
          findsOneWidget,
        );
        expect(
          find.textContaining('PR #3061', findRichText: true),
          findsNothing,
        );
        expect(repository.snapshotFetches, 1);
        await tester.pump(const Duration(milliseconds: 300));
      },
    );
  }

  group('WorktreeRow title anatomy', () {
    Widget host(RemoteWorktree worktree) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(body: WorktreeRow(worktree: worktree)),
    );

    Text title(WidgetTester tester) =>
        tester.widget<Text>(find.byKey(const ValueKey('worktree-title')));

    testWidgets('a labeled worktree titles the row with the label', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/oauth-pkce',
            label: 'lion',
          ),
        ),
      );
      await tester.pump();

      expect(title(tester).data, 'lion');
      // The identifier remains visible independently of the custom title.
      expect(
        find.descendant(
          of: find.byType(WorktreeRow),
          matching: find.textContaining('wt-1', findRichText: true),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a label-less worktree falls back to the branch title', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/oauth-pkce',
          ),
        ),
      );
      await tester.pump();

      expect(title(tester).data, 'feature/oauth-pkce');
    });

    testWidgets('a whitespace-only label falls back to the branch title', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/oauth-pkce',
            label: '   ',
          ),
        ),
      );
      await tester.pump();

      expect(title(tester).data, 'feature/oauth-pkce');
    });
  });

  group('WorktreeRow desktop two-line layout', () {
    Widget host(
      RemoteWorktree worktree, {
      double scale = 1,
      VoidCallback? onTap,
    }) => MaterialApp(
      theme: AppTheme.light,
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          body: WorktreeRow(worktree: worktree, onTap: onTap),
        ),
      ),
    );
    const titleKey = ValueKey('worktree-title');
    const leadingKey = ValueKey('worktree-leading');

    testWidgets(
      'idle rows always show the literal desktop identifier on line two',
      (tester) async {
        for (final label in [null, '', '   ', 'Custom title']) {
          await tester.pumpWidget(
            host(
              RemoteWorktree(
                localId: 'kiwi-2',
                workspaceLocalId: 'ws',
                branch: 'feature/x',
                label: label,
              ),
            ),
          );
          expect(
            find.textContaining('kiwi-2', findRichText: true),
            findsOneWidget,
          );
          final title = tester.getRect(
            find.text(label?.trim().isNotEmpty == true ? label! : 'feature/x'),
          );
          final id = tester.getRect(
            find.textContaining('kiwi-2', findRichText: true),
          );
          expect(id.top, greaterThanOrEqualTo(title.bottom));
          expect(id.left, title.left);
          expect(
            find.descendant(
              of: find.byKey(leadingKey),
              matching: find.byType(Icon),
            ),
            findsNothing,
          );
          expect(
            tester.getSize(find.byType(WorktreeRow)).height,
            greaterThanOrEqualTo(48),
          );
        }
      },
    );

    for (final width in [280.0, 390.0]) {
      for (final scale in [1.0, 2.0, 3.0]) {
        testWidgets(
          'independent title and metadata constraints at $width / $scale',
          (tester) async {
            tester.view.physicalSize = Size(width, 800);
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.reset);
            RemoteWorktree fixture(int diff) => RemoteWorktree(
              localId: 'koala',
              workspaceLocalId: 'ws',
              branch: 'feature/a-very-long-branch-name-that-must-truncate',
              isStreaming: true,
              hasUnread: true,
              insertions: diff,
              deletions: diff,
              prStatuses: const [
                RemoteWorktreePr(
                  prNumber: 3061,
                  state: 'open',
                  checkStatus: 'passing',
                ),
              ],
            );
            await tester.pumpWidget(host(fixture(0), scale: scale));
            final titleFinder = find.text(
              'feature/a-very-long-branch-name-that-must-truncate',
            );
            final titleWidth = tester.getSize(titleFinder).width;
            await tester.pumpWidget(host(fixture(12345678), scale: scale));
            expect(tester.getSize(titleFinder).width, titleWidth);
            final title = tester.getRect(find.byKey(titleKey));
            final progress = tester.getRect(find.byType(ThinkingSpinner));
            expect(progress.left, greaterThanOrEqualTo(title.right));
            expect(progress.center.dy, closeTo(title.center.dy, 1));
            expect(
              tester.getRect(find.text('+12345678')).top,
              greaterThanOrEqualTo(title.bottom),
            );
            expect(
              find.textContaining('koala', findRichText: true),
              findsOneWidget,
            );
            expect(
              find.textContaining('PR #3061', findRichText: true),
              findsOneWidget,
            );
            expect(find.byTooltip('Checks passing'), findsOneWidget);
            final metadataStyle = DefaultTextStyle.of(
              tester.element(find.byKey(const ValueKey('worktree-metadata'))),
            ).style;
            final counter = tester.widget<Text>(find.text('+12345678'));
            expect(counter.style?.fontSize, metadataStyle.fontSize);
            expect(counter.style?.fontWeight, metadataStyle.fontWeight);
            expect(
              find.ancestor(
                of: find.text('+12345678'),
                matching: find.byType(Container),
              ),
              findsNothing,
            );
            expect(tester.takeException(), isNull);
          },
        );
      }
    }

    testWidgets('multiple signals leave the remaining metadata width usable', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'kiwi',
            workspaceLocalId: 'ws',
            branch: 'feature/x',
            pipelineStatus: RemoteWorktreePipelineStatus.running,
            scriptStatus: 'running',
            insertions: 12,
          ),
        ),
      );

      final metadata = tester.getRect(
        find.byKey(const ValueKey('worktree-metadata')),
      );
      final diff = tester.getRect(find.text('+12'));
      expect(diff.left - metadata.right, closeTo(8, 1));
    });

    for (final mode in [Brightness.light, Brightness.dark]) {
      testWidgets('status priorities and PR checks in $mode', (tester) async {
        final colors = mode == Brightness.dark
            ? StatusColors.dark
            : StatusColors.light;
        Future<void> pump(RemoteWorktree row) => tester.pumpWidget(
          MaterialApp(
            theme: mode == Brightness.dark ? AppTheme.dark : AppTheme.light,
            home: Scaffold(body: WorktreeRow(worktree: row)),
          ),
        );
        for (final pipeline in RemoteWorktreePipelineStatus.values) {
          await pump(
            RemoteWorktree(
              localId: 'kiwi',
              workspaceLocalId: 'ws',
              branch: 'feature/x',
              pipelineStatus: pipeline,
              awaitingApproval: true,
              scriptStatus: 'running',
              hookStatus: 'running',
              terminalStatus: 'running',
              prStatuses: const [RemoteWorktreePr(state: 'merged')],
            ),
          );
          final icon = tester.widget<Icon>(
            find.descendant(
              of: find.byKey(leadingKey),
              matching: find.byType(Icon),
            ),
          );
          expect(icon.color, switch (pipeline) {
            RemoteWorktreePipelineStatus.paused => colors.warning,
            RemoteWorktreePipelineStatus.running => colors.neutral,
            RemoteWorktreePipelineStatus.unseen => colors.success,
            RemoteWorktreePipelineStatus.unseenFailure => colors.failed,
          });
        }
        for (final state in ['passing', 'failing', 'pending', 'none']) {
          await pump(
            RemoteWorktree(
              localId: 'kiwi',
              workspaceLocalId: 'ws',
              branch: 'feature/x',
              prStatuses: [
                RemoteWorktreePr(
                  prNumber: 42,
                  state: 'draft',
                  checkStatus: state,
                ),
              ],
            ),
          );
          expect(
            find.textContaining('kiwi · PR #42 · draft', findRichText: true),
            findsOneWidget,
          );
          expect(
            find.byTooltip('Checks $state'),
            state == 'none' ? findsNothing : findsOneWidget,
          );
          if (state != 'none') {
            final icon = tester.widget<Icon>(
              find.descendant(
                of: find.byTooltip('Checks $state'),
                matching: find.byType(Icon),
              ),
            );
            expect(icon.color, switch (state) {
              'passing' => colors.success,
              'failing' => colors.failed,
              'pending' => colors.warning,
              _ => throw StateError('Unexpected check status: $state'),
            });
          }
        }
        await pump(
          const RemoteWorktree(
            localId: 'kiwi',
            workspaceLocalId: 'ws',
            branch: 'feature/x',
            awaitingApproval: true,
            scriptStatus: 'running',
          ),
        );
        expect(
          tester
              .widget<Icon>(
                find.descendant(
                  of: find.byKey(leadingKey),
                  matching: find.byType(Icon),
                ),
              )
              .color,
          colors.warning,
        );
        await pump(
          const RemoteWorktree(
            localId: 'kiwi',
            workspaceLocalId: 'ws',
            branch: 'feature/x',
            hookStatus: 'running',
            terminalStatus: 'running',
          ),
        );
        expect(
          find.descendant(
            of: find.byKey(leadingKey),
            matching: find.byTooltip('Hook running'),
          ),
          findsOneWidget,
        );
        await pump(
          const RemoteWorktree(
            localId: 'kiwi',
            workspaceLocalId: 'ws',
            branch: 'feature/x',
            terminalStatus: 'running',
          ),
        );
        expect(
          find.descendant(
            of: find.byKey(leadingKey),
            matching: find.byTooltip('Terminal running'),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets(
      'setup replaces progress and attention; hidden unread stays suppressed',
      (tester) async {
        await tester.pumpWidget(
          host(
            const RemoteWorktree(
              localId: 'kiwi',
              workspaceLocalId: 'ws',
              branch: 'feature/x',
              setupPhase: RemoteWorktreeSetupPhase.gitPending,
              isStreaming: true,
              hasUnread: true,
            ),
          ),
        );
        expect(find.byType(ThinkingSpinner), findsOneWidget);
        expect(find.byTooltip('Setting up worktree'), findsOneWidget);
        expect(find.byKey(const ValueKey('worktree-attention')), findsNothing);
        await tester.pumpWidget(
          host(
            const RemoteWorktree(
              localId: 'kiwi',
              workspaceLocalId: 'ws',
              branch: 'feature/x',
              hasUnread: true,
              hidden: true,
            ),
          ),
        );
        expect(find.byKey(const ValueKey('worktree-attention')), findsNothing);
      },
    );

    testWidgets(
      'pipeline wins leading, other activities stay on metadata, attention stays on title',
      (tester) async {
        await tester.pumpWidget(
          host(
            const RemoteWorktree(
              localId: 'zebra',
              workspaceLocalId: 'ws',
              branch: 'feature/x',
              pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
              scriptStatus: 'running',
              hookStatus: 'running',
              terminalStatus: 'unseen',
              hasUnread: true,
              awaitingApproval: true,
              isStreaming: true,
            ),
          ),
        );
        expect(
          find.descendant(
            of: find.byKey(leadingKey),
            matching: find.byTooltip('Pipeline failed'),
          ),
          findsOneWidget,
        );
        final title = tester.getRect(find.byKey(titleKey));
        for (final tooltip in [
          'Scripts running',
          'Hook running',
          'Terminal finished',
          'Awaiting approval',
        ]) {
          expect(
            tester.getRect(find.byTooltip(tooltip)).center.dy,
            greaterThan(title.bottom),
          );
        }
        expect(
          find.byKey(const ValueKey('worktree-attention')),
          findsOneWidget,
        );
        expect(find.byTooltip('Unread'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('promoted activity appears once and row keeps tap semantics', (
      tester,
    ) async {
      var taps = 0;
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'kiwi',
            workspaceLocalId: 'ws',
            branch: 'feature/x',
            scriptStatus: 'running',
            hookStatus: 'running',
          ),
          onTap: () => taps++,
        ),
      );
      expect(find.byTooltip('Scripts running'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(leadingKey),
          matching: find.byTooltip('Scripts running'),
        ),
        findsOneWidget,
      );
      await tester.tap(find.textContaining('kiwi', findRichText: true));
      expect(taps, 1);
      expect(find.bySemanticsLabel(RegExp('kiwi')), findsWidgets);
      semantics.dispose();
    });
  });

  group('WorktreeRow PR badge and status dot', () {
    Widget host(RemoteWorktree worktree) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(body: WorktreeRow(worktree: worktree)),
    );

    testWidgets('a numberless draft PR is labeled PR draft, not PR open', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            prStatuses: [RemoteWorktreePr(state: 'draft')],
          ),
        ),
      );
      await tester.pump();
      expect(
        find.textContaining('PR draft', findRichText: true),
        findsOneWidget,
      );
      expect(find.textContaining('PR open', findRichText: true), findsNothing);
    });

    testWidgets('a merged PR uses the purple done glyph', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'koala',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            prStatuses: [RemoteWorktreePr(prNumber: 7, state: 'merged')],
          ),
        ),
      );
      final glyph = tester.widget<Icon>(find.byIcon(Icons.check));
      expect(glyph.color, StatusColors.light.merged);
      expect(find.textContaining('koala', findRichText: true), findsOneWidget);
    });

    testWidgets('a working worktree renders the spinner after the title '
        'as the single signal', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            isStreaming: true,
          ),
        ),
      );
      await tester.pump();
      // Exactly one spinner in the title cluster.
      expect(find.byType(ThinkingSpinner), findsOneWidget);
      expect(find.byKey(const ValueKey('worktree-working')), findsOneWidget);
    });
  });

  group('WorktreeRow working indicator', () {
    Widget host(RemoteWorktree worktree) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(body: WorktreeRow(worktree: worktree)),
    );

    testWidgets('a busy worktree shows an animated working indicator', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            busy: true,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(const ValueKey('worktree-working')), findsOneWidget);
      expect(tester.hasRunningAnimations, isTrue);
    });

    testWidgets('an idle worktree has no working indicator', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(const ValueKey('worktree-working')), findsNothing);
    });

    testWidgets('a streaming worktree shows the working indicator', (
      tester,
    ) async {
      // Current desktops project `isStreaming` (never the legacy `busy`), so
      // the working indicator must key off it too.
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            isStreaming: true,
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(const ValueKey('worktree-working')), findsOneWidget);
    });

    testWidgets('runtime aggregate statuses render badges', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            scriptStatus: 'running',
            hookStatus: 'running',
            terminalStatus: 'unseen-failure',
          ),
        ),
      );
      await tester.pump();

      expect(find.byTooltip('Scripts running'), findsOneWidget);
      expect(find.byTooltip('Hook running'), findsOneWidget);
      expect(find.byTooltip('Terminal finished with errors'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a running pipeline renders a static gray glyph, never a '
        'spinner (CAN-2808)', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            pipelineStatus: RemoteWorktreePipelineStatus.running,
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(RunSpinner), findsNothing);
      final glyph = tester.widget<Icon>(
        find.descendant(
          of: find.byTooltip('Pipeline running'),
          matching: find.byIcon(Icons.sync),
        ),
      );
      // Desktop paints pipeline-running gray (`fg-secondary`), not accent.
      expect(glyph.color, StatusColors.light.neutral);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a streaming worktree with a running pipeline shows exactly '
        'one animated spinner (CAN-2808)', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
            isStreaming: true,
            pipelineStatus: RemoteWorktreePipelineStatus.running,
          ),
        ),
      );
      await tester.pump();

      // The agent-working spinner is the only progress animation on the row.
      expect(find.byType(ThinkingSpinner), findsOneWidget);
      expect(find.byType(RunSpinner), findsNothing);
      expect(find.byTooltip('Pipeline running'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('no aggregate badges without the statuses', (tester) async {
      await tester.pumpWidget(
        host(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'feature/x',
          ),
        ),
      );
      await tester.pump();

      expect(find.byTooltip('Scripts running'), findsNothing);
      expect(find.byTooltip('Hook running'), findsNothing);
      expect(find.byTooltip('Terminal running'), findsNothing);
    });
  });
  group('WorktreeRow GitHub merge queue (CAN-4454)', () {
    Future<void> pumpRow(
      WidgetTester tester,
      RemoteWorktree worktree, {
      bool dark = false,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: Scaffold(body: WorktreeRow(worktree: worktree)),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
    }

    RemoteWorktree single(
      Map<String, dynamic>? mergeQueue, {
      String state = 'open',
    }) => mergeQueueWorktree('koala', [
      mergeQueueRepo(4454, state: state, mergeQueue: mergeQueue),
    ]);

    TextSpan badgeSpan(WidgetTester tester, String text) {
      final metadata = tester
          .widget<Text>(find.byKey(const ValueKey('worktree-metadata')))
          .textSpan!;
      TextSpan? match;
      metadata.visitChildren((span) {
        if (span is TextSpan && span.text == text) match = span;
        return match == null;
      });
      return match ??
          (throw TestFailure('No "$text" in ${metadata.toPlainText()}'));
    }

    final queueGlyph = find.byKey(const ValueKey('worktree-pr-merge-queue'));

    for (final dark in [false, true]) {
      testWidgets('a queued PR shows position, warning tone and the queue '
          'glyph (dark: $dark)', (tester) async {
        final semantics = tester.ensureSemantics();
        await pumpRow(
          tester,
          single(queued(position: 2, phase: 'awaiting_checks')),
          dark: dark,
        );
        final badge = badgeSpan(tester, 'PR #4454 · Queued #2');
        expect(
          badge.style!.color,
          (dark ? StatusColors.dark : StatusColors.light).warning,
        );
        expect(queueGlyph, findsOneWidget);
        // The queue glyph replaces the CI check glyph.
        expect(find.byTooltip('Checks passing'), findsNothing);
        expect(
          find.byTooltip('In merge queue, position 2. Awaiting queue checks'),
          findsOneWidget,
        );
        expect(
          find.bySemanticsLabel(
            RegExp(r'In merge queue, position 2\. Awaiting queue checks'),
          ),
          findsOneWidget,
        );
        semantics.dispose();
      });
    }

    testWidgets('an unknown position and phase read as plain Queued', (
      tester,
    ) async {
      await pumpRow(tester, single(queued()));
      badgeSpan(tester, 'PR #4454 · Queued');
      expect(find.textContaining('Queued #', findRichText: true), findsNothing);
      expect(find.byTooltip('In merge queue'), findsOneWidget);
    });

    testWidgets('each phase uses the shared desktop and web copy', (
      tester,
    ) async {
      for (final entry in {
        'queued': '. Waiting in queue',
        'awaiting_checks': '. Awaiting queue checks',
        'mergeable': '. Queue checks passed',
        'locked': '. Locked for merge',
        'unmergeable': ". Can't merge from queue",
        'unknown': '',
        'some_future_state': '',
      }.entries) {
        await pumpRow(tester, single(queued(position: 1, phase: entry.key)));
        expect(
          find.byTooltip('In merge queue, position 1${entry.value}'),
          findsOneWidget,
          reason: entry.key,
        );
      }
    });

    testWidgets('unknown or negative membership renders as before', (
      tester,
    ) async {
      for (final mergeQueue in [
        null,
        const {'inQueue': false},
      ]) {
        await pumpRow(tester, single(mergeQueue));
        badgeSpan(tester, 'PR #4454');
        expect(find.textContaining('Queued', findRichText: true), findsNothing);
        expect(queueGlyph, findsNothing);
        expect(find.byTooltip('Checks passing'), findsOneWidget);
      }
    });

    testWidgets('merged and closed win over a stale queue value', (
      tester,
    ) async {
      for (final entry in {
        'merged': 'PR merged',
        'closed': 'PR closed',
      }.entries) {
        await pumpRow(tester, single(queued(position: 1), state: entry.key));
        badgeSpan(tester, entry.value);
        expect(find.textContaining('Queued', findRichText: true), findsNothing);
        expect(queueGlyph, findsNothing);
      }
    });

    testWidgets('several repositories show the queue only when every open '
        'PR is queued', (tester) async {
      await pumpRow(
        tester,
        mergeQueueWorktree('split', [
          mergeQueueRepo(4469, mergeQueue: queued(position: 1)),
          mergeQueueRepo(18, repoId: 'repo-web', repo: 'web'),
        ]),
      );
      expect(find.textContaining('Queued', findRichText: true), findsNothing);
      expect(queueGlyph, findsNothing);

      await pumpRow(
        tester,
        mergeQueueWorktree('pair', [
          mergeQueueRepo(4470, mergeQueue: queued(position: 1)),
          mergeQueueRepo(
            19,
            repoId: 'repo-web',
            repo: 'web',
            mergeQueue: queued(position: 3, phase: 'locked'),
          ),
        ]),
      );
      badgeSpan(tester, 'PR #4470 · Queued');
      expect(find.byTooltip('In merge queue'), findsOneWidget);
    });

    testWidgets('an active merge keeps priority over the queue badge', (
      tester,
    ) async {
      await pumpRow(
        tester,
        mergeQueueWorktree(
          'busy',
          [mergeQueueRepo(4471, mergeQueue: queued(position: 1))],
          mergingPr: true,
          mergePrPhase: 'merging',
        ),
      );
      expect(
        find.textContaining('Merging pull request', findRichText: true),
        findsOneWidget,
      );
      expect(find.textContaining('Queued', findRichText: true), findsNothing);
      expect(queueGlyph, findsNothing);
    });

    testWidgets('a pr_status delta keeps the queued row until a row clears '
        'it', (tester) async {
      Map<String, dynamic> row(Map<String, dynamic> mergeQueue) => {
        ...overviewWorktree(),
        'lastKnownPrStatus': {
          'repos': [mergeQueueRepo(4454, mergeQueue: mergeQueue)],
        },
      };
      var cursor = 10;
      RemotePortalEventBatch delta(Map<String, dynamic> entity) {
        cursor++;
        return RemotePortalEventBatch.fromJson({
          'events': [
            {
              'eventId': 'queue-$cursor',
              'cursor': cursor,
              'type': 'portal.state.delta',
              'payload': {
                'scope': entity['entityType'] == 'pr_status'
                    ? 'pr'
                    : 'worktree',
                'entities': [entity],
              },
            },
          ],
          'nextCursor': cursor,
        });
      }

      final prStatus = {
        'entityType': 'pr_status',
        'localId': 'wt-1',
        'parentLocalId': 'ws-1:wt-1',
        'payload': {
          'workspaceLocalId': 'ws-1',
          'worktreeLocalId': 'wt-1',
          'repos': [
            {
              'repoId': 'repo-app',
              'status': {
                'number': 4454,
                'state': 'open',
                'url': mergeQueuePrUrl(4454),
                'checkStatus': 'pending',
              },
            },
          ],
        },
      };
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [overviewWorkspace()],
          'worktrees': [row(queued(position: 2, phase: 'awaiting_checks'))],
          'standaloneChats': <Object>[],
        });
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      addTearDown(repository.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: ListenableBuilder(
              listenable: vm,
              builder: (context, _) =>
                  WorktreeRow(worktree: vm.allWorktrees.single),
            ),
          ),
        ),
      );
      Future<void> push(Map<String, dynamic> entity) async {
        repository.eventsController.add(delta(entity));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      }

      badgeSpan(tester, 'PR #4454 · Queued #2');
      await push(prStatus);
      badgeSpan(tester, 'PR #4454 · Queued #2');
      await push({
        'entityType': 'worktree',
        'localId': 'wt-1',
        'parentLocalId': 'ws-1',
        'payload': row(const {'inQueue': false}),
      });
      badgeSpan(tester, 'PR #4454');
      await push(prStatus);
      expect(find.textContaining('Queued', findRichText: true), findsNothing);
      await tester.pump(const Duration(seconds: 2));
    });

    for (final dark in [false, true]) {
      testWidgets('every queue row fits a phone at text scale 2 '
          '(dark: $dark)', (tester) async {
        tester.view.physicalSize = const Size(390, 2400);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: MediaQuery(
              data: const MediaQueryData(
                size: Size(390, 2400),
                textScaler: TextScaler.linear(2),
              ),
              child: Scaffold(
                body: ListView(
                  children: [
                    for (final row in mergeQueueCaptureRows())
                      WorktreeRow(worktree: row),
                  ],
                ),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull);
        expect(queueGlyph, findsNWidgets(8));
      });
    }
  });
}
