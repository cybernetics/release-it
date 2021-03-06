const { EOL } = require('os');
const Logger = require('./log');
const Config = require('./config');
const Shell = require('./shell');
const Git = require('./git');
const GitDist = require('./git-dist');
const GitHub = require('./github');
const GitLab = require('./gitlab');
const npm = require('./npm');
const Version = require('./version');
const Changelog = require('./changelog');
const Prompt = require('./prompt');
const Spinner = require('./spinner');
const Metrics = require('./metrics');
const { logPreview } = require('./util');
const { debug } = require('./debug');
const { ReleaseItError } = require('./errors');
const handleDeprecated = require('./deprecated');
const { prepareDistRepo, getDistRepoClients } = require('./tasks-dist');

const runTasks = async (opts, injected = {}) => {
  const config = new Config(opts);

  const { isInteractive, isVerbose, isDryRun, isDebug } = config;

  const log = injected.log || new Logger({ isInteractive, isVerbose, isDryRun });
  const spinner = injected.spinner || new Spinner({ isInteractive, isVerbose, isDryRun, isDebug });
  const prompt = new Prompt({ config });
  const metrics = new Metrics({ isEnabled: config.isCollectMetrics });

  try {
    // TODO: Remove `distRepo` work-around in v10
    const distRepo = config.options.dist.repo;
    const options = handleDeprecated(config.getOptions(), injected.log);
    if (distRepo) {
      log.warn(
        'The "dist.repo" option is deprecated. Please see https://github.com/webpro/release-it#distribution-repository for details more.'
      );
      options.dist.repo = distRepo;
    }

    metrics.trackEvent('start', options);

    const { name, increment, dist, use, pkgFiles, scripts } = options;
    const { beforeStart, beforeBump, afterBump, beforeStage } = scripts;

    const shell = new Shell({ isVerbose, isDryRun }, { log, config });
    const gitClient = new Git(options.git, { log, shell });
    const gitDistClient = new GitDist(options.git, dist.git, dist, { log, shell });
    const changelogs = new Changelog({ shell });
    const ghClient = new GitHub(options.github, options.git, { isDryRun }, { log, changelogs });
    const glClient = new GitLab(options.gitlab, options.git, { isDryRun }, { log, changelogs });
    const npmClient = new npm(options.npm, { isDryRun }, { shell, log });
    const v = new Version({ preReleaseId: options.preReleaseId, log });

    await gitClient.validate();
    gitDistClient.validate();
    ghClient.validate();
    glClient.validate();
    await npmClient.validate();

    const { latestTag, isRootDir, remoteUrl } = gitClient;
    const run = shell.runTemplateCommand.bind(shell);

    // TODO: this is some unexpected injection
    ghClient.remoteUrl = remoteUrl;
    glClient.remoteUrl = remoteUrl;

    await spinner.show({ enabled: beforeStart, task: () => run(beforeStart), label: beforeStart, forced: true });

    v.setLatestVersion({ use, gitTag: latestTag, pkgVersion: options.npm.version, isRootDir });
    await v.bump({ increment, preRelease: options.preRelease });

    config.setRuntimeOptions(v.details);
    const { latestVersion } = v;

    // Let's get this party started
    const suffix = v.version ? `${latestVersion}...${v.version}` : `currently at ${latestVersion}`;
    log.log(`${EOL}🚀 Let's release ${name} (${suffix})`);

    const generateAndPreviewChangelog = async () => {
      const changelog = await changelogs.generate(scripts.changelog, latestTag);
      logPreview(log, 'changelog', changelog, !v.version && EOL);
      return changelog;
    };

    // With an increment such as `conventional:angular`, changelog genersation should be deferred until after the bump
    const isDeferChangeLog = v.isRecommendation(increment);

    let changelog;
    if (!isDeferChangeLog) {
      changelog = await generateAndPreviewChangelog();
      config.setRuntimeOptions({ changelog });
    }

    // Prompt for version if not determined yet
    if (isInteractive && !v.version) {
      await prompt.show({
        prompt: 'incrementList',
        task: async increment =>
          increment
            ? await v.bump({ increment })
            : await prompt.show({ prompt: 'version', task: async version => (v.version = version) })
      });
    }

    v.validate();
    config.setRuntimeOptions(v.details);
    const { version, isPreRelease } = v.details;

    // With an early exit (Ctrl-c), in specific circumstances, the changes can be reverted safely
    if (isInteractive && pkgFiles && options.git.requireCleanWorkingDir) {
      process.on('SIGINT', () => gitClient.reset(pkgFiles));
      process.on('exit', () => gitClient.reset(pkgFiles));
    }

    // Bump
    await spinner.show({ enabled: beforeBump, task: () => run(beforeBump), label: beforeBump, forced: true });
    await spinner.show({ task: () => shell.bump(pkgFiles, version), label: 'Bump version' });
    await spinner.show({ enabled: afterBump, task: () => run(afterBump), label: afterBump, forced: true });

    // Deferred changelog generation after bump
    if (isDeferChangeLog) {
      changelog = await generateAndPreviewChangelog();
      config.setRuntimeOptions({ changelog });
    }

    await spinner.show({ enabled: beforeStage, task: () => run(beforeStage), label: beforeStage, forced: true });
    await gitClient.stage(pkgFiles);
    await gitClient.stageDir();

    if (dist.repo) {
      await prepareDistRepo({ options: dist, spinner, shell, gitClient: gitDistClient });
    }

    const step = options => (isInteractive ? prompt.show(options) : spinner.show(options));

    const release = async ({ gitClient, ghClient, glClient, npmClient, scripts }) => {
      const git = gitClient.options;
      const github = ghClient.options;
      const gitlab = glClient.options;
      const npm = npmClient.options;

      // Git
      git.commit && logPreview(log, 'changeset', await gitClient.status(), EOL);
      await step({ enabled: git.commit, task: () => gitClient.commit(), label: 'Git commit', prompt: 'commit' });
      await step({ enabled: git.tag, task: () => gitClient.tag(), label: 'Git tag', prompt: 'tag' });
      await step({ enabled: git.push, task: () => gitClient.push(), label: 'Git push', prompt: 'push' });

      // GitHub
      github.release && github.releaseNotes && logPreview(log, 'release notes', await ghClient.getNotes(), EOL);
      const ghRelease = () => ghClient.release({ version, isPreRelease, changelog });
      const ghUploadAssets = () => ghClient.uploadAssets();
      if (isInteractive) {
        const release = async () => (await ghRelease()) && (await ghUploadAssets());
        await step({ enabled: github.release, task: release, label: 'GitHub release', prompt: 'ghRelease' });
      } else {
        await step({ enabled: github.release, task: ghRelease, label: 'GitHub release' });
        await step({ enabled: github.assets, task: ghUploadAssets, label: 'GitHub upload assets' });
      }

      // GitLab
      gitlab.release && gitlab.releaseNotes && logPreview(log, 'release notes', await glClient.getNotes(), EOL);
      const glRelease = () => glClient.release({ version, changelog });
      await step({ enabled: gitlab.release, task: glRelease, label: 'GitLab release', prompt: 'glRelease' });

      // npm
      const publish = () => npmClient.publish({ version, isPreRelease, otpCallback });
      const otpCallback = isInteractive ? task => prompt.show({ prompt: 'otp', task }) : null;
      await step({ enabled: npm.publish, task: publish, label: 'npm publish', prompt: 'publish' });

      // Wrap up
      const { afterRelease } = scripts;
      await spinner.show({ enabled: afterRelease, task: () => run(afterRelease), label: afterRelease, forced: true });

      ghClient.isReleased && log.log(`🔗 ${ghClient.getReleaseUrl()}`);
      glClient.isReleased && log.log(`🔗 ${glClient.getReleaseUrl()}`);
      npmClient.isPublished && log.log(`🔗 ${npmClient.getPackageUrl()}`);
    };

    await release({ gitClient, ghClient, glClient, npmClient, scripts });

    if (dist.repo) {
      const { stageDir, scripts } = dist;
      await shell.pushd(stageDir);
      await gitDistClient.init();
      gitDistClient.handleTagOptions(gitClient);
      const distClients = getDistRepoClients({ options, log, isDryRun, remoteUrl, changelogs, shell });
      await release(Object.assign({ gitClient: gitDistClient, scripts }, distClients));
      await shell.popd();
      await run(`!rm -rf ${stageDir}`);
    }

    await metrics.trackEvent('end');

    log.log(`🏁 Done (in ${Math.floor(process.uptime())}s.)`);

    return Promise.resolve({
      name,
      changelog,
      latestVersion,
      version
    });
  } catch (err) {
    await metrics.trackException(err);
    if (err instanceof ReleaseItError) {
      log.error(err.message || err);
      debug(err);
    } else {
      console.error(err); // eslint-disable-line no-console
    }
    throw err;
  }
};

module.exports = runTasks;
