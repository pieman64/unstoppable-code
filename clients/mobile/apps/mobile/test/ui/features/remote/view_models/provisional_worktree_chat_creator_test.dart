import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/provisional_worktree_chat_creator.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-2',
  workspaceLocalId: 'ws-app',
  branch: 'canopy/otter',
);

/// One creator whose worktree and chat steps the test releases by hand.
final class _Harness {
  _Harness() {
    creator = ProvisionalWorktreeChatCreator(
      createWorktree: () {
        worktreeCalls++;
        return (worktree = Completer<RemoteWorktree>()).future.then(
          (created) =>
              (worktree: created, generation: reportedIn ??= generation),
        );
      },
      shownChatId: () => shown,
      createChat: (_) {
        created++;
        return shown = 'chat-a';
      },
      confirmChat: (created, chatId) {
        chatCalls.add(chatId);
        return (chat = Completer<bool>()).future;
      },
      isListed: (_, chatId) => listed.contains(chatId),
      firstMessageSent: () => sent,
      sessionGeneration: () => generation,
      timer: (delay, callback) {
        timers.add(callback);
        return Timer(const Duration(days: 1), () {});
      },
    )..startBatch();
  }

  late final ProvisionalWorktreeChatCreator creator;
  var generation = 1;
  var worktreeCalls = 0;
  var created = 0;
  final chatCalls = <String>[];
  Completer<RemoteWorktree>? worktree;
  Completer<bool>? chat;

  /// The pairing that reported the worktree, once one did.
  int? reportedIn;
  String? shown;
  final listed = <String>{};
  var sent = false;

  /// Callbacks the creator scheduled, run only by [runTimers].
  final timers = <void Function()>[];

  void runTimers() {
    final due = List.of(timers);
    timers.clear();
    for (final callback in due) {
      callback();
    }
  }

  /// Starts a preparation and records how it settles.
  ({List<Object> errors, List<bool> done}) start() {
    final errors = <Object>[];
    final done = <bool>[];
    unawaited(
      creator.ensureCreated().then(
        (_) => done.add(true),
        onError: (Object error) => errors.add(error),
      ),
    );
    return (errors: errors, done: done);
  }

  /// Prepares chat-a in this pairing: the worktree, then its listing.
  Future<void> prepareA({bool listedA = true}) async {
    start();
    await turn();
    worktree?.complete(_worktree);
    await turn();
    chat!.complete(listedA);
    if (listedA) listed.add('chat-a');
    await turn();
    runTimers();
  }

  /// The pairing is replaced; the new one lists [chats].
  void replace(Set<String> chats) {
    generation += 1;
    listed
      ..clear()
      ..addAll(chats);
  }

  /// A Retry in a pairing whose worktree is already known.
  Future<({List<Object> errors, List<bool> done})> retry() async {
    final run = start();
    await turn();
    worktree?.complete(_worktree);
    await turn();
    runTimers();
    return run;
  }
}

/// Lets microtasks and zero-delay timers run.
Future<void> turn() => Future<void>.delayed(Duration.zero);

/// Lets pending microtasks run, but no timers.
Future<void> microtasks() async {
  for (var i = 0; i < 10; i++) {
    await Future<void>.value();
  }
}

