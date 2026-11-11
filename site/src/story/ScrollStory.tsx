import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import chevronDown from "../assets/icons/chevron-down.svg?raw";
import circleCheck from "../assets/icons/circle-check.svg?raw";
import filePen from "../assets/icons/file-pen-line.svg?raw";
import layers from "../assets/icons/layers.svg?raw";
import paperclip from "../assets/icons/paperclip.svg?raw";
import terminal from "../assets/icons/terminal.svg?raw";
import { DownloadLink, ReleaseNote } from "../components/Download";
import { DIMENSIONS, PARAM_ROWS, PRINT, TBD_ROWS } from "./facts";
import { PARTS } from "./parts";
import { COPY_STAGES, RAIL, TRACE, railPosition, readoutAt, traceAt, trackLength, type CopyStage, type Motion, type TraceIcon } from "./timeline";
import "./story.css";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeToMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Reduced motion turns the scrubbed story into one still per stage. */
function useMotion(): Motion {
  return useSyncExternalStore(subscribeToMotion, () => (window.matchMedia(REDUCED_MOTION).matches ? "still" : "full"));
}

/** A Lucide line icon from `assets/icons`, drawn in the text color, as the studio draws its trace. */
const Icon = ({ svg }: { svg: string }) => <span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;

const TRACE_ICONS: Record<TraceIcon, string> = { write: filePen, run: terminal, slice: layers };

/**
 * The words of each stage its own copy tells, in story order. They say what the app is. The printer is the show.
 * Every fact about the dock mount is in the agent's own log or files.
 */
const COPY: Record<CopyStage["id"], ReactNode> = {
  hero: (
    <>
      <p className="kick">Free for macOS</p>
      <h1>
        Materialize <b>3D</b>
      </h1>
      <p className="lead">Describe a part. Print the 3MF.</p>
      <div className="cta">
        <DownloadLink />
        <a className="text-link" href="#install">
          Install guide
        </a>
      </div>
      <ReleaseNote />
      <p className="hint">
        <svg viewBox="0 0 9 22" aria-hidden="true">
          <path d="M4.5 0v20M1 16.5l3.5 4 3.5-4" />
        </svg>
        Scroll to watch a part get made.
      </p>
    </>
  ),
  explode: (
    <>
      <p className="kick">What it is</p>
      <h2>A chat app for 3D printing</h2>
      <p>You say what you need, in your own words. An agent designs the part and makes the print file.</p>
    </>
  ),
  dive: (
    <>
      <p className="kick">Where it ends</p>
      <h2>On your build plate</h2>
      <p>The agent's work ends with a print-ready 3MF.</p>
    </>
  ),
  print: (
    <>
      <p className="kick">A real example</p>
      <h2>A shelf for a dock mount</h2>
      <p>This part came out of one chat. One of five printed parts, 100 × 80 × 30 mm.</p>
      <dl className="sheet">
        <div>
          <dt>File</dt>
          <dd className="file">ugreen-dock-mount-revB.3mf</dd>
        </div>
        <div>
          <dt>Holds</dt>
          <dd>Back plate, 2 rails, 2 shelves</dd>
        </div>
      </dl>
    </>
  ),
  request: (
    <>
      <p className="kick">
        <span>0:00</span>
        <span>The request</span>
      </p>
      <h2 className="ask">What are we making?</h2>
      <div className="composer">
        <div className="composer-text">
          Make a mount for my UGREEN dock under the monitor arm. Photo attached.{"\u2060"}
          <i aria-hidden="true" />
        </div>
        <div className="composer-bar" aria-hidden="true">
          <span className="composer-button">
            <Icon svg={paperclip} />
            Attach
          </span>
          <span className="composer-button composer-model">
            Opus 5.5
            <Icon svg={chevronDown} />
          </span>
          <span className="composer-button composer-start">Start</span>
        </div>
      </div>
      <p className="request-note">That is all you type. 13:58 later, 2 print files.</p>
    </>
  ),
};

/** The readout and the trace before the story starts moving. The director rewrites them as P changes. */
const FIRST_READOUT = readoutAt(0, PRINT);
const FIRST_TRACE = traceAt(0);

/**
 * The agent's trace, as the studio shows a finished turn. It stands in for the rewind's words. The director
 * fades it in with the rewind, takes its lines away from the bottom as the clock runs back, and rewrites its
 * kick and head. The ring stays still, as the studio's does.
 */
