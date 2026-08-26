// ESM face of the store (src/db/store.cjs).
//
// store.cjs has to be CommonJS so the command files and the ESM handlers share
// one singleton; this wrapper is what the ESM side imports for the lifecycle
// calls. Data access goes through src/utils/storage.esm.js as it always did.

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const store = require("./store.cjs");

export const initStore = store.initStore;
export const flushStore = store.flushStore;
export const isStoreReady = store.isStoreReady;
export const pendingWrites = store.pendingWrites;

export default store;