void main() {
  test(
    'completes only once the worktree exists and its chat is listed',
    () async {
      final h = _Harness();
      final run = h.start();
      await turn();
      expect(h.worktreeCalls, 1);
      expect(h.chatCalls, isEmpty);
      expect(run.done, isEmpty);

      h.worktree!.complete(_worktree);
      await turn();
      expect(h.chatCalls, ['chat-a']);
      expect(run.done, isEmpty);

      h.chat!.complete(true);
      await turn();
      expect(run.done, [true]);
      expect(run.errors, isEmpty);
    },
  );

  test('concurrent uploads share one preparation', () async {
    final h = _Harness();
    final first = h.start();
    final second = h.start();
    await turn();
    h.worktree!.complete(_worktree);
    await turn();
    h.chat!.complete(true);
    await turn();
    expect(h.worktreeCalls, 1);
    expect(h.chatCalls, hasLength(1));
    expect(first.done, [true]);
    expect(second.done, [true]);
  });

  // Each sequence fails one step. An upload queued behind the failed one
  // asks before the event loop turns again and shares the failure; only a
  // later Retry starts over.
  final failures = <String, List<void Function(_Harness h)>>{
    'worktree rejected': [
      (h) => h.worktree!.completeError(const RemoteControlException('no')),
    ],
    'chat rejected': [
      (h) => h.worktree!.complete(_worktree),
      (h) => h.chat!.complete(false),
    ],
    'chat transport failure': [
      (h) => h.worktree!.complete(_worktree),
      (h) => h.chat!.completeError(const RemoteControlException('offline')),
    ],
    'session replaced while the worktree is created': [
      (h) => h
        ..generation += 1
        ..worktree!.complete(_worktree),
    ],
    'session replaced while the chat is created': [
      (h) => h.worktree!.complete(_worktree),
      (h) => h
        ..generation += 1
        ..chat!.complete(true),
    ],
  };
  for (final MapEntry(key: name, value: steps) in failures.entries) {
    test(
      '$name: queued uploads share the failure, Retry starts over',
      () async {
        final h = _Harness();
        final run = h.start();
        await turn();
        for (final step in steps) {
          step(h);
          await microtasks();
        }
        expect(run.errors.single, isA<RemoteControlException>());
        expect(run.done, isEmpty);
        final worktreeCalls = h.worktreeCalls;
        final chatCalls = h.chatCalls.length;

        final queued = h.start();
        await microtasks();
        expect(queued.errors.single, same(run.errors.single));
        expect(h.worktreeCalls, worktreeCalls);
        expect(h.chatCalls, hasLength(chatCalls));

        // Until the scheduled clear runs, even a later upload shares it.
        await turn();
        final late = h.start();
        await microtasks();
        expect(late.errors.single, same(run.errors.single));
        expect(h.worktreeCalls, worktreeCalls);

        // Retry in the pairing that owns the files starts over.
        h
          ..runTimers()
          ..reportedIn = null;
        final retry = h.start();
        await turn();
        expect(h.worktreeCalls, worktreeCalls + 1);
        h.worktree!.complete(_worktree);
        await turn();
        h.chat!.complete(true);
        await turn();
        expect(retry.done, [true]);
      },
    );
  }

  test('disposal stops the preparation before it creates a chat', () async {
    final h = _Harness();
    final run = h.start();
    await turn();
    h.creator.dispose();
    h.worktree!.complete(_worktree);
    await turn();
    expect(h.chatCalls, isEmpty);
    expect(run.errors.single, isA<RemoteControlException>());
  });

  test('a disposed creator prepares nothing', () async {
    final h = _Harness()..creator.dispose();
    final run = h.start();
    await turn();
    expect(h.worktreeCalls, 0);
    expect(run.errors.single, isA<RemoteControlException>());
  });

  test('a later upload checks the worktree and chat again', () async {
    final h = _Harness();
    await h.prepareA();

    final next = h.start();
    await turn();
    expect(h.worktreeCalls, 2);
    h.worktree!.complete(_worktree);
    await turn();
    expect(h.chatCalls, ['chat-a', 'chat-a']);
    h.chat!.complete(true);
    await turn();
    expect(next.done, [true]);
    expect(h.created, 1);
  });

  // A replaced pairing may list another chat of the same worktree. The
  // files stay with the chat their own pairing chose, through any number of
  // refused Retries, and go to it once the current pairing lists it.
  test('a replacement holds the files for the chat chosen for them', () async {
    final h = _Harness();
    expect(h.creator.heldChatId, isNull);
    await h.prepareA();
    expect(h.creator.heldChatId, isNull);

    for (var i = 0; i < 2; i++) {
      h
        ..replace({'chat-b'})
        ..shown = 'chat-b';
      expect(h.creator.heldChatId, 'chat-a');
      final refused = await h.retry();
      expect(refused.errors.single, isA<RemoteControlException>());
      h.shown = 'chat-a';
      final unlisted = await h.retry();
      expect(unlisted.errors.single, isA<RemoteControlException>());
    }
    expect(h.chatCalls, ['chat-a']);

    h.listed.add('chat-a');
    final retry = await h.retry();
    expect(retry.done, [true]);
    expect(h.chatCalls, ['chat-a']);
    expect(h.created, 1);

    h.sent = true;
    expect(h.creator.heldChatId, isNull);
  });

  // Review finding P1: a rejected first chat leaves no chat for the files,
  // so a replacement's other chat never becomes their target.
  for (final failure in ['rejected', 'transport failure']) {
    test(
      'a $failure first chat holds the files from any replacement',
      () async {
        final h = _Harness();
        final run = h.start();
        await turn();
        h.worktree!.complete(_worktree);
        await turn();
        if (failure == 'rejected') {
          h.chat!.complete(false);
        } else {
          h.chat!.completeError(const RemoteControlException('offline'));
        }
        h.shown = null;
        await turn();
        h.runTimers();
        expect(run.errors.single, isA<RemoteControlException>());

        for (var i = 0; i < 2; i++) {
          h
            ..replace({'chat-b'})
            ..shown = 'chat-b';
          expect(h.creator.heldChatId, isNull);
          final refused = await h.retry();
          expect(refused.errors.single, isA<RemoteControlException>());
        }
        expect(h.chatCalls, ['chat-a']);
        expect(h.created, 1);

        // A new batch in this pairing goes to the chat shown here.
        h.creator.startBatch();
        final next = await h.retry();
        expect(next.done, [true]);
        expect(h.chatCalls, ['chat-a']);
      },
    );
  }

  test('a first chat rejected in its own pairing is replaced there', () async {
    final h = _Harness();
    await h.prepareA(listedA: false);
    h.shown = null;
    final retry = h.start();
    await turn();
    h.worktree!.complete(_worktree);
    await turn();
    expect(h.created, 2);
    h.chat!.complete(true);
    await turn();
    expect(retry.done, [true]);
  });

  test('a chat unconfirmed before a replacement holds the files', () async {
    final h = _Harness();
    final run = h.start();
    await turn();
    h.worktree!.complete(_worktree);
    await turn();
    h.replace({});
    h.chat!.complete(false);
    await turn();
    h.runTimers();
    expect(run.errors.single, isA<RemoteControlException>());
    expect(h.creator.heldChatId, 'chat-a');

    final refused = await h.retry();
    expect(refused.errors.single, isA<RemoteControlException>());
    h.listed.add('chat-a');
    final retry = await h.retry();
    expect(retry.done, [true]);
    expect(h.chatCalls, ['chat-a']);
  });

  test('a replacement that created the worktree prepares its chat', () async {
    final h = _Harness();
    final run = h.start();
    await turn();
    h.worktree!.completeError(const RemoteControlException('no'));
    await turn();
    h.runTimers();
    expect(run.errors.single, isA<RemoteControlException>());

    h.replace({});
    final retry = h.start();
    await turn();
    h.worktree!.complete(_worktree);
    await turn();
    h.chat!.complete(true);
    await turn();
    expect(retry.done, [true]);
    expect(h.reportedIn, h.generation);
    expect(h.chatCalls, ['chat-a']);
  });

  // Review finding: files belong to the pairing and chat shown when they
  // are staged, even when an earlier removed file's preparation or upload
  // delays their own preparation past a replacement.
  for (final late in [false, true]) {
    test('a batch staged before a replacement stays with its chat '
        '(late completion: $late)', () async {
      final h = _Harness();
      final old = h.start();
      await turn();
      h.worktree!.complete(_worktree);
      await turn();
      if (!late) {
        h.chat!.complete(true);
        h.listed.add('chat-a');
        await turn();
      }
      h.creator.startBatch();
      if (late) {
        h.chat!.complete(true);
        h.listed.add('chat-a');
        await turn();
      }
      expect(old.done, [true]);

      h
        ..replace({'chat-b'})
        ..shown = 'chat-b';
      expect(h.creator.heldChatId, 'chat-a');
      final refused = await h.retry();
      expect(refused.errors.single, isA<RemoteControlException>());
      h.shown = 'chat-a';
      final unlisted = await h.retry();
      expect(unlisted.errors.single, isA<RemoteControlException>());

      h.listed.add('chat-a');
      final retry = await h.retry();
      expect(retry.done, [true]);
      expect(h.chatCalls, ['chat-a']);
      expect(h.created, 1);
    });
  }

  // Review finding P2: files removed before a replacement leave nothing
  // behind; a batch staged after it goes to the chat chosen there, even when
  // the removed files' preparation completes late.
  for (final late in [false, true]) {
    test(
      'a batch staged after a replacement is not held (late completion: $late)',
      () async {
        final h = _Harness();
        final old = h.start();
        await turn();
        h.worktree!.complete(_worktree);
        await turn();
        if (!late) {
          h.chat!.complete(true);
          h.listed.add('chat-a');
          await turn();
          expect(old.done, [true]);
        }
        h
          ..replace({'chat-b'})
          ..shown = 'chat-b'
          ..creator.startBatch();
        if (late) {
          h.chat!.complete(true);
          await turn();
          expect(old.errors.single, isA<RemoteControlException>());
        }
        expect(h.creator.heldChatId, isNull);
        final next = await h.retry();
        expect(next.done, [true]);

        // That batch now belongs to this pairing and its chat.
        h
          ..replace({'chat-c'})
          ..shown = 'chat-c';
        expect(h.creator.heldChatId, 'chat-b');
        final refused = await h.retry();
        expect(refused.errors.single, isA<RemoteControlException>());
      },
    );
  }

  // A chat its own pairing refused takes no batch staged for it, even a
  // batch staged after the refused preparation started.
  test('a late refusal leaves the next batch no chat', () async {
    final h = _Harness();
    final old = h.start();
    await turn();
    h.worktree!.complete(_worktree);
    await turn();
    h.creator.startBatch();
    h.chat!.complete(false);
    await turn();
    h.runTimers();
    expect(old.errors.single, isA<RemoteControlException>());

    h
      ..replace({'chat-a', 'chat-b'})
      ..shown = 'chat-a';
    expect(h.creator.heldChatId, isNull);
    final refused = await h.retry();
    expect(refused.errors.single, isA<RemoteControlException>());

    h
      ..shown = 'chat-b'
      ..creator.startBatch();
    final next = await h.retry();
    expect(next.done, [true]);
  });

  test(
    'a removed batch whose preparation chooses late holds nothing',
    () async {
      final h = _Harness();
      final old = h.start();
      await turn();
      h.creator.startBatch();
      h.worktree!.complete(_worktree);
      await turn();
      expect(h.chatCalls, ['chat-a']);

      h
        ..replace({'chat-b'})
        ..shown = 'chat-b';
      expect(h.creator.heldChatId, isNull);
      h.chat!.complete(false);
      await turn();
      expect(old.errors.single, isA<RemoteControlException>());
      // The batch was staged in the earlier pairing, before any chat.
      final refused = await h.retry();
      expect(refused.errors.single, isA<RemoteControlException>());

      h.creator.startBatch();
      final next = await h.retry();
      expect(next.done, [true]);
    },
  );

  test('after the first message, files go to the chat shown', () async {
    final h = _Harness();
    await h.prepareA();
    h
      ..sent = true
      ..replace({'chat-b'})
      ..shown = 'chat-b';
    expect(h.creator.heldChatId, isNull);
    final retry = await h.retry();
    expect(retry.done, [true]);
    h.shown = 'chat-a';
    final unlisted = await h.retry();
    expect(unlisted.errors.single, isA<RemoteControlException>());
  });

  // Seeded event orders over failure, removal, replacement, late results,
  // explicit selection and the first send. A batch belongs to the pairing
  // and chat shown when it is staged, including a replacement before its
  // first preparation. Every successful preparation is for the chat shown,
  // listed in the current pairing; before the first send, a batch from an
  // earlier pairing succeeds only for the chat its pairing chose and did
  // not refuse. A preparation that should succeed at once does.
  test('seeded orders keep files with their own chat', () async {
    for (var seed = 0; seed < 2000; seed++) {
      await _World(seed).run(steps: 14);
    }
  });

  // Review finding: a batch staged in an earlier pairing reaches its first
  // preparation only after a replacement listing another chat: seed 757
  // before any preparation, seed 1253 after a new batch in the first chat.
  for (final seed in [757, 1253]) {
    test('seed $seed keeps a batch staged before a replacement', () async {
      await _World(seed).run(steps: 14);
    });
  }
}

