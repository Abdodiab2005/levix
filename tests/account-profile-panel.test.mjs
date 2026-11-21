// Real authenticated dashboard routes for the connected account card. The
// WhatsApp socket and the image transport are fakes; nothing leaves the process
// and no production endpoint or account is touched.
import {
  equal,
  finish,
  httpClient,
  listen,
  ok,
  require,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-account-profile-panel");
const store = require("./src/db/store.cjs");
const { default: routes, setSession } = await import("../src/routes/dashboard.api.esm.js");
const { app, server, io, dashboardJson, requireLoginApi, noStore, installFinalHandlers } =
  require("./app.cjs");
app.use("/dashboard/api", requireLoginApi, noStore, dashboardJson, routes);
installFinalHandlers();
const { base } = await listen(server);
const http = httpClient(base);
const provider = require("./src/utils/providerUrl.cjs");
const originalFetch = provider.safeProviderFetch;

const PHONE_ID = "201234567890@s.whatsapp.net";
const PHOTO_URL = "https://mmg.whatsapp.net/account.jpg";

let pictureCalls = 0;
let statusCalls = 0;
let imageFetches = 0;
let aboutText = "Building Levix";
let pictureUrl = PHOTO_URL;
let imageMime = "image/jpeg";
let imageBytes = Buffer.from("account-photo-bytes");

function fakeSocket({ id = PHONE_ID, name = "Levix Owner" } = {}) {
  return {
    user: { id, name },
    async profilePictureUrl(jid, type) {
      pictureCalls += 1;
      equal("profile lookup targets only the own id", jid, id);
      equal("profile lookup asks for an image", type, "image");
      return pictureUrl;
    },
    async fetchStatus(jid) {
      statusCalls += 1;
      equal("status lookup targets only the own id", jid, id);
      return [{ id, status: { status: aboutText, setAt: new Date() } }];
    },
  };
}

const connectedSession = (socket) => ({
  socket,
  getState: () => ({ state: "connected", connected: true }),
});

try {
  equal(
    "account profile requires the panel session",
    (await httpClient(base).call("/dashboard/api/account/profile")).status,
    401,
  );
  equal(
    "account photo requires the panel session",
    (await httpClient(base).call("/dashboard/api/account/photo?revision=anything")).status,
    401,
  );

  let res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("claiming the panel signs in", res.status, 303);

  provider.safeProviderFetch = async () => {
    imageFetches += 1;
    return new Response(imageBytes, { headers: { "content-type": imageMime } });
  };

  section("connected account profile is authenticated, cached and rendered");
  setSession(connectedSession(fakeSocket()));
  res = await http.call("/dashboard/api/account/profile");
  equal("profile route succeeds", res.status, 200);
  const first = (await res.json()).profile;
  equal("profile is connected", first.connected, true);
  equal("profile shows the display name", first.name, "Levix Owner");
  equal("profile shows a + phone", first.phone, "+201234567890");
  equal("profile shows About", first.about, "Building Levix");
  ok(
    "profile points at the local photo route",
    first.photoUrl.startsWith("/dashboard/api/account/photo?revision="),
  );
  ok("profile exposes an opaque revision", typeof first.revision === "string");
  ok("profile reports refresh cooldown", first.refreshAfterMs >= 0);
  equal("profile did one picture lookup", pictureCalls, 1);
  equal("profile did one status lookup", statusCalls, 1);

  await http.call("/dashboard/api/account/profile");
  equal("repeat profile read is cached", pictureCalls, 1);
  equal("repeat status read is cached", statusCalls, 1);

  res = await http.json("/dashboard/api/account/profile/refresh", {});
  equal("refresh route succeeds", res.status, 200);
  const cooled = (await res.json()).profile;
  equal("refresh inside the cooldown is cached", pictureCalls, 1);
  equal("refresh keeps the revision", cooled.revision, first.revision);

  res = await http.call("/dashboard/api/account/profile/refresh", {
    headers: { origin: "https://evil.test" },
    method: "POST",
  });
  equal("refresh rejects a cross-origin request", res.status, 403);
  equal("a rejected refresh makes no lookup", pictureCalls, 1);

  section("photo bytes use only the revision and stay bounded");
  res = await http.call(first.photoUrl);
  equal("photo route serves the cached image", res.status, 200);
  equal("photo MIME is preserved", res.headers.get("content-type"), "image/jpeg");
  equal("photo response stays private", res.headers.get("cache-control"), "no-store");
  equal("photo response is sniff-proof", res.headers.get("x-content-type-options"), "nosniff");
  equal("photo bytes survive the proxy", await res.text(), "account-photo-bytes");
  equal("photo was fetched once", imageFetches, 1);

  await http.call(first.photoUrl);
  equal("valid image is cached", imageFetches, 1);

  equal(
    "unknown revision is 404",
    (await http.call("/dashboard/api/account/photo?revision=unknown")).status,
    404,
  );
  equal("missing revision is 404", (await http.call("/dashboard/api/account/photo")).status, 404);
  equal(
    "repeated revision parameters are 404",
    (
      await http.call(
        `/dashboard/api/account/photo?revision=${encodeURIComponent(first.revision)}&revision=other`,
      )
    ).status,
    404,
  );
  equal("rejected tokens made no network call", imageFetches, 1);

  section("private and missing fields stay null without leaking a token");
  setSession(connectedSession(fakeSocket()));
  pictureUrl = null;
  aboutText = null;
  res = await http.call("/dashboard/api/account/profile");
  equal("private profile route succeeds", res.status, 200);
  const privateProfile = (await res.json()).profile;
  equal("private picture has no URL", privateProfile.photoUrl, null);
  equal("private picture has no revision", privateProfile.revision, null);
  equal("missing About is null", privateProfile.about, null);
  ok("old account revision is dead after setSession", first.revision !== privateProfile.revision);
  equal(
    "old revision is 404 after the session changes",
    (await http.call(first.photoUrl)).status,
    404,
  );
  equal("dead revision made no image fetch", imageFetches, 1);
  pictureUrl = PHOTO_URL;
  aboutText = "Building Levix";

  section("disconnect clears the visible profile");
  setSession(null);
  res = await http.call("/dashboard/api/account/profile");
  const offline = (await res.json()).profile;
  equal("offline profile reports disconnected", offline.connected, false);
  equal("offline has no name", offline.name, null);
  equal("offline has no phone", offline.phone, null);
  equal("offline has no About", offline.about, null);
  equal("offline has no photo", offline.photoUrl, null);
  equal(
    "offline photo token is 404",
    (await http.call(`/dashboard/api/account/photo?revision=${privateProfile.revision || "x"}`))
      .status,
    404,
  );
  equal("offline made no picture lookup", pictureCalls, 2);
  equal("offline made no image fetch", imageFetches, 1);

  section("reconnect and epoch boundaries produce a fresh revision");
  setSession(connectedSession(fakeSocket({ name: "Next account" })));
  res = await http.call("/dashboard/api/account/profile");
  const reconnected = (await res.json()).profile;
  equal("reconnected name is the new socket's", reconnected.name, "Next account");
  ok("reconnect rotates the revision", reconnected.revision !== first.revision);

  store.advanceAccountEpoch();
  res = await http.call("/dashboard/api/account/profile");
  const afterEpoch = (await res.json()).profile;
  equal("epoch change keeps the same live name", afterEpoch.name, "Next account");
  ok("epoch change rotates the revision", afterEpoch.revision !== reconnected.revision);
  equal("pre-epoch revision is 404", (await http.call(reconnected.photoUrl)).status, 404);

  res = await http.call(afterEpoch.photoUrl);
  equal("post-epoch revision serves bytes", res.status, 200);
  equal("post-epoch bytes are correct", await res.text(), "account-photo-bytes");

  section("non-image and oversized responses stay 404");
  imageMime = "image/svg+xml";
  store.advanceAccountEpoch();
  res = await http.call("/dashboard/api/account/profile");
  const svgProfile = (await res.json()).profile;
  equal("SVG response is 404", (await http.call(svgProfile.photoUrl)).status, 404);

  imageMime = "image/png";
  imageBytes = Buffer.alloc(1024 * 1024 + 1);
  store.advanceAccountEpoch();
  res = await http.call("/dashboard/api/account/profile");
  const oversizedProfile = (await res.json()).profile;
  equal("oversized body is 404", (await http.call(oversizedProfile.photoUrl)).status, 404);

  imageMime = "image/jpeg";
  imageBytes = Buffer.from("account-photo-bytes");
  store.advanceAccountEpoch();
  res = await http.call("/dashboard/api/account/profile");
  const restored = (await res.json()).profile;
  equal(
    "a valid image still works after the failures",
    (await http.call(restored.photoUrl)).status,
    200,
  );

  section("existing dashboard read paths keep working");
  const callsBeforeStats = pictureCalls;
  res = await http.call("/dashboard/api/stats");
  equal("stats route still succeeds", res.status, 200);
  const stats = await res.json();
  equal("stats still reports the connected account", stats.stats.botName, "Next account");
  equal("stats route never reads the account profile", pictureCalls, callsBeforeStats);

  section("panel route fallback chain, LID-only phone safety, photo retry and account change");
  {
    const LID_ID = "987654321098765@lid";
    store.authWrite(
      "creds",
      JSON.stringify({
        registered: true,
        me: { id: PHONE_ID, lid: LID_ID, name: "Saved Creds Name" },
      }),
    );
    store.saveUserMetadata({
      jid: PHONE_ID,
      lid: LID_ID,
      phone: "201234567890",
      isOwner: true,
      displayName: "Stored Owner PushName",
    });

    // 1. verifiedName fallback
    setSession(
      connectedSession({
        user: { id: LID_ID, name: null, verifiedName: "Verified Panel Name" },
        async profilePictureUrl() {
          return null;
        },
        async fetchStatus() {
          return [];
        },
      }),
    );
    res = await http.call("/dashboard/api/account/profile");
    let p = (await res.json()).profile;
    equal("panel uses verifiedName fallback", p.name, "Verified Panel Name");
    equal("panel resolves verified PN for LID socket", p.phone, "+201234567890");

    // 2. notify fallback
    setSession(
      connectedSession({
        user: { id: LID_ID, name: "~", notify: "Notify Panel Name" },
        async profilePictureUrl() {
          return null;
        },
        async fetchStatus() {
          return [];
        },
      }),
    );
    res = await http.call("/dashboard/api/account/profile");
    p = (await res.json()).profile;
    equal("panel uses notify fallback", p.name, "Notify Panel Name");

    // 3. creds.me.name fallback
    setSession(
      connectedSession({
        user: { id: LID_ID, name: null },
        async profilePictureUrl() {
          return null;
        },
        async fetchStatus() {
          return [];
        },
      }),
    );
    res = await http.call("/dashboard/api/account/profile");
    p = (await res.json()).profile;
    equal("panel uses saved creds.me.name fallback", p.name, "Saved Creds Name");

    // 4. user_metadata displayName fallback + photo retry from LID to verified PN
    store.authWrite(
      "creds",
      JSON.stringify({
        registered: true,
        me: { id: PHONE_ID, lid: LID_ID },
      }),
    );
    const photoAttempts = [];
    setSession(
      connectedSession({
        user: { id: LID_ID, name: null },
        async profilePictureUrl(jid) {
          photoAttempts.push(jid);
          if (jid === PHONE_ID) return PHOTO_URL;
          return null;
        },
        async fetchStatus() {
          return [];
        },
      }),
    );
    res = await http.call("/dashboard/api/account/profile");
    p = (await res.json()).profile;
    equal("panel uses user_metadata display_name fallback", p.name, "Stored Owner PushName");
    equal(
      "panel retries photo with verified PN when LID fails",
      photoAttempts.join(","),
      `${LID_ID},${PHONE_ID}`,
    );
    ok("retried photo URL is exposed", Boolean(p.photoUrl));

    // 5. LID-only session with no PN in creds never shows a LID as a phone number
    const ONLY_LID = "555666777888999@lid";
    store.authWrite(
      "creds",
      JSON.stringify({
        registered: true,
        me: { id: ONLY_LID, lid: ONLY_LID },
      }),
    );
    setSession(
      connectedSession({
        user: { id: ONLY_LID, name: null },
        async profilePictureUrl() {
          return null;
        },
        async fetchStatus() {
          return [];
        },
      }),
    );
    res = await http.call("/dashboard/api/account/profile");
    p = (await res.json()).profile;
    equal("LID-only account has no phone", p.phone, null);
    equal("new LID account does not leak previous owner's metadata name", p.name, null);

    // 6. Another contact with the same digits as the owner's LID does not supply the name (F2)
    store.saveUserMetadata({
      jid: `${ONLY_LID.split("@")[0]}@s.whatsapp.net`,
      displayName: "Different Contact Name",
    });
    res = await http.call("/dashboard/api/account/profile");
    p = (await res.json()).profile;
    equal("exact self IDs only: contact with same digits cannot supply name", p.name, null);
  }
} catch (error) {
  ok("account profile panel tests run", false, error?.stack || String(error));
} finally {
  provider.safeProviderFetch = originalFetch;
  setSession(null);
  server.closeAllConnections?.();
  io.close();
  server.close();
  finish();
}
