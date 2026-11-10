/**
 * The scroll story as data. One row per stage, in scroll order: how far it scrolls,
 * where its reduced-motion still sits, which rail stop and readout it uses, what tells
 * it (its own copy, or the agent's trace card), and, while rewinding, the agent log
 * line it shows. The camera keys hang off the same stage ids. Everything here is plain
 * math on the story position P, the distance in vh along the full-motion track, so the
 * scene, the copy, the trace, and the readout all read one number.
 */
import { LIFTED_PARTS, PARTS, type Part } from "./parts";

export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Smootherstep: starts and settles with zero speed and zero acceleration. */
export const ease = (x: number) => {
  const t = clamp(x);
  return t * t * t * (t * (6 * t - 15) + 10);
};

/** A span of progress through a stage, 0 to 1. */
type Span = readonly [from: number, to: number];

export type Readout = "teardown" | "print" | "rewind";

/** The icon a trace line starts with, as the studio draws it: a file the agent wrote, a command it ran, or a slice. */
export type TraceIcon = "write" | "run" | "slice";

/** While rewinding: the agent log line, its elapsed time in seconds, and where the clock holds on it. */
type Log = { line: string; seconds: number; hold: Span };

/** A log line the trace card also shows: what the agent did, then the detail after it. */
type TraceLog = Log & { icon: TraceIcon; did: string; detail: string };

type StageRow = {
  id: string;
  /** Scroll length in vh with motion on. */
  length: number;
  /** Where the reduced-motion still sits, as progress through the stage. */
  still: number;
  rail: string;
  readout: Readout;
} & (
  | {
      /** The stage's own copy tells it. The copy fades in and out over these spans. null: shown from the start, or kept to the end. */
      tells: "copy";
      fadeIn: Span | null;
      fadeOut: Span | null;
      log: Log | null;
    }
  | {
      /** The agent's trace card tells it, with this stage's step as the newest line. */
      tells: "trace";
      log: TraceLog;
    }
);

const FADE_IN: Span = [0.02, 0.14];
const FADE_OUT: Span = [0.94, 1];

/** A trace step and the readout's sentence for it, so the card and the readout always say the same thing. */
const step = (icon: TraceIcon, did: string, detail = "") => ({ icon, did, detail, line: `${did}${detail && `, ${detail}`}.` });

export const STAGES = [
  { id: "hero", length: 70, still: 0, rail: "Printer", readout: "teardown", tells: "copy", fadeIn: null, fadeOut: [0.62, 0.95], log: null },
  { id: "explode", length: 340, still: 0.97, rail: "Teardown", readout: "teardown", tells: "copy", fadeIn: FADE_IN, fadeOut: FADE_OUT, log: null },
  { id: "dive", length: 110, still: 0.95, rail: "Build plate", readout: "teardown", tells: "copy", fadeIn: FADE_IN, fadeOut: FADE_OUT, log: null },
  { id: "print", length: 270, still: 0.6, rail: "Print", readout: "print", tells: "copy", fadeIn: FADE_IN, fadeOut: FADE_OUT, log: null },
  {
    id: "slices",
    length: 120,
    still: 0.45,
    rail: "Rewind",
    readout: "rewind",
    tells: "trace",
    log: { ...step("slice", "Sliced 2 print files", "PETG Basic"), seconds: 838, hold: [0, 0.75] },
  },
  {
    id: "guide",
    length: 125,
    still: 0.85,
    rail: "Rewind",
    readout: "rewind",
    tells: "trace",
    log: { ...step("write", "Wrote assembly-guide.html", "13 steps"), seconds: 587, hold: [0.6, 0.9] },
  },
  {
    id: "adapter",
    length: 115,
    still: 0.55,
    rail: "Rewind",
    readout: "rewind",
    tells: "trace",
    log: { ...step("run", "Added the revision C arm adapter"), seconds: 365, hold: [0.45, 0.8] },
  },
  {
    id: "parts",
    length: 115,
    still: 0.6,
    rail: "Rewind",
    readout: "rewind",
    tells: "trace",
    log: { ...step("run", "Built 5 printed parts", "manifold3d, no overlaps"), seconds: 39, hold: [0.5, 0.85] },
  },
  {
    id: "drawing",
    length: 125,
    still: 0.85,
    rail: "Rewind",
    readout: "rewind",
    tells: "trace",
    log: { ...step("write", "Astra drew drawing.html", "clearances checked"), seconds: 26, hold: [0.5, 0.9] },
  },
  {
    id: "params",
    length: 105,
    still: 0.75,
    rail: "Rewind",
    readout: "rewind",
    tells: "trace",
    log: { ...step("write", "Wrote params.json", "unknown sizes marked TBD"), seconds: 12, hold: [0.4, 0.85] },
  },
  {
    id: "request",
    length: 110,
    still: 0.6,
    rail: "Request",
    readout: "rewind",
    tells: "copy",
    fadeIn: [0.16, 0.42],
    fadeOut: null,
    log: { line: "The request.", seconds: 0, hold: [0.3, 1] },
  },
] as const satisfies readonly StageRow[];

