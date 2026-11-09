import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/device_link/files/reader.dart';
import 'package:mobile/device_link/files/rooted_path.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_screen.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_view_model.dart';
import '../chats_view_model.dart';
import 'file_viewer_source.dart';

/// [FileViewerScreen] for a file the computer has open in a worktree, read
/// over the computer connection. Reads are stateless, so a reconnect resumes
/// them; while offline the viewer shows its offline notice.
class DeviceFileScreen extends StatefulWidget {
  const DeviceFileScreen({
    super.key,
    required this.model,
    required this.reader,
    required this.location,
  });

  final DeviceChatsViewModel model;
  final DeviceFileReader reader;
  final DeviceRootedPath location;

  @override
  State<DeviceFileScreen> createState() => _DeviceFileScreenState();
}

class _DeviceFileScreenState extends State<DeviceFileScreen> {
  late final FileViewerViewModel _file = FileViewerViewModel(
    source: DeviceFileViewerSource(
      reader: widget.reader,
      location: widget.location,
    ),
    path: widget.location.relativePath,
    online: widget.model.online,
  );

  @override
  void initState() {
    super.initState();
    widget.model.addListener(_onModelChanged);
    unawaited(_file.load());
  }

  @override
  void dispose() {
    widget.model.removeListener(_onModelChanged);
    widget.reader.close();
    _file.dispose();
    super.dispose();
  }

  void _onModelChanged() => _file.setOnline(widget.model.online);

  @override
  Widget build(BuildContext context) => FileViewerScreen(file: _file);
}
