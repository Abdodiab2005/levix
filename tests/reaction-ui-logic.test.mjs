import { createAutomationWriter, sortReactionRules } from "../frontend/src/utils/reactionRules.ts";
import { equal, finish, ok, section } from "./harness.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function track(opts) {
  const calls = {
    send: [],
    show: [],
    busy: [],
    failed: [],
    reconcile: 0,
    written: 0,
  };
  let living = true;
  return {
    calls,
    die() {
      living = false;
    },
    deps: {
      send: async (enabled) => {
        calls.send.push(enabled);
        return opts.send(enabled);
      },
      reconcile: async () => {
        calls.reconcile += 1;
      },
      show: (enabled) => {
        calls.show.push(enabled);
      },
      busy: (pending) => {
        calls.busy.push(pending);
      },
      failed: (err) => {
        calls.failed.push(err);
      },
      alive: () => living,
      written: () => {
        calls.written += 1;
      },
    },
  };
}

function makeServer(initial) {
  let enabled = initial;
  const pending = [];
  return {
    get enabled() {
      return enabled;
    },
    send(value) {
      enabled = value;
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      pending.push({ value, resolve });
      return promise;
    },
    answer(index) {
      const item = pending[index];
      item.resolve({ automation: { enabled: item.value } });
    },
  };
}

function rule(id, fields = {}) {
  return {
    id,
    chatJid: `${id}@g.us`,
    chatName: id,
    priority: 100,
    enabledAt: null,
    ...fields,
  };
}

function ids(list) {
  return list.map((item) => item.id).join(",");
}

section("ON then OFF while ON is pending");
{
  const gate = deferred();
  const { deps, calls } = track({ send: () => gate.promise });
  const write = createAutomationWriter(deps);
  const first = write(true, false);
  const second = write(false, true);
  equal("second call ignored", await second, false);
  equal("one send", calls.send.length, 1);
  equal("send was ON", calls.send[0], true);
  gate.resolve({ automation: { enabled: true } });
  equal("first call accepted", await first, true);
  equal("busy true then false", calls.busy.join(","), "true,false");
  equal("displayed server value", calls.show.at(-1), true);
}

section("reorder server: last accepted OFF wins");
{
  const raw = makeServer(false);
  const rawOn = raw.send(true);
  const rawOff = raw.send(false);
  equal("raw arrival order ends OFF", raw.enabled, false);
  const rawAnswers = [];
  const note = (p) => p.then((res) => rawAnswers.push(res.automation.enabled));
  note(rawOn);
  note(rawOff);
  raw.answer(1);
  raw.answer(0);
  await rawOn;
  await rawOff;
  equal("raw last answer is ON", rawAnswers.at(-1), true);

  const server = makeServer(true);
  const { deps, calls } = track({ send: (enabled) => server.send(enabled) });
  const write = createAutomationWriter(deps);
  const off = write(false, true);
  const on = write(true, false);
  equal("overlapping ON ignored", await on, false);
  equal("writer sent only OFF", calls.send.join(","), "false");
  server.answer(0);
  equal("OFF accepted", await off, true);
  equal("server ends OFF", server.enabled, false);

  const seq = makeServer(false);
  const sequential = track({ send: (enabled) => seq.send(enabled) });
  const writeSeq = createAutomationWriter(sequential.deps);
  const first = writeSeq(true, false);
  seq.answer(0);
  await first;
  const last = writeSeq(false, true);
  seq.answer(1);
  await last;
  equal("sequential last intent OFF", seq.enabled, false);
}

section("failure restores previous");
{
  const err = new Error("switch failed");
  const { deps, calls } = track({ send: () => Promise.reject(err) });
  const write = createAutomationWriter(deps);
  equal("failure still accepted", await write(true, false), true);
  equal("displayed previous", calls.show.at(-1), false);
  equal("failed once", calls.failed.length, 1);
  equal("failed with the error", calls.failed[0], err);
  equal("reconcile once", calls.reconcile, 1);
  equal("busy cleared", calls.busy.join(","), "true,false");
}

section("success reconciles and bumps written");
{
  const { deps, calls } = track({
    send: async () => ({ automation: { enabled: true } }),
  });
  const write = createAutomationWriter(deps);
  await write(true, false);
  equal("reconcile once", calls.reconcile, 1);
  equal("written at start and settle", calls.written, 2);
}

section("unmount during pending write");
{
  const gate = deferred();
  const { deps, calls, die } = track({ send: () => gate.promise });
  const write = createAutomationWriter(deps);
  const pending = write(true, false);
  die();
  const show = calls.show.length;
  const busy = calls.busy.length;
  const failed = calls.failed.length;
  const reconcile = calls.reconcile;
  gate.resolve({ automation: { enabled: true } });
  equal("pending write still settles", await pending, true);
  equal("no show after unmount", calls.show.length, show);
  equal("no busy after unmount", calls.busy.length, busy);
  equal("no failed after unmount", calls.failed.length, failed);
  equal("no reconcile after unmount", calls.reconcile, reconcile);
}

section("after a settled write a new toggle is accepted");
{
  const { deps, calls } = track({
    send: async (enabled) => ({ automation: { enabled } }),
  });
  const write = createAutomationWriter(deps);
  equal("first accepted", await write(true, false), true);
  equal("second accepted", await write(false, true), true);
  equal("two sends", calls.send.join(","), "true,false");
}

section("sortReactionRules recent / priority / chat");
{
  const rules = [
    rule("run", { chatName: "Zulu", priority: 50, runtime: { lastAt: 300 } }),
    rule("en", {
      chatName: "Alpha",
      priority: 10,
      enabledAt: 200,
      runtime: { lastAt: null },
    }),
    rule("zz", { chatName: "Mike", priority: 10 }),
    rule("aa", { chatName: "Mike", priority: 90 }),
  ];
  equal(
    "recent last-run then enable then id",
    ids(sortReactionRules(rules, "recent", "en")),
    "run,en,zz,aa",
  );
  equal("priority then id", ids(sortReactionRules(rules, "priority", "en")), "en,zz,run,aa");
  equal("chat then priority then id", ids(sortReactionRules(rules, "chat", "en")), "en,zz,aa,run");
  ok(
    "never-run disabled rules have no runtime",
    !("runtime" in rules[2]) && !("runtime" in rules[3]),
  );
}

finish();
