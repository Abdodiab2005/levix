import { createRequire } from "node:module";

// ESM evaluates this first dependency before the rest of src/index.js's graph.
const require = createRequire(import.meta.url);
require("./db.cjs").guardStartup();
