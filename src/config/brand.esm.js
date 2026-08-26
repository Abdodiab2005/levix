// ESM face of brand.cjs — same frozen object, no second source of truth.
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const brand = require("./brand.cjs");

export default brand;
export const {
  name,
  nameAr,
  tagline,
  taglineAr,
  developer,
  developerAr,
  studio,
  repo,
} = brand;
