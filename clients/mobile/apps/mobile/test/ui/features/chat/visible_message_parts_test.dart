import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/view_models/visible_message_parts.dart';

void main() {
  test(
    'mixed visible text and host notices retain order without private instructions',
    () {
      final parts = visibleMessageParts(
        'Before\n<system_instruction>Private context</system_instruction>\n<system_instruction><canopy_watcher_event>{"label":"Checks finished","kind":"delegation_finished"}</canopy_watcher_event></system_instruction>\nAfter',
      );
      expect(parts.map((part) => part.text), [
        'Before',
        'Checks finished',
        'After',
      ]);
      expect(parts[1].watcherFired?.kind, 'Delegate finished');
    },
  );

  test('steering requests reverse broker escaping and retain their sender', () {
    final parts = visibleMessageParts(
      r'<system_instruction>A managed subordinate (Reviewer) requested steering <subordinate_request>Check\n\u003cdetails\u003e</subordinate_request></system_instruction>',
    );
    expect(parts.single.kind, VisibleMessagePartKind.steeringRequest);
    expect(parts.single.text, 'Check\n<details>');
    expect(parts.single.requestedBy, 'Reviewer');
  });

  test('unknown and unclosed provider instructions stay hidden', () {
    for (final source in [
      '<system_instruction>private</system_instruction>',
      '<system_instruction>private',
    ]) {
      final parts = visibleMessageParts(source);
      expect(parts.single.kind, VisibleMessagePartKind.hidden);
      expect(parts.single.text, isEmpty);
    }
  });

  test(
    'watcher deletion notices use their display label without leaking payload',
    () {
      final parts = visibleMessageParts(
        '<system_instruction><canopy_watcher_deleted>{"label":"Release checks"}</canopy_watcher_deleted></system_instruction>',
      );
      expect(parts.single.text, 'Watcher deleted: Release checks');
    },
  );
}
