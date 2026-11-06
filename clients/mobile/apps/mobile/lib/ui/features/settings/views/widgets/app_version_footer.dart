import 'package:flutter/material.dart';
import 'package:mobile/services/app_build_info.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';

/// Installed app metadata at the end of Settings.
class AppVersionFooter extends StatefulWidget {
  const AppVersionFooter({super.key});

  @override
  State<AppVersionFooter> createState() => _AppVersionFooterState();
}

class _AppVersionFooterState extends State<AppVersionFooter> {
  final _buildInfo = AppBuildInfo.load();

  @override
  Widget build(BuildContext context) => FutureBuilder<AppBuildInfo>(
    future: _buildInfo,
    builder: (context, snapshot) {
      final info = snapshot.data;
      if (info == null) return const SizedBox.shrink();

      return Padding(
        padding: const EdgeInsets.symmetric(vertical: AppDimens.padding32),
        child: Text(
          'Version ${info.appVersion}',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: AppColors.of(context)['fg-secondary'],
          ),
        ),
      );
    },
  );
}