export type Stage = (typeof STAGES)[number];
export type StageId = Stage["id"];
export type CopyStage = Extract<Stage, { tells: "copy" }>;

/** The stages their own copy tells, in story order. */
export const COPY_STAGES = STAGES.filter((stage): stage is CopyStage => stage.tells === "copy");

/** The agent's trace, oldest step first, as the studio lists it. The rewind reads it from the bottom up. */
export const TRACE = STAGES.filter((stage): stage is Extract<Stage, { tells: "trace" }> => stage.tells === "trace").reverse();

// Filled for every stage by the loop below.
const timing = {} as Record<StageId, { start: number; length: number; index: number }>;
let cursor = 0;
for (const [index, stage] of STAGES.entries()) {
  timing[stage.id] = { start: cursor, length: stage.length, index };
  cursor += stage.length;
}
/** Length of the full-motion story in vh. */
export const TOTAL = cursor;

/** P at progress t through a stage. */
export const at = (id: StageId, t = 0) => timing[id].start + timing[id].length * t;
/** Progress through a stage at P, 0 to 1. */
export const progress = (id: StageId, P: number) => clamp((P - timing[id].start) / timing[id].length);
/** A smooth 0 to 1 ramp between two points of one stage. */
export const ramp = (id: StageId, from: number, to: number, P: number) => smoothstep(at(id, from), at(id, to), P);

export function stageAt(P: number): Stage {
  let current: Stage = STAGES[0];
  for (const stage of STAGES) if (P >= timing[stage.id].start) current = stage;
  return current;
}

// ---------------------------------------------------------------- motion

/** "full" scrubs the story with the scroll. "still" shows each stage as one still, for reduced motion. */
export type Motion = "full" | "still";

/** Under reduced motion every stage gets one screen of scroll. */
const STILL_LENGTH = 100;

/** Scroll length of the story track in vh, plus one screen that holds the last stage under the end section. */
export const trackLength = (motion: Motion) => (motion === "full" ? TOTAL : STAGES.length * STILL_LENGTH) + 100;

/** The story position P for a scroll offset in vh. */
export function positionAt(scrollVh: number, motion: Motion): number {
  if (motion === "full") return clamp(scrollVh, 0, TOTAL);
  const index = clamp(Math.floor(scrollVh / STILL_LENGTH), 0, STAGES.length - 1);
  const stage = STAGES[index] ?? STAGES[0];
  return at(stage.id, stage.still);
}

/** The scroll offset in vh that shows a stage, at progress t with motion on. */
export const scrollFor = (id: StageId, t: number, motion: Motion) =>
  motion === "full" ? at(id, t) : timing[id].index * STILL_LENGTH;

/** How far down the story P is, 0 to 1, for the rail marker. Under reduced motion it steps with the stages. */
export const storyFraction = (P: number, motion: Motion) =>
  motion === "full" ? clamp(P / TOTAL) : timing[stageAt(P).id].index / STAGES.length;

