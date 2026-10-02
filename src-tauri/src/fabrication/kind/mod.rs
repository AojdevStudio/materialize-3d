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
use serde::Serialize;
use serde_json::Value;

use super::checks::{CheckOutcome, CheckPlan, CheckedModel, InvalidPlan};
use super::kinds::sign::Sign;
use super::model::PrintableModel;
use super::pipeline::{BuildError, BuildStep};
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
/// input), and `model` is deterministic for a given `Valid` and
/// [`TAG`](ObjectKind::TAG), which is what lets a `build_key` reuse a build.
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

    fn validate(spec: Self::Spec, printer: &PrinterProfile) -> Result<Self::Valid, SpecError>;
    fn title(valid: &Self::Valid) -> String;
    /// Every check a build must pass, declared before anything is built.
    fn check_plan(valid: &Self::Valid, printer: &PrinterProfile) -> Result<CheckPlan, InvalidPlan>;
    /// Builds the bodies on the bed. Blocking, like the slicer; a long kernel
    /// polls `control` and returns [`KernelError::Cancelled`].
    fn model(valid: &Self::Valid, ctx: &KernelContext, control: &BuildControl<'_>) -> Result<Built, KernelError>;
    /// Measures `model` for every geometry and print check the plan names.
    fn measure(valid: &Self::Valid, model: &PrintableModel) -> Vec<CheckOutcome>;
    /// The PNG the app shows for the build.
    fn preview(valid: &Self::Valid, model: &PrintableModel) -> Result<Vec<u8>, KernelError>;
}

/// What a kernel may use besides the spec. A later kind adds its runtime here.
#[derive(Debug, Clone, Copy)]
pub struct KernelContext {
    pub printer: PrinterProfile,
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

/// A named byte payload a kind returns beside its model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraArtifact {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum KernelError {
    #[error("build cancelled")]
    Cancelled,
    #[error("{0}")]
    Failed(String),
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

/// A model that passed its plan's geometry checks, with its preview, ready to package.
pub struct PreparedObject {
    pub checked: CheckedModel,
    pub preview: Vec<u8>,
    pub extra: Vec<ExtraArtifact>,
}

/// The object-safe face of a kind, implemented once by [`Kind`]. The
/// pipeline and the tools see only this.
pub trait KindDriver: Send + Sync {
    fn id(&self) -> KindId;
    fn summary(&self) -> &'static str;
    /// JSON Schema of the kind's spec, every subschema inlined.
    fn spec_schema(&self) -> Value;
    fn parse(&self, spec: Value, printer: &PrinterProfile) -> Result<ParsedSpec, SpecError>;
    /// Builds and measures the model, reports [`BuildStep::GeometryBuilt`],
    /// renders the preview, and certifies the model against the parsed plan.
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
        let evidence = K::measure(valid, &model);
        control.report(BuildStep::GeometryBuilt);
        if control.is_cancelled() {
            return Err(BuildError::Cancelled);
        }
        let preview = K::preview(valid, &model)?;
        let checked = parsed.plan.certify(model, evidence).map_err(|e| BuildError::Failed(e.to_string()))?;
        Ok(PreparedObject { checked, preview, extra })
    }
}

/// Every registered kind, one line each.
pub static KINDS: &[&dyn KindDriver] = &[&Kind::<Sign>::NEW];

pub fn find(id: &str) -> Option<&'static dyn KindDriver> {
    KINDS.iter().copied().find(|kind| kind.id().as_str() == id)
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
    let mut canonical = String::new();
    write_canonical(value, &mut canonical);
    Sha256Hex::of_bytes(canonical.as_bytes())
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
