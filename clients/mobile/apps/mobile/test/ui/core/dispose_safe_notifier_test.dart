import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

final class _TestNotifier extends ChangeNotifier with DisposeSafeNotifier {
  void ping() => notifyListenersSafe();
}

void main() {
  group('DisposeSafeNotifier', () {
    test('notifyListenersSafe notifies listeners while alive', () {
      final notifier = _TestNotifier();
      var count = 0;
      notifier.addListener(() => count++);

      notifier.ping();

      expect(count, 1);
      expect(notifier.isDisposed, isFalse);
    });

    test('notifyListenersSafe is a no-op after dispose', () {
      final notifier = _TestNotifier();
      var count = 0;
      notifier.addListener(() => count++);

      notifier.dispose();

      expect(notifier.isDisposed, isTrue);
      // Without the guard this would throw "A _TestNotifier was used after being
      // disposed"; the mixin drops the post-dispose notification instead.
      expect(notifier.ping, returnsNormally);
      expect(count, 0);
    });
  });
}
