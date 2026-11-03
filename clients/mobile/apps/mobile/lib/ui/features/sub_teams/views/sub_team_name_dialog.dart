import 'package:flutter/material.dart';

/// Shows a single-field text dialog for creating or renaming a sub-team.
///
/// Returns the trimmed, non-empty name the user confirmed, or `null` when the
/// dialog is dismissed or the field is left empty. [initialValue] pre-fills the
/// field (used by the rename flow) and is pre-selected for quick replacement.
Future<String?> showSubTeamNameDialog(
  BuildContext context, {
  required String title,
  required String confirmLabel,
  String initialValue = '',
}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _SubTeamNameDialog(
      title: title,
      confirmLabel: confirmLabel,
      initialValue: initialValue,
    ),
  );
}

class _SubTeamNameDialog extends StatefulWidget {
  const _SubTeamNameDialog({
    required this.title,
    required this.confirmLabel,
    required this.initialValue,
  });

  final String title;
  final String confirmLabel;
  final String initialValue;

  @override
  State<_SubTeamNameDialog> createState() => _SubTeamNameDialogState();
}

class _SubTeamNameDialogState extends State<_SubTeamNameDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialValue,
  );
  bool _showError = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty) {
      setState(() => _showError = true);
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _submit(),
        onChanged: (_) {
          if (_showError) setState(() => _showError = false);
        },
        decoration: InputDecoration(
          labelText: 'Sub-team name',
          border: const OutlineInputBorder(),
          errorText: _showError ? 'Enter a sub-team name' : null,
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: Text(widget.confirmLabel)),
      ],
    );
  }
}
