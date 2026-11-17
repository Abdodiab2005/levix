import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const compiled = buildSync({
  entryPoints: [`${ROOT}/frontend/src/views/settings/plusOffer.ts`],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
}).outputFiles[0].text;
const module = { exports: {} };
runInNewContext(compiled, { module, exports: module.exports });
const { presentPlusOffer } = module.exports;

const regular = {
  ok: true,
  productId: "levix.plus",
  basePlanId: "monthly",
  offerId: null,
  offerToken: "regular-token",
  formattedPrice: "$2.99",
  billingPeriod: "P1M",
  introduction: null,
};
const introductory = {
  ...regular,
  offerId: "intro-3months",
  offerToken: "intro-token",
  introduction: { formattedPrice: "$0.99", billingPeriod: "P1M", billingCycleCount: 3 },
};
const catalog = (locale) =>
  JSON.parse(readFileSync(`${ROOT}/i18n/${locale}/dashboard.json`, "utf8"));
const en = catalog("en");
const t = (key) => en[key];

section("eligible and ineligible payment disclosures");
const intro = presentPlusOffer(introductory, t);
equal("eligible headline uses introductory price", intro.price, "$0.99 / month");
equal(
  "discloses three monthly payments, month 4 renewal and cancellation before checkout",
  intro.disclosure,
  "$0.99 per month for the first 3 months. Starting in month 4, renews automatically at $2.99 per month until cancelled in Google Play.",
);
equal("disclosed offer carries the actual intro token", intro.product.offerToken, "intro-token");
const base = presentPlusOffer(regular, t);
equal("ineligible headline uses regular price", base.price, "$2.99 / month");
equal(
  "ineligible terms contain only regular recurring billing",
  base.disclosure,
  "$2.99, billed monthly. Renews automatically until cancelled in Google Play.",
);
equal("regular terms retain the base plan token", base.product.offerToken, "regular-token");

section("actual Play formatting is preserved in every UI language");
for (const [locale, introductoryPrice, renewalPrice] of [
  ["en", "€0.89", "€2.79"],
  ["ar", "١٥٫٠٠ ج.م.‏", "٤٥٫٠٠ ج.م.‏"],
  ["pt-BR", "R$ 4,90", "R$ 14,90"],
  ["es-419", "$0.990 CLP", "$2.990 CLP"],
]) {
  const strings = catalog(locale);
  const result = presentPlusOffer(
    {
      ...introductory,
      formattedPrice: renewalPrice,
      introduction: { ...introductory.introduction, formattedPrice: introductoryPrice },
    },
    (key) => strings[key],
  );
  ok(
    `${locale}: both Play price strings survive unchanged`,
    result.disclosure.includes(introductoryPrice) && result.disclosure.includes(renewalPrice),
  );
  ok(
    `${locale}: terms include duration and month 4`,
    result.disclosure.includes("3") && result.disclosure.includes("4"),
  );
  ok(`${locale}: no unsubstituted placeholders`, !/\{[a-zA-Z]+\}/.test(result.disclosure));
  ok(`${locale}: no fallback USD amounts`, !/\$(?:0\.99|2\.99)(?![0-9])/.test(result.disclosure));
}

section("incomplete and unsupported payment schedules cannot enable checkout");
for (const [label, product] of [
  ["absent", null],
  ["Play unavailable", { ok: false, code: "ITEM_UNAVAILABLE" }],
  ["old bridge without offer metadata", { ...regular, basePlanId: undefined }],
  ["wrong base plan", { ...regular, basePlanId: "annual" }],
  ["nonmonthly renewal", { ...regular, billingPeriod: "P1Y" }],
  ["missing token", { ...regular, offerToken: "" }],
  ["missing localized price", { ...regular, formattedPrice: " " }],
  ["unknown introductory offer", { ...introductory, offerId: "free-trial" }],
  ["intro metadata missing", { ...introductory, introduction: null }],
  [
    "wrong intro period",
    { ...introductory, introduction: { ...introductory.introduction, billingPeriod: "P3M" } },
  ],
  [
    "wrong intro duration",
    { ...introductory, introduction: { ...introductory.introduction, billingCycleCount: 1 } },
  ],
  [
    "missing intro price",
    { ...introductory, introduction: { ...introductory.introduction, formattedPrice: "" } },
  ],
  ["intro phases on a regular plan", { ...introductory, offerId: null }],
])
  equal(label, presentPlusOffer(product, t), null);

finish();
