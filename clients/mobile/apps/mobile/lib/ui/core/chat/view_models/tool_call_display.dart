/// Display mapping for chat tool calls — a Dart port of the shared
/// desktop/web registry (`packages/ui-shared/src/components/chat/
/// tool-display-info.tsx` and the per-tool label renderers in
/// `tool-display.tsx`): each wire `toolFamily` gets an icon and friendly
/// label, and common tools get a `verb + parameter` one-line summary instead
/// of the raw tool name.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/chat_message.dart';

/// Exact recognizer for the two tools exposed by the Computer Use REPL MCP.
bool isComputerUseToolName(String? name) =>
    name == 'mcp__cua_repl__js' || name == 'mcp__cua_repl__js_reset';

/// Recognizes canonical family hints and older/partial raw-name-only parts.
bool isComputerUseTool(ChatPart part) =>
    part.toolFamily == 'computer-use' || isComputerUseToolName(part.toolName);

/// Icon for a wire tool family, wrench fallback for unknown/missing —
/// Material equivalents of the shared `TOOL_FAMILY_REGISTRY` glyphs.
IconData toolFamilyIcon(String? family) => switch (family) {
  'read' => Icons.description_outlined,
  'edit' || 'write' => Icons.edit_outlined,
  'plan' => Icons.checklist_rtl,
  'bash' => Icons.terminal,
  'grep' => Icons.find_in_page_outlined,
  'glob' => Icons.search,
  'todo' => Icons.checklist,
  'web' => Icons.public,
  'agent' => Icons.smart_toy_outlined,
  'ask-user' => Icons.help_outline,
  'script-output' => Icons.code,
  'skill' => Icons.school_outlined,
  'monitor' => Icons.desktop_windows_outlined,
  'claude' => Icons.auto_awesome,
  'watcher' => Icons.visibility_outlined,
  'canopy' => Icons.build_outlined,
  'graph' => Icons.polyline_outlined,
  'app-advisor' => Icons.lightbulb_outline,
  'pipeline-editor' => Icons.account_tree_outlined,
  _ => Icons.build_outlined,
};

/// Default label for a wire tool family (`getToolFamilyLabel` port).
String toolFamilyLabel(String? family) => switch (family) {
  'read' => 'Read',
  'edit' => 'Edit',
  'write' => 'Write',
  'plan' => 'Plan',
  'bash' => 'Bash',
  'grep' => 'Grep',
  'glob' => 'Glob',
  'todo' => 'Todo',
  'web' => 'Web',
  'agent' => 'Agent',
  'ask-user' => 'Ask user',
  'script-output' => 'Script output',
  'skill' => 'Skill',
  'monitor' => 'Monitor',
  'claude' => 'Claude',
  'watcher' => 'Watcher',
  'canopy' => 'App',
  'graph' => 'Code Graph',
  'app-advisor' => 'Orchestrator',
  'pipeline-editor' => 'Pipeline Editor',
  'computer-use' => 'Computer Use',
  _ => 'Tool',
};

/// `mcp__server__tool` parse result.
typedef McpToolName = ({String server, String tool});

/// Splits an MCP-namespaced tool name (`mcp__linear__list_issues`).
McpToolName? parseMcpToolName(String name) {
  if (!name.startsWith('mcp__')) return null;
  final rest = name.substring(5);
  final split = rest.indexOf('__');
  if (split <= 0 || split >= rest.length - 2) return null;
  return (server: rest.substring(0, split), tool: rest.substring(split + 2));
}

