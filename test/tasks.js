const path = require('path');
const { EOL } = require('os');
const test = require('ava');
const sh = require('shelljs');
const proxyquire = require('proxyquire');
const _ = require('lodash');
const Log = require('../lib/log');
const Spinner = require('../lib/spinner');
const { gitAdd, readFile, readJSON } = require('./util/index');
const uuid = require('uuid/v4');
const GitHubApi = require('@octokit/rest');
const githubRequestMock = require('./mock/github.request');
const Shell = require('../lib/shell');
const sinon = require('sinon');
const runTasks = require('../lib/tasks');
const {
  GitRepoError,
  GitRemoteUrlError,
  GitCleanWorkingDirError,
  GitUpstreamError,
  TokenError,
  InvalidVersionError,
  DistRepoStageDirError
} = require('../lib/errors');

const cwd = process.cwd();
const noop = Promise.resolve();

const sandbox = sinon.createSandbox();

const githubRequestStub = sandbox.stub().callsFake(githubRequestMock);
const githubApi = new GitHubApi();
githubApi.hook.wrap('request', githubRequestStub);
const GitHubApiStub = sandbox.stub().returns(githubApi);

const gotStub = sinon.stub().resolves({});

const npmStub = sandbox.stub().resolves();
const log = sandbox.createStubInstance(Log);
const spinner = sandbox.createStubInstance(Spinner);
spinner.show.callsFake(({ enabled = true, task }) => (enabled ? task() : noop));
const stubs = { log, spinner };

class ShellStub extends Shell {
  run(command) {
    if (/^npm /.test(command)) {
      this.log.exec(command);
      return npmStub(...arguments);
    }
    return super.run(...arguments);
  }
}

const testConfig = {
  config: false,
  'non-interactive': true,
  'disable-metrics': true
};

const tasks = (options, ...args) => runTasks(Object.assign({}, testConfig, options), ...args);

test.serial.beforeEach(t => {
  const bare = path.resolve(cwd, 'tmp', uuid());
  const target = path.resolve(cwd, 'tmp', uuid());
  sh.pushd('-q', `${cwd}/tmp`);
  sh.exec(`git init --bare ${bare}`);
  sh.exec(`git clone ${bare} ${target}`);
  sh.pushd('-q', target);
  gitAdd('line', 'file', 'Add file');
  t.context = { bare, target };
});

test.serial.afterEach(() => {
  sh.pushd('-q', cwd);
  sandbox.resetHistory();
});

test.serial('should throw when not a Git repository', async t => {
  sh.pushd('-q', '../../..');
  const expected = { instanceOf: GitRepoError, message: /not \(inside\) a Git repository/ };
  await t.throwsAsync(tasks(null, stubs), expected);
  sh.popd('-q');
});

test.serial('should throw if there is no remote Git url', async t => {
  sh.exec('git remote remove origin');
  const expected = { instanceOf: GitRemoteUrlError, message: /Could not get remote Git url/ };
  await t.throwsAsync(tasks(null, stubs), expected);
});

test.serial('should throw if working dir is not clean', async t => {
  sh.exec('rm file');
  const expected = { instanceOf: GitCleanWorkingDirError, message: /Working dir must be clean/ };
  await t.throwsAsync(tasks(null, stubs), expected);
});

test.serial('should throw if no upstream is configured', async t => {
  sh.exec('git checkout -b foo');
  const expected = { instanceOf: GitUpstreamError, message: /No upstream configured for current branch/ };
  await t.throwsAsync(tasks(null, stubs), expected);
});

test.serial('should throw if no GitHub token environment variable is set', async t => {
  const config = { github: { release: true, tokenRef: 'GITHUB_FOO' } };
  const expected = {
    instanceOf: TokenError,
    message: /Environment variable "GITHUB_FOO" is required for GitHub releases/
  };
  await t.throwsAsync(tasks(config, stubs), expected);
});

