import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Counts actual element builds without inserting probes into production UI.
class RebuildCounter {
  RebuildCounter() {
    final previous = debugOnRebuildDirtyWidget;
    debugOnRebuildDirtyWidget = (element, builtOnce) {
      previous?.call(element, builtOnce);
      counts.update(
        element.widget.runtimeType,
        (n) => n + 1,
        ifAbsent: () => 1,
      );
      if (element.widget.key case final key?) {
        keyCounts.update(key, (n) => n + 1, ifAbsent: () => 1);
      }
      elementCounts.update(element, (n) => n + 1, ifAbsent: () => 1);
    };
    addTearDown(() => debugOnRebuildDirtyWidget = previous);
  }

  final counts = <Type, int>{};

  /// Builds of elements whose widget carries a key, so a test can follow one
  /// row of a list whose widget types are private.
  final keyCounts = <Key, int>{};

  /// Builds per element, for a row found on screen that carries no key.
  final elementCounts = <Element, int>{};
  int of(Type type) => counts[type] ?? 0;
  int ofKey(Key key) => keyCounts[key] ?? 0;
  int ofElement(Element element) => elementCounts[element] ?? 0;
  void reset() {
    counts.clear();
    keyCounts.clear();
    elementCounts.clear();
  }
}
