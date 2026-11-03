import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

import 'package:mobile/ui/core/chat/view_models/composer_command_menu.dart';

/// The owning chat's feed of host suggestions. Hosts cache by scope, so
/// [load] may answer from memory.
final class ComposerCommandSource {
  const ComposerCommandSource({
    required this.scope,
    this.load,
    this.enable,
    this.resolve,
    this.revision,
    this.unsettled,
  });

  /// What [load] answers for (chat, model, harness, selections). A different
  /// scope discards the shown rows and loads again.
  final Object scope;

  /// Host rows for [scope]; null when the chat has built-in actions only.
  final Future<List<ComposerCommand>> Function()? load;

  /// What [load]'s rows also depend on that can change without a new source,
  /// such as a draft's capability selection. When it differs from the value
  /// the shown rows were loaded for, the list loads again, even while open.
  final Object? Function()? revision;

  /// Whether [load] last answered rows that a later load can change, as a
  /// stale or rebuilding host inventory does. Those rows stay shown and load
  /// again as the list next opens, not while it stays open.
  final bool Function()? unsettled;

  /// Enables an "Available to enable" row. Completes with true only after the
  /// host has authoritatively enabled it, with false when the request was
  /// superseded (an account or organization change) and should be dropped
  /// silently, and throws when it could not be enabled.
  final Future<bool> Function(ComposerCommand command)? enable;

  /// Resolves a row that [ComposerCommand.requiresResolution]: enables it on
  /// the host and completes with the authoritative text to insert, or with
  /// null when the request was superseded and should be dropped silently.
  /// Throws when it could not be resolved.
  final Future<String?> Function(ComposerCommand command)? resolve;
}

enum ComposerCommandsStatus { idle, loading, loaded, failed }

/// Shown when an "Available to enable" row could not be enabled.
const String kComposerEnableFailedMessage =
    'Could not enable that item. Try again or use the Plugins picker.';

/// Coordinates one composer's suggestion list: watches the draft for a
/// trigger, loads host rows lazily when the list opens, and applies a
/// selection to the draft. Rendering stays in the widget layer.
class ComposerMenuController extends ChangeNotifier with DisposeSafeNotifier {
  ComposerMenuController(this._draft) {
    _draft.addListener(_onDraftChanged);
  }

  final TextEditingController _draft;

  ComposerCommandSource? _source;
  List<ComposerAction> _actions = const [];
  bool _enabled = false;
  bool _dollar = false;
  bool _focused = false;
  ComposerTrigger? _trigger;

  /// The draft right after a selection; the list stays closed until the
  /// draft changes again, even when the inserted text keeps a token open.
  TextEditingValue? _closedAt;

  /// Whether the list was open at the last load check.
  bool _wasOpen = false;

  /// Whether the shown rows load again as the list next opens.
  bool _unsettled = false;

  Object? _scope;
  Object? _revision;
  ComposerCommandsStatus _status = ComposerCommandsStatus.idle;
  List<ComposerCommand> _commands = const [];
  int _loadGeneration = 0;

  ComposerCommand? _enabling;
  String? _enableError;

  /// The trigger whose typed search shows every ranked row. Any query change,
  /// close or chat change collapses the list again.
  ComposerTrigger? _expandedFor;
  int _selectionGeneration = 0;

  bool get isOpen =>
      _enabled && _focused && _trigger != null && _draft.value != _closedAt;

  ComposerTrigger? get trigger => _trigger;
  ComposerCommandsStatus get status => _status;

  /// The row whose enablement is in flight, if any.
  ComposerCommand? get enabling => _enabling;

  /// [kComposerEnableFailedMessage] after a failed enablement, until the
  /// draft changes.
  String? get enableError => _enableError;

  List<ComposerMenuSection> get sections => buildComposerMenu(
    actions: _actions,
    commands: _commands,
    query: _trigger?.query ?? '',
    expanded: _trigger != null && _expandedFor == _trigger,
  );

  /// Applies the owning composer's current state. Called while building, so
  /// it never notifies; the caller renders the updated state itself.
  void configure({
    required ComposerCommandSource? source,
    required List<ComposerAction> actions,
    required bool enabled,
    required bool dollar,
  }) {
    _source = source;
    _actions = actions;
    _enabled = enabled && source != null;
    if (dollar != _dollar) {
      _dollar = dollar;
      _trigger = findComposerTrigger(_draft.value, dollar: dollar);
    }
    if (source?.scope != _scope) {
      _scope = source?.scope;
      _selectionGeneration++;
      _expandedFor = null;
      _loadGeneration++;
      _commands = const [];
      _status = ComposerCommandsStatus.idle;
    }
    _loadIfOpen();
  }

  /// Tracks draft focus; the list only shows while the draft is focused.
  void setFocused(bool focused) {
    if (_focused == focused) return;
    _focused = focused;
    _loadIfOpen();
    notifyListenersSafe();
  }

