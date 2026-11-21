// Connected WhatsApp account profile.
//
// Everything here is memory-only and scoped to the live socket: the account's
// own name, verified phone number, About text and profile picture. The panel
// never sees a remote image URL (Android's privileged WebView blocks remote
// resources), so a photo is described by an opaque revision and bytes are read
// lazily through an authenticated route.
//
// The identity rules mirror src/messaging/identity.cjs and
// src/utils/normalizeJid.cjs: a phone number only ever comes from a
// `@s.whatsapp.net` JID, never from a LID and never from a typed setting. The
// current socket is authoritative; the verified pairing credentials are only a
// fallback, and only while they still describe the socket we are reading.
//
// A result is written to the cache only while the socket reference, the
// normalized self identity, the account epoch and connectivity all still match
// the context the lookup started in. Disconnect, reconnect or unlink therefore
// discards in-flight work instead of handing it to the next account.

const crypto = require("node:crypto");
const normalizeJid = require("../utils/normalizeJid.cjs");

const PICTURE_TIMEOUT_MS = 8000;
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// Validate the complete address before the shared device-suffix normalization.
function ownJid(value) {
  if (typeof value !== "string" || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(value))
    return null;
  return normalizeJid(value);
}
function isPhoneJid(value) {
  return ownJid(value)?.endsWith("@s.whatsapp.net") === true;
}
function isLidJid(value) {
  return ownJid(value)?.endsWith("@lid") === true;
}

function boundedText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function cleanProfileName(value) {
  const text = boundedText(value, 256);
  if (!text || text === "~") return null;
  if (/^[^\s@]+@(?:s\.whatsapp\.net|c\.us|lid|g\.us|broadcast|newsletter)$/i.test(text))
    return null;
  return text;
}

/** Digits of a phone-number JID, or null. A LID can never become a phone. */
function phoneFromPnJid(jid) {
  const normalized = ownJid(jid);
  return normalized?.endsWith("@s.whatsapp.net") ? `+${normalized.split("@")[0]}` : null;
}

/**
 * @param {object} options
 * @param {() => {socket?: object|null, state?: object, epoch?: number, identity?: object, creds?: object, storedName?: string|null, getUserDisplayName?: (jid: string) => string|null}} options.getContext
 * @param {(jid: string) => string|null} [options.getUserDisplayName]
 * @param {(socket: object, url: string, init: object) => Promise<object>} [options.fetchImage]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.ttlMs]
 * @param {number} [options.refreshCooldownMs]
 * @param {number} [options.maxPhotoBytes]
 */
