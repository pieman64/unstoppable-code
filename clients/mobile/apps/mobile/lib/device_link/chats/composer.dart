import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'composer_catalog.dart';
import 'dto.dart';
import 'models.dart';

typedef DeviceComposerSnapshot = ({
  int revision,
  Map<String, dynamic> tab,
  Map<String, Object?> selections,
});

/// No cached invocation text is safe without the host's chat-aware resolver.
/// See the CAN-5792 audit for the missing effective-selection boundary.
const deviceInvocableUnavailable =
    'Choose this skill or command in the desktop app.';

/// The existing tunneled settings patch lacks an atomic selection guard.
const devicePluginSelectionsReadOnly =
    'Catalog only. Change selections in the desktop app.';

/// Existing tunneled catalog and canonical selection reads only.
final class DeviceChatComposerRepository {
  DeviceChatComposerRepository(this.ipc);
  final DesktopIpc ipc;

  Future<Object?> _read(
    String channel, [
    List<Object?> args = const [],
  ]) async => deviceChatDto(await ipc.invoke(channel, args));

  Object? _data(Object? value) {
    final result = deviceLinkObject(value);
    if (result['success'] != true || !result.containsKey('data')) {
      throw const DeviceLinkException(
        "Couldn't load choices from your computer. Try again.",
      );
    }
    return result['data'];
  }

  Future<ComposerPluginCatalog> catalog() async {
    final values = await Future.wait([
      _read('collections:load-index'),
      _read('skills:load'),
      _read('plugins:loadCacheOnly'),
      _read('mcp-servers:load-index'),
    ]);
    return deviceComposerCatalog(
      collections: values[0],
      skills: _data(values[1]),
      plugins: _data(values[2]),
      servers: values[3],
    );
  }

  Future<DeviceComposerSnapshot> snapshot(DeviceChatRef ref) async {
    final result = deviceLinkObject(await _read('chat:get-state', [ref.scope]));
    final file = deviceLinkObject(result['tabsFile']);
    final tabs = file['tabs'];
    final revision = result['revision'];
    if (tabs is! List || revision is! int) {
      throw const FormatException('Missing chat state');
    }
    final tab = tabs
        .map(deviceLinkObject)
        .where((t) => t['id'] == ref.id)
        .firstOrNull;
    if (tab == null || tab['kind'] == 'file' || tab['archivedAt'] != null) {
      throw const DeviceLinkException('The chat is closed. Open another chat.');
    }
    final selections = tab['pluginSelections'];
    return (
      revision: revision,
      tab: tab,
      selections: normalizePluginSelections(
        selections == null ? null : deviceLinkObject(selections),
      ),
    );
  }

  /// The raw inventory has no chat target, so its rows are browse-only.
  /// Never pass local selections to raw resolve or insert provisional text.
  Future<({List<ComposerCommand> commands, bool unsettled})> inventory(
    String harness,
  ) async {
    final result = deviceLinkObject(
      _data(
        await _read('invocable-inventory:load', [
          {'providerType': harness},
        ]),
      ),
    );
    final entries = result['entries'];
    if (entries is! List ||
        result['stale'] is! bool ||
        result['rebuilding'] is! bool) {
      throw const FormatException('Missing invocable inventory');
    }
    return (
      commands: [
        for (final raw in entries)
          if (deviceLinkObject(raw) case final entry
              when entry['provider'] == harness)
            ComposerCommand(
              name: deviceLinkString(entry, 'name'),
              displayName: entry['displayName'] as String?,
              description: entry['description'] as String? ?? '',
              entryId: deviceLinkString(entry, 'id'),
              requiresResolution: true,
              unavailableReason: deviceInvocableUnavailable,
            ),
      ],
      unsettled: result['stale'] == true || result['rebuilding'] == true,
    );
  }
}