test.serial('should throw if invalid increment value is provided', async t => {
  const config = { increment: 'mini' };
  const expected = { instanceOf: InvalidVersionError, message: /invalid version was provided/ };
  await t.throwsAsync(tasks(config, stubs), expected);
});

test.serial('should throw if not a subdir is provided for dist.stageDir', async t => {
  const config = { dist: { repo: 'foo', stageDir: '..' } };
  const expected = {
    instanceOf: DistRepoStageDirError,
    message: /`dist.stageDir` \(".."\) must resolve to a sub directory/
  };
  await t.throwsAsync(tasks(config, stubs), expected);
});

test.serial('should run tasks without throwing errors', async t => {
  const { name, latestVersion, version } = await tasks(
    { increment: 'patch', pkgFiles: null, manifest: false, npm: { publish: false } },
    stubs
  );
  t.true(log.log.firstCall.args[0].includes(`release ${name} (${latestVersion}...${version})`));
  t.regex(log.log.lastCall.args[0], /Done \(in [0-9]+s\.\)/);
});

test.serial('should run tasks with minimal config and without any warnings/errors', async t => {
  gitAdd('{"name":"my-package","version":"1.2.3"}', 'package.json', 'Add package.json');
  sh.exec('git tag 1.2.3');
  gitAdd('line', 'file', 'More file');
  await tasks({ increment: 'patch', npm: { publish: false } }, stubs);
  t.true(log.log.firstCall.args[0].includes('release my-package (1.2.3...1.2.4)'));
  t.regex(log.log.lastCall.args[0], /Done \(in [0-9]+s\.\)/);
  const pkg = await readJSON('package.json');
  t.is(pkg.version, '1.2.4');
  {
    const { stdout } = sh.exec('git describe --tags --abbrev=0');
    t.is(stdout.trim(), '1.2.4');
  }
});

test.serial('should use pkg.version if no git tag', async t => {
  gitAdd('{"name":"my-package","version":"1.2.3"}', 'package.json', 'Add package.json');
  await tasks({ increment: 'minor', npm: { publish: false } }, stubs);
  t.true(log.log.firstCall.args[0].includes('release my-package (1.2.3...1.3.0)'));
  t.regex(log.log.lastCall.args[0], /Done \(in [0-9]+s\.\)/);
  const pkg = await readJSON('package.json');
  t.is(pkg.version, '1.3.0');
  {
    const { stdout } = sh.exec('git describe --tags --abbrev=0');
    t.is(stdout.trim(), '1.3.0');
  }
});

test.serial('should use pkg.version (in sub dir) w/o tagging repo', async t => {
  gitAdd('{"name":"root-package","version":"1.0.0"}', 'package.json', 'Add package.json');
  sh.exec('git tag 1.0.0');
  sh.mkdir('my-package');
  sh.pushd('-q', 'my-package');
  gitAdd('{"name":"my-package","version":"1.2.3"}', 'package.json', 'Add package.json');
  await tasks({ increment: 'minor', git: { tag: false }, npm: { publish: false } }, stubs);
  t.true(log.log.firstCall.args[0].endsWith('release my-package (1.2.3...1.3.0)'));
  t.regex(log.log.lastCall.args[0], /Done \(in [0-9]+s\.\)/);
  const pkg = await readJSON('package.json');
  t.is(pkg.version, '1.3.0');
  sh.popd('-q');
  {
    const { stdout } = sh.exec('git describe --tags --abbrev=0');
    t.is(stdout.trim(), '1.0.0');
    const pkg = await readJSON('package.json');
    t.is(pkg.version, '1.0.0');
  }
});

test.serial('should run tasks without package.json', async t => {
  sh.exec('git tag 1.0.0');
  const { name } = await tasks({ increment: 'major', npm: { publish: false } }, stubs);
  t.true(log.log.firstCall.args[0].includes(`release ${name} (1.0.0...2.0.0)`));
  t.regex(log.log.lastCall.args[0], /Done \(in [0-9]+s\.\)/);
  const warnings = _.flatten(log.warn.args);
  t.true(warnings.includes('Could not bump package.json'));
  t.true(warnings.includes('Could not stage package.json'));
  {
    const { stdout } = sh.exec('git describe --tags --abbrev=0');
    t.is(stdout.trim(), '2.0.0');
  }
});

