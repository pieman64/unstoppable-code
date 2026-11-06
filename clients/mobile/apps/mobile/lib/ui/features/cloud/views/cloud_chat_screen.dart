import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/services/platform_attachment_picker.dart';
import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/services/speech_to_text_recognizer.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'package:mobile/ui/core/chat/view_models/thinking_levels.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_model_lock.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_attachment_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/view_models/new_chat_draft_carry.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';
import 'package:mobile/ui/core/chat/widgets/voice_dictation_dialog.dart';
import 'package:mobile/ui/features/cloud/view_models/client_ids.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_attachment_uploader.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_attachment_view_model.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_chat_attachment_input.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_composer_command_source.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_composer_plugins_source.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_unsent_records.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_chat_row.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_notice_banner.dart';
import 'package:mobile/ui/core/chat/widgets/new_chat_draft_header.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_workspace_section.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/chat/chat_prompt_host.dart';
import 'package:provider/provider.dart';

/// One cloud conversation (CAN-3143): transcript, composer, ask-user cards,
/// Stop while a turn runs, in-place continuation on the next send, and the
/// Rename/Archive overflow.
///
/// Structured like `RemoteChatScreen` but owns none of its Portal
/// reconciliation: the ambient [CloudChatViewModel] is bound to [chatId] on
/// mount and every transcript, liveness, and outbox fact is read from it.
/// Leaving the screen does not close the session, so a turn left running
/// keeps streaming and the list can still show it as working.
class CloudChatScreen extends StatefulWidget {
  const CloudChatScreen({
    super.key,
    required String this.chatId,
    this.speechRecognizer,
    this.attachmentPicker,
    this.now = DateTime.now,
    this.isActive = true,
    this.onLeave,
  }) : initialWorkspaceId = null,
       onChatCreated = null,
       onFirstSendPendingChanged = null,
       projectPill = null,
       carry = null;

  /// A chat that does not exist yet: the composer opens ready to type under a
  /// project selector, and nothing is created until the first send. The
  /// created chat then binds in place, so the draft never jumps routes.
  /// [initialWorkspaceId] preselects a project; otherwise the first one is.
  ///
  /// Pass [onLeave] to mount the draft as the home shell's Chat destination
  /// (CAN-2930) rather than as a pushed route; see [onLeave].
  ///
  /// The home shell's draft also passes its [projectPill], which lists every
  /// destination's projects, and a [carry] that moves the draft between
  /// destinations (CAN-2932).
  const CloudChatScreen.create({
    super.key,
    this.initialWorkspaceId,
    this.speechRecognizer,
    this.attachmentPicker,
    this.now = DateTime.now,
    this.onLeave,
    this.onChatCreated,
    this.onFirstSendPendingChanged,
    this.isActive = true,
    this.projectPill,
    this.carry,
  }) : chatId = null;

  /// The chat this screen shows; null for [CloudChatScreen.create].
  final String? chatId;

  /// Project preselected by [CloudChatScreen.create].
  final String? initialWorkspaceId;

  /// Speech engine behind the composer mic. Null uses the `speech_to_text`
  /// plugin; tests inject a scripted recognizer.
  final SpeechRecognizer? speechRecognizer;

  /// Device pickers behind the `+` sheet's attachment rows. Null uses the
  /// platform pickers; tests inject scripted picks.
  final AttachmentPicker? attachmentPicker;

  /// Clock for persisted first-message timestamps.
  final DateTime Function() now;

  /// Whether this screen is the visible tab. Pushed chat routes remain active
  /// by default; the home shell updates this while keeping tabs mounted.
  final bool isActive;

  /// Non-null when the screen is the home shell's Chat destination instead of
  /// a pushed route: a new-chat draft, or an existing chat opened from the
  /// drawer's Recents. The app bar then leads with the menu button, the
  /// composer does not grab focus on launch, and every exit that would pop
  /// the route (archive, a scope reset, the shared session moving to another
  /// chat) calls this so the shell can show a fresh draft.
  final VoidCallback? onLeave;

  /// Called once the draft's first send has created its chat.
  final VoidCallback? onChatCreated;

  /// Reports first-chat creation so the shell can open another draft while
  /// the first prompt is pending.
  final ValueChanged<bool>? onFirstSendPendingChanged;

  /// The project selector above the draft's composer, replacing the app
  /// bar's project picker; null keeps the picker.
  final DraftProjectPillBuilder? projectPill;

  /// Brings in a draft typed for another destination, and hands this one
  /// over when the destination changes.
  final NewChatDraftCarry? carry;

  @override
  State<CloudChatScreen> createState() => _CloudChatScreenState();
}

