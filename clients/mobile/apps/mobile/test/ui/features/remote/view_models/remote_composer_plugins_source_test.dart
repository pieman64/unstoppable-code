// Deterministic and seeded sequences for a Remote Control plugins sheet:
// the chat it loaded closes or the session changes before a save, and a
// sheet reopens while an earlier save waits for the desktop.
import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_composer_commands.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';
import 'package:mobile/ui/features/remote/view_models/composer_overrides_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_tabs_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_chat_resolver.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_plugins_source.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'main',
);

Map<String, Object?> _selection(List<String> collections) => {
  'collectionIds': collections,
  'skillRefs': <Object?>[],
  'pluginRefs': <Object?>[],
};

/// One plugin selection the desktop has not answered yet.
typedef _Write = ({
  String? chatId,
  Map<String, Object?> value,
  void Function(int completedAt) complete,
  void Function() reject,
});

final class _Harness {
  _Harness() {
    tabs = RemoteChatTabsController(
      createTab: (target, {required onFailed}) {
        creates.add(target);
        rejectCreate = onFailed;
        return Future.value('create-${creates.length}');
      },
      closeTab: (target, {required onFailed}) => Future.value('close'),
      mintChatId: () => 'chat-m${creates.length + 1}',
      sessionGeneration: () => generation,
      onChanged: () {},
      onCreateFailed: (_) {},
    );
    overrides = ComposerOverridesController(
      submit:
          (target, field, value, {required onCompleted, required onFailed}) {
            writes.add((
              chatId: target.chatId,
              value: value as Map<String, Object?>,
              complete: onCompleted,
              reject: onFailed,
            ));
            return Future.value('set-${writes.length}');
          },
      sessionGeneration: () => generation,
      projectionSequence: (target) => sequences[target.chatId],
      onChanged: () {},
    );
    final resolver = RemoteComposerChatResolver(
      tabs: tabs,
      overrides: overrides,
      shownChatId: () => tabs.chatIdFor(tabs.rowsFor(projected, _worktree)),
    );
    source = remoteComposerPluginsSource(
      commands: RemoteComposerCommands(
        sessionId: () => 'session-1',
        supportsInvocableInventory: () => false,
        submit: ({required type, required target, required payload}) =>
            throw UnimplementedError(),
      ),
      overrides: overrides,
      chats: resolver,
      worktree: _worktree,
      chatId: null,
      providerType: (id) => providers[id],
      summary: (id) {
        for (final summary in projected) {
          if (summary.chatId == id) return summary;
        }
        return null;
      },
    );
  }

  late final RemoteChatTabsController tabs;
  late final ComposerOverridesController overrides;
  late final ComposerPluginsSource source;
  final creates = <RemoteWorktreeChatTarget>[];
  final writes = <_Write>[];
  final sequences = <String?, int>{};

  /// Each chat's effective provider, as the view resolves it.
  final providers = <String, String>{};
  void Function()? rejectCreate;
  var generation = 1;
  var projected = <RemoteChatSummary>[];

  /// The desktop lists [chats] with their selections; the first is active.
  void project(Map<String, List<String>> chats, {int? sequence}) {
    projected = [
      for (final (index, MapEntry(:key, :value)) in chats.entries.indexed)
        RemoteChatSummary(
          chatId: key,
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat $key',
          active: index == 0,
          pluginSelectionsDetail: _selection(value),
        ),
    ];
    if (sequence != null) {
      for (final chatId in chats.keys) {
        sequences[chatId] = sequence;
      }
    }
    tabs.sync(projected: projected, worktree: _worktree);
    overrides.sync();
  }

  /// A new session: pending work of the old one is discarded.
  void replaceSession() {
    generation++;
    tabs.sync(projected: projected, worktree: _worktree);
    overrides.sync();
  }

  Future<Map<String, Object?>> load() => source.loadSelections();