{
  const runTasks = proxyquire('../lib/tasks', {
    '@octokit/rest': Object.assign(GitHubApiStub, { '@global': true }),
    got: Object.assign(gotStub, { '@global': true }),
    './shell': Object.assign(ShellStub, { '@global': true })
  });

  const tasks = (options, ...args) => runTasks(Object.assign({}, testConfig, options), ...args);

  test.serial('should release all the things (basic)', async t => {
    const { bare, target } = t.context;
    const repoName = path.basename(bare);
    const pkgName = path.basename(target);
    gitAdd(`{"name":"${pkgName}","version":"1.0.0"}`, 'package.json', 'Add package.json');
    sh.exec('git tag 1.0.0');
    gitAdd('line', 'file', 'More file');
    await tasks({ github: { release: true }, npm: { name: pkgName, publish: true } }, stubs);
    const githubReleaseArg = githubRequestStub.firstCall.lastArg;
    t.is(githubRequestStub.callCount, 1);
    t.is(githubReleaseArg.url, '/repos/:owner/:repo/releases');
    t.is(githubReleaseArg.owner, null);
    t.is(githubReleaseArg.repo, repoName);
    t.is(githubReleaseArg.tag_name, '1.0.1');
    t.is(githubReleaseArg.name, 'Release 1.0.1');
    t.true(githubReleaseArg.body.startsWith('* More file'));
    t.is(githubReleaseArg.prerelease, false);
    t.is(githubReleaseArg.draft, false);

    t.is(npmStub.callCount, 3);
    t.is(npmStub.firstCall.args[0], 'npm ping');
    t.is(npmStub.secondCall.args[0].trim(), 'npm whoami');
    t.is(npmStub.thirdCall.args[0].trim(), 'npm publish . --tag latest');

    t.true(log.log.firstCall.args[0].endsWith(`release ${pkgName} (1.0.0...1.0.1)`));
    t.true(log.log.secondCall.args[0].endsWith(`https://github.com/null/${repoName}/releases/tag/1.0.1`));
    t.true(log.log.thirdCall.args[0].endsWith(`https://www.npmjs.com/package/${pkgName}`));
  });

  test.serial('should release all the things (pre-release, github, gitlab, dist repo)', async t => {
    const { bare, target } = t.context;
    const repoName = path.basename(bare);
    const pkgName = path.basename(target);
    const owner = null;
    gitAdd(`{"name":"${pkgName}","version":"1.0.0"}`, 'package.json', 'Add package.json');
    sh.exec('git tag v1.0.0');
    {
      // Prepare fake dist repo
      sh.exec('git checkout -b dist');
      gitAdd(`dist-line${EOL}`, 'dist-file', 'Add dist file');
      sh.exec('git push -u origin dist');
    }
    sh.exec('git checkout master');
    gitAdd('line', 'file', 'More file');
    sh.exec('git push --follow-tags');
    await tasks(
      {
        increment: 'minor',
        preRelease: 'alpha',
        git: { tagName: 'v${version}' },
        github: {
          release: true,
          releaseNotes: 'echo "Notes for ${name} (v${version}): ${changelog}"',
          assets: ['file']
        },
        gitlab: {
          release: true,
          releaseNotes: 'echo "Notes for ${name}: ${changelog}"'
        },
        npm: { name: pkgName, publish: false },
        dist: {
          repo: `${bare}#dist`,
          scripts: { beforeStage: `echo release-line >> dist-file` },
          npm: { publish: true }
        }
      },
      stubs
    );

    t.is(githubRequestStub.callCount, 2);

    const githubReleaseArg = githubRequestStub.firstCall.lastArg;
    t.is(githubReleaseArg.url, '/repos/:owner/:repo/releases');
    t.is(githubReleaseArg.owner, owner);
    t.is(githubReleaseArg.repo, repoName);
    t.is(githubReleaseArg.tag_name, 'v1.1.0-alpha.0');
    t.is(githubReleaseArg.name, 'Release 1.1.0-alpha.0');
    t.regex(githubReleaseArg.body, RegExp(`Notes for ${pkgName} \\(v1.1.0-alpha.0\\): \\* More file`));
    t.is(githubReleaseArg.prerelease, true);
    t.is(githubReleaseArg.draft, false);

    const githubAssetsArg = githubRequestStub.secondCall.lastArg;
    const { id } = githubRequestStub.firstCall.returnValue.data;
    t.true(githubAssetsArg.url.endsWith(`/repos/${owner}/${repoName}/releases/${id}/assets{?name,label}`));
    t.is(githubAssetsArg.name, 'file');

    t.true(gotStub.firstCall.args[0].endsWith(`/api/v4/projects/${repoName}/repository/tags/v1.1.0-alpha.0/release`));
    t.regex(gotStub.firstCall.args[1].body.description, RegExp(`Notes for ${pkgName}: \\* More file`));

    t.is(npmStub.callCount, 1);
    t.is(npmStub.firstCall.args[0].trim(), 'npm publish . --tag alpha');

    const { stdout } = sh.exec('git describe --tags --abbrev=0');
    t.is(stdout.trim(), 'v1.1.0-alpha.0');

    sh.exec('git checkout dist');
    sh.exec('git pull');
    const distFile = await readFile('dist-file');
    t.is(distFile.trim(), `dist-line${EOL}release-line`);

    t.true(log.log.firstCall.args[0].endsWith(`release ${pkgName} (1.0.0...1.1.0-alpha.0)`));
    t.true(log.log.secondCall.args[0].endsWith(`https://github.com/${owner}/${repoName}/releases/tag/v1.1.0-alpha.0`));
    t.true(log.log.thirdCall.args[0].endsWith(`https://localhost/${repoName}/tags/v1.1.0-alpha.0`));
    t.true(log.log.args[3][0].endsWith(`release the distribution repo for ${pkgName}`));
    t.true(log.log.args[4][0].endsWith(`https://www.npmjs.com/package/${pkgName}`));
    t.regex(log.log.lastCall.args[0], /Done \(in [0-9]+s\.\)/);
  });

  test.serial('should run all scripts', async t => {
    const spy = sinon.spy(ShellStub.prototype, 'run');

    const { bare } = t.context;
    sh.exec('git checkout -b dist');
    gitAdd(`dist-line`, 'dist-file', 'Add dist file');
    sh.exec('git push -u origin dist');
    sh.exec('git checkout master');

    await tasks(
      {
        increment: 'patch',
        pkgFiles: null,
        manifest: false,
        scripts: {
          beforeStart: 'echo beforeStart',
          beforeBump: 'echo beforeBump',
          afterBump: 'echo afterBump',
          beforeStage: 'echo beforeStage',
          afterRelease: 'echo afterRelease'
        },
        dist: {
          repo: `${bare}#dist`,
          scripts: {
            beforeStage: 'echo dist beforeStage',
            afterRelease: 'echo dist afterRelease'
          }
        }
      },
      stubs
    );

    const args = _.flatten(spy.args);
    const occurrences = (haystack, needle) => _.filter(haystack, item => item === needle).length;

    t.is(occurrences(args, 'echo beforeStart'), 1);
    t.is(occurrences(args, 'echo beforeBump'), 1);
    t.is(occurrences(args, 'echo afterBump'), 1);
    t.is(occurrences(args, 'echo beforeStage'), 1);
    t.is(occurrences(args, 'echo afterRelease'), 1);
    t.is(occurrences(args, 'echo dist beforeStage'), 1);
    t.is(occurrences(args, 'echo dist afterRelease'), 1);

    spy.restore();
  });
}
