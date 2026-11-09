import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action_sheet.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_actions_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_menu.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';

import 'package:mobile/ui/core/chat/widgets/composer_command_list.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/composer_plugins_sheet.dart';
import 'package:mobile/ui/core/chat/widgets/composer_plan_chip.dart';
import 'package:mobile/ui/core/chat/widgets/voice_dictation_button.dart';

/// Why the attachment source rows are disabled once a message holds the most
/// attachments it can carry.
const String kComposerAttachmentLimitReason = 'Up to 8 attachments per message';

/// Where the next staged attachment should be picked from.
enum ChatAttachmentSource { camera, photoLibrary, files }

/// Transport-neutral attachment presentation supplied by an owning chat
/// feature. The shared composer observes state and renders the supplied strip
/// without importing that feature's controller, models, or data access.
class ChatInputAttachments {
  const ChatInputAttachments({
    required this.listenable,
    required this.strip,
    required this.hasAttachments,
    this.hasSendableAttachments,
    required this.canAdd,
    required this.canSend,
    required this.onAttach,
  });

  final Listenable listenable;
  final Widget strip;

  /// Whether the strip has files to display.
  final bool Function() hasAttachments;

  /// Whether files alone make the draft sendable. Defaults to [hasAttachments];
  /// hosts that require text can keep the strip visible without enabling Send.
  final bool Function()? hasSendableAttachments;
  final bool Function() canAdd;
  final bool Function() canSend;
  final ValueChanged<ChatAttachmentSource> onAttach;
}

/// Transport-neutral chat composer presentation. The owning route supplies
/// its draft and resolved control callbacks; this widget has no repository
/// access.
class ChatInput extends StatelessWidget {
  const ChatInput({
    super.key,
    required this.controller,
    required this.sending,
    required this.onSend,
    this.enabled = true,
    this.voiceEnabled,
    this.actionsEnabled,
    this.controls,
    this.voice,
    this.attachments,
    this.attachmentsUnavailableReason,
    this.plugins,
    this.planMode,
    this.commands,
    this.hintText,
    this.autofocus = false,
    this.header,
    this.attachedHeader,
    this.watchers,
  }) : assert(header == null || attachedHeader == null);

  static const double _inset = 4;
  static const double _borderWidth = 1;
  // Align the outer corner center with the inset circular action's center.
  static const double _cornerRadius =
      CanopyComposerAction.diameter / 2 + _inset + _borderWidth;

  /// How far an [attachedHeader] runs behind the composer's top edge, so the
  /// composer's rounded corners sit on top of it. A drawer pads its content
  /// by this much to keep it clear of the composer.
  static const double attachedHeaderOverlap = _cornerRadius;

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;

  /// When false the send action is held, used while the worktree's chat tabs
  /// are still hydrating and the target chat id is not yet known.
  final bool enabled;

  /// Whether voice dictation can start. Defaults to [enabled] so unresolved
  /// chat targets keep every action held, while routes may independently hold
  /// Send without blocking draft dictation.
  final bool? voiceEnabled;

  /// Whether the `+` sheet can open. Defaults to [enabled]; like
  /// [voiceEnabled], a route may hold Send while files can still be staged.
  final bool? actionsEnabled;

  /// Model/plan/thinking/fast/stop controls for the resolved chat, or null
  /// while no chat is resolved yet.
  final ComposerControlsData? controls;

  /// Dictation for the draft; the mic renders only when supplied, so this
  /// widget stays stateless and repository-free.
  final VoiceDictationController? voice;

  /// Optional feature-owned attachment presentation. The `+` sheet's
  /// attachment source rows and the strip render only when supplied.
  final ChatInputAttachments? attachments;

  /// Why attachments are unavailable on this surface. When set, the
  /// attachment source rows render disabled with this text instead of
  /// disappearing; files already in [attachments] stay on the strip.
  final String? attachmentsUnavailableReason;

  /// The chat's plugin selection; null hides the Plugins row and `/plugins`.
  final ComposerPluginsSource? plugins;

  /// Plan mode where [controls] has none yet, such as a worktree before its
  /// first chat. The plan mode of [controls] wins.
  final PlanModeControl? planMode;

  PlanModeControl? get _planMode => controls?.planMode ?? planMode;

  /// Host suggestions for `/` and `$`. Built-in actions come from [controls]
  /// and [attachments]; null turns suggestions off.
  final ComposerCommandSource? commands;

  /// Optional route-specific composer prompt. Sending can remain disabled
  /// while a target resolves without making the draft field look unavailable.
  final String? hintText;

  /// Focuses the draft when the composer first appears, for routes that
  /// open ready to type.
  final bool autofocus;

  /// A row above the composer box, such as a new chat's destination control
  /// (CAN-2932); null renders nothing there.
  final Widget? header;

