import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/ui/core/quiet_prompt_host.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
import 'package:provider/provider.dart';

/// Wraps a cloud chat body and opens the desktop app prompt a successful turn
/// raised, once the chat is [isQuiet] and the keyboard is closed. Reads the
/// view directly because an ancestor Scaffold can remove MediaQuery insets. See
/// [QuietPromptHost] for the route and lifecycle conditions.
///
/// Inert when no [DesktopAppPromptController] is provided.
class DesktopAppPromptHost extends StatefulWidget {
  const DesktopAppPromptHost({
    super.key,
    required this.isQuiet,
    required this.child,
    this.settleDelay = const Duration(milliseconds: 1500),
  });

  final bool isQuiet;
  final Widget child;
  final Duration settleDelay;

  @override
  State<DesktopAppPromptHost> createState() => _DesktopAppPromptHostState();
}

class _DesktopAppPromptHostState extends State<DesktopAppPromptHost>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeMetrics() => setState(() {});

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = Provider.of<DesktopAppPromptController?>(context);
    return QuietPromptHost(
      source: controller,
      isDue: () => controller?.pendingPrompt ?? false,
      present: (context) => unawaited(controller?.presentPending(context)),
      isQuiet: widget.isQuiet && View.of(context).viewInsets.bottom == 0,
      settleDelay: widget.settleDelay,
      child: widget.child,
    );
  }
}
