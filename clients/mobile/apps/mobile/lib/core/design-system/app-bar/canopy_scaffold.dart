import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'canopy_app_bar.dart';

/// Edge-to-edge screen with floating chrome. The body fills the viewport.
/// Apply [contentPaddingOf] INSIDE a scroll view (as its padding or slivers),
/// so content starts clear of chrome and can then scroll underneath it.
/// For non-scrolling bodies apply those insets with Padding instead.
class CanopyScaffold extends StatelessWidget {
  const CanopyScaffold({
    super.key,
    required this.appBar,
    required this.body,
    this.scaffoldKey,
    this.endDrawer,
    this.onEndDrawerChanged,
  });

  final CanopyAppBar appBar;
  final Widget body;
  final GlobalKey<ScaffoldState>? scaffoldKey;
  final Widget? endDrawer;
  final ValueChanged<bool>? onEndDrawerChanged;

  static EdgeInsets contentPaddingOf(
    BuildContext context, {
    bool includeFade = true,
  }) {
    final insets = context.dependOnInheritedWidgetOfExactType<_ContentInsets>();
    if (insets == null) return EdgeInsets.zero;
    return includeFade
        ? insets.padding
        : insets.padding.copyWith(
            top: insets.padding.top - CanopyAppBar.fadeHeight,
          );
  }

  @override
  Widget build(BuildContext context) {
    final system = MediaQuery.paddingOf(context);
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value:
          (Theme.of(context).brightness == Brightness.dark
                  ? SystemUiOverlayStyle.light
                  : SystemUiOverlayStyle.dark)
              .copyWith(
                statusBarColor: Colors.transparent,
                systemNavigationBarColor: AppColors.of(context).background,
                systemNavigationBarDividerColor: Colors.transparent,
                systemNavigationBarIconBrightness:
                    Theme.of(context).brightness == Brightness.dark
                    ? Brightness.light
                    : Brightness.dark,
                systemNavigationBarContrastEnforced: false,
              ),
      child: Scaffold(
        key: scaffoldKey,
        endDrawer: endDrawer,
        onEndDrawerChanged: onEndDrawerChanged,
        backgroundColor: AppColors.of(context).background,
        extendBody: true,
        body: Stack(
          fit: StackFit.expand,
          children: [
            _ContentInsets(
              padding: EdgeInsets.fromLTRB(
                system.left,
                appBar.height(context),
                system.right,
                system.bottom,
              ),
              child: body,
            ),
            Positioned(top: 0, left: 0, right: 0, child: appBar),
          ],
        ),
      ),
    );
  }
}

class _ContentInsets extends InheritedWidget {
  const _ContentInsets({required this.padding, required super.child});
  final EdgeInsets padding;

  @override
  bool updateShouldNotify(_ContentInsets oldWidget) =>
      padding != oldWidget.padding;
}
