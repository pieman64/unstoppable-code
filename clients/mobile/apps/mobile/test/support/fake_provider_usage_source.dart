import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';

/// A [ProviderUsageSource] a test drives directly. Unavailable with no usage
/// by default, which hides Account's Usage limits row.
final class FakeProviderUsageSource extends ChangeNotifier
    implements ProviderUsageSource {
  FakeProviderUsageSource({
    this.isAvailable = false,
    this.delivery = ProviderUsageDelivery.live,
    this.projection,
  });

  @override
  bool isAvailable;

  @override
  ProviderUsageDelivery delivery;

  @override
  PortalProviderUsageProjection? projection;

  final Set<PortalProviderUsageProvider> refreshing = {};
  final Map<PortalProviderUsageProvider, String> failures = {};
  final List<PortalProviderUsageProvider> refreshes = [];
  int listenerCount = 0;

  /// Applies [change] and notifies, as the backing source would.
  void update(void Function(FakeProviderUsageSource source) change) {
    change(this);
    notifyListeners();
  }

  @override
  bool isRefreshing(PortalProviderUsageProvider provider) =>
      refreshing.contains(provider);

  @override
  String? refreshFailure(PortalProviderUsageProvider provider) =>
      failures[provider];

  @override
  Future<void> refresh(PortalProviderUsageProvider provider) async {
    refreshes.add(provider);
  }

  @override
  void addListener(VoidCallback listener) {
    listenerCount++;
    super.addListener(listener);
  }

  @override
  void removeListener(VoidCallback listener) {
    listenerCount--;
    super.removeListener(listener);
  }
}
