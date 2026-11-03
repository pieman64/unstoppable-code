import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';
import 'package:mobile/ui/core/chat/widgets/tool_call_row.dart';

void main() {
  group('toolCallLabel', () {
    ChatPart part(
      String? family, {
      String? toolName,
      Map<String, Object?>? input,
    }) => ChatPart(
      kind: 'tool_use',
      toolFamily: family,
      data: {
        'toolName': ?toolName,
        if (input != null) 'input': jsonEncode(input),
      },
    );

    test('read/edit/write show the verb plus the file basename', () {
      final read = toolCallLabel(
        part('read', input: {'file_path': '/repo/lib/ui/theme.dart'}),
      );
      expect(read.title, 'Read');
      expect(read.detail, 'theme.dart');

      final edit = toolCallLabel(
        part('edit', input: {'file_path': r'C:\repo\main.dart'}),
      );
      expect(edit.title, 'Edit');
      expect(edit.detail, 'main.dart');
    });

    test('bash prefers the description heading with the command as detail', () {
      final label = toolCallLabel(
        part(
          'bash',
          toolName: 'Bash',
          input: {'command': 'npm test', 'description': 'run the tests'},
        ),
      );
      expect(label.title, 'Run the tests');
      expect(label.detail, 'npm test');

      final bare = toolCallLabel(part('bash', toolName: 'Bash'));
      expect(bare.title, 'Bash');
      expect(bare.detail, isNull);
    });

    test('grep shows pattern and search root', () {
      final label = toolCallLabel(
        part('grep', input: {'pattern': 'TODO', 'path': '/repo/src'}),
      );
      expect(label.title, 'Grep');
      expect(label.detail, 'TODO in src');
    });

    test('MCP names prettify to Server › Tool', () {
      final label = toolCallLabel(
        part(null, toolName: 'mcp__linear__list_issues'),
      );
      expect(label.title, 'Linear › List Issues');
    });

    test('Computer Use reset keeps its secondary Reset detail', () {
      final run = toolCallLabel(
        part('computer-use', toolName: 'mcp__cua_repl__js'),
      );
      final reset = toolCallLabel(
        part('computer-use', toolName: 'mcp__cua_repl__js_reset'),
      );
      expect(run.title, 'Computer Use');
      expect(run.detail, isNull);
      expect(reset.title, 'Computer Use');
      expect(reset.detail, 'Reset');
    });

    test('Computer Use raw names work without a family hint', () {
      final run = toolCallLabel(part(null, toolName: 'mcp__cua_repl__js'));
      final reset = toolCallLabel(
        part(null, toolName: 'mcp__cua_repl__js_reset'),
      );
      expect(run.title, 'Computer Use');
      expect(run.detail, isNull);
      expect(reset.title, 'Computer Use');
      expect(reset.detail, 'Reset');
    });

    test('unknown names prettify instead of rendering raw', () {
      // Matches desktop `prettifyToolName`: snake/kebab words capitalize,
      // CamelCase names pass through, dotted names split on the dot.
      expect(prettifyToolName('tool_without_prefix'), 'Tool Without Prefix');
      expect(
        toolCallLabel(part(null, toolName: 'TodoWrite')).title,
        'TodoWrite',
      );
      expect(prettifyToolName('chat.send_message'), 'Chat - Send Message');
    });

    test('a family with no name falls back to the family label', () {
      expect(toolCallLabel(part('grep')).title, 'Grep');
      expect(toolCallLabel(const ChatPart(kind: 'tool_use')).title, 'Tool');
    });

    test('truncated (undecodable) input still labels by family', () {
      const truncated = ChatPart(
        kind: 'tool_use',
        toolFamily: 'bash',
        data: {'toolName': 'Bash', 'input': '{"command": "npm t'},
      );
      expect(toolCallLabel(truncated).title, 'Bash');
      // Claude Bash stays JSON-only: the truncated JSON must not leak into
      // the detail as if it were a raw command.
      expect(toolCallLabel(truncated).detail, isNull);
    });

    test('Codex command_execution keeps its raw-string command', () {
      // Codex projects `toolName: 'command'` with the input as a PLAIN
      // command string (runtime-chat-projection.ts), not JSON.
      const codex = ChatPart(
        kind: 'tool_use',
        toolFamily: 'bash',
        data: {'toolName': 'command', 'input': 'npm run build && npm test'},
      );
      final label = toolCallLabel(codex);
      expect(label.title, 'Command');
      expect(label.detail, 'npm run build && npm test');
    });

    test('shell-wrapped Codex commands are unwrapped like desktop', () {
      const wrapped = ChatPart(
        kind: 'tool_use',
        toolFamily: 'bash',
        data: {'toolName': 'command', 'input': "/bin/zsh -lc 'flutter test'"},
      );
      expect(toolCallLabel(wrapped).detail, 'flutter test');
      expect(unwrapShellWrappedCommand('/bin/bash -c "ls -la"'), 'ls -la');
      expect(unwrapShellWrappedCommand('plain command'), 'plain command');
      // Windows PowerShell wrapper branch (desktop parity).
      expect(
        unwrapShellWrappedCommand(
          r'"C:\Program Files\PowerShell\7\pwsh.exe" -Command "dir src"',
        ),
        'dir src',
      );
      expect(
        unwrapShellWrappedCommand(
          r'"C:\Windows\System32\powershell.exe" -Command Get-ChildItem',
        ),
        'Get-ChildItem',
      );
    });
  });

  group('ToolCallRow', () {
    Widget host(Widget child) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(body: Align(child: child)),
    );

    const bashPart = ChatPart(
      kind: 'tool_use',
      toolFamily: 'bash',
      data: {
        'toolUseId': 'tu-1',
        'toolName': 'Bash',
        'input': '{"command": "npm test"}',
      },
    );

    testWidgets('renders a flat icon row, not a text bubble chip', (
      tester,
    ) async {
      await tester.pumpWidget(host(const ToolCallRow(part: bashPart)));
      await tester.pump();

      expect(find.byIcon(Icons.terminal), findsOneWidget);
      expect(find.text('Bash'), findsOneWidget);
      expect(find.text('npm test'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Computer Use renders the shared cursor glyph', (tester) async {
      const part = ChatPart(
        kind: 'tool_use',
        toolFamily: 'computer-use',
        data: {'toolName': 'mcp__cua_repl__js'},
      );
      await tester.pumpWidget(host(const ToolCallRow(part: part)));
      await tester.pump();

      expect(
        tester.widget<CanopyIcon>(find.byType(CanopyIcon)).glyph,
        CanopyGlyph.cursorClick,
      );
      expect(find.byIcon(Icons.ads_click_outlined), findsNothing);
    });

    testWidgets('tapping expands the input and result panel', (tester) async {
      await tester.pumpWidget(
        host(
          const ToolCallRow(
            part: bashPart,
            result: (content: '52 tests passed', isError: false),
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(const ValueKey('tool-call-detail')), findsNothing);
      await tester.tap(find.text('Bash'));
      await tester.pump();

      expect(find.byKey(const ValueKey('tool-call-detail')), findsOneWidget);
      expect(find.text('Result'), findsOneWidget);
      expect(find.text('52 tests passed'), findsOneWidget);
      expect(find.text('{"command": "npm test"}'), findsOneWidget);

      // Collapses again.
      await tester.tap(find.text('Bash'));
      await tester.pump();
      expect(find.byKey(const ValueKey('tool-call-detail')), findsNothing);
    });

    testWidgets('an error result labels the panel Error', (tester) async {
      await tester.pumpWidget(
        host(
          const ToolCallRow(
            part: bashPart,
            result: (content: 'command not found', isError: true),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('Bash'));
      await tester.pump();

      expect(find.text('Error'), findsOneWidget);
      expect(find.text('command not found'), findsOneWidget);
    });

    testWidgets('a pending call shows the working spinner', (tester) async {
      await tester.pumpWidget(
        host(const ToolCallRow(part: bashPart, pending: true)),
      );
      await tester.pump();
      expect(find.byType(ThinkingSpinner), findsOneWidget);
    });

    testWidgets('a resolved call shows no spinner', (tester) async {
      await tester.pumpWidget(
        host(
          const ToolCallRow(
            part: bashPart,
            pending: true,
            result: (content: 'done', isError: false),
          ),
        ),
      );
      await tester.pump();
      expect(find.byType(ThinkingSpinner), findsNothing);
    });

    testWidgets('a long result is bounded behind Show more', (tester) async {
      final longResult = List.generate(
        40,
        (i) => 'line $i of output',
      ).join('\n');
      // Scrollable host: in the app the transcript list scrolls, so a fully
      // expanded panel exceeding the viewport is legitimate there.
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: SingleChildScrollView(
              child: ToolCallRow(
                part: bashPart,
                result: (content: longResult, isError: false),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('Bash'));
      await tester.pump();

      // Bounded by maxLines with the affordance visible.
      expect(find.byKey(const ValueKey('tool-call-show-more')), findsWidgets);
      await tester.tap(find.byKey(const ValueKey('tool-call-show-more')).last);
      await tester.pump();
      // Expanding removes that panel's affordance.
      final remaining = find.byKey(const ValueKey('tool-call-show-more'));
      expect(remaining.evaluate().length, lessThan(2));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a long title ellipsizes at phone width instead of '
        'overflowing', (tester) async {
      // Phone-width viewport so a RenderFlex overflow surfaces as a real
      // exception instead of being hidden by the default 800×600 surface.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      const longDescription = ChatPart(
        kind: 'tool_use',
        toolFamily: 'bash',
        data: {
          'toolUseId': 'tu-long',
          'toolName': 'Bash',
          'input':
              '{"command": "npm run test:electron:captures:built -- '
              'can-1700-changed-files-section.capture-spec.ts", '
              '"description": "rebuild the end-to-end bundle and rerun the '
              'full electron capture suite against the changed files section '
              'in dark mode"}',
        },
      );
      await tester.pumpWidget(
        host(
          const SizedBox(width: 390, child: ToolCallRow(part: longDescription)),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);

      // Untruncated MCP titles must ellipsize too.
      const longMcp = ChatPart(
        kind: 'tool_use',
        data: {
          'toolUseId': 'tu-mcp',
          'toolName':
              'mcp__extremely_long_server_namespace__an_equally_long_tool_'
              'name_that_never_gets_truncated_by_the_label_builder',
        },
      );
      await tester.pumpWidget(
        host(const SizedBox(width: 390, child: ToolCallRow(part: longMcp))),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });
}
