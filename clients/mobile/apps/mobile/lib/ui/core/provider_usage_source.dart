import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';

/// The paired desktop's Claude and Codex plan usage (CAN-3636), as Account
/// reads it. The app composition root backs it with Remote Control, so
/// Account does not depend on that feature. Notifies when any value may have
/// changed.
abstract interface class ProviderUsageSource implements Listenable {
  /// Whether the desktop can currently answer for plan usage.
  bool get isAvailable;

  /// Whether this phone's connection to the server is delivering updates.
  /// Independent of [isAvailable]: losing the server is not proof that the
  /// desktop went away.
  ProviderUsageDelivery get delivery;

  /// The desktop's latest projected usage; null until projected.
  PortalProviderUsageProjection? get projection;

  bool isRefreshing(PortalProviderUsageProvider provider);

  String? refreshFailure(PortalProviderUsageProvider provider);

  /// Asks the desktop to re-read [provider]'s usage.
  Future<void> refresh(PortalProviderUsageProvider provider);
}

/// This phone's own delivery of usage updates.
enum ProviderUsageDelivery {
  /// Delivering, or down only briefly.
  live,

  /// Down past a short grace; the values shown are the last received.
  reconnecting,

  /// Down for long enough that the server counts as unreachable; still
  /// retrying.
  unreachable,
}
