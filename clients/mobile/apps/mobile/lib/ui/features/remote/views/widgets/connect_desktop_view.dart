import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_pairing_failure.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

/// Pairing form shown while disconnected (or after a failed attempt): a
/// numbered procedure for finding the code on the desktop, then the slot it
/// gets typed into.
///
/// The web portal's `portal-code-form.tsx` still carries the older copy that
/// only says a code exists, so this view deliberately no longer mirrors it.
class ConnectDesktopView extends StatefulWidget {
  const ConnectDesktopView({super.key});

  @override
  State<ConnectDesktopView> createState() => _ConnectDesktopViewState();
}

/// Padding around the form. Named so the fill constraint can subtract the real
/// value instead of a copied literal.
///
/// The vertical budget here is genuinely tight: on a 375x667 phone inside the
/// app shell the form clears the fold by only a few points, and by
/// fewer still once a rejected code adds error text. If you add anything to
/// this screen, expect the fold test to tell you what it costs.
const EdgeInsets _formPadding = EdgeInsets.fromLTRB(20, 8, 20, 8);

/// Gap between the procedure and the slot it ends in. Fixed rather than
/// elastic: letting it absorb every spare point is what put a third of a
/// 390x844 screen between the steps and the code field.
const double _procedureToActionGap = 20;

/// Corner radius for the inner chips and cells, matching the 8pt the rest of
/// the Remote surfaces use inside their 12pt containers.
const double _innerRadius = 8;

class _ConnectDesktopViewState extends State<ConnectDesktopView> {
  static const int _codeLength = 6;

  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();

  /// Whether the last build was showing a rejected-code error, so the focus
  /// hand-off below fires on the transition rather than on every rebuild.
  bool _wasShowingError = false;

  @override
  void initState() {
    super.initState();
    // The cell strip renders from controller text and focus, so both have to
    // repaint it. Without the focus listener the active-cell outline would
    // only appear on the next keystroke.
    _focusNode.addListener(_onFocusChanged);
  }

