import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/git_remote_url.dart';

// Ports of the desktop's `isPlausibleGitRemoteUrl`
// (apps/desktop-app/src/main/portal/adapters/workspace-adapter.ts) and the
// protocol's `repositoryNameFromCloneUrl`
// (packages/protocol/src/portal/index.ts). The name table is the protocol
// contract test's table, so the phone shows the name the web shows.
void main() {
  group('isPlausibleGitRemoteUrl', () {
    for (final url in [
      'https://github.com/org/repo.git',
      'http://git.example.test/org/repo',
      'git://example.test/repo.git',
      'ssh://git@example.test/org/repo.git',
      'HTTPS://GitHub.com/Org/Repo.git',
      '  https://github.com/org/repo.git  ',
      'git@github.com:org/repo.git',
      'deploy@host:repo',
    ]) {
      test('accepts $url', () => expect(isPlausibleGitRemoteUrl(url), isTrue));
    }

    for (final url in [
      '',
      '   ',
      '--upload-pack=touch /tmp/x',
      '-oProxyCommand=x@host:path',
      'file:///Users/me/repo',
      '/Users/me/source-repo',
      r'C:\source\repo.git',
      'github.com/org/repo',
      'org/repo.git',
      'ftp://example.test/repo.git',
      'git@github.com',
      'git@github.com:',
      'git@git/hub.com:org/repo.git',
      'my user@host:repo',
    ]) {
      test(
        'rejects "$url"',
        () => expect(isPlausibleGitRemoteUrl(url), isFalse),
      );
    }
  });

  group('repositoryNameFromCloneUrl', () {
    for (final (url, name) in const [
      (' https://github.com/org/repo.git ', 'repo'),
      ('https://user:secret@host/org/repo.git/?token=secret#fragment', 'repo'),
      ('https://host/org/repo.git///', 'repo'),
      ('ssh://git@host/org/repo.git', 'repo'),
      ('git@host:org/repo.git', 'repo'),
      ('git@host:repo.git', 'repo'),
      (r'git@host:org/repo.git\', 'repo'),
      ('/Users/me/source-repo', 'source-repo'),
      (r'C:\source\repo.git\', 'repo'),
      ('org/repo.git', 'repo'),
      ('bare-repo', 'bare-repo'),
      ('', 'repository'),
      ('   ', 'repository'),
      ('https://', 'repository'),
      ('https://user:secret@host/', 'repository'),
      ('/.git///', 'repository'),
    ]) {
      test(
        'derives "$url" as $name',
        () => expect(repositoryNameFromCloneUrl(url), name),
      );
    }
  });
}
