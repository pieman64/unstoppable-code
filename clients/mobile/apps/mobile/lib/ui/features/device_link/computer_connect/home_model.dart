import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/store.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/chat/view_models/composer_effort.dart';
import 'controller.dart';

/// Resolves remembered choices against current computer inventory. The store
/// never supplies authorization, paths, model policy or project ownership.
class ComputerChatHomeModel extends ChangeNotifier {
  ComputerChatHomeModel(this.controller, this.context, this.store) {
    controller.addListener(_inventoryChanged);
  }
  final ComputerConnectController controller;
  final WorkspaceContext context;
  final DeviceLinkStore store;
  DeviceProject? get project =>
      projects.where((p) => p.id == projectId).firstOrNull;
  List<DeviceProject> get projects => controller.scopeFor(context).projects;
  List<DeviceWorktree> get worktrees => controller
      .scopeFor(context)
      .worktrees
      .where((w) => w.projectId == projectId)
      .toList();
  DeviceWorktree? get worktree =>
      worktrees.where((w) => w.id == worktreeId).firstOrNull;
  List<ModelOption> models = [];
  ProviderAvailability? providerAvailability;
  bool _loaded = false, _loadingSaved = false;
  bool _choicesValid = false, _reloadChoices = false;
  List<String> branches = [];
  String? projectId, worktreeId, baseBranch, modelId, thinkingLevel;
  bool loading = true, branchesSupported = false, _disposed = false;
  String? error, saveError;
  int _generation = 0;
  Future<void> _writes = Future.value();
  RemoteComposerEffort get effort => RemoteComposerEffort.resolve(
    catalog: models,
    modelId: modelId,
    providerType: null,
    level: thinkingLevel ?? 'high',
  );
  bool get canStart =>
      !_disposed &&
      controller.active &&
      error == null &&
      !loading &&
      _choicesValid &&
      controller.chats.online &&
      !controller.scopePending &&
      project != null &&
      (worktreeId == null || worktree != null);
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (_disposed ||
        _loadingSaved ||
        controller.scopePending ||
        !controller.chats.online) {
      return;
    }
    _loadingSaved = true;
    Map<String, dynamic> saved = {};
    try {
      final raw = await store.read();
      if (raw != null) {
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic> && decoded['version'] == 1) {
          saved = decoded;
        }
      }
    } catch (_) {
      /* Ignore unreadable display preferences; keep the record. */
    }
    _loadingSaved = false;
    if (_disposed || controller.scopePending || !controller.chats.online) {
      return;
    }
    _loaded = true;
    final selected = saved['projectId'];
    projectId = projects.any((p) => p.id == selected)
        ? selected as String
        : projects.firstOrNull?.id;
    final tree = saved['worktreeId'];
    worktreeId = worktrees.any((w) => w.id == tree) ? tree as String : null;
    baseBranch = saved['baseBranch'] is String
        ? saved['baseBranch'] as String
        : null;
    modelId = saved['modelId'] is String ? saved['modelId'] as String : null;
    thinkingLevel = saved['thinkingLevel'] is String
        ? saved['thinkingLevel'] as String
        : null;
    await refreshChoices();
  }

  void _inventoryChanged() {
    if (_disposed) return;
    if (controller.scopePending || !controller.chats.online) {
      _choicesValid = false;
      _reloadChoices = true;
      _generation++;
      loading = false;
      _notify();
      return;
    }
    if (!_loaded) {
      if (!controller.scopePending &&
          !controller.loading &&
          controller.chats.online) {
        unawaited(load());
      }
      _notify();
      return;
    }
    // Wait for fresh owner evidence before resolving stale selections.
    if (!controller.scopePending &&
        !controller.loading &&
        controller.chats.online) {
      if (projectId != null && project == null) {
        _choicesValid = false;
        projectId = null;
        worktreeId = baseBranch = modelId = thinkingLevel = null;
        branches = [];
        models = [];
        providerAvailability = null;
      } else if (worktreeId != null && worktree == null) {
        worktreeId = null;
      }
    }
    if (_reloadChoices && !controller.loading && !loading && project != null) {
      _reloadChoices = false;
      unawaited(refreshChoices());
    }
    _notify();
  }

  Future<void> selectProject(String id) async {
    if (!projects.any((p) => p.id == id) || id == projectId) return;
    projectId = id;
    worktreeId = baseBranch = modelId = thinkingLevel = null;
    await refreshChoices();
    await save();
  }

  Future<void> selectWorktree(String? id) async {
    if (id != null && !worktrees.any((w) => w.id == id)) return;
    worktreeId = id;
    _notify();
    await save();
  }

  Future<void> selectBranch(String id) async {
    if (!branches.contains(id)) return;
    baseBranch = id;
    _notify();
    await save();
  }

  Future<void> selectModel(String id) async {
    if (!models.any((m) => m.id == id && m.available)) return;
    modelId = id;
    if (thinkingLevel != null) thinkingLevel = effort.level;
    _notify();
    await save();
  }

  Future<bool> selectEffort(String level) async {
    if (!effort.levels.contains(level)) return false;
    thinkingLevel = level;
    _notify();
    await save();
    return true;
  }

  Future<void> refreshChoices() async {
    final generation = ++_generation;
    final target = project;
    _choicesValid = false;
    _reloadChoices = false;
    loading = true;
    error = null;
    branches = [];
    models = [];
    providerAvailability = null;
    branchesSupported = false;
    _notify();
    try {
      if (target == null ||
          !controller.chats.online ||
          controller.scopePending) {
        return;
      }
      final options = await controller.homeOptions.load(target.id);
      if (_disposed ||
          generation != _generation ||
          !controller.chats.online ||
          controller.scopePending) {
        return;
      }
      // The protocol lists only a reference repository's branches. A shared
      // base is unsafe for multi-repo projects without per-repository evidence.
      branchesSupported =
          target.type == 'single-repo' && options.branchesSupported;
      branches = branchesSupported ? options.branches : [];
      final defaultBranch = branchesSupported ? options.defaultBranch : null;
      if (!branches.contains(baseBranch)) {
        baseBranch = branches.contains(defaultBranch)
            ? defaultBranch as String
            : null;
      }
      models = options.models;
      providerAvailability = options.providerAvailability;
      if (!models.any((m) => m.id == modelId && m.available)) {
        modelId =
            models.any((m) => m.id == options.defaultModelId && m.available)
            ? options.defaultModelId
            : null;
        thinkingLevel = options.defaultThinkingLevel;
      }
      if (thinkingLevel != null) thinkingLevel = effort.level;
      _choicesValid = true;
    } catch (cause) {
      if (!_disposed && generation == _generation) {
        error = cause is DeviceLinkException
            ? cause.message
            : "Couldn't load chat options.";
      }
    } finally {
      if (!_disposed && generation == _generation) {
        loading = false;
        _notify();
      }
    }
  }

  Future<void> save() async {
    final value = jsonEncode({
      'version': 1,
      'projectId': projectId,
      'worktreeId': worktreeId,
      'baseBranch': baseBranch,
      'modelId': modelId,
      'thinkingLevel': thinkingLevel,
    });
    final next = _writes.then((_) => store.write(value));
    _writes = next.catchError((Object _) {});
    try {
      await next;
      saveError = null;
    } catch (_) {
      saveError = 'Selections could not be saved. They will reset next time.';
    }
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    controller.removeListener(_inventoryChanged);
    super.dispose();
  }
}
