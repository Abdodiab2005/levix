import { equal, finish, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-reaction-routing");
const { canonicalJid, planDelivery } = require("./src/messaging/router.cjs");
const source = "201000000001-1600000000@g.us";
const destination = "201000000002-1600000001@g.us";
const request = {
  sourceJid: source,
  requestedJid: source,
  senderJid: "201000000003@s.whatsapp.net",
  commandName: "ping",
  routeMode: "same_chat",
  sensitivity: "source",
  identity: { selfJids: [] },
};

section("same-chat legacy group delivery stays in the source chat");
equal("legacy group canonicalizes unchanged", canonicalJid(source), source);
const sameChat = planDelivery(request);
equal("same-chat delivery is allowed", sameChat.allow, true);
equal("destination is exactly the source", sameChat.destination, source);
equal("same-chat delivery can quote the original", sameChat.quote, true);
equal(
  "same-chat mode refuses another legacy group",
  planDelivery({ ...request, requestedJid: destination }).allow,
  false,
);

section("cross-group delivery still needs known membership and operational content");
const crossGroup = {
  ...request,
  routeMode: "authorized_chat",
  routeChat: destination,
  sensitivity: "operational",
};
equal("unknown membership is refused", planDelivery(crossGroup).allow, false);
equal(
  "negative membership is refused",
  planDelivery({ ...crossGroup, knownGroups: { [destination]: { member: false } } }).allow,
  false,
);
const member = { ...crossGroup, knownGroups: { [destination]: { member: true } } };
equal("verified membership permits operational content", planDelivery(member).allow, true);
equal("verified membership keeps exact destination", planDelivery(member).destination, destination);
equal(
  "source content still cannot leave the group",
  planDelivery({ ...member, sensitivity: "source" }).allow,
  false,
);

section("legacy syntax never admits malformed groups or sender-style addresses");
for (const value of [
  "201000000001-1600000000@s.whatsapp.net",
  "201000000001-1600000000@lid",
  "1-2-3@g.us",
  "abc@g.us",
])
  equal(`reject ${value}`, canonicalJid(value), null);

finish();