  /// An alternative header joined to the input: as wide as the composer and
  /// running [attachedHeaderOverlap] behind its top edge. Use for a
  /// `ComposerDrawerSurface`, such as the work drawer or Home's context
  /// pickers; [header] keeps the separated destination-control layout.
  final Widget? attachedHeader;

  /// The chat's watchers control, after the model and effort controls like
  /// desktop's `watchersSlot`; null renders nothing there.
  final Widget? watchers;

  /// The built-in `/` actions this composer can run, in desktop order.
  /// [live] feeds the Effort sheet the host's latest controls.
  List<ComposerAction> _actions(
    BuildContext context,
    ValueListenable<ComposerControlsData?> live,
  ) {
    final controls = this.controls;
    final attachments = this.attachments;
    final plugins = this.plugins;
    final plan = _planMode;
    return [
      if (plugins != null)
        ComposerAction(
          name: 'plugins',
          description: plugins.readOnlyReason == null
              ? 'Choose plugins and skills for this chat'
              : 'Browse plugins and skills for this chat',
          onRun: () => unawaited(showComposerPluginsSheet(context, plugins)),
        ),
      if (attachments != null)
        ComposerAction(
          name: 'attach',
          description: 'Add an attachment to the draft',
          onRun: () => _openActions(context),
          disabledReason:
              attachmentsUnavailableReason ??
              (attachments.canAdd()
                  ? null
                  : 'This message has the most attachments it can hold.'),
        ),
      if (controls != null) ...[
        // Matches the model chip, which is disabled while the host holds the
        // selection.
        if (controls.onSelectModel != null)
          ComposerAction(
            name: 'model',
            description: 'Choose the model for this chat',
            onRun: () => unawaited(
              showComposerModelPicker(context, ValueNotifier(controls)),
            ),
          ),
        if (controls.effort != null)
          ComposerAction(
            name: 'thinking',
            description: 'Choose the effort level',
            onRun: () => unawaited(showComposerEffortSheet(context, live)),
          ),
      ],
      if (plan != null)
        ComposerAction(
          name: 'plan',
          description: 'Toggle plan mode',
          onRun: plan.onToggle,
        ),
      if (controls != null)
        ComposerAction(
          name: 'fast',
          description: 'Toggle Fast mode',
          onRun: controls.onToggleFast,
          disabledReason: !controls.supportsFastMode
              ? 'Speed options are available for Codex models.'
              : !controls.canToggleFast
              ? 'Ultra fast is on. Change it in the desktop app.'
              : null,
        ),
    ];
  }

  /// The `+` sheet's attachment source rows, in order: source, row id,
  /// glyph, and label.
  static const _attachSources = [
    (
      ChatAttachmentSource.camera,
      'attach-camera',
      CanopyGlyph.camera1,
      'Take photo',
    ),
    (
      ChatAttachmentSource.photoLibrary,
      'attach-library',
      CanopyGlyph.images1,
      'Photo library',
    ),
    (
      ChatAttachmentSource.files,
      'attach-files',
      CanopyGlyph.pageAttachment,
      'Files',
    ),
  ];

  /// The `+` sheet's rows that apply to this chat, in their fixed order.
  List<CanopyComposerSheetAction> _sheetActions(BuildContext context) {
    final attachments = this.attachments;
    final unavailableReason = attachmentsUnavailableReason;
    final plugins = this.plugins;
    final plan = _planMode;
    final pluginCount = plugins?.selectedCount();
    final canAdd =
        unavailableReason == null && (attachments?.canAdd() ?? false);
    final attachDisabledReason =
        unavailableReason ?? (canAdd ? null : kComposerAttachmentLimitReason);
    return [
      if (attachments != null || unavailableReason != null)
        for (final (source, id, glyph, label) in _attachSources)
          CanopyComposerSheetAction(
            id: id,
            glyph: glyph,
            label: label,
            enabled: canAdd,
            // One reason under the first source covers all three.
            detail: source == _attachSources.first.$1
                ? attachDisabledReason
                : null,
            onSelected: () => attachments?.onAttach(source),
          ),
      if (plugins != null)
        CanopyComposerSheetAction(
          id: 'plugins',
          glyph: CanopyGlyph.puzzle,
          label: 'Plugins',
          count: pluginCount,
          onSelected: () =>
              unawaited(showComposerPluginsSheet(context, plugins)),
        ),
      if (plan != null)
        CanopyComposerSheetAction(
          id: 'plan',
          glyph: CanopyGlyph.map,
          label: 'Plan mode',
          toggled: plan.enabled,
          onSelected: plan.onToggle,
        ),
    ];
  }

