import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/delivery.dart';
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/worktrees/creation.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_uploader.dart';
import 'package:mobile/ui/core/chat/view_models/composer_effort.dart';
import '../device_chat_attachment_uploader.dart';
import 'controller.dart';

/// Owns one chat-first creation attempt in one computer session. A route leaving
/// disposes this coordinator; late results can no longer navigate or send.
class DeviceNewTaskModel extends ChangeNotifier {
  DeviceNewTaskModel(
    this.controller,
    this.project, {
    this.worktree,
    this.baseBranch,
    this.initialModel,
    this.thinkingLevel,
    void Function()? onSent,
    DeviceChatDelivery? delivery,
    this.workspaceContext,
    this.attachments = const [],
    this.onAttachmentsSent,
  }) : _delivery =
           delivery ??
           DeviceChatDelivery(controller.chats.chats, onConfirmed: onSent),
       _ownsDelivery = delivery == null {
    controller.chats.addListener(_changed);
  }
  final ComputerConnectController controller;
  final DeviceProject project;
  final WorkspaceContext? workspaceContext;
  DeviceChatRef? _target;
  bool get _scopeValid =>
      workspaceContext == null ||
      controller.active &&
          !controller.scopePending &&
          controller
              .scopeFor(workspaceContext)
              .projects
              .any((p) => p.id == project.id);
  final DeviceWorktree? worktree;
  final String? baseBranch, thinkingLevel;
  final ModelOption? initialModel;
  final DeviceChatDelivery _delivery;
  final bool _ownsDelivery;

  /// Files staged on Home before the chat existed. They upload into the
  /// created chat's scope once it is ready, then go with the first message.
  final List<ChatAttachmentDraft> attachments;

  /// Called once the first message carried [attachments], so Home can clear
  /// them; like a chat's own send, the files are then spent.
  final ValueChanged<List<ChatAttachmentDraft>>? onAttachmentsSent;

  /// Computer paths by draft, kept across retries in the same target.
  final _uploaded = <String, String>{};

