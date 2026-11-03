import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';

/// Interactive reference for the shared search field's states.
class SearchFieldScreen extends StatefulWidget {
  const SearchFieldScreen({super.key});

  @override
  State<SearchFieldScreen> createState() => _SearchFieldScreenState();
}

class _SearchFieldScreenState extends State<SearchFieldScreen> {
  final _empty = TextEditingController();
  final _text = TextEditingController(text: 'staging');
  final _focused = TextEditingController();

  @override
  void dispose() {
    _empty.dispose();
    _text.dispose();
    _focused.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Search field'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(16),
          children: [
            const Text(
              'Filled, with no underline or outline. Clear appears while '
              'the field has text; focus tints the fill.',
            ),
            for (final (key, label, controller, autofocus) in [
              ('empty', 'Empty', _empty, false),
              ('text', 'With text', _text, false),
              ('focused', 'Focused', _focused, true),
            ]) ...[
              const SizedBox(height: 16),
              Text(label, style: theme.textTheme.labelLarge),
              const SizedBox(height: 8),
              CanopySearchField(
                key: ValueKey('search-field-preview-$key'),
                controller: controller,
                hintText: 'Search pipelines',
                autofocus: autofocus,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
