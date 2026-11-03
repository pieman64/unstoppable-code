import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// Chat transcript glyphs ported 1:1 from the desktop app's shared icon set
/// (`packages/ui-shared/src/icons/*.tsx`): the collapsed-turn summary chips
/// and the turn feedback thumbs. These are NOT CanopyGlyph catalog glyphs (see
/// `CanopyGlyph` for those), so they live in their own asset folder and are
/// hand-synced with the desktop sources rather than generated.
enum ChatGlyph {
  message('assets/icons/chat/message.svg'),
  thinking('assets/icons/chat/thinking.svg'),
  terminal('assets/icons/chat/terminal.svg'),
  document('assets/icons/chat/document.svg'),
  documentPencil('assets/icons/chat/document-pencil.svg'),
  magnifyingGlass('assets/icons/chat/magnifying-glass.svg'),
  documentSearch('assets/icons/chat/document-search.svg'),
  globe('assets/icons/chat/globe.svg'),
  agent('assets/icons/chat/agent.svg'),
  workflow('assets/icons/chat/workflow.svg'),
  task('assets/icons/chat/task.svg'),
  stop('assets/icons/chat/stop.svg'),
  skill('assets/icons/chat/skill.svg'),
  monitor('assets/icons/chat/monitor.svg'),
  stopwatch('assets/icons/chat/stopwatch.svg'),
  questionMark('assets/icons/chat/question-mark.svg'),
  terminalBordered('assets/icons/chat/terminal-bordered.svg'),
  watcher('assets/icons/chat/watcher.svg'),
  graph('assets/icons/chat/graph.svg'),
  appAdvisor('assets/icons/chat/app-advisor.svg'),
  pipeline('assets/icons/chat/pipeline.svg'),
  mcp('assets/icons/chat/mcp.svg'),
  wrench('assets/icons/chat/wrench.svg'),
  thumbsUp('assets/icons/chat/thumbs-up.svg'),
  thumbsUpFilled('assets/icons/chat/thumbs-up-filled.svg'),
  thumbsDown('assets/icons/chat/thumbs-down.svg'),
  thumbsDownFilled('assets/icons/chat/thumbs-down-filled.svg');

  const ChatGlyph(this.assetPath);

  /// The Flutter asset path for this glyph.
  final String assetPath;
}

/// Renders a [ChatGlyph] tinted to [color] (the SVGs are monochrome
/// `currentColor` line art, like their desktop sources).
class ChatIcon extends StatelessWidget {
  const ChatIcon({super.key, required this.glyph, this.size = 14, this.color});

  final ChatGlyph glyph;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final resolved = color ?? IconTheme.of(context).color;
    return SvgPicture.asset(
      glyph.assetPath,
      width: size,
      height: size,
      colorFilter: resolved == null
          ? null
          : ColorFilter.mode(resolved, BlendMode.srcIn),
    );
  }
}
