import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/composer_overrides_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_draft_first_send.dart';

void main() {
  test(
    'failure releases navigation and retry retains options until enqueue',
    () {
      const options = RemoteChatSendOptions(model: 'codex', fastMode: true);
      final pending = <bool>[];
      var enqueued = 0;
      final first = RemoteDraftFirstSend(options, () => enqueued++)
        ..onPendingChanged = pending.add;
      first.begin();
      first.didFail();
      expect(pending, [true, false]);
      expect(first.options, same(options));
      first.begin();
      first.didEnqueue();
      expect(pending, [true, false, true, false]);
      expect(first.options, isNull);
      expect(enqueued, 1);
      first.begin();
      first.didFail();
      expect(pending, [true, false, true, false]);
    },
  );

  test('accepted edits replace only their retained composer fields', () {
    final first = RemoteDraftFirstSend(
      const RemoteChatSendOptions(
        model: 'gpt-5-codex',
        providerType: 'codex',
        planMode: true,
        thinkingLevel: 'high',
        fastMode: true,
        inputMode: 'voice',
      ),
    );
    first.didFail();
    first.didChange(ComposerField.thinkingLevel, 'medium');
    expect(first.options?.thinkingLevel, 'medium');
    expect(first.options?.model, 'gpt-5-codex');
    expect(first.options?.fastMode, isTrue);
    expect(first.options?.planMode, isTrue);
    expect(first.options?.inputMode, 'voice');
    first.didChange(ComposerField.fastMode, false);
    first.didChange(ComposerField.planMode, false);
    expect(first.options?.fastMode, isFalse);
    expect(first.options?.planMode, isFalse);
    first.didChange(
      ComposerField.model,
      'claude-sonnet',
      providerType: 'claude',
    );
    expect(first.options?.model, 'claude-sonnet');
    expect(first.options?.providerType, 'claude');
    expect(first.options?.thinkingLevel, 'medium');
    expect(first.options?.inputMode, 'voice');
    first.didEnqueue();
    first.didChange(ComposerField.fastMode, true);
    expect(first.options, isNull);
  });

  testWidgets(
    'readiness is rechecked before sending and the draft stays pending',
    (tester) async {
      var ready = true;
      var sends = 0;
      final first = RemoteDraftFirstSend();
      first.sendWhenReady(ready: () => ready, send: () => sends++);
      ready = false;
      tester.binding.scheduleFrame();
      await tester.pump();
      expect(sends, 0);
      ready = true;
      first.sendWhenReady(ready: () => ready, send: () => sends++);
      first.sendWhenReady(ready: () => ready, send: () => sends++);
      tester.binding.scheduleFrame();
      await tester.pump();
      expect(sends, 1);
      first.dispose();
    },
  );

  testWidgets('a manual enqueue cancels a scheduled automatic send', (
    tester,
  ) async {
    var sends = 0;
    final first = RemoteDraftFirstSend();
    first.sendWhenReady(ready: () => true, send: () => sends++);
    first.didEnqueue();
    tester.binding.scheduleFrame();
    await tester.pump();
    expect(sends, 0);
    first.dispose();
  });

  testWidgets('disposal releases navigation and cancels scheduled sending', (
    tester,
  ) async {
    final pending = <bool>[];
    var sends = 0;
    var enqueued = 0;
    final first = RemoteDraftFirstSend(null, () => enqueued++)
      ..onPendingChanged = pending.add;
    first.begin();
    first.sendWhenReady(ready: () => true, send: () => sends++);
    first.dispose();
    tester.binding.scheduleFrame();
    await tester.pump();
    first.didEnqueue();
    expect(pending, [true, false]);
    expect(sends, 0);
    expect(enqueued, 0);
  });
}
