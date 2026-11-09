import 'dart:async';
import 'models.dart';
import 'repository.dart';

/// Observes one submitted prompt on its created chat. Its owner may outlive the
/// chat route; receipt replacement never changes the destination or prompt.
final class DeviceChatDelivery {
  DeviceChatDelivery(this.repository, {this.onConfirmed, this.onChanged}) {
    _updates = repository.updates.listen((_) => _observe());
  }
  final DeviceChatsRepository repository;
  final void Function()? onConfirmed, onChanged;
  late final StreamSubscription<void> _updates;
  DeviceChatRef? _target;
  String? _text;
  bool _confirmed = false, _disposed = false, _wasPending = false;
  DeviceChatRef? get target => _target;
  bool get pending =>
      !_confirmed &&
      _matches(repository.pendingSend?.ref, repository.pendingSend?.text);

  bool _matches(DeviceChatRef? ref, String? text) =>
      _target != null && ref?.key == _target!.key && text == _text;

  void track(DeviceChatRef ref, String text) {
    if (_disposed) return;
    if (_target != null) {
      if (ref.key != _target!.key || text != _text) {
        throw StateError('Delivery tracking belongs to one chat and prompt.');
      }
      return;
    }
    _target = ref;
    _text = text;
  }

  /// Forgets a prompt the computer does not have, after a send it refused,
  /// so the same attempt can track an edited prompt. A pending or confirmed
  /// prompt stays tracked.
  void release() {
    if (pending || _confirmed) return;
    _target = null;
    _text = null;
  }

  void _observe() {
    if (_disposed || _target == null) return;
    final confirmed = repository.confirmedSend;
    final newlyConfirmed =
        !_confirmed && _matches(confirmed?.ref, confirmed?.text);
    if (newlyConfirmed) {
      _confirmed = true;
      onConfirmed?.call();
    }
    final next = pending;
    if (next != _wasPending || newlyConfirmed) {
      _wasPending = next;
      onChanged?.call();
    }
  }

  void dispose() {
    _disposed = true;
    unawaited(_updates.cancel());
  }
}
