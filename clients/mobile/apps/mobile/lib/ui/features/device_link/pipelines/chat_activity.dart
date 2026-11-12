import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/pipelines/chat_activity.dart';
import 'package:mobile/device_link/pipelines/repository.dart';
import 'package:mobile/ui/core/pipelines/pipeline_run_agent_activity.dart';
import 'run_screen.dart';
import 'chat_activity_controller.dart';

/// Binds the shared turn panels to one computer's execution repository.
class DevicePipelineChatActivity extends StatefulWidget {
  const DevicePipelineChatActivity({
    super.key,
    required this.repository,
    required this.ref,
    required this.messages,
    required this.online,
    required this.builder,
  });
  final DevicePipelineRepository repository;
  final DeviceChatRef? ref;
  final List<DeviceChatMessage> messages;
  final bool online;
  final Widget Function(Map<String, Widget>) builder;

  @override
  State<DevicePipelineChatActivity> createState() =>
      _DevicePipelineChatActivityState();
}

class _DevicePipelineChatActivityState
    extends State<DevicePipelineChatActivity> {
  late DevicePipelineChatActivityController _controller;
  final _expanded = <(String, String), bool>{};

  @override
  void initState() {
    super.initState();
    _controller = DevicePipelineChatActivityController(widget.repository);
    _sync();
  }

  @override
  void didUpdateWidget(DevicePipelineChatActivity old) {
    super.didUpdateWidget(old);
    if (old.repository != widget.repository) {
      _controller.dispose();
      _controller = DevicePipelineChatActivityController(widget.repository);
      _expanded.clear();
    }
    _sync();
  }

  void _sync() => _controller.update(
    ref: widget.ref,
    messages: widget.messages,
    online: widget.online,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<void>(
    stream: widget.repository.updates,
    builder: (context, _) {
      final ref = widget.ref, repository = widget.repository;
      if (ref == null) return widget.builder(const {});
      final activity = devicePipelineChatActivity(
        ref: ref,
        messages: widget.messages,
        runs: repository.runs(ref),
      );
      final latest = widget.messages
          .where((m) => activity.containsKey(m.id))
          .lastOrNull
          ?.id;
      return widget.builder({
        for (final entry in activity.entries)
          entry.key: PipelineRunAgentActivityPanel(
            key: ValueKey('agent-activity:${entry.key}'),
            turnKey: entry.key,
            runs: entry.value,
            expanded: _expanded[(ref.key, entry.key)] ?? entry.key == latest,
            onToggle: () => setState(() {
              final key = (ref.key, entry.key);
              _expanded[key] = !(_expanded[key] ?? entry.key == latest);
            }),
            pendingAction: (id) => repository.pendingAction(ref, id),
            actionError: (id) => repository.actionError(ref, id),
            onCancel: widget.online
                ? (id) => unawaited(
                    repository.control(ref, id, RemotePipelineRunAction.cancel),
                  )
                : null,
            onOpenRun: (run) => unawaited(
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => DevicePipelineRunScreen(
                    repository: repository,
                    ref: ref,
                    id: run.localId,
                    name: run.pipelineName,
                  ),
                ),
              ),
            ),
          ),
      });
    },
  );
}
