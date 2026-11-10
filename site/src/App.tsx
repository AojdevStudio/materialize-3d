import { useState } from "react";
import { HowItWorks } from "./components/HowItWorks";
import { ReleaseFacts } from "./components/ReleaseFacts";
import { ThemeToggle } from "./components/ThemeToggle";
import { ProductHero } from "./hero/ProductHero";
import markLarge from "./assets/brand/mark-256.png";
import markSmall from "./assets/brand/mark-small-32.svg";
import oflUrl from "./assets/fonts/OFL.txt?url";
import { checksumPublished, dmgFileName, release } from "./release";

type Requirement = { label: string; text: string };

const requirements: readonly Requirement[] = [
  {
    label: "Mac",
    text: "Apple Silicon and macOS 26.0 or later. Intel Macs, Windows, and Linux release builds are not offered.",
  },
  {
    label: "AI sign-in",
    text: "One inference provider: Claude, ChatGPT, or OpenCode Go, by subscription or by API key. Your provider's plan or API charges apply. The app is free.",
  },
  {
    label: "Bambu Studio",
    text: "Bambu Studio 02.08.02.61, installed separately. The agent slices with it. The app never installs or bundles it.",
  },
  { label: "uv", text: "uv and a Python it can run." },
  {
    label: "Printer",
    text: "To print, a Bambu Lab P2S with a 0.4 mm nozzle. The agent slices for its presets. Materialize 3D does not send jobs to the printer.",
  },
];

/** What a download of this release goes through, in order. Each step states the release's honest state. */
const installSteps = [
  <>
    Download <a href={release.dmgUrl}>{dmgFileName}</a>.
    {checksumPublished && (
      <>
        {" "}
        Check it with <code>shasum -a 256 {dmgFileName}</code>. It should print{" "}
        <code className="hash">{release.sha256}</code>.
      </>
    )}
  </>,
  <>Open the DMG.</>,
  <>Drag Materialize 3D to Applications.</>,
  <>
    Launch it from Applications.
    {!release.notarized && (
      <>
        {" "}
        This build has no Apple notarization yet, so macOS blocks the first launch. Open System Settings, then
        Privacy &amp; Security, and click Open Anyway for Materialize 3D.
      </>
    )}
  </>,
  <>Add your Anthropic or OpenAI API key in Settings, under Agent.</>,
  <>
    If Settings, under Bambu Studio, does not show version{" "}
    <a href={release.bambuStudio.releaseUrl}>{release.bambuStudio.version}</a>, click Choose Bambu Studio and
    select that copy.
  </>,
];

function Headline() {
  return (
    <>
      <span className="headline-part">Describe a part.</span>{" "}
      <span className="headline-part headline-accent">Print the 3MF.</span>
    </>
  );
}

function DownloadActions() {
  return (
    <>
      <div className="actions">
        <a className="button-primary" href={release.dmgUrl}>
          Download for Mac ({release.architecture})
        </a>
        <a className="install-link" href="#install">
          Install guide
        </a>
      </div>
      <p className="facts-line">macOS 26.0 or later · Apple Silicon · The app is free</p>
    </>
  );
}

export function App() {
  const [heroPaused, setHeroPaused] = useState(false);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="band">
        <header className="site-header">
          <a className="lockup" href="#top" aria-label="Materialize 3D, top of page">
            <img src={markSmall} alt="" width={28} height={28} />
            <span>Materialize 3D</span>
          </a>
          <nav className="site-nav" aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#requirements">Requirements</a>
            <a href="#install">Install</a>
          </nav>
          <ThemeToggle />
          <a className="button-small" href={release.dmgUrl}>
            Download
          </a>
        </header>
      </div>

      <main id="main">
        <section className="band hero" id="top" aria-labelledby="hero-title">
          <h1 id="hero-title">
            <Headline />
          </h1>
          <p className="lede">
            Materialize 3D is a Mac app where you describe a 3D-printable object in a chat, and an agent makes it.
            The agent writes the model, previews it, and slices it to a print-ready 3MF for your printer.
          </p>
          <DownloadActions />
          {!release.studio && (
            <p className="release-note">
              The chat studio is not in a release yet. This download is {release.version}, the earlier sign app.
            </p>
          )}
          <div className="hero-stage" aria-hidden="true">
            <ProductHero paused={heroPaused} />
          </div>
          <button type="button" className="hero-pause" onClick={() => setHeroPaused((paused) => !paused)}>
            {heroPaused ? "Play animation" : "Pause animation"}
          </button>
        </section>

        <HowItWorks />

        <section className="section" id="requirements" aria-labelledby="req-title">
          <h2 id="req-title">Requirements</h2>
          <dl className="requirements">
            {requirements.map((row) => (
              <div key={row.label} className="requirement">
                <dt>{row.label}</dt>
                <dd>{row.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="section" id="install" aria-labelledby="install-title">
          <h2 id="install-title">Install</h2>
          <div className="install">
            <ol className="install-steps">
              {installSteps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <ReleaseFacts />
          </div>
        </section>

        <section className="closing">
          <img className="closing-mark" src={markLarge} alt="" width={96} height={96} />
          <h2>
            <Headline />
          </h2>
          <DownloadActions />
        </section>
      </main>

      <footer className="site-footer">
        <img src={markSmall} alt="" width={20} height={20} />
        <span>Materialize 3D {release.version}</span>
        <nav aria-label="Project links">
          <a href={release.repoUrl}>Repository</a>
          <a href={release.releasesUrl}>Releases</a>
          <a href={release.docsUrl}>Docs</a>
          <a href={oflUrl}>Font license (SIL OFL 1.1)</a>
        </nav>
      </footer>
    </>
  );
}
