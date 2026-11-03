import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';
import 'package:mobile/data/models/remote_pipeline_dispatch.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_input_form.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_pipeline_run_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

/// Fills one pipeline's dispatch inputs and starts it on the paired desktop
/// (CAN-3174). Replaces itself with the live run screen once the desktop
/// confirms the start, so Back returns to the chat.
class RemotePipelineDispatchScreen extends StatefulWidget {
  const RemotePipelineDispatchScreen({
    super.key,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.pipeline,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final RemotePipelineDescriptor pipeline;

  @override
  State<RemotePipelineDispatchScreen> createState() =>
      _RemotePipelineDispatchScreenState();
}

class _RemotePipelineDispatchScreenState
    extends State<RemotePipelineDispatchScreen> {
  final Map<String, TextEditingController> _controllers = {};
  Map<String, String> _values = {};
  Map<String, String> _errors = {};
  RemotePipelineDispatchForm? _seededFrom;
  bool _navigated = false;

  String get _pipelineId => widget.pipeline.pipelineId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _open());
  }

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  /// Entering the screen starts from a clean slate: a rejection from an
  /// earlier visit must not sit above Run. The dispatcher keeps an in-flight
  /// start, so re-entering mid-start still shows it.
  void _open() {
    if (!mounted) return;
    context.read<RemoteControlViewModel>().clearPipelineDispatch(
      worktreeLocalId: widget.worktreeLocalId,
      pipelineId: _pipelineId,
    );
    _load();
  }

  void _load() {
    if (!mounted) return;
    unawaited(
      context.read<RemoteControlViewModel>().loadPipelineForm(
        workspaceLocalId: widget.workspaceLocalId,
        worktreeLocalId: widget.worktreeLocalId,
        pipelineId: _pipelineId,
      ),
    );
  }

  /// Seeds the field values once per loaded form, never over the user's edits.
  void _seed(RemotePipelineDispatchForm form) {
    if (identical(_seededFrom, form)) return;
    _seededFrom = form;
    _values = initialPipelineInputValues(form.inputs);
    for (final entry in _values.entries) {
      (_controllers[entry.key] ??= TextEditingController()).text = entry.value;
    }
  }

  void _setValue(String name, String value) => setState(() {
    _values = {..._values, name: value};
    _errors = {..._errors}..remove(name);
  });

  void _run(RemotePipelineDispatchForm form) {
    final visible = visiblePipelineInputs(form.inputs);
    final errors = validatePipelineInputs(visible, _values);
    setState(() => _errors = errors);
    if (errors.isNotEmpty) return;
    final viewModel = context.read<RemoteControlViewModel>();
    viewModel.clearPipelineDispatch(
      worktreeLocalId: widget.worktreeLocalId,
      pipelineId: _pipelineId,
    );
    unawaited(
      viewModel.dispatchPipeline(
        workspaceLocalId: widget.workspaceLocalId,
        worktreeLocalId: widget.worktreeLocalId,
        pipelineId: _pipelineId,
        inputs: buildPipelineInputPayload(visible, _values),
      ),
    );
  }