  @override
  void dispose() {
    _focusNode.removeListener(_onFocusChanged);
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onFocusChanged() {
    if (mounted) setState(() {});
  }

  /// Puts the keyboard back after a rejected code.
  ///
  /// Not `autofocus`: whether this view remounts on failure depends on how
  /// long the connect attempt took, since RemoteScreen swaps in a spinner
  /// while connecting. Reacting to the transition works either way.
  void _focusAfterError({required bool showingError}) {
    final bool justFailed = showingError && !_wasShowingError;
    _wasShowingError = showingError;
    if (!justFailed) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // Select the rejected digits as well as focusing, so the next keystroke
      // replaces them instead of the user backspacing six times.
      //
      // This does not rescue paste-over-a-full-code: long-press collapses the
      // selection before the menu opens, and `maxLength` makes the paste a
      // no-op anyway. That limit predates this screen's redesign — clearing
      // the field on rejection would fix it, at the cost of hiding what was
      // actually entered.
      _controller.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _controller.text.length,
      );
      _focusNode.requestFocus();
    });
  }

  String get _code => _controller.text.trim();

  bool get _isComplete => _code.length == _codeLength;

  Future<void> _submit(RemoteControlViewModel viewModel) async {
    if (!_isComplete || viewModel.isConnecting) return;
    FocusScope.of(context).unfocus();
    await viewModel.connect(_code);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final viewModel = context.read<RemoteControlViewModel>();
    context.select<RemoteControlViewModel, Object>(
      (vm) => (vm.status, vm.error),
    );
    final errorText = viewModel.status == RemoteConnectionStatus.error
        ? _errorMessage(viewModel.error)
        : null;
    _focusAfterError(showingError: errorText != null);

    // No hero icon and no intro paragraph competing with the steps — this
    // region gets ~347pt on a 375x667 phone and the procedure is the screen.
    final List<Widget> instructions = [
      Text(
        'Connect to your desktop',
        style: theme.textTheme.headlineSmall?.copyWith(
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 4),
      Text(
        'Your 6-digit code comes from the desktop app:',
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 12),
      const _PairingSteps(
        steps: [
          'Open ${Brand.productDisplayName} on your computer',
          'Click Remote Control in the account menu',
          'Click Enable Remote Control — your 6-digit code appears',
        ],
      ),
    ];

    final List<Widget> action = [
      _CodeEntry(
        controller: _controller,
        focusNode: _focusNode,
        length: _codeLength,
        code: _code,
        enabled: !viewModel.isConnecting,
        errorText: errorText,
        onChanged: () => setState(() {}),
        onSubmitted: () => unawaited(_submit(viewModel)),
      ),
      if (errorText != null) ...[
        const SizedBox(height: 4),
        // `liveRegion` so a rejection is spoken when it appears. Material gave
        // this for free while the message lived in `InputDecoration.errorText`;
        // a plain sibling `Text` announces nothing, and `_focusAfterError`
        // refocuses the field immediately, so a screen-reader user would hear
        // "text field, 000000" and no hint that anything was wrong.
        Semantics(
          liveRegion: true,
          container: true,
          child: Text(
            errorText,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.error,
            ),
          ),
        ),
      ],
      const SizedBox(height: 10),
      // No fixed height: a 46pt box clamps the label below its own line height
      // from about text scale 2.5, and FilledButton's Material does not clip,
      // so "Connect" paints outside the pill. `minimumSize` holds the same
      // resting height while letting the button grow.
      FilledButton(
        onPressed: _isComplete && !viewModel.isConnecting
            ? () => unawaited(_submit(viewModel))
            : null,
        style: FilledButton.styleFrom(
          // 48 is Material's minimum tap target and what the button settles
          // at; the padding stays constant while the label scales, so the
          // button grows with it rather than clipping.
          minimumSize: const Size.fromHeight(48),
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 24),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Brand.radius),
          ),
          textStyle: theme.textTheme.titleSmall?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        child: const Text('Connect'),
      ),
    ];

    // One scroll view holding one centred group. The box fills the viewport so
    // the group can centre inside it, and the group keeps a fixed gap between
    // the procedure and the code slot.
    //
    // `spaceBetween` was the obvious arrangement and it was wrong: it hands
    // every spare point to that one gap, so on a 390x844 phone the steps sat
    // at the top edge and the code field a third of a screen below them, with
    // nothing in between. Centring spends the slack symmetrically instead, and
    // the composition holds from a 667pt phone to a 1024pt tablet window.
    //
    // Earlier revisions pinned the action outside a separate scrolling
    // instruction region. That needed a threshold to decide when pinning was
    // affordable, and every estimate of it was wrong somewhere: too low and
    // the pinned pair overflowed, too high and Connect dropped hundreds of
    // points below the fold, and in between the instruction region clipped
    // steps mid-line against the pinned block with no scroll affordance. A
    // single scrollable removes the decision instead of tuning it.
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding:
            _formPadding +
            CanopyScaffold.contentPaddingOf(context, includeFade: false),
        // The app targets iPad as well as iPhone and this screen has no
        // tablet treatment, so cap the measure rather than stretching a phone
        // form across a 1024pt window.
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: 480,
              // `hasBoundedHeight` because an unbounded parent would make this
              // `Infinity` and throw. Only reachable if this view is ever
              // hosted somewhere other than a Scaffold body.
              minHeight: constraints.hasBoundedHeight
                  ? math.max(
                      0,
                      constraints.maxHeight -
                          _formPadding.vertical -
                          CanopyScaffold.contentPaddingOf(
                            context,
                            includeFade: false,
                          ).vertical,
                    )
                  : 0,
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ...instructions,
                const SizedBox(height: _procedureToActionGap),
                ...action,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The numbered procedure, grouped onto one surface.
///
/// The panel is doing the work: three rows floating on the page background
/// read as unrelated lines, while one `surfaceContainerHighest` block reads as
/// a single procedure, and the screen becomes "follow this over there, then
/// enter the result here" instead of one undifferentiated column.
///
/// A connecting rail through the markers was tried and removed. The vertical
/// budget on a 375x667 phone leaves a single-line step barely taller than its
/// own marker, so the rail rendered at roughly zero height beside short steps
/// and only appeared beside wrapped ones — an ornament that comes and goes is
/// worse than none.
class _PairingSteps extends StatelessWidget {
  const _PairingSteps({required this.steps});

