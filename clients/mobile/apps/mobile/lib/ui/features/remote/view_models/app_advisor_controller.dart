import 'dart:async';
import 'dart:math';

import 'package:mobile/data/models/remote_app_advisor.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/chat_turn_liveness.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_app_advisor_commands.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'chat_transcript_store.dart';
import 'owned_command_registry.dart';
import 'remote_identity.dart';

/// How long the Advisor list waits for the desktop's snapshot.
const Duration kRemoteAppAdvisorHydrationTimeout = Duration(seconds: 30);

/// How long a new chat's first send waits for the desktop to name the chat.
const Duration kRemoteAppAdvisorFirstSendTimeout = Duration(seconds: 60);

const String kRemoteAppAdvisorHydrationFailed =
    "Couldn't load Orchestrator chats from the desktop. Try again.";

const String kRemoteAppAdvisorFirstSendUnconfirmed =
    "The desktop hasn't confirmed this message yet. Waiting for its response.";

const String _actionFailed = 'The desktop did not accept the request.';

/// The models an Advisor picker offers. [projected] is false when the
/// desktop has not described any yet.
typedef RemoteAppAdvisorCatalog = ({
  List<ModelOption> models,
  ProviderAvailability? providerAvailability,
  bool projected,
});

/// One App Advisor Work Entry: the desktop's Advisor nav row and its tabs.
final class RemoteAppAdvisorEntry {
  const RemoteAppAdvisorEntry({
    required this.key,
    required this.workEntryId,
    required this.title,
    required this.tabs,
    required this.activeChatId,
    required this.isRunning,
    required this.needsAnswer,
  });

  /// The Work Entry id, or the lone tab's chat id without one.
  final String key;
  final String? workEntryId;
  final String title;

  /// Tabs in desktop tab order. Never empty.
  final List<RemoteChatSummary> tabs;

  /// The Work Entry's selected tab on the desktop.
  final String activeChatId;
  final bool isRunning;
  final bool needsAnswer;
}

