import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../frontend/src/api/client.ts";
import { userErrorMessage } from "../frontend/src/utils/userError.ts";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
  const catalog = JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8"));
  const t = (key) => catalog[key];
  const message = (err) => userErrorMessage(t, err, "recipientsLoadFailed");

  section(`${locale}: stable codes precede HTTP status`);
  equal(
    "ApiError.code",
    message(
      new ApiError(500, "raw", {
        code: "REACTION_RULE_INVALID",
      }),
    ),
    t("reactionErrorRuleInvalid"),
  );
  equal(
    "data.error",
    message(
      new ApiError(500, "raw", {
        error: "REACTION_RULE_MISSING",
      }),
    ),
    t("reactionErrorRuleMissing"),
  );
  equal(
    "plain structured response",
    message({ data: { error: "TERMS_CHANGED" } }),
    t("legalChangedReview"),
  );
  equal(
    "known body code survives unknown top-level code",
    message({
      code: "NEW_SERVER_CODE",
      data: { error: "REACTION_SWITCH_INVALID" },
    }),
    t("reactionErrorSwitchInvalid"),
  );
  equal(
    "local validation keeps its translated message",
    message(
      new ApiError(400, "raw", {
        code: "DELAY_RANGE_INVALID",
      }),
    ),
    t("delayRangeError"),
  );
  equal(
    "code is never taken from Error.message",
    message(new Error("REACTION_RULE_INVALID")),
    t("recipientsLoadFailed"),
  );

  section(`${locale}: HTTP status classes precede fallback`);
  for (const [status, key] of [
    [401, "userErrorSession"],
    [403, "userErrorPermission"],
    [404, "plusExtErrorNotFound"],
    [409, "userErrorConflict"],
    [413, "userErrorTooLarge"],
    [429, "userErrorRateLimited"],
    [500, "userErrorServer"],
    [503, "userErrorServer"],
    [599, "userErrorServer"],
  ]) {
    equal(
      `HTTP ${status}`,
      message(
        new ApiError(status, "INTERNAL_SERVER_CODE", {
          error: "UNKNOWN_API_CODE",
        }),
      ),
      t(key),
    );
  }
  equal(
    "other HTTP errors use the action fallback",
    message(new ApiError(400, "raw")),
    t("recipientsLoadFailed"),
  );

  section(`${locale}: network failures`);
  equal("fetch TypeError", message(new TypeError("Failed to fetch")), t("userErrorUnreachable"));
  equal(
    "XHR without a response",
    message(new ApiError(0, "Network error")),
    t("userErrorUnreachable"),
  );
  equal(
    "ApiError without a status",
    message(
      Object.assign(new Error("raw"), {
        name: "ApiError",
      }),
    ),
    t("userErrorUnreachable"),
  );

  section(`${locale}: unknown errors never expose technical text`);
  const raw = new Error("Error fetching recipients");
  for (const err of [
    raw,
    new Error("at fetchRecipients (client.ts:18:2)"),
    new Error('{"error":"REACTION_RULE_INVALID"}'),
    { data: { error: "UNKNOWN_API_CODE" }, message: "PRIVATE_SERVER_TEXT" },
    { code: "__proto__", data: { error: "constructor" } },
    "UNKNOWN_API_CODE",
    null,
    undefined,
  ]) {
    const result = message(err);
    equal("uses the action fallback", result, t("recipientsLoadFailed"));
    ok("translated sentence exists", typeof result === "string" && result.length > 0);
    ok("never equals the raw error message", result !== raw.message);
    if (err instanceof Error) ok("never equals any Error.message", result !== err.message);
    ok("no JSON", !result.includes("{"));
    ok("no stack frame", !result.includes("at "));
    ok("no joined API code", !/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/.test(result));
  }
  equal(
    "caller chooses the action",
    userErrorMessage(t, raw, "prefixSaveError"),
    t("prefixSaveError"),
  );
}

finish();
