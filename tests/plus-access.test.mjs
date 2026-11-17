import {
  accessFromStatus,
  isPlusSubscribed,
  legacyPlusRedirect,
  PLUS_SUBSCRIBED_STATES,
  plusAvailableFrom,
  plusHash,
  plusTabFromHash,
} from "../frontend/src/utils/plusAccess.ts";
import { equal, finish, section } from "./harness.mjs";

const status = (entitlement, extension = "active", configured = true) => ({
  configured,
  entitlement: entitlement === undefined ? undefined : { state: entitlement, until: null, reason: null },
  extension: extension === undefined ? undefined : { state: extension },
});

section("the subscribed set is the one PlusSettings uses");
equal("subscribed set", PLUS_SUBSCRIBED_STATES.join(","), "active,grace,canceled");
equal("active is subscribed", isPlusSubscribed("active"), true);
equal("grace is subscribed", isPlusSubscribed("grace"), true);
equal("canceled is subscribed", isPlusSubscribed("canceled"), true);
equal("expired is not subscribed", isPlusSubscribed("expired"), false);
equal("null is not subscribed", isPlusSubscribed(null), false);

section("every entitlement state with a running extension");
const expected = {
  active: "active",
  grace: "active",
  canceled: "active",
  none: "locked",
  inactive: "locked",
  expired: "locked",
  pending: "locked",
  on_hold: "locked",
  billing_retry: "locked",
  clock: "unknown",
  unverified: "unknown",
  unavailable: "unknown",
};
for (const [state, access] of Object.entries(expected)) {
  equal(`${state} -> ${access}`, accessFromStatus(status(state), true), access);
}

section("an unknown future state is never active");
equal("future entitlement state", accessFromStatus(status("quantum"), true), "unknown");
equal("empty entitlement state", accessFromStatus(status(""), true), "unknown");
equal("numeric entitlement state", accessFromStatus(status(7), true), "unknown");
equal("missing entitlement", accessFromStatus(status(undefined), true), "unknown");

section("null and loading");
equal("null status, availability unknown", accessFromStatus(null, null), "unknown");
equal("undefined status", accessFromStatus(undefined), "unknown");
equal("null status, available", accessFromStatus(null, true), "unknown");
equal("null status, not available", accessFromStatus(null, false), "unavailable");

section("extension states");
equal("absent extension", accessFromStatus(status("active", "absent"), true), "unavailable");
equal("absent wins over a subscribed state", accessFromStatus(status("grace", "absent")), "unavailable");
equal("not configured", accessFromStatus(status("active", "active", false), true), "unavailable");
equal("available=false wins", accessFromStatus(status("active"), false), "unavailable");
for (const extension of ["inactive", "incompatible", "disabled", "failed"]) {
  equal(`subscribed but extension ${extension} stays locked`, accessFromStatus(status("active", extension), true), "locked");
  equal(`not subscribed, extension ${extension}`, accessFromStatus(status("none", extension), true), "locked");
}
equal("subscribed, extension state missing", accessFromStatus({ configured: true, entitlement: { state: "active" }, extension: {} }, true), "unknown");
equal("subscribed, unknown extension state", accessFromStatus(status("active", "mystery"), true), "locked");

section("availability follows the Settings tab rules");
const absent = status("none", "absent");
const present = status("none", "inactive");
equal("host says configured", plusAvailableFrom({ hostConfigured: true, status: null, failed: false }), true);
equal("host wins over an absent extension", plusAvailableFrom({ hostConfigured: true, status: absent, failed: false }), true);
equal("nothing known yet", plusAvailableFrom({ hostConfigured: false, status: null, failed: false }), null);
equal("absent extension", plusAvailableFrom({ hostConfigured: false, status: absent, failed: false }), false);
equal("present extension", plusAvailableFrom({ hostConfigured: false, status: present, failed: false }), true);
equal("first read failed", plusAvailableFrom({ hostConfigured: false, status: null, failed: true }), false);
equal(
  "a later failure keeps an earlier yes",
  plusAvailableFrom({ hostConfigured: false, status: null, failed: true, previous: true }),
  true,
);
equal(
  "a later failure keeps an earlier no",
  plusAvailableFrom({ hostConfigured: false, status: null, failed: true, previous: false }),
  false,
);

section("hashes");
equal("tab from #plus/autoReply", plusTabFromHash("#plus/autoReply"), "autoReply");
equal("tab from #plus/messages", plusTabFromHash("#plus/messages"), "messages");
equal("plain #plus has no tab", plusTabFromHash("#plus"), null);
equal("unknown tab is ignored", plusTabFromHash("#plus/nope"), null);
equal("another view is ignored", plusTabFromHash("#settings/autoReply"), null);
equal("hash for a tab", plusHash("autoReply"), "#plus/autoReply");
equal("hash without a tab", plusHash(), "#plus");
equal("old settings link", legacyPlusRedirect("#settings/plus"), "#plus");
equal("old settings link with tab", legacyPlusRedirect("#settings/plus/presets"), "#plus/presets");
equal("other settings tab untouched", legacyPlusRedirect("#settings/general"), null);
equal("plain hash untouched", legacyPlusRedirect("#plus"), null);

finish();
