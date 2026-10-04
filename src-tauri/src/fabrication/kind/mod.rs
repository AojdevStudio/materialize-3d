//! Object kinds: one trait, one module per kind.
//!
//! A kind ([`ObjectKind`]) is the one place that knows how a spec becomes
//! bodies on the bed. The blanket [`Kind`] wrapper turns each kind into the
//! object-safe [`KindDriver`] that the pipeline and the tools see, and
//! [`KINDS`] lists every registered kind. Everything after
//! [`KindDriver::prepare`] (packaging, slicing, slice verification, recording)
//! is shared, so the pipeline cannot tell one kind from another.

use std::any::Any;
use std::fmt;
use std::marker::PhantomData;

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use super::package::ExtraArtifact;

use super::cad_worker::CadRuntime;
use super::checks::{CheckId, CheckOutcome, CheckPlan, CheckedModel, ChecksFailed, InvalidPlan};
use super::kinds::part::Part;
use super::kinds::sign::Sign;
use super::model::PrintableModel;
use super::pipeline::{BuildError, BuildStep, Stage};
use super::printer::PrinterProfile;
use super::revisions::Sha256Hex;

/// A registered kind's name. Stored on every revision, and a lineage keeps
/// one kind for life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct KindId(&'static str);

impl KindId {
    pub const fn new(id: &'static str) -> Self {
        Self(id)
    }

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for KindId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

/// A kind of printable object. `validate` is total (no panics on hostile
/// input). A Rust kind's `model` is deterministic for a given `Valid` and
/// [`TAG`](ObjectKind::TAG). A script kind's need not be: its build is
/// idempotent because the first build that verifies under a `build_key` is
/// sealed and reused, never because running the script again gives the same
/// bytes.
pub trait ObjectKind: Send + Sync + 'static {
    /// Untrusted wire shape, `deny_unknown_fields`. Its JSON Schema is what
    /// the `build` tool advertises for this kind.
    type Spec: DeserializeOwned + JsonSchema;
    /// Parsed, range-checked, defaults applied; holding one proves `validate`
    /// ran. Its canonical JSON is hashed into the build key, so anything it
    /// derives from the spec is `#[serde(skip)]`.
    type Valid: Serialize + Send + Sync + 'static;

    const ID: KindId;
    /// Joins `build_key`. Bump it when the output changes for the same spec,
    /// so a retry after an upgrade builds again instead of reusing.
    const TAG: &'static str;
    /// One line naming what the kind makes, for a model choosing a kind.
    const SUMMARY: &'static str;
    /// What `describe_kind` returns: how to write a good spec of this kind.
    const GUIDE: &'static str;
    /// What the system prompt carries under the kind's catalog line. Empty
    /// for a kind a model describes before it builds; `part` puts its script
    /// contract here.
    const PROMPT_GUIDE: &'static str = "";
    /// The views [`ObjectKind::preview`] renders, in order. A build keeps
    /// exactly these, so a view that is not on disk later is reported missing.
    const VIEWS: &'static [View];
    /// What the package names the build's object.
    const NAMING: ObjectNaming = ObjectNaming::Title;

    /// Whether this kind can build with `ctx`. A kind that needs the CAD
    /// runtime is unavailable without it.
    fn available(_ctx: &KernelContext) -> bool {
        true
    }

    /// Inputs besides the validated spec and the slicer that decide this
    /// kind's output, such as the runtime image a script runs in. They join
    /// the build key; a kind with none keeps the key it always had.
    fn key_inputs(_ctx: &KernelContext) -> Vec<String> {
        Vec::new()
    }

    fn validate(spec: Self::Spec, printer: &PrinterProfile) -> Result<Self::Valid, SpecError>;
    fn title(valid: &Self::Valid) -> String;
    /// Every check a build must pass, declared before anything is built.
    fn check_plan(valid: &Self::Valid, printer: &PrinterProfile) -> Result<CheckPlan, InvalidPlan>;
    /// The plan a built `model` is judged by: the declared plan, plus the
    /// checks of bodies only the build could name (a script names its own
    /// bodies). It keeps the declared plan's id and every check the declared
    /// plan names, so a kind can add per-body checks but never drop one.
    fn bind_plan(valid: &Self::Valid, printer: &PrinterProfile, _model: &PrintableModel) -> Result<CheckPlan, InvalidPlan> {
        Self::check_plan(valid, printer)
    }
    /// Builds the bodies on the bed. Blocking, like the slicer; a long kernel
    /// polls `control` and returns [`KernelError::Cancelled`].
    fn model(valid: &Self::Valid, ctx: &KernelContext, control: &BuildControl<'_>) -> Result<Built, KernelError>;
    /// Measures `model` for every geometry and print check the plan names. A
    /// long measurement polls `control` and returns [`KernelError::Cancelled`].
    fn measure(valid: &Self::Valid, model: &PrintableModel, control: &BuildControl<'_>) -> Result<Vec<CheckOutcome>, KernelError>;
    /// The build's views. The first is the preview the app shows; every
    /// view goes back to the model that asked for the build.
    fn preview(valid: &Self::Valid, model: &PrintableModel) -> Result<ViewSet, KernelError>;
}

/// One rendered view of a build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum View {
    /// A sign's finished face, as a person reads it.
    Face,
    /// From the front right, above the bed.
    Isometric,
    /// From the front of the bed, looking along +y.
    Front,
    /// From above, looking down at the bed.
    Top,
}

impl View {
    pub const ALL: [View; 4] = [View::Face, View::Isometric, View::Front, View::Top];

