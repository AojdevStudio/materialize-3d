use super::*;
use crate::fabrication::kind::{self, KernelContext, KINDS};
use crate::fabrication::pipeline::BuildOutcome;
use crate::fabrication::printer::P2S_04;
use crate::state::PrinterState;

const FIXTURE: &str = include_str!("../../tests/fixtures/signs/synthetic-back-shortly.json");

/// The kinds of an app without a CAD runtime: signs only.
fn signs_only() -> Vec<&'static dyn KindDriver> {
    kind::available(&KernelContext::without_runtime(P2S_04))
}

fn build_validator() -> jsonschema::Validator {
    jsonschema::validator_for(&Tool::Build.parameters(&signs_only())).expect("build parameters are a valid schema")
}

#[test]
fn the_tools_are_describe_build_revise_import_part_get_list_show_and_printer_status() {
    let names: Vec<&str> = Tool::ALL.iter().map(|tool| tool.name()).collect();
    assert_eq!(names, ["describe_kind", "build", "revise", "import_part", "get", "list", "show", "printer_status"]);
}

/// `import_part` takes a path on this computer, so only MCP offers it.
#[test]
fn import_part_is_offered_on_mcp_only() {
    assert!(Tool::on(Surface::ExternalMcp).any(|tool| tool == Tool::ImportPart));
    assert!(Tool::on(Surface::InAppAgent).all(|tool| tool != Tool::ImportPart));
    let in_app: Vec<Tool> = Tool::on(Surface::InAppAgent).collect();
    let external: Vec<Tool> = Tool::on(Surface::ExternalMcp).filter(|tool| *tool != Tool::ImportPart).collect();
    assert_eq!(in_app, external, "every other tool is on both surfaces");
}

#[test]
fn base64_matches_rfc_4648() {
    for (bytes, encoded) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
        assert_eq!(base64(bytes.as_bytes()), encoded, "{bytes:?}");
    }
    assert_eq!(base64(&[0xfb, 0xff, 0xbf]), "+/+/");
}

#[test]
fn no_tool_can_approve_export_or_record_a_print() {
    for tool in Tool::ALL {
        for forbidden in ["approve", "export", "print_result", "record_print"] {
            assert!(!tool.name().contains(forbidden), "{} must stay human-only", tool.name());
        }
    }
    assert!(Tool::ALL.iter().any(|tool| tool.name() == "printer_status"), "reading the printer stays legal");
}

/// Lists nothing and remembers each limit it was asked for; nothing else is
/// reachable. It builds `kinds`: signs only unless a test gives it more.
#[derive(Default)]
struct ListingActions {
    limits: std::sync::Mutex<Vec<u32>>,
    kinds: Option<Vec<&'static dyn KindDriver>>,
}

impl RequestActions for ListingActions {
    fn build(
        &self,
        _kind: &str,
        _spec: Value,
        _lineage_id: Option<&str>,
        _requester: RequestActor,
        _control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Err(ActionError::State("not in this test".into()))
    }

    fn build_next(
        &self,
        _kind: &str,
        _spec: Value,
        _lineage_id: &str,
        _requester: RequestActor,
        _control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Err(ActionError::State("not in this test".into()))
    }

    fn list(&self, limit: u32) -> Result<Vec<Revision>, ActionError> {
        self.limits.lock().expect("limits").push(limit);
        Ok(Vec::new())
    }

    fn get(&self, _id: &str) -> Result<Revision, ActionError> {
        Err(ActionError::State("not in this test".into()))
    }

    fn show(&self, _id: &str) -> Result<(), ActionError> {
        Err(ActionError::State("not in this test".into()))
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Err(ActionError::State("not in this test".into()))
    }

    fn import_part(
        &self,
        _path: &std::path::Path,
        _title: &str,
        _units: crate::fabrication::kinds::imported_part::Units,
        _requester: RequestActor,
        _control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Err(ActionError::State("not in this test".into()))
    }

    fn exports(&self, _id: &str) -> Result<Vec<crate::fabrication::revisions::ExportRecord>, ActionError> {
        Ok(Vec::new())
    }

    /// Closed: no approval arrives through this fake.
    fn approvals(&self) -> tokio::sync::watch::Receiver<u64> {
        tokio::sync::watch::channel(0).1
    }

    fn kinds(&self) -> Vec<&'static dyn KindDriver> {
        self.kinds.clone().unwrap_or_else(signs_only)
    }

    fn views(&self, _revision: &Revision) -> crate::fabrication::pipeline::KeptViews {
        Default::default()
    }
}

