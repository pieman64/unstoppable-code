import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/navigation/home_back_handlers.dart';
import 'package:mobile/ui/core/chat/widgets/composer_drawer.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/summary.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'background_tray_header.dart';
import 'background_tray_list.dart';
import 'background_tray_run_row.dart';

/// Portal drawer shell. Expansion is owned by the mounted chat, never persisted.
class BackgroundTray extends StatefulWidget {
  const BackgroundTray({
    super.key,
    required this.summary,
    required this.expanded,
    required this.onExpandedChanged,
    required this.now,
    this.active = true,
    this.onOpenAgent,
    this.runControls,
  });
  final BackgroundTraySummary summary;
  final bool active;
  final int now;
  final ValueChanged<BackgroundTrayAgentTarget>? onOpenAgent;
  final BackgroundTrayRunControls? runControls;
  final bool expanded;
  final ValueChanged<bool> onExpandedChanged;

  @override
  State<BackgroundTray> createState() => _BackgroundTrayState();
}

class _BackgroundTrayState extends State<BackgroundTray> {
  HomeBackHandlers? _backHandlers;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final handlers = HomeNavigationScope.maybeOf(context)?.backHandlers;
    if (handlers == _backHandlers) return;
    _backHandlers?.remove(_consumeBack);
    _backHandlers = handlers;
    handlers?.add(_consumeBack);
  }

  bool _consumeBack() {
    if (!widget.active ||
        !widget.expanded ||
        widget.summary.isHidden ||
        ModalRoute.of(context)?.isCurrent == false) {
      return false;
    }
    widget.onExpandedChanged(false);
    return true;
  }

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_handleKey);
  }

  bool _handleKey(KeyEvent event) {
    if (event is! KeyDownEvent ||
        event.logicalKey != LogicalKeyboardKey.escape ||
        !widget.active ||
        !widget.expanded ||
        widget.summary.isHidden ||
        ModalRoute.of(context)?.isCurrent == false) {
      return false;
    }
    widget.onExpandedChanged(false);
    return true;
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_handleKey);
    _backHandlers?.remove(_consumeBack);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final summary = widget.summary;
    final onExpandedChanged = widget.onExpandedChanged;
    if (summary.isHidden) return const SizedBox.shrink();
    final open = widget.expanded;
    return PopScope(
      canPop: _backHandlers != null || !widget.active || !open,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop && _backHandlers == null) _consumeBack();
      },
      child: Focus(
        autofocus: false,
        child: ComposerDrawerSurface(
          key: const ValueKey('background-tray'),
          child: LayoutBuilder(
            builder: (context, constraints) => Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                BackgroundTrayHeader(
                  summary: summary,
                  expanded: open,
                  onToggle: () => onExpandedChanged(!open),
                ),
                if (open)
                  Flexible(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxHeight: math.min(
                          352,
                          MediaQuery.sizeOf(context).height * .45,
                        ),
                      ),
                      child: BackgroundTrayList(
                        summary: summary,
                        now: widget.now,
                        onOpenAgent: widget.onOpenAgent,
                        runControls: widget.runControls,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
