import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/services/chat_draft_store.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'package:mobile/ui/core/chat/view_models/new_chat_draft_carry.dart';

void main() {
  group('NewChatDraftCarry (CAN-2932)', () {
    test('hands the attached draft to the next taker once', () {
      final carry = NewChatDraftCarry();
      carry.attach(
        () => (text: 'Fix the bug', projectName: 'canopy', projectId: null),
      );

      carry.handOver(projectId: 'ws-7');

      expect(carry.take(), (
        text: 'Fix the bug',
        projectName: 'canopy',
        projectId: 'ws-7',
      ));
      expect(carry.take(), isNull);
    });

    test(
      'an empty draft with no project leaves the next destination free to restore',
      () {
        final carry = NewChatDraftCarry()
          ..attach(() => (text: '', projectName: null, projectId: null))
          ..handOver();
        expect(carry.take(), isNull);
      },
    );

    test('an explicit project pick survives an otherwise empty hand-over', () {
      final carry = NewChatDraftCarry()
        ..attach(() => (text: '', projectName: null, projectId: null))
        ..handOver(projectId: 'chosen-project');
      expect(carry.take()?.projectId, 'chosen-project');
    });

    test(
      'adoption stores the destination before releasing the source',
      () async {
        final carry = NewChatDraftCarry();
        final store = _ControlledDraftStore();
        const source = CloudNewChatDraftTarget('source');
        const destination = RemoteNewChatDraftTarget('destination');
        store.setDraft(source, 'keep');
        carry.preserveSource(ComposerDraftHandoff(source, 'keep', store));
        final controller = TextEditingController(text: 'keep');
        final drafts = ComposerDraftBinding(
          controller: controller,
          store: store,
        );
        addTearDown(controller.dispose);
        addTearDown(drafts.dispose);

        carry.adoptStored(drafts, destination, store);
        expect(drafts.target, destination);
        expect(store.draftFor(destination), 'keep');
        expect(store.draftFor(source), 'keep');
        expect(store.flushCalls, 1);
        carry.adoptStored(drafts, destination, store);
        expect(store.flushCalls, 1);

        store.stored.complete(true);
        await Future<void>.value();
        expect(store.draftFor(source), isEmpty);
      },
    );

    test('source release waits for destination persistence', () async {
      final carry = NewChatDraftCarry();
      final store = InMemoryChatDraftStore();
      const target = CloudNewChatDraftTarget('source');
      store.setDraft(target, 'keep');
      carry.preserveSource(ComposerDraftHandoff(target, 'keep', store));
      final stored = Completer<bool>();
      carry.confirmStored(stored.future);
      await Future<void>.value();
      expect(store.draftFor(target), 'keep');
      stored.complete(true);
      await Future<void>.value();
      expect(store.draftFor(target), isEmpty);
    });

    test(
      'failed destination persistence retains the source for retry',
      () async {
        final carry = NewChatDraftCarry();
        final store = InMemoryChatDraftStore();
        const target = CloudNewChatDraftTarget('source');
        store.setDraft(target, 'keep');
        carry.preserveSource(ComposerDraftHandoff(target, 'keep', store));
        carry.confirmStored(Future<bool>.error(StateError('write failed')));
        await Future<void>.value();
        expect(store.draftFor(target), 'keep');
        carry.confirmStored(Future<bool>.value(true));
        await Future<void>.value();
        expect(store.draftFor(target), isEmpty);
      },
    );

    test(
      'real failed file write keeps the source recoverable until retry',
      () async {
        final root = await Directory.systemTemp.createTemp('draft-handoff-');
        addTearDown(() => root.delete(recursive: true));
        final store = await FileChatDraftStore.open(
          directory: root,
          accountScope: 'test:handoff',
        );
        const source = RemoteNewChatDraftTarget('computer');
        const destination = CloudNewChatDraftTarget('cloud');
        store.setDraft(source, 'keep');
        await store.flush();
        final carry = NewChatDraftCarry()
          ..preserveSource(ComposerDraftHandoff(source, 'keep', store));
        final blocker = Directory(
          '${root.path}/chat-drafts/${chatDraftFileName('test:handoff')}.tmp',
        );
        await blocker.create();
        final controller = TextEditingController(text: 'keep');
        final drafts = ComposerDraftBinding(
          controller: controller,
          store: store,
        );
        addTearDown(controller.dispose);
        addTearDown(drafts.dispose);
        carry.adoptStored(drafts, destination, store);
        await store.flush();
        await Future<void>.delayed(Duration.zero);
        expect(store.lastWriteError, isNotNull);
        expect(store.draftFor(source), 'keep');
        final reopened = await FileChatDraftStore.open(
          directory: root,
          accountScope: 'test:handoff',
        );
        expect(reopened.draftFor(source), 'keep');
        expect(reopened.draftFor(destination), isEmpty);

        await blocker.delete();
        carry.confirmStored(store.flush());
        await store.flush();
        await Future<void>.delayed(Duration.zero);
        expect(store.lastWriteError, isNull);
        expect(store.draftFor(source), isEmpty);
        await store.flush();
        final recovered = await FileChatDraftStore.open(
          directory: root,
          accountScope: 'test:handoff',
        );
        expect(recovered.draftFor(destination), 'keep');
        expect(recovered.draftFor(source), isEmpty);
      },
    );

    for (final source in [
      const CloudNewChatDraftTarget('cloud'),
      const RemoteNewChatDraftTarget('computer'),
    ]) {
      for (final carriedText in ['hello', 'hello again', '']) {
        test(
          'round trip to $source preserves text, carried=$carriedText',
          () async {
            final store = InMemoryChatDraftStore();
            final controller = TextEditingController();
            final binding = ComposerDraftBinding(
              controller: controller,
              store: store,
            );
            final carry = NewChatDraftCarry();
            binding.bind(source);
            controller.text = 'hello';
            carry.preserveSource(binding.retainForHandoff());
            // The intervening destination has no matching project and cannot adopt.
            controller.text = carriedText;
            carry.adopt(binding, source);
            carry.confirmStored(store.flush());
            await Future<void>.value();
            expect(controller.text, carriedText);
            expect(store.draftFor(source), controller.text);
            binding.dispose();
            controller.dispose();
          },
        );
      }
    }

    test(
      'returning to source cancels an acknowledgement already in flight',
      () async {
        final store = InMemoryChatDraftStore();
        final controller = TextEditingController();
        final binding = ComposerDraftBinding(
          controller: controller,
          store: store,
        );
        const source = CloudNewChatDraftTarget('cloud');
        final carry = NewChatDraftCarry();
        binding.bind(source);
        controller.text = 'hello';
        carry.preserveSource(binding.retainForHandoff());
        final flush = Completer<bool>();
        carry.confirmStored(flush.future);
        carry.adopt(binding, source);
        flush.complete(true);
        await Future<void>.value();
        expect(controller.text, 'hello');
        expect(store.draftFor(source), 'hello');
        binding.dispose();
        controller.dispose();
      },
    );

    test('carries nothing once its screen detached', () {
      final carry = NewChatDraftCarry();
      CarriedDraft release() =>
          (text: 'gone', projectName: null, projectId: null);
      carry
        ..attach(release)
        ..detach(release)
        ..handOver();

      expect(carry.take(), isNull);
    });

    test('a stale detach leaves the newer screen attached', () {
      final carry = NewChatDraftCarry();
      CarriedDraft older() =>
          (text: 'older', projectName: null, projectId: null);
      CarriedDraft newer() =>
          (text: 'newer', projectName: null, projectId: null);
      carry
        ..attach(older)
        ..attach(newer)
        ..detach(older)
        ..handOver();

      expect(carry.take()?.text, 'newer');
    });
  });
}

final class _ControlledDraftStore extends ChatDraftStateStore {
  final stored = Completer<bool>();
  int flushCalls = 0;

  @override
  Future<bool> flush() {
    flushCalls++;
    return stored.future;
  }
}
