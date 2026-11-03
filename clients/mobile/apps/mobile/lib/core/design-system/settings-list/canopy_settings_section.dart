import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/typography.dart';

/// A group of settings rows without dividers, with an optional bold heading
/// inset 2px beyond the rows' leading edge above a raised, rounded card.
/// The card clips row ink to its corners.
class CanopySettingsSection extends StatelessWidget {
  const CanopySettingsSection({
    super.key,
    required this.children,
    this.heading,
  });

  final String? heading;

  /// Usually [CanopySettingsRow]s.
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final heading = this.heading;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (heading != null)
          Padding(
            padding: const EdgeInsets.only(
              left: AppDimens.navRowLeadingInset + 2,
              right: AppDimens.navRowLeadingInset,
              bottom: AppDimens.padding8,
            ),
            child: Semantics(
              header: true,
              child: Text(
                heading,
                style: AppTypography.settingsHeading.copyWith(
                  color: colors.foregroundSecondary,
                ),
              ),
            ),
          ),
        Material(
          color: colors.surfaceRaised,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.xxl),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: children,
          ),
        ),
      ],
    );
  }
}
