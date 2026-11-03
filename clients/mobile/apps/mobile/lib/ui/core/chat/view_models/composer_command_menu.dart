/// Pure policy for the composer's `/` and `$` suggestions: trigger
/// detection, ranking, the capped first view, and grouping.
///
/// Ports `findTrigger` from the desktop `useComposerMenu` hook; ranking and
/// the cap live in `composer_command_search.dart`.
library;

import 'package:flutter/services.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_search.dart';

export 'package:mobile/ui/core/chat/view_models/composer_command_search.dart'
    show ComposerSearchFields, searchComposerItems;

/// A built-in composer action. It runs on the device and is never sent as
/// text.
final class ComposerAction {
  const ComposerAction({
    required this.name,
    required this.description,
    required this.onRun,
    this.disabledReason,
  });

  final String name;
  final String description;
  final VoidCallback onRun;

  /// Why the action is shown but cannot run. Such rows are disabled.
  final String? disabledReason;
}

/// The trigger token that ends at a collapsed caret: `[start, end)` holds
/// the trigger character followed by [query].
final class ComposerTrigger {
  const ComposerTrigger({
    required this.start,
    required this.end,
    required this.character,
    required this.query,
  });

  final int start;
  final int end;

  /// `/` or `$`.
  final String character;
  final String query;

  @override
  bool operator ==(Object other) =>
      other is ComposerTrigger &&
      other.start == start &&
      other.end == end &&
      other.character == character &&
      other.query == query;

  @override
  int get hashCode => Object.hash(start, end, character, query);
}

/// The desktop's backward scan bound for a trigger token.
const int kComposerTriggerScanLimit = 200;

final RegExp _whitespace = RegExp(r'\s');
final RegExp _triggerBoundary = RegExp(r'[\s([{]');

/// Finds the `/` (and, when [dollar], `$`) token that ends at the caret.
///
/// The trigger must start the draft or follow whitespace, `(`, `[` or `{`.
/// Whitespace inside the token, a non-collapsed or invalid selection, or a
/// token longer than [kComposerTriggerScanLimit] yields null.
ComposerTrigger? findComposerTrigger(
  TextEditingValue value, {
  required bool dollar,
}) {
  final selection = value.selection;
  final text = value.text;
  if (!selection.isValid ||
      !selection.isCollapsed ||
      selection.baseOffset > text.length) {
    return null;
  }
  final end = selection.baseOffset;
  for (
    var index = end - 1;
    index >= 0 && end - index <= kComposerTriggerScanLimit;
    index--
  ) {
    final character = text[index];
    if (_whitespace.hasMatch(character)) return null;
    if (character == '/' || (dollar && character == r'$')) {
      if (index == 0 || _triggerBoundary.hasMatch(text[index - 1])) {
        return ComposerTrigger(
          start: index,
          end: end,
          character: character,
          query: text.substring(index + 1, end),
        );
      }
    }
  }
  return null;
}

/// The fixed menu groups, in display order.
enum ComposerMenuGroup {
  commands('Commands'),
  skills('Skills and commands'),
  available('Available to enable');

  const ComposerMenuGroup(this.label);

  final String label;
}

/// One selectable suggestion row.
sealed class ComposerMenuEntry {
  const ComposerMenuEntry();
}

final class ComposerActionEntry extends ComposerMenuEntry {
  const ComposerActionEntry(this.action);

  final ComposerAction action;
}

final class ComposerCommandEntry extends ComposerMenuEntry {
  const ComposerCommandEntry(this.command);

  final ComposerCommand command;
}

/// Expands a capped typed search to all [count] ranked rows. Selecting it
/// never edits the draft or resolves anything.
final class ComposerShowAllEntry extends ComposerMenuEntry {
  const ComposerShowAllEntry(this.count);

  final int count;
}

/// A non-empty run of ranked rows in one group. A typed search can show a
/// group more than once, so it never regroups rows; a capped list ends with a
/// [ComposerShowAllEntry] in its last section.
typedef ComposerMenuSection = ({
  ComposerMenuGroup group,
  List<ComposerMenuEntry> entries,
});

