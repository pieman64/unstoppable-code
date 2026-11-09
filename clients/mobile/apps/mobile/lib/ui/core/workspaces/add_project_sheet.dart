import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';
import 'package:mobile/data/models/git_remote_url.dart';

/// Shown when a URL fails the on-phone check.
const String kAddProjectInvalidUrlMessage =
    'Enter a remote git URL, like https://github.com/org/repo.git or '
    'git@github.com:org/repo.git.';

/// Sends one validated, trimmed URL. Resolves to a message for the sheet when
/// nothing was sent, or null once a pending row took over.
typedef AddProjectSubmit = Future<String?> Function(String remoteUrl);

/// Opens the Add project sheet: the connected computer clones a git URL into
/// a new Personal project (CAN-3988). The sheet stays busy through [onSubmit],
/// then closes into the list's pending row. [description] names that computer.
Future<void> showAddProjectSheet(
  BuildContext context, {
  required String description,
  required AddProjectSubmit onSubmit,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (sheetContext) => Padding(
      // Keeps the action above the keyboard.
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
      ),
      child: _AddProjectSheetBody(description: description, onSubmit: onSubmit),
    ),
  );
}

class _AddProjectSheetBody extends StatefulWidget {
  const _AddProjectSheetBody({
    required this.description,
    required this.onSubmit,
  });

  final String description;
  final AddProjectSubmit onSubmit;

  @override
  State<_AddProjectSheetBody> createState() => _AddProjectSheetBodyState();
}

class _AddProjectSheetBodyState extends State<_AddProjectSheetBody> {
  final _url = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting) return;
    final url = _url.text.trim();
    final invalid = url.isEmpty
        ? 'Enter a git repository URL.'
        : isPlausibleGitRemoteUrl(url)
        ? null
        : kAddProjectInvalidUrlMessage;
    if (invalid != null) {
      setState(() => _error = invalid);
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    final error = await widget.onSubmit(url);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
    } else {
      setState(() {
        _submitting = false;
        _error = error;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      key: const ValueKey('add-project-sheet'),
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Add project', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            widget.description,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          CanopyTextField(
            key: const ValueKey('add-project-url'),
            controller: _url,
            labelText: 'Git repository URL',
            hintText: 'https://github.com/org/repo.git',
            errorText: _error,
            enabled: !_submitting,
            autofocus: true,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.done,
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 16),
          CanopyButton(
            key: const ValueKey('add-project-submit'),
            label: _submitting ? 'Adding…' : 'Add project',
            loading: _submitting,
            expand: true,
            onPressed: _submit,
          ),
        ],
      ),
    );
  }
}
