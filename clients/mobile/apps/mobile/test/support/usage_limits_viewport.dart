/// Geometry checks for the CAN-3636 Usage limits detail screen: what the
/// user can actually see between the app bar and the bottom safe area, at
/// whatever position they scrolled to. Shared by the widget regression and
/// the device flow so both judge visibility the same way.
library;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';

import 'remote_session_fake_server.dart';

const usageLimitsDisconnectedNote = ValueKey('usage-limits-disconnected');
const usageLimitsDeliveryNote = ValueKey('usage-limits-delivery');

/// The detail screen's scrolling list.
Finder get usageLimitsList => find
    .descendant(
      of: find.byType(ListView).last,
      matching: find.byType(Scrollable),
    )
    .first;

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 200));
  }
}

/// Scrolls by [delta] within the list's extent, without fling or bounce.
Future<void> _moveBy(
  WidgetTester tester,
  ScrollPosition position,
  double delta,
) async {
  position.jumpTo(
    (position.pixels + delta).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    ),
  );
  await _settle(tester);
}

/// The visible body: below the top app bar, above the bottom safe area.
Rect usageLimitsBody(WidgetTester tester) {
  final view = tester.view;
  final size = view.physicalSize / view.devicePixelRatio;
  final bottomInset = view.padding.bottom / view.devicePixelRatio;
  final bar = tester.getRect(find.byType(CanopyAppBar).last);
  return Rect.fromLTRB(0, bar.bottom, size.width, size.height - bottomInset);
}

/// [finder] matches one widget lying wholly inside the visible body.
void expectInUsageLimitsBody(
  WidgetTester tester,
  Finder finder,
  String reason,
) {
  expect(finder, findsOneWidget, reason: reason);
  final body = usageLimitsBody(tester);
  final rect = tester.getRect(finder);
  expect(rect.top, greaterThanOrEqualTo(body.top - 0.5), reason: reason);
  expect(rect.bottom, lessThanOrEqualTo(body.bottom + 0.5), reason: reason);
  expect(rect.left, greaterThanOrEqualTo(body.left - 0.5), reason: reason);
  expect(rect.right, lessThanOrEqualTo(body.right + 0.5), reason: reason);
}

/// The stale note [key] reads [message], and every line of it is inside the
/// visible body.
void expectUsageLimitsNoteInView(WidgetTester tester, Key key, String message) {
  final text = find.descendant(
    of: find.byKey(key),
    matching: find.text(message, findRichText: true),
  );
  expectUsageLimitsTextInView(tester, text, 'note "$message" in view');
}

/// [text] is one paragraph, laid out in full (no truncated line), with every
/// line of it inside the visible body.
void expectUsageLimitsTextInView(
  WidgetTester tester,
  Finder text,
  String reason,
) {
  expectInUsageLimitsBody(tester, text, reason);
  final paragraph = tester.renderObject<RenderParagraph>(text);
  expect(paragraph.didExceedMaxLines, isFalse, reason: reason);
  final origin = paragraph.localToGlobal(Offset.zero);
  final body = usageLimitsBody(tester);
  final glyphs = paragraph.getBoxesForSelection(
    TextSelection(
      baseOffset: 0,
      extentOffset: paragraph.text.toPlainText().length,
    ),
  );
  expect(glyphs, isNotEmpty, reason: reason);
  for (final box in glyphs) {
    final glyph = box.toRect().shift(origin);
    expect(glyph.top, greaterThanOrEqualTo(body.top - 0.5), reason: reason);
    expect(glyph.bottom, lessThanOrEqualTo(body.bottom + 0.5), reason: reason);
  }
}

/// Account with Claude's fetch failed and Codex signed out: the row is in
/// view, a full touch target, and its only line reads Claude's
/// "Usage unavailable" in full.
void expectUsageLimitsUnavailableRow(WidgetTester tester) {
  final row = find.byKey(const ValueKey('account-usage-limits'));
  expectInUsageLimitsBody(tester, row, 'Usage limits row in view');
  expect(tester.getSize(row).height, greaterThanOrEqualTo(48));
  for (final label in ['Usage limits', 'Claude', 'Usage unavailable']) {
    expectUsageLimitsTextInView(
      tester,
      find.descendant(of: row, matching: find.text(label)),
      '"$label" in the row',
    );
  }
  expect(find.descendant(of: row, matching: find.text('Codex')), findsNothing);
  expect(tester.takeException(), isNull);
}