  /// Closes the keyboard, then opens the `+` sheet. The draft's text and
  /// selection stay as they are.
  void _openActions(BuildContext context) {
    FocusManager.instance.primaryFocus?.unfocus();
    unawaited(
      showCanopyComposerActionSheet(context, actions: _sheetActions(context)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final controls = this.controls;
    final voice = this.voice;
    final attachments = this.attachments;
    final hasActions =
        attachments != null ||
        attachmentsUnavailableReason != null ||
        plugins != null ||
        _planMode != null;
    final attached = attachedHeader != null;
    final header = attachedHeader ?? this.header;
    final composer = LayoutBuilder(
      builder: (context, constraints) => Padding(
        // Reclaim the outer gutters when the keyboard leaves a shallow pane.
        // The effort control keeps its 48-point touch target.
        padding: EdgeInsets.fromLTRB(
          8,
          attached || constraints.maxHeight < 112 ? 0 : 8,
          8,
          constraints.maxHeight < 112 ? 0 : 8,
        ),
        child: Container(
          key: const ValueKey('chat-composer'),
          padding: const EdgeInsets.all(_inset),
          decoration: BoxDecoration(
            color: colors.surface,
            border: Border.all(color: colors.border, width: _borderWidth),
            borderRadius: BorderRadius.circular(_cornerRadius),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ListenableBuilder(
                        listenable: attachments?.listenable ?? controller,
                        builder: (context, _) {
                          final plan = _planMode;
                          final hasAttachments =
                              attachments?.hasAttachments() ?? false;
                          if (!(plan?.enabled ?? false) && !hasAttachments) {
                            return const SizedBox.shrink();
                          }
                          return Row(
                            key: const ValueKey('composer-context-row'),
                            spacing: 6,
                            children: [
                              if (plan != null && plan.enabled)
                                ComposerPlanChip(
                                  key: const ValueKey('composer-plan'),
                                  onDisable: plan.onToggle,
                                ),
                              if (hasAttachments && attachments != null)
                                Expanded(child: attachments.strip),
                            ],
                          );
                        },
                      ),
                      TextField(
                        key: const ValueKey('composer-draft'),
                        controller: controller,
                        autofocus: autofocus,
                        style: AppTypography.body.copyWith(
                          color: colors.foreground,
                        ),
                        minLines: 2,
                        maxLines: 7,
                        textInputAction: TextInputAction.newline,
                        decoration: InputDecoration(
                          hintStyle: AppTypography.body.copyWith(
                            color: colors.foregroundMuted,
                          ),
                          hintText:
                              hintText ??
                              (enabled
                                  ? 'Message the agent…'
                                  : 'Loading chat…'),
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          filled: false,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 4,
                            vertical: 8,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              // Bottom alignment keeps Send in the corner when the effort
              // trigger's taller touch target sets the row's height.
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                spacing: 4,
                children: [
                  // A surface with nothing to add, such as App Advisor, shows
                  // no `+` rather than a control that can never be used.
                  if (hasActions)
                    CanopyComposerActionsButton(
                      key: const ValueKey('composer-actions'),
                      tooltip: 'Add files and more',
                      onPressed: (actionsEnabled ?? enabled) && !sending
                          ? () => _openActions(context)
                          : null,
                    ),
                  Expanded(
                    child: switch ((controls, watchers)) {
                      (null, _) => const SizedBox(height: 32),
                      (final controls?, null) => ComposerToolbar(
                        data: controls,
                      ),
                      // The toolbar's own layout sees the room the chip
                      // leaves, so the model label shrinks first.
                      (final controls?, final watchers?) => Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        spacing: 4,
                        children: [
                          Flexible(child: ComposerToolbar(data: controls)),
                          watchers,
                        ],
                      ),
                    },
                  ),
                  if (voice != null)
                    ListenableBuilder(
                      listenable: voice,
                      builder: (context, _) => VoiceDictationButton(
                        key: const ValueKey('composer-mic'),
                        state: voice.state,
                        onPressed: switch (voice.state) {
                          _ when !(voiceEnabled ?? enabled) || sending => null,
                          VoiceDictationState.connecting => null,
                          VoiceDictationState.listening => () => unawaited(
                            voice.stop(),
                          ),
                          VoiceDictationState.idle ||
                          VoiceDictationState.error => () => unawaited(
                            voice.start(),
                          ),
                        },
                      ),
                    ),
                  ValueListenableBuilder<TextEditingValue>(
                    valueListenable: controller,
                    builder: (context, value, _) {
                      return ListenableBuilder(
                        listenable: attachments?.listenable ?? controller,
                        builder: (context, _) {
                          final hasDraft = value.text.trim().isNotEmpty;
                          final hasSendableAttachments =
                              attachments?.hasSendableAttachments?.call() ??
                              attachments?.hasAttachments() ??
                              false;
                          final hasComposerContent =
                              hasDraft || hasSendableAttachments;
                          if ((controls?.isRunning ?? false) &&
                              !hasComposerContent) {
                            return CanopyComposerAction(
                              key: const ValueKey('composer-stop'),
                              stopping: true,
                              onPressed: enabled ? controls?.onStop : null,
                            );
                          }
                          final attachmentsBlockSend =
                              attachments != null && !attachments.canSend();
                          return CanopyComposerAction(
                            key: const ValueKey('composer-send'),
                            busy: sending,
                            onPressed:
                                enabled &&
                                    !sending &&
                                    hasComposerContent &&
                                    !attachmentsBlockSend
                                ? onSend
                                : null,
                          );
                        },
                      );
                    },
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
    final menu = ComposerLiveData<ComposerControlsData?>(
      value: controls,
      builder: (context, live) => ComposerCommandMenu(
        draft: controller,
        source: commands,
        actions: commands == null ? const [] : _actions(context, live),
        enabled: enabled,
        dollar: controls?.supportsDollarCommands ?? false,
        headerOverlap: attachedHeader != null ? _cornerRadius : 0,
        child: composer,
      ),
    );
    // Keep the header and toolbar touch targets intact. When the keyboard
    // leaves less than those rows and a draft line, scroll the group from
    // the bottom so Send and the draft remain visible.
    final minimumHeight =
        48 +
        8 +
        MediaQuery.textScalerOf(context).scale(40) +
        16 +
        48 +
        2 * (_inset + _borderWidth);
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        reverse: true,
        physics: const _DraftGroupScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: constraints.maxHeight < minimumHeight
                ? minimumHeight
                : constraints.maxHeight,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: attached
                    ? const EdgeInsets.fromLTRB(8, 8, 8, 0)
                    : const EdgeInsets.symmetric(horizontal: 8),
                // Run behind the composer, which paints over the drawer's
                // lower edge so its rounded corners sit on top. An open
                // command list leaves that edge clear instead.
                child: _OverlapBelow(
                  overlap: attached ? _cornerRadius : 0,
                  // Reserve a draft line, toolbar and transcript touch
                  // target. A tall header scrolls internally before it can
                  // displace Send.
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight:
                          (constraints.maxHeight - minimumHeight).clamp(
                            48.0,
                            double.infinity,
                          ) +
                          (attached ? _cornerRadius : 0),
                    ),
                    child: header ?? const SizedBox.shrink(),
                  ),
                ),
              ),
              Flexible(child: menu),
            ],
          ),
        ),
      ),
    );
  }
}

/// Lays its child out at full height but takes [overlap] less space below,
/// so the next sibling in a column paints over the child's lower edge. That
/// hidden strip is covered by the sibling, so hit testing ignores it.
class _OverlapBelow extends SingleChildRenderObjectWidget {
  const _OverlapBelow({required this.overlap, super.child});

