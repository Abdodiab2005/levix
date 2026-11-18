// Connected account profile service: cache, coalescing, identity, context
// guards and photo bytes. Every socket and image transport is a local fake;
// nothing here opens a network connection or a data directory.
import { equal, finish, ok, section } from "./harness.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAccountProfile } = require("../src/panel/account-profile.cjs");

const PHONE_ID = "201234567890@s.whatsapp.net";
const PHONE = "+201234567890";
const OTHER_ID = "201999999999@s.whatsapp.net";
const PHOTO_URL = "https://mmg.whatsapp.net/account.jpg";

function identity(overrides = {}) {
  return { phone: PHONE_ID, lid: null, selfJids: [PHONE_ID], ...overrides };
}

function fakeSocket({ id = PHONE_ID, name = "Levix Owner" } = {}) {
  const calls = { picture: 0, status: 0, pictureArgs: [], statusArgs: [] };
  const socket = {
    user: { id, name },
    async profilePictureUrl(jid, type, timeoutMs) {
      calls.picture += 1;
      calls.pictureArgs.push({ jid, type, timeoutMs });
      return PHOTO_URL;
    },
    async fetchStatus(jid) {
      calls.status += 1;
      calls.statusArgs.push(jid);
      return [{ id: jid, status: { status: "Building Levix", setAt: new Date() } }];
    },
  };
  return { socket, calls };
}

function response(body, mime = "image/jpeg", extraHeaders = {}) {
  return new Response(body, {
    headers: { "content-type": mime, ...extraHeaders },
  });
}

function makeService({ socket, state = { connected: true }, epoch = 0, id, options = {} } = {}) {
  let context = {
    socket,
    state,
    epoch,
    identity: id || identity(),
  };
  const clock = { value: 1_000 };
  let imageCalls = 0;
  const { fetchImage: providedFetchImage, ...restOptions } = options;
  const fetchImage =
    providedFetchImage ??
    (async () => {
      return response(Buffer.from("picture-bytes"));
    });
  const wrappedFetchImage = async (...args) => {
    imageCalls += 1;
    return fetchImage(...args);
  };
  const service = createAccountProfile({
    getContext: () => context,
    fetchImage: wrappedFetchImage,
    now: () => clock.value,
    timeoutMs: 40,
    ttlMs: 300_000,
    refreshCooldownMs: 10_000,
    maxPhotoBytes: 1024,
    ...restOptions,
  });
  return {
    service,
    clock,
    get imageCalls() {
      return imageCalls;
    },
    setContext(next) {
      context = { ...context, ...next };
    },
    setConnected(connected) {
      context = { ...context, state: { connected } };
    },
  };
}

