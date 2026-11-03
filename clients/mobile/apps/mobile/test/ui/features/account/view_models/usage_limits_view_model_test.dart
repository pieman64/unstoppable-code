import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_policy.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_view_model.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/provider_usage_fixture.dart';

const _claude = PortalProviderUsageProvider.claude;
const _codex = PortalProviderUsageProvider.codex;

PortalProviderUsageProjection _projection({double sevenDay = 50}) =>
    PortalProviderUsageProjection.fromJson(
      providerUsagePayload(claude: claudeUsageEntry(sevenDay: sevenDay)),
    );

void main() {
  test('mirrors the source while available and refreshes through it', () {
    final first = _projection();
    final source = FakeProviderUsageSource(
      isAvailable: true,
      projection: first,
    );
    final viewModel = UsageLimitsViewModel(source: source);
    addTearDown(viewModel.dispose);
    expect(viewModel.isDesktopAvailable, isTrue);
    expect(viewModel.projection, same(first));
    expect(viewModel.canRefresh(_claude), isTrue);

    source.update((s) => s.refreshing.add(_claude));
    expect(viewModel.isRefreshing(_claude), isTrue);
    expect(viewModel.canRefresh(_claude), isFalse);
    expect(viewModel.canRefresh(_codex), isTrue);
    viewModel.refresh(_claude);
    expect(source.refreshes, isEmpty, reason: 'already refreshing');

    final next = _projection(sevenDay: 84);
    source.update(
      (s) => s
        ..refreshing.clear()
        ..failures[_codex] = 'Refresh failed'
        ..projection = next,
    );
    expect(viewModel.projection, same(next));
    expect(viewModel.refreshFailure(_codex), 'Refresh failed');
    viewModel.refresh(_codex);
    expect(source.refreshes, [_codex]);
  });

  test('keeps the last values and disables refresh once the source becomes '
      'unavailable, until it is available again', () {
    final first = _projection();
    final source = FakeProviderUsageSource(
      isAvailable: true,
      projection: first,
    );
    final viewModel = UsageLimitsViewModel(source: source);
    addTearDown(viewModel.dispose);
    var notified = 0;
    viewModel.addListener(() => notified++);

    source.update(
      (s) => s
        ..isAvailable = false
        ..projection = null
        ..refreshing.add(_claude)
        ..failures[_claude] = 'Refresh failed',
    );
    expect(notified, 1);
    expect(viewModel.isDesktopAvailable, isFalse);
    expect(viewModel.projection, same(first));
    expect(viewModel.isRefreshing(_claude), isFalse);
    expect(viewModel.refreshFailure(_claude), isNull);
    expect(viewModel.canRefresh(_codex), isFalse);
    viewModel.refresh(_codex);
    expect(source.refreshes, isEmpty);

    final next = _projection(sevenDay: 20);
    source.update(
      (s) => s
        ..isAvailable = true
        ..projection = next
        ..refreshing.clear()
        ..failures.clear(),
    );
    expect(viewModel.isDesktopAvailable, isTrue);
    expect(viewModel.projection, same(next));
  });

  test('while this phone cannot deliver updates, keeps the values and '
      'disables refresh without calling the desktop gone', () {
    final first = _projection();
    final source = FakeProviderUsageSource(
      isAvailable: true,
      projection: first,
    );
    final viewModel = UsageLimitsViewModel(source: source);
    addTearDown(viewModel.dispose);

    for (final delivery in [
      ProviderUsageDelivery.reconnecting,
      ProviderUsageDelivery.unreachable,
    ]) {
      source.update((s) => s.delivery = delivery);
      expect(viewModel.delivery, delivery);
      expect(viewModel.isDesktopAvailable, isTrue);
      expect(viewModel.projection, same(first));
      expect(viewModel.canRefresh(_claude), isFalse);
      expect(viewModel.canRefresh(_codex), isFalse);
      viewModel.refresh(_claude);
      expect(source.refreshes, isEmpty, reason: '$delivery');
    }

    final next = _projection(sevenDay: 84);
    source.update(
      (s) => s
        ..delivery = ProviderUsageDelivery.live
        ..projection = next,
    );
    expect(viewModel.delivery, ProviderUsageDelivery.live);
    expect(viewModel.projection, same(next));
    expect(viewModel.canRefresh(_claude), isTrue);
    viewModel.refresh(_claude);
    expect(source.refreshes, [_claude]);
  });

  test('notifies when a reset time passes without a source update', () {
    fakeAsync((async) {
      final start = usageFixtureNow;
      DateTime now() => start.add(async.elapsed);
      final source = FakeProviderUsageSource(
        isAvailable: true,
        projection: _projection(),
      );
      final viewModel = UsageLimitsViewModel(source: source, clock: now);
      var notified = 0;
      viewModel.addListener(() => notified++);
      final reset = nextUsageResetAfter(viewModel.projection, start)!;

      async.elapse(reset.difference(start) - const Duration(seconds: 1));
      expect(notified, 0);
      async.elapse(const Duration(seconds: 1));
      expect(notified, 1);
      viewModel.dispose();
      async.flushTimers();
    });
  });

  test('dispose detaches from the borrowed source', () {
    final source = FakeProviderUsageSource(isAvailable: true);
    final viewModel = UsageLimitsViewModel(source: source);
    expect(source.listenerCount, 1);
    viewModel.dispose();
    expect(source.listenerCount, 0);
    source.update((s) => s.projection = _projection());
  });
}
