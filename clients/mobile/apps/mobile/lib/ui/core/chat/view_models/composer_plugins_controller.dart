import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// The owning chat's plugin catalog and capability selection (CAN-3922).
/// Hosts adapt their own transport; the composer only reads and writes
/// complete selections.
final class ComposerPluginsSource {
  const ComposerPluginsSource({
    required this.loadCatalog,
    required this.loadSelections,
    required this.save,
    required this.selectedCount,
    required this.providerType,
    this.readOnlyReason,
  });

  final Future<ComposerPluginCatalog> Function() loadCatalog;

  /// The provider of the chat the last [loadSelections] read, which scopes
  /// the plugins it can use; null when unknown. Read once each load ends.
  final String? Function() providerType;

  /// The chat's current complete selection. Throws while it is unknown, so
  /// an unknown state can never be overwritten.
  final Future<Map<String, Object?>> Function() loadSelections;

  /// Saves the complete [selections]. Completes with what the chat holds once
  /// the host has accepted the write, and throws when it is rejected.
  final Future<Map<String, Object?>> Function(Map<String, Object?> selections)
  save;

  /// The explicit choices for the Plugins row; null when not yet known.
  final int? Function() selectedCount;

  /// Why this host can browse selections but cannot safely replace them.
  final String? readOnlyReason;
}

enum ComposerPluginsStatus { loading, ready, failed }

/// Shown on a plugin row the chat's provider cannot use.
const composerPluginUnsupportedReason = 'Unsupported by this provider';

/// Shown on a plugin's row when its toggle did not take.
String composerPluginToggleFailedMessage(ComposerPluginItem item) =>
    'Could not change ${item.name}. Try again.';

/// One open plugins sheet: loads the catalog and the chat's selection, and
/// applies one toggle at a time. A failed toggle returns the row to the
/// chat's previous selection and reports it on that row.
class ComposerPluginsController extends ChangeNotifier
    with DisposeSafeNotifier {
  ComposerPluginsController(this._source) {
    load();
  }

  final ComposerPluginsSource _source;

  ComposerPluginsStatus _status = ComposerPluginsStatus.loading;
  ComposerPluginCatalog _catalog = const ComposerPluginCatalog(items: []);
  Map<String, Object?> _selections = const {};
  String? _providerType;
  ComposerPluginItem? _saving;
  ComposerPluginItem? _failed;
  int _loadGeneration = 0;

  ComposerPluginsStatus get status => _status;
  ComposerPluginCatalog get catalog => _catalog;
  String? get readOnlyReason => _source.readOnlyReason;

  /// The row whose write is in flight; other rows wait for it.
  ComposerPluginItem? get saving => _saving;

  /// The last toggle's failure if it was [item]'s, until the next toggle.
  String? errorFor(ComposerPluginItem item) =>
      _failed?.key == item.key ? composerPluginToggleFailedMessage(item) : null;

  bool isSelected(ComposerPluginItem item) =>
      pluginSelectionsContain(_selections, item);

  /// Whether the chat's provider can use [item].
  bool isSupported(ComposerPluginItem item) =>
      item.supports(composerPluginProviderOf(_providerType));

  /// Editable sources always allow selected items to turn off, including
  /// choices the provider cannot use. Read-only sources disable every toggle.
  bool canToggle(ComposerPluginItem item) =>
      readOnlyReason == null && (isSelected(item) || isSupported(item));

  /// Loads the catalog and selection again, after a failure.
  void load() {
    final generation = ++_loadGeneration;
    _status = ComposerPluginsStatus.loading;
    notifyListenersSafe();
    unawaited(() async {
      try {
        final (catalog, selections) = await (
          _source.loadCatalog(),
          _source.loadSelections(),
        ).wait;
        // Validates the selection once, before any write is built from it.
        normalizePluginSelections(selections);
        if (isDisposed || generation != _loadGeneration) return;
        _catalog = catalog;
        _selections = selections;
        _providerType = _source.providerType();
        _status = ComposerPluginsStatus.ready;
      } catch (_) {
        if (isDisposed || generation != _loadGeneration) return;
        _status = ComposerPluginsStatus.failed;
      }
      notifyListenersSafe();
    }());
  }

  /// Turns [item] on or off and saves the complete selection.
  Future<void> toggle(ComposerPluginItem item) async {
    if (_status != ComposerPluginsStatus.ready ||
        _saving != null ||
        !canToggle(item)) {
      return;
    }
    final previous = _selections;
    final on = !isSelected(item);
    _selections = withPluginSelection(previous, item, on: on);
    _saving = item;
    _failed = null;
    notifyListenersSafe();
    try {
      final accepted = await _source.save(_selections);
      if (isDisposed) return;
      _selections = accepted;
      // The host can accept the write and still prune what it could not use.
      if (isSelected(item) != on) _failed = item;
    } catch (_) {
      if (isDisposed) return;
      _selections = previous;
      _failed = item;
    }
    _saving = null;
    notifyListenersSafe();
  }
}
