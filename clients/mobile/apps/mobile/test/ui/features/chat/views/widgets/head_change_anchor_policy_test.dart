import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/widgets/head_change_anchor_policy.dart';

void main() {
  const viewport = 600.0;

  ReaderAnchor? select(
    List<String> current,
    List<String> previous,
    Map<String, AnchorRowLayout> layouts,
  ) => selectReaderAnchor(
    currentIds: current,
    previousIds: previous,
    layoutOf: (messageId) => layouts[messageId],
    viewportExtent: viewport,
  );

  group('selectReaderAnchor', () {
    test('takes the first on-screen row of the new transcript', () {
      expect(
        select(['new-head', 'a', 'b'], ['old-head', 'a', 'b'], {
          'old-head': (top: -300, height: 100),
          'a': (top: 40, height: 100),
          'b': (top: 140, height: 100),
        }),
        (messageId: 'a', viewportOffset: 40),
      );
    });

    test('counts a row partly above the viewport as on screen', () {
      expect(
        select(['a', 'b'], ['a', 'b'], {
          'a': (top: -60, height: 100),
          'b': (top: 40, height: 100),
        }),
        (messageId: 'a', viewportOffset: -60),
      );
    });

    test('skips rows entirely above or below the viewport', () {
      expect(
        select(['above', 'below'], ['above', 'below'], {
          'above': (top: -100, height: 100),
          'below': (top: viewport, height: 100),
        }),
        isNull,
      );
    });

    test('skips rows with no layout', () {
      expect(select(['unlaid', 'b'], ['b'], {'b': (top: 10, height: 50)}), (
        messageId: 'b',
        viewportOffset: 10,
      ));
    });

    test('puts the first surviving row after the reader in their place', () {
      // The reader sees r1 and r2, which the replacement drops; r3 survives.
      expect(
        select(['fresh', 'r3', 'r4'], ['r0', 'r1', 'r2', 'r3', 'r4'], {
          'r0': (top: -400, height: 100),
          'r1': (top: 20, height: 300),
          'r2': (top: 320, height: 300),
        }),
        (messageId: 'r3', viewportOffset: 20),
      );
    });

    test('never anchors a surviving row before the reader', () {
      expect(
        select(['r0', 'r3'], ['r0', 'r1', 'r3'], {
          'r0': (top: -400, height: 100),
          'r1': (top: 20, height: 300),
        }),
        (messageId: 'r3', viewportOffset: 20),
      );
    });

    test('has no anchor when nothing the reader saw survives', () {
      expect(
        select(['fresh'], ['r1', 'r2'], {'r1': (top: 20, height: 300)}),
        isNull,
      );
    });

    test('has no anchor when the reader sees no row', () {
      expect(select(['a'], ['a'], const {}), isNull);
    });
  });
}
