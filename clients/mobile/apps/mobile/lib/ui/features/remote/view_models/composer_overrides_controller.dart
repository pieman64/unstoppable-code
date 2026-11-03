import 'dart:async';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

/// A composer control whose chosen value is applied before the desktop
/// confirms it.
final class ComposerField<T extends Object> {
  const ComposerField._(this.name);

  final String name;

  static const model = ComposerField<String>._('model');

  /// Auto routing; only `true` is submitted. Picking a [model] ends Auto.
  static const autoModel = ComposerField<bool>._('autoModel');
  static const planMode = ComposerField<bool>._('planMode');
  static const thinkingLevel = ComposerField<String>._('thinkingLevel');
  static const fastMode = ComposerField<bool>._('fastMode');

  /// A complete `PortalChatTabPluginSelections` object.
  static const pluginSelections = ComposerField<Map<String, Object?>>._(
    'pluginSelections',
  );

  @override
  String toString() => name;
}

/// Submits [field]'s [value] for [target]. [onCompleted] receives the
/// projection sequence at which the desktop completed the command;
/// [onFailed] reports its asynchronous rejection. Returns the command id, or
/// an empty id when nothing was submitted.
typedef ComposerCommand =
    Future<String> Function(
      RemoteChatTarget target,
      ComposerField<Object> field,
      Object value, {
      required void Function(int completedAt) onCompleted,
      required void Function() onFailed,
    });

/// One optimistic composer value: what the user chose, the session that
/// submitted it (null for a local value never submitted), and the projection
/// sequence at which the desktop completed it.
final class ComposerOverride {
  ComposerOverride._(this.value, this.generation, this._onSettled);

  final Object value;
  final int? generation;
  int? completedAt;
  void Function(bool applied)? _onSettled;
  final _settled = Completer<void>();

  /// Reports the outcome once: applied when the desktop completed it.
  void _settle(bool applied) {
    final onSettled = _onSettled;
    _onSettled = null;
    if (!_settled.isCompleted) _settled.complete();
    onSettled?.call(applied);
  }
}

final class _ChatOverrides {
  _ChatOverrides(this.target);

  RemoteChatTarget target;
  final Map<ComposerField<Object>, ComposerOverride> fields = {};
}

/// Optimistic composer-control values for one chat view, per chat.
///
/// A chosen value shows at once and holds until the desktop settles it. The
/// latest choice per field wins; an older submission's answer is ignored. A
/// rejection, or a submission that never went out, returns the control to
/// the projection. A completed command releases its value at the first newer
/// authoritative projection of its chat, whatever that projection says: a
/// matching value can predate the command, and a later desktop edit can skip
/// the requested value. A new session discards submitted values.
///
/// Local values ([change] with `local: true`) are send options that the
/// desktop never projects back, so only a later choice replaces them.
final class ComposerOverridesController {
  ComposerOverridesController({
    required this.submit,
    required this.sessionGeneration,
    required this.projectionSequence,
    required this.onChanged,
  });

  final ComposerCommand submit;
  final int Function() sessionGeneration;

  /// The newest authoritative composer projection sequence for [target].
  final int? Function(RemoteChatTarget target) projectionSequence;

  /// Reports a change to an override the view renders.
  final void Function() onChanged;

  final Map<String, _ChatOverrides> _chats = {};
  bool _disposed = false;

  /// [chatId]'s pending [field] value, if any.
  T? valueOf<T extends Object>(String chatId, ComposerField<T> field) =>
      switch (_chats[chatId]?.fields[field]?.value) {
        final T value => value,
        _ => null,
      };

  /// Completes once [chatId]'s latest [field] value is no longer waiting for
  /// the desktop's answer: completed, rejected, never sent, or discarded.
  Future<void> settled(String chatId, ComposerField<Object> field) async {
    while (true) {
      final record = _chats[chatId]?.fields[field];
      if (record == null || record._settled.isCompleted) return;
      await record._settled.future;
    }
  }

