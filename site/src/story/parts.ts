/**
 * The printer's teardown, one row per part in the order the labels number them.
 * `name` is the object name in printer.glb. `anchor` is the point a leader line
 * starts from, in metres on the assembled printer. `lift` is the part's turn in
 * the top-down teardown (parts that share a turn lift together). The build plate
 * never lifts: it is where the story goes next.
 */

export type Side = "left" | "right";

type PartRow = {
  name: string;
  label: string;
  /** The label on narrow screens. */
  short: string;
  anchor: readonly [x: number, y: number, z: number];
  side: Side;
  lift: number | null;
};

export const PARTS = [
  { name: "lid", label: "Top glass lid", short: "Glass lid", anchor: [0.15, 0.476, 0.16], side: "right", lift: 0 },
  { name: "screen", label: "Touchscreen", short: "Touchscreen", anchor: [-0.04, 0.47, 0.215], side: "right", lift: 1 },
  { name: "top_frame", label: "Top frame", short: "Top frame", anchor: [0.196, 0.445, 0.1], side: "right", lift: 2 },
  { name: "toolhead", label: "Toolhead", short: "Toolhead", anchor: [0.034, 0.385, 0.085], side: "right", lift: 3 },
  { name: "gantry", label: "CoreXY gantry, rods and belts", short: "CoreXY gantry", anchor: [0.16, 0.392, -0.04], side: "right", lift: 4 },
  { name: "door", label: "Front door", short: "Front door", anchor: [-0.1, 0.33, 0.203], side: "left", lift: 5 },
  { name: "panel_left", label: "Side panel", short: "Side panel", anchor: [-0.196, 0.3, 0], side: "left", lift: 6 },
  { name: "panel_right", label: "Side panel", short: "Side panel", anchor: [0.196, 0.25, 0.06], side: "right", lift: 6 },
  { name: "panel_back", label: "Back panel", short: "Back panel", anchor: [0.12, 0.36, -0.203], side: "right", lift: 7 },
  { name: "frame", label: "Frame, Z rods, lead screws", short: "Frame, Z rods", anchor: [0.182, 0.34, 0.188], side: "right", lift: 8 },
  // The heatbed reads from its left edge, so the bottom right does not crowd with the side panel and the plate.
  { name: "bed", label: "Heatbed", short: "Heatbed", anchor: [-0.131, 0.158, 0.06], side: "left", lift: 9 },
  { name: "base", label: "Base", short: "Base", anchor: [0.196, 0.03, 0.12], side: "right", lift: 10 },
  { name: "build_plate", label: "Build plate, textured PEI", short: "Build plate", anchor: [0.11, 0.165, 0.1], side: "right", lift: null },
] as const satisfies readonly PartRow[];

export type Part = (typeof PARTS)[number];
export type PartName = Part["name"];

/** The parts that lift, the count the readout shows. */
export const LIFTED_PARTS = PARTS.filter((part) => part.lift !== null).length;