/** Opacity and lift of a stage's copy at P. Under reduced motion the current stage shows and the rest hide. */
export function copyAt(stage: CopyStage, P: number, motion: Motion): { alpha: number; y: number } {
  if (motion === "still") return { alpha: stageAt(P).id === stage.id ? 1 : 0, y: 0 };
  const t = (P - timing[stage.id].start) / timing[stage.id].length;
  if (t < -0.05 || t > 1.05) return { alpha: 0, y: 0 };
  const inT = stage.fadeIn ? smoothstep(stage.fadeIn[0], stage.fadeIn[1], t) : 1;
  const outT = stage.fadeOut ? smoothstep(stage.fadeOut[0], stage.fadeOut[1], t) : 0;
  return { alpha: inT * (1 - outT), y: 14 * (1 - inT) - 14 * outT };
}

// ---------------------------------------------------------------- rail

/** Rail stops: each lights up for its stages and jumps to its target. */
export const RAIL = [
  { label: "Printer", target: ["hero", 0] },
  { label: "Teardown", target: ["explode", 0.9] },
  { label: "Build plate", target: ["dive", 0.95] },
  { label: "Print", target: ["print", 0.6] },
  { label: "Rewind", target: ["guide", 0.75] },
  { label: "Request", target: ["request", 0.6] },
] as const satisfies readonly { label: Stage["rail"]; target: readonly [StageId, number] }[];

export type RailStop = (typeof RAIL)[number];

/** Where a rail stop sits along the rail, 0 to 1: the start of its first stage. */
export function railPosition(stop: RailStop, motion: Motion): number {
  const first = STAGES.find((stage) => stage.rail === stop.label) ?? STAGES[0];
  return motion === "full" ? at(first.id) / TOTAL : timing[first.id].index / STAGES.length;
}

// ---------------------------------------------------------------- camera

/** Where the subject sits on screen: [width, height, shift x, shift y] as viewport fractions. */
type Framing = readonly [number, number, number, number];

const FRAMES = {
  hero: { desktop: [0.5, 0.74, 0.17, 0.02], phone: [0.82, 0.46, 0, 0.045] },
  explode: { desktop: [0.3, 0.8, 0.09, 0.02], phone: [0.54, 0.6, -0.025, 0.01] },
  plate: { desktop: [0.5, 0.56, 0.15, 0.02], phone: [0.9, 0.36, 0, 0.03] },
  print: { desktop: [0.5, 0.5, 0.122, -0.085], phone: [1.3, 0.36, 0, -0.01] },
  story: { desktop: [0.5, 0.62, 0.02, 0.02], phone: [0.96, 0.4, 0, -0.02] },
  drawing: { desktop: [0.5, 0.56, 0.02, 0], phone: [0.8, 0.3, 0, -0.03] },
} as const satisfies Record<string, { desktop: Framing; phone: Framing }>;

export type CameraKey = {
  stage: StageId;
  t: number;
  /** What the camera looks at: the printer's origin, the plate's top centre, or the mount's station below it, lifted in metres. */
  target: "printer" | "plate" | "station";
  lift: number;
  /** Degrees around and above the target. */
  yaw: number;
  pitch: number;
  /** The width and height in metres that must fit the framing. */
  fit: readonly [number, number];
  fov: number;
  frame: { desktop: Framing; phone: Framing };
};

