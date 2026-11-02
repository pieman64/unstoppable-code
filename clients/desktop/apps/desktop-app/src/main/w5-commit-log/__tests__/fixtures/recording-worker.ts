/*
 * The real W5 commit log worker with `recording-hooks` installed first. Run
 * through tsx by the host tests; tests must not import it.
 */
import './recording-hooks';
import '../../commit-log-worker';
