import type { PlusProductResult } from "../../utils/hostBridge";
import { fill } from "../../utils/fill";

/** Keep the payment disclosure and the product allowed at checkout together. */
export function presentPlusOffer(
  result: PlusProductResult | null,
  t: (key: "plusPrice" | "plusMonthly" | "plusIntroDisclosure" | "plusDisclosure") => string,
) {
  if (
    !result?.ok ||
    result.basePlanId !== "monthly" ||
    result.billingPeriod !== "P1M" ||
    !result.offerToken ||
    !result.formattedPrice?.trim()
  )
    return null;
  const intro = result.introduction;
  if (
    result.offerId !== null &&
    (result.offerId !== "intro-3months" ||
      !intro ||
      intro.billingPeriod !== "P1M" ||
      intro.billingCycleCount !== 3 ||
      !intro.formattedPrice?.trim())
  )
    return null;
  if (result.offerId === null && intro != null) return null;
  return {
    product: result,
    price: fill(t("plusPrice"), {
      price: intro?.formattedPrice ?? result.formattedPrice,
      period: t("plusMonthly"),
    }),
    disclosure: intro
      ? fill(t("plusIntroDisclosure"), {
          introPrice: intro.formattedPrice,
          months: intro.billingCycleCount,
          price: result.formattedPrice,
          renewalMonth: intro.billingCycleCount + 1,
        })
      : fill(t("plusDisclosure"), { price: result.formattedPrice }),
  };
}