  /// Whether a send that has or may have reached the computer named the
  /// uploads; until then, leaving this attempt deletes them.
  bool _uploadsSpent = false;
  late final _attempt = DeviceWorktreeCreateAttempt(
    project.id,
    baseBranch: baseBranch,
    onChanged: () {
      if (!_disposed) notifyListeners();
    },
  );
  Future<void>? _preparation;
  DeviceCreatedWorktree? _created;
  bool _ready = false, _sending = false;
  bool _creationNotSent = false, _sendRequested = false;
  String? _error;
  String draft = '';
  bool _disposed = false;
  bool get flat => _flat;
  bool get ready => _ready;
  bool get sending => _sending;
  String? get error => _error;
  DeviceCreatedWorktree? get created => _created;
  DeviceWorktreeCreateAttempt get attempt => _attempt;
  bool get canRetryCreation =>
      _target != null ||
      (worktree != null
          ? _creationNotSent
          : _flat
          ? _creationNotSent
          : _attempt.canRetry);
  bool get _flat => project.type == 'cowork';
  Future<void> retryCreation() async {
    if (!canRetryCreation) return;
    if (_flat || _sendRequested) {
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

  void _requireScope() {
    if (!_scopeValid) {
      throw const DeviceLinkException(
        'Projects changed. Return home to check the created chat.',
      );
    }
  }

  Future<void> _prepareTarget() async {
    final model = controller.chats;
    try {
      _error = null;
      _creationNotSent = false;
      _changed();
      if (!_scopeValid) {
        throw const DeviceLinkException(
          'Projects changed. Return home and choose the destination again.',
        );
      }
      if (_target == null && model.chats.pendingSend != null) {
        throw const DeviceLinkException(
          'Check delivery of the previous message before starting another chat.',
        );
      }
      if (_target case final target?) {
        await model.open(target);
      } else if (worktree case final tree?) {
        await model.chats.createTab(
          project.id,
          tree.id,
          onCreated: (ref) => _target = ref,
        );
      } else if (_flat) {
        await model.chats.createChat(
          project.id,
          onCreated: (ref) => _target = ref,
        );
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
          await model.chats.createTab(
            created.projectId,
            created.id,
            onCreated: (ref) => _target = ref,
          );
        } else {
          _target = ref;
          await model.open(ref);
        }
      }
      if (_disposed || !model.online) return;
      if (!_scopeValid) {
        throw const DeviceLinkException(
          'Projects changed. Return home to check the created chat.',
        );
      }
      // Resolve options from the created chat before applying the first send's
      // settings, including when the composer inherited the desktop model.
      if (initialModel != null || thinkingLevel != null) {
        await model.settings.load(model.state!.ref);
        if (_disposed || !model.online) return;
        _requireScope();
      }
      if (initialModel case final choice?) {
        final currentChoice = model.settings.models
            .where((row) => row.id == choice.id && row.available)
            .firstOrNull;
        if (currentChoice == null) {
          throw const DeviceLinkException(
            'This model is no longer available. Return home and choose another model.',
          );
        }
        await model.settings.selectModel(model.state!.ref, currentChoice);
      }
      if (_disposed || !model.online) return;
      _requireScope();
      if (thinkingLevel case final level?) {
        final tab = model.state!.tab;
        final effort = RemoteComposerEffort.resolve(
          catalog: model.settings.models,
          modelId: initialModel?.id ?? tab['model'] as String?,
          executionHarness:
              initialModel?.harness ?? tab['executionHarness'] as String?,
          providerType:
              initialModel?.provider ?? tab['providerType'] as String?,
          level: level,
        );
        if (effort.levels.isNotEmpty) {
          await model.settings.patch(model.state!.ref, {
            'thinkingLevel': effort.level,
          });
        }
      }
      if (_disposed || !model.online) return;
      _requireScope();
      if (initialModel != null || thinkingLevel != null) {
        await model.chats.refresh();
      }
      if (_disposed || !model.online) return;
      _requireScope();
      // Home's files upload before the chat is shown, so a refusal keeps
      // this creation view with its error and Retry, and the chat composer
      // cannot send the text without them.
      await _uploadAttachments();
      if (_disposed || !model.online) return;
      _requireScope();
      model.setDraft(draft);
      model.activity.setWorkspaceKind(project.id, project.type);
      _ready = true;
      _changed();
    } catch (error) {
      if (!_disposed) {
        _creationNotSent =
            error is DeviceChatCreationNotSent ||
            (worktree != null && error is DesktopIpcNotSent);
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
    _sendRequested = true;
    _sending = true;
    _changed();
    await prepare();
    if (_disposed || !_ready) {
      _sending = false;
      _changed();
      return;
    }
    final model = controller.chats;
    // The draft and send act on the selected chat: the first message must
    // reach the chat this attempt created or opened.
    if (model.state?.ref.key != _target!.key) {
      _ready = false;
      _preparation = null;
      _error = 'This chat is no longer open. Retry to send your message to it.';
      _sending = false;
      _changed();
      return;
    }
    var sent = false;
    try {
      final paths = [
        for (final draft in attachments) _uploaded[draft.localId]!,
      ];
      model.setDraft(text);
      _delivery.track(_target!, text);
      // Spent once the request may reach the computer, even if this attempt
      // closes meanwhile: an accepted or uncertain send, and its delivery
      // retry, name these paths.
      _uploadsSpent = true;
      final result = await model.chats.send(text, attachmentPaths: paths);
      sent = true;
      for (final draft in attachments) {
        unawaited(
          model.attachmentThumbnails.retain(
            attachmentId: _uploaded[draft.localId]!,
            mediaType: draft.mediaType,
            bytes: draft.bytes,
          ),
        );
      }
      if (attachments.isNotEmpty) onAttachmentsSent?.call(attachments);
      if (result == DeviceChatSendOutcome.accepted &&
          model.draft.trim() == text) {
        model.setDraft('');
      }
    } catch (error) {
      // A throw from the send means the computer does not have the message,
      // so nothing names the uploads; a closed attempt deletes them now.
      if (!sent) {
        _uploadsSpent = false;
        if (_disposed) _deleteUploads();
        // Only this view's Retry can send an edited prompt; the chat screen
        // resends the same one, whose confirmation clears Home's draft.
        if (attachments.isNotEmpty) _delivery.release();
      }
      if (!_disposed) {
        // The chat's own composer cannot carry Home's files, so return to
        // this view, whose Retry resends them.
        if (attachments.isNotEmpty) {
          _ready = false;
          _preparation = null;
        }
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

  /// Uploads each Home file not yet stored in the target, one at a time.
  /// Throws a [DeviceLinkException] naming a refused file.
  Future<void> _uploadAttachments() async {
    final uploader = DeviceChatAttachmentUploader(
      controller.chats.attachments,
      _target!,
    );
    for (final draft in attachments) {
      if (_uploaded.containsKey(draft.localId)) continue;
      try {
        final stored = await uploader.upload(
          filename: draft.filename,
          mediaType: draft.mediaType,
          bytes: draft.bytes,
        );
        if (_disposed) {
          // This attempt is gone; nothing will send the late copy.
          _deleteUpload(uploader, stored.attachmentId);
          return;
        }
        _uploaded[draft.localId] = stored.attachmentId;
      } catch (cause) {
        final reason = cause is ChatAttachmentUploadException
            ? cause.reason
            : null;
        throw DeviceLinkException(
          'Could not attach ${draft.filename}. ${reason ?? 'Try again.'}',
        );
      }
    }
  }

  void _deleteUploads() {
    final target = _target;
    if (target == null) return;
    final uploader = DeviceChatAttachmentUploader(
      controller.chats.attachments,
      target,
    );
    for (final id in _uploaded.values) {
      _deleteUpload(uploader, id);
    }
  }

  /// Best effort: a copy left behind only takes space in the chat's folder.
  static void _deleteUpload(DeviceChatAttachmentUploader uploader, String id) =>
      unawaited(uploader.delete(id).then((_) {}, onError: (Object _) {}));

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    if (!_uploadsSpent) _deleteUploads();
    if (_ownsDelivery) _delivery.dispose();
    controller.chats.removeListener(_changed);
    super.dispose();
  }
}