class _CloudChatScreenState extends State<CloudChatScreen>
    with WidgetsBindingObserver {
  final TextEditingController _composer = TextEditingController();
  late final VoiceDictationController _voice;

  /// Files staged for the next message. A draft has no chat to upload to,
  /// so its picks stay staged until the first send creates one.
  late final ChatAttachmentController _attachments;

  late final CloudChatAttachmentViewModel _attachmentFlow;
  final Set<String> _expandedTurns = {};

  /// Thinking level and Fast mode the user touched on this screen. Cloud
  /// chats carry both on each send rather than persisting them, so an
  /// untouched value stays null and the server keeps the chat's own setting.
  String? _thinking;
  bool? _fast;
  String? _pendingModelId;

  /// An Auto choice not yet confirmed (or kept by a draft until it is
  /// created). A pending model choice means manual.
  bool _pendingAuto = false;
  int _modelSelectionGeneration = 0;

  /// Ask-user requests answered or dismissed here, hidden immediately so a
  /// second tap cannot send the same answer twice while the post is in
  /// flight. The mapper clears them for good once the turn is accepted.
  final Set<String> _settledQuestions = {};

  bool _preparingSend = false;
  bool _openedSession = false;
  bool _leavingAfterSessionReset = false;
  late final int _scopeGeneration;

  /// The chat created by this screen's first send ([CloudChatScreen.create]).
  String? _createdChatId;

  /// Keeps one composer across the draft and the chat it creates, so a sheet
  /// the composer opened keeps following the screen.
  final GlobalKey _composerKey = GlobalKey();

  /// Project picked in the draft; null falls back to the initial or first.
  String? _draftWorkspaceId;

  /// The project name a draft carried from another destination brought.
  /// When it matches no cloud project, none is selected until the user
  /// picks one.
  String? _carriedProjectName;
  bool _carried = false;

  late final ChatDraftStore _draftStore;
  late final ComposerDraftBinding _drafts;

  /// The first message of this new chat while its create is unconfirmed.
  CloudUnsentRecord? _pendingCreate;

  /// [CloudChatsViewModel.pendingCreatesInFlight] as of the last pending
  /// create lookup; a change means another screen's create finished.
  Set<String> _seenCreatesInFlight = const {};

  /// Null while the screen is still a draft with no chat behind it.
  String? get _chatId => widget.chatId ?? _createdChatId;

  @override
  void initState() {
    super.initState();
    _scopeGeneration = context.read<CloudChatsViewModel>().scopeGeneration;
    _draftStore = maybeChatDraftStore(context) ?? InMemoryChatDraftStore();
    _drafts = ComposerDraftBinding(controller: _composer, store: _draftStore);
    if (widget.chatId case final chatId?) {
      _drafts.bind(CloudChatDraftTarget(chatId));
    } else if (widget.carry case final carry?) {
      if (carry.take() case final carried?) {
        _carried = true;
        _carriedProjectName = carried.projectName;
        _draftWorkspaceId = carried.projectId;
        _composer.text = carried.text;
      }
      carry.attach(_handOver);
    }
    WidgetsBinding.instance.addObserver(this);
    _voice = VoiceDictationController(
      draft: _composer,
      recognizer: widget.speechRecognizer ?? SpeechToTextRecognizer(),
    )..addListener(_onVoiceChanged);
    final repository = context.read<CloudChatViewModel>().repository;
    _attachments = ChatAttachmentController(
      uploader: switch (widget.chatId) {
        final chatId? => CloudChatAttachmentUploader(repository, chatId),
        null => null,
      },
      picker: widget.attachmentPicker ?? PlatformAttachmentPicker(),
    )..addListener(_onAttachmentsChanged);
    _attachmentFlow = CloudChatAttachmentViewModel(
      session: context.read<CloudChatViewModel>(),
      list: context.read<CloudChatsViewModel>(),
      attachments: _attachments,
      drafts: _drafts,
    );
    // Post-frame: `open` notifies synchronously, which the route's first
    // build forbids.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_attachments.recoverLostMedia());
      final list = context.read<CloudChatsViewModel>();
      unawaited(list.ensureModels());
      final chatId = widget.chatId;
      if (chatId == null) {
        // The draft needs the projects. As the shell's landing screen it can
        // be the first cloud surface built; `load` is a no-op once loaded.
        unawaited(
          list.load().then((_) {
            if (mounted) _syncDraftTarget(list);
          }),
        );
        return;
      }
      final session = context.read<CloudChatViewModel>();
      final active = session.state;
      session.open(
        chatId,
        cursorEpoch: active?.chatId == chatId
            ? active!.cursorEpoch
            : list.chatById(chatId)?.coreAgentSessionId ?? '',
      );
      _openedSession = true;
    });
  }

  @override
  void didUpdateWidget(CloudChatScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isActive && !widget.isActive) {
      unawaited(_voice.abandon());
    }
  }

  @override
  void dispose() {
    widget.carry?.detach(_handOver);
    WidgetsBinding.instance.removeObserver(this);
    _voice.removeListener(_onVoiceChanged);
    // Close the microphone before the draft goes away; a late final result
    // has nowhere to land.
    unawaited(_voice.abandon());
    _voice.dispose();
    // Unsent uploads are deleted on the way out; the controller is disposed
    // once they are.
    _attachmentFlow.dispose();
    _attachments.removeListener(_onAttachmentsChanged);
    unawaited(_attachments.discardAll().whenComplete(_attachments.dispose));
    _drafts.dispose();
    _composer.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(_voice.abandon());
    }
  }

  /// Surfaces a dictation issue once: guidance dialogs for blocked or
  /// missing recognition, a snackbar for a transient stop.
  void _onVoiceChanged() {
    final issue = _voice.takeIssue();
    if (issue == null || !mounted) return;
    if (issue == VoiceDictationIssue.failed) {
      _snack('Voice dictation stopped. Try again.');
      return;
    }
    unawaited(showVoiceDictationIssueDialog(context, issue));
  }

  /// Surfaces a staging issue or an upload failure once. The failed chip
  /// keeps its own copy of the upload error, but the strip can be scrolled
  /// out of view, so the failure is announced too.
  void _onAttachmentsChanged() {
    final issue = _attachments.takeIssue();
    final uploadError = _attachments.takeUploadError();
    if (!mounted) return;
    if (uploadError != null) _snack(uploadError);
    if (issue != null) _snack(chatAttachmentIssueMessage(issue));
  }

  void _snack(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  static String _describe(Object error, String fallback) => switch (error) {
    CloudApiException(:final message) => message,
    CloudSendError(:final message) => message,
    _ => fallback,
  };

  // ---- Composer ----

  /// The chat's model: the retained record's, a pending pick, the saved
  /// model, then the catalog default. The catalog may no longer list it.
  String? _modelId(
    CloudChatsViewModel list,
    CloudChatSummary? summary,
    CloudSendPayload? retained,
  ) =>
      retained?.modelDefinitionId ??
      _pendingModelId ??
      summary?.modelDefinitionId ??
      list.defaultModelId;

  ModelOption? _selectedModel(
    CloudChatsViewModel list,
    CloudChatSummary? summary,
    CloudSendPayload? retained,
  ) {
    final id = _modelId(list, summary, retained);
    return list.models.where((model) => model.id == id).firstOrNull;
  }

  /// The chat model's effort levels; empty hides effort and omits it from
  /// sends. A model the catalog no longer lists gets the provider fallback,
  /// never the default model's levels. Core's harness binding for this chat
  /// picks that fallback before the row's harness or provider; a draft has
  /// no binding, whatever chat the session still holds.
  List<String> _thinkingLevels(
    CloudChatViewModel session,
    CloudChatsViewModel list,
    CloudChatSummary? summary,
    CloudSendPayload? retained,
  ) {
    final chatId = _chatId;
    final bound = chatId != null && session.state?.chatId == chatId
        ? session.state?.executionHarness
        : null;
    final selected = _selectedModel(list, summary, retained);
    return resolveThinkingLevels(
      list.models,
      _modelId(list, summary, retained),
      bound ?? selected?.harness ?? selected?.provider,
    );
  }

  bool _autoSelected(CloudChatSummary? summary, CloudSendPayload? retained) =>
      retained?.autoModel ??
      (_pendingAuto ||
          (_pendingModelId == null && (summary?.modelAuto ?? false)));

  /// The payload of the unsent record this chat or draft still holds: the
  /// draft's pending create, or a send the server may still hold. A resend
  /// replays it unchanged, so the chip shows its selection and takes no new
  /// choice until the record settles or is discarded.
  CloudSendPayload? _retainedSelection(CloudChatViewModel session) {
    final chatId = _chatId;
    if (chatId == null) return _pendingCreate?.payload;
    return session.state?.chatId == chatId
        ? session.retainedSend?.payload
        : null;
  }

  ComposerControlsData _composerControls({
    required CloudChatViewModel session,
    required CloudChatsViewModel list,
    required CloudChatSummary? summary,
    required bool isRunning,
  }) {
    final retained = _retainedSelection(session);
    final selected = _selectedModel(list, summary, retained);
    final modelId =
        retained?.modelDefinitionId ??
        selected?.id ??
        summary?.modelDefinitionId;
    final providerType = selected?.provider;
    final levels = _thinkingLevels(session, list, summary, retained);
    final supportsFast = selected?.supportsFastMode ?? false;
    final fast = supportsFast && (_fast ?? summary?.fastMode ?? false);
    return ComposerControlsData(
      providerType: providerType,
      modelLabel: selected?.label ?? modelId,
      selectedModelId: modelId,
      availableModels: list.models,
      providerAvailability: null,
      planMode: null,
      effort: levels.isEmpty
          ? null
          : EffortControl(
              level: clampThinkingLevelTo(
                _thinking ?? summary?.thinkingLevel ?? 'off',
                levels,
              ),
              levels: levels,
              onSelect: (level) async {
                setState(() => _thinking = level);
                return true;
              },
            ),
      speed: fast ? CanopyEffortSpeed.fast : CanopyEffortSpeed.regular,
      supportsFastMode: supportsFast,
      isRunning: isRunning,
      onSelectModel: retained != null
          ? null
          : (id) => unawaited(_selectModel(list, id)),
      onToggleFast: () => setState(() => _fast = !fast),
      onStop: () => unawaited(session.interrupt()),
      catalogStatus: list.modelsLoaded
          ? ModelCatalogStatus.loaded
          : list.modelsError != null
          ? ModelCatalogStatus.failed
          : ModelCatalogStatus.loading,
      onRetryCatalog: () => unawaited(list.ensureModels()),
      lockedHarness: _chatId == null
          ? null
          : cloudLockedHarness(
              boundHarness: session.state?.executionHarness,
              messages: session.messages,
              modelHarnesses: list.modelHarnesses,
            ),
      auto: ModelAutoControl(
        selected: _autoSelected(summary, retained),
        onSelect: () => unawaited(_selectAuto(list)),
      ),
    );
  }

  Future<void> _selectModel(CloudChatsViewModel list, String id) =>
      _persistSelection(id, () => list.setModel(_chatId!, id));

  Future<void> _selectAuto(CloudChatsViewModel list) =>
      _persistSelection(null, () => list.setAutoModel(_chatId!));

  /// Shows a model ([modelId]) or Auto (null) at once, then persists it. A
  /// draft keeps the pick locally; the chat is created with it.
  Future<void> _persistSelection(
    String? modelId,
    Future<void> Function() persist,
  ) async {
    // A picker opened before the record was retained can still call back.
    if (_retainedSelection(context.read<CloudChatViewModel>()) != null) return;
    final generation = ++_modelSelectionGeneration;
    setState(() {
      _pendingModelId = modelId;
      _pendingAuto = modelId == null;
    });
    if (_chatId == null) return;
    try {
      await persist();
    } catch (error) {
      if (!mounted || generation != _modelSelectionGeneration) return;
      _snack(_describe(error, "Couldn't change the model. Please try again."));
    } finally {
      if (mounted && generation == _modelSelectionGeneration) {
        setState(() {
          _pendingModelId = null;
          _pendingAuto = false;
        });
      }
    }
  }

  CloudSendPayload _payload(
    String text,
    CloudChatViewModel session,
    CloudChatsViewModel list,
  ) {
    final chatId = _chatId;
    final summary = chatId == null ? null : list.chatById(chatId);
    final retained = _retainedSelection(session);
    final selected = _selectedModel(list, summary, retained);
    final currentThinking = _thinking ?? summary?.thinkingLevel ?? 'off';
    final levels = _thinkingLevels(session, list, summary, retained);
    final shownThinking = clampThinkingLevelTo(currentThinking, levels);
    return CloudSendPayload(
      text: text,
      modelDefinitionId:
          retained?.modelDefinitionId ??
          selected?.id ??
          summary?.modelDefinitionId,
      thinkingLevel: levels.isEmpty
          ? null
          : _thinking != null || shownThinking != currentThinking
          ? shownThinking
          : null,
      fastMode: (selected?.supportsFastMode ?? false) ? _fast : null,
      autoModel: _autoSelected(summary, retained),
    );
  }

  /// Whether a turn may go to [chatId] now: the session still holds it, the
  /// account scope is the one this screen opened in, and no model or Auto
  /// choice for it is still saving.
  bool _canPostTo(
    CloudChatViewModel session,
    CloudChatsViewModel list,
    String chatId,
  ) =>
      session.state?.chatId == chatId &&
      list.scopeGeneration == _scopeGeneration &&
      !list.isSelectionSavePending(chatId);

  Future<void> _send(
    CloudChatViewModel session,
    CloudChatsViewModel list,
  ) async {
    if (_composer.text.trim().isEmpty ||
        _preparingSend ||
        !_attachments.canSend) {
      return;
    }
    final chatId = _chatId;
    final summary = chatId == null ? null : list.chatById(chatId);
    if (summary?.modelDefinitionId == null && list.defaultModelId == null) {
      setState(() => _preparingSend = true);
      try {
        await list.ensureModels();
      } finally {
        if (mounted) setState(() => _preparingSend = false);
      }
      if (!mounted || list.scopeGeneration != _scopeGeneration) return;
      if (!list.modelsLoaded) {
        _snack(
          list.modelsError ?? "Couldn't load available models. Try again.",
        );
        return;
      }
    }
    // The composer stays editable while models load; send what it holds now.
    final text = _composer.text.trim();
    if (text.isEmpty) return;
    if (chatId == null) {
      return _attachments.isEmpty &&
              !_attachmentFlow.hasPendingCreateFor(
                _draftWorkspace(list)?.externalId,
              )
          ? _createAndSend(session, list, text)
          : _createForAttachments(session, list);
    }
    // The session may have closed or moved to another chat while models
    // loaded; keep the text rather than send it elsewhere or erase it.
    if (!_canPostTo(session, list, chatId)) return;
    if (_attachmentFlow.send(_payload(text, session, list))) {
      _clearSentComposer();
    }
  }

  void _clearSentComposer() {
    unawaited(_voice.abandon());
    _composer.clear();
  }

  /// The draft's project: the one picked here, else the preselected one, else
  /// the first. Falls through when a picked project has since disappeared.
  /// A draft carried from another destination takes its project's namesake
  /// instead of the first, or none (CAN-2932).
  CloudWorkspaceSummary? _draftWorkspace(CloudChatsViewModel list) {
    final workspaces = list.workspaces;
    for (final id in [_draftWorkspaceId, widget.initialWorkspaceId]) {
      if (id == null) continue;
      final match = workspaces.where((w) => w.externalId == id).firstOrNull;
      if (match != null) return match;
    }
    if (!_carried) return workspaces.firstOrNull;
    final name = _carriedProjectName?.toLowerCase();
    if (name == null) return null;
    return workspaces.where((w) => w.name.toLowerCase() == name).firstOrNull;
  }

  /// Hands this draft to another destination's draft screen.
  CarriedDraft _handOver() {
    unawaited(_voice.abandon());
    final carried = (
      text: _composer.text,
      projectName: _draftWorkspace(context.read<CloudChatsViewModel>())?.name,
      projectId: null,
    );
    final release = _drafts.retainForHandoff();
    widget.carry?.preserveSource(release);
    return carried;
  }

  Future<void> _pickDraftWorkspace(CloudChatsViewModel list) async {
    final id = await showCloudProjectPickerSheet(
      context,
      list.workspaces,
      selectedId: _draftWorkspace(list)?.externalId,
    );
    if (id == null || !mounted) return;
    setState(() => _draftWorkspaceId = id);
    _syncDraftTarget(list);
  }

  /// Where the composer's text is saved: the chat, or the draft's project.
  DraftTarget? _draftTargetFor(CloudChatsViewModel list) {
    final chatId = _chatId;
    if (chatId != null) return CloudChatDraftTarget(chatId);
    final workspace = _draftWorkspace(list);
    return workspace == null
        ? null
        : CloudNewChatDraftTarget(workspace.externalId);
  }

  void _syncDraftTarget(CloudChatsViewModel list) {
    final next = _draftTargetFor(list);
    // Adopt, not bind: the draft is typeable before its project is known.
    if (next != null && next != _drafts.target) {
      final carry = widget.carry;
      if (carry == null) {
        _drafts.adopt(next);
      } else {
        carry.adoptStored(_drafts, next, _draftStore);
      }
    }
    if (_chatId == null) _adoptPendingCreate(list);
  }

  /// Shows this project's unconfirmed first message, or hands it to its chat
  /// when the create did land before the app closed.
  void _adoptPendingCreate(CloudChatsViewModel list) {
    if (!mounted) return;
    final inFlight = list.pendingCreatesInFlight;
    _seenCreatesInFlight = inFlight;
    if (_pendingCreate?.status == UnsentStatus.sending) return;
    final workspace = _draftWorkspace(list);
    if (workspace == null) return;
    final record = cloudPendingCreates(
      _draftStore,
      workspace.externalId,
    ).where((r) => !inFlight.contains(r.clientRequestId)).firstOrNull;
    if (record == null) {
      if (_pendingCreate != null) setState(() => _pendingCreate = null);
      return;
    }
    final externalId = record.externalId;
    if (externalId != null && list.chatById(externalId) != null) {
      final recovered = record.copyWith(
        chatId: externalId,
        status: UnsentStatus.uncertain,
      );
      _draftStore.putUnsent(recovered.toUnsentRecord());
      context.read<CloudChatViewModel>().adoptRecoveredUnsent(recovered);
      if (_pendingCreate != null) setState(() => _pendingCreate = null);
      return;
    }
    final shown = record.status == UnsentStatus.sending
        ? record.copyWith(status: UnsentStatus.uncertain)
        : record;
    if (!identical(shown, record)) {
      _draftStore.putUnsent(shown.toUnsentRecord());
    }
    setState(() => _pendingCreate = shown);
  }

  /// The pending first message as a transcript row.
  ChatMessage? get _creatingMessage => switch (_pendingCreate) {
    null => null,
    final record => ChatMessage(
      messageId: 'creating',
      chatId: 'creating',
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: record.payload.text,
      delivery: switch (record.status) {
        UnsentStatus.sending => null,
        UnsentStatus.notSent => ChatDelivery.notSent,
        UnsentStatus.uncertain => ChatDelivery.uncertain,
      },
      deliveryNote: record.error,
    ),
  };

  /// First send of a draft: saves the prompt as a pending create, then
  /// creates the chat in the selected project with the picked model, binds
  /// the shared session to it here, and sends. A failed create leaves the
  /// prompt as a `Not sent` row with Resend and Discard; the create reuses
  /// the record's chat id, so a retry never makes a second chat.
  Future<void> _createAndSend(
    CloudChatViewModel session,
    CloudChatsViewModel list,
    String text,
  ) async {
    final workspace = _draftWorkspace(list);
    if (workspace == null || _waitForQueuedTurn(session)) return;
    final record = CloudUnsentRecord.pendingCreate(
      workspaceId: workspace.externalId,
      externalId: randomUuidV4(),
      clientRequestId: randomUuidV4(),
      payload: _payload(text, session, list),
      createdAt: widget.now(),
      pluginSelections: _draftStore.draftSelectionsFor(
        CloudNewChatDraftTarget(workspace.externalId),
      ),
    );
    _draftStore.putUnsent(
      record.toUnsentRecord(),
      clearDraft: CloudNewChatDraftTarget(workspace.externalId),
    );
    unawaited(_voice.abandon());
    _composer.clear();
    await _runPendingCreate(session, list, record);
  }

  /// [record] as the store holds it now, while it is still a pending create.
  /// Another draft screen may have created its chat (turning it into that
  /// chat's record) or discarded it since this row was shown; the stale row
  /// is then cleared and nothing in the store is touched.
  CloudUnsentRecord? _currentPendingCreate(CloudUnsentRecord record) {
    final stored = switch (_draftStore.unsentById(
      cloudUnsentRecordId(record.clientRequestId),
    )) {
      final value? => CloudUnsentRecord.fromRecord(value),
      null => null,
    };
    if (stored != null && stored.isPendingCreate) return stored;
    if (mounted && _pendingCreate?.clientRequestId == record.clientRequestId) {
      setState(() => _pendingCreate = null);
    }
    return null;
  }

  /// First send of a draft that holds attachments. Uploads need a chat, so
  /// the chat is created first, as on the web, while the composer keeps the
  /// text and the files. A failed create leaves both for another Send, which
  /// reuses the same chat id. Once the chat exists the screen binds to it,
  /// uploads the files there, and sends when every one is ready; a failed
  /// upload waits on the strip with Retry.
  ///
  /// Unlike [_createAndSend] nothing is written as a pending create: the
  /// picked files live only in memory, so a restored record could not send
  /// them.
  Future<void> _createForAttachments(
    CloudChatViewModel session,
    CloudChatsViewModel list,
  ) async {
    final workspace = _draftWorkspace(list);
    if (workspace == null || _waitForQueuedTurn(session)) return;
    setState(() => _preparingSend = true);
    widget.onFirstSendPendingChanged?.call(true);
    final scope = list.scopeGeneration;
    try {
      await _attachmentFlow.createAndSend(
        workspaceId: workspace.externalId,
        selection: _payload('', session, list),
        pluginSelections: _draftStore.draftSelectionsFor(
          CloudNewChatDraftTarget(workspace.externalId),
        ),
        canBind: () =>
            mounted && widget.isActive && !_waitForQueuedTurn(session),
        onBound: (chat) {
          setState(() {
            _createdChatId = chat.externalId;
            _openedSession = true;
            _pendingModelId = null;
            _pendingAuto = false;
          });
          widget.onFirstSendPendingChanged?.call(false);
          widget.onChatCreated?.call();
        },
        currentPayload: () => _payload(_composer.text.trim(), session, list),
        onSent: _clearSentComposer,
      );
    } catch (error) {
      if (mounted && list.scopeGeneration == scope) {
        _snack(_describe(error, "Couldn't create the chat. Please try again."));
      }
    } finally {
      if (mounted && list.scopeGeneration == scope) {
        setState(() => _preparingSend = false);
        widget.onFirstSendPendingChanged?.call(false);
      }
    }
  }

  /// Binding closes the chat the session holds; never drop its queued turn.
  bool _waitForQueuedTurn(CloudChatViewModel session) {
    final active = session.state;
    if (active == null || active.outbox.isEmpty) return false;
    _snack('Wait for the queued message to send before starting another chat.');
    return true;
  }

  Future<void> _runPendingCreate(
    CloudChatViewModel session,
    CloudChatsViewModel list,
    CloudUnsentRecord shown,
  ) async {
    // A callback kept from before an account reset must not read or create
    // anything in the new account.
    if (list.scopeGeneration != _scopeGeneration ||
        list.pendingCreatesInFlight.contains(shown.clientRequestId)) {
      return;
    }
    final record = _currentPendingCreate(shown);
    if (record == null) return;
    final workspaceId = record.workspaceId;
    final externalId = record.externalId;
    if (workspaceId == null ||
        externalId == null ||
        _waitForQueuedTurn(session)) {
      return;
    }
    final active = session.state;
    final sending = record.copyWith(
      status: UnsentStatus.sending,
      clearError: true,
    );
    _draftStore.putUnsent(sending.toUnsentRecord());
    final scopeGeneration = list.scopeGeneration;
    if (mounted) setState(() => _pendingCreate = sending);
    widget.onFirstSendPendingChanged?.call(true);
    list.markCreateInFlight(record.clientRequestId);
    CloudChatSummary? chat;
    Object? failure;
    try {
      chat = await list.createChat(
        workspaceId,
        externalId: externalId,
        modelDefinitionId: record.payload.modelDefinitionId,
        autoModel: record.payload.autoModel,
        pluginSelections: record.pluginSelections,
      );
    } catch (error) {
      failure = error;
    }
    if (list.scopeGeneration != scopeGeneration) {
      list.clearCreateInFlight(record.clientRequestId);
      return;
    }
    if (chat == null) {
      final failed = sending.copyWith(
        status: UnsentStatus.notSent,
        error: failure == null
            ? null
            : _describe(failure, "Couldn't create the chat. Please try again."),
      );
      _draftStore.putUnsent(failed.toUnsentRecord());
      // Written first, so a draft screen that looks again finds the failure.
      list.clearCreateInFlight(record.clientRequestId);
      if (!mounted) return;
      setState(() => _pendingCreate = failed);
      widget.onFirstSendPendingChanged?.call(false);
      return;
    }
    final chatId = chat.externalId;
    final current = session.state;
    if (!widget.isActive ||
        (widget.onLeave != null && !mounted) ||
        current?.chatId != active?.chatId ||
        (current != null &&
            current.chatId != chatId &&
            (current.outbox.isNotEmpty || !mounted))) {
      // The chat exists but this screen can no longer bind to it: keep the
      // prompt as that chat's draft.
      _draftStore.removeUnsent(cloudUnsentRecordId(record.clientRequestId));
      final target = CloudChatDraftTarget(chatId);
      final existing = _draftStore.draftFor(target);
      final text = record.payload.text;
      _draftStore.setDraft(
        target,
        existing.isEmpty ? text : '$text\n$existing',
      );
      list.clearCreateInFlight(record.clientRequestId);
      if (mounted) {
        setState(() => _pendingCreate = null);
        widget.onFirstSendPendingChanged?.call(false);
        if (widget.isActive) _snack('Your message is saved as a draft.');
      }
      return;
    }
    // The route may have been popped while creation was pending. The shared
    // session still owns the first send, so only the UI update needs mounted.
    // Sending under the record's id replaces the pending create with the
    // chat's own record.
    session.open(chatId, cursorEpoch: chat.coreAgentSessionId);
    session.send(
      clientRequestId: record.clientRequestId,
      payload: record.payload,
    );
    list.clearCreateInFlight(record.clientRequestId);
    if (!mounted) return;
    setState(() {
      _pendingCreate = null;
      _createdChatId = chatId;
      _openedSession = true;
      _pendingModelId = null;
      _pendingAuto = false;
    });
    // Anything typed while the chat was created stays in the composer and
    // becomes the new chat's draft.
    _drafts.rebind(CloudChatDraftTarget(chatId));
    unawaited(_attachmentFlow.bindAttachments(chatId));
    widget.onFirstSendPendingChanged?.call(false);
    widget.onChatCreated?.call();
  }

  /// Cloud has no structured answer route yet: the answer goes out as the
  /// next user turn, the same way the web client replies. Secret questions
  /// never reach this path (see [_SecretQuestionNotice]).
  void _answerQuestion(
    CloudChatViewModel session,
    CloudChatsViewModel list,
    AskUserQuestionState request,
    List<AskUserQuestionAnswer> answers,
  ) {
    // A card built for another chat or account, or while a choice saves,
    // keeps its answers and sends nothing.
    final chatId = _chatId;
    if (chatId == null || !_canPostTo(session, list, chatId)) return;
    setState(() => _settledQuestions.add(request.requestId));
    session.send(
      clientRequestId: randomUuidV4(),
      payload: _payload(formatAskUserAnswers(answers), session, list),
    );
  }

  // ---- Overflow ----

  Future<void> _rename(CloudChatsViewModel list, String chatId) async {
    final current = list.chatById(chatId)?.title ?? '';
    final title = await showDialog<String>(
      context: context,
      builder: (dialogContext) => _RenameDialog(initial: current),
    );
    if (title == null || !mounted) return;
    try {
      await list.rename(chatId, title.isEmpty ? null : title);
    } catch (error) {
      if (!mounted) return;
      _snack(_describe(error, "Couldn't rename the chat. Please try again."));
    }
  }

  Future<void> _archive(CloudChatsViewModel list, String chatId) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Archive this chat?'),
        content: const Text(
          'It moves to the archive and stops appearing in your cloud chats.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const ValueKey('cloud-archive-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Archive'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await list.archive(chatId);
      if (!mounted) return;
      final session = context.read<CloudChatViewModel>();
      if (session.state?.chatId == chatId) {
        _leavingAfterSessionReset = true;
        session.close();
      }
      _leave();
    } catch (error) {
      if (!mounted) return;
      _snack(
        _describe(error, "Couldn't archive the cloud session. Try again."),
      );
    }
  }

  /// Leaves the chat: pops the pushed route, or hands the shell's Chat
  /// destination back for a fresh draft.
  void _leave() {
    if (widget.onLeave case final onLeave?) {
      onLeave();
    } else {
      Navigator.of(context).pop();
    }
  }

  /// The shell's menu button when this is its Chat destination; otherwise
  /// null so a pushed route keeps its back button.
  Widget? _menuButton(BuildContext context) => widget.onLeave == null
      ? null
      : HomeMenuButton.maybeOf(context, designSystem: true);

  // ---- Build ----

  @override
  Widget build(BuildContext context) {
    final session = context.watch<CloudChatViewModel>();
    final list = context.watch<CloudChatsViewModel>();
    if (list.scopeGeneration != _scopeGeneration) {
      if (!_leavingAfterSessionReset) {
        _leavingAfterSessionReset = true;
        final draftRoute = ModalRoute.of(context);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          // Unbind first: leaving the old scope must not erase its draft.
          _drafts.bind(null);
          _composer.clear();
          _pendingCreate = null;
          _draftWorkspaceId = null;
          _pendingModelId = null;
          _pendingAuto = false;
          _thinking = null;
          _fast = null;
          final navigator = Navigator.of(context);
          if (draftRoute != null && draftRoute.isActive) {
            navigator.popUntil((route) => route == draftRoute);
          }
          if (widget.onLeave case final onLeave?) {
            onLeave();
          } else if (navigator.canPop()) {
            navigator.pop();
          }
        });
      }
      return const SizedBox.shrink();
    }
    final chatId = _chatId;
    if (chatId == null) {
      if (_draftTargetFor(list) != _drafts.target) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _syncDraftTarget(list);
        });
      } else if (!setEquals(
        list.pendingCreatesInFlight,
        _seenCreatesInFlight,
      )) {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _adoptPendingCreate(list),
        );
      }
      return _buildDraft(session, list);
    }
    final summary = list.chatById(chatId);
    final selectionSaving = list.isSelectionSavePending(chatId);
    // The session closed under a pushed route: leave it. In the shell the
    // session moving to any other chat counts too, since the shared session
    // holds one chat and silently rebinding could drop its queued turn.
    final sessionLeft = widget.onLeave == null
        ? session.state == null && Navigator.of(context).canPop()
        : session.state?.chatId != chatId;
    if (_openedSession && sessionLeft && !_leavingAfterSessionReset) {
      _leavingAfterSessionReset = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _leave();
      });
    }
    final bound = session.state?.chatId == chatId;
    final state = bound ? session.state : null;
    final messages = bound ? session.messages : const <ChatMessage>[];
    final isRunning = bound && session.turnInProgress;
    final loading =
        state == null ||
        (messages.isEmpty &&
            state.sessionStatus == CloudSessionStatus.unknown &&
            state.bootstrapError == null &&
            !isRunning);

    final pendingQuestions = bound
        ? session.pendingQuestions
              .where((q) => !_settledQuestions.contains(q.requestId))
              .toList(growable: false)
        : const <AskUserQuestionState>[];
    // Awaiting questions render as the tail of the transcript so they scroll
    // with the conversation instead of sitting on a fixed shelf.
    final trailing = <Widget>[
      for (final request in pendingQuestions)
        if (request.questions.any((q) => q.secret))
          _SecretQuestionNotice(
            key: ValueKey('cloud-secret-question-${request.requestId}'),
            onDismiss: () =>
                setState(() => _settledQuestions.add(request.requestId)),
          )
        else
          PendingQuestionCard(
            key: ValueKey('question-${request.requestId}'),
            request: request,
            onSubmit: selectionSaving
                ? null
                : (answers) => _answerQuestion(session, list, request, answers),
            onDismiss: () =>
                setState(() => _settledQuestions.add(request.requestId)),
          ),
    ];

    final failed = bound ? session.failedSends.entries.lastOrNull : null;
    // Ordinary failed sends speak through their row's delivery note with
    // Resend and Discard; only a failed continuation needs the banner.
    final sendError = failed != null && session.hasFailedContinuation
        ? failed
        : null;
    final bootstrapError = state?.bootstrapError;
    final visibleBootstrapError = session.hasFailedContinuation
        ? null
        : bootstrapError;
    final hasFeed = messages.isNotEmpty || trailing.isNotEmpty || isRunning;
    final showBootstrapBanner = visibleBootstrapError != null && hasFeed;
    final hasPinnedBanner =
        sendError != null ||
        showBootstrapBanner ||
        session.olderHistoryError != null;
    final waitingForModel =
        summary?.modelDefinitionId == null && list.modelsLoading;

    final Widget transcriptArea;
    if (hasFeed) {
      transcriptArea = Builder(
        builder: (context) => ChatFeed(
          chatId: chatId,
          topContentInset: hasPinnedBanner
              ? 0
              : CanopyScaffold.contentPaddingOf(context).top,
          messages: messages,
          onLoadOlder: session.hasMoreHistory
              ? () => unawaited(session.loadOlder())
              : null,
          loadingOlder: session.loadingOlder,
          expandedTurns: _expandedTurns,
          turnInProgress: isRunning,
          onToggleTurn: (key) => setState(() {
            if (!_expandedTurns.remove(key)) _expandedTurns.add(key);
          }),
          trailing: trailing,
          onResend: selectionSaving
              ? null
              : (id) {
                  if (_canPostTo(session, list, chatId)) {
                    session.resendMessage(
                      id,
                      fresh: (text) => _payload(text, session, list),
                    );
                  }
                },
          onDiscard: session.discardMessage,
        ),
      );
    } else if (visibleBootstrapError != null) {
      transcriptArea = _BootstrapError(
        message: visibleBootstrapError,
        onRetry: () => unawaited(session.refresh()),
      );
    } else if (loading) {
      transcriptArea = const _TranscriptLoading();
    } else {
      transcriptArea = const _EmptyTranscript();
    }

    final controls = bound
        ? _composerControls(
            session: session,
            list: list,
            summary: summary,
            isRunning: isRunning,
          )
        : null;
    final composer = ChatInput(
      key: _composerKey,
      controller: _composer,
      sending: _preparingSend || waitingForModel || selectionSaving,
      enabled:
          bound &&
          state?.bootstrapError == null &&
          !_preparingSend &&
          !waitingForModel,
      voiceEnabled: bound,
      controls: controls,
      commands: controls == null
          ? null
          : cloudChatCommandSource(
              list.composerCommands,
              chatId: chatId,
              modelDefinitionId: controls.selectedModelId,
            ),
      plugins: switch ((controls, list.workspaceForChat(chatId))) {
        (final controls?, final workspace?) => cloudChatPluginsSource(
          list.composerCommands,
          chatId: chatId,
          workspaceId: workspace.externalId,
          summarySelections: summary?.capabilitySelections,
          harness: controls.lockedHarness ?? controls.providerType,
        ),
        _ => null,
      },
      voice: _voice,
      attachments: cloudChatInputAttachmentsFor(_attachments),
      onSend: () => unawaited(_send(session, list)),
    );

    // Idle with a settled reply: when an end-of-turn prompt may open.
    final isQuiet =
        widget.isActive &&
        bound &&
        messages.isNotEmpty &&
        !isRunning &&
        !_preparingSend &&
        // No turn is running yet, but the chat is not idle.
        _retainedSelection(session) == null &&
        failed == null &&
        visibleBootstrapError == null &&
        // Not redundant: a failed continuation hides the bootstrap error
        // (visibleBootstrapError is null) while its send is still failing.
        !session.hasFailedContinuation &&
        session.olderHistoryError == null &&
        pendingQuestions.isEmpty;
    final secondary = AppColors.of(context).foregroundSecondary;
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        leading: _menuButton(context),
        content: Text(
          summary == null ? 'Chat' : cloudChatDisplayTitle(summary),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: ChatLocationSubtitle(
          glyph: CanopyGlyph.cloud,
          location: 'Cloud chat',
          text: list.workspaceForChat(chatId)?.name,
        ),
        trailing: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            MenuAnchor(
              builder: (context, controller, child) => CanopyIconButton(
                key: const ValueKey('cloud-chat-options'),
                glyph: CanopyGlyph.dotGrid1x3Horizontal,
                tooltip: 'Chat options',
                onPressed: () =>
                    controller.isOpen ? controller.close() : controller.open(),
              ),
              menuChildren: [
                MenuItemButton(
                  key: const ValueKey('cloud-chat-rename'),
                  leadingIcon: CanopyIcon(
                    glyph: CanopyGlyph.pencil,
                    tint: secondary,
                  ),
                  onPressed: () => unawaited(_rename(list, chatId)),
                  child: const Text('Rename'),
                ),
                MenuItemButton(
                  key: const ValueKey('cloud-chat-archive'),
                  leadingIcon: CanopyIcon(
                    glyph: CanopyGlyph.archive,
                    tint: secondary,
                  ),
                  onPressed: () => unawaited(_archive(list, chatId)),
                  child: const Text('Archive'),
                ),
              ],
            ),
          ],
        ),
      ),
      body: ChatPromptHost(
        isQuiet: isQuiet,
        child: Builder(
          builder: (context) => Padding(
            key: const ValueKey('cloud-chat-screen'),
            padding: CanopyScaffold.contentPaddingOf(context).copyWith(
              top: hasPinnedBanner || !hasFeed
                  ? CanopyScaffold.contentPaddingOf(context).top
                  : 0,
            ),
            child: Column(
              children: [
                if (sendError != null)
                  CloudNoticeBanner(
                    key: const ValueKey('cloud-send-error'),
                    message:
                        sendError.value.lastError?.message ??
                        'Could not send the message. Retry.',
                    retryKey: const ValueKey('cloud-send-error-retry'),
                    onRetry: selectionSaving
                        ? null
                        : () {
                            if (_canPostTo(session, list, chatId)) {
                              session.retrySend(
                                sendError.key,
                                fresh: (text) => _payload(text, session, list),
                              );
                            }
                          },
                  ),
                if (showBootstrapBanner)
                  CloudNoticeBanner(
                    key: const ValueKey('cloud-bootstrap-error'),
                    message: visibleBootstrapError,
                    onRetry: () => unawaited(session.refresh()),
                  ),
                if (session.olderHistoryError case final historyError?)
                  CloudNoticeBanner(
                    key: const ValueKey('cloud-older-history-error'),
                    message: historyError,
                    onRetry: () => unawaited(session.loadOlder()),
                  ),
                Expanded(
                  child: ChatBody(
                    transcript: transcriptArea,
                    composer: composer,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// [CloudChatScreen.create] before its first send: the project picker and
  /// title in the app bar, an empty prompt, and a composer ready to type.
  Widget _buildDraft(CloudChatViewModel session, CloudChatsViewModel list) {
    final workspace = _draftWorkspace(list);
    final workspacesError = list.workspaces.isEmpty ? list.error : null;
    // Until the first project list answers, "No project" would be wrong, so
    // the header shows the title alone. That includes the frame before the
    // load starts, when nothing has answered and nothing has failed yet, and
    // a brand-new account's first project being set up.
    final projectsLoading =
        list.workspaces.isEmpty &&
        (list.isLoading ||
            list.isFirstProjectDecisionPending ||
            list.isProvisioningFirstProject ||
            (list.cloudAvailable == null && list.error == null));
    final waitingForModel = list.modelsLoading && !list.modelsLoaded;
    final creating = _creatingMessage;
    final canSend =
        workspace != null &&
        !_preparingSend &&
        !waitingForModel &&
        creating == null;
    final controls = _composerControls(
      session: session,
      list: list,
      summary: null,
      isRunning: false,
    );
    final projectPill = widget.projectPill;
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        leading: _menuButton(context),
        // With the project pill above the composer, the header says where
        // the chat runs instead (CAN-2932).
        subtitle: projectPill == null
            ? null
            : const ChatLocationSubtitle(
                glyph: CanopyGlyph.cloud,
                location: 'Cloud chat',
                text: 'Cloud',
              ),
        content: NewChatDraftHeader(
          title: 'New chat',
          project:
              projectPill != null || projectsLoading || workspacesError != null
              ? null
              : NewChatDraftProjectButton(
                  key: const ValueKey('cloud-new-chat-project'),
                  name: workspace?.name,
                  onPressed:
                      _preparingSend ||
                          creating != null ||
                          list.workspaces.isEmpty
                      ? null
                      : () => unawaited(_pickDraftWorkspace(list)),
                ),
        ),
      ),
      body: Builder(
        builder: (context) => Padding(
          key: const ValueKey('cloud-new-chat-screen'),
          padding: CanopyScaffold.contentPaddingOf(context),
          child: ChatBody(
            transcript: workspacesError != null
                ? StateMessageView(
                    key: const ValueKey('cloud-new-chat-workspaces-error'),
                    glyph: CanopyGlyph.exclamationTriangle,
                    title: "Couldn't load projects",
                    message: workspacesError,
                    onRetry: list.refresh,
                  )
                : creating == null
                ? const _NewChatPrompt()
                : ChatFeed(
                    chatId: creating.chatId,
                    messages: [creating],
                    expandedTurns: const {},
                    turnInProgress: false,
                    onToggleTurn: (_) {},
                    onResend: (_) {
                      final record = _pendingCreate;
                      if (record != null) {
                        unawaited(_runPendingCreate(session, list, record));
                      }
                    },
                    onDiscard: (_) {
                      final shown = _pendingCreate;
                      if (shown == null) return;
                      final record = _currentPendingCreate(shown);
                      if (record == null) return;
                      _draftStore.removeUnsent(
                        cloudUnsentRecordId(record.clientRequestId),
                      );
                      setState(() => _pendingCreate = null);
                      // An older first message for this project shows
                      // next.
                      _adoptPendingCreate(list);
                    },
                  ),
            composer: ChatInput(
              key: _composerKey,
              controller: _composer,
              autofocus: widget.onLeave == null,
              sending: _preparingSend || waitingForModel,
              enabled: canSend,
              voiceEnabled: true,
              hintText: 'Message the agent…',
              header: projectPill == null
                  ? null
                  : Builder(
                      builder: (context) => projectPill(
                        context,
                        DraftProjectSelection(
                          id: workspace?.externalId,
                          name: workspace?.name,
                          icon: workspace == null
                              ? null
                              : CloudProjectIcon(color: workspace.color),
                          // Open while Cloud's projects load: the list
                          // also holds the computer's.
                          enabled: !_preparingSend && creating == null,
                          select: (id) {
                            setState(() => _draftWorkspaceId = id);
                            _syncDraftTarget(list);
                          },
                        ),
                      ),
                    ),
              controls: controls,
              commands: workspace == null
                  ? null
                  : cloudDraftCommandSource(
                      list.composerCommands,
                      drafts: _draftStore,
                      workspaceId: workspace.externalId,
                      modelDefinitionId: controls.selectedModelId,
                    ),
              plugins: workspace == null
                  ? null
                  : cloudDraftPluginsSource(
                      list.composerCommands,
                      drafts: _draftStore,
                      workspaceId: workspace.externalId,
                      harness: controls.providerType,
                    ),
              voice: _voice,
              attachments: cloudChatInputAttachmentsFor(_attachments),
              onSend: () => unawaited(_send(session, list)),
            ),
          ),
        ),
      ),
    );
  }
}

/// The plain-text turn a submitted ask-user card becomes: each question with
/// its picked options and any typed answer, so the agent (and anyone reading
/// the transcript on web) sees exactly what was chosen.
String formatAskUserAnswers(List<AskUserQuestionAnswer> answers) {
  final blocks = <String>[];
  for (final answer in answers) {
    final typed = answer.freeformText?.trim();
    final chosen = [
      ...answer.selectedOptions,
      if (typed != null && typed.isNotEmpty) typed,
    ];
    blocks.add(
      '${answer.question}\n'
      '${chosen.isEmpty ? '(no answer)' : chosen.join(', ')}',
    );
  }
  return blocks.join('\n\n');
}

class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});

  final String initial;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initial,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Rename chat'),
    content: TextField(
      key: const ValueKey('cloud-rename-field'),
      controller: _controller,
      autofocus: true,
      textInputAction: TextInputAction.done,
      decoration: const InputDecoration(hintText: 'Chat title'),
      onSubmitted: (value) => Navigator.of(context).pop(value.trim()),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FilledButton(
        key: const ValueKey('cloud-rename-save'),
        onPressed: () => Navigator.of(context).pop(_controller.text.trim()),
        child: const Text('Save'),
      ),
    ],
  );
}

