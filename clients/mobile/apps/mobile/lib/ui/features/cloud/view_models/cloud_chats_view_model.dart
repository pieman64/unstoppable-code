import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/repositories/cloud_composer_commands.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/core/chat/view_models/model_picker_catalog.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_authentication_failures.dart';

/// Name of the project created for a brand-new cloud account; matches the web
/// client's `DEFAULT_WORKSPACE_NAME`.
const String defaultCloudProjectName = 'My project';

/// Requests the first-project provision makes before giving up, matching the
/// web client's background budget.
const int _firstProjectAttempts = 3;

/// Longest wait honored from a `Retry-After`, and the wait used without one.
const Duration _maxFirstProjectRetryDelay = Duration(seconds: 30);
const Duration _fallbackFirstProjectRetryDelay = Duration(seconds: 2);

/// 503 codes that mean "come back in a moment" rather than "this failed".
const Set<String> _provisioningBusyCodes = {
  'CLOUD_ACCOUNT_PROVISIONING',
  'CLOUD_WORKSPACE_PROVISIONING',
};

enum _FirstProject { undecided, provisioning, settled, failed }

/// Cloud workspaces and their chats for the list screen, plus the model
/// catalog every cloud composer reads.
///
/// Availability is inferred from the workspaces probe, the same way the web
/// client infers it: a 404 means the server-side gate is closed and the cloud
/// entry point hides. Any other failure leaves availability unknown so a
/// transient outage never hides the tab.
class CloudChatsViewModel extends ChangeNotifier with DisposeSafeNotifier {
  CloudChatsViewModel({
    required this.repository,
    this.delay = Future<void>.delayed,
  });

  final CloudChatRepository repository;

  /// The composer's `/` suggestions for this account's chats and drafts.
  late final CloudComposerCommands composerCommands = CloudComposerCommands(
    repository,
  );

  /// Waits between first-project retries; tests inject an instant one.
  final Future<void> Function(Duration) delay;
  final CloudAuthenticationFailures authenticationFailures =
      CloudAuthenticationFailures();

  List<CloudWorkspaceSummary> _workspaces = const [];
  bool? _cloudAvailable;
  bool _loading = false;
  bool _loadedOnce = false;
  Future<void>? _inFlight;
  String? _error;
  CloudModelCatalog? _catalog;
  List<ModelOption> _models = const [];
  Future<void>? _modelsInFlight;
  bool _modelsLoading = false;
  String? _modelsError;
  int _generation = 0;

  /// Changes whenever the account or organization scope is reset.
  int get scopeGeneration => _generation;
  CloudApiException? _authenticationFailure;
  int _authenticationFailureRevision = 0;
  final Map<String, Future<void>> _modelSelectionQueues = {};
  _FirstProject _firstProject = _FirstProject.undecided;
  Future<void>? _firstProjectInFlight;
  bool _firstProjectPairingPending = false;
  final Map<String, DateTime> _observedActivity = {};

  /// The latest user message this device has seen in [chatId], or null.
  ///
  /// The workspaces payload carries no message timestamps, so this overlay
  /// is what lets the Recents list (CAN-2931) move a cloud chat up after the
  /// user writes in it here. It is in-memory only and cleared by [reset].
  DateTime? observedChatActivityAt(String chatId) => _observedActivity[chatId];

  /// Records a user message in [chatId] at [at]; older observations are kept.
  void recordChatActivity(String chatId, DateTime at) {
    final current = _observedActivity[chatId];
    if (current != null && !at.isAfter(current)) return;
    _observedActivity[chatId] = at;
    notifyListenersSafe();
  }

  final Set<String> _createsInFlight = {};

  /// First messages (by `clientRequestId`) whose chat create is running in
  /// this process, across every draft screen. A draft must not show one as
  /// interrupted while the screen that sent it still awaits the server; when
  /// the set changes, drafts look for pending creates again.
  Set<String> get pendingCreatesInFlight => Set.unmodifiable(_createsInFlight);

  void markCreateInFlight(String clientRequestId) {
    if (_createsInFlight.add(clientRequestId)) notifyListenersSafe();
  }

  /// Call once the create's outcome is in the draft store.
  void clearCreateInFlight(String clientRequestId) {
    if (_createsInFlight.remove(clientRequestId)) notifyListenersSafe();
  }

