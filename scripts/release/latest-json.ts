#!/usr/bin/env bun
/**
 * Writes latest.json, the update feed installed apps read, to stdout. scripts/release/build-macos.sh runs it:
 *
 *   UPDATE_VERSION=<version> UPDATE_SIGNATURE=<minisign signature> UPDATE_URL=<archive URL> UPDATE_DATE=<RFC 3339> \
 *     bun scripts/release/latest-json.ts > dist-release/latest.json
 */

/** The update banner shows these notes, and they are all a user reads before Update now. */
export function updateNotes(version: string): string {
  const changes = `What changed: https://github.com/AojdevStudio/materialize-3d/releases/tag/v${version}`;
  const fromOldApp =
    "The sign, part, printer, and MakerWorld screens, the MCP server, and the OpenAI API key path are gone, and the app no longer sends jobs to a printer. Choose Later to keep 0.2.2.";
  if (version === "0.3.0") return `Materialize 3D 0.3.0 is a new chat studio. ${fromOldApp}\n${changes}`;
  if (version.startsWith("0.3.")) {
    return `Materialize 3D ${version}. Updating from 0.2.2? 0.3 is a new chat studio. ${fromOldApp}\n${changes}`;
  }
  return `Materialize 3D ${version}. ${changes}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

if (import.meta.main) {
  const version = required("UPDATE_VERSION");
  const feed = {
    version,
    notes: updateNotes(version),
    pub_date: required("UPDATE_DATE"),
    platforms: { "darwin-aarch64": { signature: required("UPDATE_SIGNATURE"), url: required("UPDATE_URL") } },
  };
  console.log(JSON.stringify(feed, null, 2));
}
