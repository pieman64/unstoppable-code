import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/ui/core/chat/widgets/chat_search_view.dart';
import '../chats_screen.dart';
import 'controller.dart';

class DeviceChatSearchScreen extends StatefulWidget {
  const DeviceChatSearchScreen({super.key, required this.controller});
  final ComputerConnectController controller;
  @override
  State<DeviceChatSearchScreen> createState() => _DeviceChatSearchScreenState();
}

class _DeviceChatSearchScreenState extends State<DeviceChatSearchScreen> {
  int? _openingGeneration;
  @override
  void dispose() {
    if (_openingGeneration case final generation?) {
      unawaited(widget.controller.restoreOverview(generation));
    }
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(widget.controller.chats.refreshCatalog());
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller.chats,
    builder: (context, _) {
      final model = widget.controller.chats;
      final worktrees = widget.controller.worktrees.worktrees;
      return ChatSearchView(
        contextLabel: 'this computer',
        loading: model.catalogLoading,
        error: model.error,
        onRetry: model.refreshCatalog,
        items: [
          for (final ref in model.chats.catalog)
            ChatSearchItem(
              id: ref.id,
              title: ref.title,
              subtitle:
                  worktrees
                      .where(
                        (w) => w.key == '${ref.projectId}/${ref.worktreeId}',
                      )
                      .map((w) => '${w.projectName} · ${w.name}')
                      .firstOrNull ??
                  model.chats.workspaces
                      .where((w) => w.id == ref.projectId)
                      .map((w) => w.name)
                      .firstOrNull ??
                  '',
              worktree: worktrees.any(
                (w) => w.key == '${ref.projectId}/${ref.worktreeId}',
              ),
              onOpen: !model.online
                  ? () {}
                  : () async {
                      final pending = model.open(ref);
                      final generation = model.chats.selectionGeneration;
                      _openingGeneration = generation;
                      final opened = await pending;
                      if (!context.mounted ||
                          _openingGeneration != generation ||
                          model.chats.selectionGeneration != generation) {
                        return;
                      }
                      _openingGeneration = null;
                      if (!opened) {
                        await widget.controller.restoreOverview(generation);
                        return;
                      }
                      widget.controller.enterChat();
                      await Navigator.of(context).push<void>(
                        MaterialPageRoute(
                          builder: (_) => DeviceChatScreen(
                            model: model,
                            worktree: widget.controller.activityContext(ref),
                            locationLabel: worktrees
                                .where(
                                  (w) =>
                                      w.key ==
                                      '${ref.projectId}/${ref.worktreeId}',
                                )
                                .map((w) => w.name)
                                .firstOrNull,
                          ),
                        ),
                      );
                      if (context.mounted) {
                        await widget.controller.restoreOverview(
                          model.chats.selectionGeneration,
                        );
                      }
                    },
            ),
        ],
      );
    },
  );
}