  /// Loads host rows again after a failure.
  void retry() {
    _status = ComposerCommandsStatus.idle;
    _loadIfOpen();
    notifyListenersSafe();
  }

  void _onDraftChanged() {
    final trigger = findComposerTrigger(_draft.value, dollar: _dollar);
    final reopened = _closedAt != null && _draft.value != _closedAt;
    if (reopened) _closedAt = null;
    if (trigger == _trigger && _enableError == null && !reopened) return;
    if (trigger != _trigger) _expandedFor = null;
    _selectionGeneration++;
    _trigger = trigger;
    _enableError = null;
    _loadIfOpen();
    notifyListenersSafe();
  }

  void _loadIfOpen() {
    final opening = isOpen && !_wasOpen;
    if (!isOpen) {
      _expandedFor = null;
      _selectionGeneration++;
    }
    _wasOpen = isOpen;
    final load = _source?.load;
    if (!isOpen || load == null) return;
    final revision = _source?.revision?.call();
    if (_status != ComposerCommandsStatus.idle) {
      if (revision != _revision) {
        // The rows were loaded for another revision: discard them.
        _commands = const [];
      } else if (!opening || !_unsettled) {
        return;
      }
    }
    _revision = revision;
    _unsettled = false;
    final generation = ++_loadGeneration;
    _status = ComposerCommandsStatus.loading;
    unawaited(() async {
      List<ComposerCommand>? commands;
      try {
        commands = await load();
      } catch (_) {
        commands = null;
      }
      if (isDisposed || generation != _loadGeneration) return;
      _commands = commands ?? const [];
      _unsettled = commands != null && (_source?.unsettled?.call() ?? false);
      _status = commands == null
          ? ComposerCommandsStatus.failed
          : ComposerCommandsStatus.loaded;
      notifyListenersSafe();
    }());
  }

  /// Applies [entry]: a built-in action consumes its token and runs; a host
  /// row replaces the token with its insertion. Nothing is sent.
  Future<void> select(ComposerMenuEntry entry) async {
    final trigger = _trigger;
    if (trigger == null || !isOpen) return;
    switch (entry) {
      case ComposerShowAllEntry():
        // Expands in place: the draft, focus and enablement stay untouched.
        _expandedFor = trigger;
        notifyListenersSafe();
      case ComposerActionEntry(:final action):
        if (action.disabledReason != null) return;
        _replace(trigger, '');
        action.onRun();
      case ComposerCommandEntry(:final command):
        if (command.unavailableReason != null || _enabling != null) return;
        final String? insertion;
        if (command.requiresResolution) {
          final resolve = _source?.resolve;
          insertion = resolve == null
              ? null
              : await _prepare(command, trigger, () => resolve(command));
        } else if (command.needsEnable) {
          final enable = _source?.enable;
          insertion = enable == null
              ? null
              : await _prepare(
                  command,
                  trigger,
                  () async => await enable(command)
                      ? command.insertion(trigger.character)
                      : null,
                );
        } else {
          insertion = command.insertion(trigger.character);
        }
        if (insertion != null) _replace(trigger, insertion);
    }
  }

  /// Enables [command] through [request] and returns the text to insert
  /// while it may still be inserted: the draft, its trigger, and the chat
  /// must be unchanged when it lands. Null when it failed, was superseded,
  /// or arrived too late.
  Future<String?> _prepare(
    ComposerCommand command,
    ComposerTrigger trigger,
    Future<String?> Function() request,
  ) async {
    final draft = _draft.value;
    final scope = _scope;
    final generation = _selectionGeneration;
    _enabling = command;
    _enableError = null;
    notifyListenersSafe();
    final String? insertion;
    try {
      insertion = await request();
    } catch (_) {
      if (isDisposed) return null;
      _enabling = null;
      if (_draft.value == draft &&
          _scope == scope &&
          generation == _selectionGeneration) {
        _enableError = kComposerEnableFailedMessage;
      }
      notifyListenersSafe();
      return null;
    }
    if (isDisposed) return null;
    _enabling = null;
    if (insertion == null) {
      notifyListenersSafe();
      return null;
    }
    // The enabled row moves out of "Available to enable": load again on the
    // next open.
    if (_scope == scope) {
      _loadGeneration++;
      _status = ComposerCommandsStatus.idle;
    }
    final current =
        _draft.value == draft &&
        _scope == scope &&
        _trigger == trigger &&
        generation == _selectionGeneration;
    notifyListenersSafe();
    return current ? insertion : null;
  }

  void _replace(ComposerTrigger trigger, String replacement) {
    final next = replaceComposerTrigger(_draft.value, trigger, replacement);
    _closedAt = next;
    _wasOpen = false;
    _draft.value = next;
  }

  @override
  void dispose() {
    _draft.removeListener(_onDraftChanged);
    super.dispose();
  }
}
