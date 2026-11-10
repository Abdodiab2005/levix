const { AsyncLocalStorage } = require("node:async_hooks");

const scope = new AsyncLocalStorage();

function withCommand(command, fn) {
  return scope.run(command, fn);
}

function currentCommand() {
  return scope.getStore() || null;
}

module.exports = { withCommand, currentCommand };
