import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/ui/features/remote/view_models/space_notification_menu.dart';
import 'package:mobile/ui/features/remote/view_models/space_notifications_view_model.dart';

const _space = 'space-1';

SpaceNotificationPolicy _policy(
  int revision, [
  SpaceNotificationLevel? override,
  bool writesEnabled = true,
  String spaceId = _space,
]) => SpaceNotificationPolicy(
  spaceId: spaceId,
  revision: revision,
  override: override,
  writesEnabled: writesEnabled,
);

typedef _Save = ({
  String spaceId,
  int expectedRevision,
  SpaceNotificationLevel? override,
  Completer<SpaceNotificationPolicy> completer,
});

/// Every call waits until the test completes it, so ordering is explicit.
final class _ScriptedRepository implements SpaceNotificationsRepository {
  final loads = <Completer<SpaceNotificationPolicy>>[];
  final saves = <_Save>[];

  @override
  Future<SpaceNotificationPolicy> load(String spaceId) {
    final completer = Completer<SpaceNotificationPolicy>();
    loads.add(completer);
    return completer.future;
  }

  @override
  Future<SpaceNotificationPolicy> save(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  }) {
    final completer = Completer<SpaceNotificationPolicy>();
    saves.add((
      spaceId: spaceId,
      expectedRevision: expectedRevision,
      override: override,
      completer: completer,
    ));
    return completer.future;
  }
}

/// Stands in for the Remote Control session: notifies on every change, but
/// only a different [scope] is a new session.
final class _Session extends ChangeNotifier {
  int scope = 1;

  void change(int next) {
    scope = next;
    notifyListeners();
  }
}

SpaceNotificationsException _refused(
  SpaceNotificationsFailure failure, [
  SpaceNotificationPolicy? policy,
]) => SpaceNotificationsException(failure, policy: policy);

