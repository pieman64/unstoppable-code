import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/features/home/home_tab.dart';

/// Selected top-level destination for `HomeShell`, lifted out of the shell so
/// push deep-link fallbacks (and future programmatic navigation) can switch
/// tabs.
///
/// The selection is a [HomeTab], not an index: the visible set shrinks for a
/// user with no organization, so an index means different destinations in
/// different shells. [select] ignores a tab that is not currently visible,
/// which is what makes a feed deep-link a no-op for an org-less user instead
/// of landing them on whichever tab happens to sit at index 0.
class HomeTabController extends ValueNotifier<HomeTab> {
  HomeTabController({required this.tabs, HomeTab? initialTab})
    : assert(tabs.isNotEmpty, 'the shell needs at least one tab'),
      assert(
        initialTab == null || tabs.contains(initialTab),
        'the landing tab must be one this shell shows',
      ),
      initialTab = _resolveInitialTab(tabs, initialTab),
      super(_resolveInitialTab(tabs, initialTab));

  /// Falls back to the first tab when the requested landing tab is not one this
  /// shell shows.
  ///
  /// The assert above catches that in debug, but `super(...)` bypasses the
  /// guarded [value] setter — so in a release build a mismatched pair would
  /// produce exactly what that guard exists to prevent: `selectedIndex == -1`
  /// and an `IndexedStack(index: -1)`.
  static HomeTab _resolveInitialTab(List<HomeTab> tabs, HomeTab? requested) =>
      requested != null && tabs.contains(requested) ? requested : tabs.first;

  /// The destinations this shell renders, in menu order.
  final List<HomeTab> tabs;

  /// Where the shell opens, and where it falls back to when a carried-over
  /// selection is not in [tabs].
  ///
  /// Separate from menu order on purpose: a shell may lead with one destination
  /// while opening on the most relevant actionable surface.
  final HomeTab initialTab;

  /// Position of the current selection within [tabs]. Always valid, because
  /// [value] cannot be moved outside [tabs].
  int get selectedIndex => tabs.indexOf(value);

  /// Selects [tab] when it is visible in this shell.
  ///
  /// A valid selection attempt always notifies, even when [tab] is already
  /// selected, so navigation side effects such as dismissing the menu still
  /// occur. Hidden tabs remain a no-op.
  void select(HomeTab tab) {
    if (!tabs.contains(tab)) return;
    if (tab == value) {
      notifyListeners();
      return;
    }
    value = tab;
  }

  /// Rejects a tab this shell does not show.
  ///
  /// The guard lives on the setter rather than only in [select] so no caller
  /// can bypass it — an out-of-set value would make [selectedIndex] return -1,
  /// which breaks `IndexedStack`.
  @override
  set value(HomeTab tab) {
    if (!tabs.contains(tab)) return;
    super.value = tab;
  }
}

/// Provides a [HomeTabController] for [tabs] to [child], replacing it when the
/// visible set changes.
///
/// A provider's `create` runs once per element, so a plain
/// `ChangeNotifierProvider` would keep serving the controller built for the
/// original tab set. That matters on the very path this shell exists for: a
/// user who creates their first organization, or accepts an invitation, stays
/// at the same position in the widget tree — and would keep the three-tab
/// no-organization controller, silently never getting Activity or Usage back
/// until the next app launch.
class HomeTabControllerProvider extends StatefulWidget {
  const HomeTabControllerProvider({
    required this.tabs,
    required this.child,
    this.initialTab,
    super.key,
  });

  /// The destinations the shell should currently show.
  final List<HomeTab> tabs;

  /// Where the shell opens. Defaults to the first tab.
  final HomeTab? initialTab;

  final Widget child;

  @override
  State<HomeTabControllerProvider> createState() =>
      _HomeTabControllerProviderState();
}

class _HomeTabControllerProviderState extends State<HomeTabControllerProvider> {
  late HomeTabController _controller = HomeTabController(
    tabs: widget.tabs,
    initialTab: widget.initialTab,
  );

  @override
  void didUpdateWidget(HomeTabControllerProvider oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Value equality, not identity: a caller rebuilding with an equivalent but
    // freshly-built list must not lose the user's selected tab. `initialTab` is
    // checked too — it is an independent input, so a shell that changed only
    // where it lands would otherwise be ignored.
    if (listEquals(oldWidget.tabs, widget.tabs) &&
        oldWidget.initialTab == widget.initialTab) {
      return;
    }
    // Carry the selection over when the new shell still shows that tab: the
    // headline flow is creating an organization FROM the Members tab, and
    // bouncing the user to Activity the moment it succeeds would be a
    // non-sequitur. `select` no-ops when the tab is gone, leaving the new
    // shell's landing tab. A removed Settings destination (Usage, when
    // Personal is selected) opens Activity instead, when the shell shows it
    // (CAN-3715).
    final previous = _controller.value;
    _controller.dispose();
    _controller = HomeTabController(
      tabs: widget.tabs,
      initialTab: widget.initialTab,
    )..select(previous);
    if (!widget.tabs.contains(previous) &&
        settingsHomeTabs.contains(previous)) {
      _controller.select(HomeTab.activity);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      // `.value`, so the provider does not dispose a controller this State
      // owns and replaces.
      ChangeNotifierProvider<HomeTabController>.value(
        value: _controller,
        child: widget.child,
      );
}