function createAccountProfile({
  getContext,
  getUserDisplayName = null,
  fetchImage = null,
  now = Date.now,
  timeoutMs = 8000,
  ttlMs = 300_000,
  refreshCooldownMs = 10_000,
  maxPhotoBytes = 1024 * 1024,
} = {}) {
  if (typeof getContext !== "function") throw new TypeError("getContext is required");

  let generation = 0;
  let metadata = null; // { snapshot, revision, name, phone, about, photoInternal, expiresAt }
  let metadataInFlight = null; // { snapshot, promise }
  let image = null; // { snapshot, revision, expiresAt, negative, bytes?, mime? }
  let imageInFlight = null; // { snapshot, revision, promise }
  let lastLookupAt = null;
  const controllers = new Set();

  function resolveCredsName(raw, identity, acceptedIds, matchesIdentity) {
    const credsMe = raw?.creds?.me;
    if (credsMe && typeof credsMe === "object") {
      const credId = ownJid(credsMe.id);
      const credLid = ownJid(credsMe.lid);
      const hasCredIds = Boolean(credId || credLid);
      const credMatches = hasCredIds
        ? (credId && acceptedIds.includes(credId)) || (credLid && acceptedIds.includes(credLid))
        : matchesIdentity;
      if (credMatches) {
        const fromCreds = cleanProfileName(credsMe.name);
        if (fromCreds) return fromCreds;
      }
    }
    if (matchesIdentity) {
      return cleanProfileName(identity?.name ?? identity?.me?.name);
    }
    return null;
  }

  function resolveCanonicalOwnerJid({ socket, identity, selfId, selfLid, matchesIdentity }) {
    if (selfId && isPhoneJid(selfId)) return selfId;
    if (matchesIdentity && isPhoneJid(identity?.phone)) return ownJid(identity.phone);
    if (selfLid && isLidJid(selfLid)) return selfLid;
    if (selfId && isLidJid(selfId)) return selfId;
    if (matchesIdentity && isLidJid(identity?.lid)) return ownJid(identity.lid);
    return selfId || selfLid || null;
  }

  function resolveStoredDisplayName(
    raw,
    identity,
    acceptedIds,
    matchesIdentity,
    canonicalJid = null,
  ) {
    const lookupFn =
      typeof raw?.getUserDisplayName === "function"
        ? raw.getUserDisplayName
        : typeof getUserDisplayName === "function"
          ? getUserDisplayName
          : null;
    const ids = canonicalJid
      ? [canonicalJid, ...acceptedIds.filter((jid) => jid !== canonicalJid)]
      : acceptedIds;
    if (lookupFn) {
      for (const jid of ids) {
        try {
          const candidate = cleanProfileName(lookupFn(jid));
          if (candidate) return candidate;
        } catch {}
      }
    }
    if (raw?.userMetadata && typeof raw.userMetadata === "object") {
      for (const jid of ids) {
        const entry = raw.userMetadata[jid];
        const candidate = cleanProfileName(typeof entry === "string" ? entry : entry?.displayName);
        if (candidate) return candidate;
      }
    }
    if (matchesIdentity) {
      return cleanProfileName(raw?.storedName ?? identity?.displayName);
    }
    return null;
  }

  function readContext() {
    let raw = null;
    try {
      raw = getContext();
    } catch {
      raw = null;
    }
    const socket = raw?.socket && typeof raw.socket === "object" ? raw.socket : null;
    const state = raw?.state && typeof raw.state === "object" ? raw.state : {};
    const identity = raw?.identity && typeof raw.identity === "object" ? raw.identity : {};
    const selfJids = Array.isArray(identity.selfJids)
      ? [...new Set(identity.selfJids.map(ownJid).filter(Boolean))].sort()
      : [];
    const selfId = ownJid(socket?.user?.id);
    const selfLid = ownJid(socket?.user?.lid);
    const connected = Boolean(socket && state.connected);
    const matchesIdentity = Boolean(
      selfId && (selfJids.includes(selfId) || (selfLid && selfJids.includes(selfLid))),
    );
    const canonicalJid = resolveCanonicalOwnerJid({
      socket,
      identity,
      selfId,
      selfLid,
      matchesIdentity,
    });
    const socketIds = [selfId, selfLid].filter(Boolean);
    const rawAcceptedIds = matchesIdentity
      ? [...new Set([...selfJids, ...socketIds])]
      : [...new Set(socketIds)];
    const acceptedIds = canonicalJid
      ? [canonicalJid, ...rawAcceptedIds.filter((id) => id !== canonicalJid)]
      : rawAcceptedIds;

    let phone = null;
    if (selfId && isPhoneJid(selfId)) {
      phone = phoneFromPnJid(selfId);
    } else if (matchesIdentity && isPhoneJid(identity.phone)) {
      // Only while the verified pairing still names this socket's LID.
      phone = phoneFromPnJid(identity.phone);
    }

    // Other verified form (PN vs LID) for photo retry when selfId has no photo.
    let altSelfId = null;
    if (selfId && matchesIdentity) {
      if (isLidJid(selfId) && isPhoneJid(identity.phone)) {
        altSelfId = ownJid(identity.phone);
      } else if (isPhoneJid(selfId)) {
        const verifiedLid = ownJid(identity.lid) || (isLidJid(selfLid) ? selfLid : null);
        if (verifiedLid && isLidJid(verifiedLid)) altSelfId = verifiedLid;
      }
    }

    // Preferred: trusted stored owner display name in user_metadata (written once on
    // connection open or via live notify messages, avoiding Baileys replay mutations).
    // Fallback chain:
    // 1. linked account's own display name in user_metadata
    // 2. sock.user.name (fallback on fresh install before metadata write)
    // 3. sock.user.verifiedName
    // 4. sock.user.notify
    // 5. saved credentials' me.name
    const name = selfId
      ? cleanProfileName(
          resolveStoredDisplayName(raw, identity, acceptedIds, matchesIdentity, canonicalJid),
        ) ||
        cleanProfileName(socket?.user?.name) ||
        cleanProfileName(socket?.user?.verifiedName) ||
        cleanProfileName(socket?.user?.notify) ||
        cleanProfileName(resolveCredsName(raw, identity, acceptedIds, matchesIdentity)) ||
        null
      : null;

    return {
      generation,
      socket,
      connected,
      epoch: raw?.epoch ?? null,
      selfId,
      altSelfId,
      name,
      phone,
      selfJidsKey: selfJids.join("|"),
      acceptedIds,
    };
  }

  function sameContext(a, b) {
    if (!a || !b) return false;
    return (
      a.generation === b.generation &&
      a.socket === b.socket &&
      a.epoch === b.epoch &&
      a.selfId === b.selfId &&
      a.phone === b.phone &&
      a.selfJidsKey === b.selfJidsKey &&
      a.connected === b.connected
    );
  }

  function abortImages() {
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {}
    }
    controllers.clear();
  }

  function resetCache({ abort = true } = {}) {
    metadata = null;
    lastLookupAt = null;
    metadataInFlight = null;
    image = null;
    imageInFlight = null;
    if (abort) abortImages();
  }

  function discardStale(snapshot) {
    if (metadata && !sameContext(metadata.snapshot, snapshot)) {
      metadata = null;
      image = null;
    }
    if (image && !sameContext(image.snapshot, snapshot)) image = null;
    if (metadataInFlight && !sameContext(metadataInFlight.snapshot, snapshot)) {
      metadataInFlight = null;
    }
    if (imageInFlight && !sameContext(imageInFlight.snapshot, snapshot)) {
      imageInFlight = null;
      abortImages();
    }
  }

  function refreshAfterMs() {
    if (lastLookupAt === null) return 0;
    const remaining = refreshCooldownMs - (now() - lastLookupAt);
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  function emptyProfile(snapshot) {
    return {
      connected: Boolean(snapshot?.connected),
      name: null,
      phone: null,
      about: null,
      photoUrl: null,
      revision: null,
      refreshAfterMs: refreshAfterMs(),
    };
  }

  function localProfile(snapshot) {
    if (!snapshot?.connected) return emptyProfile(snapshot);
    return {
      connected: true,
      name: cleanProfileName(snapshot.name) ?? null,
      phone: snapshot.phone ?? null,
      about: null,
      photoUrl: null,
      revision: null,
      refreshAfterMs: refreshAfterMs(),
    };
  }

  function view(entry, snapshot) {
    const hasPhoto = Boolean(entry.photoInternal);
    return {
      connected: Boolean(snapshot.connected),
      name: cleanProfileName(snapshot.name) ?? null,
      phone: snapshot.phone ?? null,
      about: entry.about ?? null,
      photoUrl: hasPhoto
        ? `/dashboard/api/account/photo?revision=${encodeURIComponent(entry.revision)}`
        : null,
      revision: hasPhoto ? entry.revision : null,
      refreshAfterMs: refreshAfterMs(),
    };
  }

  /** Resolve within `ms` even when the wrapped promise ignores its signal. */
  function settleWithin(value, ms) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      timer = setTimeout(() => finish({ status: "timeout" }), Math.max(0, ms));
      Promise.resolve(value).then(
        (result) => finish({ status: "fulfilled", value: result }),
        (error) => finish({ status: "rejected", reason: error }),
      );
    });
  }

  function callWithin(socket, method, args) {
    if (!socket || typeof socket[method] !== "function") {
      return Promise.resolve({ status: "fulfilled", value: null });
    }
    let call;
    try {
      call = socket[method](...args);
    } catch (error) {
      return Promise.resolve({ status: "rejected", reason: error });
    }
    return settleWithin(call, timeoutMs);
  }

  function statusAbout(value, snapshot) {
    if (!Array.isArray(value)) return null;
    const row = value.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        typeof candidate.id === "string" &&
        snapshot.acceptedIds.includes(ownJid(candidate.id)),
    );
    // rc14: { id, status: { status: string|null, setAt: Date } }. A row for
    // any other JID is ignored instead of being shown as this account's About.
    const status = row?.status;
    return boundedText(status && typeof status === "object" ? status.status : null, 2048);
  }

  async function lookupPhotoUrl(snapshot) {
    const first = await callWithin(snapshot.socket, "profilePictureUrl", [
      snapshot.selfId,
      "image",
      PICTURE_TIMEOUT_MS,
    ]);
    if (first.status === "fulfilled" && typeof first.value === "string" && first.value.trim()) {
      return first.value.trim();
    }
    if (!snapshot.altSelfId || snapshot.altSelfId === snapshot.selfId) return null;
    const current = readContext();
    if (!sameContext(snapshot, current) || !current.connected) return null;
    const second = await callWithin(snapshot.socket, "profilePictureUrl", [
      snapshot.altSelfId,
      "image",
      PICTURE_TIMEOUT_MS,
    ]);
    return second.status === "fulfilled" && typeof second.value === "string" && second.value.trim()
      ? second.value.trim()
      : null;
  }

  async function lookup(snapshot) {
    const [photoInternal, status] = await Promise.all([
      lookupPhotoUrl(snapshot),
      callWithin(snapshot.socket, "fetchStatus", [snapshot.selfId]),
    ]);

    const about = status.status === "fulfilled" ? statusAbout(status.value, snapshot) : null;

    const current = readContext();
    if (!sameContext(snapshot, current) || !current.connected) {
      return emptyProfile(current);
    }

    const entry = {
      snapshot,
      revision: crypto.randomUUID(),
      name: current.name,
      phone: current.phone,
      about,
      photoInternal,
      expiresAt: now() + ttlMs,
    };
    metadata = entry;
    if (image && (image.revision !== entry.revision || !sameContext(image.snapshot, current))) {
      image = null;
    }
    return view(entry, current);
  }

  function startLookup(snapshot) {
    lastLookupAt = now();
    const promise = lookup(snapshot);
    const flight = { snapshot, promise };
    metadataInFlight = flight;
    promise
      .finally(() => {
        if (metadataInFlight === flight) metadataInFlight = null;
      })
      .catch(() => {});
    return promise;
  }

  async function get() {
    const snapshot = readContext();
    if (!snapshot.connected || !snapshot.selfId) {
      resetCache({ abort: true });
      return localProfile(snapshot);
    }
    discardStale(snapshot);

    if (metadata && sameContext(metadata.snapshot, snapshot) && now() < metadata.expiresAt) {
      return view(metadata, snapshot);
    }
    if (metadataInFlight && sameContext(metadataInFlight.snapshot, snapshot)) {
      return metadataInFlight.promise;
    }
    return startLookup(snapshot);
  }

  async function refresh() {
    const snapshot = readContext();
    if (!snapshot.connected || !snapshot.selfId) {
      resetCache({ abort: true });
      return localProfile(snapshot);
    }
    discardStale(snapshot);

    if (metadataInFlight && sameContext(metadataInFlight.snapshot, snapshot)) {
      return metadataInFlight.promise;
    }
    if (lastLookupAt !== null && now() - lastLookupAt < refreshCooldownMs) {
      return metadata && sameContext(metadata.snapshot, snapshot) && now() < metadata.expiresAt
        ? view(metadata, snapshot)
        : localProfile(snapshot);
    }
    return startLookup(snapshot);
  }

  function mimeOf(response) {
    const raw = response?.headers?.get?.("content-type");
    if (typeof raw !== "string") return null;
    const mime = raw.split(";")[0].trim().toLowerCase();
    return ALLOWED_IMAGE_MIME.has(mime) ? mime : null;
  }

  async function loadImage(snapshot, revision, url, expiresAt) {
    const controller = new AbortController();
    controllers.add(controller);
    let reader = null;
    let response = null;
    let timer;
    let value = null;
    const cancel = () => {
      controller.abort();
      try {
        reader?.cancel().catch(() => {});
      } catch {}
      try {
        reader?.releaseLock();
      } catch {}
      try {
        if (response?.body && !response.body.locked) response.body.cancel().catch(() => {});
      } catch {}
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        cancel();
        reject(new Error("Account photo timed out"));
      }, timeoutMs);
    });
    const read = async () => {
      if (!sameContext(snapshot, readContext())) throw new Error("Stale account");
      response = await fetchImage(snapshot.socket, url, { signal: controller.signal });
      if (controller.signal.aborted) {
        cancel();
        throw new Error("Cancelled");
      }
      if (!sameContext(snapshot, readContext())) throw new Error("Stale account");
      const mime = mimeOf(response);
      if (!response.ok || !mime) throw new Error("Unavailable account photo");
      const declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxPhotoBytes)) {
        throw new Error("Account photo exceeds size limit");
      }
      if (!response.body?.getReader) throw new Error("Missing photo stream");
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value: chunk } = await reader.read();
        if (done) break;
        total += chunk.byteLength;
        if (total > maxPhotoBytes) throw new Error("Account photo exceeds size limit");
        chunks.push(chunk);
      }
      if (!total) throw new Error("Empty photo");
      return { bytes: Buffer.concat(chunks, total), mime };
    };
    try {
      value = await Promise.race([read(), deadline]);
    } catch {
      value = null;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      // Cleanup is best effort and must never extend the request deadline.
      cancel();
    }
    const current = readContext();
    if (
      !sameContext(snapshot, current) ||
      !current.connected ||
      !metadata ||
      metadata.revision !== revision ||
      now() >= expiresAt
    )
      return null;
    // All failures, including HTTP/MIME/size/empty-body/timeout, share this
    // negative cache. Repeated image requests never refetch the same failure.
    image = { snapshot, revision, expiresAt, negative: !value, ...value };
    return value;
  }

  async function photo(revision) {
    if (typeof revision !== "string" || !revision) return null;

    const snapshot = readContext();
    if (!snapshot.connected || !snapshot.selfId) {
      resetCache({ abort: true });
      return null;
    }
    discardStale(snapshot);

    if (
      !metadata ||
      !sameContext(metadata.snapshot, snapshot) ||
      metadata.revision !== revision ||
      !metadata.photoInternal ||
      now() >= metadata.expiresAt
    ) {
      return null;
    }

    if (
      image &&
      sameContext(image.snapshot, snapshot) &&
      image.revision === revision &&
      now() < image.expiresAt
    ) {
      return image.negative ? null : { bytes: image.bytes, mime: image.mime };
    }
    if (
      imageInFlight &&
      sameContext(imageInFlight.snapshot, snapshot) &&
      imageInFlight.revision === revision
    ) {
      return imageInFlight.promise;
    }

    const expiresAt = metadata.expiresAt;
    const url = metadata.photoInternal;
    if (!fetchImage) {
      image = { snapshot, revision, expiresAt, negative: true };
      return null;
    }

    const promise = loadImage(snapshot, revision, url, expiresAt);
    const flight = { snapshot, revision, promise };
    imageInFlight = flight;
    promise
      .finally(() => {
        if (imageInFlight === flight) imageInFlight = null;
      })
      .catch(() => {});
    return promise;
  }

  function reset() {
    generation += 1;
    lastLookupAt = null;
    resetCache({ abort: true });
  }

  return { get, refresh, photo, reset };
}

module.exports = { createAccountProfile };
