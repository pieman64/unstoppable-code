import 'package:flutter/widgets.dart';

/// Root-navigator observer used by screens that must react when another route
/// covers them without disposing them.
final RouteObserver<ModalRoute<Object?>> appRouteObserver =
    RouteObserver<ModalRoute<Object?>>();
