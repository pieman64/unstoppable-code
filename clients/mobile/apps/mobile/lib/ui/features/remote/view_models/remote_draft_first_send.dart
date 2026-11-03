import 'package:flutter/scheduler.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/composer_overrides_controller.dart';

/// Sends a draft composed before the chat screen opened once it is ready.
/// Composer selections survive creation failures and manual retries until the
/// first message has a durable send record.
final class RemoteDraftFirstSend {
  RemoteDraftFirstSend([this._options, this._onEnqueued]);

  void Function(bool)? onPendingChanged;
  bool _running = false;
  bool _completed = false;
  bool _disposed = false;

  void begin() {
    if (_disposed || _completed || _running) return;
    _running = true;
    onPendingChanged?.call(true);
  }

  void didFail() {
    if (!_running) return;
    _running = false;
    onPendingChanged?.call(false);
  }

  void dispose() {
    _disposed = true;
    didFail();
    _onEnqueued = null;
    onPendingChanged = null;
  }

  void Function()? _onEnqueued;

  RemoteChatSendOptions? _options;
  bool _pending = true;
  bool _scheduled = false;

  RemoteChatSendOptions? get options => _options;

  /// Keeps accepted composer edits over the carried draft's untouched fields.
  /// Command-backed edits arrive only after the desktop accepts the choice.
  void didChange<T extends Object>(
    ComposerField<T> field,
    T value, {
    String? providerType,
  }) {
    final options = _options;
    if (_disposed || _completed || options == null) return;
    _options = RemoteChatSendOptions(
      userMessageId: options.userMessageId,
      model: switch ((field, value)) {
        (ComposerField.model, final String model) => model,
        _ => options.model,
      },
      providerType: field == ComposerField.model
          ? providerType
          : options.providerType,
      planMode: switch ((field, value)) {
        (ComposerField.planMode, final bool plan) => plan,
        _ => options.planMode,
      },
      thinkingLevel: switch ((field, value)) {
        (ComposerField.thinkingLevel, final String level) => level,
        _ => options.thinkingLevel,
      },
      fastMode: switch ((field, value)) {
        (ComposerField.fastMode, final bool fast) => fast,
        _ => options.fastMode,
      },
      inputMode: options.inputMode,
      attachments: options.attachments,
    );
  }

  void sendWhenReady({
    required bool Function() ready,
    required void Function() send,
  }) {
    if (_disposed || !_pending || _scheduled || !ready()) return;
    _scheduled = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      if (_disposed || !_pending || !ready()) return;
      _pending = false;
      send();
    });
  }

  void didEnqueue() {
    _pending = false;
    _completed = true;
    didFail();
    _options = null;
    final onEnqueued = _onEnqueued;
    _onEnqueued = null;
    onEnqueued?.call();
  }
}