  /// Applies [value] to [target]'s [field] at once and, unless [local],
  /// submits it. Throws [RemoteControlException] when the desktop could not
  /// be asked and this is still the latest choice.
  ///
  /// [onSettled] reports once whether the desktop completed the submission
  /// (true) or it was rejected, never sent, superseded, or discarded with
  /// its session (false).
  Future<void> change<T extends Object>(
    RemoteChatTarget target,
    ComposerField<T> field,
    T value, {
    bool local = false,
    void Function(bool applied)? onSettled,
  }) async {
    final chatId = target.chatId;
    if (_disposed || chatId == null) {
      onSettled?.call(false);
      return;
    }
    final chat = _chats.putIfAbsent(chatId, () => _ChatOverrides(target))
      ..target = target;
    final record = ComposerOverride._(
      value,
      local ? null : sessionGeneration(),
      onSettled,
    );
    chat.fields[field]?._settle(false);
    chat.fields[field] = record;
    onChanged();
    if (local) {
      record._settle(true);
      return;
    }

    bool isCurrent() =>
        !_disposed &&
        identical(chat.fields[field], record) &&
        record.generation == sessionGeneration();
    void discard() {
      chat.fields.remove(field);
      record._settle(false);
      onChanged();
    }

    try {
      final commandId = await submit(
        target,
        field,
        value,
        onCompleted: (completedAt) {
          if (!isCurrent()) return;
          record.completedAt = completedAt;
          record._settle(true);
          if (_isSettled(chat, record)) discard();
        },
        onFailed: () {
          if (isCurrent()) discard();
        },
      );
      if (isCurrent() && commandId.isEmpty) discard();
    } on RemoteControlException {
      if (!isCurrent()) {
        record._settle(false);
        return;
      }
      discard();
      rethrow;
    }
  }

  /// Picks a concrete model, which also ends Auto: a pending Auto choice is
  /// dropped so the newer choice shows.
  Future<void> chooseModel(
    RemoteChatTarget target,
    String model, {
    void Function(bool applied)? onSettled,
  }) {
    _drop(target.chatId, ComposerField.autoModel);
    return change(target, ComposerField.model, model, onSettled: onSettled);
  }

  /// Turns on Auto, dropping a pending concrete model choice.
  Future<void> chooseAuto(RemoteWorktreeChatTarget target) {
    _drop(target.chatId, ComposerField.model);
    return change(target, ComposerField.autoModel, true);
  }

  /// Whether [chatId] shows Auto: a pending Auto wins, a pending model means
  /// manual, otherwise the desktop's [projected] mode.
  bool autoSelected(String chatId, {required bool projected}) =>
      valueOf(chatId, ComposerField.autoModel) ??
      (valueOf(chatId, ComposerField.model) == null && projected);

  /// Forgets [field]'s pending value; its late outcome is then ignored.
  void _drop(String? chatId, ComposerField<Object> field) =>
      _chats[chatId]?.fields.remove(field)?._settle(false);

  bool _isSettled(_ChatOverrides chat, ComposerOverride record) {
    final completedAt = record.completedAt;
    final projectedAt = projectionSequence(chat.target);
    return completedAt != null &&
        projectedAt != null &&
        projectedAt > completedAt;
  }

  /// Releases settled values and discards values a replaced session
  /// submitted. Returns whether any value changed.
  bool sync() {
    if (_disposed) return false;
    final generation = sessionGeneration();
    var changed = false;
    for (final chat in _chats.values) {
      chat.fields.removeWhere((_, record) {
        final stale =
            (record.generation != null && record.generation != generation) ||
            _isSettled(chat, record);
        changed = changed || stale;
        if (stale) record._settle(false);
        return stale;
      });
    }
    return changed;
  }

  /// Stops reporting changes; late command outcomes are ignored. Values
  /// still waiting for the desktop settle as not applied.
  void dispose() {
    _disposed = true;
    for (final chat in _chats.values) {
      for (final record in chat.fields.values) {
        record._settle(false);
      }
    }
  }
}
