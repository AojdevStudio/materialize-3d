import { ThemeToggle } from "./components/ThemeToggle";
import { ReleaseFacts } from "./components/ReleaseFacts";
import sign from "./data/p2s-test-sign.json";
import signPreview from "./assets/p2s-test-sign-preview.png";
import shotDescribe from "./assets/screens/02-main-with-chat.png";
import shotGenerate from "./assets/screens/03-build-progress.png";
import shotInspect from "./assets/screens/04-verified-awaiting-approval.png";
import shotApprove from "./assets/screens/05-approved.png";
import shotExport from "./assets/screens/06-relaunch-still-approved.png";
import oflUrl from "./assets/fonts/OFL.txt?url";
import { checksumPublished, dmgFileName, release } from "./release";

type Step = {
  title: string;
  body: string;
  shot: string;
  alt: string;
  /** States only what the screenshot shows. */
  caption: string;
};

const steps: readonly Step[] = [
  {
    title: "Describe",
    body: "Tell the in-app chat what sign you want.",
    shot: shotDescribe,
    alt: "Materialize 3D main window with an empty AI Assistant panel on the right.",
    caption:
      "The AI Assistant panel, empty, with the Describe what to make box where you type your request.",
  },
  {
    title: "Generate",
    body: "The app builds a three-color, face-down sign package: a white base with two inlay colors.",
    shot: shotGenerate,
    alt: "Signs tab with the build stage track showing Spec validated.",
    caption:
      "A build in progress. The stage track has reached Spec validated, ahead of Geometry built, Package written, Sliced, and Verified.",
  },
  {
    title: "Inspect",
    body: "It slices with Bambu Studio using Bambu Lab P2S 0.4 mm nozzle presets, then runs 27 automated geometry and slice checks, including first-layer coverage per color.",
    shot: shotInspect,
    alt: "Revision r1 of the P2S three-color test sign with a table of passed checks.",
    caption:
      "Revision r1 of the test sign: 27 of 27 checks passed, approval pending, print not tested.",
  },
  {
    title: "Approve",
    body: "You approve the exact package by its SHA-256 hash. The assistant cannot approve. Any change to the design makes a new revision that needs a new approval.",
    shot: shotApprove,
    alt: "The same revision marked Approved, with an Export 3MF button.",
    caption:
      "The same revision after a person approved it for hash 9fee629…0738. Print is still Not tested.",
  },
  {
    title: "Export",
    body: "Export a 3MF through the macOS Save dialog, open it in Bambu Studio, check the filament mapping, and print from Bambu Studio. Only a person records the print result.",
    shot: shotExport,
    alt: "The approved revision after a relaunch, with Export 3MF and print result buttons.",
    caption:
      "The approved revision after quitting and relaunching. The approval is kept, Export 3MF is ready, and Passed and Failed wait for a person to record the print.",
  },
];

const shipped = [
  "Describe a sign in the in-app chat",
  "Three-color, face-down sign package: white base, two inlay colors",
  "Slicing with Bambu Studio on Bambu Lab P2S 0.4 mm nozzle presets",
  "27 automated geometry and slice checks, including first-layer coverage per color",
  "Approval by a person, bound to the package SHA-256; the assistant cannot approve",
  "A new revision and a new approval for any design change",
  "3MF export through the macOS Save dialog; you print from Bambu Studio",
  "Print results recorded only by a person",
  "Optional local MCP endpoint so external agents can use the same tools; off by default, loopback only",
] as const;

const unvalidatedTabs = [
  "Model Library",
  "3D Preview",
  "MakerWorld",
  "OpenSCAD",
  "Print Monitor",
  "Print History",
] as const;

