import 'dart:async';

import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/settings.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/protocol.dart';

final class _Selection {
  _Selection(this.patch, this.save);
  final Map<String, dynamic> patch;
  final Future<int> Function(Map<String, dynamic> tab) save;
  final result = Completer<bool>();
  int? revision;
}

Map<String, dynamic> _merge(
  Map<String, dynamic> tab,
  Map<String, dynamic> patch,
) => {
  ...tab,
  ...patch,
  if (patch['modelConfig'] case final Map<String, dynamic> config)
    'modelConfig': {...?tab['modelConfig'] as Map<String, dynamic>?, ...config},
};

/// Shows choices immediately while serializing the existing desktop commands.
/// A receipt's revision releases its preview only once chat state catches up.
/// The queue belongs to one selected chat and connection, never a later target.
final class DeviceComposerSettingsController {
  DeviceComposerSettingsController({
    required this.current,
    required this.sessionGeneration,
    required this.refresh,
    required this.onChanged,
  });

  final DeviceChatState? Function() current;
  final int Function() sessionGeneration;
  final Future<void> Function() refresh;
  final void Function() onChanged;
  final _selections = <_Selection>[];
  Object? _scope;
  Object? _refreshScope;
  Object? _workingScope;
  int _selectionGeneration = 0;
  bool _draining = false, _disposed = false;
  String? _error;
  int _errorRevision = 0;
  String? get error => _error;
  int get errorRevision => _errorRevision;
  set error(String? value) {
    _error = value;
    _errorRevision++;
  }

  /// A reload acknowledges only the error it started with, not a later failure.
  void clearError({required int expectedRevision}) {
    if (expectedRevision == _errorRevision) error = null;
  }

  Object get _currentScope => (
    current()?.ref.key,
    current()?.closed,
    sessionGeneration(),
    _selectionGeneration,
  );
  bool get saving =>
      _selections.isNotEmpty || (_draining && _workingScope == _currentScope);
  bool get refreshing => _refreshScope == _currentScope;

  void invalidate() {
    _selectionGeneration++;
    sync();
  }

  /// Reconcile only against authoritative revisions, never a matching old value.
  void sync() {
    final scope = _currentScope;
    if (_scope != scope) {
      _scope = scope;
      for (final selection in _selections) {
        if (!selection.result.isCompleted) selection.result.complete(false);
      }
      _selections.clear();
      error = null;
    }
    final revision = current()?.revision;
    _selections.removeWhere(
      (selection) =>
          selection.revision != null &&
          revision != null &&
          revision >= selection.revision!,
    );
  }

  Map<String, dynamic> get tab {
    sync();
    return _selections.fold(current()?.tab ?? {}, (tab, selection) {
      return _merge(tab, selection.patch);
    });
  }

  Future<bool> change(
    DeviceChatRef ref,
    Map<String, dynamic> patch,
    Future<int> Function(Map<String, dynamic> tab) save,
  ) {
    sync();
    if (_disposed || current()?.ref.key != ref.key) {
      return Future.value(false);
    }
    final selection = _Selection(patch, save);
    _selections.add(selection);
    error = null;
    onChanged();
    if (!_draining) unawaited(_drain());
    return selection.result.future;
  }

  Future<void> _drain() async {
    _draining = true;
    try {
      while (!_disposed) {
        sync();
        final next = _selections
            .where((selection) => selection.revision == null)
            .firstOrNull;
        if (next == null ||
            _selections.any((selection) => selection.revision != null)) {
          if (_selections.isEmpty) break;
          // The receipt and the push can complete on adjacent stream turns.
          await Future<void>.value();
          sync();
          if (_selections.isEmpty) break;
          if (_selections.every((selection) => selection.revision == null)) {
            continue;
          }
          // A receipt can have side effects beyond our patch, such as a model
          // change clearing provider settings. Recover missed state before
          // constructing the next write from the canonical tab.
          final scope = _scope;
          _refreshScope = scope;
          try {
            await refresh();
          } catch (cause) {
            // A failed read for the previous chat must not strand new picks.
            if (!_disposed && scope != _currentScope) continue;
            if (!_disposed && scope == _currentScope) {
              error = _describe(cause);
              for (final selection in _selections) {
                if (!selection.result.isCompleted) {
                  selection.result.complete(false);
                }
              }
              _selections.clear();
            }
            break;
          } finally {
            _refreshScope = null;
          }
          sync();
          if (_selections.any((selection) => selection.revision == null)) {
            continue;
          }
          break;
        }
        final scope = _scope;
        _workingScope = scope;
        var effective = current()?.tab ?? <String, dynamic>{};
        for (final selection in _selections) {
          effective = _merge(effective, selection.patch);
          if (identical(selection, next)) break;
        }
        try {
          final revision = await next.save(effective);
          if (!_disposed && scope == _currentScope) next.revision = revision;
          if (!next.result.isCompleted) {
            next.result.complete(!_disposed && scope == _currentScope);
          }
        } catch (cause) {
          if (!_disposed && scope == _currentScope) {
            if (cause is DeviceChatSettingsRejected ||
                cause is DesktopIpcNotSent) {
              final superseded = _selections
                  .skipWhile((selection) => !identical(selection, next))
                  .skip(1)
                  .any(
                    (selection) =>
                        next.patch.keys.every(selection.patch.containsKey),
                  );
              _selections.remove(next);
              if (!superseded) error = _describe(cause);
            } else {
              // A timeout or lost reply can still commit on the computer.
              // Cancel dependent picks instead of writing from uncertain state.
              for (final selection in _selections) {
                if (!selection.result.isCompleted) {
                  selection.result.complete(false);
                }
              }
              _selections.clear();
              error =
                  "Couldn't confirm chat settings. Check the selection before trying again.";
            }
          }
          if (!next.result.isCompleted) next.result.complete(false);
        }
        if (!_disposed) {
          sync();
          onChanged();
        }
      }
    } finally {
      _draining = false;
      _workingScope = null;
      if (!_disposed) onChanged();
    }
  }

  String _describe(Object cause) => cause is DeviceLinkException
      ? cause.message
      : "Couldn't save chat settings. Try again.";

  void dispose() {
    _disposed = true;
    for (final selection in _selections) {
      if (!selection.result.isCompleted) selection.result.complete(false);
    }
    _selections.clear();
  }
}