enum _Event {
  prepare,
  report,
  confirm,
  reject,
  replace,
  listA,
  listB,
  showA,
  showB,
}

/// Additional events, rarer so that sequences reach replacements.
enum _RareEvent { newBatch, send }

/// One seeded sequence against a creator whose worktree is reported by the
/// pairing current at the report event, with an oracle of what each pairing
/// chose.
final class _World {
  _World(this.seed) : _random = Random(seed);

  final int seed;
  final Random _random;
  final log = <String>[];

  var generation = 1;

  /// The pairing that reported the worktree, once one did.
  int? reportedIn;
  final worktree = Completer<void>();
  final listed = <String>{};
  String? shown;
  String? lastMinted;
  var minted = 0;
  var sent = false;
  ({String chatId, int generation, Completer<bool> result})? pending;

  int batch = 0;

  /// The pairing current when the batch was staged.
  var batchGeneration = 1;

  /// The chat the batch's own pairing chose and did not refuse, starting
  /// with the chat shown when it was staged.
  String? owned;

  /// The batch each preparation started for, by the worktree it received.
  final _preparedBatch = Map<RemoteWorktree, int>.identity();

  late final creator = ProvisionalWorktreeChatCreator(
    createWorktree: () async {
      final created = RemoteWorktree(
        localId: _worktree.localId,
        workspaceLocalId: _worktree.workspaceLocalId,
        branch: _worktree.branch,
      );
      _preparedBatch[created] = batch;
      if (reportedIn == null) await worktree.future;
      return (worktree: created, generation: reportedIn!);
    },
    shownChatId: () => shown,
    createChat: (_) {
      final chatId = lastMinted = shown = 'chat-a${++minted}';
      return chatId;
    },
    confirmChat: (created, chatId) {
      // The pairing that reported the worktree chooses the current batch's
      // chat, taking it over from an earlier pairing that had none.
      if (_preparedBatch[created] == batch) {
        batchGeneration = generation;
        owned = chatId;
      }
      if (listed.contains(chatId)) return Future.value(true);
      final current = pending;
      if (current != null && current.chatId == chatId) {
        return current.result.future;
      }
      final result = Completer<bool>();
      pending = (chatId: chatId, generation: generation, result: result);
      return result.future;
    },
    isListed: (_, chatId) => listed.contains(chatId),
    firstMessageSent: () => sent,
    sessionGeneration: () => generation,
    timer: (delay, callback) {
      scheduleMicrotask(callback);
      return Timer(const Duration(days: 1), () {});
    },
  );