const signColors = [sign.base, ...sign.inks];

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Materialize 3D, top of page">
          <span className="wordmark-serif">Materialize</span>
          <span className="wordmark-3d">3D</span>
        </a>
        <nav aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#requirements">Requirements</a>
          <a href="#install">Install</a>
          <a href="#roadmap">Roadmap</a>
        </nav>
        <ThemeToggle />
      </header>

      <main id="main">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">
              Describe a sign. <em>Approve</em> a verified slice.
            </h1>
            <p className="lede">
              Materialize 3D is a conversational Mac app for creating 3D-printable objects, starting
              with signs for the Bambu Lab P2S. Describe a three-color sign in chat; the app builds
              it, slices it with Bambu Studio, runs 27 automated checks, and waits for your approval
              before you export a 3MF.
            </p>
            <a className="download" href={release.dmgUrl}>
              Download for Mac ({release.architecture})
            </a>
            <ReleaseFacts />
            <p className="hero-note">
              Free app. You bring an Anthropic or OpenAI API key. <a href={release.releasesUrl}>All releases</a>
            </p>
          </div>
          <figure className="hero-shot">
            <img
              src={shotInspect}
              width={1440}
              height={900}
              alt="Materialize 3D showing a test sign revision with 27 of 27 checks passed and approval pending."
              fetchPriority="high"
            />
            <figcaption>
              Real app, release candidate build: 27 of 27 checks passed on the test sign, waiting for
              a person to approve.
            </figcaption>
          </figure>
        </section>

        <section id="how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="steps">
            {steps.map((step, i) => (
              <li key={step.title} className="step">
                <div className="step-copy">
                  <span className="step-num">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
                <figure>
                  <img src={step.shot} width={1440} height={900} alt={step.alt} loading="lazy" />
                  <figcaption>{step.caption}</figcaption>
                </figure>
              </li>
            ))}
          </ol>
        </section>

        <section id="sign" className="sign" aria-labelledby="sign-title">
          <h2 id="sign-title">The reference design</h2>
          <div className="sign-grid">
            <img
              src={signPreview}
              width={800}
              height={500}
              alt="Rendered face of the test sign: HELLO in navy, a teal rule and dot, 3 COLOR TEST, and a navy P2S badge on white."
              loading="lazy"
            />
            <div>
              <p>
                A synthetic acceptance sign, “{sign.title}”, is the design 0.1.0 was validated on. It
                passes all 27 automated checks. Its physical print is the owner's acceptance step,
                and no print result has been published.
              </p>
              <dl className="facts">
                <dt>Size</dt>
                <dd>
                  {sign.width_mm} × {sign.height_mm} × {sign.thickness_mm} mm
                </dd>
                <dt>Inlay depth</dt>
                <dd>{sign.inlay_depth_mm} mm</dd>
                <dt>Filaments</dt>
                <dd>
                  <ul className="swatches">
                    {signColors.map((c) => (
                      <li key={c.name}>
                        <span className="swatch" style={{ background: c.hex }} aria-hidden="true" />
                        {c.name} <code>{c.hex}</code>
                      </li>
                    ))}
                  </ul>
                </dd>
              </dl>
            </div>
          </div>
        </section>

        <section id="requirements" aria-labelledby="req-title">
          <h2 id="req-title">Requirements</h2>
          <dl className="facts facts-wide">
            <dt>Mac</dt>
            <dd>{release.architecture}. Tested on {release.testedMacOS}.</dd>
            <dt>Bambu Studio</dt>
            <dd>
              Version <code>{release.bambuStudio.version}</code>, free, installed separately from{" "}
              <a href={release.bambuStudio.releaseUrl}>Bambu Lab's official release page</a>. The app
              never installs or bundles it. If you use another version, keep it and put this one in
              its own folder.
            </dd>
            <dt>API key</dt>
            <dd>
              An Anthropic or OpenAI key that you provide. The provider bills model usage at its own
              rates; the app itself is free.
            </dd>
            <dt>Printer</dt>
            <dd>Bambu Lab P2S with AMS and three filaments. This is the validated printer.</dd>
            <dt>Not offered</dt>
            <dd>Intel Mac, Windows, and Linux downloads.</dd>
          </dl>
        </section>

        <section id="install" aria-labelledby="install-title">
          <h2 id="install-title">Install</h2>
          <ol className="install">
            <li>
              Download <a href={release.dmgUrl}>{dmgFileName}</a>.
              {checksumPublished && (
                <>
                  {" "}
                  Check it with <code>shasum -a 256 {dmgFileName}</code>; it should print{" "}
                  <code className="hash">{release.sha256}</code>.
                </>
              )}
            </li>
            <li>Open the DMG.</li>
            <li>Drag Materialize 3D to Applications.</li>
            <li>
              Launch it from Applications.
              {!release.notarized && (
                <>
                  {" "}
                  This build has no Apple notarization yet, so macOS blocks the first launch. Open
                  System Settings, then Privacy &amp; Security, and click Open Anyway for Materialize
                  3D.
                </>
              )}
            </li>
            <li>Add your Anthropic or OpenAI API key in Settings, under Agent.</li>
            <li>
              If Settings, under Bambu Studio, does not show version {release.bambuStudio.version},
              click Choose Bambu Studio and select that copy.
            </li>
          </ol>
        </section>

        <section id="scope" aria-labelledby="scope-title">
          <h2 id="scope-title">Shipped and planned</h2>
          <div className="scope">
            <div>
              <h3>Shipped in {release.version}</h3>
              <ul>
                {shipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>In the app, not validated</h3>
              <p>
                These tabs exist in {release.version} but are not part of the validated workflow:
              </p>
              <ul>
                {unvalidatedTabs.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div id="roadmap">
              <h3>Planned</h3>
              <p>
                Signs are the first proven workflow, not the permanent scope. The broader aim is
                conversational creation of other printable objects. That work is planned and not
                built; there are no dates.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <span className="wordmark-serif">Materialize</span>
        <span>3D {release.version}</span>
        <nav aria-label="Project links">
          <a href={release.repoUrl}>Repository</a>
          <a href={release.releasesUrl}>Releases</a>
          <a href={release.docsUrl}>Docs</a>
          <a href={oflUrl}>Font licenses (SIL OFL 1.1)</a>
        </nav>
      </footer>
    </>
  );
}
