//! The `part` kind: any solid, written as build123d.
//!
//! A spec carries the model's script, its params, the person's measurements as
//! requirements, and the filaments. The script runs only in the CAD worker's
//! generation guest ([`CadRuntime::generate`]); a fresh inspection guest
//! normalizes what it made ([`CadRuntime::normalize`]); and everything after
//! that is Rust: the mesh is welded to the µm grid, and the mesh checks, the
//! requirement checks, and the advisory print checks all measure that mesh.
//! The script's own asserts and prints never count as checks.
//!
//! The package names the part's object `part-` plus the first 12 hex digits
//! of its build key ([`ObjectNaming::BuildKey`]), so Bambu Studio's exact
//! support warning about it can be told apart and recorded as the advisory
//! `slice.support_warning`. The normalized STEP rides in the package
//! ([`ExtraArtifact::Step`]), so approval covers it.

mod measure;
mod preview;
pub mod self_test;
mod spec;

#[cfg(test)]
pub(crate) mod tests;

#[cfg(all(test, any(target_os = "macos", all(target_os = "linux", feature = "linux-cad-test"))))]
mod backend_tests;

pub use spec::{
    is_requirement_check, Axis, Filament, MeasuredRequirement, ParamValue, PartSpec, Requirement, ValidPart, PART_SCHEMA_VERSION,
};

use crate::fabrication::cad_worker::{CadJob, CadRuntime, RawBody, WorkerError, WorkerLimits};
use crate::fabrication::layers::slice::MAX_TRIANGLES;
use crate::fabrication::checks::{slice_and_handoff_checks, slice_support_warning, CheckId, CheckOutcome, CheckPhase, CheckPlan, CheckPlanId, InvalidPlan};
use crate::fabrication::kind::{
    BuildControl, Built, ExtraArtifact, KernelContext, KernelError, KindId, ObjectKind, ObjectNaming, SpecError, View, ViewSet,
};
use crate::fabrication::model::{Body, PrintableModel};
use crate::fabrication::pipeline::Stage;
use crate::fabrication::printer::PrinterProfile;

/// Version of the part's check plan. Per body: four mesh checks and three
/// advisory print checks; one check per requirement; then the shared slice
/// and handoff checks and the advisory support warning.
pub const PART_CHECK_PLAN: CheckPlanId = CheckPlanId::new("part-checks-1");

/// The mesh checks every body passes, in recorded order.
const MESH_CHECKS: [&str; 4] = ["closed_manifold", "non_degenerate", "outward_orientation", "bounds"];
/// The advisory print checks every body gets, in recorded order.
const PRINT_CHECKS: [&str; 3] = ["overhang", "min_wall", "first_layer"];

/// The `part` kind.
pub struct Part;

impl ObjectKind for Part {
    type Spec = PartSpec;
    type Valid = ValidPart;

    const ID: KindId = KindId::new("part");
    /// The runtime image, the inspector, the tessellation, and the sandbox
    /// policy join the build key too ([`Part::key_inputs`]).
    const TAG: &'static str = "part-1";
    const SUMMARY: &'static str = "any solid, written as build123d";
    /// `describe_kind` text: a worked example and build123d idioms.
    const GUIDE: &'static str = include_str!("part_guide.md");
    /// The script contract, which the system prompt carries.
    const PROMPT_GUIDE: &'static str = include_str!("part_contract.md");
    const NAMING: ObjectNaming = ObjectNaming::BuildKey;

    fn available(ctx: &KernelContext) -> bool {
        ctx.runtime.is_some()
    }

    fn key_inputs(ctx: &KernelContext) -> Vec<String> {
        ctx.runtime.as_ref().map(CadRuntime::key_inputs).unwrap_or_default()
    }

    fn validate(spec: PartSpec, printer: &PrinterProfile) -> Result<ValidPart, SpecError> {
        ValidPart::parse(spec, printer)
    }

    fn title(valid: &ValidPart) -> String {
        valid.title().to_owned()
    }

    /// The checks known before the script runs: one per requirement, then the
    /// slice and handoff checks. [`Part::bind_plan`] adds every body's checks
    /// once the bodies exist.
    fn check_plan(valid: &ValidPart, _printer: &PrinterProfile) -> Result<CheckPlan, InvalidPlan> {
        plan(valid, &[])
    }

