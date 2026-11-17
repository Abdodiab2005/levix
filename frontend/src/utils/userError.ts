import type { MessageKey } from "../i18n/translations";

type Translate = (key: MessageKey) => string;

const CODE_KEYS: Readonly<Record<string, string>> = {
  REACTION_RULE_INVALID: "reactionErrorRuleInvalid",
  REACTION_RULE_MISSING: "reactionErrorRuleMissing",
  REACTION_RULE_CHANGED: "reactionErrorRuleChanged",
  REACTION_AUTOMATION_CHANGED: "reactionAutomationChanged",
  REACTION_SWITCH_INVALID: "reactionErrorSwitchInvalid",
  INTERNAL: "reactionErrorInternal",
  DELAY_RANGE_INVALID: "delayRangeError",
  TERMS_CHANGED: "legalChangedReview",
  CONSENT_REQUIRED: "legalReasonNotAccepted",
  UNLINK_INCOMPLETE: "connectionUnlinkIncomplete",
  wrong_password: "recoveryErrWrongPassword",
  invalid_email: "recoveryErrInvalidEmail",
  wrong_code: "recoveryErrWrongCode",
  expired: "recoveryErrExpired",
  no_pending: "recoveryErrExpired",
  too_many_attempts: "userErrorRateLimited",
  throttled: "userErrorRateLimited",
  rate_limited: "userErrorRateLimited",
  inactive: "plusExtErrorInactive",
  BAD_REQUEST: "plusExtErrorBadRequest",
  INVALID_TEMPLATE: "plusExtErrorInvalidTemplate",
  UNKNOWN_PLACEHOLDER: "plusExtErrorUnknownPlaceholder",
  NOT_CUSTOMIZABLE: "plusExtErrorNotCustomizable",
  TOO_LONG: "plusExtErrorTooLong",
  INVALID_CHAT: "plusExtErrorInvalidChat",
  LIMIT: "plusExtErrorLimit",
  NOT_FOUND: "plusExtErrorNotFound",
  TRANSLATE_FAILED: "plusExtErrorTranslateFailed",
};

const warned = new WeakSet<object>();
let warnedPrimitive = false;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Log safe metadata once per original error. */
function warnOnce(err: unknown, status: number | undefined, code: string | undefined): void {
  if (!(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) return;
  const object = record(err);
  if (object ? warned.has(object) : warnedPrimitive) return;
  if (object) warned.add(object);
  else warnedPrimitive = true;
  console.warn("Panel action failed", {
    type:
      object?.name === "ApiError"
        ? "ApiError"
        : err instanceof TypeError
          ? "TypeError"
          : err instanceof Error
            ? "Error"
            : "Unknown",
    status,
    code,
  });
}

/** API details are data, never display text. */
export function userErrorMessage(t: Translate, err: unknown, fallbackKey: string): string {
  const error = record(err);
  const data = record(error?.data);
  const code = [error?.code, data?.error].find(
    (value): value is string => typeof value === "string" && Object.hasOwn(CODE_KEYS, value),
  );
  const status =
    typeof error?.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 0 &&
    error.status <= 599
      ? error.status
      : undefined;
  warnOnce(err, status, code);

  let key = code ? CODE_KEYS[code] : undefined;
  if (!key) {
    if (status === 401) key = "userErrorSession";
    else if (status === 403) key = "userErrorPermission";
    else if (status === 404) key = "plusExtErrorNotFound";
    else if (status === 409) key = "userErrorConflict";
    else if (status === 413) key = "userErrorTooLarge";
    else if (status === 429) key = "userErrorRateLimited";
    else if (status !== undefined && status >= 500) key = "userErrorServer";
    else if (
      err instanceof TypeError ||
      status === 0 ||
      (error?.name === "ApiError" && status === undefined)
    )
      key = "userErrorUnreachable";
  }
  return t((key ?? fallbackKey) as MessageKey);
}
