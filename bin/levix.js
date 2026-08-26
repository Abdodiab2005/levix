#!/usr/bin/env node
// The `levix` command. Everything it does lives in src/cli.js, so the packaged
// executable and this wrapper share one implementation.

import { run } from "../src/cli.js";

await run(process.argv);