function Trace() {
  return (
    <div className="story-trace" role="group" aria-label="Agent trace">
      <p className="kick" data-trace="kick">
        {FIRST_TRACE.kick}
      </p>
      <div className="trace-card" data-done={FIRST_TRACE.done || undefined}>
        <p className="trace-head">
          <span className="trace-mark" aria-hidden="true">
            <Icon svg={circleCheck} />
            <svg className="trace-ring" viewBox="0 0 16 16">
              <circle cx={8} cy={8} r={6} />
              <path d="M8 2a6 6 0 0 1 6 6" />
            </svg>
          </span>
          <span data-trace="head">{FIRST_TRACE.head}</span>
          <span className="trace-count" data-trace="count">
            {FIRST_TRACE.count}
          </span>
        </p>
        <ol className="trace-lines">
          {TRACE.map(({ id, log }) => (
            <li key={id} data-step={id}>
              <Icon svg={TRACE_ICONS[log.icon]} />
              <span className="trace-did">{log.did}</span>
              {log.detail && <span className="trace-detail">{log.detail}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Params() {
  return (
    <pre className="story-params">
      <span className="c">params.json</span>
      {"\n{\n"}
      {PARAM_ROWS.map(({ key, value }) => (
        <Fragment key={key}>
          {"  "}
          <span className="k">"{key}"</span>: {value},{"\n"}
        </Fragment>
      ))}
      {"  "}
      <span className="k">"tbd"</span>
      {": {\n"}
      {TBD_ROWS.map(({ key, status }, i) => (
        <Fragment key={key}>
          {"    "}
          <span className="k">"{key}"</span>: <span className="t">"{status}"</span>
          {i < TBD_ROWS.length - 1 ? ",\n" : "\n"}
        </Fragment>
      ))}
      {"  }\n}"}
    </pre>
  );
}

/**
 * The scroll story: a printer that comes apart top down, the right shelf printing on
 * its plate, and a rewind through the agent's trace back to the request. The 3D view and
 * the timing load on demand. All text is DOM text here.
 */
export function ScrollStory() {
  const motion = useMotion();
  const root = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<string | null>("Loading the 3D model");

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    setStatus("Loading the 3D model");
    let stop: (() => void) | null = null;
    let cancelled = false;
    import("./director").then(
      ({ startStory }) => {
        if (!cancelled) stop = startStory(element, motion, setStatus);
      },
      (error: unknown) => {
        if (!cancelled) setStatus(`The 3D view did not load. ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [motion]);

  return (
    <section ref={root} className="story" id="top" aria-label="Scroll story" data-motion={motion}>
      <div className="story-view">
        <canvas
          key={motion}
          className="story-canvas"
          role="img"
          aria-label="A 3D printer built in Blender for this page. As you scroll it comes apart from the top down to the build plate, the right shelf of a dock mount prints on the plate, and the story rewinds through how the agent made it."
        />
        <svg className="story-lines" aria-hidden="true">
          {PARTS.map((part) => (
            <g key={part.name} data-line={part.name}>
              <path />
              <circle r="2.2" />
            </g>
          ))}
        </svg>
        {COPY_STAGES.map((stage) => (
          <section key={stage.id} className="stage-copy" data-stage={stage.id}>
            {COPY[stage.id]}
          </section>
        ))}
        <ol className="story-labels" aria-label="Printer parts, top down">
          {PARTS.map((part, i) => (
            <li key={part.name} data-part={part.name}>
              <span className="part-index">{String(i + 1).padStart(2, "0")}</span>
              <span className="part-long">{part.label}</span>
              <span className="part-short">{part.short}</span>
            </li>
          ))}
        </ol>
        <ul className="story-dimensions" aria-label="Drawing sizes in millimetres">
          {DIMENSIONS.map((dimension, i) => (
            <li key={i} data-dimension={i}>
              <b>{dimension.value}</b>
              {dimension.text && ` ${dimension.text}`}
            </li>
          ))}
        </ul>
        <Params />
        <div className="readout">
          <p className="kick">
            <span data-readout="kick">{FIRST_READOUT.kick}</span>
            <span data-readout="kickNote">{FIRST_READOUT.kickNote}</span>
          </p>
          <p className="readout-value">
            <span data-readout="value">{FIRST_READOUT.value}</span>
            <span className="of" data-readout="of">
              {FIRST_READOUT.of}
            </span>
            <span className="unit" data-readout="unit">
              {FIRST_READOUT.unit}
            </span>
          </p>
          <p className="readout-line" data-readout="line">
            {FIRST_READOUT.line}
          </p>
          <p className="readout-note" data-readout="note">
            {FIRST_READOUT.note}
          </p>
        </div>
        <Trace />
        <nav className="story-rail" aria-label="Story stages">
          {RAIL.map((stop) => (
            <button
              key={stop.label}
              type="button"
              data-rail={stop.label}
              aria-label={`Go to ${stop.label}`}
              style={{ top: `${(railPosition(stop, motion) * 100).toFixed(2)}%` }}
            >
              {stop.label}
            </button>
          ))}
          <span className="rail-mark" aria-hidden="true" />
        </nav>
        <p className="story-status" role="status">
          {status}
        </p>
      </div>
      <div className="story-track" style={{ height: `${trackLength(motion)}vh` }} />
    </section>
  );
}
