import 'dart:async';

import 'package:mobile/ui/features/remote/view_models/remote_draft_first_send.dart';
import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/models/chat_destination_store.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/ui/core/chat/view_models/new_chat_draft_carry.dart';
import 'package:mobile/ui/core/chat/widgets/new_chat_draft_pill.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_workspace_section.dart';
import 'package:mobile/ui/composition/new_chat/chat_destination.dart';
import 'package:mobile/ui/composition/new_chat/new_chat_project_sheet.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_new_chat_draft.dart';
import 'package:provider/provider.dart';

/// The home shell's new chat (CAN-2932): a draft that runs on Cloud or on a
/// paired computer. As on web, the project pill above the composer lists
/// every destination's projects in one list, and the project decides where
/// the chat runs; the header says where.
///
/// The choice belongs to this draft alone; nothing else in the app changes
/// with it. A draft opens on the destination of the last chat started on
/// this device, or on Cloud when that computer is no longer paired. Moving
/// to another destination carries the typed text; when the move was not a
/// project pick, the project of the same name is selected there, if any.
///
/// Cloud drafts are [CloudChatScreen.create]. A computer's draft is
/// [RemoteNewChatDraft]; its first send opens [RemoteChatScreen.create] in
/// place, which creates the chat on the computer and sends the draft.
class NewChatDraft extends StatefulWidget {
  const NewChatDraft({
    super.key,
    this.isActive = true,
    this.onLeave,
    this.onChatCreated,
    this.onFirstSendPendingChanged,
    this.onRemoteFirstSendPendingChanged,
    this.onAddComputer,
    this.speechRecognizer,
  });

  final bool isActive;

  /// See [CloudChatScreen.onLeave].
  final VoidCallback? onLeave;

  /// Called once the draft's first send has started its chat.
  final VoidCallback? onChatCreated;

  /// See [CloudChatScreen.onFirstSendPendingChanged].
  final ValueChanged<bool>? onFirstSendPendingChanged;

  /// A computer first send needs its hosted screen until enqueue completes.
  final ValueChanged<bool>? onRemoteFirstSendPendingChanged;

  /// Opens pairing; null hides "Add a computer".
  final VoidCallback? onAddComputer;

  /// Speech engine behind the composer mic, for tests.
  final SpeechRecognizer? speechRecognizer;

  @override
  State<NewChatDraft> createState() => _NewChatDraftState();
}

class _NewChatDraftState extends State<NewChatDraft> {
  final NewChatDraftCarry _carry = NewChatDraftCarry();
  late final ChatDestinationStore? _store;

  /// The destination the user picked in this draft.
  String? _pickedId;

  /// The last started chat's destination, once read.
  String? _storedId;

  /// Whether the store answered. Until then no draft mounts, so a saved
  /// Cloud draft is never carried to the remembered computer on launch.
  late bool _storeRead = _store == null;

  /// The destination the visible draft screen was built for.
  String? _shownId;

  /// Set once the first send started a chat; the destination is then fixed.
  RemoteWorkspace? _startedWorkspace;
  String? _startedBaseWorktreeId;
  RemoteDraftFirstSend? _firstSend;
  bool _cloudStarted = false;
  bool _cloudSendPending = false;

  DraftProjectSelection? _currentSelection;

  VoidCallback? _releaseRemoteVisibility;