    pub fn as_str(self) -> &'static str {
        match self {
            View::Face => "face",
            View::Isometric => "isometric",
            View::Front => "front",
            View::Top => "top",
        }
    }

    /// The file a build keeps this view in, inside its directory.
    pub fn file_name(self) -> String {
        format!("view-{}.png", self.as_str())
    }
}

/// A build's PNG views: at least one, each view at most once, the preview
/// first.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewSet(Vec<(View, Vec<u8>)>);

impl ViewSet {
    pub fn new(views: Vec<(View, Vec<u8>)>) -> Result<Self, KernelError> {
        let repeated = views.iter().enumerate().any(|(i, (view, _))| views[..i].iter().any(|(seen, _)| seen == view));
        if views.is_empty() || repeated {
            return Err(KernelError::Failed("a view set holds each view once, and at least one".into()));
        }
        Ok(Self(views))
    }

    /// The view the app shows as the build's preview.
    pub fn preview(&self) -> &[u8] {
        &self.0[0].1
    }

    pub fn views(&self) -> &[(View, Vec<u8>)] {
        &self.0
    }
}

/// What a kernel may use besides the spec.
#[derive(Debug, Clone)]
pub struct KernelContext {
    pub printer: PrinterProfile,
    /// The CAD runtime, verified against the digests compiled into this app.
    /// `None` when it is missing or failed verification; a kind that needs it
    /// is then unavailable.
    pub runtime: Option<CadRuntime>,
}

impl KernelContext {
    pub fn without_runtime(printer: PrinterProfile) -> Self {
        Self { printer, runtime: None }
    }
}

/// What the package names a build's object, which is the name Bambu Studio
/// prints in its slicing warnings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectNaming {
    /// The spec's title. Its warnings name text the spec chose, so none can be
    /// told apart from a look-alike and each one fails `slice.no_warnings`.
    Title,
    /// `part-` and the first 12 hex digits of the build key: text the app
    /// chose. Bambu's exact support warning about it is then recorded as the
    /// advisory `slice.support_warning`.
    BuildKey,
}

impl ObjectNaming {
    pub fn object_name(self, title: &str, build_key: &Sha256Hex) -> String {
        match self {
            ObjectNaming::Title => title.to_owned(),
            ObjectNaming::BuildKey => format!("part-{}", &build_key.as_str()[..12]),
        }
    }
}

/// A running build's progress sink and cancel flag.
#[derive(Clone, Copy)]
pub struct BuildControl<'a> {
    progress: &'a dyn Fn(BuildStep),
    cancelled: &'a dyn Fn() -> bool,
}

impl<'a> BuildControl<'a> {
    pub fn new(progress: &'a dyn Fn(BuildStep), cancelled: &'a dyn Fn() -> bool) -> Self {
        Self { progress, cancelled }
    }

    /// Reports a step once it completes.
    pub fn report(&self, step: BuildStep) {
        (self.progress)(step)
    }

    pub fn is_cancelled(&self) -> bool {
        (self.cancelled)()
    }
}

/// What [`ObjectKind::model`] builds.
#[derive(Debug)]
pub struct Built {
    pub model: PrintableModel,
    /// Files the build carries besides the model, such as a STEP. Signs have none.
    pub extra: Vec<ExtraArtifact>,
}

#[derive(Debug, thiserror::Error)]
pub enum KernelError {
    #[error("build cancelled")]
    Cancelled,
    #[error("{0}")]
    Failed(String),
    /// A bounded error a script's author can act on, and where it stopped.
    #[error("{stage}: {error}")]
    Stage { stage: Stage, error: String },
}

/// A spec its kind refused. The message names what to fix; a person or a
/// model reads it as is.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SpecError(pub String);

