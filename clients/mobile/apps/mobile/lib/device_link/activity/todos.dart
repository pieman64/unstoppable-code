import 'dart:convert';
import 'package:mobile/data/models/computer_activity/activity.dart';

final class DeviceTodos {
  DeviceTodos(this.lists, this.unavailable)
    : signature = jsonEncode([
        for (final list in lists)
          [
            list.chatId,
            for (final item in list.items) [item.id, item.content, item.status],
          ],
        unavailable.toList(),
      ]);
  final List<RemoteChatTodoList> lists;
  final Set<String> unavailable;
  final String signature;
}

/// Uses complete host-derived metadata, never the phone's paginated body tail.
DeviceTodos deviceTodos(Iterable<Map<String, dynamic>> tabs) {
  final lists = <RemoteChatTodoList>[];
  final unavailable = <String>{};
  for (final tab in tabs) {
    final id = tab['id'];
    if (id is! String || tab['kind'] == 'file' || tab['archivedAt'] != null) {
      continue;
    }
    final descriptor = tab['transcript'];
    if (descriptor is! Map<String, dynamic>) {
      unavailable.add(id);
      continue;
    }
    final items = <RemoteTodoItem>[];
    var valid = true;
    for (final field in ['todos', 'taskTodos']) {
      final rows = descriptor[field] ?? const [];
      if (rows is! List) {
        valid = false;
        break;
      }
      for (final row in rows) {
        if (row is! Map<String, dynamic> ||
            row['id'] is! String ||
            row['content'] is! String ||
            row['status'] is! String) {
          valid = false;
          break;
        }
        items.add(
          RemoteTodoItem(
            id: '${field == 'todos' ? 'todo:' : ''}${row['id']}',
            content: row['content'] as String,
            status: row['status'] as String,
          ),
        );
      }
    }
    if (valid) {
      lists.add(
        RemoteChatTodoList(chatId: id, items: List.unmodifiable(items)),
      );
    } else {
      unavailable.add(id);
    }
  }
  return DeviceTodos(List.unmodifiable(lists), Set.unmodifiable(unavailable));
}