/// The detail opened from that row: Claude's [message] and its enabled
/// refresh are in view, with no stale note.
void expectUsageLimitsErrorDetail(WidgetTester tester, String message) {
  expectUsageLimitsTextInView(tester, find.text(message), 'Claude error');
  final refresh = find.byKey(const ValueKey('usage-limits-refresh-claude'));
  expectInUsageLimitsBody(tester, refresh, 'Claude refresh in view');
  expect(usageLimitsRefreshButton(tester, refresh).onPressed, isNotNull);
  final target = tester.getSize(refresh);
  expect(target.width, greaterThanOrEqualTo(44));
  expect(target.height, greaterThanOrEqualTo(44));
  expect(find.byKey(usageLimitsDisconnectedNote), findsNothing);
  expect(find.byKey(usageLimitsDeliveryNote), findsNothing);
  expect(tester.takeException(), isNull);
}

/// Scrolls the detail, as the user would, until Codex's section and its
/// "Not signed in on desktop" line are in view in full.
Future<void> scrollToUsageLimitsSignedOutCodex(WidgetTester tester) async {
  final signedOut = find.text('Not signed in on desktop');
  await tester.scrollUntilVisible(signedOut, 200, scrollable: usageLimitsList);
  await _settle(tester);
  expectUsageLimitsTextInView(
    tester,
    find.descendant(
      of: find.byKey(const ValueKey('usage-limits-section-codex')),
      matching: find.text('Codex'),
    ),
    'Codex title',
  );
  expectUsageLimitsTextInView(tester, signedOut, 'Codex signed out');
  expect(tester.takeException(), isNull);
}

/// From the open detail screen, scrolls until Claude has left the body and
/// Codex's [codexValue] leads it, just under the bar. Returns the position.
Future<ScrollPosition> scrollUsageLimitsToCodex(
  WidgetTester tester, {
  String codexValue = '55.0%',
}) async {
  final position = tester.state<ScrollableState>(usageLimitsList).position;
  final bar = tester.getRect(find.byType(CanopyAppBar).last);
  final value = find.text(codexValue);
  await tester.scrollUntilVisible(value, 200, scrollable: usageLimitsList);
  await tester.ensureVisible(value);
  await tester.pump();
  // Just under the bar, or as close as the list's end allows.
  await _moveBy(
    tester,
    position,
    tester.getTopLeft(value).dy - bar.bottom - 24,
  );
  expect(position.pixels, lessThanOrEqualTo(position.maxScrollExtent));
  expect(position.pixels, greaterThan(0));
  // Claude's plan line is above the bar, or recycled far out of view.
  final claudePlan = find.text('Claude Max 20x');
  if (claudePlan.evaluate().isNotEmpty) {
    expect(
      tester.getBottomLeft(claudePlan).dy,
      lessThanOrEqualTo(bar.bottom),
      reason: 'scrolled past Claude',
    );
  }
  expectInUsageLimitsBody(tester, value, 'Codex value in view');
  return position;
}

/// Scrolls the list the way the user would until [provider]'s refresh sits
/// in the visible body, clear of the bar and any note.
Future<Finder> scrollToUsageLimitsRefresh(
  WidgetTester tester,
  String provider, {
  double delta = -200,
}) async {
  final refresh = find.byKey(ValueKey('usage-limits-refresh-$provider'));
  await tester.scrollUntilVisible(refresh, delta, scrollable: usageLimitsList);
  await tester.pump();
  final hidden = usageLimitsBody(tester).top - tester.getTopLeft(refresh).dy;
  if (hidden > 0) {
    final position = tester.state<ScrollableState>(usageLimitsList).position;
    await _moveBy(tester, position, -hidden - 16);
  }
  expectInUsageLimitsBody(tester, refresh, '$provider refresh in view');
  return refresh;
}

IconButton usageLimitsRefreshButton(WidgetTester tester, Finder refresh) =>
    tester.widget<IconButton>(
      find.descendant(of: refresh, matching: find.byType(IconButton)),
    );

/// Both refreshes are disabled and tapping them sends no further command;
/// the note stays in view wherever the list is scrolled to reach them.
Future<void> expectUsageLimitsRefreshBlocked(
  WidgetTester tester,
  FakePortalSessionServer server,
  Key note,
  String message,
) async {
  final sent = List.of(server.commandBodies);
  for (final provider in ['codex', 'claude']) {
    final refresh = await scrollToUsageLimitsRefresh(tester, provider);
    expect(usageLimitsRefreshButton(tester, refresh).onPressed, isNull);
    await tester.tap(refresh, warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 100));
    expectUsageLimitsNoteInView(tester, note, message);
  }
  expect(server.commandBodies, sent);
}
