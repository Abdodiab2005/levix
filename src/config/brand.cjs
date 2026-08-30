// Who this bot is. Frozen on purpose.
//
// The name and the credit are NOT settings: they are not in the database and
// not editable from the dashboard. Every template renders from this object —
// app.cjs assigns it to `app.locals.brand` — so everything on it is public by
// definition.
//
// That is exactly why the AI's identity block is NOT here any more. It lives in
// src/config/ai-identity.cjs, which the agent imports and no template, route or
// setting can reach. Keeping model instructions on the same object the views
// render was one `<%= %>` away from putting them on a web page.

const BRAND = Object.freeze({
  name: "Levix",
  nameAr: "ليفيكس",
  tagline: "Personal WhatsApp Bot",
  taglineAr: "بوت واتساب شخصي",

  copyrightYear: 2026,
  developer: "Abdelrhman Diab",
  developerAr: "عبدالرحمن دياب",
  developerSite: "https://abdelrhman.leviro.net",
  studio: "Leviro",
  studioSite: "https://leviro.net",

  repo: "https://github.com/Abdodiab2005/levix",
});

module.exports = BRAND;
