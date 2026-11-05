import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/widgets/chat_list_notice.dart';

class ChatSearchItem {
  const ChatSearchItem({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.worktree,
    required this.onOpen,
  });
  final String id, title, subtitle;
  final bool worktree;
  final VoidCallback onOpen;
}

/// The shared Remote Control and Computer connect title-search screen.
class ChatSearchView extends StatefulWidget {
  const ChatSearchView({
    super.key,
    required this.items,
    required this.contextLabel,
    this.loading = false,
    this.error,
    this.onRetry,
  });
  final List<ChatSearchItem> items;
  final String contextLabel;
  final bool loading;
  final String? error;
  final VoidCallback? onRetry;
  @override
  State<ChatSearchView> createState() => _ChatSearchViewState();
}

class _ChatSearchViewState extends State<ChatSearchView> {
  final _query = TextEditingController();
  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final query = _query.text.trim().toLowerCase();
    final results = widget.items
        .where((row) => row.title.toLowerCase().contains(query))
        .toList();
    final notice = widget.error != null
        ? ChatListNotice(message: widget.error!, onRetry: widget.onRetry)
        : widget.loading
        ? const ChatListNotice(message: 'Loading chats from your desktop…')
        : null;
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: TextField(
          key: const ValueKey('chat-search-field'),
          controller: _query,
          autofocus: true,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(
            hintText: 'Search chats',
            border: InputBorder.none,
          ),
          onChanged: (_) => setState(() {}),
        ),
        trailing: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (query.isNotEmpty)
              CanopyIconButton(
                glyph: CanopyGlyph.crossMedium,
                tooltip: 'Clear',
                onPressed: () => setState(_query.clear),
              ),
          ],
        ),
      ),
      body: Builder(
        builder: (context) {
          final insets = CanopyScaffold.contentPaddingOf(context);
          final Widget body;
          if (results.isEmpty && (widget.error != null || widget.loading)) {
            body = const SizedBox.shrink();
          } else if (query.isEmpty || results.isEmpty) {
            body = Center(
              child: Padding(
                padding: insets + const EdgeInsets.all(24),
                child: Text(
                  query.isEmpty
                      ? 'Search every chat by title.'
                      : 'No chats match your search in ${widget.contextLabel}.',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            );
          } else {
            body = ListView.builder(
              padding: insets.copyWith(top: notice == null ? insets.top : 0),
              itemCount: results.length,
              itemBuilder: (context, index) {
                final result = results[index];
                return ListTile(
                  key: ValueKey('chat-search-result-${result.id}'),
                  leading: Icon(
                    result.worktree
                        ? Icons.account_tree_outlined
                        : Icons.chat_bubble_outline,
                  ),
                  title: Text(
                    result.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    result.subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onTap: result.onOpen,
                );
              },
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (notice != null)
                Padding(
                  padding: EdgeInsets.only(top: insets.top),
                  child: notice,
                ),
              Expanded(child: body),
            ],
          );
        },
      ),
    );
  }
}
