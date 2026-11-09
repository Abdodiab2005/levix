// The reaction candidate query binds candidateLimit + 1. Own process so the
// statement cache has not already prepared that SQL.

import { DatabaseSync } from "node:sqlite";
import { equal, finish, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-reaction-limits");

const store = require("./src/db/store.cjs");
const { candidateLimit } = require("./src/automation/limits.cjs");

section("reaction rule query bound");

{
  const real = DatabaseSync.prototype.prepare;
  const seen = [];
  DatabaseSync.prototype.prepare = function prepare(sql) {
    const statement = real.call(this, sql);
    if (typeof sql === "string" && sql.includes("FROM reaction_rules") && sql.includes("LIMIT ?")) {
      return new Proxy(statement, {
        get(target, prop, receiver) {
          if (prop === "all") {
            return (...args) => {
              seen.push(args.at(-1));
              return target.all(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return statement;
  };
  try {
    store.reactionRulesForChats(["120363000000009@g.us"], {
      emoji: "😀",
      type: "add",
      originalType: "text",
    });
    equal("store query bound is candidateLimit + 1", seen.at(-1), candidateLimit + 1);
  } finally {
    DatabaseSync.prototype.prepare = real;
  }
}

finish();
