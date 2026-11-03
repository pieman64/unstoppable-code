import 'dart:io';

import 'package:package_info_plus/package_info_plus.dart';

/// Platform and build context attached to feedback submissions.
///
/// Carries nothing user-authored: no conversation content, no workspace
/// content, no tokens. Just what an engineer needs to reproduce a report.
final class AppBuildInfo {
  const AppBuildInfo({
    required this.version,
    required this.buildNumber,
    required this.platform,
    required this.osVersion,
  });

  final String version;
  final String buildNumber;
  final String platform;
  final String osVersion;

  /// The form the turn-feedback `appVersion` column expects.
  String get appVersion => '$version+$buildNumber';

  static Future<AppBuildInfo> load() async {
    final info = await PackageInfo.fromPlatform();
    return AppBuildInfo(
      version: info.version,
      buildNumber: info.buildNumber,
      platform: Platform.operatingSystem,
      osVersion: Platform.operatingSystemVersion,
    );
  }

  Map<String, dynamic> toContext() => <String, dynamic>{
    'platform': platform,
    'osVersion': osVersion,
    'appVersion': appVersion,
  };
}