  final List<String> steps;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(Brand.radius),
        // The fill alone measures about 1.05:1 against the page in light mode,
        // so the panel barely reads as a surface without an edge.
        // `surfaceContainerHighest` + radius 12 + `Border.all(outlineVariant)`
        // is this app's existing panel: `activity_sidebar.dart` builds it
        // byte-for-byte, `remote_chat_screen.dart` repeats it at a pill
        // radius, and `tool_call_row.dart` reuses the same border token.
        // `outlineVariant` is opaque — `AppTheme` pins `outline` from the
        // brand and leaves `outlineVariant` seed-generated — and even so this
        // edge only reaches about 1.55:1 light and 1.86:1 dark, short of the
        // 3:1 a boundary wants. Matching the app beats inventing a value on
        // one screen.
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (int i = 0; i < steps.length; i++)
            _PairingStep(
              number: i + 1,
              text: steps[i],
              isLast: i == steps.length - 1,
            ),
        ],
      ),
    );
  }
}

/// One numbered instruction. `isLast` only drops the trailing gap — an
/// earlier revision ran a rail between the markers, which is documented on
/// [_PairingSteps] as tried and removed.
///
/// The steps name the desktop app's real sidebar entry and enable button
/// because the previous copy only promised that a code existed somewhere,
/// which left users hunting for it (CAN-2579). Text is [Expanded] so a long
/// product name wraps instead of overflowing at phone width.
class _PairingStep extends StatelessWidget {
  const _PairingStep({
    required this.number,
    required this.text,
    required this.isLast,
  });

  final int number;
  final String text;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // The marker is a filled circle rather than a tint: `onPrimary` on
    // `primary` is the contrast pair the brand guarantees, whereas a digit
    // drawn in `primary` over a low-alpha `primary` wash lands near 4:1 and
    // misses AA for 12sp text.
    //
    // The diameter is twice the digit's own scaled font size rather than a
    // scaled constant. iOS scales large sizes by a smaller factor than small
    // ones, so scaling a bare 24 would grow the circle more slowly than the
    // 12sp digit inside it and eventually clip — silently, since
    // `Alignment.center` never reports overflow.
    final TextStyle? digitStyle = theme.textTheme.labelMedium;
    final double diameter =
        MediaQuery.textScalerOf(context).scale(digitStyle?.fontSize ?? 12) * 2;

