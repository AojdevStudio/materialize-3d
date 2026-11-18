/**
 * The printer's teardown. site/models/blender/build_printer.py writes printer-parts.json beside printer.glb: each
 * part's object name and label, in the order the labels number them, and the printer's sizes. This file adds how
 * the page lays out each part. `anchor` is the point a leader line starts from, in metres on the assembled printer.
 * `lift` is the part's turn in the top-down teardown (parts that share a turn lift together). The build plate never
 * lifts: it is where the story goes next.
 */
import printer from "../assets/story/printer-parts.json" with { type: "json" };

type Layout = {
  /** The label on narrow screens. */
  short: string;
  anchor: readonly [x: number, y: number, z: number];
  side: "left" | "right";
  lift: number | null;
};

const LAYOUT = {
  lid: { short: "Glass lid", anchor: [0.15, 0.476, 0.16], side: "right", lift: 0 },
  screen: { short: "Touchscreen", anchor: [-0.04, 0.47, 0.215], side: "right", lift: 1 },
  top_frame: { short: "Top frame", anchor: [0.196, 0.445, 0.1], side: "right", lift: 2 },
  toolhead: { short: "Toolhead", anchor: [0.034, 0.385, 0.085], side: "right", lift: 3 },
  gantry: { short: "CoreXY gantry", anchor: [0.16, 0.392, -0.04], side: "right", lift: 4 },
  door: { short: "Front door", anchor: [-0.1, 0.33, 0.203], side: "left", lift: 5 },
  panel_left: { short: "Side panel", anchor: [-0.196, 0.3, 0], side: "left", lift: 6 },
  panel_right: { short: "Side panel", anchor: [0.196, 0.25, 0.06], side: "right", lift: 6 },
  panel_back: { short: "Back panel", anchor: [0.12, 0.36, -0.203], side: "right", lift: 7 },
  frame: { short: "Frame, Z rods", anchor: [0.182, 0.34, 0.188], side: "right", lift: 8 },
  // The heatbed reads from its left edge, so the bottom right does not crowd with the side panel and the plate.
  bed: { short: "Heatbed", anchor: [-0.131, 0.158, 0.06], side: "left", lift: 9 },
  base: { short: "Base", anchor: [0.196, 0.03, 0.12], side: "right", lift: 10 },
  build_plate: { short: "Build plate", anchor: [0.11, 0.165, 0.1], side: "right", lift: null },
} as const satisfies Record<string, Layout>;

const laidOut = (name: string): name is keyof typeof LAYOUT => Object.hasOwn(LAYOUT, name);

export const PARTS = printer.parts.map(({ name, label }) => {
  if (!laidOut(name)) throw new Error(`printer-parts.json: the teardown has no layout for ${name}`);
  return { name, label, ...LAYOUT[name] };
});
if (PARTS.length !== Object.keys(LAYOUT).length) throw new Error("printer-parts.json: a part with a layout is missing");

export type Part = (typeof PARTS)[number];

/** The parts that lift, the count the readout shows. */
export const LIFTED_PARTS = PARTS.filter((part) => part.lift !== null).length;

const plate = PARTS.find((part) => part.lift === null);
if (!plate) throw new Error("the teardown has no part that stays put");

/** The part left standing at the end of the teardown, with the printer's outer size and print area in mm. */
export const PRINTER = { plate: plate.label, outerMm: printer.outer_mm, areaMm: printer.build_volume_mm.slice(0, 2) };
