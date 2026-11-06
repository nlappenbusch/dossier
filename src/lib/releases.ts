// Where Dossier's releases are published, for the update check and its
// notice (update-check.ts, the sidebar). Safe to use in the browser.

export const RELEASES_REPOSITORY = "AienTech/dossier";
/**
 * The repository's page, for credits and support (the sidebar). This fork's,
 * so the source of what runs here is a click away (AGPL-3.0 §13); updates are
 * still looked for upstream.
 */
export const REPOSITORY_URL = "https://github.com/nlappenbusch/dossier";
/** How to update, in the wiki. */
export const UPGRADE_GUIDE_URL = `https://github.com/${RELEASES_REPOSITORY}/wiki/Upgrading`;

/** A published release: its version, without the "v", and its page on GitHub. */
export type Release = { version: string; url: string };

/** 1.10.0 is newer than 1.9.2; anything after "-" (a pre-release) is ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string) => version.replace(/^v/i, "").split("-")[0].split(".").map((part) => Number(part) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
