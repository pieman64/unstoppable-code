import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';

/// The paired desktop's Claude and Codex plan usage (CAN-3636), as Account
/// reads it. The app composition root backs it with Computer Connect, so
/// Account does not depend on that feature. Notifies when any value may have
/// changed.
abstract interface class ProviderUsageSource implements Listenable {
  /// Identity of the computer whose values are shown. Changing computers must
  /// clear the detail screen's retained values, even when the new one is offline.
  Object? get scopeKey;

  /// Whether the desktop can currently answer for plan usage.
  bool get isAvailable;

  /// Whether this phone's computer connection is delivering updates.
  ProviderUsageDelivery get delivery;

  /// The desktop's latest projected usage; null until projected.
  PortalProviderUsageProjection? get projection;

  bool isRefreshing(PortalProviderUsageProvider provider);

  String? refreshFailure(PortalProviderUsageProvider provider);

  /// Asks the desktop to re-read [provider]'s usage.
  Future<void> refresh(PortalProviderUsageProvider provider);
}

/// This phone's delivery of usage updates from the selected computer.
enum ProviderUsageDelivery {
  /// Delivering updates from the connected computer.
  live,

  /// Reconnecting; the values shown are the last received.
  reconnecting,

  /// The selected computer is unreachable.
  unreachable,
}
