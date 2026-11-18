/**
 * Every release fact the page states lives here, with the off-site links the page may
 * render. After a release is published and checked, edit `version` and the release's
 * `sha256` only (docs/releasing.md, step 7). The page renders the honest state for whatever
 * these values are (pending checksum, unsigned, unnotarized).
 * `bun scripts/release/release-facts.ts` checks these values against the app's sources.
 */
export type Release = {
  version: string;
  repoUrl: string;
  releasesUrl: string;
  docsUrl: string;
  dmgUrl: string;
  /** Lowercase hex SHA-256 of the DMG, or "pending" until the release is verified. */
  sha256: "pending" | (string & {});
  signed: boolean;
  notarized: boolean;
  /** Shown verbatim, e.g. "macOS 26.7". */
  testedMacOS: string;
  /** Shown verbatim in the download label, e.g. "Apple Silicon". */
  architecture: string;
  bambuStudio: { version: string; releaseUrl: string };
  /** Whether this download is the chat studio. While false, the hero says the studio is not in a release yet. */
  studio: boolean;
};

/** The last published release. It trails package.json while the next release is built. */
const version = "0.3.2";
/** The build `VALIDATED_VERSIONS` names in src-tauri/src/bambu/studio.rs. */
const bambuStudio = "02.08.02.61";

export const release: Release = {
  version,
  repoUrl: "https://github.com/AojdevStudio/materialize-3d",
  releasesUrl: "https://github.com/AojdevStudio/materialize-3d/releases",
  docsUrl: "https://github.com/AojdevStudio/materialize-3d#readme",
  dmgUrl: `https://github.com/AojdevStudio/materialize-3d/releases/download/v${version}/Materialize-3D-${version}-macos-arm64.dmg`,
  sha256: "5f883a5f5f88983da486c895ff059a72b1628847194be5e352b2f564c2f8b06a",
  signed: true,
  notarized: true,
  testedMacOS: "macOS 26.7.2",
  architecture: "Apple Silicon",
  bambuStudio: {
    version: bambuStudio,
    releaseUrl: `https://github.com/bambulab/BambuStudio/releases/tag/v${bambuStudio}`,
  },
  studio: true,
};

/** The page may say "signed and notarized by Apple" only when this is true. */
export const appleTrusted = release.signed && release.notarized;

export const checksumPublished = release.sha256 !== "pending";

export const dmgFileName = new URL(release.dmgUrl).pathname.split("/").pop() ?? "the DMG";

/** The studio's blog and the repository's license, on the footer's legal line. */
export const blogUrl = "https://aojdevstudio.me/blog";
export const licenseUrl = `${release.repoUrl}/blob/main/LICENSE`;

/** The complete set of off-site links the page may render. Tests assert against it. */
export const externalLinks = [
  release.repoUrl,
  release.releasesUrl,
  release.docsUrl,
  release.dmgUrl,
  release.bambuStudio.releaseUrl,
  blogUrl,
  licenseUrl,
] as const;
