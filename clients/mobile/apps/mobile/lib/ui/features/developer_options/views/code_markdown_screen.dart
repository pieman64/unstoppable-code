import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';
import 'package:mobile/ui/features/developer_options/views/typography_preview_widgets.dart';

class CodeMarkdownScreen extends StatelessWidget {
  const CodeMarkdownScreen({super.key});

  @override
  Widget build(BuildContext context) => TypographyPreviewPage(
    title: 'Code and markdown',
    children: [
      const TypographyPreviewCard(
        title: 'Conversation text',
        description: 'Inter · Regular, emphasis and italic',
        child: MessageMarkdown(
          text:
              '## Ready for review\nRegular text with **emphasis** and *italic*.\n- Review the changes\n- Run the tests\n> Keep the details easy to read.',
        ),
      ),
      const TypographyPreviewCard(
        title: 'Inline and fenced code',
        description: 'JetBrains Mono · Code blocks use 13 / 20',
        child: MessageMarkdown(
          text:
              'Run `flutter test` from the project.\n```dart\nfinal ready = true;\nif (ready) {\n  runTests();\n}\n```',
        ),
      ),
      const TypographyPreviewCard(
        title: 'Tables',
        description: 'Cells wrap to the column · wide tables scroll sideways',
        child: MessageMarkdown(
          text:
              '| Shape | Result |\n'
              '|---|---|\n'
              '| 2 questions, free-form on one | Free-form arrived as "Additional", no option |\n'
              '| 1 question, ~100-char labels | Returned verbatim, no truncation |\n'
              '| 3 questions, dismissed | Whole batch discarded as an error |',
        ),
      ),
      TypographyPreviewCard(
        title: 'Technical text',
        description: 'Monospace alignment and character shapes',
        child: Text(
          '0 O o  1 I l\n== != <= >= ->\nlib/ui/theme.dart\nrun_01  12.50\nrun_02   3.75',
          style: AppTypography.code,
        ),
      ),
      const Text(
        'These examples use the same markdown renderer and code style as chat messages.',
      ),
    ],
  );
}
