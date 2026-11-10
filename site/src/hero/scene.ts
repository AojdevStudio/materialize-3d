/**
 * The hero's scene model. One loop tells one job: a request typed on the start
 * screen, the agent working through six steps, the guide opening, and the
 * dock mount landing in Ready to print with its print files.
 */

export type Beat = "type" | "work" | "guide" | "payoff";

export type Scene = {
  beat: Beat;
  /** The request as typed so far on the start screen. */
  draft: string;
  /** Trace lines landed, 0 to TRACE.length. */
  steps: number;
};

export type Status = "working" | "ready" | "printed";

export type Project = { title: string; detail: string; time: string };

type BeatView = {
  screen: "start" | "chat";
  /** Where the dock mount sits in the sidebar, or null before it exists. */
  dock: Exclude<Status, "printed"> | null;
  guide: boolean;
  done: boolean;
};

export const BEATS = {
  type: { screen: "start", dock: null, guide: false, done: false },
  work: { screen: "chat", dock: "working", guide: false, done: false },
  guide: { screen: "chat", dock: "working", guide: true, done: false },
  payoff: { screen: "chat", dock: "ready", guide: true, done: true },
} as const satisfies Record<Beat, BeatView>;

export const REQUEST = "Make a mount for my UGREEN dock under the monitor arm. Photo attached.";

export const GROUPS = [
  { status: "working", label: "Working" },
  { status: "ready", label: "Ready to print" },
  { status: "printed", label: "Printed" },
] as const satisfies readonly { status: Status; label: string }[];

/** The projects already in the sidebar before this loop's job. */
export const SHELF: Record<Status, readonly Project[]> = {
  working: [{ title: "Phone stand", detail: "Building parts", time: "2m" }],
  ready: [{ title: "2x2 cube", detail: "1 print file", time: "3d" }],
  printed: [{ title: "Cable clip", detail: "PETG", time: "Oct 30" }],
};

export const DOCK = {
  working: { title: "Dock mount", detail: "Building parts", time: "now" },
  ready: { title: "Dock mount", detail: "2 print files", time: "1h" },
} as const satisfies Record<Exclude<Status, "printed">, Project>;

export type TraceIcon = "file" | "terminal" | "layers";

/** `elapsed` is the header's clock once that step has landed. */
export const TRACE = [
  { icon: "file", title: "Wrote params.json", detail: "unknown sizes marked TBD", elapsed: "0:12" },
  { icon: "file", title: "Astra drew drawing.html", detail: "clearances checked", elapsed: "0:26" },
  { icon: "terminal", title: "Built 5 printed parts", detail: "manifold3d, no overlaps", elapsed: "0:39" },
  { icon: "terminal", title: "Added the revision C arm adapter", detail: "", elapsed: "6:05" },
  { icon: "file", title: "Wrote assembly-guide.html", detail: "13 steps", elapsed: "9:47" },
  { icon: "layers", title: "Sliced 2 print files", detail: "PETG Basic", elapsed: "13:58" },
] as const satisfies readonly { icon: TraceIcon; title: string; detail: string; elapsed: string }[];

export const PRINT_FILES = [
  { name: "ugreen-dock-mount-revB.3mf", contents: "Back plate, 2 rails, 2 shelves" },
  { name: "ugreen-dock-mount-revC-adapter.3mf", contents: "Arm adapter, 4 walls, 40% infill" },
] as const;

export const SUGGESTIONS = ["A mount or bracket", "A replacement part", "A desk organizer", "Something from a photo"] as const;

export const initial: Scene = { beat: "type", draft: "", steps: 0 };

/** The frame most people see: the finished part, ready to print. */
export const poster: Scene = { beat: "payoff", draft: "", steps: TRACE.length };
