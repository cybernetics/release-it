const { EOL } = require('os');

class ReleaseItError extends Error {
  constructor(...args) {
    super(...args);
    Error.captureStackTrace(this, this.constructor);
  }
}

class GitCommitError extends ReleaseItError {}

class GitHubClientError extends ReleaseItError {}

class InvalidVersionError extends ReleaseItError {
  constructor() {
    super('An invalid version was provided.');
  }
}

class FileNotFoundError extends ReleaseItError {
  constructor(filePath) {
    super(`File not found (${filePath})`);
  }
}

class DistRepoStageDirError extends ReleaseItError {
  constructor(stageDir) {
    super(
      `The \`dist.stageDir\` ("${stageDir}") must resolve to a sub directory of current working directory.` +
        EOL +
        'Documentation: https://github.com/webpro/release-it#distribution-repository'
    );
  }
}

class GitRepoError extends ReleaseItError {
  constructor() {
    super('The current directory is not (inside) a Git repository. Use `--no.git` to skip Git steps.');
  }
}

class GitRemoteUrlError extends ReleaseItError {
  constructor() {
    super('Could not get remote Git url.' + EOL + 'Please add a remote repository.');
  }
}

class GitCleanWorkingDirError extends ReleaseItError {
  constructor() {
    super(
      'Working dir must be clean.' +
        EOL +
        'Please stage and commit your changes.' +
        EOL +
        'Alternatively, use `--no-git.requireCleanWorkingDir` to include the changes in the release commit' +
        ' (or save `"git.requireCleanWorkingDir": false` in the configuration).'
    );
  }
}

class GitUpstreamError extends ReleaseItError {
  constructor() {
    super(
      'No upstream configured for current branch.' +
        EOL +
        'Please set an upstream branch.' +
        EOL +
        'Alternatively, use `--no-git.requireUpstream` to have this set this by release-it' +
        ' (or save `"git.requireUpstream": false` in the configuration).'
    );
  }
}

class TokenError extends ReleaseItError {
  constructor(type, tokenRef) {
    super(
      `Environment variable "${tokenRef}" is required for ${type} releases.` +
        EOL +
        `Documentation: https://github.com/webpro/release-it#${type.toLowerCase()}-releases`
    );
  }
}

class npmTimeoutError extends ReleaseItError {
  constructor(timeout) {
    super(`Unable to reach npm registry (timed out after ${timeout}ms).`);
  }
}

class npmAuthError extends ReleaseItError {
  constructor() {
    super('Not authenticated with npm. Please `npm login` and try again.');
  }
}

module.exports = {
  ReleaseItError,
  GitHubClientError,
  InvalidVersionError,
  FileNotFoundError,
  DistRepoStageDirError,
  GitRepoError,
  GitRemoteUrlError,
  GitCleanWorkingDirError,
  GitUpstreamError,
  GitCommitError,
  TokenError,
  npmTimeoutError,
  npmAuthError
};