  /// Starts a save and records how it ends.
  List<Object?> save(Map<String, Object?> selections) {
    final outcome = <Object?>[];
    unawaited(source.save(selections).then(outcome.add, onError: outcome.add));
    return outcome;
  }
}

/// A standalone chat's plugins sheet over a desktop with the invocable
/// inventory (CAN-3925).
final class _StandaloneHarness {
  _StandaloneHarness() {
    overrides = ComposerOverridesController(
      submit:
          (target, field, value, {required onCompleted, required onFailed}) {
            targets.add(target);
            writes.add((
              chatId: target.chatId,
              value: value as Map<String, Object?>,
              complete: onCompleted,
              reject: onFailed,
            ));
            return Future.value('set-${writes.length}');
          },
      sessionGeneration: () => generation,
      projectionSequence: (target) => sequences[target.chatId],
      onChanged: () {},
    );
    commands = RemoteComposerCommands(
      sessionId: () => 'session-$generation',
      supportsInvocableInventory: () => inventory,
      submit: ({required type, required target, required payload}) async {
        catalogCalls.add({'type': type, 'target': target, ...payload});
        return const RemotePortalCommandResult(
          commandId: 'catalog',
          result: {'plugins': <Object?>[]},
        );
      },
    );
  }

  late final ComposerOverridesController overrides;
  late final RemoteComposerCommands commands;
  final writes = <_Write>[];
  final targets = <RemoteChatTarget>[];
  final catalogCalls = <Map<String, Object?>>[];
  final sequences = <String?, int>{};
  var inventory = true;
  var generation = 1;
  RemoteStandaloneChat? chat;

  /// The desktop projects the chat with [collections], or without a
  /// selection when null.
  void project(List<String>? collections, {int? sequence}) {
    chat = RemoteStandaloneChat.fromJson({
      'localId': 'solo',
      'projectLocalId': 'notes',
      'title': 'Notes',
      'pluginSelectionsDetail': ?(collections == null
          ? null
          : _selection(collections)),
    });
    if (sequence != null) sequences['solo'] = sequence;
    overrides.sync();
  }

  void replaceSession() {
    generation++;
    overrides.sync();
  }

  /// The source the view builds now, as each open of the sheet reads it.
  ComposerPluginsSource? source() => remoteStandalonePluginsSource(
    commands: commands,
    overrides: overrides,
    chatId: 'solo',
    providerType: 'claude',
    standaloneChat: (id) => id == chat?.localId ? chat : null,
  );

  List<Object?> save(ComposerPluginsSource source, Map<String, Object?> value) {
    final outcome = <Object?>[];
    unawaited(source.save(value).then(outcome.add, onError: outcome.add));
    return outcome;
  }
}

