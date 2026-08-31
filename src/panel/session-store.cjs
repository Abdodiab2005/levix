const session = require("express-session");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class PanelSessionStore extends session.Store {
  constructor({ ttlMs = 12 * 60 * 60 * 1000, maxSessions = 128 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  _expiresAt(sess) {
    const expires = Date.parse(sess?.cookie?.expires || "");
    if (Number.isFinite(expires)) return expires;

    const maxAge = Number(sess?.cookie?.maxAge);
    if (Number.isFinite(maxAge) && maxAge > 0) return Date.now() + maxAge;

    return Date.now() + this.ttlMs;
  }

  _prune() {
    const now = Date.now();
    for (const [sid, entry] of this.sessions) {
      if (entry.expiresAt <= now) this.sessions.delete(sid);
    }
  }

  _makeRoom(sid) {
    if (this.sessions.has(sid) || this.sessions.size < this.maxSessions) return;

    let oldestSid = null;
    let oldestExpiry = Infinity;
    for (const [candidateSid, entry] of this.sessions) {
      if (entry.expiresAt < oldestExpiry) {
        oldestSid = candidateSid;
        oldestExpiry = entry.expiresAt;
      }
    }
    if (oldestSid) this.sessions.delete(oldestSid);
  }

  get(sid, callback) {
    try {
      this._prune();
      const entry = this.sessions.get(sid);
      callback(null, entry ? clone(entry.session) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      this._prune();
      this._makeRoom(sid);
      this.sessions.set(sid, {
        session: clone(sess),
        expiresAt: this._expiresAt(sess),
      });
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      this._prune();
      const entry = this.sessions.get(sid);
      if (entry) {
        entry.expiresAt = this._expiresAt(sess);
        if (sess?.cookie) entry.session.cookie = clone(sess.cookie);
      }
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    this.sessions.delete(sid);
    callback(null);
  }

  clear(callback = () => {}) {
    this.sessions.clear();
    callback(null);
  }

  length(callback) {
    this._prune();
    callback(null, this.sessions.size);
  }
}

module.exports = { PanelSessionStore };