  @override
  void initState() {
    super.initState();
    // The project list includes Cloud's projects even while a computer's
    // draft is shown. Post-frame: loading notifies synchronously.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(context.read<CloudChatsViewModel>().load());
    });
    _store = Provider.of<ChatDestinationStore?>(context, listen: false);
    final store = _store;
    if (store != null) {
      unawaited(
        store.read().catchError((Object _) => null).then((id) {
          if (!mounted) return;
          setState(() {
            _storedId = id;
            _storeRead = true;
          });
        }),
      );
    }
  }

  @override
  void didUpdateWidget(NewChatDraft oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncRemoteVisibility();
  }

  @override
  void dispose() {
    _firstSend?.dispose();
    widget.onFirstSendPendingChanged?.call(false);
    _releaseRemoteVisibility?.call();
    _releaseRemoteVisibility = null;
    super.dispose();
  }

  /// A computer chat started here keeps the Remote Control overview
  /// reconciling while it is the visible destination, as a pushed Remote
  /// Control chat route does.
  void _syncRemoteVisibility() {
    if (_startedWorkspace != null && widget.isActive) {
      _releaseRemoteVisibility ??= context
          .read<RemoteControlViewModel>()
          .beginRemoteRouteVisibility();
    } else {
      _releaseRemoteVisibility?.call();
      _releaseRemoteVisibility = null;
    }
  }

  bool get _locked =>
      _startedWorkspace != null || _cloudStarted || _cloudSendPending;

  List<ComputerChatDestination> _computers(RemoteControlViewModel remote) =>
      pairedComputers(
        connection: remote.connection,
        status: remote.portalConnectionStatus,
      );

  bool _restoring(RemoteControlViewModel remote) =>
      remote.connection == null &&
      (remote.isRestoring || !remote.hasProbedSession);

  ChatDestination _resolve(RemoteControlViewModel remote, String? id) =>
      resolveChatDestination(
        id: id,
        computers: _computers(remote),
        restoring: _restoring(remote),
      );

  /// Moves the draft to [id], carrying what was typed, and selects
  /// [projectId] there when it is given.
  void _show(String id, {String? projectId}) {
    if (id == _shownId) return;
    _carry.handOver(projectId: projectId);
    setState(() => _shownId = id);
  }

  /// Every destination's projects, Cloud's first, as web lists them.
  List<NewChatProject> _projects(RemoteControlViewModel remote) {
    final colors = AppColors.of(context);
    final computers = _computers(remote);
    final computerProjects = computers.isEmpty
        ? const <RemoteWorkspace>[]
        : RemoteContextScope(
            context.read<WorkspaceContext?>(),
            remote.workspaces,
          ).workspaces;
    return [
      for (final workspace in context.read<CloudChatsViewModel>().workspaces)
        (
          destination: const CloudChatDestination(),
          id: workspace.externalId,
          name: workspace.name,
          icon: CloudProjectIcon(color: workspace.color),
        ),
      for (final computer in computers)
        for (final workspace in computerProjects)
          (
            destination: computer,
            id: workspace.localId,
            name: workspace.name,
            icon: CanopyIcon(
              glyph: CanopyGlyph.folderFilled,
              size: 14,
              tint: colors.foregroundSecondary,
            ),
          ),
    ];
  }

  Future<void> _openProjects(
    ChatDestination shown,
    DraftProjectSelection selection,
  ) async {
    final remote = context.read<RemoteControlViewModel>();
    final choice = await showNewChatProjectSheet(
      context,
      projects: _projects(remote),
      selectedKey: switch (selection.id) {
        final id? => newChatProjectKey(shown, id),
        null => null,
      },
      // One computer can be paired today; another needs CAN-4425.
      canAddComputer:
          widget.onAddComputer != null && _computers(remote).isEmpty,
    );
    if (!mounted || _locked) return;
    switch (choice) {
      case PickedNewChatProject(:final project):
        final available = _projects(remote).any(
          (current) =>
              current.destination.id == project.destination.id &&
              current.id == project.id,
        );
        if (!available) return;
        _pickedId = project.destination.id;
        if (project.destination.id == _shownId) {
          _currentSelection?.select(project.id);
        } else {
          _show(project.destination.id, projectId: project.id);
        }
      case AddComputerChoice():
        widget.onAddComputer?.call();
      case null:
        break;
    }
  }

  /// The project pill for a draft shown on [shown].
  DraftProjectPillBuilder _projectPill(ChatDestination shown) =>
      (context, selection) {
        _currentSelection = selection;
        final name = selection.name;
        return NewChatDraftPill(
          key: const ValueKey('new-chat-project-pill'),
          icon:
              selection.icon ??
              CanopyIcon(
                glyph: CanopyGlyph.folderFilled,
                size: 14,
                tint: AppColors.of(context).foregroundSecondary,
              ),
          label: name ?? 'Choose project',
          semanticLabel: 'Project, ${name ?? 'none chosen'}',
          onPressed: _locked || !selection.enabled
              ? null
              : () => unawaited(_openProjects(shown, selection)),
        );
      };

  void _startOnComputer(
    RemoteWorkspace workspace,
    String? baseWorktreeId,
    RemoteChatSendOptions? sendOptions,
    String destinationId,
  ) {
    unawaited(_store?.write(destinationId));
    setState(() {
      _startedWorkspace = workspace;
      _startedBaseWorktreeId = baseWorktreeId;
      _firstSend =
          RemoteDraftFirstSend(sendOptions, () {
              if (!mounted) return;
              widget.onFirstSendPendingChanged?.call(false);
              widget.onChatCreated?.call();
            })
            ..onPendingChanged = (pending) {
              if (mounted) {
                widget.onRemoteFirstSendPendingChanged?.call(pending);
              }
            };
    });
    _syncRemoteVisibility();
    widget.onFirstSendPendingChanged?.call(true);
    _firstSend?.begin();
  }

  void _cloudChatCreated() {
    unawaited(_store?.write(CloudChatDestination.cloudId));
    _cloudStarted = true;
    widget.onChatCreated?.call();
  }

  void _cloudSendPendingChanged(bool pending) {
    if (mounted && pending != _cloudSendPending) {
      setState(() => _cloudSendPending = pending);
    }
    widget.onFirstSendPendingChanged?.call(pending);
  }

  @override
  Widget build(BuildContext context) {
    if (_startedWorkspace case final workspace?) {
      return RemoteChatScreen.create(
        key: const ValueKey('new-chat-started-on-computer'),
        workspace: workspace,
        baseWorktreeId: _startedBaseWorktreeId,
        firstSend: _firstSend,
        isActive: widget.isActive,
        speechRecognizer: widget.speechRecognizer,
      );
    }
    final remote = context.watch<RemoteControlViewModel>();
    if (!_storeRead) return const Scaffold(body: SizedBox.shrink());
    final target = _resolve(remote, _pickedId ?? _storedId);
    final shownId = _shownId ??= target.id;
    if (!_locked && target.id != shownId) {
      // After this frame, so the visible draft hands its text over before
      // it is replaced.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _locked) return;
        _show(
          _resolve(
            context.read<RemoteControlViewModel>(),
            _pickedId ?? _storedId,
          ).id,
        );
      });
    }
    final shown = shownId == CloudChatDestination.cloudId
        ? const CloudChatDestination()
        : _shownComputer(remote, shownId);
    final projectPill = _projectPill(shown);
    return switch (shown) {
      CloudChatDestination() => CloudChatScreen.create(
        key: const ValueKey('new-chat-cloud-draft'),
        isActive: widget.isActive,
        speechRecognizer: widget.speechRecognizer,
        onLeave: widget.onLeave,
        onChatCreated: _cloudChatCreated,
        onFirstSendPendingChanged: _cloudSendPendingChanged,
        projectPill: projectPill,
        carry: _carry,
      ),
      ComputerChatDestination(:final name, :final availability) =>
        RemoteNewChatDraft(
          key: ValueKey('new-chat-computer-draft-$shownId'),
          computerName: name,
          isActive: widget.isActive,
          projectPill: projectPill,
          carry: _carry,
          speechRecognizer: widget.speechRecognizer,
          unavailableMessage: switch (availability) {
            ComputerAvailability.online => null,
            ComputerAvailability.offline =>
              '$name is offline. Open ${Brand.productDisplayName} on that '
                  'computer to send.',
            ComputerAvailability.connecting => 'Connecting to $name…',
          },
          onReconnect: availability == ComputerAvailability.offline
              ? () => unawaited(remote.refresh())
              : null,
          onStart: (workspace, baseWorktreeId, sendOptions) =>
              _startOnComputer(workspace, baseWorktreeId, sendOptions, shownId),
        ),
    };
  }

  /// The shown computer as it is now; while it is no longer paired it stays
  /// on screen as offline until the draft moves to Cloud after this frame.
  ComputerChatDestination _shownComputer(
    RemoteControlViewModel remote,
    String id,
  ) {
    final resolved = _resolve(remote, id);
    if (resolved is ComputerChatDestination) return resolved;
    return ComputerChatDestination(
      name: ComputerChatDestination.nameFromId(id) ?? id,
      availability: ComputerAvailability.offline,
    );
  }
}