  List<CloudWorkspaceSummary> get workspaces => _workspaces;

  /// Null until the server has answered the workspaces probe once.
  bool? get cloudAvailable => _cloudAvailable;
  bool get isLoading => _loading;
  String? get error => _error;
  CloudApiException? get authenticationFailure => _authenticationFailure;
  int get authenticationFailureRevision => _authenticationFailureRevision;

  /// The catalog projected onto the shared composer model shape.
  List<ModelOption> get models => _models;
  bool get modelsLoading => _modelsLoading;
  String? get modelsError => _modelsError;
  bool get modelsLoaded => _catalog != null;

  /// The catalog's explicit model-to-harness bindings, which lock a chat.
  Map<String, String> get modelHarnesses =>
      _catalog?.modelHarnesses ?? const {};
  String? get defaultModelId {
    final catalog = _catalog;
    if (catalog == null) return null;
    final fallback = catalog.defaultModelFallbackId;
    if (fallback != null) return fallback;
    if (catalog.defaultModelBlocked) {
      return _models.isEmpty ? null : _models.first.id;
    }
    return catalog.defaultModelId;
  }

  CloudChatSummary? chatById(String chatId) {
    for (final workspace in _workspaces) {
      for (final chat in workspace.chats) {
        if (chat.externalId == chatId) return chat;
      }
    }
    return null;
  }

  CloudWorkspaceSummary? workspaceForChat(String chatId) {
    for (final workspace in _workspaces) {
      if (workspace.chats.any((chat) => chat.externalId == chatId)) {
        return workspace;
      }
    }
    return null;
  }

  /// Fetches workspaces the first time; later calls are no-ops unless a
  /// fetch is still in flight, in which case they await it.
  Future<void> load() {
    if (_loadedOnce) return _inFlight ?? Future.value();
    return refresh();
  }

  /// Always re-fetches; concurrent callers share one request.
  Future<void> refresh() {
    final active = _inFlight;
    if (active != null) return active;
    final generation = _generation;
    late final Future<void> tracked;
    tracked = _fetch(generation).whenComplete(() {
      if (generation == _generation && identical(_inFlight, tracked)) {
        _inFlight = null;
      }
    });
    return _inFlight = tracked;
  }

  Future<void> _fetch(int generation) async {
    _loading = true;
    _error = null;
    _authenticationFailure = null;
    notifyListenersSafe();
    try {
      final workspaces = await repository.listWorkspaces();
      if (!_active(generation)) return;
      _workspaces = List.unmodifiable(workspaces);
      _cloudAvailable = repository.supportsCloudChats ?? true;
      _loadedOnce = true;
      // A failed provision is re-armed only by a fresh list answer, which
      // takes a user action (retry or pull to refresh), so it cannot loop.
      if (_firstProject == _FirstProject.failed) {
        _firstProject = _FirstProject.undecided;
      }
      // Any project at all means this is not a first run, now or later: a
      // user who archives their last project on the web gets no replacement.
      if (_firstProject == _FirstProject.undecided && workspaces.isNotEmpty) {
        _firstProject = _FirstProject.settled;
      }
    } catch (error) {
      if (!_active(generation)) return;
      authenticationFailures.report(error);
      _error = _describe(error);
      if (error is CloudApiException &&
          const {401, 403}.contains(error.statusCode)) {
        _authenticationFailure = error;
        _authenticationFailureRevision++;
      }
    } finally {
      if (_active(generation)) {
        _loading = false;
        notifyListenersSafe();
      }
    }
  }

  /// Loads the model catalog once and keeps it for every composer.
  Future<void> ensureModels() {
    if (_catalog != null) return Future.value();
    final active = _modelsInFlight;
    if (active != null) return active;
    final generation = _generation;
    late final Future<void> tracked;
    tracked = _fetchModels(generation).whenComplete(() {
      if (generation == _generation && identical(_modelsInFlight, tracked)) {
        _modelsInFlight = null;
      }
    });
    return _modelsInFlight = tracked;
  }

