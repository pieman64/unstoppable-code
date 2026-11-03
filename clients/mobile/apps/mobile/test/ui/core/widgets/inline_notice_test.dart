import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';

void main() {
  for (final (name, theme) in [
    ('light', AppTheme.light),
    ('dark', AppTheme.dark),
  ]) {
    testWidgets('the explanation takes the tertiary ink at the state size '
        '($name, DESIGN.md typography)', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: const Scaffold(
            body: InlineNotice(
              glyph: CanopyGlyph.eyeSlash,
              state: 'Share your work in the feed.',
              explanation: 'Turn this on in the desktop app.',
            ),
          ),
        ),
      );

      final text = tester.widget<RichText>(
        find.descendant(
          of: find.byType(InlineNotice),
          matching: find.byType(RichText),
        ),
      );
      final spans = <TextSpan>[];
      text.text.visitChildren((span) {
        if (span is TextSpan && span.text != null) spans.add(span);
        return true;
      });
      final [state, explanation] = spans;
      final colors = AppColors.of(tester.element(find.byType(InlineNotice)));
      expect(state.text, 'Share your work in the feed.');
      expect(explanation.text, ' Turn this on in the desktop app.');
      expect(explanation.style?.color, colors.foregroundMuted);
      // The state keeps the notice's body ink.
      expect(state.style?.color, isNull);
      // Hierarchy comes from ink and weight, never size.
      expect(state.style?.fontSize, isNull);
      expect(explanation.style?.fontSize, isNull);
      expect(explanation.style?.fontWeight, isNull);
    });
  }
}
