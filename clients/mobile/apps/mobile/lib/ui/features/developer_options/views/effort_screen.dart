import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// Reference for the composer's Effort trigger and panel with synthetic
/// levels. The chat feature owns the real levels; Developer Options does not
/// import it.
class EffortScreen extends StatelessWidget {
  const EffortScreen({super.key});

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: const Text('Effort'),
    ),
    body: Builder(
      builder: (context) => ListView(
        padding:
            CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(16),
        children: const [
          _Example(
            id: 'none-to-ultra',
            title: 'None to Ultra, no Fast mode',
            levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            level: 'low',
          ),
          _Example(
            id: 'fast',
            title: 'Low to Ultra with Fast mode',
            levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            level: 'xhigh',
            speed: CanopyEffortSpeed.regular,
          ),
          _Example(
            id: 'ultra-fast',
            title: 'Ultra fast, read-only',
            levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            level: 'high',
            speed: CanopyEffortSpeed.ultraFast,
          ),
          _Example(
            id: 'single',
            title: 'One level',
            levels: ['high'],
            level: 'high',
          ),
        ],
      ),
    ),
  );
}

/// One interactive trigger and panel pair.
class _Example extends StatefulWidget {
  const _Example({
    required this.id,
    required this.title,
    required this.levels,
    required this.level,
    this.speed,
  });

  final String id;
  final String title;
  final List<String> levels;
  final String level;
  final CanopyEffortSpeed? speed;

  @override
  State<_Example> createState() => _ExampleState();
}

class _ExampleState extends State<_Example> {
  late String _level = widget.level;
  late CanopyEffortSpeed? _speed = widget.speed;

  /// The panel over this example's state; [onChanged] also rebuilds the
  /// sheet that shows it.
  Widget _panel({VoidCallback? onChanged}) {
    final speed = _speed;
    void update(VoidCallback change) {
      setState(change);
      onChanged?.call();
    }

    return CanopyEffortPanel(
      level: _level,
      levels: widget.levels,
      onSelect: (level) async {
        update(() => _level = level);
        return true;
      },
      speed: speed,
      onToggleFast: speed == null || speed == CanopyEffortSpeed.ultraFast
          ? null
          : () => update(
              () => _speed = speed == CanopyEffortSpeed.fast
                  ? CanopyEffortSpeed.regular
                  : CanopyEffortSpeed.fast,
            ),
    );
  }

  void _openSheet() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => StatefulBuilder(
      builder: (context, setSheet) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 8, 16),
          child: _panel(onChanged: () => setSheet(() {})),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Padding(
      key: ValueKey('effort-example-${widget.id}'),
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 8,
        children: [
          Text(
            widget.title,
            style: AppTypography.sectionLabel.copyWith(
              color: colors.foreground,
            ),
          ),
          CanopyEffortTrigger(
            key: ValueKey('effort-trigger-${widget.id}'),
            level: _level,
            speed: _speed ?? CanopyEffortSpeed.regular,
            onTap: _openSheet,
          ),
          DecoratedBox(
            decoration: BoxDecoration(
              border: Border.all(color: colors.border),
              borderRadius: BorderRadius.circular(AppRadii.lg),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
              child: _panel(),
            ),
          ),
        ],
      ),
    );
  }
}