try {
  section("own profile is cached and concurrent reads coalesce");
  {
    const { socket, calls } = fakeSocket();
    const harness = makeService({ socket });
    const first = await harness.service.get();
    equal("connected", first.connected, true);
    equal("display name", first.name, "Levix Owner");
    equal("phone uses a + prefix", first.phone, PHONE);
    equal("About comes from the nested rc14 status", first.about, "Building Levix");
    ok(
      "photo is exposed through a local revision URL",
      first.photoUrl.startsWith("/dashboard/api/account/photo?revision="),
    );
    ok("revision is opaque", typeof first.revision === "string" && first.revision.length > 10);
    equal("profile lookup used the PN", calls.pictureArgs[0].jid, PHONE_ID);
    equal("profile lookup asked for an image", calls.pictureArgs[0].type, "image");
    equal("profile lookup kept the 8s bound", calls.pictureArgs[0].timeoutMs, 8000);
    equal("status lookup used the own id", calls.statusArgs[0], PHONE_ID);

    const cached = await harness.service.get();
    equal("second read is served from cache", calls.picture, 1);
    equal("status lookup is cached too", calls.status, 1);
    equal("cached revision is stable", cached.revision, first.revision);
  }

  {
    let resolvePicture;
    let resolveStatus;
    const calls = { picture: 0, status: 0 };
    const socket = {
      user: { id: PHONE_ID, name: "Levix Owner" },
      profilePictureUrl() {
        calls.picture += 1;
        return new Promise((resolve) => {
          resolvePicture = resolve;
        });
      },
      fetchStatus() {
        calls.status += 1;
        return new Promise((resolve) => {
          resolveStatus = resolve;
        });
      },
    };
    const { service } = makeService({ socket });
    const a = service.get();
    const b = service.get();
    resolvePicture(PHOTO_URL);
    resolveStatus([{ id: PHONE_ID, status: { status: "About" } }]);
    const [one, two] = await Promise.all([a, b]);
    equal("concurrent reads share one picture lookup", calls.picture, 1);
    equal("concurrent reads share one status lookup", calls.status, 1);
    equal("both callers see the same profile", one.revision, two.revision);
  }

  section("missing, private and malicious status rows stay null");
  {
    const missing = fakeSocket();
    missing.socket.profilePictureUrl = async () => {
      missing.calls.picture++;
      throw new Error("private");
    };
    missing.socket.fetchStatus = async () => {
      missing.calls.status++;
      return [{ id: PHONE_ID, status: { status: null } }];
    };
    const harness = makeService({ socket: missing.socket });
    const profile = await harness.service.get();
    equal("private photo has no URL", profile.photoUrl, null);
    equal("private photo has no revision", profile.revision, null);
    equal("empty About stays null", profile.about, null);
    await harness.service.get();
    equal("negative metadata is cached", missing.calls.picture, 1);
    equal("negative status is cached", missing.calls.status, 1);

    const unrelated = fakeSocket();
    unrelated.socket.fetchStatus = async () => [
      { id: OTHER_ID, status: { status: "Another account's About" } },
    ];
    const second = await makeService({ socket: unrelated.socket }).service.get();
    equal("a row for another JID is not this account's About", second.about, null);

    unrelated.socket.fetchStatus = async () => [{ id: PHONE_ID, status: { status: "Great" } }];
    const good = await makeService({ socket: unrelated.socket }).service.get();
    equal("a matching row is accepted", good.about, "Great");
    unrelated.socket.fetchStatus = async () => [{ id: PHONE_ID, status: { status: 42 } }];
    const notString = await makeService({ socket: unrelated.socket }).service.get();
    equal("non-string About is ignored", notString.about, null);
  }

  section("name and About are bounded");
  {
    const { socket } = fakeSocket({ name: "N".repeat(300) });
    socket.fetchStatus = async () => [{ id: PHONE_ID, status: { status: "A".repeat(5000) } }];
    const profile = await makeService({ socket }).service.get();
    equal("name is bounded to 256", profile.name.length, 256);
    equal("About is bounded to 2048", profile.about.length, 2048);
  }

  section("phone identity is a PN, never a LID or a typed fallback");
  {
    const lidId = "987654321098765@lid";
    const lidSocket = { user: { id: lidId, name: "Lid owner" } };
    lidSocket.profilePictureUrl = async () => null;
    lidSocket.fetchStatus = async () => [{ id: lidId, status: { status: "LID About" } }];
    const linked = identity({ lid: lidId, selfJids: [PHONE_ID, lidId] });
    const profile = await makeService({ socket: lidSocket, id: linked }).service.get();
    equal("verified pairing supplies the phone for a LID socket", profile.phone, PHONE);
    equal("About still uses the LID self id", profile.about, "LID About");

    const stale = identity({ lid: lidId, selfJids: [PHONE_ID] });
    const staleProfile = await makeService({ socket: lidSocket, id: stale }).service.get();
    equal("stale credentials do not supply a phone", staleProfile.phone, null);
    ok(
      "no LID ever became a phone",
      staleProfile.phone !== lidId && staleProfile.phone !== "+987654321098765",
    );

    let queriedId = null;
    const deviceSocket = {
      user: { id: "201234567890:12@s.whatsapp.net", name: "Device" },
      async profilePictureUrl(id) {
        queriedId = id;
        return null;
      },
      async fetchStatus() {
        return [];
      },
    };
    const device = await makeService({ socket: deviceSocket }).service.get();
    equal("device suffix is normalized before the lookup", queriedId, PHONE_ID);
    equal("device suffix is normalized in the phone", device.phone, PHONE);
  }

  section("offline never queries and closes the cache");
  {
    const { socket, calls } = fakeSocket();
    const harness = makeService({ socket, state: { connected: false } });
    const profile = await harness.service.get();
    equal("offline profile is disconnected", profile.connected, false);
    equal("offline has no name", profile.name, null);
    equal("offline has no phone", profile.phone, null);
    equal("offline has no About", profile.about, null);
    equal("offline has no photo", profile.photoUrl, null);
    equal("offline never queried the picture", calls.picture, 0);
    equal("offline never queried the status", calls.status, 0);
    equal("offline photo token is useless", await harness.service.photo("anything"), null);
    equal("offline photo token triggers no image fetch", harness.imageCalls, 0);
  }

  section("disconnect and epoch changes discard in-flight results");
  {
    const { socket, calls } = fakeSocket();
    let resolvePicture;
    socket.profilePictureUrl = () => {
      calls.picture += 1;
      return new Promise((resolve) => {
        resolvePicture = resolve;
      });
    };
    const harness = makeService({ socket });
    const pending = harness.service.get();
    harness.setConnected(false);
    resolvePicture(PHOTO_URL);
    const profile = await pending;
    equal("late lookup after disconnect reports disconnected", profile.connected, false);
    equal("late lookup leaks no About", profile.about, null);
    equal("late lookup leaks no photo", profile.photoUrl, null);

    const again = await harness.service.get();
    equal("disconnected reads stay network-free", calls.picture, 1);
    equal("disconnected result is still empty", again.name, null);
  }

  {
    const { socket, calls } = fakeSocket();
    let resolvePicture;
    socket.profilePictureUrl = () => {
      calls.picture += 1;
      return new Promise((resolve) => {
        resolvePicture = resolve;
      });
    };
    const harness = makeService({ socket });
    const pending = harness.service.get();
    harness.setContext({ epoch: 7 });
    resolvePicture(PHOTO_URL);
    const discarded = await pending;
    equal("epoch change drops the previous About", discarded.about, null);
    equal("epoch change drops the previous photo", discarded.photoUrl, null);
    await harness.service.get();
    equal("new epoch performs its own lookup", calls.picture, 2);
  }

  {
    const first = fakeSocket();
    const second = fakeSocket({ id: OTHER_ID, name: "Next account" });
    let resolvePicture;
    first.socket.profilePictureUrl = () => {
      first.calls.picture += 1;
      return new Promise((resolve) => {
        resolvePicture = resolve;
      });
    };
    const harness = makeService({ socket: first.socket, id: identity() });
    const pending = harness.service.get();
    harness.setContext({
      socket: second.socket,
      identity: { phone: OTHER_ID, lid: null, selfJids: [OTHER_ID] },
    });
    resolvePicture(PHOTO_URL);
    const discarded = await pending;
    equal("superseded response does not borrow the new account name", discarded.name, null);
    equal("superseded response does not borrow the new account phone", discarded.phone, null);
    equal("switched socket has no previous About", discarded.about, null);
    await harness.service.get();
    equal("new socket performs its own lookup", second.calls.picture, 1);
    equal("previous socket is not queried again", first.calls.picture, 1);
  }

  section("refresh cooldown and coalescing");
  {
    const { socket, calls } = fakeSocket();
    const harness = makeService({ socket });
    const first = await harness.service.get();
    harness.clock.value += 1_000;
    const cooled = await harness.service.refresh();
    equal("refresh within ten seconds uses the cache", calls.picture, 1);
    equal("cooldown returns the cached revision", cooled.revision, first.revision);
    ok("cooldown reports remaining time", cooled.refreshAfterMs > 0);

    harness.clock.value += 10_000;
    const refreshed = await harness.service.refresh();
    equal("refresh after the cooldown queries again", calls.picture, 2);
    ok("refresh rotates the opaque revision", refreshed.revision !== first.revision);
  }

  {
    const { socket, calls } = fakeSocket();
    const harness = makeService({ socket });
    await harness.service.get();
    harness.clock.value += 10_001;

    let resolvePicture;
    let resolveStatus;
    socket.profilePictureUrl = () => {
      calls.picture += 1;
      return new Promise((resolve) => {
        resolvePicture = resolve;
      });
    };
    socket.fetchStatus = () => {
      calls.status += 1;
      return new Promise((resolve) => {
        resolveStatus = resolve;
      });
    };
    const one = harness.service.refresh();
    const two = harness.service.refresh();
    resolvePicture(PHOTO_URL);
    resolveStatus([{ id: PHONE_ID, status: { status: "About" } }]);
    const [a, b] = await Promise.all([one, two]);
    equal("repeated refreshes share one picture request", calls.picture, 2);
    equal("repeated refreshes share one status request", calls.status, 2);
    equal("repeated refreshes see the same result", a.revision, b.revision);
  }

  section("metadata lookup is bounded even when promises ignore the signal");
  {
    const calls = { picture: 0, status: 0 };
    const socket = {
      user: { id: PHONE_ID, name: "Slow" },
      profilePictureUrl() {
        calls.picture += 1;
        return new Promise(() => {});
      },
      fetchStatus() {
        calls.status += 1;
        return new Promise(() => {});
      },
    };
    const harness = makeService({ socket, options: { timeoutMs: 30 } });
    const profile = await harness.service.get();
    equal("timeout still reports connected", profile.connected, true);
    equal("timeout leaves About null", profile.about, null);
    equal("timeout leaves the photo null", profile.photoUrl, null);
    await harness.service.get();
    equal("timed-out lookup is cached instead of spamming", calls.picture, 1);
  }

  section("photo bytes are lazy, revision-scoped and cached");
  {
    const { socket, calls } = fakeSocket();
    const harness = makeService({ socket });
    const profile = await harness.service.get();
    equal("photo is not fetched by the metadata read", harness.imageCalls, 0);

    const bytes = await harness.service.photo("unknown-revision");
    equal("unknown revision is refused", bytes, null);
    equal("unknown revision performs no fetch", harness.imageCalls, 0);

    const [one, two] = await Promise.all([
      harness.service.photo(profile.revision),
      harness.service.photo(profile.revision),
    ]);
    equal("concurrent image reads coalesce", harness.imageCalls, 1);
    equal("image MIME is returned", one.mime, "image/jpeg");
    equal("image bytes survive", one.bytes.toString(), "picture-bytes");
    equal("second reader gets the same image", two.bytes.toString(), "picture-bytes");

    await harness.service.photo(profile.revision);
    equal("valid image is cached", harness.imageCalls, 1);
    equal("metadata lookup is never triggered by a photo", calls.picture, 1);
  }

  {
    const { socket } = fakeSocket();
    let fail = true;
    const fetchImage = async () => {
      if (fail) throw new Error("network");
      return response(Buffer.from("ok"));
    };
    const harness = makeService({ socket, options: { fetchImage } });
    const profile = await harness.service.get();
    equal("failed image is null", await harness.service.photo(profile.revision), null);
    equal("failed image is attempted once", harness.imageCalls, 1);
    fail = false;
    equal("negative image result is cached", await harness.service.photo(profile.revision), null);
    equal("negative image result avoids a second fetch", harness.imageCalls, 1);
  }

  section("photo limits: MIME, content-length, stream size and timeout");
  {
    const cases = [
      ["SVG is refused", "image/svg+xml", Buffer.from("<svg/>"), {}, null],
      ["HTML is refused", "text/html", Buffer.from("<html/>"), {}, null],
      ["PNG is accepted", "image/png", Buffer.from("png-bytes"), {}, "image/png"],
      ["WebP is accepted", "image/webp", Buffer.from("webp-bytes"), {}, "image/webp"],
    ];
    for (const [label, mime, body, headers, expected] of cases) {
      const { socket } = fakeSocket();
      const harness = makeService({
        socket,
        options: { fetchImage: async () => response(body, mime, headers) },
      });
      const profile = await harness.service.get();
      const picture = await harness.service.photo(profile.revision);
      equal(label, picture?.mime ?? null, expected);
    }

    {
      const { socket } = fakeSocket();
      const harness = makeService({
        socket,
        options: {
          maxPhotoBytes: 8,
          fetchImage: async () =>
            response(Buffer.from("abc"), "image/png", { "content-length": "9999" }),
        },
      });
      const profile = await harness.service.get();
      equal(
        "declared oversize body is refused before reading",
        await harness.service.photo(profile.revision),
        null,
      );
    }

    {
      const { socket } = fakeSocket();
      const harness = makeService({
        socket,
        options: {
          maxPhotoBytes: 8,
          fetchImage: async () => response(Buffer.alloc(20), "image/png"),
        },
      });
      const profile = await harness.service.get();
      equal(
        "streamed oversize body is refused",
        await harness.service.photo(profile.revision),
        null,
      );
    }

    {
      const { socket } = fakeSocket();
      const harness = makeService({
        socket,
        options: { timeoutMs: 25, fetchImage: async () => new Promise(() => {}) },
      });
      const profile = await harness.service.get();
      const started = Date.now();
      equal(
        "hanging image fetch returns null",
        await harness.service.photo(profile.revision),
        null,
      );
      ok("hanging image fetch is bounded", Date.now() - started < 1_000);
    }
  }

  section("a context change during image bytes discards the image");
  {
    const { socket } = fakeSocket();
    let streamController;
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    });
    const harness = makeService({
      socket,
      options: {
        fetchImage: async () => new Response(body, { headers: { "content-type": "image/png" } }),
      },
    });
    const profile = await harness.service.get();
    const pending = harness.service.photo(profile.revision);
    await new Promise((resolve) => setTimeout(resolve, 5));
    streamController.enqueue(new Uint8Array([1, 2, 3]));
    harness.setConnected(false);
    streamController.close();
    equal("image finished after disconnect is discarded", await pending, null);
    equal(
      "discarded image is not cached for the next account",
      await harness.service.photo(profile.revision),
      null,
    );
  }

  section("refresh invalidates old photo revisions");
  {
    const { socket } = fakeSocket();
    const harness = makeService({ socket });
    const first = await harness.service.get();
    harness.clock.value += 10_001;
    const second = await harness.service.refresh();
    ok("refresh rotates the revision", second.revision !== first.revision);
    equal(
      "old photo revision is refused without a fetch",
      await harness.service.photo(first.revision),
      null,
    );
    equal("refused old revision performed no fetch", harness.imageCalls, 0);
    equal(
      "new revision still works",
      (await harness.service.photo(second.revision)).mime,
      "image/jpeg",
    );
  }

  section("review regressions: exact identities and verified aliases");
  for (const id of [
    "123@s.whatsapp.net.evil",
    "123:4@lid.evil",
    "123@lid.evil",
    "name@s.whatsapp.net",
    "123@s.whatsapp.net@lid",
  ]) {
    const { socket, calls } = fakeSocket({ id });
    const harness = makeService({ socket });
    const profile = await harness.service.get();
    equal("invalid own id has no phone " + id, profile.phone, null);
    equal("invalid own id performs no lookup " + id, calls.picture, 0);
    equal("invalid own id performs no status query " + id, calls.status, 0);
  }
  {
    const lid = "987654321098765@lid";
    const { socket } = fakeSocket({ id: lid });
    socket.fetchStatus = async () => [{ id: PHONE_ID, status: { status: "Verified alias About" } }];
    const harness = makeService({ socket, id: identity({ lid, selfJids: [PHONE_ID, lid] }) });
    equal(
      "verified PN alias of own LID is accepted",
      (await harness.service.get()).about,
      "Verified alias About",
    );
  }
  {
    const { socket, calls } = fakeSocket();
    const harness = makeService({ socket });
    await harness.service.get();
    socket.user.name = "New local name";
    equal(
      "name change needs no remote lookup",
      (await harness.service.get()).name,
      "New local name",
    );
    equal("local name change preserves query cache", calls.picture, 1);
  }
  section("review regressions: all negative image outcomes cache and cleanup stays bounded");
  for (const [label, fetchImage] of [
    [
      "HTTP failure",
      async () =>
        new Response("private", { status: 404, headers: { "content-type": "image/png" } }),
    ],
    ["MIME failure", async () => response("<svg/>", "image/svg+xml")],
    ["empty body", async () => response(new Uint8Array(), "image/png")],
    ["size header", async () => response("x", "image/png", { "content-length": "99999" })],
    [
      "hung body and cancellation",
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
            cancel() {
              return new Promise(() => {});
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    ],
  ]) {
    const { socket } = fakeSocket();
    const harness = makeService({ socket, options: { timeoutMs: 25, fetchImage } });
    const profile = await harness.service.get();
    const started = Date.now();
    equal(label + " returns null", await harness.service.photo(profile.revision), null);
    ok(label + " stays bounded", Date.now() - started < 500);
    equal(label + " repeats null", await harness.service.photo(profile.revision), null);
    equal(label + " fetches only once", harness.imageCalls, 1);
  }

  section("reset clears every cached profile and image");
  {
    const { socket } = fakeSocket();
    const harness = makeService({ socket });
    const profile = await harness.service.get();
    await harness.service.photo(profile.revision);
    harness.service.reset();
    equal(
      "reset makes the old revision invalid",
      await harness.service.photo(profile.revision),
      null,
    );
    equal("reset did not fetch the old image", harness.imageCalls, 1);
    const next = await harness.service.get();
    ok("a fresh lookup follows reset", next.revision !== profile.revision);
  }
} catch (error) {
  ok("account profile unit tests run", false, error?.stack || String(error));
} finally {
  finish();
}
