import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, section, ok, finish } from "./harness.mjs";

const installer = join(ROOT, "deploy", "install.sh");
const source = readFileSync(installer, "utf8");

section("fresh-server Node bootstrap");

ok("installer remains valid bash", spawnSync("bash", ["-n", installer]).status === 0);
ok(
  "missing or old Node enters the bootstrap path",
  /if \[ "\$NODE_MAJOR" -lt "\$MIN_NODE_MAJOR" \] \|\| ! command -v npm/.test(source) &&
    /install_node24/.test(source)
);
ok("Debian is supported", /debian\|ubuntu/.test(source));
ok("Ubuntu is supported", /debian\|ubuntu/.test(source));
ok("other distributions fail explicitly", /Automatic Node installation is supported on Debian and Ubuntu only/.test(source));
ok("NodeSource 24-style repository is configured", /deb\.nodesource\.com\/node_\$\{MIN_NODE_MAJOR\}\.x nodistro main/.test(source));
ok("NodeSource repository is pinned to its signing key", /signed-by=\/etc\/apt\/keyrings\/nodesource\.asc/.test(source));
ok("the NodeSource signing key is downloaded as data", /nodesource-repo\.gpg\.key -o "\$key_tmp"/.test(source));
ok("nodejs is installed with apt", /apt-get install -y nodejs/.test(source));
ok(
  "the installer does not pipe a second remote setup script into bash",
  !/deb\.nodesource\.com\/setup_[^\s|]+[^\n]*\|[^\n]*bash/.test(source)
);
ok("Node is re-checked after bootstrapping", /install_node24[\s\S]*NODE_MAJOR="\$\(node_major\)"/.test(source));
ok("npm is still required before installing Levix", /command -v npm[\s\S]*npm install -g "\$\{PACKAGE\}@\$\{VERSION\}"/.test(source));
ok("the old fresh-server hard stop is gone", !/Node is not installed\. Get Node/.test(source));

finish();
