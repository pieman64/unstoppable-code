import 'package:provider/provider.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import '../../../support/fake_remote_control_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_overview_sections.dart';
import 'package:mobile/ui/features/remote/views/widgets/attention_sections.dart';
import 'package:mobile/ui/features/remote/views/widgets/pending_question_indicator.dart';

RemoteWorktree worktree(
  String id, {
  String workspaceId = 'ws-1',
  String? label,
  bool? awaitingApproval,
  bool? hasUnread,
  bool? isStreaming,
  RemoteWorktreePipelineStatus? pipelineStatus,
}) => RemoteWorktree(
  localId: id,
  workspaceLocalId: workspaceId,
  branch: 'branch/$id',
  label: label,
  awaitingApproval: awaitingApproval,
  hasUnread: hasUnread,
  isStreaming: isStreaming,
  pipelineStatus: pipelineStatus,
);

AttentionEntry entry(
  String id, {
  String workspaceId = 'ws-1',
  String workspaceName = 'acme',
  String? label,
  bool? awaitingApproval,
  bool? hasUnread,
  bool? isStreaming,
  RemoteWorktreePipelineStatus? pipelineStatus,
}) => AttentionEntry(
  worktree: worktree(
    id,
    workspaceId: workspaceId,
    label: label,
    awaitingApproval: awaitingApproval,
    hasUnread: hasUnread,
    isStreaming: isStreaming,
    pipelineStatus: pipelineStatus,
  ),
  workspaceName: workspaceName,
);

const emptySections = AttentionSectionsData(
  awaitingApproval: [],
  unreadChats: [],
  inProgress: [],
  pipelinesRunning: [],
  pipelinesFinished: [],
);

AttentionSectionsData sections({
  List<AttentionEntry> awaitingApproval = const [],
  List<AttentionEntry> unreadChats = const [],
  List<AttentionEntry> inProgress = const [],
  List<AttentionEntry> pipelinesRunning = const [],
  List<AttentionEntry> pipelinesFinished = const [],
}) => AttentionSectionsData(
  awaitingApproval: awaitingApproval,
  unreadChats: unreadChats,
  inProgress: inProgress,
  pipelinesRunning: pipelinesRunning,
  pipelinesFinished: pipelinesFinished,
);

