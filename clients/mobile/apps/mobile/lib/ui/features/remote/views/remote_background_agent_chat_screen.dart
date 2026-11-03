import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/agent_chat.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

/// Read-only retained subagent chat. It follows the root chat's live updates
/// and cannot cross a pairing generation or issue a send/stop command.
class RemoteBackgroundAgentChatScreen extends StatefulWidget {
  const RemoteBackgroundAgentChatScreen({
    super.key,
    required this.source,
    required this.parent,
    required this.target,
    required this.sessionGeneration,
  });
  final RemoteControlViewModel source;
  final RemoteWorktreeChatTarget parent;
  final BackgroundTrayAgentTarget target;
  final int sessionGeneration;

  @override
  State<RemoteBackgroundAgentChatScreen> createState() =>
      _RemoteBackgroundAgentChatScreenState();
}

class _RemoteBackgroundAgentChatScreenState
    extends State<RemoteBackgroundAgentChatScreen> {
  final _expanded = <String>{};

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.source,
    builder: (context, _) {
      final source = widget.source;
      final runs =
          source.sessionGeneration == widget.sessionGeneration &&
              source.isConnected
          ? backgroundTrayAgentRuns(
              source.messagesFor(widget.parent),
              widget.target,
            )
          : const <BackgroundTrayAgentRun>[];
      final part = runs.lastOrNull?.part;
      final data = part?.data;
      final delegation = data?['delegation'];
      final card = delegation is Map<String, dynamic> ? delegation : data;
      final title = card?['description'];
      final truncated = runs.any(
        (run) => run.part.data?['subBlocksTruncated'] == true,
      );
      final streamBacked = runs.any(
        (run) => switch (run.part.data?['delegation']) {
          {'transcriptStore': 'chat-stream-v2'} => true,
          _ => false,
        },
      );
      final notice = streamBacked
          ? 'Open the desktop app for the full transcript.'
          : truncated
          ? "Earlier items aren't available here"
          : null;
      return CanopyScaffold(
        appBar: CanopyAppBar(
          automaticallyImplyLeading: true,
          content: Text(
            title is String && title.isNotEmpty ? title : 'Subagent',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        body: Builder(
          builder: (context) {
            final padding = CanopyScaffold.contentPaddingOf(context);
            if (part == null) {
              return const Center(
                child: Text('This agent is no longer available.'),
              );
            }
            return Column(
              key: const ValueKey('background-agent-chat'),
              children: [
                if (notice != null)
                  Padding(
                    padding: padding.copyWith(left: 16, right: 16, bottom: 8),
                    child: Text(notice, style: AppTypography.bodySmall),
                  ),
                Expanded(
                  child: ChatFeed(
                    chatId: 'agent',
                    messages: [
                      for (final run in runs)
                        ...backgroundTrayAgentMessages(
                          run.part,
                          runGeneration: run.generation,
                        ),
                    ],
                    expandedTurns: _expanded,
                    turnInProgress: false,
                    topContentInset: notice != null ? 0 : padding.top,
                    bottomActionInset: padding.bottom,
                    onToggleTurn: (id) => setState(() {
                      if (!_expanded.remove(id)) _expanded.add(id);
                    }),
                  ),
                ),
              ],
            );
          },
        ),
      );
    },
  );
}