    /// The declared plan with every body's mesh and print checks. The script
    /// chooses its bodies' names, never which checks a body gets.
    fn bind_plan(valid: &ValidPart, _printer: &PrinterProfile, model: &PrintableModel) -> Result<CheckPlan, InvalidPlan> {
        let bodies: Vec<&str> = model.bodies().iter().map(|b| b.name.as_str()).collect();
        plan(valid, &bodies)
    }

    /// Generation, then inspection, through the CAD runtime. Returns the
    /// inspector's mesh on the µm grid and its normalized STEP.
    fn model(valid: &ValidPart, ctx: &KernelContext, control: &BuildControl<'_>) -> Result<Built, KernelError> {
        let runtime = ctx.runtime.as_ref().ok_or_else(|| KernelError::Failed("the CAD runtime is unavailable".into()))?;
        let job = CadJob { source: valid.source().to_owned(), params: valid.params_json() };
        let generated = runtime.generate(&job, &WorkerLimits::PART, control).map_err(|e| worker_error(Stage::Generate, e))?;
        let slots = generated.bodies.slots(valid.palette()).map_err(|e| stage(Stage::Generate, e.to_string()))?;
        if control.is_cancelled() {
            return Err(KernelError::Cancelled);
        }
        let normalized = runtime
            .normalize(generated.step, &generated.bodies, &WorkerLimits::PART, control)
            .map_err(|e| worker_error(Stage::Inspect, e))?;
        within_slicing_limit(&normalized.bodies)?;
        let names = generated.bodies.bodies();
        if normalized.bodies.len() != names.len() {
            return Err(stage(
                Stage::Inspect,
                format!("the inspector found {} solids, but build() returned {} bodies", normalized.bodies.len(), names.len()),
            ));
        }
        let bodies = names
            .iter()
            .zip(slots)
            .zip(&normalized.bodies)
            .map(|(((name, _), slot), raw)| Body { name: name.as_str().to_owned(), slot, mesh: raw.weld() })
            .collect();
        let model = PrintableModel::new(valid.title().to_owned(), valid.palette().clone(), bodies)
            .map_err(|e| stage(Stage::Generate, e.to_string()))?;
        Ok(Built { model, extra: vec![ExtraArtifact::Step(normalized.step)] })
    }

    fn measure(valid: &ValidPart, model: &PrintableModel, control: &BuildControl<'_>) -> Result<Vec<CheckOutcome>, KernelError> {
        measure::measure(valid, model, &|| control.is_cancelled())
    }

    /// Isometric, front, and top views of the welded mesh.
    fn preview(_valid: &ValidPart, model: &PrintableModel) -> Result<ViewSet, KernelError> {
        let views = [View::Isometric, View::Front, View::Top]
            .into_iter()
            .map(|view| preview::render(model, view).map(|png| (view, png)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(KernelError::Failed)?;
        ViewSet::new(views)
    }
}

/// The part's plan for `bodies`: each body's mesh checks, every requirement,
/// each body's print checks, then the slice and handoff checks with the
/// support warning last.
fn plan(valid: &ValidPart, bodies: &[&str]) -> Result<CheckPlan, InvalidPlan> {
    let per_body = |phase: CheckPhase, names: &[&str]| -> Vec<CheckId> {
        bodies.iter().flat_map(|body| names.iter().map(move |name| CheckId::new(phase, &format!("{name}.{body}")))).collect()
    };
    let mut required = per_body(CheckPhase::Geometry, &MESH_CHECKS);
    required.extend(valid.requirements().iter().map(MeasuredRequirement::check_id));
    required.extend(per_body(CheckPhase::Print, &PRINT_CHECKS));
    required.extend(slice_and_handoff_checks());
    required.push(slice_support_warning());
    CheckPlan::new(PART_CHECK_PLAN, required)
}

/// Refuses a mesh with more triangles than the layer checks slice, so a part
/// is never verified without its print checks.
fn within_slicing_limit(bodies: &[RawBody]) -> Result<(), KernelError> {
    let triangles: usize = bodies.iter().map(RawBody::triangle_count).sum();
    if triangles > MAX_TRIANGLES {
        return Err(stage(
            Stage::Inspect,
            format!("the solid tessellates into {triangles} triangles; at most {MAX_TRIANGLES} are allowed, so simplify the model"),
        ));
    }
    Ok(())
}

fn stage(stage: Stage, error: String) -> KernelError {
    KernelError::Stage { stage, error }
}

fn worker_error(at: Stage, error: WorkerError) -> KernelError {
    match error {
        WorkerError::Cancelled => KernelError::Cancelled,
        WorkerError::Internal(why) => KernelError::Failed(why),
        other => stage(at, other.to_string()),
    }
}