/// A spec its kind accepted, ready to build. Only [`KindDriver::parse`] makes
/// one, so a spec cannot reach a kernel without validation.
pub struct ParsedSpec {
    kind: KindId,
    tag: &'static str,
    title: String,
    /// The validated spec as JSON: what `spec_sha256` hashes.
    validated: Value,
    spec_sha256: Sha256Hex,
    plan: CheckPlan,
    valid: Box<dyn Any + Send + Sync>,
}

impl ParsedSpec {
    pub fn kind(&self) -> KindId {
        self.kind
    }

    /// The kind's [`ObjectKind::TAG`], for the build key.
    pub fn tag(&self) -> &'static str {
        self.tag
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    /// The validated spec, defaults applied, as JSON.
    pub fn validated(&self) -> &Value {
        &self.validated
    }

    /// SHA-256 of the validated spec's canonical JSON.
    pub fn spec_sha256(&self) -> &Sha256Hex {
        &self.spec_sha256
    }

    pub fn plan(&self) -> &CheckPlan {
        &self.plan
    }
}

/// A model that passed its plan's geometry checks, with its views, ready to
/// package. The checked model carries the build's extras, and `plan` is the
/// bound plan ([`ObjectKind::bind_plan`]) that certified it and finishes it.
pub struct PreparedObject {
    pub checked: CheckedModel,
    pub views: ViewSet,
    pub plan: CheckPlan,
}

/// The object-safe face of a kind, implemented once by [`Kind`]. The
/// pipeline and the tools see only this.
pub trait KindDriver: Send + Sync {
    fn id(&self) -> KindId;
    fn summary(&self) -> &'static str;
    /// See [`ObjectKind::GUIDE`].
    fn guide(&self) -> &'static str;
    /// See [`ObjectKind::PROMPT_GUIDE`].
    fn prompt_guide(&self) -> &'static str;
    /// See [`ObjectKind::VIEWS`].
    fn views(&self) -> &'static [View];
    /// See [`ObjectKind::available`].
    fn available(&self, ctx: &KernelContext) -> bool;
    fn naming(&self) -> ObjectNaming;
    /// See [`ObjectKind::key_inputs`].
    fn key_inputs(&self, ctx: &KernelContext) -> Vec<String>;
    /// JSON Schema of the kind's spec, every subschema inlined.
    fn spec_schema(&self) -> Value;
    fn parse(&self, spec: Value, printer: &PrinterProfile) -> Result<ParsedSpec, SpecError>;
    /// Builds and measures the model, reports [`BuildStep::GeometryBuilt`],
    /// renders the views, and certifies the model against the parsed plan. A
    /// failed blocking geometry check stops it at [`Stage::Geometry`].
    fn prepare(&self, parsed: &ParsedSpec, ctx: &KernelContext, control: &BuildControl<'_>)
        -> Result<PreparedObject, BuildError>;
}

/// The [`KindDriver`] of an [`ObjectKind`].
pub struct Kind<K>(PhantomData<fn() -> K>);

impl<K> Kind<K> {
    pub const NEW: Self = Self(PhantomData);
}

impl<K: ObjectKind> KindDriver for Kind<K> {
    fn id(&self) -> KindId {
        K::ID
    }

    fn summary(&self) -> &'static str {
        K::SUMMARY
    }

    fn guide(&self) -> &'static str {
        K::GUIDE
    }

    fn prompt_guide(&self) -> &'static str {
        K::PROMPT_GUIDE
    }

    fn views(&self) -> &'static [View] {
        K::VIEWS
    }

    fn available(&self, ctx: &KernelContext) -> bool {
        K::available(ctx)
    }

    fn naming(&self) -> ObjectNaming {
        K::NAMING
    }

    fn key_inputs(&self, ctx: &KernelContext) -> Vec<String> {
        K::key_inputs(ctx)
    }

    fn spec_schema(&self) -> Value {
        inlined_schema::<K::Spec>()
    }

    fn parse(&self, spec: Value, printer: &PrinterProfile) -> Result<ParsedSpec, SpecError> {
        let spec: K::Spec = serde_json::from_value(spec).map_err(|e| SpecError(format!("malformed spec: {e}")))?;
        let valid = K::validate(spec, printer)?;
        let plan = K::check_plan(&valid, printer).map_err(|e| SpecError(e.to_string()))?;
        let validated = serde_json::to_value(&valid).map_err(|e| SpecError(format!("spec does not serialize: {e}")))?;
        Ok(ParsedSpec {
            kind: K::ID,
            tag: K::TAG,
            title: K::title(&valid),
            spec_sha256: canonical_sha256(&validated),
            validated,
            plan,
            valid: Box::new(valid),
        })
    }

    fn prepare(
        &self,
        parsed: &ParsedSpec,
        ctx: &KernelContext,
        control: &BuildControl<'_>,
    ) -> Result<PreparedObject, BuildError> {
        let valid = parsed
            .valid
            .downcast_ref::<K::Valid>()
            .ok_or_else(|| BuildError::Failed(format!("a {} spec cannot build as {}", parsed.kind, K::ID)))?;
        let Built { model, extra } = K::model(valid, ctx, control)?;
        let plan = bound_plan(&parsed.plan, K::bind_plan(valid, &ctx.printer, &model))?;
        let evidence = K::measure(valid, &model, control)?;
        control.report(BuildStep::GeometryBuilt);
        if control.is_cancelled() {
            return Err(BuildError::Cancelled);
        }
        let views = K::preview(valid, &model)?;
        if !views.views().iter().map(|(view, _)| *view).eq(K::VIEWS.iter().copied()) {
            return Err(BuildError::Failed(format!("{} rendered views other than its declared {:?}", K::ID, K::VIEWS)));
        }
        let checked = plan.certify(model, extra, evidence).map_err(|e| match e {
            failed @ ChecksFailed::Failed(_) => BuildError::Stage { stage: Stage::Geometry, error: failed.to_string() },
            mismatch => BuildError::Failed(mismatch.to_string()),
        })?;
        Ok(PreparedObject { checked, views, plan })
    }
}

