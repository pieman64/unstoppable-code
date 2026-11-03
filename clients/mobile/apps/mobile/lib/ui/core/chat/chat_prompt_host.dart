import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

/// App composition supplies the end-of-turn prompts without coupling the
/// conversation to the features that own them.
typedef ChatPromptBuilder =
    Widget Function(BuildContext context, bool isQuiet, Widget child);

class ChatPromptHost extends StatelessWidget {
  const ChatPromptHost({super.key, required this.isQuiet, required this.child});

  final bool isQuiet;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final builder = context.watch<ChatPromptBuilder?>();
    return builder?.call(context, isQuiet, child) ?? child;
  }
}
