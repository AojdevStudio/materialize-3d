import { appleTrusted, checksumPublished, release } from "../release";

/**
 * The release record under the download button. Renders the honest state for each
 * flag: the Apple claim appears only when the build is both signed and notarized.
 */
export function ReleaseFacts() {
  return (
    <dl className="release-facts">
      <dt>Version</dt>
      <dd>
        {release.version}, tested on {release.testedMacOS}
      </dd>
      <dt>SHA-256</dt>
      <dd>{checksumPublished ? <span className="hash">{release.sha256}</span> : "Not published yet"}</dd>
      {appleTrusted ? (
        <>
          <dt>Apple</dt>
          <dd>Signed and notarized by Apple</dd>
        </>
      ) : (
        <>
          <dt>Signing</dt>
          <dd>{release.signed ? "Signed" : "Not signed yet"}</dd>
          <dt>Notarization</dt>
          <dd>{release.notarized ? "Notarized" : "Not notarized yet"}</dd>
        </>
      )}
    </dl>
  );
}