  Future<void> _fetchModels(int generation) async {
    _modelsLoading = true;
    _modelsError = null;
    notifyListenersSafe();
    try {
      final catalog = await repository.getModels();
      if (!_active(generation)) return;
      _catalog = catalog;
      _models = List.unmodifiable(catalog.models.map(_project(catalog)));
    } catch (error) {
      if (!_active(generation)) return;
      authenticationFailures.report(error);
      _modelsError = _describeModels(error);
    } finally {
      if (_active(generation)) {
        _modelsLoading = false;
        notifyListenersSafe();
      }
    }
  }

  /// Hosted models are billed to AI Credits and run on their resolved
  /// harness, like the web catalog projection.
  static ModelOption Function(CloudModelOption) _project(
    CloudModelCatalog catalog,
  ) => (option) {
    final harness = option.harness ?? catalog.modelHarnesses[option.id];
    final signInLock = modelLibrarySignInLock(catalog.modelLibrary);
    return ModelOption(
      id: option.id,
      label: option.label,
      provider: harness ?? 'other',
      source: 'ai-gateway',
      harness: harness,
      vendor: option.provider,
      family: option.family,
      familyLabel: option.familyLabel,
      contextWindow: switch (option.contextWindow) {
        final int value when value > 0 => value,
        _ => null,
      },
      showMoreOnly: option.showMoreOnly,
      kind: 'model',
      // A guest sees the models they cannot run yet, locked with the reason,
      // like the web picker (CAN-2872). Purchase-only locks are not gated on
      // mobile, which has no purchase flow.
      available: !(option.libraryLocked && signInLock != null),
      unavailableReason: option.libraryLocked ? signInLock : null,
      description: option.description,
      // Core's declared set is canonical, like web's projection. Core
      // rejects Ultra, so it is never offered.
      supportedThinkingLevels: switch (option.thinkingLevels) {
        final levels? => List.unmodifiable(
          levels.where((level) => level != 'ultra'),
        ),
        null => null,
      },
      isDefault: option.id == catalog.defaultModelId,
      supportsFastMode: option.fastModeSupported,
    );
  };

  /// Creates an empty chat in [workspaceId] under the caller's [externalId]
  /// and [modelDefinitionId], or the catalog default model when known, with
  /// the draft's [pluginSelections] when it chose its own, then caches it
  /// under its workspace. Reusing [externalId] makes a retry return
  /// the same chat instead of a second one. Returns null when the account or
  /// organization changes while it runs. [autoModel] creates it in Auto.
  Future<CloudChatSummary?> createChat(
    String workspaceId, {
    required String externalId,
    String? modelDefinitionId,
    bool autoModel = false,
    Map<String, Object?>? pluginSelections,
  }) async {
    final generation = _generation;
    await ensureModels();
    if (!_active(generation)) return null;
    final chat = await _request(
      () => repository.createChat(
        workspaceId,
        externalId: externalId,
        modelDefinitionId: modelDefinitionId ?? defaultModelId,
        autoModel: autoModel,
        pluginSelections: pluginSelections,
      ),
    );
    if (!_active(generation)) return null;
    _workspaces = List.unmodifiable([
      for (final workspace in _workspaces)
        if (workspace.externalId == workspaceId)
          _copyWorkspace(
            workspace,
            chats: [
              ...workspace.chats.where((c) => c.externalId != chat.externalId),
              chat,
            ],
          )
        else
          workspace,
    ]);
    notifyListenersSafe();
    return chat;
  }

  Future<CloudChatSummary> rename(String chatId, String? title) async {
    final chat = await _request(() => repository.renameChat(chatId, title));
    _replaceChat(chat);
    return chat;
  }

  Future<CloudChatSummary> setModel(String chatId, String? modelDefinitionId) =>
      _queueModelSelection(
        chatId,
        () => repository.setChatModel(chatId, modelDefinitionId),
      );

  /// Turns on Auto, ordered with [setModel] choices for the same chat.
  Future<CloudChatSummary> setAutoModel(String chatId) =>
      _queueModelSelection(chatId, () => repository.setChatAutoModel(chatId));

  /// A model or Auto choice for [chatId] is still saving. Every send to that
  /// chat is held until the last one settles, so the turn runs in the mode the
  /// chip shows, on any screen that shows the chat.
  bool isSelectionSavePending(String chatId) =>
      _modelSelectionQueues.containsKey(chatId);

