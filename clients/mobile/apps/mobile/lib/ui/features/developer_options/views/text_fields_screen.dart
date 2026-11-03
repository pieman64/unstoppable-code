import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';

class TextFieldsScreen extends StatefulWidget {
  const TextFieldsScreen({super.key});

  @override
  State<TextFieldsScreen> createState() => _TextFieldsScreenState();
}

class _TextFieldsScreenState extends State<TextFieldsScreen> {
  final _empty = TextEditingController();
  final _value = TextEditingController(text: 'develop');
  final _error = TextEditingController(text: '6');
  final _disabled = TextEditingController(text: 'main');

  @override
  void dispose() {
    for (final controller in [_empty, _value, _error, _disabled]) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: const Text('Text fields'),
    ),
    body: Builder(
      builder: (context) => ListView(
        padding:
            CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(16),
        children: [
          CanopyTextField(
            key: const ValueKey('text-field-preview-empty'),
            controller: _empty,
            labelText: 'Base branch',
            helperText:
                'Base branch used to compute the merge-base for review.',
          ),
          const SizedBox(height: 24),
          CanopyTextField(
            key: const ValueKey('text-field-preview-value'),
            controller: _value,
            labelText: 'With text',
          ),
          const SizedBox(height: 24),
          CanopyTextField(
            key: const ValueKey('text-field-preview-error'),
            controller: _error,
            labelText: 'Review count',
            keyboardType: TextInputType.number,
            errorText: 'Enter a number from 1 to 5.',
          ),
          const SizedBox(height: 24),
          CanopyTextField(
            key: const ValueKey('text-field-preview-disabled'),
            controller: _disabled,
            labelText: 'Disabled',
            enabled: false,
          ),
        ],
      ),
    ),
  );
}
