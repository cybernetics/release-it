const chalk = require('chalk');
const _ = require('lodash');

class Logger {
  constructor({ isInteractive = false, isVerbose = false, isDryRun = false } = {}) {
    this.isInteractive = isInteractive;
    this.isVerbose = isVerbose;
    this.isDryRun = isDryRun;
  }
  log(...args) {
    console.log(...args); // eslint-disable-line no-console
  }
  error(...args) {
    console.error(chalk.red('ERROR'), ...args); // eslint-disable-line no-console
  }
  info(...args) {
    this.isInteractive && this.log(chalk.grey(...args));
  }
  warn(...args) {
    this.log(chalk.yellow('WARNING'), ...args);
  }
  verbose(...args) {
    this.isVerbose && this.log(...args);
  }
  exec(...args) {
    if (this.isVerbose || this.isDryRun) {
      const isNotExecuted = typeof _.last(args) !== 'boolean' || _.last(args) === false;
      const prefix = isNotExecuted ? '!' : '$';
      this.log(prefix, ..._.filter(args, _.isString));
    }
  }
}

module.exports = Logger;
