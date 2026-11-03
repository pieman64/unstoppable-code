import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_selection.dart';

const _levels = ['low', 'medium', 'high', 'xhigh'];

/// A drag from the host's level that lands on [to].
({CanopyEffortSelection next, String? send}) _land(
  CanopyEffortSelection selection,
  double to, {
  String host = 'medium',
}) => selection
    .start(_levels, _levels.indexOf(host).toDouble())
    .drag(_levels, to)
    .release(_levels, to, hostLevel: host)!;

void main() {
  test('shows the host level until a drag previews another', () {
    const idle = CanopyEffortSelection();
    expect(idle.shown('medium'), 'medium');

    final dragging = idle.start(_levels, 1).drag(_levels, 2.4);
    expect(dragging.dragging, isTrue);
    expect(dragging.shown('medium'), 'high');
  });

  test('a landing sends its level and keeps it shown', () {
    final landing = _land(const CanopyEffortSelection(), 3);
    expect(landing.send, 'xhigh');
    expect(landing.next.dragging, isFalse);
    expect(landing.next.shown('medium'), 'xhigh');

    final kept = landing.next.settle(landing.next.choice, kept: true);
    expect(kept.shown('medium'), 'xhigh');
  });

  test('a landing on the host level sends nothing and drops the preview', () {
    final landing = _land(const CanopyEffortSelection(), 1);
    expect(landing.send, isNull);
    expect(landing.next.preview, isNull);
  });

  test('a move or release without a drag changes nothing', () {
    const idle = CanopyEffortSelection();
    expect(idle.drag(_levels, 2), same(idle));
    expect(idle.release(_levels, 2, hostLevel: 'medium'), isNull);
  });

  test('an immediate refusal shows the host level again', () {
    final landing = _land(const CanopyEffortSelection(), 3);
    final refused = landing.next.settle(landing.next.choice, kept: false);
    expect(refused.shown('medium'), 'medium');
  });

  test('a superseded refusal keeps the newer landing', () {
    final first = _land(const CanopyEffortSelection(), 2);
    final second = _land(first.next, 3);

    final afterOld = second.next.settle(first.next.choice, kept: false);
    expect(afterOld.shown('medium'), 'xhigh');

    final afterNew = afterOld.settle(second.next.choice, kept: false);
    expect(afterNew.shown('medium'), 'medium');
  });

  test('an older refusal during a newer drag keeps the drag', () {
    final first = _land(const CanopyEffortSelection(), 3);
    final dragging = first.next.start(_levels, 3).drag(_levels, 0);

    final afterOld = dragging.settle(first.next.choice, kept: false);
    expect(afterOld.dragging, isTrue);
    expect(afterOld.shown('medium'), 'low');

    final landing = afterOld.release(_levels, 0, hostLevel: 'medium')!;
    expect(landing.send, 'low');
  });

  test('a new host level replaces a landed preview', () {
    final landing = _land(const CanopyEffortSelection(), 3);
    final updated = landing.next.hostChanged(levels: false, level: true);
    expect(updated.shown('high'), 'high');
  });

  test('a new host level during a drag keeps the drag and its level', () {
    final dragging = const CanopyEffortSelection()
        .start(_levels, 1)
        .drag(_levels, 3);
    final updated = dragging.hostChanged(levels: false, level: true);
    expect(updated.dragging, isTrue);
    expect(updated.shown('low'), 'xhigh');

    final landing = updated.release(_levels, 3, hostLevel: 'low')!;
    expect(landing.send, 'xhigh');
  });

  test('a drag back to a rolled-back host level sends nothing', () {
    final dragging = const CanopyEffortSelection()
        .start(_levels, 2)
        .drag(_levels, 1)
        .hostChanged(levels: false, level: true);
    final landing = dragging.release(_levels, 1, hostLevel: 'medium')!;
    expect(landing.send, isNull);
    expect(landing.next.shown('medium'), 'medium');
  });

  test('new levels end a drag, and its release sends nothing', () {
    final dragging = const CanopyEffortSelection()
        .start(_levels, 1)
        .drag(_levels, 3);
    final updated = dragging.hostChanged(levels: true, level: false);
    expect(updated.dragging, isFalse);
    expect(updated.shown('medium'), 'medium');
    expect(updated.release(['low', 'high'], 3, hostLevel: 'medium'), isNull);
  });

  test('unchanged host data keeps a landed preview', () {
    final landing = _land(const CanopyEffortSelection(), 3);
    expect(
      landing.next.hostChanged(levels: false, level: false),
      same(landing.next),
    );
  });
}