  final double overlap;

  @override
  _RenderOverlapBelow createRenderObject(BuildContext context) =>
      _RenderOverlapBelow(overlap);

  @override
  void updateRenderObject(
    BuildContext context,
    _RenderOverlapBelow renderObject,
  ) => renderObject.overlap = overlap;
}

class _RenderOverlapBelow extends RenderProxyBox {
  _RenderOverlapBelow(this._overlap);

  double _overlap;
  set overlap(double value) {
    if (value == _overlap) return;
    _overlap = value;
    markNeedsLayout();
  }

  @override
  void performLayout() {
    final child = this.child;
    if (child == null) {
      size = constraints.smallest;
      return;
    }
    child.layout(constraints, parentUsesSize: true);
    final height = child.size.height;
    // An empty header, like a hidden work drawer, takes no space at all.
    size = constraints.constrain(
      Size(child.size.width, height > _overlap ? height - _overlap : 0),
    );
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final size = child?.getDryLayout(constraints) ?? constraints.smallest;
    return constraints.constrain(
      Size(size.width, size.height > _overlap ? size.height - _overlap : 0),
    );
  }

  @override
  double computeMinIntrinsicHeight(double width) {
    final height = super.computeMinIntrinsicHeight(width);
    return height > _overlap ? height - _overlap : 0;
  }

  @override
  double computeMaxIntrinsicHeight(double width) {
    final height = super.computeMaxIntrinsicHeight(width);
    return height > _overlap ? height - _overlap : 0;
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    if (size.height > 0) super.paint(context, offset);
  }
}

// Caret reveal belongs to the draft's own scroller. Moving this outer group
// implicitly would push Send below the keyboard; explicit drags still work.
class _DraftGroupScrollPhysics extends ClampingScrollPhysics {
  const _DraftGroupScrollPhysics({super.parent});

  @override
  bool get allowImplicitScrolling => false;

  @override
  _DraftGroupScrollPhysics applyTo(ScrollPhysics? ancestor) =>
      _DraftGroupScrollPhysics(parent: buildParent(ancestor));
}