/// Strips a `/bin/<shell> -<flags> '<payload>'` or Windows
/// `"...\pwsh.exe" -Command <payload>` wrapper off a shell command so the row
/// shows the payload the agent actually ran (`unwrapShellWrappedCommand` port
/// from `tool-display.tsx`, all three branches).
String unwrapShellWrappedCommand(String command) {
  final singleQuoted = RegExp(
    r"^/bin/\S+\s+-\S+\s+'((?:[^'\\]|\\.)*)'$",
  ).firstMatch(command);
  if (singleQuoted != null) return singleQuoted.group(1) ?? command;
  final doubleQuoted = RegExp(
    r'^/bin/\S+\s+-\S+\s+"((?:[^"\\]|\\.)*)"$',
  ).firstMatch(command);
  if (doubleQuoted != null) return doubleQuoted.group(1) ?? command;
  final windowsPrefix = RegExp(
    r'''^["'][^"']*\\(?:pwsh|powershell)\.exe["']\s+-Command\b\s*''',
    caseSensitive: false,
  ).firstMatch(command);
  if (windowsPrefix != null) {
    final payload = command.substring(windowsPrefix.end).trim();
    return _unwrapWholeQuotedPayload(payload) ?? payload;
  }
  return command;
}

/// `unwrapWholeQuotedPayload` port: strips one pair of quotes only when they
/// wrap the entire payload.
String? _unwrapWholeQuotedPayload(String payload) {
  if (payload.isEmpty) return null;
  final quote = payload[0];
  if (quote != "'" && quote != '"') return payload;
  if (payload.length < 2 || !payload.endsWith(quote)) return payload;
  final inner = payload.substring(1, payload.length - 1);
  return inner.contains(quote) ? payload : inner;
}

/// Humanizes a raw tool name (`prettifyToolName` port): `mcp` segments and
/// snake/kebab words are capitalized, and a dotted name becomes
/// `Prefix - Rest`.
String prettifyToolName(String name) {
  String capitalizeWords(String segment) => segment
      .split(RegExp(r'[_-]+'))
      .expand((word) => word.split(' '))
      .where((word) => word.isNotEmpty)
      .map((word) => word[0].toUpperCase() + word.substring(1))
      .join(' ');

  final dotIndex = name.indexOf('.');
  if (dotIndex < 0) return capitalizeWords(name);
  final prefix = capitalizeWords(name.substring(0, dotIndex));
  final rest = capitalizeWords(name.substring(dotIndex + 1));
  return '$prefix - $rest';
}

/// One-line row label for a tool call: a [title] (verb + friendly target)
/// plus an optional monospace [detail] suffix (e.g. the shell command).
typedef ToolCallLabel = ({String title, String? detail});

/// The resolved outcome attached to a tool call.
typedef ToolCallResult = ({String content, bool isError});

/// Reads a result embedded directly on a `tool_use` part (`data.result`),
/// the shape the persisted projection can carry — the live runtime projects
/// results as separate `tool_result` parts instead.
ToolCallResult? embeddedToolResult(ChatPart part) {
  final result = part.data?['result'];
  if (result is! Map<String, dynamic>) return null;
  final content = result['output'] ?? result['content'] ?? result['text'];
  if (content is! String || content.trim().isEmpty) return null;
  return (content: content, isError: result['isError'] == true);
}

String _truncate(String text, int max) =>
    text.length > max ? '${text.substring(0, max)}…' : text;

String _baseName(String path) {
  final segments = path.split(RegExp(r'[\\/]+'));
  return segments.isEmpty ? path : segments.last;
}

Map<String, Object?> _parsedInput(ChatPart part) {
  final input = part.toolInput;
  if (input == null || input.isEmpty) return const {};
  try {
    final decoded = jsonDecode(input);
    return decoded is Map<String, Object?> ? decoded : const {};
  } on FormatException {
    // Producer-side truncation can cut the JSON mid-token; the raw input is
    // still shown in the expanded panel.
    return const {};
  }
}

String? _stringField(Map<String, Object?> parsed, String key) {
  final value = parsed[key];
  return value is String && value.trim().isNotEmpty ? value : null;
}

/// An `Agent`/`Task` call that spawns a helper agent, as hosts that carry
/// raw tool blocks (Computer Connect) send it instead of an `agent` part.
bool isAgentSpawn(ChatPart part) =>
    part.kind == 'tool_use' &&
    (part.toolName == 'Agent' || part.toolName == 'Task');

