import 'package:flutter/widgets.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:provider/provider.dart';

/// Calls [refresh] when the user comes back to Activity: on every Activity
/// selection, including reselection and the push-tap fallback, and when the
/// app resumes while Activity is selected.
///
/// Without a [HomeTabController] (a standalone feed) every resume counts.
/// The feed joins overlapping reloads, so simultaneous signals cost one
/// request.
class ActivityRefreshBinding extends StatefulWidget {
  const ActivityRefreshBinding({
    super.key,
    required this.refresh,
    required this.child,
  });

  /// Reloads Activity. It receives this binding's context, so it reaches the
  /// feed of the current account context. The app composition owns the feed,
  /// so the home feature does not import it.
  final void Function(BuildContext context) refresh;

  final Widget child;

  @override
  State<ActivityRefreshBinding> createState() => _ActivityRefreshBindingState();
}

class _ActivityRefreshBindingState extends State<ActivityRefreshBinding>
    with WidgetsBindingObserver {
  HomeTabController? _tabs;

  bool get _activityVisible =>
      _tabs == null || _tabs!.value == HomeTab.activity;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // The shell replaces its controller when the visible tab set changes, so
    // follow the current one.
    final tabs = Provider.of<HomeTabController?>(context);
    if (identical(tabs, _tabs)) return;
    _tabs?.removeListener(_onTabSelected);
    _tabs = tabs?..addListener(_onTabSelected);
  }

  void _onTabSelected() {
    if (_tabs?.value == HomeTab.activity) _refresh();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _activityVisible) _refresh();
  }

  void _refresh() => widget.refresh(context);

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tabs?.removeListener(_onTabSelected);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
