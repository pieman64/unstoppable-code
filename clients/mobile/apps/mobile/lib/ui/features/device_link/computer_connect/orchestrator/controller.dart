import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/desktop/surface.dart';
import 'package:mobile/device_link/orchestrator/catalog.dart';
import 'package:mobile/device_link/orchestrator/questions.dart';
import '../../chats_view_model.dart';
import '../../desktop_link_model.dart';

/// One computer's Orchestrator. It shares connection lifetime with Computer
/// Connect, with independent chat subscriptions, delivery state and drafts.
final class ComputerOrchestratorController extends ChangeNotifier {
  factory ComputerOrchestratorController({
    required DesktopLinkModel connection,
    required DesktopOrchestratorConnection transport,
    required String computerId,
    required ChatDraftStore drafts,
    Timer Function(Duration, void Function()) createTimer = Timer.new,
  }) {
    final catalog = OrchestratorCatalog();
    final questions = OrchestratorQuestions(
      transport.orchestrator,
      main: connection.repository,
    );
    final chats = DeviceChatsViewModel(
      connection: connection,
      chats: DeviceChatsRepository(
        transport.orchestrator,
        readCatalog: catalog.read,
      ),
      ownsConnection: false,
      questionSource: questions,
    )..bindDrafts(computerId, drafts);
    return ComputerOrchestratorController._(
      chats,
      transport,
      catalog,
      questions,
      createTimer,
    );
  }
  ComputerOrchestratorController._(
    this.chats,
    this.transport,
    this.catalog,
    this.questions,
    this.createTimer,
  ) {
    chats.addListener(_changed);
    chats.connection.addListener(_connectionChanged);
    _events = chats.chats.ipc.events.listen(_event);
    _connectionChanged();
  }
  final DeviceChatsViewModel chats;
  final DesktopOrchestratorConnection transport;
  final OrchestratorCatalog catalog;
  final OrchestratorQuestions questions;
  final Timer Function(Duration, void Function()) createTimer;
  late final StreamSubscription<Map<String, dynamic>> _events;
  Timer? _refresh;
  bool _disposed = false, _online = false, _visible = false, _inChat = false;
  int _generation = 0;
  List<OrchestratorEntry>? _watchedEntries;
  void _changed() {
    if (_disposed) return;
    if (!_inChat &&
        !chats.catalogLoading &&
        !identical(_watchedEntries, catalog.entries)) {
      _watchedEntries = catalog.entries;
      unawaited(_watchOverview().catchError((Object _) {}));
    }
    notifyListeners();
  }

  void setVisible(bool value) {
    if (_visible == value || _disposed) return;
    _visible = value;
    if (!value) {
      _refresh?.cancel();
      _refresh = null;
    }
    unawaited(
      transport.setOrchestratorVisible(value).catchError((Object _) {}),
    );
    if (value && chats.online) unawaited(refresh());
  }

  void _connectionChanged() {
    if (_online == chats.online) return;
    _online = chats.online;
    _generation++;
    if (!_online) {
      _watchedEntries = null;
      catalog.invalidate();
      questions.invalidate();
    }
    _refresh?.cancel();
    _refresh = null;
    if (_online) unawaited(_ready());
  }

  Future<void> _ready() async {
    try {
      // Creating the app-advisor sender before this acknowledgement lets the
      // desktop redeliver this controller's pending questions after reconnect.
      await chats.chats.ipc.invoke('app-advisor:window-renderer-ready');
      await transport.setOrchestratorVisible(_visible);
      if (!_disposed && chats.online && !_inChat) await _watchOverview();
    } catch (_) {
      // Catalog/open errors retain an explicit retry in the shared UI.
    }
  }

  void _event(Map<String, dynamic> event) {
    final push = event['payload'];
    if (!_visible ||
        _inChat ||
        !chats.online ||
        event['name'] != 'ipc.push' ||
        push is! Map) {
      return;
    }
    if (!const [
      'chat:state-changed',
      'chat-search:updated',
      'app-advisor:window-command',
      'app-advisor:settings-changed',
      'sidebar-item-groups:changed',
    ].contains(push['channel'])) {
      return;
    }
    // One bounded delay, not a resettable debounce that busy chats can starve.
    _refresh ??= createTimer(const Duration(milliseconds: 500), () {
      _refresh = null;
      unawaited(refresh());
    });
  }

  Future<void> _watchOverview() async {
    if (!chats.online || _inChat || _disposed) return;
    await chats.chats.ipc.invoke('chat:set-state-scopes', [
      {
        'kind': 'scopes',
        'scopes': [
          for (final entry in catalog.entries)
            {'projectId': orchestratorProjectId, 'worktreeId': entry.id},
        ],
      },
    ]);
  }

  Future<void> refresh() async {
    await chats.refreshCatalog();
    if (!_inChat && !_disposed) {
      try {
        await _watchOverview();
      } catch (_) {}
    }
  }

  Future<bool> open(OrchestratorEntry? entry) async {
    if (!chats.online || _inChat || chats.creating || chats.catalogLoading) {
      return false;
    }
    _inChat = true;
    _refresh?.cancel();
    _refresh = null;
    final generation = _generation;
    DeviceChatRef? ref;
    if (entry != null) {
      try {
        ref = await catalog.activeChat(chats.chats.ipc, entry);
      } catch (_) {
        chats.error = "Couldn't load this task.";
        _inChat = false;
        _changed();
        return false;
      }
      if (_disposed || generation != _generation || !chats.online) {
        _inChat = false;
        return false;
      }
    }
    final success = ref != null
        ? await chats.open(ref)
        : entry == null
        ? await chats.create(
            DeviceChatWorkspace(orchestratorProjectId, 'Orchestrator'),
          )
        : await _createTab(entry.id);
    if (_disposed || generation != _generation || !success) {
      _inChat = false;
      return false;
    }
    return true;
  }

  Future<bool> _createTab(String entryId) async {
    try {
      await chats.chats.createTab(orchestratorProjectId, entryId);
      return chats.state != null;
    } catch (_) {
      if (!_disposed) {
        chats.error = "Couldn't create this chat.";
        _changed();
      }
      return false;
    }
  }

  Future<void> leaveChat({bool refreshCatalog = true}) async {
    if (_disposed) return;
    _inChat = false;
    await chats.leaveChat();
    if (_disposed || !chats.online) return;
    if (refreshCatalog) {
      await refresh();
    } else {
      // Failed opens must still release chat interests and restore the list's
      // subscriptions. A catalog refresh would erase their actionable error.
      try {
        await _watchOverview();
      } catch (_) {}
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    catalog.invalidate();
    _refresh?.cancel();
    chats.removeListener(_changed);
    chats.connection.removeListener(_connectionChanged);
    unawaited(_events.cancel());
    unawaited(questions.dispose());
    chats.dispose();
    super.dispose();
  }
}
