import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';

void main() {
  const a = RemoteStandaloneChatDraftTarget('a');
  const b = RemoteStandaloneChatDraftTarget('b');

  late TextEditingController controller;
  late InMemoryChatDraftStore store;
  late ComposerDraftBinding binding;

  setUp(() {
    controller = TextEditingController();
    store = InMemoryChatDraftStore();
    binding = ComposerDraftBinding(controller: controller, store: store);
  });
  tearDown(() {
    binding.dispose();
    controller.dispose();
  });

  test('typing saves under the bound target', () {
    binding.bind(a);
    controller.text = 'hello';
    expect(store.draftFor(a), 'hello');
  });

  test('bind loads the target text with the cursor at the end', () {
    store.setDraft(b, 'saved');
    binding.bind(b);
    expect(controller.text, 'saved');
    expect(controller.selection, const TextSelection.collapsed(offset: 5));
  });

  test('bind does not leak text across targets', () {
    binding.bind(a);
    controller.text = 'for a';
    binding.bind(b);
    expect(controller.text, '');
    expect(store.draftFor(a), 'for a');
    expect(store.draftFor(b), '');
    controller.text = 'for b';
    expect(store.draftFor(a), 'for a');
    expect(store.draftFor(b), 'for b');
  });

  test('bind(null) detaches so a programmatic clear keeps the draft', () {
    binding.bind(a);
    controller.text = 'keep me';
    binding.bind(null);
    controller.clear();
    expect(store.draftFor(a), 'keep me');
  });

  test('adopt keeps text typed while unbound when the target is empty', () {
    controller.text = 'typed early';
    binding.adopt(a);
    expect(controller.text, 'typed early');
    expect(store.draftFor(a), 'typed early');
    controller.text = 'typed early, more';
    expect(store.draftFor(a), 'typed early, more');
  });

  test('adopt keeps both a saved draft and text typed while unbound', () {
    store.setDraft(a, 'saved');
    controller.text = 'typed';
    binding.adopt(a);
    expect(controller.text, 'saved\ntyped');
    expect(store.draftFor(a), 'saved\ntyped');
  });

  test('returning to a retained source keeps the carried draft once', () {
    binding.bind(a);
    controller.text = 'hello';
    final release = binding.retainForHandoff();
    binding.adopt(a, returningFrom: release);
    expect(controller.text, 'hello');
    expect(store.draftFor(a), 'hello');
    release();
    expect(store.draftFor(a), 'hello');
  });

  test('adopt from another target behaves like bind', () {
    binding.bind(a);
    controller.text = 'for a';
    binding.adopt(b);
    expect(controller.text, '');
    expect(store.draftFor(a), 'for a');
  });

  test('rebind moves the draft without changing the text', () {
    binding.bind(a);
    controller.text = 'moving';
    binding.rebind(b);
    expect(controller.text, 'moving');
    expect(store.draftFor(a), '');
    expect(store.draftFor(b), 'moving');
    expect(binding.target, b);
  });

  test('clearing the composer after a send removes the draft', () {
    binding.bind(a);
    controller.text = 'sent';
    controller.clear();
    expect(store.draftFor(a), '');
  });

  test('handoff keeps the saved source until acknowledged after disposal', () {
    binding.bind(a);
    controller.text = 'keep until stored';
    final release = binding.retainForHandoff();
    expect(binding.target, isNull);
    expect(store.draftFor(a), 'keep until stored');
    controller.clear();
    expect(store.draftFor(a), 'keep until stored');
    release();
    expect(store.draftFor(a), isEmpty);
  });

  test('late handoff acknowledgement preserves a newer source edit', () {
    binding.bind(a);
    controller.text = 'old';
    final release = binding.retainForHandoff();
    store.setDraft(a, 'new');
    release();
    expect(store.draftFor(a), 'new');
  });

  group('ComposerDraftBinding.release (CAN-2932)', () {
    test('forgets the saved draft and keeps the text on screen', () {
      final store = InMemoryChatDraftStore();
      final controller = TextEditingController();
      final binding = ComposerDraftBinding(
        controller: controller,
        store: store,
      );
      const target = RemoteNewChatDraftTarget('ws-1');
      binding.bind(target);
      controller.text = 'carry me';
      expect(store.draftFor(target), 'carry me');

      binding.release();
      controller.text = 'carry me further';

      expect(binding.target, isNull);
      expect(store.draftFor(target), '');
      expect(controller.text, 'carry me further');
      binding.dispose();
      controller.dispose();
    });
  });
}
