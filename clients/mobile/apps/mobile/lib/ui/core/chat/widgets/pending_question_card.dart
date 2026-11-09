import 'package:flutter/material.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/typography.dart';

/// Interactive card for one awaiting AskUserQuestion request. Mirrors the
/// shared desktop/web card (`@canopy/ui-shared` `AskUserQuestionCard`): each
/// question is a radio group (checkboxes when `multiSelect`) of full-width,
/// wrapping option rows, with "Other" as an explicitly selectable peer choice
/// whose text field only appears once it is picked, and Submit/Dismiss below.
///
/// Transport-neutral: the host decides what an answer means (Remote Control
/// sends `portal.chat.answer_question`).
class PendingQuestionCard extends StatefulWidget {
  const PendingQuestionCard({
    super.key,
    required this.request,
    required this.onSubmit,
    required this.onDismiss,
  });

  final AskUserQuestionState request;

  /// Null holds Submit while the host cannot send yet; the answers stay.
  final void Function(List<AskUserQuestionAnswer> answers)? onSubmit;
  final VoidCallback onDismiss;

  @override
  State<PendingQuestionCard> createState() => _PendingQuestionCardState();
}

class _PendingQuestionCardState extends State<PendingQuestionCard> {
  /// Selected concrete option indices, per question. "Other" is tracked in
  /// [_otherSelected] instead of as a magic option value, so it can never
  /// collide with a genuine option (desktop keeps the same separation).
  final Map<int, Set<int>> _selected = {};
  final Set<int> _otherSelected = {};
  final Map<int, TextEditingController> _otherText = {};

  @override
  void dispose() {
    for (final controller in _otherText.values) {
      controller.dispose();
    }
    super.dispose();
  }

  TextEditingController _otherControllerFor(int index) =>
      _otherText.putIfAbsent(index, TextEditingController.new);

  String? _otherTextFor(int index) {
    if (!_otherSelected.contains(index)) return null;
    final text = _otherText[index]?.text.trim();
    return text == null || text.isEmpty ? null : text;
  }

  /// Every answerable question needs a picked option or freeform text before
  /// submit; a question with neither options nor an "other" field cannot block
  /// submission. Selecting "Other" without typing is not yet an answer.
  bool get _canSubmit {
    if (widget.request.questions.isEmpty) return false;
    for (final (index, question) in widget.request.questions.indexed) {
      if (question.options.isEmpty && !question.allowOther) continue;
      final hasOption = (_selected[index] ?? const <int>{}).isNotEmpty;
      if (!hasOption && _otherTextFor(index) == null) return false;
    }
    return true;
  }

  List<AskUserQuestionAnswer> _buildAnswers() => [
    for (final (index, question) in widget.request.questions.indexed)
      AskUserQuestionAnswer(
        questionId: question.id,
        question: question.question,
        selectedOptions: [
          for (final (optionIndex, option) in question.options.indexed)
            if ((_selected[index] ?? const <int>{}).contains(optionIndex))
              option,
        ],
        freeformText: _otherTextFor(index),
      ),
  ];

  void _toggleOption(int index, AskUserQuestion question, int option) {
    setState(() {
      final selections = _selected.putIfAbsent(index, () => <int>{});
      if (question.multiSelect) {
        if (!selections.remove(option)) selections.add(option);
      } else {
        selections
          ..clear()
          ..add(option);
        // Radio semantics: a concrete pick clears "Other".
        _otherSelected.remove(index);
      }
    });
  }

