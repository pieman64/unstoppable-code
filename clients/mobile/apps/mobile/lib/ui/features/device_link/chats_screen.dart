import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/ui/core/chat/widgets/voice_composer_binding.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'computer_connect/activity_drawer.dart';
import 'package:mobile/ui/core/chat/widgets/queued_messages_status.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';
import 'package:mobile/device_link/chats/presentation.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/ui/core/chat/widgets/chat_provisioning.dart';
import 'package:mobile/ui/core/chat/widgets/chat_tabs_sheet.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/services/platform_attachment_picker.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_thumbnail_scope.dart';
import 'package:mobile/ui/core/chat/widgets/chat_attachment_input.dart';
import 'chats_view_model.dart';
import 'computer_connect/chat_controls.dart';
import 'device_chat_attachment_uploader.dart';

/// Shown on the attach control while the computer is unreachable.
const String kDeviceAttachmentsNeedReconnect =
    'Reconnect to your computer to attach files.';

/// Remote Control's shared chat presentation, backed by device-link state.
class DeviceChatScreen extends StatefulWidget {
  const DeviceChatScreen({
    super.key,
    required this.model,
    this.locationLabel,
    this.worktree,
    this.speechRecognizer,
    this.attachmentPicker,
  });
  final DeviceChatsViewModel model;
  final SpeechRecognizer? speechRecognizer;

  /// Device pickers behind the composer's attach control. Null uses
  /// [PlatformAttachmentPicker].
  final AttachmentPicker? attachmentPicker;
  final String? locationLabel;
  final WorktreeActivityContext? worktree;
  @override
  State<DeviceChatScreen> createState() => _DeviceChatScreenState();
}