/// The paired desktop's App Advisor chats (CAN-3989): the projected Work
/// Entries and tabs, their transcripts and questions, and this client's
/// commands on them.
///
/// The desktop owns every Advisor chat. This controller mirrors its
/// projections, layers optimistic sends, tabs, and question resolutions on
/// top until the desktop confirms or rejects them, and reports desktop
/// rejections through [actionError].
final class RemoteAppAdvisorController {
  RemoteAppAdvisorController({
    required this.advisorCommands,
    required this.commands,
    required this.isConnected,
    required this.notify,
    this.hydrationTimeout = kRemoteAppAdvisorHydrationTimeout,
    this.firstSendTimeout = kRemoteAppAdvisorFirstSendTimeout,
    DateTime Function()? clock,
    RemoteTimerFactory? timer,
    this._mintId,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new;

  final RemoteAppAdvisorCommands advisorCommands;
  final OwnedCommandRegistry commands;
  final bool Function() isConnected;
  final void Function() notify;
  final Duration hydrationTimeout;
  final Duration firstSendTimeout;
  final DateTime Function() _clock;
  final RemoteTimerFactory _timer;
  final String Function()? _mintId;

  final Random _random = Random();

  final Map<String, RemoteAppAdvisorChat> _chats = {};
  final Map<String, List<RemoteChatMessage>> _transcripts = {};

  /// Provisional rows render after the desktop transcript until their echo
  /// establishes a canonical position and replaces the local timestamp.
  final Map<String, Set<String>> _pendingMessages = {};

  /// Tabs created here that the desktop has not projected yet, keyed by
  /// chat id, with the Work Entry they were opened in.
  final Map<String, String> _pendingTabs = {};
  final Set<String> _resolvedQuestions = {};

  /// Models chosen here that the desktop has not projected yet, by chat id.
  final Map<String, String> _modelChoices = {};

  /// Chats whose choice in [_modelChoices] goes with the next send instead
  /// of a model command, because the desktop had not created the tab yet.
  final Set<String> _unsentModelChoices = {};
  RemoteAppAdvisorSettings? _settings;
  bool _loadingSettings = false;
  int _sessionGeneration = 0;
  int _settingsGeneration = 0;
  final Set<String> _resendingMessages = {};

  /// Chats whose whole recent transcript has landed this session, from a
  /// complete list seed or their own targeted load.
  final Set<String> _loadedChats = {};

  /// Targeted chat loads in flight, with their watchdogs.
  final Map<String, Timer> _loadingChats = {};
  final Map<String, String> _chatLoadErrors = {};
  _FirstSend? _firstSend;
  ({String messageId, String chatId})? _boundFirstSend;
  bool _hydrated = false;
  bool _hydrating = false;
  Timer? _hydrationWatchdog;
  String? _hydrationError;
  String? _actionError;

  /// Whether the desktop announces App Advisor support.
  bool get isSupported => advisorCommands.isSupported;

  /// Whether commands can reach the desktop now.
  bool get canAct => isConnected() && isSupported;

  /// True once the desktop's full chat list has landed this session.
  bool get isHydrated => _hydrated;
  bool get isHydrating => _hydrating;
  String? get hydrationError => _hydrationError;

  /// The latest desktop rejection of an Advisor command, until cleared.
  String? get actionError => _actionError;

  void clearActionError() {
    if (_actionError == null) return;
    _actionError = null;
    notify();
  }

  /// Whether a new chat's first send is waiting for the desktop's chat id.
  bool get isStartingChat => _firstSend != null;

  /// The optimistic first message of a chat the desktop has not named yet.
  RemoteChatMessage? get startingMessage =>
      _firstSend?.chatId.isCompleted == false
      ? _firstSend?.messageIn('')
      : null;

  /// The desktop's late binding for the new-chat send owned by a screen.
  String? chatForFirstSend(String? messageId) =>
      messageId != null && _boundFirstSend?.messageId == messageId
      ? _boundFirstSend?.chatId
      : null;

  /// Work Entries in the desktop's manual order.
  List<RemoteAppAdvisorEntry> get entries {
    final groups = <String, List<RemoteAppAdvisorChat>>{};
    for (final chat in _chats.values) {
      groups.putIfAbsent(chat.entryKey, () => []).add(chat);
    }
    final rows = [
      for (final (index, chats) in groups.values.indexed)
        (chats: chats, firstIndex: index),
    ]..sort(_compareEntries);
    return [for (final row in rows) _entryOf(row.chats)];
  }

  /// The Work Entry holding [chatId], including a tab still being created.
  RemoteAppAdvisorEntry? entryFor(String chatId) {
    final entryKey = _chats[chatId]?.entryKey ?? _pendingTabs[chatId];
    if (entryKey == null) return null;
    for (final entry in entries) {
      if (entry.key == entryKey) return entry;
    }
    return null;
  }

  /// Tabs of [entry], plus tabs created in it here and not yet projected.
  List<RemoteChatSummary> tabsFor(RemoteAppAdvisorEntry entry) => [
    ...entry.tabs,
    for (final MapEntry(key: chatId, value: entryKey) in _pendingTabs.entries)
      if (entryKey == entry.key && !_chats.containsKey(chatId))
        RemoteChatSummary(chatId: chatId, scope: null, title: 'New chat'),
  ];

  List<RemoteChatMessage> messagesFor(String chatId) {
    final rows = _transcripts[chatId] ?? const <RemoteChatMessage>[];
    final pending = _pendingMessages[chatId] ?? const <String>{};
    return [
      for (final row in rows)
        if (!pending.contains(row.messageId)) row,
      for (final row in rows)
        if (pending.contains(row.messageId)) row,
    ];
  }

  /// Unanswered questions on [chatId], minus ones resolved here.
  List<AskUserQuestionState> pendingQuestionsFor(String chatId) => [
    for (final request
        in _chats[chatId]?.summary.pendingQuestions ??
            const <AskUserQuestionState>[])
      if (!request.answered && !_resolvedQuestions.contains(request.requestId))
        request,
  ];

  bool isRunning(String chatId) =>
      _chats[chatId]?.summary.turnActive == true ||
      // Local sends have no host transcript position until acknowledged.
      isChatTurnRunning(
        (_transcripts[chatId] ?? const <RemoteChatMessage>[]).where(
          (row) =>
              !(_pendingMessages[chatId]?.contains(row.messageId) ?? false) &&
              row.delivery == null,
        ),
      );

  int? turnElapsedMs(String chatId) => _chats[chatId]?.summary.turnElapsedMs;

  /// The projected tab summary for [chatId]; null for a tab still being
  /// created.
  RemoteChatSummary? summaryFor(String chatId) => _chats[chatId]?.summary;

  /// The model new Advisor chats run on, from the desktop's Advisor settings.
  String? get defaultModel => _settings?.model;

  /// The models [chatId]'s picker offers; a null [chatId] is a new chat.
  /// A tab the desktop has not projected a catalog for borrows another
  /// Advisor tab's, since they share the desktop's Advisor model choices.
  /// The settings catalog backs a new chat and an Advisor with no tabs.
  RemoteAppAdvisorCatalog catalogFor(String? chatId) {
    RemoteAppAdvisorCatalog fromTab(RemoteChatSummary summary) => (
      models: summary.availableModels,
      providerAvailability: summary.providerAvailability,
      projected: true,
    );
    final own = chatId == null ? null : _chats[chatId]?.summary;
    if (own != null && own.hasProjectedModelCatalog) return fromTab(own);
    final settings = _settings;
    if (settings != null && settings.availableModels.isNotEmpty) {
      return (
        models: settings.availableModels,
        providerAvailability: settings.providerAvailability,
        projected: true,
      );
    }
    for (final chat in _chats.values) {
      if (chat.summary.hasProjectedModelCatalog) return fromTab(chat.summary);
    }
    return (models: const [], providerAvailability: null, projected: false);
  }

  /// [chatId]'s model: a choice made here until the desktop projects it,
  /// then the desktop's, then the Advisor default for a tab with no model
  /// yet. A null [chatId] is a new chat, which runs on the default.
  String? modelFor(String? chatId) {
    if (chatId == null) return defaultModel;
    return _modelChoices[chatId] ??
        _chats[chatId]?.summary.model ??
        defaultModel;
  }

  /// Reads the Advisor default model once per paired session.
  Future<void> loadSettings() async {
    if (_settings != null || _loadingSettings || !canAct) return;
    _loadingSettings = true;
    final generation = _settingsGeneration;
    try {
      final read = await advisorCommands.readSettings();
      if (generation != _settingsGeneration) return;
      if (read.settings case final settings?) {
        _applySettings(settings);
      } else {
        commands.register(
          read.commandId,
          recordOutcome: false,
          onCompleted: (result) {
            if (generation != _settingsGeneration) return;
            if (result != null) {
              _applySettings(RemoteAppAdvisorSettings.fromJson(result));
            }
          },
          onFailed: (_) {
            if (generation == _settingsGeneration) _loadingSettings = false;
          },
        );
      }
    } on Object {
      // The picker falls back to the projected catalog; a later open retries.
      if (generation == _settingsGeneration) _loadingSettings = false;
    }
  }

  void _applySettings(RemoteAppAdvisorSettings settings) {
    _settings = settings;
    _loadingSettings = false;
    notify();
  }

  /// Starts loading the chat list in the background once the desktop can
  /// answer, so it is ready before the user opens Advisor. Does nothing once
  /// loaded or after a failure, which the Advisor screen offers to retry.
  void prefetch() {
    if (_hydrated || _hydrating || _hydrationError != null) return;
    unawaited(hydrate());
  }

  /// Whether opening [chatId] should load its transcript: the desktop has
  /// created the tab and its whole recent transcript has not landed yet.
  bool needsChatLoad(String chatId) =>
      _chats.containsKey(chatId) &&
      !_loadedChats.contains(chatId) &&
      !_loadingChats.containsKey(chatId) &&
      !_chatLoadErrors.containsKey(chatId);

  bool isLoadingChat(String chatId) => _loadingChats.containsKey(chatId);

  String? chatLoadError(String chatId) => _chatLoadErrors[chatId];

  Future<void> retryChatLoad(String chatId) async {
    if (!canAct) return;
    _chatLoadErrors.remove(chatId);
    await loadChat(chatId);
  }

  /// Loads one chat's transcript with a request that reads only that chat,
  /// which answers much faster than the whole list.
  Future<void> loadChat(String chatId) async {
    if (!canAct || !needsChatLoad(chatId)) return;
    late final Timer watchdog;
    watchdog = _timer(
      hydrationTimeout,
      () => _settleChatLoad(chatId, watchdog, kRemoteAppAdvisorHydrationFailed),
    );
    _loadingChats[chatId] = watchdog;
    notify();
    try {
      final commandId = await advisorCommands.requestChatState(chatId);
      if (!identical(_loadingChats[chatId], watchdog)) return;
      commands.register(
        commandId,
        recordOutcome: false,
        onFailed: (error) => _settleChatLoad(chatId, watchdog, error),
      );
    } on RemoteControlException catch (error) {
      _settleChatLoad(chatId, watchdog, error.message);
    } on Object {
      _settleChatLoad(chatId, watchdog, kRemoteAppAdvisorHydrationFailed);
    }
  }

  void _settleChatLoad(String chatId, Timer watchdog, String error) {
    if (!identical(_loadingChats[chatId], watchdog)) return;
    _loadingChats.remove(chatId);
    watchdog.cancel();
    _chatLoadErrors[chatId] = error;
    notify();
  }

  /// Asks the desktop for every Advisor chat. One request at a time; the
  /// answer arrives as an `app_advisor` snapshot event.
  Future<void> hydrate() async {
    if (_hydrating || !canAct) return;
    unawaited(loadSettings());
    _hydrating = true;
    _hydrationError = null;
    late final Timer watchdog;
    void fail(String error) {
      if (!identical(_hydrationWatchdog, watchdog)) return;
      _failHydration(error);
    }

    watchdog = _timer(
      hydrationTimeout,
      () => fail(kRemoteAppAdvisorHydrationFailed),
    );
    _hydrationWatchdog = watchdog;
    notify();
    try {
      final commandId = await advisorCommands.requestState();
      if (!identical(_hydrationWatchdog, watchdog)) return;
      commands.register(commandId, recordOutcome: false, onFailed: fail);
    } on RemoteControlException catch (error) {
      fail(error.message);
    } catch (_) {
      fail(kRemoteAppAdvisorHydrationFailed);
    }
  }

  /// Sends [text] to [chatId], or starts a new chat in [workEntryId] when
  /// [chatId] is null. Returns the chat the message went to. Throws a
  /// [RemoteControlException] when the desktop rejects the send. Rejected
  /// messages remain in their original transcript. A first send stays in the
  /// unnamed transcript (the empty key) for explicit resend or discard.
  Future<String> send({
    String? chatId,
    String? workEntryId,
    required String text,
    String? model,
  }) async {
    if (!canAct) throw const RemoteControlException(_actionFailed);
    if (chatId == null && _firstSend != null) {
      throw const RemoteControlException(_actionFailed);
    }
    final optimistic = _FirstSend(
      messageId: _newId('msg-m'),
      text: text,
      occurredAt: _clock(),
      model: model,
    );
    _actionError = null;
    if (chatId == null) return _startChat(optimistic, workEntryId);
    return _sendToChat(chatId, optimistic, model: model);
  }

  Future<String> _sendToChat(
    String chatId,
    _FirstSend optimistic, {
    String? model,
  }) async {
    _actionError = null;
    final userMessageId = optimistic.messageId;
    // A model chosen before the desktop created the tab rides on this send.
    final unsentModel = _unsentModelChoices.remove(chatId)
        ? _modelChoices[chatId]
        : null;
    final generation = _sessionGeneration;
    void fail(String error) {
      if (generation != _sessionGeneration) return;
      if (unsentModel != null && _modelChoices[chatId] == unsentModel) {
        _unsentModelChoices.add(chatId);
      }
      _failSend(chatId, userMessageId, error);
    }

    _upsert(chatId, optimistic.messageIn(chatId), optimistic: true);
    notify();
    try {
      final commandId = await advisorCommands.send(
        chatId: chatId,
        userMessageId: userMessageId,
        text: optimistic.text,
        model: model ?? unsentModel,
      );
      if (generation != _sessionGeneration) return chatId;
      commands.register(commandId, recordOutcome: false, onFailed: fail);
    } on RemoteChatSendOutcomeUnknownException catch (error) {
      if (generation == _sessionGeneration &&
          (_pendingMessages[chatId]?.contains(userMessageId) ?? false)) {
        _failSend(
          chatId,
          userMessageId,
          error.message,
          delivery: ChatDelivery.uncertain,
        );
      }
      rethrow;
    } on RemoteControlException catch (error) {
      fail(error.message);
      rethrow;
    } on Object {
      fail(_actionFailed);
      throw const RemoteControlException(_actionFailed);
    }
    return chatId;
  }

  /// Retries an explicitly rejected message without disturbing the composer.
  Future<String?> resend(
    String? chatId,
    String messageId, {
    String? model,
  }) async {
    final message = messagesFor(chatId ?? '')
        .where(
          (row) =>
              row.messageId == messageId &&
              row.delivery == ChatDelivery.notSent,
        )
        .firstOrNull;
    if (message == null ||
        !canAct ||
        (chatId == null && isStartingChat) ||
        !_resendingMessages.add(messageId)) {
      return null;
    }
    final generation = _sessionGeneration;
    try {
      final sentChatId = chatId == null
          ? await _startChat(
              _FirstSend(
                messageId: message.messageId,
                text: message.text,
                occurredAt: message.occurredAt ?? _clock(),
                model: model,
              ),
              null,
            )
          : await _sendToChat(
              chatId,
              _FirstSend(
                messageId: message.messageId,
                text: message.text,
                occurredAt: message.occurredAt ?? _clock(),
              ),
            );
      if (generation == _sessionGeneration) {
        return sentChatId;
      }
    } on RemoteControlException {
      // The original failed row remains available for another attempt.
    } finally {
      if (generation == _sessionGeneration) {
        _resendingMessages.remove(messageId);
      }
    }
    return null;
  }

  void discardFailedMessage(String chatId, String messageId) {
    if (!messagesFor(
      chatId,
    ).any((row) => row.messageId == messageId && row.delivery != null)) {
      return;
    }
    _removeMessage(chatId, messageId);
    final first = _firstSend;
    if (chatId.isEmpty && first?.messageId == messageId) {
      first?.watchdog?.cancel();
      _firstSend = null;
    }
    notify();
  }

  Future<String> _startChat(_FirstSend first, String? workEntryId) {
    _actionError = null;
    _boundFirstSend = null;
    _firstSend = first;
    first.watchdog = _timer(
      firstSendTimeout,
      () => _failFirstSend(
        first,
        kRemoteAppAdvisorFirstSendUnconfirmed,
        uncertain: true,
      ),
    );
    notify();
    unawaited(_submitFirstSend(first, workEntryId));
    return first.chatId.future;
  }

  Future<void> _submitFirstSend(_FirstSend first, String? workEntryId) async {
    final generation = _sessionGeneration;
    try {
      final commandId = await advisorCommands.send(
        userMessageId: first.messageId,
        text: first.text,
        workEntryId: workEntryId,
        model: first.model,
      );
      if (generation != _sessionGeneration) return;
      commands.register(
        commandId,
        recordOutcome: false,
        onCompleted: (result) {
          if (generation != _sessionGeneration) return;
          final chatId = result?['chatId'];
          if (chatId is String && chatId.isNotEmpty) {
            _bindFirstSend(first, chatId);
          }
        },
        onFailed: (error) {
          if (generation == _sessionGeneration) _failFirstSend(first, error);
        },
      );
    } on RemoteChatSendOutcomeUnknownException {
      if (generation != _sessionGeneration) return;
      _failFirstSend(
        first,
        kRemoteAppAdvisorFirstSendUnconfirmed,
        uncertain: true,
      );
    } on RemoteControlException catch (error) {
      if (generation != _sessionGeneration) return;
      _failFirstSend(first, error.message);
    } catch (_) {
      if (generation != _sessionGeneration) return;
      _failFirstSend(first, _actionFailed);
    }
  }

  /// Stops [chatId]'s running turn.
  Future<void> cancel(String chatId) =>
      _runCommand(() => advisorCommands.cancel(chatId));

  /// Opens a new tab in [entry] and returns its client-minted chat id. The
  /// tab shows at once and is removed again if the desktop rejects it.
  String createTab(RemoteAppAdvisorEntry entry) {
    final chatId = _newId('chat-m');
    _pendingTabs[chatId] = entry.key;
    _actionError = null;
    notify();
    unawaited(
      _runCommand(
        () => advisorCommands.createTab(
          chatId: chatId,
          workEntryId: entry.workEntryId,
        ),
        onFailed: () => _pendingTabs.remove(chatId),
      ),
    );
    return chatId;
  }

  /// Sets [chatId]'s model, showing it at once. A rejection restores the
  /// desktop's model and shows why. A tab the desktop has not created yet
  /// keeps the choice for its first send.
  Future<void> setModel(String chatId, String model) async {
    if (modelFor(chatId) == model) return;
    _modelChoices[chatId] = model;
    if (!_chats.containsKey(chatId)) {
      _unsentModelChoices.add(chatId);
      notify();
      return;
    }
    _unsentModelChoices.remove(chatId);
    await _runCommand(
      () => advisorCommands.setModel(chatId: chatId, model: model),
      onFailed: () {
        if (_modelChoices[chatId] == model) _modelChoices.remove(chatId);
      },
    );
  }

  /// Answers an awaiting question, hiding its card until the desktop
  /// confirms. A rejection brings the card back.
  Future<void> answerQuestion(
    String chatId, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) => _resolveQuestion(
    requestId,
    () => advisorCommands.answerQuestion(
      chatId: chatId,
      requestId: requestId,
      answers: answers,
    ),
  );

  Future<void> dismissQuestion(String chatId, {required String requestId}) =>
      _resolveQuestion(
        requestId,
        () => advisorCommands.dismissQuestion(
          chatId: chatId,
          requestId: requestId,
        ),
      );

  /// Applies a streamed message. Returns whether anything visible changed.
  bool applyMessage(RemoteAppAdvisorMessageEvent event) {
    final first = _firstSend;
    if (first != null && event.message.messageId == first.messageId) {
      _bindFirstSend(first, event.chatId, notifyChange: false);
    }
    _upsert(event.chatId, event.message);
    return true;
  }

  /// Applies an `app_advisor` snapshot: untargeted, it replaces the chat
  /// list; targeted, only its chat.
  bool applySnapshot(RemoteAppAdvisorSnapshotEvent event) {
    final target = event.targetChatId;
    if (target == null) {
      final previous = Map.of(_chats);
      _chats.clear();
      for (final chat in event.chats) {
        _chats[chat.chatId] = previous[chat.chatId]?.merge(chat) ?? chat;
        _settleModelChoice(chat);
      }
      for (final entry in previous.entries) {
        if (_hasRecoverableMessages(entry.key)) {
          _chats.putIfAbsent(entry.key, () => entry.value);
        }
      }
      _modelChoices.removeWhere(
        (chatId, _) =>
            !_chats.containsKey(chatId) &&
            !_pendingTabs.containsKey(chatId) &&
            !_hasRecoverableMessages(chatId),
      );
      _transcripts.removeWhere(
        (chatId, _) =>
            chatId.isNotEmpty &&
            !_chats.containsKey(chatId) &&
            !_pendingTabs.containsKey(chatId) &&
            !_hasRecoverableMessages(chatId),
      );
      _pendingMessages.removeWhere(
        (chatId, _) => !_transcripts.containsKey(chatId),
      );
      _hydrated = true;
      _settleHydration();
      // A bounded seed may hold only part of some transcripts.
      if (!event.chatMessagesTruncated) {
        _loadedChats.addAll(_chats.keys);
        for (final chatId in _chats.keys) {
          _loadingChats.remove(chatId)?.cancel();
          _chatLoadErrors.remove(chatId);
        }
      }
    } else {
      for (final chat in event.chats) {
        if (chat.chatId == target) _applyChat(chat);
      }
      // A targeted seed covers its chat; the desktop marks it truncated only
      // so it never prunes other chats.
      _loadedChats.add(target);
      _loadingChats.remove(target)?.cancel();
      _chatLoadErrors.remove(target);
    }
    _pendingTabs.removeWhere((chatId, _) => _chats.containsKey(chatId));
    final seeded = <String>{};
    for (final message in event.chatMessages) {
      if (target == null || message.chatId == target) {
        final first = _firstSend;
        if (first != null && message.messageId == first.messageId) {
          _bindFirstSend(first, message.chatId, notifyChange: false);
        }
        _upsert(message.chatId, message);
        seeded.add(message.chatId);
      }
    }
    // Seed rows can predate rows streamed in earlier; order by position.
    for (final chatId in seeded) {
      _transcripts[chatId] = _sortedByPosition(_transcripts[chatId]!);
    }
    return true;
  }

  /// Applies projected tab updates.
  bool applyDelta(RemoteAppAdvisorDeltaEvent event) {
    if (event.chats.isEmpty && event.removedChatIds.isEmpty) return false;
    for (final chat in event.chats) {
      _applyChat(chat);
      _pendingTabs.remove(chat.chatId);
    }
    for (final chatId in event.removedChatIds) {
      _removeChat(chatId);
    }
    return true;
  }

  void _removeChat(String chatId) {
    if (_boundFirstSend?.chatId == chatId) _boundFirstSend = null;
    final chat = _chats.remove(chatId);
    for (final question
        in chat?.summary.pendingQuestions ?? const <AskUserQuestionState>[]) {
      _resolvedQuestions.remove(question.requestId);
    }
    _transcripts.remove(chatId);
    _pendingMessages.remove(chatId);
    _pendingTabs.remove(chatId);
    _modelChoices.remove(chatId);
    _unsentModelChoices.remove(chatId);
    _loadedChats.remove(chatId);
    _loadingChats.remove(chatId)?.cancel();
    _chatLoadErrors.remove(chatId);
  }

  bool _hasRecoverableMessages(String chatId) =>
      (_transcripts[chatId] ?? const <RemoteChatMessage>[]).any(
        (message) =>
            message.delivery != null ||
            (_pendingMessages[chatId]?.contains(message.messageId) ?? false),
      );

  /// Invalidate desktop projections without deleting the only copy of text
  /// that has not been confirmed. The next seed reconciles by message id.
  void reloadAfterSkippedEvents() {
    // Retained commands still own their terminal handlers. Only projection
    // reads are stale; a later desktop rejection must remain actionable.
    _settingsGeneration++;
    // Submitted choices lost their terminal events. Let the recovered desktop
    // projection own them; local choices still waiting for a first send stay.
    _modelChoices.removeWhere(
      (chatId, _) => !_unsentModelChoices.contains(chatId),
    );
    _resendingMessages.clear();
    _hydrationWatchdog?.cancel();
    _hydrationWatchdog = null;
    for (final watchdog in _loadingChats.values) {
      watchdog.cancel();
    }
    _loadingChats.clear();
    _loadedChats.clear();
    _chatLoadErrors.clear();
    _hydrated = false;
    _hydrating = false;
    _hydrationError = null;
    _resolvedQuestions.clear();
    _settings = null;
    _loadingSettings = false;
    final first = _firstSend;
    if (first != null) {
      _failFirstSend(
        first,
        kRemoteAppAdvisorFirstSendUnconfirmed,
        uncertain: true,
      );
    }
    for (final entry in _transcripts.entries.toList()) {
      final pending = _pendingMessages[entry.key] ?? const <String>{};
      _transcripts[entry.key] = [
        for (final message in entry.value)
          if (message.delivery != null || pending.contains(message.messageId))
            message,
      ];
      for (final message in _transcripts[entry.key]!.toList()) {
        if (message.delivery == null && pending.contains(message.messageId)) {
          _failSend(
            entry.key,
            message.messageId,
            kRemoteAppAdvisorFirstSendUnconfirmed,
            delivery: ChatDelivery.uncertain,
          );
        }
      }
    }
  }

  /// Forgets the discarded session's chats.
  void reset() {
    _sessionGeneration++;
    _settingsGeneration++;
    _boundFirstSend = null;
    _resendingMessages.clear();
    _chatLoadErrors.clear();
    _hydrationWatchdog?.cancel();
    _hydrationWatchdog = null;
    final first = _firstSend;
    _firstSend = null;
    if (first != null) {
      first.watchdog?.cancel();
      if (!first.chatId.isCompleted) {
        first.chatId.completeError(
          const RemoteControlException('Remote Control is disconnected.'),
        );
      }
    }
    _chats.clear();
    _transcripts.clear();
    _pendingMessages.clear();
    _pendingTabs.clear();
    _resolvedQuestions.clear();
    _modelChoices.clear();
    _unsentModelChoices.clear();
    _settings = null;
    _loadingSettings = false;
    _loadedChats.clear();
    for (final watchdog in _loadingChats.values) {
      watchdog.cancel();
    }
    _loadingChats.clear();
    _hydrated = false;
    _hydrating = false;
    _hydrationError = null;
    _actionError = null;
  }

  void dispose() => reset();

  void _applyChat(RemoteAppAdvisorChat chat) {
    _chats[chat.chatId] = _chats[chat.chatId]?.merge(chat) ?? chat;
    _settleModelChoice(chat);
  }

  /// A choice is settled once the desktop projects it; later desktop changes
  /// then show through.
  void _settleModelChoice(RemoteAppAdvisorChat chat) {
    if (_sameModelSelection(chat.summary.model, _modelChoices[chat.chatId])) {
      _modelChoices.remove(chat.chatId);
      _unsentModelChoices.remove(chat.chatId);
    }
  }

  static bool _sameModelSelection(String? projected, String? chosen) =>
      chosen != null &&
      (projected == chosen || projected?.startsWith('$chosen@') == true);

  void _upsert(
    String chatId,
    RemoteChatMessage message, {
    bool optimistic = false,
  }) {
    final rows = List.of(_transcripts[chatId] ?? const <RemoteChatMessage>[]);
    final pending = _pendingMessages.putIfAbsent(chatId, () => <String>{});
    if (optimistic) {
      pending.add(message.messageId);
    } else if (message.delivery == null && pending.remove(message.messageId)) {
      // The echo replaces the whole provisional row. Its local time must not
      // win revision comparisons or keep it ahead of earlier desktop replies.
      rows.removeWhere((row) => row.messageId == message.messageId);
    }
    final index = rows.indexWhere((row) => row.messageId == message.messageId);
    if (index < 0) {
      rows.add(message);
    } else {
      rows[index] = ChatTranscriptStore.newerMessage(rows[index], message);
    }
    _transcripts[chatId] = _sortedByPosition(rows);
  }

  void _removeMessage(String chatId, String messageId) {
    _pendingMessages[chatId]?.remove(messageId);
    final rows = _transcripts[chatId];
    if (rows == null) return;
    _transcripts[chatId] = [
      for (final row in rows)
        if (row.messageId != messageId) row,
    ];
  }

  void _bindFirstSend(
    _FirstSend first,
    String chatId, {
    bool notifyChange = true,
  }) {
    if (!identical(_firstSend, first)) return;
    _firstSend = null;
    _boundFirstSend = (messageId: first.messageId, chatId: chatId);
    first.watchdog?.cancel();
    _actionError = null;
    // Keep earlier rejected submissions reachable after this chat is named.
    _pendingMessages.remove('');
    for (final message in _transcripts.remove('') ?? <RemoteChatMessage>[]) {
      if (message.messageId == first.messageId) continue;
      _upsert(
        chatId,
        RemoteChatMessage(
          messageId: message.messageId,
          chatId: chatId,
          role: message.role,
          status: message.status,
          text: message.text,
          occurredAt: message.occurredAt,
          delivery: message.delivery,
          deliveryNote: message.deliveryNote,
        ),
      );
    }
    if (messagesFor(chatId).every((row) => row.messageId != first.messageId)) {
      _upsert(chatId, first.messageIn(chatId), optimistic: true);
    }
    // Keep showing the chosen model until the desktop projects the chat.
    if (first.model case final model?
        when !_sameModelSelection(_chats[chatId]?.summary.model, model)) {
      _modelChoices[chatId] = model;
    }
    if (!first.chatId.isCompleted) first.chatId.complete(chatId);
    if (notifyChange) notify();
  }

  void _failFirstSend(
    _FirstSend first,
    String error, {
    bool uncertain = false,
  }) {
    if (!identical(_firstSend, first)) return;
    // A deadline is not a rejection. Retain the attempt and hold new sends
    // until its completion, echo, explicit rejection or user dismissal.
    if (!uncertain) _firstSend = null;
    first.watchdog?.cancel();
    _upsert('', first.messageIn(''), optimistic: true);
    if (!first.chatId.isCompleted) {
      first.chatId.completeError(RemoteControlException(error));
    }
    _failSend(
      '',
      first.messageId,
      error,
      delivery: uncertain ? ChatDelivery.uncertain : ChatDelivery.notSent,
    );
  }

  void _failSend(
    String chatId,
    String userMessageId,
    String error, {
    ChatDelivery delivery = ChatDelivery.notSent,
  }) {
    final message = messagesFor(
      chatId,
    ).where((row) => row.messageId == userMessageId).firstOrNull;
    if (message != null) {
      _upsert(
        chatId,
        RemoteChatMessage(
          messageId: message.messageId,
          chatId: chatId,
          role: message.role,
          status: ChatMessageStatus.failed,
          text: message.text,
          occurredAt: message.occurredAt,
          delivery: delivery,
          deliveryNote: error,
        ),
      );
    } else {
      _removeMessage(chatId, userMessageId);
    }
    _actionError = delivery == ChatDelivery.uncertain ? null : error;
    notify();
  }

  void _failHydration(String error) {
    if (!_hydrating) return;
    _settleHydration();
    _hydrationError = error;
    notify();
  }

  void _settleHydration() {
    _hydrating = false;
    _hydrationError = null;
    _hydrationWatchdog?.cancel();
    _hydrationWatchdog = null;
  }

  Future<void> _resolveQuestion(
    String requestId,
    Future<String> Function() submit,
  ) async {
    _resolvedQuestions.add(requestId);
    await _runCommand(
      submit,
      onFailed: () => _resolvedQuestions.remove(requestId),
    );
  }

  /// Submits a command whose only outcome of interest is a rejection, which
  /// runs [onFailed] and is shown through [actionError].
  Future<void> _runCommand(
    Future<String> Function() submit, {
    void Function()? onFailed,
  }) async {
    final generation = _sessionGeneration;
    void fail(String error) {
      if (generation != _sessionGeneration) return;
      onFailed?.call();
      _actionError = error;
      notify();
    }

    if (!canAct) {
      fail(_actionFailed);
      return;
    }
    _actionError = null;
    notify();
    try {
      final commandId = await submit();
      if (generation != _sessionGeneration) return;
      commands.register(commandId, recordOutcome: false, onFailed: fail);
    } on RemoteControlException catch (error) {
      fail(error.message);
    } catch (_) {
      fail(_actionFailed);
    }
  }

  String _newId(String prefix) =>
      _mintId?.call() ??
      '$prefix${_clock().millisecondsSinceEpoch}-'
          '${_random.nextInt(0xffffff).toRadixString(16).padLeft(6, '0')}';

  RemoteAppAdvisorEntry _entryOf(List<RemoteAppAdvisorChat> chats) {
    final tabs = [for (final chat in chats) chat.summary]..sort(_compareTabs);
    final first = chats.first;
    final active =
        tabs.where((tab) => tab.active == true).firstOrNull ?? tabs.first;
    return RemoteAppAdvisorEntry(
      key: first.entryKey,
      workEntryId: first.workEntryId,
      title:
          chats.map((chat) => chat.workEntryTitle).nonNulls.firstOrNull ??
          active.displayTitle,
      tabs: tabs,
      activeChatId: active.chatId,
      isRunning: tabs.any((tab) => isRunning(tab.chatId)),
      needsAnswer: tabs.any(
        (tab) => pendingQuestionsFor(tab.chatId).isNotEmpty,
      ),
    );
  }

  /// The desktop's persisted manual order: `workEntryOrder` ascending, rows
  /// without one last, ties to the newer entry, then first appearance.
  static int _compareEntries(
    ({List<RemoteAppAdvisorChat> chats, int firstIndex}) left,
    ({List<RemoteAppAdvisorChat> chats, int firstIndex}) right,
  ) {
    final leftOrder = left.chats.map((c) => c.workEntryOrder).nonNulls;
    final rightOrder = right.chats.map((c) => c.workEntryOrder).nonNulls;
    if (leftOrder.isNotEmpty && rightOrder.isNotEmpty) {
      final byOrder = leftOrder.first.compareTo(rightOrder.first);
      if (byOrder != 0) return byOrder;
    } else if (leftOrder.isNotEmpty) {
      return -1;
    } else if (rightOrder.isNotEmpty) {
      return 1;
    }
    final leftCreated = _entryCreatedAt(left.chats);
    final rightCreated = _entryCreatedAt(right.chats);
    if (leftCreated != null &&
        rightCreated != null &&
        leftCreated != rightCreated) {
      return rightCreated.compareTo(leftCreated);
    }
    return left.firstIndex.compareTo(right.firstIndex);
  }

  static DateTime? _entryCreatedAt(List<RemoteAppAdvisorChat> chats) {
    final raw = chats.map((chat) => chat.workEntryCreatedAt).nonNulls;
    return raw.isEmpty ? null : DateTime.tryParse(raw.first);
  }

  /// Desktop tab order: `order`, then creation time, then id.
  static int _compareTabs(RemoteChatSummary left, RemoteChatSummary right) {
    final leftOrder = left.order;
    final rightOrder = right.order;
    if (leftOrder != null && rightOrder != null && leftOrder != rightOrder) {
      return leftOrder.compareTo(rightOrder);
    }
    if (leftOrder != null && rightOrder == null) return -1;
    if (leftOrder == null && rightOrder != null) return 1;
    final byCreated = (left.createdAt ?? '').compareTo(right.createdAt ?? '');
    if (byCreated != 0) return byCreated;
    return left.chatId.compareTo(right.chatId);
  }

  /// Stable sort by position. Rows without one go after every positioned
  /// row, keeping their relative order.
  static List<RemoteChatMessage> _sortedByPosition(
    List<RemoteChatMessage> rows,
  ) {
    final indexed = [for (final (index, row) in rows.indexed) (index, row)];
    indexed.sort((left, right) {
      final leftAt = left.$2.positionAt;
      final rightAt = right.$2.positionAt;
      final byPosition = leftAt != null && rightAt != null
          ? leftAt.compareTo(rightAt)
          : (leftAt == null ? 1 : 0) - (rightAt == null ? 1 : 0);
      return byPosition != 0 ? byPosition : left.$1.compareTo(right.$1);
    });
    return [for (final (_, row) in indexed) row];
  }
}

/// An optimistic user message. For a new chat it also waits for the
/// desktop to name the chat.
final class _FirstSend {
  _FirstSend({
    required this.messageId,
    required this.text,
    required this.occurredAt,
    this.model,
  }) {
    // The screen may stop listening; a late failure must not surface as an
    // unhandled error.
    chatId.future.ignore();
  }

  final String messageId;
  final String text;
  final DateTime occurredAt;

  /// The model a new chat should run on; null keeps the Advisor default.
  final String? model;
  final Completer<String> chatId = Completer<String>();
  Timer? watchdog;

  RemoteChatMessage messageIn(String chatId) => RemoteChatMessage(
    messageId: messageId,
    chatId: chatId,
    role: ChatRole.user,
    status: ChatMessageStatus.complete,
    text: text,
    occurredAt: occurredAt,
  );
}