    // One announcement per step, with the ordinal spoken as a word. Left as
    // sibling Text nodes a screen reader stops on the bare digit "1" and then
    // the instruction, so the ordering cue reads as noise.
    return Semantics(
      label: 'Step $number: $text',
      excludeSemantics: true,
      child: Padding(
        padding: EdgeInsets.only(bottom: isLast ? 0 : 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: diameter,
              height: diameter,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: theme.colorScheme.primary,
                shape: BoxShape.circle,
              ),
              child: Text(
                '$number',
                style: digitStyle?.copyWith(
                  color: theme.colorScheme.onPrimary,
                  fontWeight: AppTypography.emphasisWeight,
                  fontVariations: AppTypography.emphasisVariations,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                text,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurface,
                  height: 1.35,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The slot the procedure ends in: one cell per digit, over a real but
/// invisible [TextField].
///
/// A single outlined box with six dots in it gave no feedback about how many
/// digits were left, and used an `OutlineInputBorder` that appears nowhere
/// else in this app. Cells make the length legible before the first keystroke
/// and put the caret where the eye already is.
///
/// The field underneath stays a genuine [TextField] — one per screen — so the
/// keyboard, digit formatters, paste, and autofill all behave normally. The
/// cells sit above it inside [IgnorePointer] so taps fall through to it.
class _CodeEntry extends StatelessWidget {
  const _CodeEntry({
    required this.controller,
    required this.focusNode,
    required this.length,
    required this.code,
    required this.enabled,
    required this.errorText,
    required this.onChanged,
    required this.onSubmitted,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final int length;
  final String code;
  final bool enabled;
  final String? errorText;
  final VoidCallback onChanged;
  final VoidCallback onSubmitted;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final double height = math.max(
      48,
      MediaQuery.textScalerOf(context).scale(26) * 1.85,
    );

    return SizedBox(
      height: height,
      // `expand`, not the default `loose`. The hidden field sizes itself to
      // InputDecorator's 48pt minimum, which `fontSize: 1` and zero content
      // padding cannot shrink and nothing else grows; the visible strip grows
      // with the text scaler. Left loose, the field pins to the top and
      // everything below 48pt stops hit-testing — 26% of the control dead at
      // text scale 1.35, 67% at 3.0, on the screen's only input.
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Invisible, but still the real input: it owns the caret, the
          // keyboard, and the controller.
          //
          // The rejection rides on the field's own semantics as a hint, which
          // is what `InputDecoration.errorText` used to attach for free. It
          // cannot go back through the decoration: that renders a second
          // `Text` of the message even at zero font size, and the visible one
          // lives outside this fixed-height box.
          Semantics(
            // The name lives here rather than on `hintText`, which only
            // announces while the field is empty — so it disappeared exactly
            // when a user was correcting a rejected code. This merges into the
            // field's own node; the tree still holds one text field.
            label: '6-digit code',
            hint: errorText,
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              // Never focused on first view: the code only exists on the
              // desktop, so nobody can type here yet, and raising the keyboard
              // would cover the very steps that explain where to go
              // (CAN-2579). A rejected code hands focus back.
              enabled: enabled,
              // The only way back out of that keyboard. An iOS number pad has
              // no return key, and `_submit` unfocuses only once all six
              // digits are entered — so a half-entered code, or a rejected one
              // that [_focusAfterError] just re-focused, left the user stuck
              // behind it.
              onTapOutside: (_) => FocusScope.of(context).unfocus(),
              keyboardType: TextInputType.number,
              maxLength: length,
              showCursor: false,
              // Hides the drag handles while keeping the selection menu, so a
              // long-press still offers Paste — which matters here more than
              // anywhere, since the code is usually on the clipboard from the
              // desktop. Both `enableInteractiveSelection: false` and
              // `EmptyTextSelectionControls` kill the menu outright: measured,
              // each gives zero toolbars on iOS and Android, because neither
              // mixes in `TextSelectionHandleControls` and `showToolbar` then
              // takes the legacy `buildToolbar` path.
              selectionControls: _hiddenSelectionHandles,
              autofillHints: const [AutofillHints.oneTimeCode],
              style: const TextStyle(color: Colors.transparent, fontSize: 1),
              cursorColor: Colors.transparent,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(
                counterText: '',
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                // Keeps the decorator's content box the height of the strip.
                // `StackFit.expand` above is what actually restores hit testing:
                // the field used to sit at InputDecorator's ~48pt minimum while
                // the strip grew with the text scaler, leaving everything below
                // 48pt inert. This padding only keeps the decorator's own layout
                // agreeing with the box it is handed.
                contentPadding: EdgeInsets.symmetric(
                  vertical: math.max(0, (height - 20) / 2),
                ),
              ),
              onChanged: (_) => onChanged(),
              onSubmitted: (_) => onSubmitted(),
            ),
          ),
          // `IgnorePointer` stopped suppressing semantics in Flutter 3.8, so
          // without this the per-cell digits leak in as unlabelled text.
          ExcludeSemantics(
            child: IgnorePointer(
              child: Row(
                children: [
                  for (int i = 0; i < length; i++) ...[
                    if (i > 0) const SizedBox(width: 8),
                    Expanded(
                      child: _CodeCell(
                        digit: i < code.length ? code[i] : null,
                        // The caret cell only reads as active while the
                        // field actually holds focus, so a filled-but-
                        // blurred code does not keep advertising an
                        // insertion point.
                        isActive: focusNode.hasFocus && i == code.length,
                        hasError: errorText != null,
                        theme: theme,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One digit slot. Empty, filled, active, and error are four distinct reads.
class _CodeCell extends StatelessWidget {
  const _CodeCell({
    required this.digit,
    required this.isActive,
    required this.hasError,
    required this.theme,
  });

  final String? digit;
  final bool isActive;
  final bool hasError;
  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    // A resting border, not a transparent one: the cell edge and the dot are
    // the whole "a code goes here" affordance now that the outlined box and
    // its `••••••` hint are gone. Against the cell fill the opaque
    // `outlineVariant` measures about 1.47:1 light and 1.49:1 dark — short of
    // 3:1, but it is the app's divider token. The active and error states use
    // opaque colors and clear 3:1 in light mode (4.21:1 and 4.63:1); against
    // the dark fill they land at 2.87:1 and 2.62:1.
    final Color border = hasError
        ? theme.colorScheme.error
        : isActive
        ? theme.colorScheme.primary
        : theme.colorScheme.outlineVariant;

    return AnimatedContainer(
      // Short enough to feel like part of the keypress rather than an
      // animation the user waits on.
      duration: const Duration(milliseconds: 120),
      curve: Curves.easeOut,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(_innerRadius),
        border: Border.all(
          color: border,
          width: hasError || isActive ? 1.5 : 1,
        ),
      ),
      child: switch (digit) {
        // A resting placeholder, not an empty box. Six identical blank
        // rectangles say nothing about what belongs in them; the dots carry
        // over the affordance the old single field's `••••••` hint had, at an
        // alpha that stays quiet next to a real digit.
        null => Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            // 0.68, not less: composited over the cell fill this measures
            // 3.15:1 light and 4.07:1 dark, where 0.6 gave 2.69:1 light and
            // missed the 3:1 a graphical affordance needs. The contrast test
            // pins the ratio rather than the number.
            color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.68),
          ),
        ),
        final String value => FittedBox(
          // The cell is `Expanded` at a sixth of a fixed row, so it cannot
          // grow with the text scaler the way the button below can. Scaling
          // down is the difference between a small digit and a clipped one.
          fit: BoxFit.scaleDown,
          child: Text(
            value,
            style: theme.textTheme.titleLarge?.copyWith(
              color: theme.colorScheme.onSurface,
              fontWeight: AppTypography.emphasisWeight,
              fontVariations: AppTypography.emphasisVariations,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ),
      },
    );
  }
}

/// Selection behaviour for the hidden code field: no drag handles, but the
/// normal selection menu.
///
/// Mixing in [TextSelectionHandleControls] is the load-bearing part —
/// `TextSelectionOverlay.showToolbar` falls back to the legacy
/// `buildToolbar` path for anything that does not, which is why
/// [EmptyTextSelectionControls] suppresses Paste entirely.
class _HiddenSelectionHandles extends TextSelectionControls
    with TextSelectionHandleControls {
  @override
  Size getHandleSize(double textLineHeight) => Size.zero;

  @override
  Widget buildHandle(
    BuildContext context,
    TextSelectionHandleType type,
    double textLineHeight, [
    VoidCallback? onTap,
  ]) => const SizedBox.shrink();

  @override
  Offset getHandleAnchor(TextSelectionHandleType type, double textLineHeight) =>
      Offset.zero;
}

/// One instance, not one per build: [EditableText] compares `selectionControls`
/// by identity and tears down and rebuilds the whole selection overlay when it
/// differs, which a fresh instance would trigger on every keystroke.
final TextSelectionControls _hiddenSelectionHandles = _HiddenSelectionHandles();

/// Extracts a user-presentable message from a connect failure. Repository
/// errors already carry inline-friendly copy; anything else gets a generic
/// fallback rather than a raw `toString()`.
String _errorMessage(Object? error) {
  if (error is RemoteNoDesktopForCodeException) {
    const message =
        'Open ${Brand.productDisplayName} on your computer, turn on Remote '
        'Control, then enter the new code.';
    // The server cannot tell an offline desktop from one on the other
    // server, so staging builds add a hint. Production never mentions
    // environments.
    return AppConfig.isStaging
        ? '$message\nThis phone uses the staging server. Use staging in the '
              'desktop app too.'
        : message;
  }
  if (error is RemoteControlException) return error.message;
  if (error == null) return 'Could not connect. Please try again.';
  return 'Could not connect. Please try again.';
}