#[tokio::test]
async fn list_refuses_a_limit_outside_1_to_100_on_both_surfaces() {
    let schema = jsonschema::validator_for(&Tool::List.parameters(&signs_only())).expect("list schema");
    for surface in [Surface::InAppAgent, Surface::ExternalMcp] {
        let actions = Arc::new(ListingActions::default());
        let call = ToolCall {
            surface,
            actions: actions.clone(),
            progress: Arc::new(|_| {}),
            cancel: CancellationToken::new(),
            blocking: TaskTracker::new(),
        };
        for limit in [0, 101] {
            let args = json!({ "limit": limit });
            assert!(!schema.is_valid(&args), "{surface:?}: schema advertises limit {limit}");
            let refused = Tool::List.invoke(&call, args).await;
            assert!(
                matches!(&refused, Err(ToolError::InvalidArguments(e)) if e.to_string().contains("1 to 100")),
                "{surface:?}: limit {limit} gave {refused:?}"
            );
        }
        for limit in [1, 100] {
            let args = json!({ "limit": limit });
            assert!(schema.is_valid(&args), "{surface:?}: schema refuses limit {limit}");
            Tool::List.invoke(&call, args).await.expect("in-range limit");
        }
        Tool::List.invoke(&call, json!({})).await.expect("default limit");
        assert_eq!(*actions.limits.lock().expect("limits"), [1, 100, 20], "{surface:?}: limits passed through unchanged");
    }
}

/// `get` waits at most 900 seconds; more is refused, never clamped, on both surfaces.
#[tokio::test]
async fn get_refuses_a_wait_over_900_seconds_on_both_surfaces() {
    let schema = jsonschema::validator_for(&Tool::Get.parameters(&signs_only())).expect("get schema");
    let id = "7d9f3c1e-2b4a-4c8e-9f10-123456789abc";
    assert!(schema.is_valid(&json!({ "revision_id": id, "wait_s": 900 })));
    assert!(!schema.is_valid(&json!({ "revision_id": id, "wait_s": 901 })));
    for surface in [Surface::InAppAgent, Surface::ExternalMcp] {
        let call = call_on(surface, Arc::new(ListingActions::default()));
        let refused = Tool::Get.invoke(&call, json!({ "revision_id": id, "wait_s": 901 })).await;
        assert!(
            matches!(&refused, Err(ToolError::InvalidArguments(e)) if e.to_string().contains("0 to 900")),
            "{surface:?}: {refused:?}"
        );
    }
}

#[test]
fn the_build_schema_accepts_a_sign_spec() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let args = json!({ "kind": "sign", "spec": fixture });
    let errors: Vec<String> = build_validator().iter_errors(&args).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "fixture rejected: {errors:?}");
}

#[test]
fn the_build_schema_rejects_unknown_kinds_and_malformed_specs() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let validator = build_validator();
    let mutate = |f: &dyn Fn(&mut Value)| {
        let mut spec = fixture.clone();
        f(&mut spec);
        json!({ "kind": "sign", "spec": spec })
    };
    let bad = [
        ("missing inks", mutate(&|s| drop(s.as_object_mut().expect("object").remove("inks")))),
        ("unknown field", mutate(&|s| s["colour"] = json!("navy"))),
        ("unknown element type", mutate(&|s| s["elements"][1]["type"] = json!("circle"))),
        ("width as text", mutate(&|s| s["width_mm"] = json!("150"))),
        ("bad font weight", mutate(&|s| s["elements"][1]["font"] = json!("black"))),
        ("text without baseline", mutate(&|s| drop(s["elements"][1].as_object_mut().expect("text").remove("y_mm")))),
        ("no spec", json!({ "kind": "sign", "lineage_id": "x" })),
        ("no kind", json!({ "spec": fixture })),
        ("a kind this app cannot build", json!({ "kind": "part", "spec": fixture })),
        ("a kind only import_part makes", json!({ "kind": "imported_part", "spec": fixture })),
    ];
    for (why, args) in bad {
        assert!(!validator.is_valid(&args), "schema accepted a spec with {why}");
    }
}

/// Where the frontend reads the types the chat and the designs view share with Rust.
const GENERATED_TYPES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/types/generated.ts");