  String get _trace => 'seed $seed: ${log.join(', ')}';

  Future<void> run({required int steps}) async {
    creator.startBatch();
    for (var i = 0; i < steps; i++) {
      if (_random.nextInt(4) == 0) {
        await _apply(
          _RareEvent.values[_random.nextInt(_RareEvent.values.length)],
        );
      } else {
        await _apply(_Event.values[_random.nextInt(_Event.values.length)]);
      }
      await microtasks();
    }
  }

  Future<void> _apply(Enum event) async {
    log.add(event.name);
    switch (event) {
      case _Event.prepare:
        _prepare();
      case _Event.report:
        if (reportedIn == null) {
          reportedIn = generation;
          worktree.complete();
        }
      case _Event.confirm:
        if (pending case final current?) {
          pending = null;
          if (current.generation == generation) listed.add(current.chatId);
          current.result.complete(true);
        }
      case _Event.reject:
        if (pending case final current?) {
          pending = null;
          if (current.generation == batchGeneration &&
              current.generation == generation &&
              owned == current.chatId) {
            owned = null;
          }
          if (shown == current.chatId) shown = null;
          current.result.complete(false);
        }
      case _Event.replace:
        generation++;
        listed.clear();
        final current = pending;
        pending = null;
        current?.result.complete(false);
      case _Event.listA:
        if (lastMinted case final chatId?) listed.add(chatId);
      case _Event.listB:
        listed.add('chat-b');
      case _Event.showA:
        shown = lastMinted ?? shown;
      case _Event.showB:
        shown = 'chat-b';
      case _RareEvent.newBatch:
        creator.startBatch();
        batch++;
        batchGeneration = generation;
        owned = shown;
      case _RareEvent.send:
        sent = true;
    }
  }