void main() {
  void usePhoneViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  Widget buildSubject(
    AttentionSectionsData data, {
    ValueChanged<RemoteWorktree>? onOpenWorktree,
    RemoteControlViewModel? viewModel,
  }) {
    final RemoteControlViewModel vm;
    if (viewModel != null) {
      vm = viewModel;
    } else {
      final repo = FakeRemoteControlRepository();
      vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
    }
    return ChangeNotifierProvider.value(
      value: vm,
      child: MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: SingleChildScrollView(
            child: AttentionSections(
              data: data,
              onOpenWorktree: onOpenWorktree ?? (_) {},
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('renders nothing when every section is empty', (tester) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(buildSubject(emptySections));
    expect(find.byKey(const ValueKey('attention-sections')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('deduplicates worktrees and shows all of their signals', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final multiSignal = entry(
      'wt-1',
      label: 'lion',
      awaitingApproval: true,
      hasUnread: true,
    );
    await tester.pumpWidget(
      buildSubject(
        sections(
          awaitingApproval: [multiSignal],
          unreadChats: [multiSignal],
          pipelinesFinished: [
            entry(
              'wt-2',
              pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
            ),
          ],
        ),
      ),
    );

    expect(find.text('NEEDS ATTENTION'), findsOneWidget);
    expect(find.text('lion'), findsOneWidget);
    // Signals use the same shared cluster as the workspace-list rows:
    // awaiting approval is the review-plan icon, unread is the blue dot.
    expect(find.byIcon(Icons.fact_check_outlined), findsOneWidget);
    expect(find.byTooltip('Unread'), findsOneWidget);

    // Row anatomy: the standard worktree row, whose metadata line names the
    // workspace in place of the worktree id, because the queue spans
    // projects.
    expect(find.text('acme'), findsNWidgets(2));
    expect(find.text('wt-1'), findsNothing);
    expect(find.text('branch/wt-1 · acme'), findsNothing);
    // Failed pipeline row gets the error icon.
    expect(find.byIcon(Icons.error_outline), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('caps the combined list at 4 with a +N more toggle', (
    tester,
  ) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(unreadChats: [for (var i = 0; i < 6; i++) entry('wt-$i')]),
      ),
    );

    expect(find.text('branch/wt-3'), findsOneWidget);
    expect(find.text('branch/wt-4'), findsNothing);
    expect(find.text('+2 more'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('attention-more')));
    await tester.pumpAndSettle();
    expect(find.text('branch/wt-5'), findsOneWidget);
    expect(find.text('Show less'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('attention-more')));
    await tester.pumpAndSettle();
    expect(find.text('branch/wt-4'), findsNothing);
    expect(find.text('+2 more'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('short sections render no expander', (tester) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(sections(unreadChats: [entry('wt-1'), entry('wt-2')])),
    );
    expect(find.byKey(const ValueKey('attention-more')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('keys same-id rows by workspace and worktree identity', (
    tester,
  ) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(
          unreadChats: [
            entry('wt-shared', workspaceId: 'ws-alpha'),
            entry('wt-shared', workspaceId: 'ws-beta'),
          ],
        ),
      ),
    );

    expect(
      find.byKey(const ValueKey('attention-row-ws-alpha-wt-shared')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('attention-row-ws-beta-wt-shared')),
      findsOneWidget,
    );
  });

  // CAN-2808 moved merely-working rows out of NEEDS ATTENTION into their own
  // IN PROGRESS group so activity was not presented as an ask. That group is
  // now gone entirely: a running agent needs nothing from the user, and its
  // status still renders on the row inside its project.
  testWidgets('merely-working rows are not pinned at all', (tester) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(
          inProgress: [entry('wt-streaming', isStreaming: true)],
          pipelinesRunning: [
            entry(
              'wt-pipeline',
              pipelineStatus: RemoteWorktreePipelineStatus.running,
            ),
          ],
        ),
      ),
    );

    expect(find.byKey(const ValueKey('attention-sections')), findsNothing);
    expect(find.text('NEEDS ATTENTION'), findsNothing);
    expect(find.text('IN PROGRESS'), findsNothing);
    expect(
      find.byKey(const ValueKey('attention-row-ws-1-wt-streaming')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('attention-row-ws-1-wt-pipeline')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders one labeled group counting only pinned rows', (
    tester,
  ) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(
          awaitingApproval: [entry('wt-approval', awaitingApproval: true)],
          unreadChats: [entry('wt-unread', hasUnread: true)],
          inProgress: [entry('wt-streaming', isStreaming: true)],
        ),
      ),
    );

    expect(find.text('NEEDS ATTENTION'), findsOneWidget);
    expect(find.text('IN PROGRESS'), findsNothing);
    // The count pill reads 2, not 3: the working row is not pinned, so it
    // must not inflate the queue's count either.
    expect(find.text('2'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('exposes sentence-case semantics for the uppercase group label', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final semantics = tester.ensureSemantics();

    await tester.pumpWidget(
      buildSubject(
        sections(
          unreadChats: [entry('wt-unread')],
          inProgress: [entry('wt-streaming')],
        ),
      ),
    );

    expect(find.bySemanticsLabel('Needs attention'), findsOneWidget);
    expect(find.bySemanticsLabel('In progress'), findsNothing);
    semantics.dispose();
  });

  testWidgets('caps the queue and expands on demand', (tester) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(
          unreadChats: [for (var i = 0; i < 6; i++) entry('wt-unread-$i')],
        ),
      ),
    );

    expect(find.text('branch/wt-unread-4'), findsNothing);
    expect(find.text('+2 more'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('attention-more')));
    await tester.pumpAndSettle();
    expect(find.text('branch/wt-unread-5'), findsOneWidget);
    expect(find.text('+2 more'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('keeps expansion state while entries stay above the cap', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final six = [for (var i = 0; i < 6; i++) entry('wt-unread-$i')];

    await tester.pumpWidget(buildSubject(sections(unreadChats: six)));
    await tester.tap(find.byKey(const ValueKey('attention-more')));
    await tester.pumpAndSettle();
    expect(find.text('branch/wt-unread-5'), findsOneWidget);

    // One row leaves the queue; five still exceeds the cap, so an expanded
    // queue must not silently snap shut under the user.
    await tester.pumpWidget(
      buildSubject(sections(unreadChats: six.take(5).toList())),
    );
    await tester.pumpAndSettle();

    expect(find.text('branch/wt-unread-4'), findsOneWidget);
    expect(find.text('+1 more'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('collapses the queue after its entries shrink below the cap', (
    tester,
  ) async {
    usePhoneViewport(tester);
    final fiveEntries = [for (var i = 0; i < 5; i++) entry('wt-unread-$i')];

    await tester.pumpWidget(buildSubject(sections(unreadChats: fiveEntries)));
    await tester.tap(find.byKey(const ValueKey('attention-more')));
    await tester.pumpAndSettle();
    expect(find.text('branch/wt-unread-4'), findsOneWidget);

    await tester.pumpWidget(
      buildSubject(sections(unreadChats: fiveEntries.take(4).toList())),
    );
    await tester.pumpWidget(buildSubject(sections(unreadChats: fiveEntries)));
    await tester.pumpAndSettle();

    expect(find.text('branch/wt-unread-4'), findsNothing);
    expect(find.text('+1 more'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tapping a row reports its worktree', (tester) async {
    usePhoneViewport(tester);
    RemoteWorktree? opened;
    await tester.pumpWidget(
      buildSubject(
        sections(awaitingApproval: [entry('wt-tap')]),
        onOpenWorktree: (worktree) => opened = worktree,
      ),
    );

    await tester.tap(find.byKey(const ValueKey('attention-row-ws-1-wt-tap')));
    expect(opened?.localId, 'wt-tap');
    expect(tester.takeException(), isNull);
  });

  // CAN-4434: a pinned row is the standard worktree row, so it carries the
  // same PR, check, and diff indicators as the project list.
  testWidgets('shows the PR label, checks, and diff counters', (tester) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(
          unreadChats: [
            const AttentionEntry(
              worktree: RemoteWorktree(
                localId: 'wt-pr',
                workspaceLocalId: 'ws-1',
                branch: 'feature/pr',
                label: 'otter',
                hasUnread: true,
                insertions: 42,
                deletions: 7,
                prStatuses: [
                  RemoteWorktreePr(
                    prNumber: 4434,
                    state: 'open',
                    checkStatus: 'passing',
                  ),
                ],
              ),
              workspaceName: 'acme',
            ),
          ],
        ),
      ),
    );

    final row = find.byKey(const ValueKey('attention-row-ws-1-wt-pr'));
    expect(
      find.descendant(
        of: row,
        matching: find.textContaining('acme · PR #4434'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.byTooltip('Checks passing')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.text('+42')),
      findsOneWidget,
    );
    expect(find.descendant(of: row, matching: find.text('-7')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('shows the pending question indicator', (tester) async {
    usePhoneViewport(tester);
    const pinned = RemoteWorktree(
      localId: 'wt-ask',
      workspaceLocalId: 'ws-1',
      branch: 'feature/ask',
      hasUnread: true,
    );
    final repo = FakeRemoteControlRepository()
      ..snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [pinned],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-ask',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-ask',
            title: 'Ask',
            active: true,
            pendingQuestions: [
              AskUserQuestionState(
                requestId: 'req-1',
                questions: [
                  AskUserQuestion(
                    id: 'q-1',
                    header: 'Deploy',
                    question: 'Ship it?',
                    options: ['Yes', 'No'],
                  ),
                ],
              ),
            ],
          ),
        ],
      );
    final vm = RemoteControlViewModel(
      repository: repo,
      stateRefreshDebounce: Duration.zero,
    );
    addTearDown(vm.dispose);
    addTearDown(repo.eventsController.close);
    await tester.runAsync(() => vm.connect('123456'));
    expect(vm.worktreeNeedsAnswer(pinned), isTrue);

    await tester.pumpWidget(
      buildSubject(
        sections(
          unreadChats: [
            const AttentionEntry(worktree: pinned, workspaceName: 'acme'),
          ],
        ),
        viewModel: vm,
      ),
    );

    expect(
      find.descendant(
        of: find.byKey(const ValueKey('attention-row-ws-1-wt-ask')),
        matching: find.byType(PendingQuestionIndicator),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('fits a long label, PR label, and large diff at 390 px', (
    tester,
  ) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(
          awaitingApproval: [
            const AttentionEntry(
              worktree: RemoteWorktree(
                localId: 'wt-long',
                workspaceLocalId: 'ws-1',
                branch: 'feature/a-very-long-branch-name-for-overflow-checks',
                label:
                    'A very long worktree label that keeps going well past '
                    'the width of a phone screen',
                awaitingApproval: true,
                hasUnread: true,
                pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
                terminalStatus: 'running',
                insertions: 1234567,
                deletions: 7654321,
                prStatuses: [
                  RemoteWorktreePr(
                    prNumber: 123456,
                    state: 'draft',
                    checkStatus: 'failing',
                  ),
                ],
              ),
              workspaceName: 'a-workspace-with-a-long-project-name',
            ),
          ],
        ),
      ),
    );

    expect(tester.getSize(find.byType(Scaffold)).width, 390);
    expect(
      find.byKey(const ValueKey('attention-row-ws-1-wt-long')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('attention-row-ws-1-wt-long')),
        matching: find.textContaining('PR #123456 · draft'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  // CAN-2808: only the agent animates, so a working row with a running
  // pipeline still shows exactly one spinner.
  testWidgets('a pinned row never shows two spinners', (tester) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      buildSubject(
        sections(
          unreadChats: [
            entry(
              'wt-busy',
              hasUnread: true,
              isStreaming: true,
              pipelineStatus: RemoteWorktreePipelineStatus.running,
            ),
          ],
        ),
      ),
    );

    expect(
      find.descendant(
        of: find.byKey(const ValueKey('attention-row-ws-1-wt-busy')),
        matching: find.byType(ThinkingSpinner),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
