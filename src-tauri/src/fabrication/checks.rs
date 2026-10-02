//! Check plans as proof.
//!
//! A kind declares its [`CheckPlan`] before anything is built. The plan turns
//! evidence into proof values with private constructors: [`CheckPlan::certify`]
//! is the only way to get a [`CheckedModel`], which is the only thing the
//! package writer accepts, and [`CheckPlan::finish`] is the only way to get
//! [`PassedChecks`], which is what a verified build is recorded from. Both
//! reject evidence that is missing a planned check, repeats one, carries one
//! the plan does not name, or contains a failure.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use super::bambu;
use super::model::PrintableModel;

/// When a check runs. Check ids start with the phase's name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CheckPhase {
    /// Measurements of the built model, before any package exists.
    Geometry,
    /// Printability of the built model (layer checks). No kind plans one yet.
    Print,
    /// Judgements of the slicer's output.
    Slice,
    /// The package a person opens matches what was sliced.
    Handoff,
}

impl CheckPhase {
    fn prefix(self) -> &'static str {
        match self {
            CheckPhase::Geometry => "geometry",
            CheckPhase::Print => "print",
            CheckPhase::Slice => "slice",
            CheckPhase::Handoff => "handoff",
        }
    }

    /// Phases [`CheckPlan::certify`] judges; the rest are judged by [`CheckPlan::finish`].
    fn is_model_phase(self) -> bool {
        matches!(self, CheckPhase::Geometry | CheckPhase::Print)
    }
}

/// `<phase>.<name>`, for example `geometry.closed_manifold.white` or
/// `slice.layer1_coverage`. Recorded on revisions as the check's stable name.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CheckId {
    phase: CheckPhase,
    id: String,
}

impl CheckId {
    pub fn new(phase: CheckPhase, name: &str) -> Self {
        Self { phase, id: format!("{}.{name}", phase.prefix()) }
    }

    pub fn phase(&self) -> CheckPhase {
        self.phase
    }

    pub fn as_str(&self) -> &str {
        &self.id
    }
}

impl fmt::Display for CheckId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.id)
    }
}

/// One check's result.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckOutcome {
    pub id: CheckId,
    pub passed: bool,
    pub detail: String,
}

/// Names a plan's version; it changes whenever the plan's checks change meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckPlanId(&'static str);

impl CheckPlanId {
    pub const fn new(id: &'static str) -> Self {
        Self(id)
    }

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

/// The checks a build must pass, in the order they are recorded.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckPlan {
    id: CheckPlanId,
    required: Vec<CheckId>,
}

/// The handoff check every plan carries: the package's embedded settings and
/// colours match the verified slice.
pub fn handoff_settings_match_slice() -> CheckId {
    CheckId::new(CheckPhase::Handoff, "settings_match_slice")
}

/// The slice-phase id for one of Bambu Studio's slice checks.
pub fn slice_check_id(check: bambu::CheckId) -> CheckId {
    CheckId::new(CheckPhase::Slice, check.as_str())
}

