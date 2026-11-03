import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

/// Backs [ProviderUsageSource] with a borrowed [RemoteControlViewModel]. It
/// holds no state and owns nothing: listeners attach to the view model, and
/// refresh goes through its existing command path.
final class RemoteProviderUsageSource implements ProviderUsageSource {
  RemoteProviderUsageSource(this._remote);

  final RemoteControlViewModel _remote;

  @override
  bool get isAvailable => isProviderUsageAvailable(
    isConnected: _remote.isConnected,
    desktopStatus: _remote.portalConnectionStatus,
    supportsProviderUsage: _remote.supportsProviderUsage,
  );

  @override
  ProviderUsageDelivery get delivery => switch (_remote.linkState) {
    RemoteLinkState.live => ProviderUsageDelivery.live,
    RemoteLinkState.reconnecting => ProviderUsageDelivery.reconnecting,
    RemoteLinkState.unreachable => ProviderUsageDelivery.unreachable,
  };

  @override
  PortalProviderUsageProjection? get projection => _remote.providerUsage;

  @override
  bool isRefreshing(PortalProviderUsageProvider provider) =>
      _remote.isProviderUsageRefreshing(provider);

  @override
  String? refreshFailure(PortalProviderUsageProvider provider) =>
      _remote.providerUsageRefreshFailure(provider);

  @override
  Future<void> refresh(PortalProviderUsageProvider provider) =>
      _remote.refreshProviderUsage(provider);

  @override
  void addListener(VoidCallback listener) => _remote.addListener(listener);

  @override
  void removeListener(VoidCallback listener) =>
      _remote.removeListener(listener);
}

/// Whether the desktop can currently answer for plan usage: paired, the
/// desktop itself live, and announcing the `provider_usage` capability.
bool isProviderUsageAvailable({
  required bool isConnected,
  required RemotePortalConnectionStatus? desktopStatus,
  required bool supportsProviderUsage,
}) =>
    isConnected &&
    desktopStatus == RemotePortalConnectionStatus.active &&
    supportsProviderUsage;
