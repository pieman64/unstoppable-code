import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Shared Auto availability for every model picker on this device, like the
/// web `useBrowserModelRoutingAvailability`: one cached answer, refreshed
/// when a picker opens after [ttl]. A failed load hides Auto.
///
/// The answer belongs to the account that [accountScope] names (environment
/// and user). Another account never sees it. Only the latest load publishes,
/// so a load that started before an account switch never does.
class ModelRoutingAvailabilityController extends ChangeNotifier
    with DisposeSafeNotifier {
  ModelRoutingAvailabilityController({
    required this.load,
    required this.accountScope,
    DateTime Function()? now,
    this.ttl = const Duration(seconds: 30),
  }) : _now = now ?? DateTime.now;

  final Future<ModelRoutingAvailability> Function() load;
  final String? Function() accountScope;
  final DateTime Function() _now;
  final Duration ttl;

  ModelRoutingAvailability _state = ModelRoutingAvailability.loading;
  String? _scope;
  DateTime? _loadedAt;
  Future<void>? _pending;
  int _request = 0;

  ModelRoutingAvailability get state =>
      accountScope() == _scope ? _state : ModelRoutingAvailability.loading;

  /// Loads availability unless a fresh answer or a load is already present
  /// for the current account.
  Future<void> refresh() {
    final scope = accountScope();
    if (scope != _scope) {
      _scope = scope;
      _state = ModelRoutingAvailability.loading;
      _loadedAt = null;
      _pending = null;
    }
    final loadedAt = _loadedAt;
    if (loadedAt != null && _now().difference(loadedAt) < ttl) {
      return Future.value();
    }
    return _pending ??= _load();
  }

  Future<void> _load() async {
    final request = ++_request;
    ModelRoutingAvailability next;
    try {
      next = await load();
    } catch (_) {
      next = ModelRoutingAvailability.hidden;
    }
    if (request != _request) return;
    _pending = null;
    _loadedAt = _now();
    if (next == _state) return;
    _state = next;
    notifyListenersSafe();
  }
}
