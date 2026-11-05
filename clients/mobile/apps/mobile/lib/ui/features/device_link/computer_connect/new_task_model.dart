import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/worktrees/creation.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'controller.dart';

/// Owns one chat-first creation attempt in one computer session. A route leaving
/// disposes this coordinator; late results can no longer navigate or send.
class DeviceNewTaskModel extends ChangeNotifier {
  DeviceNewTaskModel(this.controller, this.project) {
    controller.chats.addListener(_changed);
  }
  final ComputerConnectController controller;
  final DeviceProject project;
  late final _attempt = DeviceWorktreeCreateAttempt(
    project.id,
    onChanged: () {
      if (!_disposed) notifyListeners();
    },
  );
  Future<void>? _preparation;
  DeviceCreatedWorktree? _created;
  bool _ready = false, _sending = false;
  bool _creationNotSent = false;
  String? _error;
  String draft = '';
  bool _disposed = false;
  bool get flat => _flat;
  bool get ready => _ready;
  bool get sending => _sending;
  String? get error => _error;
  DeviceCreatedWorktree? get created => _created;
  DeviceWorktreeCreateAttempt get attempt => _attempt;
  bool get canRetryCreation => _flat ? _creationNotSent : _attempt.canRetry;
  bool get _flat => project.type == 'cowork';
  Future<void> retryCreation() async {
    if (!canRetryCreation) return;
    if (_flat) {
      await send();
    } else {
      await prepare();
    }
  }

  Future<void> prepare() {
    if (_preparation case final existing?) return existing;
    late final Future<void> future;
    future = _prepareTarget().whenComplete(() {
      if (!_ready && identical(_preparation, future)) _preparation = null;
    });
    _preparation = future;
    return future;
  }

  Future<void> _prepareTarget() async {
    final model = controller.chats;
    try {
      _error = null;
      _creationNotSent = false;
      _changed();
      if (_flat) {
        await model.chats.createChat(project.id);
      } else {
        final created = await controller.worktreeCreator.create(_attempt);
        if (_disposed || !model.online) return;
        _created = created;
        final tree = DeviceWorktree(
          projectId: created.projectId,
          projectName: project.name,
          id: created.id,
          name: created.name,
          savedStatus: 'active',
        );
        await controller.worktrees.load(tree);
        if (_disposed || !model.online) return;
        if (tree.status == 'Unavailable') {
          throw const DeviceLinkException(
            'Could not load the created task. Refresh to try opening it again.',
          );
        }
        final ref =
            tree.chats
                .where((chat) => chat.id == tree.activeChatId)
                .firstOrNull ??
            tree.chats.firstOrNull;
        if (ref == null) {
          await model.chats.createTab(created.projectId, created.id);
        } else {
          await model.open(ref);
        }
      }
      if (_disposed || !model.online) return;
      model.setDraft(draft);
      model.activity.setWorkspaceKind(project.id, project.type);
      _ready = true;
      _changed();
    } catch (error) {
      if (!_disposed) {
        _creationNotSent = error is DeviceChatCreationNotSent;
        _error = error is DeviceLinkException
            ? error.message
            : _attempt.worktreeId != null
            ? 'Still setting up on your computer. Retry to check the same task.'
            : 'Creation was not confirmed. Check your computer before starting another task.';
        _changed();
      }
    }
  }

  Future<void> send() async {
    final text = draft.trim();
    if (text.isEmpty || _sending || !controller.chats.online) return;
    _sending = true;
    _changed();
    await prepare();
    if (_disposed || !_ready) {
      _sending = false;
      _changed();
      return;
    }
    final model = controller.chats;
    try {
      final result = await model.chats.send(text);
      if (result == DeviceChatSendOutcome.accepted &&
          model.draft.trim() == text) {
        model.setDraft('');
      }
    } catch (error) {
      if (!_disposed) {
        _error = error is DeviceLinkException
            ? error.message
            : 'Could not send the message. Check delivery before retrying.';
        _changed();
      }
    } finally {
      _sending = false;
      _changed();
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    controller.chats.removeListener(_changed);
    super.dispose();
  }
}
