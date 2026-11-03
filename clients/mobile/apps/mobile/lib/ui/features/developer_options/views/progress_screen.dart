import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/progress/canopy_progress_checklist.dart';
import 'package:mobile/data/models/remote_progress_phases.dart';

/// Reference states for [CanopyProgressChecklist], mirroring the desktop
/// Pull Requests card's in-progress, completed, and failed checklists.
class ProgressScreen extends StatelessWidget {
  const ProgressScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Progress checklist'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(16),
          children: const [
            Text('In progress'),
            SizedBox(height: 8),
            CanopyProgressChecklist(
              badge: CanopyProgressBadge(
                label: 'Creating',
                tone: CanopyProgressBadgeTone.progress,
              ),
              steps: [
                CanopyProgressChecklistStep(
                  label: 'Gathering changes',
                  status: RemoteProgressStepStatus.completed,
                ),
                CanopyProgressChecklistStep(
                  label: 'Summarizing changes',
                  status: RemoteProgressStepStatus.active,
                ),
                CanopyProgressChecklistStep(
                  label: 'Pushing to remote',
                  status: RemoteProgressStepStatus.pending,
                ),
                CanopyProgressChecklistStep(
                  label: 'Creating pull request',
                  status: RemoteProgressStepStatus.pending,
                ),
              ],
            ),
            SizedBox(height: 24),
            Text('Completed'),
            SizedBox(height: 8),
            CanopyProgressChecklist(
              badge: CanopyProgressBadge(
                label: 'Created',
                tone: CanopyProgressBadgeTone.success,
              ),
              steps: [
                CanopyProgressChecklistStep(
                  label: 'Gathering changes',
                  status: RemoteProgressStepStatus.completed,
                ),
                CanopyProgressChecklistStep(
                  label: 'Summarizing changes',
                  status: RemoteProgressStepStatus.completed,
                ),
                CanopyProgressChecklistStep(
                  label: 'Pushing to remote',
                  status: RemoteProgressStepStatus.completed,
                ),
                CanopyProgressChecklistStep(
                  label: 'Creating pull request',
                  status: RemoteProgressStepStatus.completed,
                ),
              ],
            ),
            SizedBox(height: 24),
            Text('Failed'),
            SizedBox(height: 8),
            CanopyProgressChecklist(
              badge: CanopyProgressBadge(
                label: 'Failed',
                tone: CanopyProgressBadgeTone.error,
              ),
              error: 'no upstream branch',
              steps: [
                CanopyProgressChecklistStep(
                  label: 'Gathering changes',
                  status: RemoteProgressStepStatus.completed,
                ),
                CanopyProgressChecklistStep(
                  label: 'Summarizing changes',
                  status: RemoteProgressStepStatus.error,
                ),
                CanopyProgressChecklistStep(
                  label: 'Pushing to remote',
                  status: RemoteProgressStepStatus.pending,
                ),
                CanopyProgressChecklistStep(
                  label: 'Creating pull request',
                  status: RemoteProgressStepStatus.pending,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