export const CAMERA: readonly CameraKey[] = [
  { stage: "hero", t: 0, target: "printer", lift: 0.25, yaw: 30, pitch: 9, fit: [0.64, 0.58], fov: 28, frame: FRAMES.hero },
  { stage: "hero", t: 0.8, target: "printer", lift: 0.25, yaw: 30, pitch: 9, fit: [0.64, 0.58], fov: 28, frame: FRAMES.hero },
  // The camera pulls back ahead of the lid, so no part ever leaves the frame.
  { stage: "explode", t: 0.15, target: "printer", lift: 0.6, yaw: 33, pitch: 11, fit: [1.2, 1.56], fov: 28, frame: FRAMES.explode },
  { stage: "explode", t: 1, target: "printer", lift: 0.6, yaw: 38, pitch: 11, fit: [1.2, 1.56], fov: 28, frame: FRAMES.explode },
  { stage: "dive", t: 0.92, target: "plate", lift: 0, yaw: 40, pitch: 40, fit: [0.38, 0.27], fov: 28, frame: FRAMES.plate },
  { stage: "print", t: 0.08, target: "plate", lift: 0.008, yaw: 27, pitch: 31, fit: [0.235, 0.15], fov: 28, frame: FRAMES.print },
  { stage: "print", t: 0.96, target: "plate", lift: 0.014, yaw: 9, pitch: 25, fit: [0.215, 0.14], fov: 28, frame: FRAMES.print },
  { stage: "slices", t: 0.5, target: "plate", lift: 0.036, yaw: 2, pitch: 16, fit: [0.25, 0.16], fov: 28, frame: FRAMES.print },
  { stage: "slices", t: 0.92, target: "plate", lift: 0.02, yaw: 8, pitch: 20, fit: [0.25, 0.16], fov: 28, frame: FRAMES.print },
  { stage: "guide", t: 0.62, target: "station", lift: -0.01, yaw: 28, pitch: 22, fit: [0.5, 0.36], fov: 28, frame: FRAMES.story },
  { stage: "guide", t: 1, target: "station", lift: -0.03, yaw: 40, pitch: 20, fit: [0.5, 0.4], fov: 28, frame: FRAMES.story },
  { stage: "adapter", t: 0.5, target: "station", lift: -0.055, yaw: 124, pitch: 12, fit: [0.3, 0.38], fov: 28, frame: FRAMES.story },
  { stage: "adapter", t: 0.78, target: "station", lift: -0.055, yaw: 124, pitch: 12, fit: [0.34, 0.38], fov: 28, frame: FRAMES.story },
  { stage: "parts", t: 0.55, target: "station", lift: 0.015, yaw: 34, pitch: 26, fit: [0.62, 0.34], fov: 28, frame: FRAMES.story },
  { stage: "parts", t: 0.9, target: "station", lift: 0.015, yaw: 30, pitch: 24, fit: [0.62, 0.34], fov: 28, frame: FRAMES.story },
  { stage: "drawing", t: 0.5, target: "station", lift: -0.004, yaw: 0, pitch: 0, fit: [0.5, 0.3], fov: 9, frame: FRAMES.drawing },
  { stage: "drawing", t: 1, target: "station", lift: -0.004, yaw: 0, pitch: 0, fit: [0.5, 0.3], fov: 9, frame: FRAMES.drawing },
  { stage: "params", t: 0.8, target: "station", lift: -0.004, yaw: 0, pitch: 0, fit: [0.3, 0.18], fov: 9, frame: FRAMES.drawing },
  { stage: "request", t: 1, target: "station", lift: -0.004, yaw: 0, pitch: 0, fit: [0.3, 0.18], fov: 9, frame: FRAMES.drawing },
];

// ---------------------------------------------------------------- teardown and print

/** How far a part has lifted at P, 0 to 1. Parts lift in turn through the teardown. */
export function liftAt(part: Part, P: number): number {
  if (part.lift === null) return 0;
  return clamp((progress("explode", P) - 0.06 - part.lift * 0.071) / 0.17);
}

/** What the right shelf has printed by P, 0 to 1. */
export const printedAt = (P: number) => (P < at("print") ? 0 : clamp((progress("print", P) - 0.08) / 0.82));

/** A part's leader label draws in as the part lifts and leaves on the dive. The plate's label holds through the dive. */
export function labelAlpha(part: Part, P: number): number {
  if (part.lift === null) return ramp("explode", 0.88, 0.97, P) * (1 - ramp("print", 0, 0.08, P));
  return smoothstep(0.12, 0.6, liftAt(part, P)) * (1 - ramp("dive", 0, 0.3, P));
}

/** The mount fades away as the story rewinds past the drawing into params.json. */
export const mountAlpha = (P: number) => 1 - ramp("params", 0.05, 0.55, P);

/**
 * The overlays that are not a stage's own copy or the trace: the drawing's dimensions and params.json.
 * The dimensions are gone before params.json fades in over the same spot.
 */
export const overlaysAt = (P: number) => ({
  dimensions: ramp("drawing", 0.5, 0.78, P) * (1 - ramp("params", 0.05, 0.3, P)),
  params: ramp("params", 0.3, 0.6, P) * (1 - ramp("request", 0, 0.16, P)),
});

