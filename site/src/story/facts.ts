/**
 * The dock mount facts the story quotes, read once from dock-data.json. The file
 * comes from site/models/dock/dock_mesh.py, which reads the mount's own params.json,
 * so every size on the page is the size the agent wrote. Lengths are in millimetres.
 */
import dock from "../assets/story/dock-data.json";
import type { PrintFacts } from "./timeline";

type Tuple<N extends number, T extends number[] = []> = T["length"] extends N ? T : Tuple<N, [...T, number]>;

/** Reads exactly n numbers from the file, as a tuple. */
function exactly<N extends number>(values: readonly number[], n: N, what: string): Readonly<Tuple<N>> {
  if (values.length !== n) throw new Error(`dock-data.json: ${what} needs ${n} numbers, got ${values.length}`);
  return values as unknown as Tuple<N>;
}

const [boxX0, boxX1, boxY0, boxY1, boxZ0, boxZ1] = exactly(dock.dock_box_mm, 6, "dock_box_mm");

/** The printed part's size on the plate (x, y, height). */
export const PRINT_SIZE = exactly(dock.print_size_mm, 3, "print_size_mm");

export const PRINT: PrintFacts = { heightMm: PRINT_SIZE[2], layerMm: dock.layer_mm, layers: dock.layers };

/** The printed part's pose on the plate, column-major, three.js axes, metres. */
export const PRINT_MATRIX = exactly(dock.print_matrix, 16, "print_matrix");

const [assemblyWidth, , assemblyHeight] = exactly(dock.assembly_mm, 3, "assembly_mm");

/** How far the rails and shelves move apart in the exploded view. */
export const EXPLODE = { railY: dock.explode_mm.rail_y, shelfX: dock.explode_mm.shelf_x };

/** The dock itself, drawn dashed as a reference box in the mount's axes. */
export const DOCK_BOX = { x: [boxX0, boxX1], y: [boxY0, boxY1], z: [boxZ0, boxZ1] } as const;

const { params, tbd } = dock;

/** The params.json keys the story shows, in order. */
const PARAM_KEYS = [
  "dock_width_mm",
  "dock_height_mm",
  "dock_depth_mm",
  "fit_clearance_each_side_mm",
  "clear_width_mm",
  "plate_width_mm",
  "plate_height_mm",
  "plate_thickness_mm",
  "rail_height_mm",
  "wing_width_mm",
  "printed_part_count",
] as const satisfies readonly (keyof typeof params)[];

const TBD_KEYS = ["dock_body", "side_vents", "heat_set_inserts", "arm"] as const satisfies readonly (keyof typeof tbd)[];

export const PARAM_ROWS = PARAM_KEYS.map((key) => ({ key, value: params[key] }));
export const TBD_ROWS = TBD_KEYS.map((key) => ({ key, status: tbd[key] }));

/**
 * The drawing's dimension lines on the front elevation, in metres from the mount's
 * centre. Each runs `from` to `to`, drawn `offset` away from the part, with its label.
 */
export type Dimension = {
  from: readonly [number, number];
  to: readonly [number, number];
  offset: readonly [number, number];
  value: number;
  text: string;
};

const halfWidth = assemblyWidth / 2000;
const halfHeight = assemblyHeight / 2000;
const halfClear = params.clear_width_mm / 2000;

export const DIMENSIONS: readonly Dimension[] = [
  { from: [-halfWidth, -halfHeight], to: [halfWidth, -halfHeight], offset: [0, -0.034], value: assemblyWidth, text: "overall" },
  { from: [halfWidth, -halfHeight], to: [halfWidth, halfHeight], offset: [0.03, 0], value: assemblyHeight, text: "" },
  {
    from: [-halfClear, halfHeight],
    to: [halfClear, halfHeight],
    offset: [0, 0.026],
    value: params.clear_width_mm,
    text: `clear. Dock ${params.dock_width_mm} + ${params.fit_clearance_each_side_mm} each side`,
  },
];
