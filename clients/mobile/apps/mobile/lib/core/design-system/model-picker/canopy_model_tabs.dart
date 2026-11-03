import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// One tab in [CanopyModelTabs]. A [muted] tab names something that is not
/// connected; it stays selectable so it can explain how to connect.
class CanopyModelTab {
  const CanopyModelTab({
    required this.key,
    required this.label,
    this.muted = false,
  });

  final Key key;
  final String label;
  final bool muted;
}

/// Horizontally scrolling pill tabs for the model picker's harness rail.
/// Each tab keeps a 44px touch target.
class CanopyModelTabs extends StatelessWidget {
  const CanopyModelTabs({
    super.key,
    required this.tabs,
    required this.selectedIndex,
    required this.onSelected,
  });

  final List<CanopyModelTab> tabs;
  final int selectedIndex;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    // Start-aligned when the tabs fit, scrollable when they do not.
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          spacing: 4,
          children: [
            for (final (index, tab) in tabs.indexed)
              Semantics(
                key: tab.key,
                container: true,
                button: true,
                selected: index == selectedIndex,
                // The ripple stays on the pill; the rest of the 44px target
                // still selects the tab.
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  excludeFromSemantics: true,
                  onTap: () => onSelected(index),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 44),
                    child: Center(
                      widthFactor: 1,
                      child: Material(
                        type: MaterialType.transparency,
                        child: InkWell(
                          onTap: () => onSelected(index),
                          borderRadius: BorderRadius.circular(AppRadii.full),
                          child: Ink(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 6,
                            ),
                            decoration: BoxDecoration(
                              color: index == selectedIndex
                                  ? colors['bg-secondary']
                                  : null,
                              borderRadius: BorderRadius.circular(
                                AppRadii.full,
                              ),
                            ),
                            child: Text(
                              tab.label,
                              style: AppTypography.compactLabel.copyWith(
                                color: tab.muted
                                    ? colors['fg-quaternary']
                                    : index == selectedIndex
                                    ? colors.foreground
                                    : colors.foregroundSecondary,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
