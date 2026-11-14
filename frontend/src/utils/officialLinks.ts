// Fixed product destinations, independent of release notes or page input.
export const officialLinks = Object.freeze({
  website: "https://levix.leviro.net",
  docs: "https://levix.leviro.net/docs",
  support: "https://levix.leviro.net/feedback",
  github: "https://github.com/Abdodiab2005/levix",
  releases: "https://github.com/Abdodiab2005/levix/releases",
  play: "https://play.google.com/store/apps/details?id=net.leviro.levix",
  portfolio: "https://abdelrhman.leviro.net",
  studio: "https://leviro.net",
});

export function safeOfficialUrl(value: string): boolean {
  if (Object.values(officialLinks).some((url) => url === value)) return true;
  return /^https:\/\/github\.com\/Abdodiab2005\/levix\/releases\/tag\/v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(
    value,
  );
}

/** Never send panel cookies, referrers or an opener to another application. */
export function openOfficialLink(url: string): boolean {
  if (!safeOfficialUrl(url)) return false;
  if (window.LevixHost) return window.LevixHost.openOfficialLink?.(url) === true;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
