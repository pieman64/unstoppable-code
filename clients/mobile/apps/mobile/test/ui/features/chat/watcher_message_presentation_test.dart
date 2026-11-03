// CAN-4432: the visible notice and watcher title of a cloud watcher message,
// matching web's `watcherFiredPresentation`.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/view_models/watcher_message_presentation.dart';

/// A fired watcher as a host that cannot hide context sends it
/// (`agentWatcherFiredPromptText`).
String _watcherMessage(String payload, {String tag = 'canopy'}) => [
  '<system_instruction>',
  'Canopy watcher internal event details.',
  '',
  '<${tag}_watcher_event>',
  payload,
  '</${tag}_watcher_event>',
  '</system_instruction>',
  '',
  'Canopy watcher fired.',
  'Chat completion: Release notes',
].join('\n');

void main() {
  test('shows the notice under the payload label', () {
    final presentation = watcherMessagePresentation(
      _watcherMessage(
        '{"label": " Chat completion: Release notes ", "secret": "x"}',
      ),
    );
    expect(
      presentation?.text,
      'Canopy watcher fired.\nChat completion: Release notes',
    );
    expect(presentation?.watcherFired.kind, 'Chat completion: Release notes');
    expect(presentation?.watcherFired.combinedWatchers, isNull);
  });

  test('accepts any namespace and tag case, matching open and close', () {
    final presentation = watcherMessagePresentation(
      _watcherMessage('{"label": "Deploy"}', tag: 'Acme2'),
    );
    expect(presentation?.watcherFired.kind, 'Deploy');
    expect(
      watcherMessagePresentation(
        '<system_instruction><canopy_watcher_event>{"label": "Deploy"}'
        '</acme_watcher_event></system_instruction>Notice',
      ),
      isNull,
    );
  });

  test('falls back to "Watcher" for a missing label or malformed JSON', () {
    for (final payload in ['{"label": "  "}', '{}', '{not json', '[1]']) {
      final presentation = watcherMessagePresentation(_watcherMessage(payload));
      expect(presentation?.watcherFired.kind, 'Watcher', reason: payload);
      expect(
        presentation?.text,
        'Canopy watcher fired.\nChat completion: Release notes',
      );
    }
  });

  test('a block without a notice shows the label as its text', () {
    final presentation = watcherMessagePresentation(
      '<system_instruction><canopy_watcher_event>{"label": "Deploy"}'
      '</canopy_watcher_event></system_instruction>',
    );
    expect(presentation?.text, 'Deploy');
    expect(presentation?.watcherFired.kind, 'Deploy');
  });

  test('an unclosed instruction block hides the rest of the message', () {
    final presentation = watcherMessagePresentation(
      'Before\n<system_instruction><canopy_watcher_event>{"label": "Deploy"}'
      '</canopy_watcher_event> trailing instructions',
    );
    expect(presentation?.text, 'Before');
  });

  test('names historical delegate watches as the main chat does', () {
    for (final (outcome, kind) in [
      ('timeout', 'Delegate watch timed out'),
      ('completed', 'Delegate watch completed'),
    ]) {
      final presentation = watcherMessagePresentation(
        _watcherMessage(
          '{"label": "Delegate", "target": '
          '{"kind": "managed_delegation", "outcome": "$outcome"}}',
        ),
      );
      expect(presentation?.watcherFired.kind, kind);
    }
  });

  test('names automatic delegation notices without a watch', () {
    final presentation = watcherMessagePresentation(
      _watcherMessage(
        '{"kind": "delegation_finished", "label": "Review: completed"}',
      ),
    );
    expect(presentation?.watcherFired.kind, 'Delegate finished');
  });

  test('keeps visible text around blocks and drops other instructions', () {
    final presentation = watcherMessagePresentation(
      'Typed first\n'
      '<system_instruction>Reload capabilities.</system_instruction>\n'
      '<system_instruction><canopy_watcher_deleted>{"label": "Lint"}'
      '</canopy_watcher_deleted></system_instruction>\n'
      '<system_instruction><canopy_watcher_event>{"label": "Deploy"}'
      '</canopy_watcher_event></system_instruction>\n'
      'Canopy watcher fired.',
    );
    expect(
      presentation?.text,
      'Typed first\n\nWatcher deleted: Lint\n\nCanopy watcher fired.',
    );
    expect(presentation?.watcherFired.kind, 'Deploy');
  });

  test('leaves messages without a watcher event unchanged', () {
    for (final text in [
      '',
      'Canopy watcher fired.\nWorktree pipeline completion: Lint',
      '<system_instruction>Reload capabilities.</system_instruction>Hi',
      '<system_instruction><canopy_watcher_deleted>{"label": "Lint"}'
          '</canopy_watcher_deleted></system_instruction>',
    ]) {
      expect(watcherMessagePresentation(text), isNull, reason: text);
    }
  });

  test('a steering request is never shown as a watcher', () {
    expect(
      watcherMessagePresentation(
        '<system_instruction><canopy_watcher_event>{"label": "Deploy"}'
        '</canopy_watcher_event></system_instruction>'
        '<system_instruction>A managed subordinate (Fixer) requested '
        'steering.<subordinate_request>Help</subordinate_request>'
        '</system_instruction>',
      ),
      isNull,
    );
  });
}
