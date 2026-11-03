import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/summary.dart';
import 'package:mobile/ui/features/remote/views/widgets/background_tray.dart';

import '../../../../../support/reduced_motion.dart';
import '../../view_models/background_tray/fixtures.dart' as fixture;

void main() {
  useReducedMotion();

  Future<void> pumpTray(
    WidgetTester tester,
    BackgroundTraySummary summary, {
    bool expanded = false,
    double scale = 1,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var open = expanded;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: MediaQuery(
            data: MediaQueryData(
              size: const Size(390, 844),
              disableAnimations: true,
              textScaler: TextScaler.linear(scale),
            ),
            child: Align(
              alignment: Alignment.bottomCenter,
              child: StatefulBuilder(
                builder: (context, setState) => BackgroundTray(
                  summary: summary,
                  now: 66000,
                  expanded: open,
                  onExpandedChanged: (value) => setState(() => open = value),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('terminal indicators distinguish done failed and cancelled', (
    tester,
  ) async {
    for (final entry in {
      BackgroundTrayIndicator.failed: CanopyGlyph.crossSmall,
      BackgroundTrayIndicator.cancelled: CanopyGlyph.stop,
      BackgroundTrayIndicator.needsInput: CanopyGlyph.circleQuestionmark,
      BackgroundTrayIndicator.succeeded: CanopyGlyph.checkmark1,
    }.entries) {
      await pumpTray(
        tester,
        BackgroundTraySummary(text: 'Background status', indicator: entry.key),
      );
      expect(
        find.byWidgetPredicate(
          (w) => w is CanopyIcon && w.glyph == entry.value,
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('hidden summary renders nothing', (tester) async {
    await pumpTray(tester, const BackgroundTraySummary());
    expect(find.byKey(const ValueKey('background-tray')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('summary and chevron toggle; collapsed kinds name their counts', (
    tester,
  ) async {
    await pumpTray(
      tester,
      summarizeBackgroundTray(
        tasks: [fixture.task('one'), fixture.task('two')],
      ),
    );
    expect(find.bySemanticsLabel('Commands: 2'), findsOneWidget);
    expect(find.bySemanticsLabel('2 background tasks running'), findsOneWidget);
    expect(find.text('Task one'), findsNothing);
    await tester.tap(find.text('2 running in the background'));
    await tester.pump();
    expect(find.text('Task one'), findsOneWidget);
    expect(find.text('Running'), findsNothing);
    expect(find.bySemanticsLabel('Hide background work'), findsNWidgets(2));
    await tester.tap(find.byKey(const ValueKey('background-tray-toggle')));
    await tester.pump();
    expect(find.text('Task one'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'all kinds fit at phone width and large type; status dot is named',
    (tester) async {
      final kinds = [
        for (final kind in BackgroundTrayKind.values)
          BackgroundTrayKindCount(
            kind,
            123,
            cornerDot: BackgroundTrayIndicator.needsInput,
          ),
      ];
      await pumpTray(
        tester,
        BackgroundTraySummary(
          text: '1 needs input · 2 paused',
          indicator: BackgroundTrayIndicator.needsInput,
          kinds: kinds,
        ),
        scale: 2,
      );
      expect(find.bySemanticsLabel('Needs input'), findsOneWidget);
      expect(find.bySemanticsLabel('Agents: 123'), findsOneWidget);
      expect(find.bySemanticsLabel('Pull requests: 123'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'several groups have sticky semantic headings inside capped scroll',
    (tester) async {
      await pumpTray(
        tester,
        summarizeBackgroundTray(
          agents: [
            for (var i = 0; i < 10; i++)
              fixture.agent(
                'approval-$i',
                status: BackgroundTrayAgentStatus.approval,
              ),
          ],
          tasks: [fixture.task('running')],
          runs: [fixture.run('finished', BackgroundTrayRunStatus.succeeded)],
        ),
        expanded: true,
      );
      final list = find.byKey(const ValueKey('background-tray-rows'));
      expect(tester.getSize(list).height, lessThanOrEqualTo(352));
      expect(
        tester.getSemantics(find.text('Needs you')),
        matchesSemantics(isHeader: true, label: 'Needs you'),
      );
      await tester.drag(list, const Offset(0, -150));
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(find.text('Needs you')).dy,
        greaterThanOrEqualTo(tester.getTopLeft(list).dy),
      );
      await tester.drag(list, const Offset(0, -600));
      await tester.pumpAndSettle();
      expect(find.text('finished').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'one inspector stays open and opening the last row reveals it inside the list',
    (tester) async {
      await pumpTray(
        tester,
        summarizeBackgroundTray(
          tasks: [for (var i = 0; i < 12; i++) fixture.task('$i')],
        ),
        expanded: true,
      );
      await tester.tap(find.text('Task 0'));
      await tester.pump();
      expect(
        find.byKey(const ValueKey('background-tray-inspector-0')),
        findsOneWidget,
      );
      final list = find.byKey(const ValueKey('background-tray-rows'));
      await tester.drag(list, const Offset(0, -650));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Task 11'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('background-tray-inspector-0')),
        findsNothing,
      );
      final inspector = find.byKey(
        const ValueKey('background-tray-inspector-11'),
      );
      expect(
        tester.getRect(inspector).bottom,
        lessThanOrEqualTo(tester.getRect(list).bottom),
      );
      expect(
        tester.getRect(inspector).top,
        greaterThanOrEqualTo(tester.getRect(list).top),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'task rows show progress, queue state and shell output guidance',
    (tester) async {
      final tasks = [
        for (final kind in RemoteBackgroundProcessKind.values)
          BackgroundTrayTask(
            RemoteBackgroundProcess(
              localId: kind.name,
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
              chatId: 'chat',
              toolUseId: '',
              kind: kind,
              description: 'Check ${kind.name}',
              status: kind == RemoteBackgroundProcessKind.task
                  ? RemoteBackgroundProcessStatus.queued
                  : RemoteBackgroundProcessStatus.running,
              lastDescription: 'Progress ${kind.name}',
              summary: 'Summary ${kind.name}',
              startedAt: 1000,
              canStop: true,
            ),
          ),
      ];
      await pumpTray(
        tester,
        summarizeBackgroundTray(tasks: tasks),
        expanded: true,
      );
      expect(find.text('Progress bash'), findsOneWidget);
      for (final entry in {
        'agent': CanopyGlyph.agent,
        'bash': CanopyGlyph.console,
        'workflow': CanopyGlyph.workflows,
        'task': CanopyGlyph.squareChecklist,
      }.entries) {
        expect(
          find.descendant(
            of: find.byKey(ValueKey('background-tray-activity-${entry.key}')),
            matching: find.byWidgetPredicate(
              (w) => w is CanopyIcon && w.glyph == entry.value,
            ),
          ),
          findsOneWidget,
        );
      }
      expect(find.text('Queued'), findsOneWidget);
      expect(find.text('1m 5s'), findsNWidgets(4));
      await tester.tap(find.text('Check bash'));
      await tester.pumpAndSettle();
      expect(find.text('Output shows in the desktop app.'), findsOneWidget);
      await tester.tap(find.text('Check task'));
      await tester.pumpAndSettle();
      expect(find.text('Summary task'), findsOneWidget);
      expect(find.text('Output shows in the desktop app.'), findsNothing);
      expect(find.textContaining('Stop'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('task with no updates still opens and closes an inspector', (
    tester,
  ) async {
    const process = RemoteBackgroundProcess(
      localId: 'empty',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'chat',
      toolUseId: '',
      kind: RemoteBackgroundProcessKind.task,
      description: 'Waiting task',
      status: RemoteBackgroundProcessStatus.running,
      canStop: false,
    );
    await pumpTray(
      tester,
      summarizeBackgroundTray(tasks: [const BackgroundTrayTask(process)]),
      expanded: true,
    );
    await tester.tap(find.text('Waiting task'));
    await tester.pumpAndSettle();
    expect(find.text('No updates yet'), findsOneWidget);
    await tester.tap(find.text('Waiting task'));
    await tester.pumpAndSettle();
    expect(find.text('No updates yet'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'approval agent has activity, attention state, steps and metadata',
    (tester) async {
      await pumpTray(
        tester,
        summarizeBackgroundTray(
          agents: [
            BackgroundTrayAgent(
              id: 'review',
              title: 'Review changes',
              kind: BackgroundTrayAgentKind.delegate,
              status: BackgroundTrayAgentStatus.approval,
              activity: 'Needs filesystem access',
              steps: [
                for (var i = 0; i < 22; i++)
                  BackgroundTrayAgentStep(
                    id: 'step-$i',
                    toolName: 'Read',
                    input: '{"file_path":"/tmp/file-$i.dart"}',
                  ),
              ],
              prompt: 'Review the implementation',
              meta: 'Delegate · GPT-6 Sol',
            ),
          ],
          tasks: [fixture.task('shell')],
        ),
        expanded: true,
      );
      expect(find.text('Needs you'), findsOneWidget);
      expect(
        tester
            .widget<ColoredBox>(
              find.byKey(const ValueKey('background-tray-activity-review')),
            )
            .color,
        AppColors.light['bg-attention-muted'],
      );
      expect(find.text('Awaiting approval'), findsOneWidget);
      expect(find.text('Needs filesystem access'), findsOneWidget);
      await tester.tap(find.text('Review changes'));
      await tester.pumpAndSettle();
      expect(find.text('Delegate · GPT-6 Sol'), findsOneWidget);
      expect(find.textContaining('file-21.dart'), findsOneWidget);
      expect(find.textContaining('file-0.dart'), findsNothing);
      expect(find.textContaining('file-1.dart'), findsNothing);
      expect(find.text('Review the implementation'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('agent falls back to latest step or three-line prompt', (
    tester,
  ) async {
    await pumpTray(
      tester,
      summarizeBackgroundTray(
        agents: const [
          BackgroundTrayAgent(
            id: 'native',
            title: 'Review',
            kind: BackgroundTrayAgentKind.codex,
            status: BackgroundTrayAgentStatus.running,
            meta: 'Codex · GPT-6 Sol · high',
            prompt: 'Review the diff before release',
          ),
        ],
      ),
      expanded: true,
    );
    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<Text>(find.text('Review the diff before release')).maxLines,
      3,
    );
    expect(find.text('Codex · GPT-6 Sol · high'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unlisted delegate copy has no inspector or action', (
    tester,
  ) async {
    for (final count in [1, 3]) {
      for (final listed in [false, true]) {
        await pumpTray(
          tester,
          summarizeBackgroundTray(
            agents: listed ? [fixture.agent('listed')] : [],
            unlistedDelegations: count,
          ),
          expanded: true,
        );
        final label =
            '$count ${listed ? 'more ' : ''}${count == 1 ? 'delegate' : 'delegates'}';
        expect(find.text(label), findsOneWidget);
        await tester.tap(find.text(label));
        await tester.pump();
        expect(
          find.byKey(
            const ValueKey('background-tray-inspector-unlisted-delegates'),
          ),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      }
    }
  });

  testWidgets(
    'approval and queued agents fit with expanded details at large type',
    (tester) async {
      await pumpTray(
        tester,
        summarizeBackgroundTray(
          agents: [
            fixture.agent(
              'approval',
              status: BackgroundTrayAgentStatus.approval,
            ),
            fixture.agent('queued', status: BackgroundTrayAgentStatus.queued),
          ],
        ),
        expanded: true,
        scale: 2,
      );
      expect(find.bySemanticsLabel(RegExp(r'\bQueued\b')), findsOneWidget);
      expect(find.text('Awaiting approval'), findsOneWidget);
      await tester.tap(find.text('Agent approval'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('background-tray-inspector-approval')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('system back collapses without leaving the chat', (tester) async {
    await pumpTray(
      tester,
      summarizeBackgroundTray(tasks: [fixture.task('one')]),
      expanded: true,
    );
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.text('Task one'), findsNothing);
    expect(find.text('1 running in the background'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Escape collapses while the draft has focus', (tester) async {
    var expanded = true;
    final focus = FocusNode();
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => Column(
              children: [
                BackgroundTray(
                  summary: summarizeBackgroundTray(
                    tasks: [fixture.task('one')],
                  ),
                  now: 66000,
                  expanded: expanded,
                  onExpandedChanged: (value) =>
                      setState(() => expanded = value),
                ),
                TextField(focusNode: focus),
              ],
            ),
          ),
        ),
      ),
    );
    focus.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(expanded, isFalse);
    expect(focus.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
  });
}
