import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';

/// Human label for a feed item type, used in the filter sheet.
String feedItemTypeLabel(FeedItemType type) => switch (type) {
  FeedItemType.agentSession => 'Agent sessions',
  FeedItemType.prMerged => 'PRs merged',
  FeedItemType.prOpened => 'PRs opened',
  FeedItemType.pipelineRun => 'Pipeline runs',
  FeedItemType.planApproved => 'Plans approved',
  FeedItemType.planShared => 'Plans shared',
  FeedItemType.planUpdated => 'Plans updated',
  FeedItemType.worktreeStarted => 'Worktrees started',
  FeedItemType.worktreeUpdated => 'Worktrees updated',
  FeedItemType.runFailed => 'Failed runs',
  FeedItemType.runShared => 'Shared runs',
};

/// Opens the activity-feed filter sheet, applying the chosen type/search/actor
/// filters to [viewModel] on "Apply".
///
/// [membersViewModel] supplies the org member list used to populate the actor
/// picker. It is captured here (under the provider scope) and passed into the
/// sheet, since the modal builder runs above the provider subtree. Null means
/// the context has no members (Personal), so the sheet offers no member filter.
void showFeedFilterSheet(
  BuildContext context,
  FeedViewModel viewModel,
  MembersViewModel? membersViewModel,
) {
  unawaited(
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _FeedFilterSheet(
        viewModel: viewModel,
        membersViewModel: membersViewModel,
      ),
    ),
  );
}

/// Short label for a member in the actor picker: their name, falling back to
/// their email when the name is blank.
String memberActorLabel(OrganizationMember member) {
  final name = member.name.trim();
  return name.isEmpty ? member.email : name;
}

class _FeedFilterSheet extends StatefulWidget {
  const _FeedFilterSheet({
    required this.viewModel,
    required this.membersViewModel,
  });

  final FeedViewModel viewModel;
  final MembersViewModel? membersViewModel;

  @override
  State<_FeedFilterSheet> createState() => _FeedFilterSheetState();
}

class _FeedFilterSheetState extends State<_FeedFilterSheet> {
  late final Set<FeedItemType> _types = {...widget.viewModel.activeTypes};
  late final TextEditingController _search = TextEditingController(
    text: widget.viewModel.query,
  );
  late String? _actorId = widget.viewModel.actorId;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<OrganizationMember> get _members =>
      widget.membersViewModel?.organization?.members ?? const [];

  /// The label for the currently-selected actor, resolved from the member list
  /// when possible so it survives a page reload; falls back to the view model's
  /// last known label.
  String? get _selectedActorLabel {
    final id = _actorId;
    if (id == null) return null;
    for (final member in _members) {
      if (member.id == id) return memberActorLabel(member);
    }
    return widget.viewModel.actorLabel;
  }

  void _apply() {
    unawaited(
      widget.viewModel.setFilters(
        types: _types,
        query: _search.text,
        actorId: _actorId,
        actorLabel: _selectedActorLabel,
      ),
    );
    Navigator.of(context).pop();
  }

  void _clear() {
    unawaited(widget.viewModel.clearFilters());
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        // Keep the search field clear of the on-screen keyboard.
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(context).viewInsets.bottom,
        ),
        // A pinned action row below a scrollable filter region: the member list
        // can be long, so the filters scroll while Clear/Apply stay reachable.
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: ListenableBuilder(
                listenable: Listenable.merge([?widget.membersViewModel]),
                builder: (context, _) {
                  final members = _members;
                  return ListView(
                    shrinkWrap: true,
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    children: [
                      Text(
                        'Filter activity',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: AppTypography.emphasisWeight,
                          fontVariations: AppTypography.emphasisVariations,
                        ),
                      ),
                      const SizedBox(height: 12),
                      // Clearing the field only edits the draft; filters
                      // still change on Apply or the keyboard search key.
                      CanopySearchField(
                        controller: _search,
                        hintText: 'Search',
                        onSubmitted: (_) => _apply(),
                      ),
                      const SizedBox(height: 16),
                      if (members.isNotEmpty) ...[
                        Text('Member', style: theme.textTheme.labelLarge),
                        const SizedBox(height: 4),
                        RadioGroup<String?>(
                          groupValue: _actorId,
                          onChanged: (value) =>
                              setState(() => _actorId = value),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              // "All members" (null) clears the actor filter.
                              const RadioListTile<String?>(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                title: Text('All members'),
                                value: null,
                              ),
                              for (final member in members)
                                RadioListTile<String?>(
                                  dense: true,
                                  contentPadding: EdgeInsets.zero,
                                  title: Text(memberActorLabel(member)),
                                  subtitle:
                                      member.name.trim().isEmpty ||
                                          member.name.trim() == member.email
                                      ? null
                                      : Text(member.email),
                                  value: member.id,
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],
                      Text('Types', style: theme.textTheme.labelLarge),
                      const SizedBox(height: 4),
                      for (final type in FeedItemType.values)
                        CheckboxListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(feedItemTypeLabel(type)),
                          value: _types.contains(type),
                          onChanged: (checked) => setState(() {
                            if (checked ?? false) {
                              _types.add(type);
                            } else {
                              _types.remove(type);
                            }
                          }),
                        ),
                    ],
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Row(
                children: [
                  Expanded(
                    child: TextButton(
                      onPressed: _clear,
                      child: const Text('Clear'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      onPressed: _apply,
                      child: const Text('Apply'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