/// Shown in place of the answer card when a question asks for a secret: a
/// plain user turn would persist the value in the transcript, so mobile
/// declines and points at the web app, which has the redacting path.
class _SecretQuestionNotice extends StatelessWidget {
  const _SecretQuestionNotice({super.key, required this.onDismiss});

  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(top: 8, bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'The agent is asking for a secret. Answer it on the web app, '
            'where the value stays out of the transcript.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 8),
          TextButton(onPressed: onDismiss, child: const Text('Dismiss')),
        ],
      ),
    );
  }
}

class _TranscriptLoading extends StatelessWidget {
  const _TranscriptLoading();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const LoadingSpinner(size: 20),
          const SizedBox(height: 12),
          Text(
            'Loading conversation…',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _BootstrapError extends StatelessWidget {
  const _BootstrapError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      key: const ValueKey('cloud-chat-bootstrap-error'),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CanopyIcon(
              glyph: CanopyGlyph.warningSign,
              tint: theme.colorScheme.error,
              size: 32,
            ),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const ValueKey('cloud-chat-retry'),
              onPressed: onRetry,
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}

class _NewChatPrompt extends StatelessWidget {
  const _NewChatPrompt();

  @override
  Widget build(BuildContext context) {
    return Center(
      key: const ValueKey('cloud-new-chat-prompt'),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'What would you like to do?',
          textAlign: TextAlign.center,
          style: AppTypography.heading.copyWith(
            color: AppColors.of(context).foreground,
          ),
        ),
      ),
    );
  }
}

class _EmptyTranscript extends StatelessWidget {
  const _EmptyTranscript();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      key: const ValueKey('cloud-chat-empty'),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'No messages yet. Send one to start the conversation.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}
