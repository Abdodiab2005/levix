// Pure helpers for group moderation preview formatting, plural member counts,
// preset descriptions, and warning explanations.
import type { ModerationPolicy } from "../types";

export type MarkdownSegmentType = "text" | "bold" | "italic" | "strike" | "mono";

export interface MarkdownSegment {
  type: MarkdownSegmentType;
  text: string;
}

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];
export type GroupMembersKey = `groupMembers_${PluralCategory}`;

export type ModerationActionCode = "DELETE" | "WARN" | "KICK" | "FLAG";

function replaceVars(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : match,
  );
}

/**
 * Parse WhatsApp-style inline markdown (*bold*, _italic_, ~strike~, ```mono```)
 * into a flat array of segments. Unmatched delimiters stay as plain text.
 * Line breaks are preserved inside text segments.
 */
export function parseWhatsAppMarkdown(input: string): MarkdownSegment[] {
  if (!input) return [];
  const segments: MarkdownSegment[] = [];
  let plain = "";

  const flushPlain = () => {
    if (!plain) return;
    const last = segments.at(-1);
    if (last && last.type === "text") {
      last.text += plain;
    } else {
      segments.push({ type: "text", text: plain });
    }
    plain = "";
  };

  let i = 0;
  while (i < input.length) {
    if (input.startsWith("```", i)) {
      const close = input.indexOf("```", i + 3);
      if (close > i + 3) {
        flushPlain();
        segments.push({ type: "mono", text: input.slice(i + 3, close) });
        i = close + 3;
        continue;
      }
      plain += "```";
      i += 3;
      continue;
    }

    const ch = input[i];
    if (ch === "*" || ch === "_" || ch === "~") {
      const lineEnd = input.indexOf("\n", i + 1);
      const limit = lineEnd === -1 ? input.length : lineEnd;
      const nextChar = input[i + 1];
      if (i + 1 < limit && nextChar !== ch && !/\s/.test(nextChar)) {
        let close = -1;
        for (let j = i + 2; j < limit; j += 1) {
          if (input[j] === ch && !/\s/.test(input[j - 1])) {
            close = j;
            break;
          }
        }
        if (close !== -1) {
          flushPlain();
          const type: MarkdownSegmentType = ch === "*" ? "bold" : ch === "_" ? "italic" : "strike";
          segments.push({ type, text: input.slice(i + 1, close) });
          i = close + 1;
          continue;
        }
      }
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return segments;
}

export function groupMembersPluralKey(count: number, locale: string): GroupMembersKey {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  let category: PluralCategory = "other";
  try {
    const resolved = new Intl.PluralRules(locale).select(safeCount);
    if ((PLURAL_CATEGORIES as readonly string[]).includes(resolved)) {
      category = resolved as PluralCategory;
    }
  } catch {
    category = safeCount === 1 ? "one" : "other";
  }
  return `groupMembers_${category}`;
}

export function formatGroupMembers(
  count: number | null | undefined,
  locale: string,
  t: (key: string) => string,
): string {
  if (count === null || count === undefined || !Number.isFinite(count)) {
    return t("groupMembersUnknown");
  }
  const safeCount = Math.max(0, Math.trunc(count));
  const key = groupMembersPluralKey(safeCount, locale);
  return replaceVars(t(key), { n: safeCount });
}

export function moderationActionKey(
  action: ModerationActionCode | null | undefined,
): "moderationActionDelete" | "moderationActionWarn" | "moderationActionKick" | "actionFlag" {
  if (action === "DELETE") return "moderationActionDelete";
  if (action === "KICK") return "moderationActionKick";
  if (action === "FLAG") return "actionFlag";
  return "moderationActionWarn";
}

export function moderationActionTone(
  action: ModerationActionCode | null | undefined,
): "danger" | "warn" | "neutral" {
  if (action === "KICK") return "danger";
  if (action === "DELETE") return "neutral";
  return "warn";
}

export function describePresetPolicy(policy: ModerationPolicy, t: (key: string) => string): string {
  return replaceVars(t("presetSummaryLine"), {
    limit: policy.limit,
    limitAction: t(moderationActionKey(policy.limitAction)),
    linkAction: t(moderationActionKey(policy.features.antilink ?? "WARN")),
    mediaAction: t(moderationActionKey(policy.features.media ?? "WARN")),
    forbiddenAction: t(moderationActionKey(policy.features.forbidden ?? "WARN")),
    spamAction: t(moderationActionKey(policy.features.antispam ?? "WARN")),
  });
}

export function buildWarningsExplanation(
  policy: ModerationPolicy,
  t: (key: string) => string,
): string[] {
  const lines: string[] = [];

  if (policy.mode === "severity") {
    lines.push(
      replaceVars(
        t(policy.hitMerge === "sum" ? "warnExplainAddSeveritySum" : "warnExplainAddSeverityMax"),
        {
          link: policy.weights.antilink,
          media: policy.weights.media,
          forbidden: policy.weights.forbidden,
          spam: policy.weights.antispam,
          manual: policy.weights.manual,
        },
      ),
    );
    lines.push(
      replaceVars(t("warnExplainLimitSeverity"), {
        flagAt: policy.flagAt,
        kickAt: policy.kickAt,
      }),
    );
  } else {
    lines.push(
      t(policy.hitMerge === "sum" ? "warnExplainAddSimpleSum" : "warnExplainAddSimpleMax"),
    );
    if (policy.limitAction === "FLAG") {
      if (policy.flag.whileFlagged === "escalate") {
        lines.push(
          replaceVars(t("warnExplainLimitFlagEscalate"), {
            limit: policy.limit,
            extra: policy.flag.escalateAfter,
          }),
        );
      } else {
        lines.push(replaceVars(t("warnExplainLimitFlag"), { limit: policy.limit }));
      }
    } else {
      lines.push(replaceVars(t("warnExplainLimitKick"), { limit: policy.limit }));
    }
  }

  if (policy.decay.mode === "expire") {
    lines.push(replaceVars(t("warnExplainDecayExpire"), { days: policy.decay.days }));
  } else if (policy.decay.mode === "step") {
    lines.push(replaceVars(t("warnExplainDecayStep"), { days: policy.decay.days }));
  }

  return lines;
}

export function shouldWarnPresetReplace(
  current: ModerationPolicy,
  saved: ModerationPolicy,
  target: ModerationPolicy,
  isCustomPreset: boolean,
): boolean {
  const currentJson = JSON.stringify(current);
  if (currentJson === JSON.stringify(target)) return false;
  return isCustomPreset || currentJson !== JSON.stringify(saved);
}