// ---------------------------------------------------------------- readout

export type PrintFacts = { heightMm: number; layerMm: number; layers: number };

export type ReadoutView = {
  kick: string;
  kickNote: string;
  value: string;
  /** Shown after the value in a lighter tone, e.g. "/12". */
  of: string;
  unit: string;
  line: string;
  note: string;
};

const TIME_KEYS = STAGES.flatMap(({ id, log }) => (log ? log.hold.map((t) => ({ at: at(id, t), seconds: log.seconds })) : []));

/** The rewind clock at P, in seconds: holds on each log line and runs between them. */
function elapsedAt(P: number): number {
  let seconds: number = TIME_KEYS[0]?.seconds ?? 0;
  for (const [i, key] of TIME_KEYS.entries()) {
    const next = TIME_KEYS[i + 1];
    if (next && P >= key.at) seconds = lerp(key.seconds, next.seconds, clamp((P - key.at) / (next.at - key.at)));
  }
  return seconds;
}

/** Seconds as m:ss. */
export const minutes = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function readoutAt(P: number, print: PrintFacts): ReadoutView {
  const stage = stageAt(P);
  switch (stage.readout) {
    case "teardown": {
      const lifting = PARTS.filter((part) => part.lift !== null && liftAt(part, P) > 0.02);
      const lifted = PARTS.filter((part) => part.lift !== null && liftAt(part, P) > 0.5).length;
      const done = lifted >= LIFTED_PARTS;
      return {
        kick: "Parts lifted",
        kickNote: "Top down",
        value: String(lifted).padStart(2, "0"),
        of: `/${LIFTED_PARTS}`,
        unit: "",
        line: done ? "Build plate, textured PEI" : (lifting.at(-1)?.label ?? "Assembled"),
        note: done ? "256 × 256 mm" : "392 × 406 × 478 mm outer",
      };
    }
    case "print": {
      const height = print.heightMm * printedAt(P);
      const layer = Math.min(print.layers, Math.round(height / print.layerMm));
      return {
        kick: "Z height",
        kickNote: "Illustrative",
        value: height.toFixed(2),
        of: "",
        unit: "mm",
        line: `Layer ${String(layer).padStart(3, "0")} / ${print.layers}`,
        note: `${print.layerMm.toFixed(2)} mm layers · nozzle 255 °C · bed 70 °C`,
      };
    }
    case "rewind":
      return {
        kick: "Elapsed",
        kickNote: "Rewinding",
        value: minutes(elapsedAt(P)),
        of: "",
        unit: "",
        line: stage.log.line,
        note: "One request · 2 print files",
      };
  }
}

// ---------------------------------------------------------------- trace

export type TraceView = {
  /** Above the card: how the part got here while every step shows, then the rewind time of the newest step left. */
  kick: string;
  done: boolean;
  head: string;
  count: string;
  /** How far each trace line is in, oldest first: 1 shown, 0 gone. */
  lines: number[];
  /** The whole card's opacity. */
  alpha: number;
};

/**
 * The trace card at P. It comes in with the rewind and leaves before the request. A step's line leaves from the
 * bottom once the rewind clock runs back past its hold, so the card always ends on the step the clock is at.
 * The oldest line goes with the card.
 */
export function traceAt(P: number): TraceView {
  const lines = TRACE.map(({ id, log }, i) => (i === 0 ? 1 : 1 - ramp(id, log.hold[1], log.hold[1] + 0.12, P)));
  const shown = lines.filter((alpha) => alpha >= 0.5).length;
  const newest = TRACE[shown - 1]?.log.seconds ?? 0;
  const done = shown === TRACE.length;
  return {
    kick: `${done ? "How it got here" : "Rewind"} · ${minutes(newest)}`,
    done,
    head: done ? `Worked for ${Math.round(newest / 60)} min` : `Working for ${minutes(elapsedAt(P))}`,
    count: done ? `${TRACE.length} steps` : `step ${shown} of ${TRACE.length}`,
    lines,
    alpha: ramp("slices", 0.02, 0.14, P) * (1 - ramp("request", 0, 0.16, P)),
  };
}
