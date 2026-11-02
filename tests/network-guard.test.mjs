import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

section("test network guard");
const guard = join(ROOT, "tests", "fixtures", "no-external-network.cjs");
const probe = `const net = require('node:net');
const dgram = require('node:dgram');
try { new net.Socket().connect(443, 'web.whatsapp.com'); process.exit(2); }
catch (e) { if (!e.message.includes('refused non-local')) process.exit(3); }
try { dgram.createSocket('udp4').send(Buffer.from('x'), 53, '8.8.8.8'); process.exit(4); }
catch (e) { if (!e.message.includes('refused UDP')) process.exit(5); }`;
const child = spawnSync(process.execPath, ["-e", probe], {
  encoding: "utf8",
  env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(guard)}` },
});
equal("a child blocks external TCP and UDP", child.status, 0);
ok("guard probe ran successfully", !child.error, child.error?.message);
finish();