  void _prepare() {
    final startedIn = generation;
    final startedBatch = batch;
    final chatId = shown;
    final immediate =
        reportedIn != null &&
        pending == null &&
        chatId != null &&
        listed.contains(chatId) &&
        (sent ||
            batchGeneration == generation ||
            (chatId == owned && owned != null));
    var settled = false;
    unawaited(
      creator.ensureCreated().then(
        (_) {
          settled = true;
          if (startedBatch != batch) return;
          final target = shown;
          if (!sent && batchGeneration != generation) {
            expect(target, owned, reason: 'held elsewhere; $_trace');
          }
          if (generation != reportedIn) {
            expect(listed, contains(target), reason: _trace);
          }
          // A pairing that did not report the worktree chooses the listed
          // chat shown, unconfirmed.
          if (generation == batchGeneration && generation != reportedIn) {
            owned = target;
          }
        },
        onError: (Object error) {
          settled = true;
          expect(error, isA<RemoteControlException>(), reason: _trace);
          expect(
            immediate && startedIn == generation && startedBatch == batch,
            isFalse,
            reason: 'refused a listed own chat; $_trace',
          );
        },
      ),
    );
    if (immediate) {
      unawaited(
        microtasks().then((_) {
          if (startedIn == generation && startedBatch == batch) {
            expect(settled, isTrue, reason: 'still waiting; $_trace');
          }
        }),
      );
    }
  }
}
