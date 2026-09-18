// Panel session validity. `loggedIn` alone is not enough: a leftover cookie
// must stop working when the password is changed or wiped.

const secrets = require("../config/secrets.cjs");

function isPanelSessionValid(session) {
  if (!session?.loggedIn) return false;
  if (!secrets.hasDashboardPassword()) return false;
  return session.passwordUpdatedAt === secrets.getPasswordUpdatedAt();
}

function stampPanelSession(session) {
  session.loggedIn = true;
  session.passwordUpdatedAt = secrets.getPasswordUpdatedAt();
}

module.exports = { isPanelSessionValid, stampPanelSession };