  void _openRun(RemoteControlViewModel viewModel, String executionId) {
    if (_navigated) return;
    _navigated = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      viewModel.clearPipelineDispatch(
        worktreeLocalId: widget.worktreeLocalId,
        pipelineId: _pipelineId,
      );
      final navigator = Navigator.of(context);
      // Chat → picker → form becomes chat → run: drop the form, then replace
      // the picker, so Back from the run returns to the chat.
      navigator.pop();
      unawaited(
        navigator.pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) =>
                ChangeNotifierProvider<RemoteControlViewModel>.value(
                  value: viewModel,
                  child: RemotePipelineRunScreen(
                    workspaceLocalId: widget.workspaceLocalId,
                    worktreeLocalId: widget.worktreeLocalId,
                    executionId: executionId,
                    pipelineName: widget.pipeline.name,
                  ),
                ),
          ),
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<RemoteControlViewModel>();
    final formState = viewModel.pipelineFormState(
      worktreeLocalId: widget.worktreeLocalId,
      pipelineId: _pipelineId,
    );
    final dispatch = viewModel.pipelineDispatchState(
      worktreeLocalId: widget.worktreeLocalId,
      pipelineId: _pipelineId,
    );
    if (dispatch case RemotePipelineDispatchStarted(:final executionId)) {
      _openRun(viewModel, executionId);
    }
    final submitting = dispatch is RemotePipelineDispatchSubmitting;
    final blocksBack = submitting && !dispatch.queuedWhileReconnecting;
    final status = viewModel.portalConnectionStatus;
    final degraded = RemoteDegradedBanner.isDegraded(status);
    final theme = Theme.of(context);
    return PopScope(
      canPop: !blocksBack,
      child: CanopyScaffold(
        appBar: CanopyAppBar(
          automaticallyImplyLeading: true,
          content: Text(
            widget.pipeline.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.titleMedium,
          ),
        ),
        body: Builder(
          builder: (context) {
            final basePadding = CanopyScaffold.contentPaddingOf(context);
            // The banner sits directly under the app bar, so the content
            // below it drops the top inset the bar would otherwise need.
            final padding = degraded
                ? basePadding.copyWith(top: 0)
                : basePadding;
            final content = switch (formState) {
              // Disconnecting clears every form; say so instead of spinning.
              null when !viewModel.isConnected => _LoadFailure(
                padding: padding,
                message: 'Not connected to a desktop.',
                onRetry: _load,
              ),
              null || RemotePipelineFormLoading() => Padding(
                padding: padding,
                child: const Center(child: CircularProgressIndicator()),
              ),
              RemotePipelineFormFailed(:final message) => _LoadFailure(
                padding: padding,
                message: message,
                onRetry: _load,
              ),
              RemotePipelineFormLoaded(:final form) => _buildForm(
                context,
                padding,
                form,
                submitting: submitting,
                degraded: degraded,
                dispatchError: dispatch is RemotePipelineDispatchFailed
                    ? dispatch.message
                    : null,
              ),
            };
            if (!degraded) return content;
            return Padding(
              padding: EdgeInsets.only(top: basePadding.top),
              child: Column(
                children: [
                  RemoteDegradedBanner(
                    status: status,
                    deviceLabel: viewModel.connection?.deviceLabel,
                  ),
                  Expanded(child: content),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildForm(
    BuildContext context,
    EdgeInsets padding,
    RemotePipelineDispatchForm form, {
    required bool submitting,
    required bool degraded,
    required String? dispatchError,
  }) {
    _seed(form);
    final theme = Theme.of(context);
    final description = widget.pipeline.description;
    final blocked = form.inputsOmitted
        ? 'This pipeline has too many inputs to show here. Run it from the '
              'desktop app.'
        : form.unsupportedReason != null
        ? "This pipeline needs input the phone can't provide. Run it from the "
              'desktop app.'
        : null;
    final fields = visiblePipelineInputs(form.inputs);
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, padding.top + 8, 16, 16),
            children: [
              if (description != null) ...[
                Text(description, style: theme.textTheme.bodyMedium),
                const SizedBox(height: 16),
              ],
              if (blocked != null)
                Text(
                  blocked,
                  key: const ValueKey('pipeline-dispatch-blocked'),
                  style: theme.textTheme.bodyMedium,
                )
              else
                for (final input in fields)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: _InputField(
                      input: input,
                      controller: _controllers[input.name] ??=
                          TextEditingController(text: _values[input.name]),
                      value: _values[input.name] ?? '',
                      error: _errors[input.name],
                      enabled: !submitting,
                      onChanged: (value) => _setValue(input.name, value),
                    ),
                  ),
            ],
          ),
        ),
        if (blocked == null)
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (dispatchError != null) ...[
                    Text(
                      dispatchError,
                      key: const ValueKey('pipeline-dispatch-error'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: StatusColors.of(context).failed,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  // A temporary state: Run stays visible and comes back with the
                  // desktop, rather than the form disappearing.
                  if (degraded && !submitting) ...[
                    Text(
                      "Your desktop is reconnecting. Run when it's back.",
                      key: const ValueKey('pipeline-dispatch-reconnecting'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  CanopyButton(
                    key: const ValueKey('pipeline-dispatch-run'),
                    label: submitting ? 'Starting…' : 'Run',
                    loading: submitting,
                    expand: true,
                    onPressed: submitting || degraded ? null : () => _run(form),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _InputField extends StatelessWidget {
  const _InputField({
    required this.input,
    required this.controller,
    required this.value,
    required this.error,
    required this.enabled,
    required this.onChanged,
  });

  final RemotePipelineInputDefinition input;
  final TextEditingController controller;
  final String value;
  final String? error;
  final bool enabled;
  final ValueChanged<String> onChanged;

  String get _label => input.required ? '${input.name} *' : input.name;

  @override
  Widget build(BuildContext context) {
    final key = ValueKey('pipeline-dispatch-field:${input.name}');
    final description = input.description;
    switch (input.type) {
      case RemotePipelineInputType.boolean
          when !input.required || input.defaultValue != null:
        return SwitchListTile(
          key: key,
          contentPadding: EdgeInsets.zero,
          title: Text(_label),
          subtitle: description == null ? null : Text(description),
          value: value == 'true',
          onChanged: enabled ? (on) => onChanged(on ? 'true' : 'false') : null,
        );
      case RemotePipelineInputType.boolean:
        return _SelectField(
          fieldKey: key,
          name: input.name,
          label: _label,
          hint: description,
          value: value,
          error: error,
          enabled: enabled,
          options: const [('true', 'True'), ('false', 'False')],
          onChanged: onChanged,
        );
      case RemotePipelineInputType.choice:
        return _SelectField(
          fieldKey: key,
          name: input.name,
          label: _label,
          hint: description,
          value: value,
          error: error,
          enabled: enabled,
          options: [for (final option in input.options) (option, option)],
          onChanged: onChanged,
        );
      case RemotePipelineInputType.number:
        final range = [
          if (input.min != null) 'min ${input.min}',
          if (input.max != null) 'max ${input.max}',
        ].join(', ');
        final helper = [?description, if (range.isNotEmpty) range].join(' · ');
        return CanopyTextField(
          key: key,
          controller: controller,
          enabled: enabled,
          keyboardType: const TextInputType.numberWithOptions(
            signed: true,
            decimal: true,
          ),
          labelText: _label,
          helperText: helper.isEmpty ? null : helper,
          errorText: error,
          onChanged: onChanged,
        );
      case RemotePipelineInputType.string:
        return CanopyTextField(
          key: key,
          controller: controller,
          enabled: enabled,
          labelText: _label,
          helperText: description,
          errorText: error,
          onChanged: onChanged,
        );
    }
  }
}

/// A tappable field that opens a bottom sheet of options with a checkmark on
/// the selected one (DESIGN.md picker rule).
class _SelectField extends StatelessWidget {
  const _SelectField({
    required this.fieldKey,
    required this.name,
    required this.label,
    required this.hint,
    required this.value,
    required this.error,
    required this.enabled,
    required this.options,
    required this.onChanged,
  });

  final Key fieldKey;
  final String name;
  final String label;
  final String? hint;
  final String value;
  final String? error;
  final bool enabled;
  final List<(String, String)> options;
  final ValueChanged<String> onChanged;

  Future<void> _pick(BuildContext context) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final (optionValue, optionLabel) in options)
              ListTile(
                key: ValueKey('pipeline-dispatch-choice:$name:$optionValue'),
                title: Text(optionLabel),
                trailing: optionValue == value
                    ? const CanopyIcon(glyph: CanopyGlyph.checkmark1)
                    : null,
                selected: optionValue == value,
                onTap: () => Navigator.of(sheetContext).pop(optionValue),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onChanged(picked);
  }

  @override
  Widget build(BuildContext context) {
    final selected = options.where((option) => option.$1 == value).firstOrNull;
    return InkWell(
      key: fieldKey,
      onTap: enabled ? () => unawaited(_pick(context)) : null,
      child: InputDecorator(
        isEmpty: selected == null,
        decoration: InputDecoration(
          labelText: label,
          hintText: 'Select…',
          helperText: hint,
          errorText: error,
          enabled: enabled,
          suffixIcon: const CanopyIcon(glyph: CanopyGlyph.chevronDownMedium),
        ),
        child: Text(selected?.$2 ?? ''),
      ),
    );
  }
}

class _LoadFailure extends StatelessWidget {
  const _LoadFailure({
    required this.padding,
    required this.message,
    required this.onRetry,
  });

  final EdgeInsets padding;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding.add(const EdgeInsets.symmetric(horizontal: 24)),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          FilledButton.tonal(
            key: const ValueKey('pipeline-dispatch-retry'),
            onPressed: onRetry,
            child: const Text('Try again'),
          ),
        ],
      ),
    ),
  );
}
