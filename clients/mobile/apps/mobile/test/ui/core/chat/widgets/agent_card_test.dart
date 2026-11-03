import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/widgets/agent_card.dart';
import 'package:mobile/ui/core/chat/widgets/thinking_row.dart';
import 'package:mobile/ui/core/chat/widgets/tool_call_row.dart';
import 'package:mobile/ui/core/theme.dart';

const _longDescription =
    'Map every exported name in the workflow contracts library and explain '
    'how each module is used by the runner and Core';

ChatPart _card({
  bool running = true,
  bool failed = false,
  String? result,
  List<Map<String, dynamic>> subBlocks = const [],
  int omitted = 0,
}) => ChatPart(
  kind: 'agent',
  data: {
    'provider': 'claude',
    'toolUseId': 'spawn',
    'subagentType': 'Explore',
    'description': _longDescription,
    'prompt': 'List the exports',
    'runInBackground': true,
    'result': ?result,
    if (running) 'isRunning': true,
    if (failed) 'isError': true,
    'usage': {'outputTokens': 1200, 'toolUses': 2, 'durationMs': 65000},
    'subBlocks': subBlocks,
    if (omitted > 0) 'subBlocksTruncated': true,
    if (omitted > 0) 'omittedSubBlocks': omitted,
    'taskId': 't1',
    'taskStatus': running ? 'running' : 'completed',
  },
);

Future<void> _pump(
  WidgetTester tester,
  ChatPart part, {
  ThemeData? theme,
}) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? AppTheme.light,
      home: Scaffold(
        body: SingleChildScrollView(child: AgentCard(part: part)),
      ),
    ),
  );
}

void main() {
  testWidgets('a running card shows its header and expands at phone width', (
    tester,
  ) async {
    await _pump(
      tester,
      _card(
        subBlocks: [
          {
            'kind': 'thinking',
            'data': {'text': 'Plan the search'},
          },
          {
            'kind': 'tool_use',
            'toolFamily': 'read',
            'data': {
              'toolUseId': 'child',
              'toolName': 'Read',
              'input': '{"file_path":"lib/index.ts"}',
              'result': {
                'toolUseId': 'child',
                'output': 'ok',
                'isError': false,
              },
            },
          },
          {
            'kind': 'text',
            'data': {'text': 'Found 12 modules'},
          },
          _card(running: false, result: 'Nested done').toJsonForTest(),
        ],
        omitted: 3,
      ),
    );
    expect(find.text('Agent · Explore'), findsOneWidget);
    expect(find.text('background'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-card-running')), findsOneWidget);
    expect(find.text('Found 12 modules'), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.tap(find.byKey(const ValueKey('agent-card-header')).first);
    await tester.pump();
    expect(find.byType(ThinkingRow), findsOneWidget);
    expect(find.byType(ToolCallRow), findsOneWidget);
    expect(find.text('Found 12 modules'), findsOneWidget);
    expect(find.text("3 earlier items aren't available here"), findsOneWidget);
    expect(find.text('2 tool uses'), findsOneWidget);
    expect(find.text('1m 5s'), findsOneWidget);
    expect(find.byType(AgentCard), findsNWidgets(2));
    expect(find.text('Show prompt'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('agent-card-prompt-toggle')));
    await tester.pump();
    expect(find.text('List the exports'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  _pairedResultTests();
  _depthTests();

  testWidgets('a failed card marks the error and reveals its result', (
    tester,
  ) async {
    await _pump(
      tester,
      _card(running: false, failed: true, result: 'Child failed'),
      theme: AppTheme.dark,
    );
    expect(find.text('error'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-card-running')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('agent-card-header')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('agent-card-result-toggle')));
    await tester.pump();
    expect(find.text('Child failed'), findsOneWidget);
    expect(find.text('Hide result'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

Map<String, dynamic> _chain(int depth) => {
  'kind': 'agent',
  'data': {
    'subagentType': 'general-purpose-reviewer-$depth',
    'description': _longDescription,
    'runInBackground': true,
    'isRunning': true,
    'taskId': 'task-$depth',
    'subBlocks': [
      {
        'kind': 'tool_use',
        'toolFamily': 'bash',
        'data': {
          'toolUseId': 'bash-$depth',
          'toolName': 'Bash',
          'input': '{"command":"pnpm run test --filter workflow-contracts"}',
        },
      },
      if (depth < 9) _chain(depth + 1),
    ],
  },
};

Future<void> _pumpPhone(
  WidgetTester tester,
  Widget child,
  ThemeData theme,
) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: theme,
      home: Scaffold(body: SingleChildScrollView(child: child)),
    ),
  );
}

void _pairedResultTests() {
  testWidgets('a child result in a separate part settles its tool row', (
    tester,
  ) async {
    await _pumpPhone(
      tester,
      AgentCard(
        part: ChatPart.fromJson({
          'kind': 'agent',
          'data': {
            'subagentType': 'Explore',
            'isRunning': true,
            'subBlocks': [
              {
                'kind': 'tool_use',
                'toolFamily': 'read',
                'data': {
                  'toolUseId': 'read-1',
                  'toolName': 'Read',
                  'input': '{"file_path":"lib/a.ts"}',
                },
              },
              {
                'kind': 'tool_result',
                'data': {
                  'toolUseId': 'read-1',
                  'output': 'ENOENT: no such file',
                  'isError': true,
                },
              },
              {
                'kind': 'tool_use',
                'toolFamily': 'read',
                'data': {
                  'toolUseId': 'read-2',
                  'toolName': 'Read',
                  'input': '{"file_path":"lib/b.ts"}',
                },
              },
              {
                'kind': 'tool_result',
                'data': {'toolUseId': 'orphan', 'output': 'Orphan output'},
              },
            ],
          },
        }),
      ),
      AppTheme.light,
    );
    await tester.tap(find.byKey(const ValueKey('agent-card-header')));
    await tester.pump();
    final rows = tester
        .widgetList<ToolCallRow>(find.byType(ToolCallRow))
        .toList();
    expect(rows, hasLength(2));
    expect(rows[0].result, (content: 'ENOENT: no such file', isError: true));
    expect(rows[1].result, isNull);
    expect(find.text('Orphan output'), findsOneWidget);
    expect(find.text('ENOENT: no such file'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

void _depthTests() {
  for (final dark in [false, true]) {
    testWidgets('the full depth-bound chain expands without overflow at 390px '
        '(${dark ? 'dark' : 'light'})', (tester) async {
      await _pumpPhone(
        tester,
        AgentCard(part: ChatPart.fromJson(_chain(1))),
        dark ? AppTheme.dark : AppTheme.light,
      );
      for (var depth = 1; depth <= 9; depth++) {
        final headers = find.byKey(const ValueKey('agent-card-header'));
        expect(headers, findsNWidgets(depth));
        await tester.tap(headers.last);
        await tester.pump();
        expect(tester.takeException(), isNull, reason: 'depth $depth');
      }
      expect(find.byType(AgentCard), findsNWidgets(9));
      expect(find.text('Agent · general-purpose-reviewer-9'), findsOneWidget);
      final deepest = tester.getRect(
        find.byKey(const ValueKey('agent-card-header')).last,
      );
      expect(deepest.width, greaterThanOrEqualTo(56));
      expect(deepest.right, lessThanOrEqualTo(390));
    });
  }
}

extension on ChatPart {
  Map<String, dynamic> toJsonForTest() => {'kind': kind, 'data': data};
}
