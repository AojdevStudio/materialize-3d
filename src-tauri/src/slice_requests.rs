//! The slices and printer checks the sidecar asks Rust for. The update gate's pass for a slice is the sidecar
//! module's job, because the update model describes it.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::OnceCell;

use crate::studio;

/// Outside work by operation id: one result each, shared by every request that names the id.
pub type Operations = Mutex<HashMap<String, Arc<OnceCell<Result<Value, String>>>>>;

/// A slice the agent asked for, under its tool call's operation id.
#[derive(Deserialize)]
pub struct SliceCall {
    operation: String,
    #[serde(flatten)]
    request: studio::slice::Request,
}

pub fn preset_cache<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| format!("finding the app's cache folder: {e}"))?.join("bambu-presets"))
}

pub async fn check<R: Runtime>(app: &AppHandle<R>, printer: studio::slice::Printer) -> Result<Value, String> {
    let cache = preset_cache(app)?;
    tauri::async_runtime::spawn_blocking(move || studio::slice::check(&printer, &cache))
        .await
        .map_err(|e| format!("the printer check failed: {e}"))??;
    Ok(Value::Null)
}

pub async fn slice(operations: &Operations, SliceCall { operation, request }: SliceCall, cache: PathBuf) -> Result<Value, String> {
    once_per_operation(operations, operation, || async move {
        let sliced = tauri::async_runtime::spawn_blocking(move || studio::slice::slice(&request, &cache))
            .await
            .map_err(|e| format!("the slice task failed: {e}"))??;
        serde_json::to_value(sliced).map_err(|e| e.to_string())
    })
    .await
}

/// Runs `work` once per operation id. A sidecar that crashed mid-slice leaves Rust's slice running, and its resumed
/// turn asks again with the same id: that request waits for the first and gets its result, so two slices never write
/// the same output, and a result that came after the crash is not lost.
async fn once_per_operation<F, Fut>(operations: &Operations, id: String, work: F) -> Result<Value, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let cell = operations.lock().unwrap_or_else(|e| e.into_inner()).entry(id).or_default().clone();
    cell.get_or_init(work).await.clone()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn a_repeated_operation_waits_for_the_first_and_gets_its_result() {
        let operations = Operations::default();
        let runs = AtomicU64::new(0);
        let work = |answer: &'static str| {
            let runs = &runs;
            move || async move {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(json!(answer))
            }
        };
        let (first, again) = tokio::join!(
            once_per_operation(&operations, "op".to_owned(), work("first")),
            once_per_operation(&operations, "op".to_owned(), work("again")),
        );
        assert_eq!((first, again), (Ok(json!("first")), Ok(json!("first"))));
        assert_eq!(once_per_operation(&operations, "op".to_owned(), work("later")).await, Ok(json!("first")));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(once_per_operation(&operations, "other".to_owned(), work("other")).await, Ok(json!("other")));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_slice_call_carries_its_operation_id() {
        let printer = json!({ "machine": "Bambu Lab P2S 0.4 nozzle", "process": "0.20mm Standard @BBL P2S", "filament": "Bambu PETG Basic @BBL P2S 0.4 nozzle" });
        let call: SliceCall =
            serde_json::from_value(json!({ "operation": "abc", "project": "p", "inputs": ["a.stl"], "output": "out.3mf", "printer": printer })).expect("slice call");
        assert_eq!(call.operation, "abc");
        assert!(serde_json::from_value::<SliceCall>(json!({ "project": "p", "inputs": ["a.stl"], "output": "out.3mf", "printer": printer })).is_err());
    }
}
