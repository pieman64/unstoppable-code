import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/ui/core/quiet_prompt_host.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:provider/provider.dart';

/// Wraps a chat body and presents the satisfaction prompt when one is pending
/// and the chat is [isQuiet]; see [QuietPromptHost] for the other conditions.
///
/// Inert when no [SatisfactionPromptController] is provided, so screen tests
/// that do not care about the prompt need no extra setup.
class SatisfactionPromptHost extends StatelessWidget {
  const SatisfactionPromptHost({
    super.key,
    required this.surface,
    required this.isQuiet,
    required this.child,
    this.settleDelay = const Duration(milliseconds: 1500),
  });

  final SatisfactionSurface surface;
  final bool isQuiet;
  final Widget child;
  final Duration settleDelay;

  @override
  Widget build(BuildContext context) {
    final controller = Provider.of<SatisfactionPromptController?>(context);
    return QuietPromptHost(
      source: controller,
      isDue: () => controller?.pendingPrompt ?? false,
      present: (context) => unawaited(controller?.present(context, surface)),
      isQuiet: isQuiet,
      settleDelay: settleDelay,
      child: child,
    );
  }
}