void main() {
  late _ScriptedRepository repository;
  late _Session session;
  late SpaceNotificationsViewModel vm;

  setUp(() {
    repository = _ScriptedRepository();
    session = _Session();
    vm = SpaceNotificationsViewModel(
      repository: repository,
      sessionChanges: session,
      sessionScope: () => session.scope,
    );
  });

  tearDown(() {
    vm.dispose();
    session.dispose();
  });

  SpaceNotificationMenuState state() => vm.menuStateFor(_space);

  /// Reads the space at [policy] and waits for it to settle.
  Future<void> loaded(SpaceNotificationPolicy policy) async {
    final refresh = vm.refresh(_space);
    repository.loads.last.complete(policy);
    await refresh;
  }

  group('reading', () {
    test(
      'a space is loading with no selection until its read returns',
      () async {
        expect(state().status, SpaceNotificationMenuStatus.loading);
        expect(state().checked, isNull);
        final refresh = vm.refresh(_space);
        expect(state().statusLine?.text, SpaceNotificationCopy.loading);
        expect(state().choicesEnabled, isFalse);
        repository.loads.single.complete(_policy(3));
        await refresh;
        expect(state().status, SpaceNotificationMenuStatus.ready);
        expect(state().checked, SpaceNotificationChoice.all);
        expect(state().choicesEnabled, isTrue);
        expect(state().statusLine, isNull);
      },
    );

    test('a failed first read shows no selection and how to retry', () async {
      final refresh = vm.refresh(_space);
      repository.loads.single.completeError(
        _refused(SpaceNotificationsFailure.ambiguous),
      );
      await refresh;
      expect(state().checked, isNull);
      expect(state().choicesEnabled, isFalse);
      expect(state().statusLine, (
        text: SpaceNotificationCopy.loadFailed,
        isFailure: true,
      ));
    });

    test('an unknown space is disabled with why', () async {
      final refresh = vm.refresh(_space);
      repository.loads.single.completeError(
        _refused(SpaceNotificationsFailure.notFound),
      );
      await refresh;
      expect(state().checked, isNull);
      expect(state().choicesEnabled, isFalse);
      expect(state().statusLine, (
        text: SpaceNotificationCopy.writesClosed,
        isFailure: false,
      ));
    });

    test('closed writes show the saved choice read-only', () async {
      await loaded(_policy(2, SpaceNotificationLevel.mute, false));
      expect(state().checked, SpaceNotificationChoice.mute);
      expect(state().choicesEnabled, isFalse);
      expect(state().statusLine?.text, SpaceNotificationCopy.writesClosed);
      await vm.select(_space, SpaceNotificationLevel.all);
      expect(repository.saves, isEmpty);
    });

    test('a read naming another space is not adopted', () async {
      await loaded(_policy(1, SpaceNotificationLevel.attention, true, 'other'));
      expect(state().checked, isNull);
      expect(state().statusLine?.text, SpaceNotificationCopy.loadFailed);
    });

    test('a failed re-read keeps the acknowledged choice usable', () async {
      await loaded(_policy(3, SpaceNotificationLevel.attention));
      final refresh = vm.refresh(_space);
      repository.loads.last.completeError(
        _refused(SpaceNotificationsFailure.ambiguous),
      );
      await refresh;
      expect(state().checked, SpaceNotificationChoice.attention);
      expect(state().status, SpaceNotificationMenuStatus.ready);
    });
  });

  group('saving', () {
    test('a choice is checked only once the server acknowledges it', () async {
      await loaded(_policy(3));
      final save = vm.select(_space, SpaceNotificationLevel.mute);
      expect(repository.saves.single.expectedRevision, 3);
      expect(repository.saves.single.override, SpaceNotificationLevel.mute);
      expect(state().checked, SpaceNotificationChoice.all);
      expect(state().pending, SpaceNotificationChoice.mute);
      // The sheet keeps its look and height while saving: choices stay
      // enabled and no status line appears, but no second save can start.
      expect(state().statusLine, isNull);
      expect(state().choicesEnabled, isTrue);
      expect(state().canSelect, isFalse);

      repository.saves.single.completer.complete(
        _policy(4, SpaceNotificationLevel.mute),
      );
      await save;
      expect(state().checked, SpaceNotificationChoice.mute);
      expect(state().pending, isNull);
      expect(state().status, SpaceNotificationMenuStatus.ready);
      expect(state().statusLine, isNull);
    });

    test('All activity saves a null override', () async {
      await loaded(_policy(3, SpaceNotificationLevel.mute));
      final save = vm.select(_space, null);
      expect(repository.saves.single.override, isNull);
      repository.saves.single.completer.complete(_policy(4));
      await save;
      expect(state().checked, SpaceNotificationChoice.all);
    });

    test('one save at a time: taps and reads wait for it to settle', () async {
      await loaded(_policy(3));
      final save = vm.select(_space, SpaceNotificationLevel.mute);
      await vm.select(_space, SpaceNotificationLevel.attention);
      await vm.refresh(_space);
      expect(repository.saves, hasLength(1));
      expect(repository.loads, hasLength(1));
      repository.saves.single.completer.complete(
        _policy(4, SpaceNotificationLevel.mute),
      );
      await save;
    });

    test('selecting the saved choice sends nothing', () async {
      await loaded(_policy(3, SpaceNotificationLevel.mute));
      await vm.select(_space, SpaceNotificationLevel.mute);
      expect(repository.saves, isEmpty);
    });

    test('nothing is saved before the space is read', () async {
      await vm.select(_space, SpaceNotificationLevel.mute);
      expect(repository.saves, isEmpty);
    });

    for (final (failure, copy) in [
      (
        SpaceNotificationsFailure.staleRevision,
        SpaceNotificationCopy.changedElsewhere,
      ),
      (
        SpaceNotificationsFailure.deliveryInProgress,
        SpaceNotificationCopy.deliveryInProgress,
      ),
      (
        SpaceNotificationsFailure.writesDisabled,
        SpaceNotificationCopy.writesClosed,
      ),
    ]) {
      test(
        'a ${failure.name} refusal adopts the authoritative state',
        () async {
          await loaded(_policy(3));
          final save = vm.select(_space, SpaceNotificationLevel.mute);
          repository.saves.single.completer.completeError(
            _refused(failure, _policy(5, SpaceNotificationLevel.attention)),
          );
          await save;
          expect(state().checked, SpaceNotificationChoice.attention);
          expect(state().statusLine, (text: copy, isFailure: true));
          expect(repository.loads, hasLength(1), reason: 'no reconcile read');
        },
      );
    }

    test('a refusal policy for another space is not adopted', () async {
      await loaded(_policy(3));
      final save = vm.select(_space, SpaceNotificationLevel.mute);
      repository.saves.single.completer.completeError(
        _refused(
          SpaceNotificationsFailure.staleRevision,
          _policy(5, SpaceNotificationLevel.attention, true, 'other'),
        ),
      );
      await save;
      expect(state().checked, SpaceNotificationChoice.all);
      expect(state().statusLine?.text, SpaceNotificationCopy.saveFailed);
    });

    test('a save to an unknown space disables it', () async {
      await loaded(_policy(3));
      final save = vm.select(_space, SpaceNotificationLevel.mute);
      repository.saves.single.completer.completeError(
        _refused(SpaceNotificationsFailure.notFound),
      );
      await save;
      expect(state().checked, isNull);
      expect(state().statusLine?.text, SpaceNotificationCopy.writesClosed);
    });
  });

  group('an ambiguous save is settled by re-reading', () {
    Future<void> ambiguousSave(SpaceNotificationPolicy? reread) async {
      await loaded(_policy(3));
      final save = vm.select(_space, SpaceNotificationLevel.mute);
      repository.saves.single.completer.completeError(
        _refused(SpaceNotificationsFailure.ambiguous),
      );
      await pumpEventQueue();
      expect(repository.loads, hasLength(2), reason: 'reconcile read');
      expect(state().status, SpaceNotificationMenuStatus.saving);
      expect(state().pending, SpaceNotificationChoice.mute);
      if (reread == null) {
        repository.loads.last.completeError(
          _refused(SpaceNotificationsFailure.ambiguous),
        );
      } else {
        repository.loads.last.complete(reread);
      }
      await save;
    }

    test('committed when the revision advanced to the choice', () async {
      await ambiguousSave(_policy(4, SpaceNotificationLevel.mute));
      expect(state().checked, SpaceNotificationChoice.mute);
      expect(state().status, SpaceNotificationMenuStatus.ready);
    });

    test('not saved when the revision did not move', () async {
      await ambiguousSave(_policy(3));
      expect(state().checked, SpaceNotificationChoice.all);
      expect(state().statusLine?.text, SpaceNotificationCopy.saveFailed);
    });

    test('changed elsewhere when another choice landed', () async {
      await ambiguousSave(_policy(4, SpaceNotificationLevel.attention));
      expect(state().checked, SpaceNotificationChoice.attention);
      expect(state().statusLine?.text, SpaceNotificationCopy.changedElsewhere);
    });

    test('unconfirmed when the re-read fails too', () async {
      await ambiguousSave(null);
      expect(state().checked, SpaceNotificationChoice.all);
      expect(state().statusLine?.text, SpaceNotificationCopy.unconfirmed);
    });

    test(
      'an acknowledgement that does not match the choice reconciles',
      () async {
        await loaded(_policy(3));
        final save = vm.select(_space, SpaceNotificationLevel.mute);
        repository.saves.single.completer.complete(_policy(3));
        await pumpEventQueue();
        expect(repository.loads, hasLength(2));
        repository.loads.last.complete(_policy(4, SpaceNotificationLevel.mute));
        await save;
        expect(state().checked, SpaceNotificationChoice.mute);
      },
    );

    test('a later read replaces the failure line', () async {
      await ambiguousSave(_policy(3));
      // Same revision: the failure still describes it.
      await loaded(_policy(3));
      expect(state().statusLine?.text, SpaceNotificationCopy.saveFailed);
      await loaded(_policy(6, SpaceNotificationLevel.all));
      expect(state().statusLine, isNull);
      expect(state().checked, SpaceNotificationChoice.all);
    });
  });

  group('stale results', () {
    test('a late read never rolls a space back to an older revision', () async {
      await loaded(_policy(3));
      final save = vm.select(_space, SpaceNotificationLevel.mute);
      repository.saves.single.completer.complete(
        _policy(4, SpaceNotificationLevel.mute),
      );
      await save;
      await loaded(_policy(3));
      expect(state().checked, SpaceNotificationChoice.mute);
    });

    test('a superseded read is dropped', () async {
      await loaded(_policy(3));
      final first = vm.refresh(_space);
      final second = vm.refresh(_space);
      repository.loads[2].complete(_policy(7, SpaceNotificationLevel.mute));
      await second;
      repository.loads[1].complete(_policy(8, SpaceNotificationLevel.all));
      await first;
      expect(state().checked, SpaceNotificationChoice.mute);
    });

    test(
      'a session change forgets choices and drops in-flight saves',
      () async {
        await loaded(_policy(3));
        final generation = vm.generation;
        final save = vm.select(_space, SpaceNotificationLevel.mute);
        session.change(2);
        expect(vm.generation, generation + 1);
        expect(state().checked, isNull);
        expect(state().status, SpaceNotificationMenuStatus.loading);
        repository.saves.single.completer.complete(
          _policy(4, SpaceNotificationLevel.mute),
        );
        await save;
        expect(state().checked, isNull);
      },
    );

    test('an unchanged session scope keeps choices', () async {
      await loaded(_policy(3, SpaceNotificationLevel.mute));
      session.change(1);
      expect(state().checked, SpaceNotificationChoice.mute);
    });

    test('an in-flight read from a previous session is dropped', () async {
      final refresh = vm.refresh(_space);
      vm.reset();
      repository.loads.single.complete(_policy(3, SpaceNotificationLevel.mute));
      await refresh;
      expect(state().checked, isNull);
    });
  });

  group('menu presentation', () {
    test('choices, labels, and descriptions mirror the shared menu', () {
      expect(SpaceNotificationChoice.values.map(spaceNotificationChoiceLabel), [
        'All activity',
        'Needs my attention',
        'Mute',
      ]);
      expect(SpaceNotificationChoice.all.level, isNull);
      expect(
        spaceNotificationChoiceDescription(SpaceNotificationChoice.all),
        'Notify me about everything in this space',
      );
      expect(
        spaceNotificationChoiceDescription(SpaceNotificationChoice.attention),
        'Notify me only when work needs input, approval, or review, is blocked, or fails',
      );
      expect(
        spaceNotificationChoiceDescription(SpaceNotificationChoice.mute),
        'Send no notifications from this space',
      );
    });

    test('no override and an explicit all both check All activity', () {
      expect(SpaceNotificationChoice.of(null), SpaceNotificationChoice.all);
      expect(
        SpaceNotificationChoice.of(SpaceNotificationLevel.all),
        SpaceNotificationChoice.all,
      );
    });
  });
}
