import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/chat/widgets/draft_option_sheet.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/composition/new_chat/chat_destination.dart';

/// A project a new chat can start in, on whichever destination owns it.
typedef NewChatProject = ({
  ChatDestination destination,
  String id,
  String name,
  Widget icon,
});

/// What the project sheet returned.
sealed class NewChatProjectChoice {
  const NewChatProjectChoice();
}

final class PickedNewChatProject extends NewChatProjectChoice {
  const PickedNewChatProject(this.project);

  final NewChatProject project;
}

final class AddComputerChoice extends NewChatProjectChoice {
  const AddComputerChoice();
}

const String _addComputerId = 'add-computer';

/// The sheet's key for [project], unique across destinations.
String newChatProjectKey(ChatDestination destination, String projectId) =>
    '${destination.id}/$projectId';

/// Where [destination] is, as a project row's subtitle words it.
String _locationLabel(ChatDestination destination) => switch (destination) {
  CloudChatDestination() => 'Cloud',
  ComputerChatDestination(:final name, :final availability) =>
    switch (availability) {
      ComputerAvailability.online => name,
      ComputerAvailability.offline => '$name · Offline',
      ComputerAvailability.connecting => '$name · Connecting…',
    },
};

/// Asks which project a new chat starts in (CAN-2932). Like web's project
/// selector it is one list, Cloud's projects first and then the computer's,
/// and the project decides where the chat runs. Each row says where, so
/// projects that share a name stay apart. "Add a computer" closes the list
/// when [canAddComputer]. Returns null when dismissed.
Future<NewChatProjectChoice?> showNewChatProjectSheet(
  BuildContext context, {
  required List<NewChatProject> projects,
  required String? selectedKey,
  required bool canAddComputer,
}) async {
  final colors = AppColors.of(context);
  final byKey = {
    for (final project in projects)
      newChatProjectKey(project.destination, project.id): project,
  };
  final id = await showDraftOptionSheet(
    context,
    title: 'Choose a project',
    keyPrefix: 'new-chat-project',
    selectedId: selectedKey,
    options: [
      for (final MapEntry(:key, value: project) in byKey.entries)
        (
          id: key,
          name: project.name,
          icon: project.icon,
          subtitle: _locationLabel(project.destination),
        ),
      if (canAddComputer)
        (
          id: _addComputerId,
          name: 'Add a computer',
          icon: CanopyIcon(
            glyph: CanopyGlyph.plusMedium,
            size: 14,
            tint: colors.foregroundSecondary,
          ),
          subtitle: null,
        ),
    ],
  );
  if (id == null) return null;
  if (id == _addComputerId) return const AddComputerChoice();
  final project = byKey[id];
  return project == null ? null : PickedNewChatProject(project);
}
