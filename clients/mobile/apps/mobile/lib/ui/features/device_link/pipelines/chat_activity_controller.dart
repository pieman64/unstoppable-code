import 'dart:async';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/pipelines/chat_activity.dart';
import 'package:mobile/device_link/pipelines/repository.dart';

/// Hydrates the visible chat's receipt-backed runs without replaying controls.
/// One controller belongs to one computer repository and one mounted feed.
final class DevicePipelineChatActivityController {
  DevicePipelineChatActivityController(this.repository) {
    _updates = repository.updates.listen((_) => _syncConnection());
  }

  final DevicePipelineRepository repository;
  late final StreamSubscription<void> _updates;
  DeviceChatRef? _ref;
  List<DeviceChatMessage> _messages = const [];
  bool _online = false;
  int? _connectedGeneration;
  final _requested = <String>{};
  void Function()? _release;

  void update({
    required DeviceChatRef? ref,
    required List<DeviceChatMessage> messages,
    required bool online,
  }) {
    final changed = _ref?.key != ref?.key;
    _ref = ref;
    _messages = messages;
    _online = online;
    if (changed) {
      _release?.call();
      _release = null;
      _requested.clear();
      if (ref != null) _release = repository.watch(ref);
    }
    _syncConnection(refresh: changed);
  }

  void _syncConnection({bool refresh = false}) {
    final generation = _online && repository.connected
        ? repository.connectionGeneration
        : null;
    final reconnected =
        generation != null && generation != _connectedGeneration;
    _connectedGeneration = generation;
    if (reconnected) _requested.clear();
    _hydrate(refresh: refresh || reconnected);
  }

  void _hydrate({bool refresh = false}) {
    final ref = _ref;
    if (!_online || !repository.connected || ref == null) return;
    final activity = devicePipelineChatActivity(
      ref: ref,
      messages: _messages,
      runs: repository.runs(ref),
    );
    for (final runs in activity.values) {
      for (final run in runs) {
        if ((refresh || !run.hasDetail) && _requested.add(run.localId)) {
          unawaited(repository.get(ref, run.localId));
        }
      }
    }
  }

  void dispose() {
    _release?.call();
    unawaited(_updates.cancel());
  }
}
