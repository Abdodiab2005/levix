// Installation identity for Levix Plus.
//
// The Ed25519 keypair is created the first time something asks for it, never
// at boot, so a Free install never writes one. The PKCS8 private key is sealed
// with the vault and stored at `plus:installation-key`. The installation id is
// base64url(SHA-256(raw public key)): 43 characters, no personal data.

const crypto = require("node:crypto");

const { rawFromKeyObject } = require("./keys.cjs");

const INSTALLATION_KEY = "plus:installation-key";

function createInstallation(deps = {}) {
  const storage = () => deps.storage ?? require("../../db/store.cjs");
  const vault = () => deps.vault ?? require("../../config/vault.cjs");
  let cache = null;

  function readSealed() {
    const store = storage();
    const value =
      typeof store.getBotSetting === "function"
        ? store.getBotSetting(INSTALLATION_KEY, null)
        : typeof store.get === "function"
          ? (store.get(INSTALLATION_KEY) ?? null)
          : null;
    if (typeof value !== "string" || value.length === 0) return null;
    return value;
  }

  function writeSealed(value) {
    const store = storage();
    if (typeof store.saveBotSetting === "function") store.saveBotSetting(INSTALLATION_KEY, value);
    else if (typeof store.set === "function") store.set(INSTALLATION_KEY, value);
    else throw unreadable();
  }

  function importSealed(sealed) {
    const v = vault();
    if (typeof v.isSealed === "function" && !v.isSealed(sealed)) throw unreadable();
    let pkcs8;
    try {
      pkcs8 = v.open(sealed);
    } catch {
      throw unreadable();
    }
    if (typeof pkcs8 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(pkcs8)) throw unreadable();
    const der = Buffer.from(pkcs8, "base64");
    if (der.length === 0 || der.toString("base64") !== pkcs8) throw unreadable();
    try {
      const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      const raw = rawFromKeyObject(crypto.createPublicKey(privateKey));
      const installationId = crypto.createHash("sha256").update(raw).digest("base64url");
      return { privateKey, raw, installationId };
    } catch (error) {
      if (error?.code === "INSTALLATION_UNREADABLE") throw error;
      throw unreadable();
    }
  }

  function viewFrom(loaded) {
    return Object.freeze({
      installationId: loaded.installationId,
      publicKeyRaw: Buffer.from(loaded.raw),
      sign(bytes) {
        const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        return crypto.sign(null, data, loaded.privateKey);
      },
    });
  }

  function load() {
    const sealed = readSealed();
    if (sealed == null) {
      cache = null;
      return null;
    }
    if (cache && cache.sealed === sealed) return cache.view;
    const loaded = importSealed(sealed);
    const view = viewFrom(loaded);
    cache = { sealed, view };
    return view;
  }

  function getInstallation() {
    return load();
  }

  function getOrCreateInstallation() {
    if (readSealed() != null) return load();
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    writeSealed(vault().seal(pkcs8));
    return load();
  }

  return { getInstallation, getOrCreateInstallation };
}

function unreadable() {
  const error = new Error("installation key cannot be opened");
  error.code = "INSTALLATION_UNREADABLE";
  return error;
}

const defaults = createInstallation();

module.exports = {
  INSTALLATION_KEY,
  createInstallation,
  getInstallation: () => defaults.getInstallation(),
  getOrCreateInstallation: () => defaults.getOrCreateInstallation(),
};