/// The `agent` part an [isAgentSpawn] call stands for, so it draws as the
/// same helper agent row desktop folds the call into: its type, description,
/// prompt and background flag from the input, and its outcome from [result].
ChatPart agentPartOfSpawn(
  ChatPart part, {
  required ToolCallResult? result,
  required bool running,
}) {
  final parsed = _parsedInput(part);
  return ChatPart(
    kind: 'agent',
    data: {
      'toolUseId': ?part.toolUseId,
      'subagentType': ?_stringField(parsed, 'subagent_type'),
      'description': ?_stringField(parsed, 'description'),
      'prompt': ?_stringField(parsed, 'prompt'),
      'runInBackground': parsed['run_in_background'] == true,
      'isRunning': running,
      'result': ?result?.content,
      'isError': result?.isError ?? false,
    },
  );
}

/// Builds the friendly one-line label for a `tool_use` part, mirroring the
/// desktop `getToolDisplayInfo` verb+parameter grammar for the common tools
/// and falling back to `Server › Tool` for MCP names and a prettified name
/// otherwise.
ToolCallLabel toolCallLabel(ChatPart part) {
  final family = part.toolFamily;
  final toolName = part.toolName;
  final parsed = _parsedInput(part);

  if (isComputerUseTool(part)) {
    return (
      title: 'Computer Use',
      detail: toolName == 'mcp__cua_repl__js_reset' ? 'Reset' : null,
    );
  }

  switch (family) {
    case 'read':
      final filePath = _stringField(parsed, 'file_path');
      return (
        title: 'Read',
        detail: filePath == null ? null : _baseName(filePath),
      );
    case 'write' || 'edit':
      final filePath = _stringField(parsed, 'file_path');
      final verb = toolFamilyLabel(family);
      return (
        title: verb,
        detail: filePath == null ? null : _baseName(filePath),
      );
    case 'bash':
      // Codex `command_execution` projects the input as a RAW command
      // string (`toolName: 'command'` in runtime-chat-projection.ts), not
      // JSON — dispatch on the name like desktop's `renderCommand` so Codex
      // shell rows keep their one-line command summary (with the same
      // shell-wrapper unwrap). Claude Bash/PowerShell stays JSON-only so a
      // truncated JSON input never leaks into the detail.
      final rawInput = part.toolInput?.trim();
      final command =
          _stringField(parsed, 'command') ??
          (toolName == 'command' && rawInput != null && rawInput.isNotEmpty
              ? unwrapShellWrappedCommand(rawInput)
              : null);
      final description = _stringField(parsed, 'description');
      final heading = description == null
          ? switch (toolName) {
              'PowerShell' => 'PowerShell',
              'command' => 'Command',
              _ => 'Bash',
            }
          : _truncate(
              description[0].toUpperCase() + description.substring(1),
              80,
            );
      return (
        title: heading,
        detail: command == null ? null : _truncate(command, 60),
      );
    case 'grep':
      final pattern = _stringField(parsed, 'pattern');
      final path = _stringField(parsed, 'path');
      return (
        title: 'Grep',
        detail: pattern == null
            ? null
            : path == null
            ? pattern
            : '$pattern in ${_baseName(path)}',
      );
    case 'glob':
      return (title: 'Glob', detail: _stringField(parsed, 'pattern'));
    case 'web':
      final target =
          _stringField(parsed, 'url') ?? _stringField(parsed, 'query');
      return (
        title: toolName == 'WebSearch' ? 'Web Search' : 'Web Fetch',
        detail: target == null ? null : _truncate(target, 60),
      );
    case 'skill':
      final skill =
          _stringField(parsed, 'skill') ?? _stringField(parsed, 'command');
      return (title: skill == null ? 'Skill' : 'Using skill', detail: skill);
    case 'todo':
      return (title: 'Todo', detail: null);
  }

  if (toolName != null) {
    final mcp = parseMcpToolName(toolName);
    if (mcp != null) {
      return (
        title:
            '${prettifyToolName(mcp.server)} › '
            '${prettifyToolName(mcp.tool)}',
        detail: null,
      );
    }
    return (title: prettifyToolName(toolName), detail: null);
  }
  return (title: toolFamilyLabel(family), detail: null);
}
