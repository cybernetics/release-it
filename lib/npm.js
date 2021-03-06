const semver = require('semver');
const _ = require('lodash');
const { rejectAfter } = require('./util');
const { debugNpm: debug } = require('./debug');
const { npmTimeoutError, npmAuthError } = require('./errors');

const REGISTRY_TIMEOUT = 5000;
const DEFAULT_TAG = 'latest';
const NPM_BASE_URL = 'https://www.npmjs.com/package/';

const noop = Promise.resolve();

class npm {
  constructor(...args) {
    const options = Object.assign({}, ...args);
    this.options = options;
    this.log = options.log;
    this.shell = options.shell;
  }

  async validate() {
    if (!this.options.publish) return;
    if (!(await this.isRegistryUp())) {
      throw new npmTimeoutError(REGISTRY_TIMEOUT);
    }
    if (!(await this.isAuthenticated())) {
      throw new npmAuthError();
    }
  }

  isRegistryUp() {
    return Promise.race([this.shell.run('npm ping'), rejectAfter(REGISTRY_TIMEOUT)]).then(() => true, () => false);
  }

  isAuthenticated() {
    return this.shell.run('npm whoami').then(() => true, () => false);
  }

  getPackageUrl() {
    return `${NPM_BASE_URL}${this.options.name}`;
  }

  getTag({ tag = DEFAULT_TAG, version, isPreRelease } = {}) {
    if (!isPreRelease || !version) {
      return tag;
    } else {
      const preReleaseComponents = semver.prerelease(version);
      return _.get(preReleaseComponents, 0, tag);
    }
  }

  publish({ tag = this.options.tag, version, isPreRelease, otp = this.options.otp, otpCallback } = {}) {
    const { name, publishPath = '.', access, private: isPrivate } = this.options;
    const resolvedTag = this.getTag({ tag, version, isPreRelease });
    const isScopedPkg = name.startsWith('@');
    const accessArg = isScopedPkg && access ? `--access ${access}` : '';
    const otpArg = otp ? `--otp ${otp}` : '';
    const dryRunArg = this.options.isDryRun ? '--dry-run' : '';
    if (isPrivate) {
      this.log.warn('Skip publish: package is private.');
      return noop;
    }
    return this.shell
      .run(`npm publish ${publishPath} --tag ${resolvedTag} ${accessArg} ${otpArg} ${dryRunArg}`)
      .then(() => {
        this.isPublished = true;
      })
      .catch(err => {
        debug(err);
        if (/one-time pass/.test(err)) {
          if (otp != null) {
            this.log.warn('The provided OTP is incorrect or has expired.');
          }
          if (otpCallback) {
            return otpCallback(otp => this.publish({ tag, version, isPreRelease, otp, otpCallback }));
          }
        }
        throw err;
      });
  }
}

module.exports = npm;