  void _toggleOther(int index, AskUserQuestion question) {
    setState(() {
      if (!_otherSelected.remove(index)) _otherSelected.add(index);
      // Radio semantics: picking "Other" clears the concrete selections.
      if (!question.multiSelect) _selected[index]?.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final requestId = widget.request.requestId;
    return Container(
      // Horizontal insets come from the transcript's own padding — this card
      // is a transcript row, so it lines up with the message bubbles above it.
      margin: const EdgeInsets.only(top: 8, bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.colorScheme.primary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (index, question) in widget.request.questions.indexed)
            Container(
              margin: EdgeInsets.only(top: index > 0 ? 12 : 0),
              padding: EdgeInsets.only(top: index > 0 ? 12 : 0),
              decoration: index > 0
                  ? BoxDecoration(
                      border: Border(
                        top: BorderSide(color: theme.dividerColor),
                      ),
                    )
                  : null,
              child: _QuestionBlock(
                requestId: requestId,
                index: index,
                question: question,
                selected: _selected[index] ?? const <int>{},
                otherSelected: _otherSelected.contains(index),
                otherController: _otherControllerFor(index),
                onToggleOption: (option) =>
                    _toggleOption(index, question, option),
                onToggleOther: () => _toggleOther(index, question),
                onOtherChanged: () => setState(() {}),
              ),
            ),
          const SizedBox(height: 12),
          Row(
            children: [
              FilledButton(
                key: ValueKey('question-submit-$requestId'),
                onPressed: _canSubmit && widget.onSubmit != null
                    ? () => widget.onSubmit?.call(_buildAnswers())
                    : null,
                child: const Text('Submit'),
              ),
              const SizedBox(width: 8),
              TextButton(
                key: ValueKey('question-dismiss-$requestId'),
                onPressed: widget.onDismiss,
                child: const Text('Dismiss'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One question of a [PendingQuestionCard]: optional header, the question
/// text, its option rows, and the "Other" row plus its conditional field.
class _QuestionBlock extends StatelessWidget {
  const _QuestionBlock({
    required this.requestId,
    required this.index,
    required this.question,
    required this.selected,
    required this.otherSelected,
    required this.otherController,
    required this.onToggleOption,
    required this.onToggleOther,
    required this.onOtherChanged,
  });

  final String requestId;
  final int index;
  final AskUserQuestion question;
  final Set<int> selected;
  final bool otherSelected;
  final TextEditingController otherController;
  final ValueChanged<int> onToggleOption;
  final VoidCallback onToggleOther;
  final VoidCallback onOtherChanged;

  /// "Other" shares the question's radio group, one slot past the last real
  /// option, so choosing it deselects whichever option was picked.
  int get _otherValue => question.options.length;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final rows = <Widget>[
      for (final (optionIndex, option) in question.options.indexed)
        _ChoiceRow(
          value: optionIndex,
          multiSelect: question.multiSelect,
          checked: selected.contains(optionIndex),
          label: option,
          description: optionIndex < question.optionDescriptions.length
              ? question.optionDescriptions[optionIndex]
              : null,
          onToggle: () => onToggleOption(optionIndex),
        ),
      if (question.allowOther) ...[
        _ChoiceRow(
          value: _otherValue,
          multiSelect: question.multiSelect,
          checked: otherSelected,
          label: 'Other',
          muted: true,
          onToggle: onToggleOther,
        ),
        if (otherSelected)
          Padding(
            padding: const EdgeInsets.only(left: 4, top: 2, bottom: 4),
            child: TextField(
              key: ValueKey('question-other-field-$requestId-$index'),
              controller: otherController,
              obscureText: question.secret,
              // A secret is a single-line credential; everything else gets
              // desktop's multi-line answer box.
              minLines: question.secret ? 1 : 3,
              maxLines: question.secret ? 1 : 6,
              onChanged: (_) => onOtherChanged(),
              decoration: const InputDecoration(
                isDense: true,
                border: OutlineInputBorder(),
                hintText: 'Type your answer…',
              ),
            ),
          ),
      ],
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (question.header case final header?)
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Text(
              header,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Text(
            question.question,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: AppTypography.emphasisWeight,
              fontVariations: AppTypography.emphasisVariations,
            ),
          ),
        ),
        // Checkbox questions have no single selection, so they stay outside a
        // radio group; single-select rows share one so the framework enforces
        // mutual exclusion for us.
        if (question.multiSelect)
          ...rows
        else
          RadioGroup<int>(
            groupValue: otherSelected ? _otherValue : selected.firstOrNull,
            onChanged: (value) {
              if (value == null) return;
              if (value == _otherValue) {
                onToggleOther();
              } else {
                onToggleOption(value);
              }
            },
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: rows,
            ),
          ),
      ],
    );
  }
}

/// One tappable option row: a radio (or checkbox) plus a wrapping label and
/// optional helper text. The whole row is the hit target, so a long label is
/// as tappable as the control itself.
class _ChoiceRow extends StatelessWidget {
  const _ChoiceRow({
    required this.value,
    required this.multiSelect,
    required this.checked,
    required this.label,
    required this.onToggle,
    this.description,
    this.muted = false,
  });

  final int value;
  final bool multiSelect;
  final bool checked;
  final String label;
  final String? description;
  final bool muted;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onToggle,
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 32,
              height: 32,
              child: multiSelect
                  ? Checkbox(
                      value: checked,
                      visualDensity: VisualDensity.compact,
                      onChanged: (_) => onToggle(),
                    )
                  : Radio<int>(value: value),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 5, bottom: 5),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      label,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: muted
                            ? theme.colorScheme.onSurfaceVariant
                            : theme.colorScheme.onSurface,
                      ),
                    ),
                    if (description case final text? when text.isNotEmpty)
                      Text(
                        text,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