class _DeviceChatScreenState extends State<DeviceChatScreen>
    with WidgetsBindingObserver {
  late final _composer = TextEditingController(text: widget.model.draft);
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  late final _locationTarget = widget.model.state?.ref;
  final _expanded = <String>{};
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _composer.addListener(_draftChanged);
    widget.model.addListener(_syncAttachments);
    _syncAttachments();
    // Android may have killed the app while a picker was open.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_attachments?.recoverLostMedia());
    });
    unawaited(widget.model.loadSettings());
  }

  /// Files staged for the selected chat. A chat's files are stored in its
  /// scope's attachments folder on the computer, and stay with that chat.
  ChatAttachmentController? _attachments;
  String? _attachmentsKey;

  void _syncAttachments() {
    final ref = widget.model.state?.ref;
    // Keep staged files while a reconnect clears the selection.
    if (ref == null || ref.key == _attachmentsKey) return;
    final previous = _attachments;
    if (previous != null) _discardAttachments(previous);
    _attachmentsKey = ref.key;
    _attachments = ChatAttachmentController(
      uploader: DeviceChatAttachmentUploader(widget.model.attachments, ref),
      picker: widget.attachmentPicker ?? PlatformAttachmentPicker(),
      prepareUpload: _prepareAttachmentUpload,
    )..addListener(_onAttachmentsChanged);
  }

  /// Runs before each upload, so a retried file waits for the connection.
  Future<void> _prepareAttachmentUpload() async {
    if (!widget.model.online) {
      throw const DeviceLinkException(kDeviceAttachmentsNeedReconnect);
    }
  }

  void _discardAttachments(ChatAttachmentController attachments) {
    attachments.removeListener(_onAttachmentsChanged);
    unawaited(attachments.discardAll().whenComplete(attachments.dispose));
  }

  /// Surfaces a staging issue or an upload failure once; the strip can be
  /// scrolled out of view.
  void _onAttachmentsChanged() {
    final attachments = _attachments;
    if (attachments == null || !mounted) return;
    final issue = attachments.takeIssue();
    final message =
        attachments.takeUploadError() ??
        (issue == null ? null : chatAttachmentIssueMessage(issue));
    if (message == null) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _send({required bool dictated}) async {
    final attachments = _attachments;
    final drafts = attachments?.takeForSend() ?? const [];
    final sent = await widget.model.send(
      dictated: dictated,
      attachments: drafts,
    );
    if (sent || attachments == null || drafts.isEmpty) return;
    attachments.restore(drafts);
    // The chat changed while sending: its files go with its discarded strip.
    if (!identical(_attachments, attachments)) {
      unawaited(attachments.discardAll());
    }
  }

  bool _routeVisible = false, _drawerOpen = false;
  AppLifecycleState? _lifecycle;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _routeVisible = ModalRoute.isCurrentOf(context) ?? true;
    _lifecycle = WidgetsBinding.instance.lifecycleState;
    _syncVisibility();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _lifecycle = state;
    _syncVisibility();
  }

  void _syncVisibility() => widget.model.setTranscriptVisible(
    _routeVisible &&
        !_drawerOpen &&
        (_lifecycle == null || _lifecycle == AppLifecycleState.resumed),
  );

  void _draftChanged() => widget.model.setDraft(_composer.text);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.model.setTranscriptVisible(false);
    widget.model.removeListener(_syncAttachments);
    if (_attachments case final attachments?) _discardAttachments(attachments);
    // A send still in flight then discards its files if it is refused.
    _attachments = null;
    _composer.removeListener(_draftChanged);
    _composer.dispose();
    super.dispose();
  }

  void _syncDraft() {
    final text = widget.model.draft;
    if (_composer.text != text) {
      _composer.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
    }
  }

  void _tabs() {
    final model = widget.model;
    unawaited(
      showChatTabsSheet(
        context,
        summaries: model.tabs,
        selectedChatId: model.state?.ref.id,
        chatState: model,
        resolveLiveState: () => ChatTabsLiveState(
          working: {
            for (final tab in model.tabs)
              if (model.state!.scope.running(tab.id)) tab.id,
          },
          unread: {
            for (final tab in model.tabs)
              if (model.state!.scope.tab(tab.id)['unread'] == true) tab.id,
          },
          needsAnswer: {
            for (final tab in model.tabs)
              if (model.state!.scope.needsInput(tab.id)) tab.id,
          },
        ),
        onSelect: (id) {
          final ref = model.tabs.where((t) => t.id == id).firstOrNull;
          if (ref != null && ref.key != model.state?.ref.key) {
            unawaited(model.open(ref));
          }
        },
        onNewChat: model.online && !model.creating
            ? () => unawaited(model.newTab())
            : null,
        onClose: model.online ? (id) => unawaited(model.closeTab(id)) : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.model,
    builder: (context, _) {
      final model = widget.model;
      final state = model.state;
      final providedWorktree = widget.worktree;
      final worktree = state == null
          ? null
          : providedWorktree?.workspaceLocalId == state.ref.projectId &&
                providedWorktree?.localId == state.ref.worktreeId
          ? providedWorktree
          : const [
              'single-repo',
              'multi-repo',
            ].contains(model.activity.workspaceKind(state.ref.projectId))
          ? WorktreeActivityContext(
              workspaceLocalId: state.ref.projectId,
              localId: state.ref.worktreeId,
            )
          : null;
      _syncDraft();
      final questions = state?.scope.pendingQuestions(state.ref.id) ?? [];
      // Like Remote Control, only a chat with nothing to show yet presents
      // loading; refreshes behind an existing transcript stay silent.
      final transcriptLoading =
          model.chats.loading &&
          (state == null || (state.messages.isEmpty && questions.isEmpty));
      final notices = <Widget>[
        if (!model.online)
          _notice(
            model.connection.reconnecting
                ? 'Reconnecting… Your draft is kept.'
                : 'Connection lost. Your draft is kept.',
            action: model.connection.reconnecting
                ? null
                : CanopyButton(
                    label: 'Reconnect',
                    onPressed: model.connection.reconnect,
                    variant: CanopyButtonVariant.inline,
                  ),
          ),
        if (model.chats.pendingSend == null)
          if ((model.error ?? model.chats.error) case final String error)
            _notice(error),
        if (!model.chats.sending &&
            model.chats.pendingSend?.ref.key == state?.ref.key &&
            model.chats.pendingSend != null)
          _notice(
            model.chats.error ??
                'Delivery is not confirmed. Check before sending again.',
            action: Wrap(
              children: [
                CanopyButton(
                  label: 'Check delivery',
                  onPressed: model.online && !model.chats.loading
                      ? model.refreshChat
                      : null,
                  variant: CanopyButtonVariant.inline,
                ),
                CanopyButton(
                  label: 'Retry same message',
                  onPressed: model.online && !model.chats.sending
                      ? () => model.send(retry: true)
                      : null,
                  variant: CanopyButtonVariant.inline,
                ),
              ],
            ),
          ),
        if (!model.chats.sending &&
            model.chats.pendingSend != null &&
            model.chats.pendingSend!.ref.key != state?.ref.key)
          _notice(
            'Another chat has an unconfirmed message. Open it to check delivery.',
            action: CanopyButton(
              label: 'Open original chat',
              onPressed: model.online && !model.chats.loading
                  ? () {
                      final pending = model.chats.pendingSend;
                      if (pending != null) unawaited(model.open(pending.ref));
                    }
                  : null,
              variant: CanopyButtonVariant.inline,
            ),
          ),
        if (state?.closed == true)
          _notice('This chat is no longer open on your computer.'),
        if (state?.hasPendingDecision == true && questions.isEmpty)
          _notice('This turn needs a response on your computer.'),
        if (state?.runtimeError case final error?) _notice(error),
        if (model.settingsError case final error?)
          _notice(
            error,
            action: CanopyButton(
              label: 'Retry models',
              onPressed: model.loadSettings,
              variant: CanopyButtonVariant.inline,
            ),
          ),
      ];
      final hasTabs = model.tabs.isNotEmpty;
      return CanopyScaffold(
        scaffoldKey: _scaffoldKey,
        onEndDrawerChanged: (open) {
          _drawerOpen = open;
          _syncVisibility();
          if (open && state != null) unawaited(model.activity.load(state.ref));
        },
        endDrawer: worktree == null || state == null
            ? null
            : DeviceActivityDrawer(
                repository: model.activity,
                ref: state.ref,
                worktree: worktree,
                online: model.online,
              ),
        appBar: CanopyAppBar(
          automaticallyImplyLeading: true,
          content: Text(
            state?.title ?? 'Chat',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: ChatLocationSubtitle(
            glyph: CanopyGlyph.macbook,
            location: 'Computer chat',
            text:
                _locationTarget?.projectId == state?.ref.projectId &&
                    _locationTarget?.worktreeId == state?.ref.worktreeId
                ? widget.locationLabel
                : null,
            computer: model.connection.host?['name'] as String?,
          ),
          trailing: worktree != null
              ? CanopyIconButton(
                  key: const ValueKey('open-activity'),
                  glyph: CanopyGlyph.sidebar,
                  tooltip: 'Activity & files',
                  onPressed: () => _scaffoldKey.currentState?.openEndDrawer(),
                )
              : null,
        ),
        body: Builder(
          builder: (context) => Padding(
            // Only the feed scrolls under the app bar; loading centers below it.
            padding: CanopyScaffold.contentPaddingOf(
              context,
            ).copyWith(top: notices.isEmpty && !transcriptLoading ? 0 : null),
            child: ChatBody(
              transcript: LayoutBuilder(
                builder: (context, constraints) => Column(
                  children: [
                    if (notices.isNotEmpty)
                      ConstrainedBox(
                        // Cap tall notices without reserving unused flex space.
                        constraints: BoxConstraints(
                          maxHeight: constraints.maxHeight / 2,
                        ),
                        child: SingleChildScrollView(
                          child: Column(children: notices),
                        ),
                      ),
                    Expanded(
                      child: Stack(
                        children: [
                          if (transcriptLoading)
                            const Positioned.fill(
                              child: ChatTranscriptLoading(
                                key: ValueKey('device-transcript-loading'),
                                label: 'Loading conversation…',
                              ),
                            )
                          else if (state != null)
                            Positioned.fill(
                              child: AttachmentThumbnailScope(
                                thumbnails: model.attachmentThumbnails,
                                child: ChatFeed(
                                  key: ValueKey(
                                    'device-chat-transcript-${state.ref.key}',
                                  ),
                                  chatId: state.ref.id,
                                  topContentInset: notices.isEmpty
                                      ? CanopyScaffold.contentPaddingOf(
                                          context,
                                        ).top
                                      : 0,
                                  bottomActionInset: hasTabs
                                      ? CanopyOverlayAction.stackOffset
                                      : 0,
                                  messages: deviceChatPresentation(
                                    state.ref.id,
                                    state.messages,
                                  ),
                                  expandedTurns: _expanded,
                                  turnInProgress: state.running,
                                  onToggleTurn: (id) => setState(() {
                                    if (!_expanded.remove(id)) {
                                      _expanded.add(id);
                                    }
                                  }),
                                  onLoadOlder:
                                      state.before != null && model.online
                                      ? () => unawaited(model.chats.loadOlder())
                                      : null,
                                  loadingOlder: model.chats.loadingOlder,
                                  trailing: [
                                    if ((state.runtime['queuedMessageIds']
                                                as List? ??
                                            [])
                                        .isNotEmpty)
                                      QueuedMessagesStatus(
                                        key: const ValueKey(
                                          'device-queued-messages',
                                        ),
                                        count:
                                            (state.runtime['queuedMessageIds']
                                                    as List)
                                                .length,
                                      ),
                                    for (final question in questions)
                                      PendingQuestionCard(
                                        key: ValueKey(
                                          'question-${question.requestId}',
                                        ),
                                        request: question,
                                        onSubmit:
                                            model.online && !model.deciding
                                            ? (answers) => unawaited(
                                                model.answer(
                                                  question.requestId,
                                                  answers,
                                                ),
                                              )
                                            : null,
                                        onDismiss: () => unawaited(
                                          model.dismissQuestion(
                                            question.requestId,
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          if (hasTabs)
                            Positioned(
                              right: CanopyOverlayAction.gutter,
                              bottom: 0,
                              child: ChatTabsFab(
                                hasUnread: state!.scope.tabs.any(
                                  (t) => t['unread'] == true,
                                ),
                                needsAnswer: model.tabs.any(
                                  (t) => state.scope.needsInput(t.id),
                                ),
                                onPressed: _tabs,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              composer: SingleChildScrollView(
                reverse: true,
                child: VoiceComposerBinding(
                  draft: _composer,
                  target: state?.ref.key,
                  active: model.online && state?.closed != true,
                  recognizer: widget.speechRecognizer,
                  builder: (context, voice) => ChatInput(
                    key: const ValueKey('device-chat-composer'),
                    controller: _composer,
                    sending: model.chats.sending,
                    enabled: model.canSend,
                    hintText: model.chats.pendingSend != null
                        ? 'Check delivery before sending…'
                        : null,
                    voice: voice,
                    voiceEnabled: model.online && state?.closed != true,
                    onSend: () {
                      final dictated = voice.dictated;
                      unawaited(voice.abandon());
                      unawaited(_send(dictated: dictated));
                    },
                    controls: deviceComposerControls(model),
                    actionsEnabled: model.online,
                    attachments: switch (_attachments) {
                      final attachments? => chatInputAttachmentsFor(
                        attachments,
                      ),
                      null => null,
                    },
                    attachmentsUnavailableReason: model.online
                        ? null
                        : kDeviceAttachmentsNeedReconnect,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
  Widget _notice(String text, {Widget? action}) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InlineNotice(glyph: CanopyGlyph.circleInfo, state: text),
        ?action,
      ],
    ),
  );
}
