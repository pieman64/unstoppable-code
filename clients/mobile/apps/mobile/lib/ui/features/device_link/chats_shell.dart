import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'chats_connection_screen.dart';
import 'chats_screen.dart';
import 'chats_view_model.dart';

class DeviceChatsShell extends StatefulWidget {
  const DeviceChatsShell({
    super.key,
    required this.model,
    required this.readCredentials,
  });
  final DeviceChatsViewModel model;
  final Future<String?> Function() readCredentials;
  @override
  State<DeviceChatsShell> createState() => _DeviceChatsShellState();
}

class _DeviceChatsShellState extends State<DeviceChatsShell>
    with WidgetsBindingObserver {
  bool _opening = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      unawaited(widget.model.connection.suspend());
    }
    if (state == AppLifecycleState.resumed) {
      unawaited(widget.model.connection.resume());
    }
  }

  Future<void> _showChat(Future<bool> Function() open) async {
    if (_opening) return;
    _opening = true;
    try {
      if (await open() && mounted) {
        await Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) => DeviceChatScreen(model: widget.model),
          ),
        );
        await widget.model.leaveChat();
      }
    } finally {
      _opening = false;
    }
  }

  Future<void> _newChat() async {
    if (widget.model.creating || _opening) return;
    final destination =
        await showModalBottomSheet<
          ({DeviceChatWorkspace workspace, String title})
        >(
          context: context,
          useSafeArea: true,
          isScrollControlled: true,
          builder: (context) =>
              _DestinationSheet(workspaces: widget.model.chats.workspaces),
        );
    if (destination != null && mounted) {
      await _showChat(
        () => widget.model.create(
          destination.workspace,
          title: destination.title,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.model,
    builder: (context, _) {
      final model = widget.model;
      if (!model.online) {
        return DeviceChatsConnectionScreen(
          model: model.connection,
          readCredentials: widget.readCredentials,
        );
      }
      return CanopyScaffold(
        appBar: CanopyAppBar(
          content: const Text('Device chats'),
          subtitle: Text(
            model.connection.host?['name'] as String? ?? 'Connected computer',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          leading: CanopyIconButton(
            glyph: CanopyGlyph.arrowRotateClockwise,
            tooltip: 'Refresh chats',
            onPressed: model.catalogLoading ? null : model.refreshCatalog,
          ),
          trailing: CanopyIconButton(
            glyph: CanopyGlyph.bubblePlus,
            tooltip: 'New chat',
            onPressed:
                model.creating ||
                    model.catalogLoading ||
                    model.chats.workspaces.isEmpty
                ? null
                : _newChat,
          ),
        ),
        body: Builder(
          builder: (context) => Padding(
            padding: CanopyScaffold.contentPaddingOf(context),
            child: Column(
              children: [
                if (model.error case final error?)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
                    child: InlineNotice(
                      glyph: CanopyGlyph.circleInfo,
                      state: error,
                    ),
                  ),
                Expanded(
                  child: RefreshIndicator(
                    onRefresh: model.refreshCatalog,
                    child: ListView(
                      key: const ValueKey('device-chats-list'),
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.only(top: 8, bottom: 16),
                      children: [
                        if (model.chats.catalog.isEmpty && model.catalogLoading)
                          const Padding(
                            key: ValueKey('device-chats-loading'),
                            padding: EdgeInsets.all(24),
                            child: Center(child: LoadingSpinner(size: 22)),
                          )
                        else if (model.chats.catalog.isEmpty)
                          const Padding(
                            padding: EdgeInsets.all(24),
                            child: Text(
                              'No chats to show. Start a new chat in a workspace.',
                            ),
                          ),
                        for (final chat in model.chats.catalog)
                          ListTile(
                            key: ValueKey('device-chat-row-${chat.id}'),
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 24,
                              vertical: 4,
                            ),
                            minTileHeight: 56,
                            title: Text(
                              chat.title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            onTap: () => _showChat(() => model.open(chat)),
                          ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: CanopyButton(
                            label: 'Disconnect',
                            onPressed: model.connection.disconnect,
                            variant: CanopyButtonVariant.inline,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

class _DestinationSheet extends StatefulWidget {
  const _DestinationSheet({required this.workspaces});
  final List<DeviceChatWorkspace> workspaces;
  @override
  State<_DestinationSheet> createState() => _DestinationSheetState();
}

class _DestinationSheetState extends State<_DestinationSheet> {
  final _title = TextEditingController();
  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.7,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'New chat',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 16),
                  CanopyTextField(
                    key: const ValueKey('device-new-chat-title'),
                    controller: _title,
                    labelText: 'Chat title (optional)',
                    textInputAction: TextInputAction.done,
                  ),
                  const SizedBox(height: 16),
                  const Text('Choose a workspace'),
                ],
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final workspace in widget.workspaces)
                    ListTile(
                      key: ValueKey('device-workspace-${workspace.id}'),
                      title: Text(workspace.name),
                      onTap: () => Navigator.pop(context, (
                        workspace: workspace,
                        title: _title.text,
                      )),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
