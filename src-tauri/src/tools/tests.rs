use super::*;
use crate::fabrication::pipeline::BuildOutcome;
use crate::state::PrinterState;

const FIXTURE: &str = include_str!("../../tests/fixtures/signs/synthetic-back-shortly.json");

fn build_validator() -> jsonschema::Validator {
    jsonschema::validator_for(Tool::Build.parameters()).expect("build parameters are a valid schema")
}

#[test]
fn the_tools_are_build_get_list_show_and_printer_status() {
    let names: Vec<&str> = Tool::ALL.iter().map(|tool| tool.name()).collect();
    assert_eq!(names, ["build", "get", "list", "show", "printer_status"]);
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

/// Lists nothing and remembers each limit it was asked for; nothing else is reachable.
#[derive(Default)]
struct ListingActions {
    limits: std::sync::Mutex<Vec<u32>>,
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
}

#[tokio::test]
async fn list_refuses_a_limit_outside_1_to_100_on_both_surfaces() {
    let schema = jsonschema::validator_for(Tool::List.parameters()).expect("list schema");
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
        ("an unregistered kind", json!({ "kind": "part", "spec": fixture })),
    ];
    for (why, args) in bad {
        assert!(!validator.is_valid(&args), "schema accepted a spec with {why}");
    }
}
