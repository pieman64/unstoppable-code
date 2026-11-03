import 'dart:async';

import 'package:mobile/data/models/remote_provider_usage.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_provider_usage_commands.dart';

import 'owned_command_registry.dart';
import 'remote_identity.dart';

/// Watchdog for a usage refresh the desktop never answers with new data.
const Duration kRemoteProviderUsageRefreshTimeout = Duration(seconds: 60);

const String kRemoteProviderUsageRefreshUnconfirmed =
    "The desktop didn't send new usage. Try again.";

const String _refreshFailed = "Couldn't refresh usage. Try again.";

/// The paired desktop's Claude and Codex plan usage (CAN-3635) and this
/// client's per-provider refreshes.
///
/// A refresh acknowledgement only means the desktop started reading; it stays
/// pending until that provider's entry changes in a pushed update, the
/// desktop rejects the command, or [refreshTimeout] passes. One refresh per
/// provider is in flight at a time, so repeated taps send one command.
final class ProviderUsageTracker {
  ProviderUsageTracker({
    required this.usageCommands,
    required this.commands,
    required this.isConnected,
    required this.notify,
    this.refreshTimeout = kRemoteProviderUsageRefreshTimeout,
    this.timer = Timer.new,
  });

  final RemoteProviderUsageCommands usageCommands;
  final OwnedCommandRegistry commands;
  final bool Function() isConnected;
  final void Function() notify;
  final Duration refreshTimeout;
  final RemoteTimerFactory timer;

  PortalProviderUsageProjection? _projection;
  int? _cursor;
  final Map<PortalProviderUsageProvider, _PendingRefresh> _pending = {};
  final Map<PortalProviderUsageProvider, String> _failures = {};

  /// Latest projected usage; null until the desktop projects it.
  PortalProviderUsageProjection? get projection => _projection;

  bool isRefreshing(PortalProviderUsageProvider provider) =>
      _pending.containsKey(provider);

  /// Why the last refresh of [provider] did not complete, until retried.
  String? refreshFailure(PortalProviderUsageProvider provider) =>
      _failures[provider];

  /// Applies an observation covering events up to [cursor]. An observation
  /// older than one already applied (a slow state read overtaken by a pushed
  /// delta) is ignored. Returns whether anything visible changed.
  bool apply(RemoteProviderUsageUpdate update, {int? cursor}) {
    final applied = _cursor;
    if (cursor != null && applied != null && cursor < applied) return false;
    if (cursor != null) _cursor = cursor;
    final next = update.projection;
    _projection = next;
    for (final provider in List.of(_pending.keys)) {
      final pending = _pending[provider]!;
      final entry = next == null ? null : _entryFor(next, provider);
      if (entry == null || _signature(entry) != pending.baseline) {
        _settle(provider, pending);
      }
    }
    return true;
  }

  /// Sends one `portal.provider_usage.refresh` for [provider] unless one is
  /// already pending.
  Future<void> refresh(PortalProviderUsageProvider provider) async {
    if (_pending.containsKey(provider) || !isConnected()) return;
    final current = _projection;
    final entry = current == null ? null : _entryFor(current, provider);
    final pending = _PendingRefresh(entry == null ? null : _signature(entry));
    _pending[provider] = pending;
    _failures.remove(provider);
    pending.watchdog = timer(
      refreshTimeout,
      () => _fail(provider, pending, kRemoteProviderUsageRefreshUnconfirmed),
    );
    notify();
    try {
      // Feature-owned: a rejection is shown for this provider only, never in
      // Remote Control's command-failure banner.
      commands.register(
        await usageCommands.refresh(provider),
        recordOutcome: false,
        onFailed: (message) => _fail(provider, pending, message),
      );
    } on RemoteControlException catch (error) {
      _fail(provider, pending, error.message);
    } catch (_) {
      _fail(provider, pending, _refreshFailed);
    }
  }

  void _settle(PortalProviderUsageProvider provider, _PendingRefresh pending) {
    if (!identical(_pending[provider], pending)) return;
    _pending.remove(provider);
    pending.watchdog?.cancel();
  }

  void _fail(
    PortalProviderUsageProvider provider,
    _PendingRefresh pending,
    String message,
  ) {
    if (!identical(_pending[provider], pending)) return;
    _settle(provider, pending);
    _failures[provider] = message;
    notify();
  }

  /// Forgets the discarded session's usage and refreshes.
  void reset() {
    for (final pending in _pending.values) {
      pending.watchdog?.cancel();
    }
    _pending.clear();
    _failures.clear();
    _projection = null;
    _cursor = null;
  }

  void dispose() => reset();

  static PortalProviderUsageEntry? _entryFor(
    PortalProviderUsageProjection projection,
    PortalProviderUsageProvider provider,
  ) {
    for (final entry in projection.providers) {
      if (entry.provider == provider) return entry;
    }
    return null;
  }

  /// What a refresh can change about one provider's entry.
  static String _signature(PortalProviderUsageEntry entry) => [
    entry.authState.wire,
    entry.lastUpdatedAt,
    entry.error?.message,
    entry.planLabel,
    entry.accountEmail,
    for (final window in entry.windows) ...[
      window.id,
      window.usedPercent,
      window.resetsAt,
      window.credits?.remaining,
      window.credits?.spent,
      window.credits?.total,
    ],
  ].join('\u0000');
}

final class _PendingRefresh {
  _PendingRefresh(this.baseline);

  /// The provider's entry when the refresh started; null when absent.
  final String? baseline;
  Timer? watchdog;
}
