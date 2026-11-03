import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';

/// Keeps one composer's text saved under the [DraftTarget] it is showing
/// (CAN-3556). Each chat gets its own draft back when the user returns.
final class ComposerDraftBinding {
  ComposerDraftBinding({required this._controller, required this._store}) {
    _controller.addListener(_save);
  }

  final TextEditingController _controller;
  final ChatDraftPort _store;
  DraftTarget? _target;
  bool _loading = false;

  DraftTarget? get target => _target;

  void bind(DraftTarget? target) {
    if (target == _target) return;
    _target = target;
    if (target == null) return;
    final text = _store.draftFor(target);
    _loading = true;
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _loading = false;
  }

  /// Like [bind], except that text typed while nothing was bound (a draft
  /// whose target was not known yet) is kept: it becomes [target]'s draft,
  /// after any text already saved there.
  void adopt(DraftTarget target, {ComposerDraftHandoff? returningFrom}) {
    final retained = returningFrom != null && returningFrom.target == target
        ? returningFrom
        : null;
    retained?.cancelRelease();
    final typed = _controller.text;
    if (_target != null || (typed.isEmpty && retained == null)) {
      return bind(target);
    }
    final saved = _store.draftFor(target);
    _target = target;
    var text = typed;
    if (saved.isNotEmpty &&
        saved != typed &&
        (retained == null || saved != retained.text)) {
      text = typed.isEmpty ? saved : '$saved\n$typed';
    }
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _store.setDraft(target, text);
  }

  /// Unbinds without clearing the saved source. The returned acknowledgement
  /// clears it only after the next composer has persisted its copy, and only
  /// if nobody has edited the source since this handoff.
  ComposerDraftHandoff retainForHandoff() {
    final handoff = ComposerDraftHandoff(_target, _controller.text, _store);
    _target = null;
    return handoff;
  }

  /// Hands the text to another composer: forgets what is saved under the
  /// current target and unbinds, leaving the controller as it is.
  void release() {
    final target = _target;
    _target = null;
    if (target != null) _store.setDraft(target, '');
  }

  void rebind(DraftTarget to) {
    final from = _target;
    if (from == null || from == to) {
      _target = to;
      return;
    }
    _store.moveDraft(from, to);
    _target = to;
  }

  void _save() {
    final target = _target;
    if (_loading || target == null) return;
    _store.setDraft(target, _controller.text);
  }

  void dispose() {
    _controller.removeListener(_save);
    unawaited(_store.flush());
  }
}

/// Saved source of a destination handoff. Returning to it cancels delayed
/// cleanup, including acknowledgements already waiting for another store flush.
final class ComposerDraftHandoff {
  ComposerDraftHandoff(this.target, this.text, this._store);

  final DraftTarget? target;
  final String text;
  final ChatDraftPort _store;
  bool _cancelled = false;

  void cancelRelease() => _cancelled = true;

  void call() {
    if (_cancelled) return;
    _cancelled = true;
    final source = target;
    if (source != null && _store.draftFor(source) == text) {
      _store.setDraft(source, '');
      unawaited(_store.flush());
    }
  }
}