/// The slice and handoff checks every plan ends with today, in recorded order.
pub fn slice_and_handoff_checks() -> impl Iterator<Item = CheckId> {
    bambu::CheckId::ALL.into_iter().map(slice_check_id).chain(std::iter::once(handoff_settings_match_slice()))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InvalidPlan {
    /// A plan with no checks would let a build pass on no evidence.
    #[error("check plan {0} names no checks")]
    Empty(&'static str),
    #[error("check plan {plan} names {id} twice")]
    Duplicate { plan: &'static str, id: CheckId },
}

impl CheckPlan {
    pub fn new(id: CheckPlanId, required: Vec<CheckId>) -> Result<Self, InvalidPlan> {
        if required.is_empty() {
            return Err(InvalidPlan::Empty(id.as_str()));
        }
        let mut seen = BTreeSet::new();
        if let Some(dup) = required.iter().find(|check| !seen.insert(*check)) {
            return Err(InvalidPlan::Duplicate { plan: id.as_str(), id: dup.clone() });
        }
        Ok(Self { id, required })
    }

    pub fn id(&self) -> CheckPlanId {
        self.id
    }

    pub fn required(&self) -> &[CheckId] {
        &self.required
    }

    /// Proves the model passed every planned geometry and print check.
    /// `evidence` must hold exactly those checks, each once.
    pub fn certify(&self, model: PrintableModel, evidence: Vec<CheckOutcome>) -> Result<CheckedModel, ChecksFailed> {
        let outcomes = self.judge(|phase| phase.is_model_phase(), evidence)?;
        Ok(CheckedModel { model, proof: PassedGeometry { outcomes } })
    }

    /// Proves every planned check passed: the certified geometry checks plus
    /// `slice` and `handoff`, which must hold exactly the plan's slice and
    /// handoff checks. On success the outcomes are in plan order.
    pub fn finish(
        &self,
        geometry: &PassedGeometry,
        slice: Vec<CheckOutcome>,
        handoff: Vec<CheckOutcome>,
    ) -> Result<PassedChecks, ChecksFailed> {
        let evidence = geometry.outcomes.iter().cloned().chain(slice).chain(handoff).collect();
        let outcomes = self.judge(|_| true, evidence)?;
        Ok(PassedChecks { plan: self.id, outcomes })
    }

    /// Matches `evidence` against the planned checks of the selected phases and
    /// returns it in plan order when every one of them is present once and passed.
    fn judge(&self, phases: impl Fn(CheckPhase) -> bool, evidence: Vec<CheckOutcome>) -> Result<Vec<CheckOutcome>, ChecksFailed> {
        let planned: Vec<&CheckId> = self.required.iter().filter(|id| phases(id.phase())).collect();
        let mut by_id: BTreeMap<CheckId, CheckOutcome> = BTreeMap::new();
        let mut mismatch = PlanMismatch::default();
        for outcome in evidence {
            if !planned.contains(&&outcome.id) {
                mismatch.unexpected.push(outcome.id);
            } else if by_id.contains_key(&outcome.id) {
                mismatch.duplicate.push(outcome.id);
            } else {
                by_id.insert(outcome.id.clone(), outcome);
            }
        }
        mismatch.missing = planned.iter().filter(|id| !by_id.contains_key(id)).map(|id| (*id).clone()).collect();
        if !mismatch.is_empty() {
            return Err(ChecksFailed::Mismatch(mismatch));
        }
        let ordered: Vec<CheckOutcome> = planned.iter().filter_map(|id| by_id.remove(id)).collect();
        if ordered.iter().all(|outcome| outcome.passed) {
            Ok(ordered)
        } else {
            Err(ChecksFailed::Failed(ordered))
        }
    }
}

/// Evidence that does not line up with the plan, by check id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanMismatch {
    pub missing: Vec<CheckId>,
    pub duplicate: Vec<CheckId>,
    pub unexpected: Vec<CheckId>,
}

impl PlanMismatch {
    fn is_empty(&self) -> bool {
        self.missing.is_empty() && self.duplicate.is_empty() && self.unexpected.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ChecksFailed {
    /// The checks that ran are not the checks the plan names.
    #[error("{}", describe_mismatch(.0))]
    Mismatch(PlanMismatch),
    /// Every planned check ran once and at least one failed. Holds every
    /// outcome, in plan order, so the failure can be recorded with its evidence.
    #[error("{}", describe_failures(.0))]
    Failed(Vec<CheckOutcome>),
}

fn describe_mismatch(mismatch: &PlanMismatch) -> String {
    let list = |ids: &[CheckId]| ids.iter().map(CheckId::as_str).collect::<Vec<_>>().join(", ");
    let mut parts = Vec::new();
    for (what, ids) in [("missing", &mismatch.missing), ("duplicate", &mismatch.duplicate), ("unexpected", &mismatch.unexpected)] {
        if !ids.is_empty() {
            parts.push(format!("{what} {}", list(ids)));
        }
    }
    format!("checks do not match the check plan: {}", parts.join("; "))
}

fn describe_failures(outcomes: &[CheckOutcome]) -> String {
    let failed: Vec<String> = outcomes.iter().filter(|o| !o.passed).map(|o| format!("{}: {}", o.id, o.detail)).collect();
    format!("checks failed: {}", failed.join("; "))
}

/// The geometry and print checks a [`CheckedModel`] passed, in plan order.
#[derive(Debug, Clone, PartialEq)]
pub struct PassedGeometry {
    outcomes: Vec<CheckOutcome>,
}

impl PassedGeometry {
    pub fn outcomes(&self) -> &[CheckOutcome] {
        &self.outcomes
    }
}

/// A model that passed its plan's geometry and print checks. Only
/// [`CheckPlan::certify`] makes one, and the package writer takes nothing else.
///
/// Code outside this module can read one it was given:
///
/// ```
/// use materialize_3d_lib::fabrication::checks::CheckedModel;
/// fn title(checked: &CheckedModel) -> &str {
///     checked.model().title()
/// }
/// ```
///
/// but cannot assemble one without the plan:
///
/// ```compile_fail,E0451
/// use materialize_3d_lib::fabrication::checks::{CheckedModel, PassedGeometry};
/// use materialize_3d_lib::fabrication::model::PrintableModel;
/// fn forge(model: PrintableModel, proof: PassedGeometry) -> CheckedModel {
///     CheckedModel { model, proof }
/// }
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct CheckedModel {
    model: PrintableModel,
    proof: PassedGeometry,
}

impl CheckedModel {
    pub fn model(&self) -> &PrintableModel {
        &self.model
    }

    pub fn geometry(&self) -> &PassedGeometry {
        &self.proof
    }
}

/// Every check of a plan, each passed, in plan order. Only [`CheckPlan::finish`]
/// makes one; a build is recorded as verified from this.
///
/// ```
/// use materialize_3d_lib::fabrication::checks::PassedChecks;
/// fn count(passed: &PassedChecks) -> usize {
///     passed.outcomes().len()
/// }
/// ```
///
/// ```compile_fail,E0451
/// use materialize_3d_lib::fabrication::checks::{CheckOutcome, CheckPlanId, PassedChecks};
/// fn forge(plan: CheckPlanId, outcomes: Vec<CheckOutcome>) -> PassedChecks {
///     PassedChecks { plan, outcomes }
/// }
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct PassedChecks {
    plan: CheckPlanId,
    outcomes: Vec<CheckOutcome>,
}

impl PassedChecks {
    pub fn plan(&self) -> CheckPlanId {
        self.plan
    }

    pub fn outcomes(&self) -> &[CheckOutcome] {
        &self.outcomes
    }
}

/// Proof for tests that record builds without running geometry or a slicer.
/// It goes through [`CheckPlan::certify`] and [`CheckPlan::finish`] like the
/// pipeline; there is no other way to make one.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::fabrication::model::{Body, Mesh, Palette};
    use crate::fabrication::printer::P2S_04;

    pub(crate) fn model() -> PrintableModel {
        let palette = Palette::new(vec!["#FFFFFF".into()], &P2S_04).expect("palette");
        let mesh = Mesh::new(vec![[0, 0, 0], [1000, 0, 0], [0, 1000, 0]], vec![[0, 1, 2]]).expect("mesh");
        let slot = palette.slot(0).expect("slot");
        PrintableModel::new("t".into(), palette, vec![Body { name: "a".into(), slot, mesh }]).expect("model")
    }

    /// A plan of exactly `ids`, every one passed.
    pub(crate) fn passed(ids: &[CheckId]) -> PassedChecks {
        let plan = CheckPlan::new(CheckPlanId::new("test-support-1"), ids.to_vec()).expect("plan");
        let pass = |phase: fn(CheckPhase) -> bool| -> Vec<CheckOutcome> {
            ids.iter()
                .filter(|id| phase(id.phase()))
                .map(|id| CheckOutcome { id: id.clone(), passed: true, detail: "ok".into() })
                .collect()
        };
        let checked = plan.certify(model(), pass(CheckPhase::is_model_phase)).expect("certified");
        plan.finish(checked.geometry(), pass(|p| p == CheckPhase::Slice), pass(|p| p == CheckPhase::Handoff))
            .expect("passed")
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::model;
    use super::*;

    fn geometry(name: &str) -> CheckId {
        CheckId::new(CheckPhase::Geometry, name)
    }

    fn pass(id: &CheckId) -> CheckOutcome {
        CheckOutcome { id: id.clone(), passed: true, detail: "ok".into() }
    }

    fn plan() -> CheckPlan {
        let required = [geometry("closed.a"), geometry("bounds.a")].into_iter().chain(slice_and_handoff_checks()).collect();
        CheckPlan::new(CheckPlanId::new("test-1"), required).expect("plan")
    }

    fn geometry_evidence() -> Vec<CheckOutcome> {
        vec![pass(&geometry("bounds.a")), pass(&geometry("closed.a"))]
    }

    fn slice_evidence() -> Vec<CheckOutcome> {
        bambu::CheckId::ALL.into_iter().map(|c| pass(&slice_check_id(c))).collect()
    }

    fn mismatch(result: Result<CheckedModel, ChecksFailed>) -> PlanMismatch {
        match result {
            Err(ChecksFailed::Mismatch(m)) => m,
            other => panic!("expected a plan mismatch, got {other:?}"),
        }
    }

    #[test]
    fn a_plan_refuses_no_checks_and_a_check_named_twice() {
        assert_eq!(CheckPlan::new(CheckPlanId::new("p"), vec![]).unwrap_err(), InvalidPlan::Empty("p"));
        let err = CheckPlan::new(CheckPlanId::new("p"), vec![geometry("x"), geometry("x")]).unwrap_err();
        assert_eq!(err, InvalidPlan::Duplicate { plan: "p", id: geometry("x") });
    }

    #[test]
    fn certify_orders_passed_geometry_by_the_plan() {
        let checked = plan().certify(model(), geometry_evidence()).expect("certified");
        let ids: Vec<&str> = checked.geometry().outcomes().iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["geometry.closed.a", "geometry.bounds.a"]);
        assert_eq!(checked.model(), &model());
    }

    #[test]
    fn certify_rejects_missing_duplicate_unexpected_and_failed_checks() {
        let plan = plan();
        let missing = mismatch(plan.certify(model(), vec![pass(&geometry("closed.a"))]));
        assert_eq!(missing.missing, [geometry("bounds.a")]);

        let mut repeated = geometry_evidence();
        repeated.push(pass(&geometry("closed.a")));
        assert_eq!(mismatch(plan.certify(model(), repeated)).duplicate, [geometry("closed.a")]);

        let mut extra = geometry_evidence();
        extra.push(pass(&geometry("ink_present.b")));
        extra.push(pass(&slice_check_id(bambu::CheckId::NoWarnings)));
        assert_eq!(
            mismatch(plan.certify(model(), extra)).unexpected,
            [geometry("ink_present.b"), slice_check_id(bambu::CheckId::NoWarnings)]
        );

        let mut failing = geometry_evidence();
        failing[0].passed = false;
        failing[0].detail = "min 0 max 300".into();
        let err = plan.certify(model(), failing).unwrap_err();
        assert_eq!(err.to_string(), "checks failed: geometry.bounds.a: min 0 max 300");
        assert!(matches!(err, ChecksFailed::Failed(outcomes) if outcomes.len() == 2));
    }

    #[test]
    fn finish_needs_every_slice_and_handoff_check_to_pass() {
        let plan = plan();
        let checked = plan.certify(model(), geometry_evidence()).expect("certified");
        let handoff = || vec![pass(&handoff_settings_match_slice())];

        let passed = plan.finish(checked.geometry(), slice_evidence(), handoff()).expect("passed");
        assert_eq!(passed.plan(), CheckPlanId::new("test-1"));
        let ids: Vec<&CheckId> = passed.outcomes().iter().map(|o| &o.id).collect();
        assert_eq!(ids, plan.required().iter().collect::<Vec<_>>());

        let mut short = slice_evidence();
        short.pop();
        let err = plan.finish(checked.geometry(), short, handoff()).unwrap_err();
        assert!(matches!(&err, ChecksFailed::Mismatch(m) if m.missing == [slice_check_id(bambu::CheckId::Layer1Coverage)]), "{err}");

        let mut failing = handoff();
        failing[0].passed = false;
        let err = plan.finish(checked.geometry(), slice_evidence(), failing).unwrap_err();
        assert!(matches!(&err, ChecksFailed::Failed(outcomes) if outcomes.len() == plan.required().len()), "{err}");
    }
}
