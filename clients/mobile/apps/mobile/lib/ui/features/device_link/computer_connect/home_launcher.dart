import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/delivery.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'controller.dart';
import 'home_model.dart';

final class ComputerHomeLaunch {
  const ComputerHomeLaunch({
    required this.project,
    required this.worktree,
    required this.baseBranch,
    required this.model,
    required this.thinkingLevel,
    required this.text,
    required this.delivery,
    required this.context,
  });
  final DeviceProject project;
  final DeviceWorktree? worktree;
  final String? baseBranch, thinkingLevel;
  final ModelOption? model;
  final String text;
  final DeviceChatDelivery delivery;
  final WorkspaceContext context;
}

final class _HomeDraft {
  _HomeDraft(this.target, ChatDraftStore store) {
    _binding = ComposerDraftBinding(controller: controller, store: store)
      ..bind(target);
  }
  final ComputerHomeDraftTarget target;
  final controller = TextEditingController();
  late ComposerDraftBinding _binding;
  void bindStore(ChatDraftStore store) {
    _binding.dispose();
    _binding = ComposerDraftBinding(controller: controller, store: store)
      ..adopt(target);
  }

  void dispose() {
    _binding.dispose();
    controller.dispose();
  }
}

/// One computer session owns launch admission, scoped durable drafts and delivery
/// observation. Replacing Home never releases an unresolved send or its draft.
final class ComputerHomeLauncher extends ChangeNotifier {
  ComputerHomeLauncher(this.controller, this.computerId, this._store) {
    controller.chats.addListener(_changed);
  }
  final ComputerConnectController controller;
  final String computerId;
  ChatDraftStore _store;
  final _drafts = <WorkspaceContext, _HomeDraft>{};
  DeviceChatDelivery? _delivery;
  bool _busy = false, _disposed = false;
  String? error;
  bool get busy => _busy;
  DeviceChatRef? get pendingRef => controller.chats.chats.pendingSend?.ref;

  TextEditingController draftFor(WorkspaceContext context) => _drafts
      .putIfAbsent(
        context,
        () => _HomeDraft(
          ComputerHomeDraftTarget(
            computerId: computerId,
            contextId: context.organizationId == null
                ? 'personal'
                : 'organization:${context.organizationId}',
          ),
          _store,
        ),
      )
      .controller;

  void bindDraftStore(ChatDraftStore store) {
    if (identical(store, _store)) return;
    _store = store;
    for (final draft in _drafts.values) {
      draft.bindStore(store);
    }
  }

  Future<ComputerHomeLaunch?> begin(ComputerChatHomeModel choices) async {
    if (_disposed ||
        _busy ||
        pendingRef != null ||
        !identical(choices.controller, controller) ||
        !choices.canStart) {
      return null;
    }
    final draft = draftFor(choices.context);
    if (draft.text.trim().isEmpty) return null;
    _busy = true;
    error = null;
    _changed();
    try {
      await choices.save();
      final saved = await _store.flush();
      if (_disposed || pendingRef != null || !choices.canStart) {
        _busy = false;
        _changed();
        return null;
      }
      if (!saved) {
        error =
            'The draft could not be saved. It may not survive an app restart.';
      }
      final text = draft.text;
      _delivery?.dispose();
      final delivery = DeviceChatDelivery(
        controller.chats.chats,
        onConfirmed: () {
          if (draft.text == text) draft.clear();
        },
        onChanged: _changed,
      );
      _delivery = delivery;
      controller.enterChat();
      return ComputerHomeLaunch(
        project: choices.project!,
        worktree: choices.worktree,
        baseBranch: choices.baseBranch,
        model: choices.models.where((m) => m.id == choices.modelId).firstOrNull,
        thinkingLevel: choices.thinkingLevel,
        text: text,
        delivery: delivery,
        context: choices.context,
      );
    } catch (_) {
      error = 'Could not prepare the chat. Try again.';
      _busy = false;
      _changed();
      return null;
    }
  }

  bool _allowed(DeviceChatRef ref, WorkspaceContext context) =>
      controller.active &&
      controller.chats.online &&
      !controller.scopePending &&
      controller
          .scopeFor(context)
          .projects
          .any((project) => project.id == ref.projectId);

  Future<DeviceChatRef?> resume(WorkspaceContext context) async {
    final ref = pendingRef;
    if (_disposed || _busy || ref == null) return null;
    if (!_allowed(ref, context)) {
      error = 'This chat is not available in the selected account context.';
      _changed();
      return null;
    }
    _busy = true;
    error = null;
    _changed();
    controller.enterChat();
    final opened = await controller.chats.open(ref);
    if (_disposed || !_allowed(ref, context) || !opened) {
      error =
          'Could not open the chat. Check the account context and try again.';
      await finish();
      return null;
    }
    return ref;
  }

  Future<void> finish() async {
    if (_disposed) return;
    try {
      await controller.chats.leaveChat();
      if (!_disposed) await controller.watchOverview();
    } finally {
      _busy = false;
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
    _delivery?.dispose();
    for (final draft in _drafts.values) {
      draft.dispose();
    }
    super.dispose();
  }
}
