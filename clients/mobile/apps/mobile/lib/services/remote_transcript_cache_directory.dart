/// Where Remote Control persists recent chat tails (CAN-3373), and the data
/// protection applied to it.
///
/// Transcripts can contain code and secrets. They are not encrypted by the
/// app; they rely on the platform: app-private application support storage
/// on Android, and Complete data protection on iOS, under which the files
/// are unreadable while the device is locked.
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

const String kRemoteTranscriptProtectionChannel =
    'com.unstoppabledomains.canopy/file_protection';

/// The cache directory inside application support, created if needed. On
/// iOS the native side creates it with Complete protection, which every file
/// written into it inherits, and verifies the protection; anything less
/// throws, so nothing is written without it.
Future<Directory> remoteTranscriptCacheDirectory({
  Future<Directory> Function() applicationSupport =
      getApplicationSupportDirectory,
  MethodChannel channel = const MethodChannel(
    kRemoteTranscriptProtectionChannel,
  ),
}) async {
  final root = await applicationSupport();
  final directory = Directory(p.join(root.path, 'remote-transcripts'));
  if (defaultTargetPlatform == TargetPlatform.iOS) {
    final protected = await channel.invokeMethod<bool>('protectDirectory', {
      'path': directory.path,
    });
    if (protected != true) {
      throw const FileSystemException('Data protection was not applied');
    }
    return directory;
  }
  return directory.create(recursive: true);
}