  Future<CloudChatSummary> _queueModelSelection(
    String chatId,
    Future<CloudChatSummary> Function() request,
  ) {
    final operation = _persistModelSelection(
      _modelSelectionQueues[chatId] ?? Future.value(),
      request,
      _generation,
    );
    late final Future<void> queue;
    queue = _settle(operation).whenComplete(() {
      if (identical(_modelSelectionQueues[chatId], queue)) {
        _modelSelectionQueues.remove(chatId);
        notifyListenersSafe();
      }
    });
    _modelSelectionQueues[chatId] = queue;
    notifyListenersSafe();
    return operation;
  }

  /// Applies the selection mode and model the server saved with an accepted
  /// turn, so the chip follows a fallback from Auto, as on the web.
  void applyAcceptedModelSelection(
    String chatId, {
    String? modelSelectionMode,
    String? modelDefinitionId,
  }) {
    final chat = chatById(chatId);
    if (chat == null) return;
    final auto = modelSelectionMode == null
        ? chat.modelAuto
        : modelSelectionMode == 'auto';
    final model = modelDefinitionId ?? chat.modelDefinitionId;
    if (auto == chat.modelAuto && model == chat.modelDefinitionId) return;
    _replaceChat(
      chat.withModelSelection(modelAuto: auto, modelDefinitionId: model),
    );
  }

  Future<void> archive(String chatId) async {
    await _request(() => repository.archiveChat(chatId));
    _forgetChat(chatId);
  }

  /// Deletes [chatId]; the server keeps it for the workspace's retention
  /// window. The row leaves the list only once the server accepts.
  Future<void> delete(String chatId) async {
    await _request(() => repository.deleteChat(chatId));
    _forgetChat(chatId, includeChildTabs: true);
  }

  void _forgetChat(String chatId, {bool includeChildTabs = false}) {
    if (isDisposed) return;
    _workspaces = List.unmodifiable([
      for (final workspace in _workspaces)
        _copyWorkspace(
          workspace,
          chats: workspace.chats
              .where(
                (chat) =>
                    chat.externalId != chatId &&
                    (!includeChildTabs || chat.taskChatExternalId != chatId),
              )
              .toList(growable: false),
        ),
    ]);
    notifyListenersSafe();
  }

  /// True while the first project for a brand-new account is being created.
  bool get isProvisioningFirstProject =>
      _firstProject == _FirstProject.provisioning;

  /// True while the shell is waiting to learn whether this account has a
  /// paired desktop before deciding whether to create its first project.
  bool get isFirstProjectDecisionPending =>
      _firstProjectPairingPending && _firstProject == _FirstProject.undecided;

  void setFirstProjectPairingPending(bool pending, {bool notify = true}) {
    if (_firstProjectPairingPending == pending) return;
    _firstProjectPairingPending = pending;
    if (notify) notifyListenersSafe();
  }

  /// Creates [defaultCloudProjectName] for a brand-new account, as the web
  /// client does on its first load, so a first-run user can start a chat
  /// without visiting the web.
  ///
  /// Decides once per account, and only after the first list has answered:
  /// an account that had any project, or a [pairedDesktop] user (whose work
  /// lives on the desktop), is never provisioned for. The server keeps the
  /// same promise across devices and reinstalls: the request is idempotent
  /// per account and declines once the first project has been archived.
  Future<void> provisionFirstProjectIfNeeded({required bool pairedDesktop}) {
    final active = _firstProjectInFlight;
    if (active != null) return active;
    if (!_loadedOnce || _cloudAvailable != true) return Future.value();
    if (_firstProject != _FirstProject.undecided) return Future.value();
    if (pairedDesktop || _workspaces.isNotEmpty) {
      _firstProject = _FirstProject.settled;
      return Future.value();
    }
    final generation = _generation;
    late final Future<void> tracked;
    tracked = _provisionFirstProject(generation).whenComplete(() {
      if (generation == _generation &&
          identical(_firstProjectInFlight, tracked)) {
        _firstProjectInFlight = null;
      }
    });
    return _firstProjectInFlight = tracked;
  }

