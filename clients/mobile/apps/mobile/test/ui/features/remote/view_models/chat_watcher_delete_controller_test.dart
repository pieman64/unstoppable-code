import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/ui/features/remote/view_models/chat_watcher_delete_controller.dart';

void main() {
  group('ChatWatcherDeleteController', () {
    late List<({String id, bool notify})> calls;
    late Completer<void> result;
    late ChatWatcherDeleteController controller;

    setUp(() {
      calls = [];
      result = Completer();
      controller = ChatWatcherDeleteController(
        delete: (id, {required notifySubscriber}) {
          calls.add((id: id, notify: notifySubscriber));
          return result.future;
        },
      );
      addTearDown(controller.dispose);
    });

    test('arming one row resets the notify choice and disarms others', () {
      controller.arm('a');
      controller.setNotifySubscriber(true);
      controller.arm('b');

      expect(controller.isConfirming('a'), isFalse);
      expect(controller.isConfirming('b'), isTrue);
      expect(controller.notifySubscriber, isFalse);

      controller.cancel();
      expect(controller.isConfirming('b'), isFalse);
      expect(calls, isEmpty);
    });

    test('a confirmed delete stays pending after success', () async {
      controller.arm('a');
      controller.setNotifySubscriber(true);
      final done = controller.confirm('a');

      expect(controller.isPending('a'), isTrue);
      expect(calls.single, (id: 'a', notify: true));
      // A second confirm while in flight sends nothing more.
      await controller.confirm('a');
      expect(calls, hasLength(1));

      result.complete();
      await done;

      // The removal delta removes the row; until then it reads as deleting.
      expect(controller.isPending('a'), isTrue);
      expect(controller.isConfirming('a'), isFalse);
      expect(controller.errorFor('a'), isNull);
    });

    test('a failure keeps the confirm open with its error', () async {
      controller.arm('a');
      final done = controller.confirm('a');
      result.completeError(
        const RemoteWatcherDeleteException(
          RemoteWatcherDeleteFailure.notFoundOrFiring,
          'desktop text',
        ),
      );
      await done;

      expect(controller.isPending('a'), isFalse);
      expect(controller.isConfirming('a'), isTrue);
      expect(
        controller.errorFor('a'),
        'Watcher not found or currently firing.',
      );

      // Re-arming clears the error for a retry.
      controller.arm('a');
      expect(controller.errorFor('a'), isNull);
    });

    test('confirm requires the row to be armed', () async {
      await controller.confirm('a');
      expect(calls, isEmpty);
    });
  });

  group('chatWatcherDeleteErrorText', () {
    test('uses the desktop message for other typed failures', () {
      expect(
        chatWatcherDeleteErrorText(
          const RemoteWatcherDeleteException(
            RemoteWatcherDeleteFailure.unconfirmed,
            'The desktop has not confirmed deletion.',
          ),
        ),
        'The desktop has not confirmed deletion.',
      );
      expect(
        chatWatcherDeleteErrorText(StateError('boom')),
        'Could not delete the watcher. Try again.',
      );
    });
  });
}
