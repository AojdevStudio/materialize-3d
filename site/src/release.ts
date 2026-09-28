/**
 * Every release fact the page states lives here. After a release is verified, the
 * orchestrator edits this object only; the page renders the honest state for
 * whatever these values are (pending checksum, unsigned, unnotarized).
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
};

export const release: Release = {
  version: "0.1.0",
  repoUrl: "https://github.com/AojdevStudio/materialize-3d",
  releasesUrl: "https://github.com/AojdevStudio/materialize-3d/releases",
  docsUrl: "https://github.com/AojdevStudio/materialize-3d#readme",
  dmgUrl:
    "https://github.com/AojdevStudio/materialize-3d/releases/download/v0.1.0/Materialize-3D-0.1.0-macos-arm64.dmg",
  sha256: "pending",
  signed: false,
  notarized: false,
  testedMacOS: "macOS 26.7",
  architecture: "Apple Silicon",
  bambuStudio: {
    version: "02.08.02.61",
    releaseUrl: "https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61",
  },
};

/** The page may say "signed and notarized by Apple" only when this is true. */
export const appleTrusted = release.signed && release.notarized;

export const checksumPublished = release.sha256 !== "pending";

export const dmgFileName = new URL(release.dmgUrl).pathname.split("/").pop() ?? "the DMG";

/** The complete set of off-site links the page may render. Tests assert against it. */
export const externalLinks = [
  release.repoUrl,
  release.releasesUrl,
  release.docsUrl,
  release.dmgUrl,
  release.bambuStudio.releaseUrl,
] as const;
