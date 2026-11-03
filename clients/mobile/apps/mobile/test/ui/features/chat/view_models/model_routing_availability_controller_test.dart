import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/ui/core/chat/view_models/model_routing_availability_controller.dart';

void main() {
  test('one load serves concurrent refreshes until the answer ages', () async {
    var now = DateTime(2026, 10, 9);
    var loads = 0;
    final answer = Completer<ModelRoutingAvailability>();
    final controller = ModelRoutingAvailabilityController(
      load: () {
        loads++;
        return loads == 1
            ? answer.future
            : Future.value(ModelRoutingAvailability.noCredits);
      },
      accountScope: () => null,
      now: () => now,
    );
    expect(controller.state, ModelRoutingAvailability.loading);

    final first = controller.refresh();
    final second = controller.refresh();
    answer.complete(ModelRoutingAvailability.available);
    await Future.wait([first, second]);
    expect(loads, 1);
    expect(controller.state, ModelRoutingAvailability.available);

    now = now.add(const Duration(seconds: 29));
    await controller.refresh();
    expect(loads, 1);

    now = now.add(const Duration(seconds: 2));
    await controller.refresh();
    expect(loads, 2);
    expect(controller.state, ModelRoutingAvailability.noCredits);
  });

  test('a cached answer is not reused after the account changes', () async {
    var scope = 'production:user-1';
    var loads = 0;
    final answers = {
      'production:user-1': ModelRoutingAvailability.available,
      'production:user-2': ModelRoutingAvailability.noCredits,
    };
    final controller = ModelRoutingAvailabilityController(
      load: () async {
        loads++;
        return answers[scope]!;
      },
      accountScope: () => scope,
    );
    await controller.refresh();
    expect(controller.state, ModelRoutingAvailability.available);

    // Well inside the TTL, another account signs in.
    scope = 'production:user-2';
    expect(controller.state, ModelRoutingAvailability.loading);
    await controller.refresh();
    expect(loads, 2);
    expect(controller.state, ModelRoutingAvailability.noCredits);
  });

  test('a pending request from the previous account never publishes', () async {
    var scope = 'production:user-1';
    final previous = Completer<ModelRoutingAvailability>();
    final current = Completer<ModelRoutingAvailability>();
    var loads = 0;
    final controller = ModelRoutingAvailabilityController(
      load: () => ++loads == 1 ? previous.future : current.future,
      accountScope: () => scope,
    );
    final stale = controller.refresh();

    scope = 'staging:user-1';
    final fresh = controller.refresh();
    expect(loads, 2);
    previous.complete(ModelRoutingAvailability.available);
    await stale;
    expect(controller.state, ModelRoutingAvailability.loading);

    // The current account's load is still the one in flight.
    unawaited(controller.refresh());
    expect(loads, 2);
    current.complete(ModelRoutingAvailability.noCredits);
    await fresh;
    expect(controller.state, ModelRoutingAvailability.noCredits);
  });

  group('returning to an account (A -> B -> A)', () {
    late String scope;
    late DateTime now;
    late List<Completer<ModelRoutingAvailability>> answers;
    late ModelRoutingAvailabilityController controller;
    late Future<void> a1;
    late Future<void> a2;

    setUp(() {
      scope = 'production:user-1';
      now = DateTime(2026, 10, 9);
      answers = [];
      controller = ModelRoutingAvailabilityController(
        load: () {
          final answer = Completer<ModelRoutingAvailability>();
          answers.add(answer);
          return answer.future;
        },
        accountScope: () => scope,
        now: () => now,
      );
      a1 = controller.refresh();
      scope = 'staging:user-1';
      unawaited(controller.refresh());
      scope = 'production:user-1';
      a2 = controller.refresh();
      expect(answers, hasLength(3));
    });

    test('an older load for A cannot replace the newer answer', () async {
      answers[2].complete(ModelRoutingAvailability.noCredits);
      await a2;
      expect(controller.state, ModelRoutingAvailability.noCredits);

      now = now.add(const Duration(seconds: 20));
      answers[0].complete(ModelRoutingAvailability.available);
      await a1;
      expect(controller.state, ModelRoutingAvailability.noCredits);

      // The cache age still counts from the newer answer.
      now = now.add(const Duration(seconds: 11));
      unawaited(controller.refresh());
      expect(answers, hasLength(4));
    });

    test('an older load for A leaves the newer load in flight', () async {
      answers[0].complete(ModelRoutingAvailability.available);
      await a1;
      expect(controller.state, ModelRoutingAvailability.loading);

      unawaited(controller.refresh());
      expect(answers, hasLength(3));
      answers[2].complete(ModelRoutingAvailability.noCredits);
      await a2;
      expect(controller.state, ModelRoutingAvailability.noCredits);
    });
  });

  test('a failed load hides Auto', () async {
    final controller = ModelRoutingAvailabilityController(
      load: () => Future.error(Exception('offline')),
      accountScope: () => null,
    );
    await controller.refresh();
    expect(controller.state, ModelRoutingAvailability.hidden);
  });

  test('the wire state maps like web; unknown values hide Auto', () {
    expect(
      ModelRoutingAvailability.fromWire('available'),
      ModelRoutingAvailability.available,
    );
    expect(
      ModelRoutingAvailability.fromWire('no-credits'),
      ModelRoutingAvailability.noCredits,
    );
    expect(
      ModelRoutingAvailability.fromWire('rolled-back'),
      ModelRoutingAvailability.hidden,
    );
    expect(
      ModelRoutingAvailability.fromWire(null),
      ModelRoutingAvailability.hidden,
    );
  });
}
