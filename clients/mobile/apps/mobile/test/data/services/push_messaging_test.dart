import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/push_messaging.dart';

void main() {
  test('fake emits foreground and opened messages on their streams', () async {
    final fake = FakePushMessaging();
    final foreground = <PushMessage>[];
    final opened = <PushMessage>[];
    final subA = fake.onForegroundMessage.listen(foreground.add);
    final subB = fake.onNotificationOpened.listen(opened.add);

    fake.emitForegroundMessage(
      const PushMessage(title: 'T', body: 'B', data: {'k': 'v'}),
    );
    fake.emitNotificationOpened(const PushMessage(title: 'O'));
    await Future<void>.delayed(Duration.zero);

    expect(foreground, hasLength(1));
    expect(foreground.single.data, {'k': 'v'});
    expect(opened, hasLength(1));
    expect(opened.single.title, 'O');
    await subA.cancel();
    await subB.cancel();
  });

  test('fake returns the initial message at most once', () async {
    final fake = FakePushMessaging()
      ..initialMessage = const PushMessage(title: 'launch');
    expect((await fake.getInitialMessage())?.title, 'launch');
    expect(await fake.getInitialMessage(), isNull);
  });

  group('foldPushSubtitle', () {
    test('leads the body with the iOS subtitle, matching Android', () {
      expect(
        foldPushSubtitle('Push notification copy', '1m 0s · 14 tool calls'),
        'Push notification copy\n1m 0s · 14 tool calls',
      );
    });

    test('keeps the body when there is no subtitle', () {
      expect(foldPushSubtitle(null, 'feature/push'), 'feature/push');
      expect(foldPushSubtitle('', 'feature/push'), 'feature/push');
    });

    test('uses the subtitle alone when the body is empty', () {
      expect(foldPushSubtitle('Task', null), 'Task');
      expect(foldPushSubtitle('Task', ''), 'Task');
    });
  });
}
