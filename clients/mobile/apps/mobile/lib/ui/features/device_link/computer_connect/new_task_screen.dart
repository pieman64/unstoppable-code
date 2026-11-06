import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/ui/core/chat/widgets/chat_provisioning.dart';
import '../chats_screen.dart';
import 'controller.dart';
import 'new_task_model.dart';

/// The same chat-first creation flow as mobile Remote Control. Code projects
/// provision on entry; flat projects create their entry on the first send.
class DeviceNewTaskScreen extends StatefulWidget {
  const DeviceNewTaskScreen({
    super.key,
    required this.controller,
    required this.project,
  });
  final ComputerConnectController controller;
  final DeviceProject project;
  @override
  State<DeviceNewTaskScreen> createState() => _DeviceNewTaskScreenState();
}

class _DeviceNewTaskScreenState extends State<DeviceNewTaskScreen> {
  final _draft = TextEditingController();
  late final DeviceNewTaskModel _model;
  @override
  void initState() {
    super.initState();
    _model = DeviceNewTaskModel(widget.controller, widget.project);
    _draft.addListener(() => _model.draft = _draft.text);
    if (!_model.flat) unawaited(_model.prepare());
  }

  @override
  void dispose() {
    _model.dispose();
    _draft.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _model,
    builder: (context, _) => _build(context),
  );

  Widget _build(BuildContext context) {
    final model = widget.controller.chats;
    if (_model.ready) {
      return DeviceChatScreen(
        model: model,
        locationLabel: _model.created?.name ?? widget.project.name,
        worktree: _model.created == null
            ? null
            : WorktreeActivityContext(
                workspaceLocalId: _model.created!.projectId,
                localId: _model.created!.id,
              ),
      );
    }
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('New chat'),
        subtitle: ChatLocationSubtitle(
          glyph: CanopyGlyph.macbook,
          location: 'Computer chat',
          text: widget.project.name,
          computer: model.connection.host?['name'] as String?,
        ),
      ),
      // The scaffold's insets are only visible below it.
      body: Builder(
        builder: (context) => Padding(
          padding: CanopyScaffold.contentPaddingOf(context),
          child: ChatBody(
            transcript: _model.error != null
                ? ChatCreationFailed(
                    message: _model.error!,
                    onRetry: _model.canRetryCreation
                        ? () => unawaited(_model.retryCreation())
                        : null,
                  )
                : !_model.flat || _model.sending
                ? ChatTranscriptLoading(
                    label: _model.attempt.worktreeId == null
                        ? 'Creating worktree…'
                        : 'Setting up worktree…',
                    labelKey: const ValueKey('creating-worktree-status'),
                  )
                : const ChatEmptyTranscript(isNewChat: true),
            composer: ChatInput(
              controller: _draft,
              sending: _model.sending,
              enabled: model.online && _model.error == null,
              onSend: () => unawaited(_model.send()),
              voiceEnabled: false,
              actionsEnabled: false,
              hintText: 'Message the agent…',
            ),
          ),
        ),
      ),
    );
  }
}