/// src/types/generated.ts as these Rust types declare it.
fn frontend_types() -> String {
    use ts_rs::{Config, TS};
    let cfg = Config::new();
    let declarations = [
        Actor::decl(&cfg),
        BuildStep::decl(&cfg),
        BuildStatus::decl(&cfg),
        ApprovalStatus::decl(&cfg),
        PrintStatus::decl(&cfg),
        Stage::decl(&cfg),
        View::decl(&cfg),
        DesignSummary::decl(&cfg),
        BuildResult::decl(&cfg),
    ];
    let mut out = String::from(
        "// Generated from the Rust types by ts-rs. Do not edit; regenerate with\n\
         // `cd src-tauri && UPDATE_GENERATED_TYPES=1 cargo test --lib generated_frontend_types`.\n",
    );
    for declaration in declarations {
        out.push_str(&format!("\nexport {declaration}\n"));
    }
    out.lines().map(|line| format!("{}\n", line.trim_end())).collect()
}

/// The frontend's copies of these types are generated, never written by hand,
/// so a change on either side fails here until the file is regenerated.
#[test]
fn generated_frontend_types_match_the_rust_types() {
    let generated = frontend_types();
    if std::env::var_os("UPDATE_GENERATED_TYPES").is_some() {
        std::fs::write(GENERATED_TYPES, &generated).expect("write generated types");
    }
    let committed = std::fs::read_to_string(GENERATED_TYPES).expect("src/types/generated.ts");
    assert_eq!(committed, generated, "src/types/generated.ts is stale; regenerate it");
}

fn call_on(surface: Surface, actions: Arc<dyn RequestActions>) -> ToolCall {
    ToolCall { surface, actions, progress: Arc::new(|_| {}), cancel: CancellationToken::new(), blocking: TaskTracker::new() }
}

/// Without the CAD runtime, the build tool neither advertises `part` nor
/// lets a call name it, on both surfaces; `describe_kind` refuses it too.
#[tokio::test]
async fn without_the_runtime_the_tools_refuse_part() {
    let kinds = signs_only();
    assert_eq!(Tool::Build.parameters(&kinds)["properties"]["kind"]["enum"], json!(["sign"]));
    assert_eq!(Tool::DescribeKind.parameters(&kinds)["properties"]["kind"]["enum"], json!(["sign"]));
    for surface in [Surface::InAppAgent, Surface::ExternalMcp] {
        let call = call_on(surface, Arc::new(ListingActions::default()));
        for tool in [Tool::Build, Tool::DescribeKind] {
            let refused = tool.invoke(&call, json!({ "kind": "part", "spec": {} })).await;
            let refused = match tool {
                Tool::Build => refused,
                _ => tool.invoke(&call, json!({ "kind": "part" })).await,
            };
            assert!(
                matches!(&refused, Err(ToolError::KindNotOffered { kind, offered }) if kind == "part" && offered == "sign"),
                "{surface:?} {}: {refused:?}",
                tool.name()
            );
        }
    }
}

/// With the runtime, `part` is offered exactly like a sign: in the schema,
/// in `describe_kind`, and past the build tool's kind check.
#[tokio::test]
async fn with_the_runtime_the_tools_offer_part() {
    let kinds: Vec<&'static dyn KindDriver> = KINDS.to_vec();
    assert_eq!(Tool::Build.parameters(&kinds)["properties"]["kind"]["enum"], json!(["sign", "part"]));
    let validator = jsonschema::validator_for(&Tool::Build.parameters(&kinds)).expect("schema");
    let clip = crate::fabrication::kinds::part::tests::clip_spec();
    assert!(validator.is_valid(&json!({ "kind": "part", "spec": clip })), "the design's clip spec fits the build schema");
    for surface in [Surface::InAppAgent, Surface::ExternalMcp] {
        let call = call_on(surface, Arc::new(ListingActions { kinds: Some(kinds.clone()), ..Default::default() }));
        let described = Tool::DescribeKind.invoke(&call, json!({ "kind": "part" })).await.expect("describe part");
        assert_eq!(described.value["guide"], json!(include_str!("../fabrication/kinds/part_guide.md")));
        assert_eq!(described.value["contract"], json!(include_str!("../fabrication/kinds/part_contract.md")));
        let built = Tool::Build.invoke(&call, json!({ "kind": "part", "spec": clip })).await;
        assert!(matches!(&built, Err(ToolError::Action(ActionError::State(why))) if why == "not in this test"), "{built:?}");
    }
    let call = call_on(Surface::InAppAgent, Arc::new(ListingActions::default()));
    let sign = Tool::DescribeKind.invoke(&call, json!({ "kind": "sign" })).await.expect("describe sign");
    assert!(sign.value["guide"].as_str().is_some_and(|guide| guide.contains("y_mm is the baseline")), "{sign:?}");
    assert!(sign.value.get("contract").is_none(), "a sign has no contract: {sign:?}");
}