/// `bound`, if it keeps `declared`'s id and every check `declared` names.
fn bound_plan(declared: &CheckPlan, bound: Result<CheckPlan, InvalidPlan>) -> Result<CheckPlan, BuildError> {
    let bound = bound.map_err(|e| BuildError::Failed(e.to_string()))?;
    let dropped: Vec<&str> =
        declared.required().iter().filter(|id| !bound.required().contains(id)).map(CheckId::as_str).collect();
    if bound.id() != declared.id() || !dropped.is_empty() {
        return Err(BuildError::Failed(format!(
            "check plan {} was bound as {} without [{}]",
            declared.id().as_str(),
            bound.id().as_str(),
            dropped.join(", ")
        )));
    }
    Ok(bound)
}

/// Every registered kind, one line each. A kind that needs something this app
/// may lack, such as the CAD runtime, is still listed; [`available`] is what
/// leaves it out.
pub static KINDS: &[&dyn KindDriver] = &[&Kind::<Sign>::NEW, &Kind::<Part>::NEW];

/// The registered kind named `id`, whether or not it is available.
pub fn find(id: &str) -> Option<&'static dyn KindDriver> {
    KINDS.iter().copied().find(|kind| kind.id().as_str() == id)
}

/// The kinds that can build with `ctx`, in [`KINDS`] order.
pub fn available(ctx: &KernelContext) -> Vec<&'static dyn KindDriver> {
    KINDS.iter().copied().filter(|kind| kind.available(ctx)).collect()
}

/// The catalog a model reads: one line per kind in `kinds`, and under a
/// kind's line its [`KindDriver::prompt_guide`], indented. A kind with no
/// prompt guide is marked `[describe]`: a model calls `describe_kind` for it
/// before it builds one.
pub fn catalog(kinds: &[&'static dyn KindDriver]) -> String {
    let mut out = String::new();
    for kind in kinds {
        let guide = kind.prompt_guide().trim();
        if guide.is_empty() {
            out.push_str(&format!("- {} [describe]: {}\n", kind.id(), kind.summary()));
            continue;
        }
        out.push_str(&format!("- {}: {}\n", kind.id(), kind.summary()));
        for line in guide.lines() {
            match line.trim_end() {
                "" => out.push('\n'),
                line => out.push_str(&format!("  {line}\n")),
            }
        }
    }
    out
}

/// JSON Schema for `T` with every subschema inlined; providers differ in `$ref` support.
pub fn inlined_schema<T: JsonSchema>() -> Value {
    let generator = schemars::generate::SchemaSettings::draft2020_12()
        .with(|settings| settings.inline_subschemas = true)
        .into_generator();
    let mut schema = generator.into_root_schema_for::<T>().to_value();
    if let Some(object) = schema.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
    }
    schema
}

/// SHA-256 (lowercase hex) of `value`'s canonical JSON: object keys sorted,
/// no whitespace. Input field order does not matter.
fn canonical_sha256(value: &Value) -> Sha256Hex {
    Sha256Hex::of_bytes(canonical_json(value).as_bytes())
}

/// `value` as canonical JSON: object keys sorted, no whitespace, one line.
pub fn canonical_json(value: &Value) -> String {
    let mut canonical = String::new();
    write_canonical(value, &mut canonical);
    canonical
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            out.push('{');
            for (i, (key, value)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(value, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

#[cfg(test)]
mod tests;