  Future<void> _provisionFirstProject(int generation) async {
    _firstProject = _FirstProject.provisioning;
    _error = null;
    notifyListenersSafe();
    try {
      final workspace = await _requestFirstProject(generation);
      if (!_active(generation)) return;
      // A decline (null) is an answer, not a failure: the account already
      // had its first project, so the list stays as it is.
      _firstProject = _FirstProject.settled;
      if (workspace != null &&
          !_workspaces.any((w) => w.externalId == workspace.externalId)) {
        _workspaces = List.unmodifiable([..._workspaces, workspace]);
      }
    } catch (error) {
      if (!_active(generation)) return;
      authenticationFailures.report(error);
      _firstProject = _FirstProject.failed;
      _error = switch (error) {
        CloudApiException(:final message) => message,
        _ => "Couldn't set up your first project. Try again.",
      };
    } finally {
      if (_active(generation)) notifyListenersSafe();
    }
  }

  /// One provision request, retrying the brief 503 a brand-new account's
  /// tenancy answers while another request is still setting it up.
  Future<CloudWorkspaceSummary?> _requestFirstProject(int generation) async {
    for (var attempt = 1; ; attempt++) {
      try {
        return await repository.provisionFirstWorkspace(
          defaultCloudProjectName,
        );
      } on CloudApiException catch (error) {
        final busy =
            error.statusCode == 503 &&
            _provisioningBusyCodes.contains(error.code);
        if (!busy || attempt >= _firstProjectAttempts) rethrow;
        final wait = error.retryAfter ?? _fallbackFirstProjectRetryDelay;
        await delay(
          wait > _maxFirstProjectRetryDelay ? _maxFirstProjectRetryDelay : wait,
        );
        if (!_active(generation)) return null;
      }
    }
  }

  /// Forgets everything; the next [load] probes again. Called on account or
  /// organization changes.
  void reset() {
    _generation++;
    composerCommands.clear();
    _inFlight = null;
    _modelsInFlight = null;
    _workspaces = const [];
    _cloudAvailable = null;
    _loading = false;
    _loadedOnce = false;
    _error = null;
    _authenticationFailure = null;
    _catalog = null;
    _models = const [];
    _modelsLoading = false;
    _modelsError = null;
    _modelSelectionQueues.clear();
    _observedActivity.clear();
    _createsInFlight.clear();
    _firstProject = _FirstProject.undecided;
    _firstProjectInFlight = null;
    notifyListenersSafe();
  }

  bool _active(int generation) => !isDisposed && generation == _generation;

  Future<T> _request<T>(Future<T> Function() request) async {
    try {
      return await request();
    } catch (error) {
      authenticationFailures.report(error);
      rethrow;
    }
  }

  Future<CloudChatSummary> _persistModelSelection(
    Future<void> previous,
    Future<CloudChatSummary> Function() request,
    int generation,
  ) async {
    await previous;
    if (!_active(generation)) {
      throw StateError('Model selection was reset before it started');
    }
    final chat = await _request(request);
    if (_active(generation)) _replaceChat(chat);
    return chat;
  }

  static Future<void> _settle(Future<Object?> operation) async {
    try {
      await operation;
    } catch (_) {
      // A later selection must still run after an earlier PATCH fails.
    }
  }

  void _replaceChat(CloudChatSummary updated) {
    if (isDisposed) return;
    _workspaces = List.unmodifiable([
      for (final workspace in _workspaces)
        _copyWorkspace(
          workspace,
          chats: [
            for (final chat in workspace.chats)
              if (chat.externalId == updated.externalId) updated else chat,
          ],
        ),
    ]);
    notifyListenersSafe();
  }

  static CloudWorkspaceSummary _copyWorkspace(
    CloudWorkspaceSummary value, {
    required List<CloudChatSummary> chats,
  }) => CloudWorkspaceSummary(
    retainedChatCount: value.retainedChatCount,
    deletionRetentionDays: value.deletionRetentionDays,
    externalId: value.externalId,
    name: value.name,
    description: value.description,
    color: value.color,
    coreSandboxId: value.coreSandboxId,
    createdAtMs: value.createdAtMs,
    chats: List.unmodifiable(chats),
  );

  static String _describe(Object error) => switch (error) {
    CloudApiException(:final message) => message,
    _ => "Couldn't load cloud chats",
  };

  static String _describeModels(Object error) => switch (error) {
    CloudApiException(:final message) => message,
    _ => "Couldn't load available models. Try again.",
  };
}