void main() {
  group('a plugins sheet writes only to the chat it loaded', () {
    test('a closed chat rejects the save instead of writing to the chat '
        'shown next', () async {
      final harness = _Harness()
        ..project({
          'a': ['kit'],
          'b': [],
        });
      expect(await harness.load(), _selection(['kit']));

      harness.project({'b': []});
      final outcome = harness.save(_selection(['kit', 'more']));
      await pumpEventQueue();

      expect(harness.writes, isEmpty);
      expect(outcome.single, isA<RemoteControlException>());
    });

    test('another chat shown while the loaded one is still listed gets no '
        'write', () async {
      final harness = _Harness()
        ..project({
          'a': ['kit'],
          'b': [],
        });
      expect(await harness.load(), _selection(['kit']));

      harness.tabs.select('b');
      harness.save(_selection(['kit', 'more']));
      await pumpEventQueue();

      expect(harness.writes.single.chatId, 'a');
    });

    test('a replaced session rejects the save', () async {
      final harness = _Harness()
        ..project({
          'a': ['kit'],
        });
      expect(await harness.load(), _selection(['kit']));

      harness.replaceSession();
      final outcome = harness.save(_selection(['kit', 'more']));
      await pumpEventQueue();

      expect(harness.writes, isEmpty);
      expect(outcome.single, isA<RemoteControlException>());
    });

    test(
      'a first chat that fails to be created leaves nothing to save to',
      () async {
        final harness = _Harness();
        final load = harness.load();
        await pumpEventQueue();
        harness.rejectCreate!();
        await expectLater(load, throwsA(isA<RemoteControlException>()));

        final outcome = harness.save(_selection(['kit']));
        await pumpEventQueue();

        expect(harness.creates, hasLength(1));
        expect(harness.writes, isEmpty);
        expect(outcome.single, isA<RemoteControlException>());
      },
    );

    test('loading again reads and then writes the chat shown now', () async {
      final harness = _Harness()
        ..project({
          'a': ['kit'],
          'b': [],
        });
      await harness.load();
      harness.project({'b': []});

      expect(await harness.load(), _selection([]));
      harness.save(_selection(['more']));
      await pumpEventQueue();

      expect(harness.writes.single.chatId, 'b');
    });
  });

  group('a plugins sheet scopes plugins by the chat it loaded', () {
    test('a first chat is scoped by the provider of the chat the load '
        'created', () async {
      final harness = _Harness();
      expect(harness.source.providerType(), isNull);
      final load = harness.load();
      await pumpEventQueue();
      final chatId = harness.creates.single.chatId!;
      harness.providers[chatId] = 'codex';
      expect(harness.source.providerType(), isNull);

      harness.project({chatId: []});
      expect(await load, _selection([]));

      expect(harness.source.providerType(), 'codex');
    });

    test(
      'the loaded chat keeps the scope when another chat is shown',
      () async {
        final harness = _Harness()
          ..providers.addAll({'a': 'claude', 'b': 'codex'})
          ..project({'a': [], 'b': []});
        await harness.load();

        harness.tabs.select('b');

        expect(harness.source.providerType(), 'claude');
      },
    );
  });

  group('a reopened sheet loads after the pending save settles', () {
    for (final accepted in [true, false]) {
      test('${accepted ? 'an accepted' : 'a rejected'} removal', () async {
        final harness = _Harness()
          ..project({
            'a': ['kit'],
          });
        await harness.load();
        harness.save(_selection([]));
        await pumpEventQueue();

        Map<String, Object?>? reopened;
        unawaited(harness.load().then((value) => reopened = value));
        await pumpEventQueue();
        expect(reopened, isNull);

        final write = harness.writes.single;
        if (accepted) {
          write.complete(1);
        } else {
          write.reject();
        }
        await pumpEventQueue();

        expect(reopened, accepted ? _selection([]) : _selection(['kit']));
      });
    }

    test(
      'a newer save is awaited too, and an older answer is ignored',
      () async {
        final harness = _Harness()
          ..project({
            'a': ['kit'],
          });
        await harness.load();
        harness
          ..save(_selection([]))
          ..save(_selection(['kit', 'more']));
        await pumpEventQueue();

        Map<String, Object?>? reopened;
        unawaited(harness.load().then((value) => reopened = value));
        await pumpEventQueue();
        harness.writes.first.reject();
        await pumpEventQueue();
        expect(reopened, isNull);

        harness.writes.last.complete(1);
        await pumpEventQueue();
        expect(reopened, _selection(['kit', 'more']));
      },
    );

    test('a replaced session releases the wait with the projection', () async {
      final harness = _Harness()
        ..project({
          'a': ['kit'],
        });
      await harness.load();
      harness.save(_selection([]));
      await pumpEventQueue();

      Map<String, Object?>? reopened;
      unawaited(harness.load().then((value) => reopened = value));
      await pumpEventQueue();
      harness.replaceSession();
      await pumpEventQueue();

      expect(reopened, _selection(['kit']));
    });

    test('disposing the view releases the wait', () async {
      final harness = _Harness()
        ..project({
          'a': ['kit'],
        });
      await harness.load();
      harness.save(_selection([]));
      await pumpEventQueue();

      var done = false;
      unawaited(
        harness.load().then((_) => done = true, onError: (_) => done = true),
      );
      await pumpEventQueue();
      harness.overrides.dispose();
      await pumpEventQueue();

      expect(done, isTrue);
    });

    test('seeded sequences never load or extend a rejected choice', () async {
      for (var seed = 0; seed < 50; seed++) {
        final random = Random(seed);
        final harness = _Harness()
          ..project({
            'a': ['kit'],
          }, sequence: 0);
        // What the desktop holds for chat a.
        var confirmed = _selection(['kit']);
        var sequence = 0;
        final pending = <_Write>[];
        final steps = <String>[];
        await harness.load();
        for (var step = 0; step < 30; step++) {
          switch (random.nextInt(4)) {
            case 0:
              final value = _selection(['c$step']);
              harness.save(value);
              await pumpEventQueue();
              pending.add(harness.writes.last);
              steps.add('save c$step');
            case 1 when pending.isNotEmpty:
              final write = pending.removeAt(random.nextInt(pending.length));
              write.complete(++sequence);
              // The desktop applies it and projects it later.
              confirmed = write.value;
              harness.project({
                'a': [...(confirmed['collectionIds']! as List).cast<String>()],
              }, sequence: ++sequence);
              steps.add('accept ${write.value['collectionIds']}');
            case 2 when pending.isNotEmpty:
              final write = pending.removeAt(random.nextInt(pending.length));
              write.reject();
              steps.add('reject ${write.value['collectionIds']}');
            case _:
              // Reopen: the load ends once nothing is pending.
              Map<String, Object?>? loaded;
              unawaited(harness.load().then((value) => loaded = value));
              await pumpEventQueue();
              for (final write in [...pending]) {
                write.reject();
              }
              pending.clear();
              await pumpEventQueue();
              steps.add('reopen');
              expect(loaded, confirmed, reason: 'seed $seed: $steps');
          }
          await pumpEventQueue();
        }
      }
    });
  });
  group('CAN-3925 a standalone plugins sheet', () {
    test('needs the inventory and a projected chat', () {
      final harness = _StandaloneHarness();
      expect(harness.source(), isNull);
      harness.project(['kit']);
      expect(harness.source(), isNotNull);
      harness.inventory = false;
      expect(harness.source(), isNull);
      expect(
        remoteStandalonePluginsSource(
          commands: harness.commands,
          overrides: harness.overrides,
          chatId: null,
          providerType: null,
          standaloneChat: (_) => harness.chat,
        ),
        isNull,
      );
    });

    test(
      'an unprojected selection stays unknown and is never loaded',
      () async {
        final harness = _StandaloneHarness()..project(null);
        final source = harness.source()!;
        expect(source.selectedCount(), isNull);
        await expectLater(
          source.loadSelections(),
          throwsA(isA<RemoteControlException>()),
        );
        expect(
          harness.save(source, _selection(['kit'])),
          isEmpty,
          reason: 'pending',
        );
        await pumpEventQueue();
        expect(harness.writes, isEmpty);

        harness.project([]);
        expect(harness.source()!.selectedCount(), 0);
        expect(await harness.source()!.loadSelections(), _selection([]));
      },
    );

    test('loads the catalog for the standalone chat', () async {
      final harness = _StandaloneHarness()..project(['kit']);
      await harness.source()!.loadCatalog();
      expect(harness.catalogCalls.single, {
        'type': 'portal.chat.list_plugin_catalog',
        'target': {'standaloneChatLocalId': 'solo'},
        'projectId': 'notes',
        'providerType': 'claude',
      });
    });

    test('a save holds until the desktop applies it', () async {
      final harness = _StandaloneHarness()..project(['kit'], sequence: 1);
      final source = harness.source()!;
      expect(source.selectedCount(), 1);
      await source.loadSelections();
      final outcome = harness.save(source, _selection(['kit', 'more']));
      await pumpEventQueue();
      expect(
        harness.targets.single,
        isA<RemoteStandaloneChatTarget>()
            .having((t) => t.chatId, 'chatId', 'solo')
            .having((t) => t.projectLocalId, 'projectLocalId', 'notes'),
      );
      expect(harness.source()!.selectedCount(), 2);
      expect(outcome, isEmpty);

      harness.writes.single.complete(2);
      await pumpEventQueue();
      expect(outcome.single, _selection(['kit', 'more']));
      harness.project(['kit', 'more'], sequence: 3);
      expect(
        harness.overrides.valueOf('solo', ComposerField.pluginSelections),
        isNull,
      );
      expect(harness.source()!.selectedCount(), 2);
    });

    test('a rejected save returns to the projection', () async {
      final harness = _StandaloneHarness()..project(['kit']);
      final source = harness.source()!;
      await source.loadSelections();
      final outcome = harness.save(source, _selection([]));
      await pumpEventQueue();
      harness.writes.single.reject();
      await pumpEventQueue();
      expect(outcome.single, isA<RemoteControlException>());
      expect(harness.source()!.selectedCount(), 1);
    });

    test('a replaced session or a chat gone rejects the save', () async {
      final harness = _StandaloneHarness()..project(['kit']);
      var source = harness.source()!;
      await source.loadSelections();
      harness.replaceSession();
      expect(harness.save(source, _selection([])), isEmpty, reason: 'pending');
      await pumpEventQueue();
      source = harness.source()!;
      await source.loadSelections();
      harness.chat = null;
      final gone = harness.save(source, _selection([]));
      await pumpEventQueue();
      expect(gone.single, isA<RemoteControlException>());
      expect(harness.writes, isEmpty);
    });

    test('seeded sequences reopen on what the desktop holds', () async {
      for (var seed = 0; seed < 50; seed++) {
        final random = Random(seed);
        final harness = _StandaloneHarness()..project(['kit'], sequence: 0);
        var confirmed = _selection(['kit']);
        var sequence = 0;
        final pending = <_Write>[];
        final steps = <String>[];
        var source = harness.source()!;
        await source.loadSelections();
        for (var step = 0; step < 30; step++) {
          switch (random.nextInt(6)) {
            case 0:
              final written = harness.writes.length;
              harness.save(source, _selection(['c$step']));
              await pumpEventQueue();
              if (harness.writes.length > written) {
                pending.add(harness.writes.last);
              }
              steps.add('save c$step');
            case 1 when pending.isNotEmpty:
              // Completions can arrive out of order.
              final write = pending.removeAt(random.nextInt(pending.length));
              write.complete(++sequence);
              confirmed = write.value;
              harness.project([
                ...(confirmed['collectionIds']! as List).cast<String>(),
              ], sequence: ++sequence);
              steps.add('accept ${write.value['collectionIds']}');
            case 2 when pending.isNotEmpty:
              final write = pending.removeAt(random.nextInt(pending.length));
              write.reject();
              steps.add('reject ${write.value['collectionIds']}');
            case 3:
              // Another client edits the chat on the desktop.
              confirmed = _selection(['host$step']);
              harness.project(['host$step'], sequence: ++sequence);
              steps.add('host edit host$step');
            case 4:
              // A new session drops what the old one submitted.
              harness.replaceSession();
              for (final write in pending) {
                steps.add('drop ${write.value['collectionIds']}');
              }
              pending.clear();
              source = harness.source()!;
              await source.loadSelections();
              steps.add('new session');
            case _:
              // Reopen the chat: the load ends once nothing is pending.
              Map<String, Object?>? loaded;
              source = harness.source()!;
              unawaited(
                source.loadSelections().then((value) => loaded = value),
              );
              await pumpEventQueue();
              for (final write in [...pending]) {
                write.reject();
                steps.add('reject ${write.value['collectionIds']}');
              }
              pending.clear();
              await pumpEventQueue();
              steps.add('reopen');
              expect(loaded, confirmed, reason: 'seed $seed: $steps');
          }
          await pumpEventQueue();
        }
      }
    });
  });
}