String _commandKey(String name) {
  final lower = name.toLowerCase();
  return lower.startsWith('/') || lower.startsWith(r'$')
      ? lower.substring(1)
      : lower;
}

/// What a host row inserts and enables. Rows that share a name but differ
/// here (two plugins' commands, say) are distinct suggestions.
(String, String) _capabilityIdentity(ComposerCommand command) {
  final insertText = command.insertText;
  final ref = command.enableRef;
  return (
    insertText == null || insertText.isEmpty
        ? _commandKey(command.name)
        : insertText,
    ref == null
        ? command.entryId ?? ''
        : [
            for (final key in [...ref.keys]..sort()) '$key=${ref[key]}',
          ].join('\n'),
  );
}

/// Ranks [actions] and host [commands] together for [query]. An empty query
/// lists actions, enabled rows, then rows available to enable, in order. A
/// typed query keeps one global ranking in contiguous group runs, capped to
/// a first view with Show all unless [expanded].
/// A host row named like a built-in action is hidden (desktop rule), and a
/// host row repeating another's insertion and enable reference shows once.
List<ComposerMenuSection> buildComposerMenu({
  required List<ComposerAction> actions,
  required List<ComposerCommand> commands,
  required String query,
  bool expanded = false,
}) {
  final builtIn = {for (final action in actions) action.name.toLowerCase()};
  final seen = <(String, String)>{};
  final hostRows = <ComposerCommand>[];
  for (final command in commands) {
    if (builtIn.contains(_commandKey(command.name)) ||
        !seen.add(_capabilityIdentity(command))) {
      continue;
    }
    hostRows.add(command);
  }
  final entries = <ComposerMenuEntry>[
    for (final action in actions) ComposerActionEntry(action),
    for (final row in hostRows)
      if (!row.availableToEnable) ComposerCommandEntry(row),
    for (final row in hostRows)
      if (row.availableToEnable) ComposerCommandEntry(row),
  ];
  final ranked = searchComposerItems(entries, query, _searchFields);
  final typed = normalizeSearchText(query).isNotEmpty;
  final limited = typed && !expanded
      ? limitSlashResults(ranked, (entry) => _group(entry).name)
      : (visible: ranked, hiddenCount: 0);
  final sections = <ComposerMenuSection>[
    for (final run in groupContiguousRuns(
      limited.visible,
      (entry) => _group(entry).name,
    ))
      (group: _group(run.rows.first), entries: run.rows),
  ];
  if (limited.hiddenCount > 0 && sections.isNotEmpty) {
    sections.last.entries.add(ComposerShowAllEntry(ranked.length));
  }
  return sections;
}

ComposerSearchFields _searchFields(ComposerMenuEntry entry) => switch (entry) {
  ComposerActionEntry(:final action) => (
    name: action.name,
    displayName: null,
    description: action.description,
    category: null,
    namespace: null,
    memberName: null,
    available: false,
  ),
  ComposerCommandEntry(:final command) => (
    name: command.name,
    displayName: command.displayName,
    description: command.description,
    category: command.category,
    namespace: command.pluginName,
    memberName: command.memberName,
    available: command.availableToEnable,
  ),
  ComposerShowAllEntry() => throw StateError('Show all is not ranked'),
};

ComposerMenuGroup _group(ComposerMenuEntry entry) => switch (entry) {
  ComposerCommandEntry(:final command) =>
    command.availableToEnable
        ? ComposerMenuGroup.available
        : ComposerMenuGroup.skills,
  _ => ComposerMenuGroup.commands,
};

/// Replaces [trigger]'s token in [value] with [replacement] and puts the
/// caret after it. The rest of the draft is kept.
TextEditingValue replaceComposerTrigger(
  TextEditingValue value,
  ComposerTrigger trigger,
  String replacement,
) => TextEditingValue(
  text: value.text.replaceRange(trigger.start, trigger.end, replacement),
  selection: TextSelection.collapsed(
    offset: trigger.start + replacement.length,
  ),
);
