import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Drives the remote chat screen's conversation list — the FAB plus the modal
/// bottom sheet behind it — the way a user does.
///
/// The pumps are explicit durations rather than `pumpAndSettle`: a streaming
/// chat keeps a repeating spinner animation alive, which never settles.
extension ChatTabsSheetDriver on WidgetTester {
  static const Duration _sheetAnimation = Duration(milliseconds: 400);

  /// Opens the tab sheet from the FAB. The leading pump clears a previous
  /// sheet's exit animation, whose modal barrier would otherwise swallow the
  /// tap.
  Future<void> openTabsSheet() async {
    await pump(_sheetAnimation);
    await tap(find.byKey(const ValueKey('chat-tabs-fab')));
    await pump();
    await pump(_sheetAnimation);
  }

  /// Starts the sheet's dismissal after an action popped it.
  ///
  /// Deliberately one frame: advancing fake time far enough to finish the exit
  /// animation also advances the view model's own timers, and several tests
  /// assert against state a stray refresh would move. The exiting sheet is
  /// still in the tree afterwards — [openTabsSheet] waits it out, and
  /// [finishSheetDismiss] is there for tests that assert it is gone.
  Future<void> settleSheetDismiss() => pump();

  /// Runs the sheet's exit animation to completion.
  Future<void> finishSheetDismiss() async {
    await pump();
    await pump(_sheetAnimation);
  }

  /// Switches to the chat titled [title]: FAB -> sheet row -> dismiss.
  Future<void> selectTabFromSheet(String title) async {
    await openTabsSheet();
    await tap(
      find.descendant(of: find.byType(BottomSheet), matching: find.text(title)),
    );
    await settleSheetDismiss();
  }

  /// Taps the sheet's "New chat" button.
  Future<void> startNewChatFromSheet() async {
    await openTabsSheet();
    await tap(find.byKey(const ValueKey('new-chat-button')));
    await settleSheetDismiss();
  }

  /// Closes [chatId]'s tab from its sheet row.
  Future<void> closeTabFromSheet(String chatId) async {
    await openTabsSheet();
    await tap(find.byKey(ValueKey('chat-tab-close-$chatId')));
    await settleSheetDismiss();
  }

  /// Dismisses an open sheet without choosing anything.
  Future<void> dismissTabsSheet() async {
    Navigator.of(element(find.byKey(const ValueKey('new-chat-button')))).pop();
    await finishSheetDismiss();
  }
}
