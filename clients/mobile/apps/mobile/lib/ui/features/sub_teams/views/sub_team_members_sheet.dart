import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/organization.dart';

/// Bottom-sheet membership picker for a sub-team: a checkbox list of every org
/// [members] entry, pre-checked for the current [selectedMemberIds].
///
/// On "Save" it pops the selected member ids (a full set-replacement, matching
/// the backend PUT contract); on "Cancel"/dismiss it pops `null`.
class SubTeamMembersSheet extends StatefulWidget {
  const SubTeamMembersSheet({
    super.key,
    required this.teamName,
    required this.members,
    required this.selectedMemberIds,
  });

  final String teamName;
  final List<OrganizationMember> members;
  final List<String> selectedMemberIds;

  @override
  State<SubTeamMembersSheet> createState() => _SubTeamMembersSheetState();
}

class _SubTeamMembersSheetState extends State<SubTeamMembersSheet> {
  late final Set<String> _selected = {...widget.selectedMemberIds};

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 8,
          bottom: 16 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Members of ${widget.teamName}',
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Select which organization members belong to this sub-team.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final member in widget.members)
                    CheckboxListTile(
                      value: _selected.contains(member.id),
                      onChanged: (checked) => setState(() {
                        if (checked ?? false) {
                          _selected.add(member.id);
                        } else {
                          _selected.remove(member.id);
                        }
                      }),
                      secondary: CircleAvatar(
                        child: Text(
                          _initials(member.name),
                          style: theme.textTheme.labelMedium,
                        ),
                      ),
                      title: Text(
                        member.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        member.email,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: () => Navigator.of(
                      context,
                    ).pop(_selected.toList(growable: false)),
                    child: const Text('Save'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

String _initials(String name) {
  final parts = name
      .trim()
      .split(RegExp(r'\s+'))
      .where((p) => p.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
  return (parts.first.substring(0, 1) + parts.last.substring(0, 1))
      .toUpperCase();
}
