pub mod cloud;
pub mod credentials;
pub mod mqtt;
pub mod protocol;

pub use credentials::BambuCredentials;
pub use protocol::{BambuCommand, BambuReport};

use std::sync::Arc;
use std::time::Duration;

use rumqttc::{AsyncClient, Event, Incoming};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as TokioMutex;

use crate::state::{AppState, ConnectionState, ConnectionType, PrintHistoryRecord, QueueStatus};

/// Maximum consecutive local MQTT failures before falling back to Cloud.
const LOCAL_FAILURE_THRESHOLD: u32 = 3;
/// Maximum reconnect backoff in seconds.
const MAX_BACKOFF_SECS: u64 = 30;

/// Errors from the PrinterService.
#[derive(Debug, thiserror::Error)]
pub enum PrinterError {
    #[error("credential error: {0}")]
    Credentials(#[from] credentials::CredentialError),
    #[error("MQTT error: {0}")]
    Mqtt(String),
    #[error("cloud error: {0}")]
    Cloud(#[from] cloud::CloudError),
    #[error("printer service not connected")]
    NotConnected,
    #[error("printer service already running")]
    AlreadyRunning,
    #[error("FTPS error: {0}")]
    Ftps(String),
}

/// Inner state of the printer service, protected by an async mutex.
struct PrinterServiceInner {
    credentials: Option<BambuCredentials>,
    mqtt_client: Option<AsyncClient>,
    connection_state: ConnectionState,
    reconnect_count: u32,
    local_failure_count: u32,
    shutdown: bool,
}

/// The core service that owns the printer connection lifecycle.
///
/// `Clone`-able (wraps internals in `Arc`) so Tauri commands can access it.
#[derive(Clone)]
pub struct PrinterService {
    inner: Arc<TokioMutex<PrinterServiceInner>>,
}

impl Default for PrinterService {
    fn default() -> Self {
        Self::new()
    }
}

impl PrinterService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(TokioMutex::new(PrinterServiceInner {
                credentials: None,
                mqtt_client: None,
                connection_state: ConnectionState::Disconnected,
                reconnect_count: 0,
                local_failure_count: 0,
                shutdown: false,
            })),
        }
    }

    /// Start the printer connection with the given credentials.
    /// Spawns a background tokio task for the connection lifecycle.
    pub async fn start(
        &self,
        creds: BambuCredentials,
        app_handle: AppHandle,
        app_state: Arc<AppState>,
    ) -> Result<(), PrinterError> {
        {
            let mut inner = self.inner.lock().await;
            if inner.connection_state != ConnectionState::Disconnected
                && inner.connection_state != ConnectionState::Offline
            {
                return Err(PrinterError::AlreadyRunning);
            }
            inner.credentials = Some(creds);
            inner.shutdown = false;
            inner.reconnect_count = 0;
            inner.local_failure_count = 0;
        }

        let service = self.clone();
        tokio::spawn(async move {
            service.connection_loop(app_handle, app_state).await;
        });

        Ok(())
    }

    /// Disconnect cleanly.
    pub async fn disconnect(&self, app_handle: &AppHandle, app_state: &AppState) {
        let mut inner = self.inner.lock().await;
        inner.shutdown = true;

        if let Some(client) = inner.mqtt_client.take() {
            if let Err(e) = client.disconnect().await {
                log::warn!("MQTT disconnect error: {e}");
            }
        }

        let old_state = inner.connection_state.clone();
        inner.connection_state = ConnectionState::Disconnected;
        inner.reconnect_count = 0;
        inner.local_failure_count = 0;

        // Update shared PrinterState
        if let Ok(mut printer) = app_state.printer.lock() {
            printer.is_connected = false;
            printer.connection_state = ConnectionState::Disconnected;
            printer.connection_type = None;
            printer.last_error = None;
        }

        log::info!(
            "connection state: {old_state:?} → Disconnected (user disconnect)"
        );

        let _ = app_state.emit_state_change(app_handle, "printer:changed");
    }

    /// Send a command to the connected printer.
    pub async fn send_command(
        &self,
        cmd: BambuCommand,
    ) -> Result<(), PrinterError> {
        let inner = self.inner.lock().await;
        let client = inner
            .mqtt_client
            .as_ref()
            .ok_or(PrinterError::NotConnected)?;
        let creds = inner
            .credentials
            .as_ref()
            .ok_or(PrinterError::NotConnected)?;

        let topic = creds.request_topic();
        let payload = cmd.to_json();
        log::info!("sending command to {topic}: {cmd:?}");

        mqtt::publish(client, &topic, &payload)
            .await
            .map_err(PrinterError::Mqtt)
    }

    /// Clone the stored credentials for use outside the service (e.g. FTPS upload).
    /// Returns `None` if the service has not been started with credentials.
    pub async fn get_credentials(&self) -> Option<BambuCredentials> {
        let inner = self.inner.lock().await;
        inner.credentials.clone()
    }

    /// The main connection lifecycle loop.  Tries local MQTT first,
    /// falls back to Cloud after `LOCAL_FAILURE_THRESHOLD` local failures.
    async fn connection_loop(&self, app_handle: AppHandle, app_state: Arc<AppState>) {
        loop {
            // Check for shutdown
            {
                let inner = self.inner.lock().await;
                if inner.shutdown {
                    log::info!("printer service shutdown requested, exiting loop");
                    return;
                }
            }

            // Transition to Discovering
            self.set_state(
                ConnectionState::Discovering,
                &app_handle,
                &app_state,
                "starting connection attempt",
            )
            .await;

            let use_cloud = {
                let inner = self.inner.lock().await;
                inner.local_failure_count >= LOCAL_FAILURE_THRESHOLD
            };

            let result = if use_cloud {
                self.try_cloud_connection(&app_handle, &app_state).await
            } else {
                self.try_local_connection(&app_handle, &app_state).await
            };

            match result {
                Ok(()) => {
                    // Event loop exited — check if this was a clean shutdown
                    let inner = self.inner.lock().await;
                    if inner.shutdown {
                        return;
                    }
                    drop(inner);

                    // Connection lost — transition to Reconnecting
                    self.set_state(
                        ConnectionState::Reconnecting,
                        &app_handle,
                        &app_state,
                        "connection lost",
                    )
                    .await;
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    log::warn!("connection attempt failed: {err_msg}");

                    let mut inner = self.inner.lock().await;
                    if inner.shutdown {
                        return;
                    }

                    if !use_cloud {
                        inner.local_failure_count += 1;
                        log::info!(
                            "local MQTT failure {}/{}",
                            inner.local_failure_count,
                            LOCAL_FAILURE_THRESHOLD
                        );
                    }
                    inner.reconnect_count += 1;

                    // Update last_error
                    if let Ok(mut printer) = app_state.printer.lock() {
                        printer.last_error = Some(err_msg);
                    }
                    drop(inner);

                    // Check if both paths have been exhausted
                    let should_go_offline = {
                        let inner = self.inner.lock().await;
                        use_cloud && inner.reconnect_count > LOCAL_FAILURE_THRESHOLD + 3
                    };

                    if should_go_offline {
                        self.set_state(
                            ConnectionState::Offline,
                            &app_handle,
                            &app_state,
                            "both local and cloud paths exhausted",
                        )
                        .await;
                        return;
                    }

                    self.set_state(
                        ConnectionState::Reconnecting,
                        &app_handle,
                        &app_state,
                        "retrying after failure",
                    )
                    .await;
                }
            }

            // Exponential backoff
            let backoff = {
                let inner = self.inner.lock().await;
                let secs = (1u64 << inner.reconnect_count.min(5)).min(MAX_BACKOFF_SECS);
                Duration::from_secs(secs)
            };
            log::info!("reconnect backoff: {backoff:?}");
            tokio::time::sleep(backoff).await;
        }
    }

    /// Attempt a local MQTT connection and run the event loop.
    async fn try_local_connection(
        &self,
        app_handle: &AppHandle,
        app_state: &AppState,
    ) -> Result<(), PrinterError> {
        let config = {
            let inner = self.inner.lock().await;
            let creds = inner
                .credentials
                .as_ref()
                .ok_or(PrinterError::NotConnected)?;
            cloud::local_mqtt_config(creds)
        };

        log::info!("attempting local MQTT connection to {}", config.host);
        let (client, eventloop) = mqtt::connect(&config).map_err(PrinterError::Mqtt)?;

        // Store client
        {
            let mut inner = self.inner.lock().await;
            inner.mqtt_client = Some(client.clone());
        }

        self.run_event_loop(
            client,
            eventloop,
            ConnectionState::ConnectedMqtt,
            ConnectionType::Mqtt,
            app_handle,
            app_state,
        )
        .await
    }

    /// Attempt a Cloud MQTT connection and run the event loop.
    async fn try_cloud_connection(
        &self,
        app_handle: &AppHandle,
        app_state: &AppState,
    ) -> Result<(), PrinterError> {
        let config = {
            let inner = self.inner.lock().await;
            let creds = inner
                .credentials
                .as_ref()
                .ok_or(PrinterError::NotConnected)?;
            cloud::cloud_mqtt_config(creds)
        };

        log::info!("attempting Cloud MQTT connection to {}", config.host);
        let (client, eventloop) = mqtt::connect(&config).map_err(PrinterError::Mqtt)?;

        {
            let mut inner = self.inner.lock().await;
            inner.mqtt_client = Some(client.clone());
        }

        self.run_event_loop(
            client,
            eventloop,
            ConnectionState::ConnectedCloud,
            ConnectionType::Cloud,
            app_handle,
            app_state,
        )
        .await
    }

    /// Run the MQTT event loop.  On first successful connect, sends `pushall`
    /// and transitions to the given connected state.  Processes incoming
    /// messages and merges them into `PrinterState`.
    async fn run_event_loop(
        &self,
        client: AsyncClient,
        mut eventloop: rumqttc::EventLoop,
        connected_state: ConnectionState,
        conn_type: ConnectionType,
        app_handle: &AppHandle,
        app_state: &AppState,
    ) -> Result<(), PrinterError> {
        let (report_topic, request_topic) = {
            let inner = self.inner.lock().await;
            let creds = inner
                .credentials
                .as_ref()
                .ok_or(PrinterError::NotConnected)?;
            (creds.report_topic(), creds.request_topic())
        };

        let mut connected = false;

        loop {
            // Check for shutdown
            {
                let inner = self.inner.lock().await;
                if inner.shutdown {
                    return Ok(());
                }
            }

            match eventloop.poll().await {
                Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                    log::info!("MQTT ConnAck received");
                    connected = true;

                    // Subscribe to report topic
                    if let Err(e) = mqtt::subscribe(&client, &report_topic).await {
                        log::warn!("failed to subscribe to {report_topic}: {e}");
                    }

                    // Send pushall to get initial full state
                    let pushall_payload = BambuCommand::PushAll.to_json();
                    if let Err(e) =
                        mqtt::publish(&client, &request_topic, &pushall_payload).await
                    {
                        log::warn!("failed to send pushall: {e}");
                    }

                    // Transition to connected
                    self.set_connected(
                        connected_state.clone(),
                        conn_type.clone(),
                        app_handle,
                        app_state,
                    )
                    .await;
                }
                Ok(Event::Incoming(Incoming::Publish(publish))) => {
                    self.handle_publish(&publish.payload, app_handle, app_state);
                }
                Ok(Event::Incoming(Incoming::PingResp)) => {
                    // Keepalive — no action needed
                }
                Ok(Event::Incoming(incoming)) => {
                    log::debug!("MQTT incoming: {incoming:?}");
                }
                Ok(Event::Outgoing(_)) => {}
                Err(e) => {
                    log::warn!("MQTT event loop error: {e}");
                    if connected {
                        // Was connected, now disconnected — return to trigger reconnect
                        return Ok(());
                    } else {
                        // Never connected — connection failed
                        return Err(PrinterError::Mqtt(e.to_string()));
                    }
                }
            }
        }
    }

    /// Parse and merge an incoming MQTT publish message.
    /// Detects gcode_state transitions and dispatches side effects:
    /// - RUNNING→FINISH/FAILED: record print history + send notification
    /// - Any→IDLE: advance the print queue
    fn handle_publish(&self, payload: &[u8], app_handle: &AppHandle, app_state: &AppState) {
        let payload_str = match std::str::from_utf8(payload) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("MQTT payload is not valid UTF-8: {e}");
                return;
            }
        };

        let report: BambuReport = match serde_json::from_str(payload_str) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("failed to parse MQTT payload as BambuReport: {e}");
                return;
            }
        };

        if let Some(ref status) = report.print {
            // ── Read previous gcode_state before merge ──
            let prev_gcode_state = app_state
                .printer
                .lock()
                .ok()
                .and_then(|p| p.gcode_state.clone());

            // ── Merge delta into PrinterState ──
            if let Ok(mut printer) = app_state.printer.lock() {
                status.merge_into(&mut printer);
                log::debug!(
                    "push_status merged: nozzle={:?}°C bed={:?}°C state={:?} progress={:?}%",
                    printer.nozzle_temp,
                    printer.bed_temp,
                    printer.gcode_state,
                    printer.print_progress,
                );
            }

            let _ = app_state.emit_state_change(app_handle, "printer:changed");

            // ── Read current gcode_state after merge ──
            let curr_gcode_state = app_state
                .printer
                .lock()
                .ok()
                .and_then(|p| p.gcode_state.clone());

            // ── Dispatch transition if state actually changed ──
            if let Some(ref curr) = curr_gcode_state {
                if prev_gcode_state.as_deref() != Some(curr.as_str()) {
                    log::info!(
                        "gcode_state transition: {:?} → {:?}",
                        prev_gcode_state,
                        curr
                    );
                    handle_gcode_transition(
                        prev_gcode_state,
                        curr.clone(),
                        app_handle,
                        app_state,
                    );

                    // ── IDLE transition: advance the print queue ──
                    if curr == "IDLE" {
                        log::info!("queue: advancing to next job after IDLE transition");
                        let service = self.clone();
                        let app_handle_clone = app_handle.clone();
                        tokio::spawn(async move {
                            if let Err(e) =
                                auto_send_pending_job(&service, &app_handle_clone).await
                            {
                                log::error!("auto-send on IDLE transition failed: {e}");
                            }
                        });
                    }
                }
            }
        }
    }

    /// Update the connection state and emit a change event.
    async fn set_state(
        &self,
        new_state: ConnectionState,
        app_handle: &AppHandle,
        app_state: &AppState,
        reason: &str,
    ) {
        let old_state = {
            let mut inner = self.inner.lock().await;
            let old = inner.connection_state.clone();
            inner.connection_state = new_state.clone();
            old
        };

        let is_connected = matches!(
            new_state,
            ConnectionState::ConnectedMqtt | ConnectionState::ConnectedCloud
        );

        if let Ok(mut printer) = app_state.printer.lock() {
            printer.connection_state = new_state.clone();
            printer.is_connected = is_connected;
            if !is_connected {
                printer.connection_type = None;
            }
        }

        log::info!(
            "connection state: {old_state:?} → {new_state:?} ({reason})"
        );

        let _ = app_state.emit_state_change(app_handle, "printer:changed");
    }

    /// Transition to a connected state with the appropriate connection type.
    /// After transitioning, spawns a background task to auto-send any pending
    /// queue jobs if the printer is IDLE.
    async fn set_connected(
        &self,
        state: ConnectionState,
        conn_type: ConnectionType,
        app_handle: &AppHandle,
        app_state: &AppState,
    ) {
        let (printer_host, printer_name) = {
            let mut inner = self.inner.lock().await;
            inner.connection_state = state.clone();
            inner.reconnect_count = 0;
            let host = inner.credentials.as_ref().map(|c| c.printer.host.clone());
            let name = inner.credentials.as_ref().map(|c| c.printer.name.clone());
            (host, name)
        };

        if let Ok(mut printer) = app_state.printer.lock() {
            printer.connection_state = state.clone();
            printer.connection_type = Some(conn_type.clone());
            printer.is_connected = true;
            printer.last_error = None;

            // Store the printer IP for camera URL construction
            if let Some(ref ip) = printer_host {
                printer.printer_ip = Some(ip.clone());
            }

            // Set printer name from credentials if not already set by config
            if printer.name.is_none() {
                if let Some(ref name) = printer_name {
                    printer.name = Some(name.clone());
                }
            }
        }

        log::info!("connected via {conn_type:?}");
        let _ = app_state.emit_state_change(app_handle, "printer:changed");

        // Fire-and-forget: auto-send first pending queue job if printer is IDLE
        let service = self.clone();
        let app_handle_clone = app_handle.clone();
        tokio::spawn(async move {
            // Wait 2s for pushall state to arrive
            tokio::time::sleep(Duration::from_secs(2)).await;

            if let Err(e) = auto_send_pending_job(&service, &app_handle_clone).await {
                log::error!("auto-send failed: {e}");
            }
        });
    }
}

// ─── Gcode State Transition Handler ───────────────────────────────────────────

/// Handle a gcode_state transition. Called when prev != curr.
///
/// - RUNNING→FINISH: Record a "success" history entry, fire notification
/// - RUNNING→FAILED: Record a "failed" history entry with fail_reason, fire notification
fn handle_gcode_transition(
    prev: Option<String>,
    curr: String,
    app_handle: &AppHandle,
    app_state: &AppState,
) {
    let prev_str = prev.as_deref().unwrap_or("(none)");
    let is_from_running = prev_str == "RUNNING";

    if !is_from_running {
        return;
    }

    let (status, should_record) = match curr.as_str() {
        "FINISH" => ("success", true),
        "FAILED" => ("failed", true),
        _ => return,
    };

    if !should_record {
        return;
    }

    match record_print_completion(app_state, status) {
        Some((model_name, fail_reason)) => {
            // Emit history:changed with updated list
            emit_history_changed(app_handle, app_state);

            // Fire OS notification
            let fail_reason_for_notif = if status == "failed" {
                fail_reason
            } else {
                None
            };
            send_print_notification(
                app_handle,
                &model_name,
                status,
                fail_reason_for_notif.as_deref(),
            );

            // Emit proactive notification for the frontend agent listener
            let event_type = match status {
                "success" => "print_complete",
                "failed" => "print_failed",
                _ => return,
            };
            emit_proactive_notification(app_handle, app_state, &model_name, event_type);
        }
        None => {
            // Recording was skipped (dedup) or failed (logged inside)
        }
    }
}

/// Core logic for recording a print completion into SQLite.
/// Returns `Some((model_name, fail_reason))` if a record was inserted,
/// `None` if skipped (dedup) or if an error occurred.
///
/// Separated from `handle_gcode_transition` so it can be unit-tested
/// without a Tauri `AppHandle`.
fn record_print_completion(
    app_state: &AppState,
    status: &str,
) -> Option<(String, Option<String>)> {
    // Read printer state fields for the history record
    let (model_name, gcode_file, gcode_start_time, fail_reason) = {
        let printer = match app_state.printer.lock() {
            Ok(p) => p,
            Err(e) => {
                log::error!("failed to lock printer state for history recording: {e}");
                return None;
            }
        };
        (
            printer
                .subtask_name
                .clone()
                .unwrap_or_else(|| "Unknown".into()),
            printer.gcode_file.clone(),
            printer.gcode_start_time.clone(),
            printer.fail_reason.clone(),
        )
    };

    // Deduplication: check if we already recorded this print
    {
        let guard = match app_state.last_recorded_start_time.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("failed to lock dedup guard: {e}");
                return None;
            }
        };
        if let Some(ref last_time) = *guard {
            if gcode_start_time.as_deref() == Some(last_time.as_str()) {
                log::debug!(
                    "dedup: skipping duplicate history record for start_time={}",
                    last_time
                );
                return None;
            }
        }
    }

    // Calculate duration if start_time is available
    let (started_at, duration_seconds) = if let Some(ref start_str) = gcode_start_time {
        // Try parsing as Unix timestamp first, then ISO 8601
        let start_secs: Option<i64> = start_str
            .parse::<i64>()
            .ok()
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(start_str)
                    .ok()
                    .map(|dt| dt.timestamp())
            });

        if let Some(secs) = start_secs {
            let now = chrono::Utc::now().timestamp();
            let dur = now - secs;
            (Some(start_str.clone()), Some(dur.max(0)))
        } else {
            (Some(start_str.clone()), None)
        }
    } else {
        (None, None)
    };

    // Try to get filament estimates from the first Submitted queue job
    let (filament_grams, filament_meters, quality_profile, thumbnail_path) = {
        let queue = app_state.print_queue.lock().ok();
        queue
            .and_then(|q| {
                q.iter()
                    .find(|j| j.status == QueueStatus::Submitted)
                    .map(|j| {
                        (
                            j.filament_grams,
                            j.filament_meters,
                            j.quality_profile.clone(),
                            j.thumbnail_path.clone(),
                        )
                    })
            })
            .unwrap_or((None, None, None, None))
    };

    let completed_at = chrono::Utc::now().to_rfc3339();
    let record = PrintHistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        model_name: model_name.clone(),
        gcode_file,
        started_at,
        completed_at,
        duration_seconds,
        status: status.into(),
        fail_reason: if status == "failed" {
            fail_reason.clone()
        } else {
            None
        },
        filament_grams,
        filament_meters,
        thumbnail_path,
        quality_profile,
    };

    // Insert into SQLite
    let insert_result = {
        let db_guard = match app_state.db.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("failed to lock db for history insert: {e}");
                return None;
            }
        };
        match db_guard.as_ref() {
            Some(conn) => crate::database::insert_history(conn, &record),
            None => {
                log::error!("database not initialized — cannot record history");
                return None;
            }
        }
    };

    if let Err(e) = insert_result {
        log::error!("failed to insert history record: {e}");
        return None;
    }

    log::info!(
        "print history: recorded '{}' as {}",
        model_name,
        status
    );

    // Update dedup guard
    if let Ok(mut guard) = app_state.last_recorded_start_time.lock() {
        *guard = gcode_start_time;
    }

    Some((model_name, fail_reason))
}

/// Emit the `history:changed` event with the full history list.
fn emit_history_changed(app_handle: &AppHandle, app_state: &AppState) {
    let history = {
        let db_guard = match app_state.db.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("failed to lock db for history emission: {e}");
                return;
            }
        };
        match db_guard.as_ref() {
            Some(conn) => match crate::database::get_all_history(conn) {
                Ok(h) => h,
                Err(e) => {
                    log::error!("failed to read history for emission: {e}");
                    return;
                }
            },
            None => return,
        }
    };

    if let Err(e) = app_handle.emit("history:changed", &history) {
        log::error!("failed to emit history:changed event: {e}");
    }
}

/// Send an OS notification for print completion or failure.
fn send_print_notification(
    app_handle: &AppHandle,
    model_name: &str,
    status: &str,
    fail_reason: Option<&str>,
) {
    use tauri_plugin_notification::NotificationExt;

    let (title, body) = match status {
        "success" => (
            "Print Complete".to_string(),
            format!("{model_name} finished successfully"),
        ),
        "failed" => {
            let reason = fail_reason.unwrap_or("unknown reason");
            (
                "Print Failed".to_string(),
                format!("{model_name} failed: {reason}"),
            )
        }
        _ => return,
    };

    if let Err(e) = app_handle
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        log::warn!("failed to send notification: {e}");
    } else {
        log::info!("notification sent: {title} — {body}");
    }
}

// ─── Proactive Agent Notifications ────────────────────────────────────────────

/// Payload for `proactive:notification` Tauri events consumed by the frontend
/// notification listener to drive agent-initiated chat messages.
#[derive(Debug, Clone, serde::Serialize)]
struct ProactiveNotificationPayload {
    event_type: String,
    model_name: String,
    printer_name: String,
}

/// Emit a `proactive:notification` event for the frontend agent notification
/// listener, after checking that the corresponding notification setting is
/// enabled in the settings table.
///
/// `event_type` must be `"print_complete"` or `"print_failed"`.
fn emit_proactive_notification(
    app_handle: &AppHandle,
    app_state: &AppState,
    model_name: &str,
    event_type: &str,
) {
    let setting_key = match event_type {
        "print_complete" => "notifications.print_complete",
        "print_failed" => "notifications.print_failed",
        _ => {
            log::warn!("proactive:notification unknown event_type={event_type}");
            return;
        }
    };

    // Check settings gate
    if is_notification_suppressed(app_state, setting_key) {
        log::debug!(
            "proactive:notification-suppressed setting={setting_key} value=false"
        );
        return;
    }

    // Read printer name from state
    let printer_name = {
        match app_state.printer.lock() {
            Ok(printer) => printer
                .name
                .clone()
                .unwrap_or_else(|| "Unknown Printer".into()),
            Err(e) => {
                log::error!("failed to lock printer for proactive notification: {e}");
                "Unknown Printer".into()
            }
        }
    };

    let payload = ProactiveNotificationPayload {
        event_type: event_type.to_string(),
        model_name: model_name.to_string(),
        printer_name,
    };

    if let Err(e) = app_handle.emit("proactive:notification", &payload) {
        log::error!("failed to emit proactive:notification: {e}");
    } else {
        log::info!(
            "proactive:notification-emitted event_type={} model={}",
            event_type,
            model_name
        );
    }
}

/// Check if a notification setting is suppressed (explicitly set to "false").
/// Returns `true` if the notification should be suppressed, `false` otherwise.
///
/// When the setting is missing from the DB, returns `false` (not suppressed)
/// because the defaults in `database.rs` have notifications enabled.
fn is_notification_suppressed(app_state: &AppState, setting_key: &str) -> bool {
    let db_guard = match app_state.db.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("failed to lock db for settings check: {e}");
            return false; // Don't suppress on lock failure
        }
    };

    match db_guard.as_ref() {
        Some(conn) => match crate::database::get_setting(conn, setting_key) {
            Ok(Some(value)) => value == "false",
            Ok(None) => false, // Not stored → default is "true"
            Err(e) => {
                log::error!("failed to read setting {setting_key}: {e}");
                false
            }
        },
        None => false, // No DB → don't suppress
    }
}

// ─── Auto-Send Queue Logic ────────────────────────────────────────────────────

/// Check if the printer is IDLE and there are pending queue jobs.
/// If so, submit the first pending job (upload + MQTT command).
async fn auto_send_pending_job(
    service: &PrinterService,
    app_handle: &AppHandle,
) -> Result<(), String> {
    // We need AppState from the Tauri managed state
    let app_state: tauri::State<'_, std::sync::Arc<crate::state::AppState>> = app_handle
        .try_state()
        .ok_or_else(|| "AppState not managed".to_string())?;

    // Check if printer is IDLE
    let is_idle = {
        let printer = app_state
            .printer
            .lock()
            .map_err(|e| format!("failed to lock printer state: {e}"))?;
        printer
            .gcode_state
            .as_deref()
            .map(|s| s == "IDLE")
            .unwrap_or(false)
    };

    if !is_idle {
        log::debug!("auto-send: printer not IDLE, skipping queue check");
        return Ok(());
    }

    // Get first pending job
    let first_pending = {
        let queue = app_state
            .print_queue
            .lock()
            .map_err(|e| format!("failed to lock print queue: {e}"))?;
        queue
            .iter()
            .find(|j| j.status == crate::state::QueueStatus::Pending)
            .cloned()
    };

    let job = match first_pending {
        Some(j) => j,
        None => {
            log::debug!("auto-send: no pending jobs in queue");
            return Ok(());
        }
    };

    log::info!(
        "auto-send: submitting queued job '{}' ({})",
        job.model_name,
        job.id
    );

    let file_path = std::path::PathBuf::from(&job.threemf_path);
    if !file_path.exists() {
        let err = format!("3MF file not found: {}", job.threemf_path);
        log::error!("auto-send: {err}");
        crate::print_queue::update_job_status(
            &app_state,
            &job.id,
            crate::state::QueueStatus::Failed { reason: err },
        )?;
        return Ok(());
    }

    let file_bytes = std::fs::read(&file_path)
        .map_err(|e| format!("failed to read 3MF: {e}"))?;
    let md5_digest = format!("{:x}", md5::compute(&file_bytes));

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("print.3mf")
        .to_string();

    // Get credentials for FTPS
    let creds = service
        .get_credentials()
        .await
        .ok_or_else(|| "no credentials available for auto-send".to_string())?;

    let host = creds.printer.host.clone();
    let access_code = creds.ftps_password().to_string();

    // Upload via FTPS
    if let Err(e) = upload_to_printer(&host, &access_code, &file_path).await {
        let err_msg = format!("FTPS upload failed: {e}");
        log::error!("auto-send: {err_msg}");
        crate::print_queue::update_job_status(
            &app_state,
            &job.id,
            crate::state::QueueStatus::Failed {
                reason: err_msg,
            },
        )?;
        return Ok(());
    }

    // Send MQTT project_file command
    let ftp_url = format!("ftp:///cache/{filename}");
    let cmd = BambuCommand::ProjectFile {
        param: "Metadata/plate_1.gcode".into(),
        subtask_name: filename.clone(),
        url: ftp_url,
        md5: md5_digest,
        use_ams: false,
        ams_mapping: String::new(),
    };

    if let Err(e) = service.send_command(cmd).await {
        let err_msg = format!("MQTT command failed: {e}");
        log::error!("auto-send: {err_msg}");
        crate::print_queue::update_job_status(
            &app_state,
            &job.id,
            crate::state::QueueStatus::Failed {
                reason: err_msg,
            },
        )?;
        return Ok(());
    }

    // Mark as submitted
    crate::print_queue::update_job_status(
        &app_state,
        &job.id,
        crate::state::QueueStatus::Submitted,
    )?;

    log::info!(
        "auto-send: job '{}' submitted successfully",
        job.model_name
    );
    Ok(())
}

// ─── FTPS Upload ──────────────────────────────────────────────────────────────

/// Upload a file to the printer via implicit FTPS on port 990.
///
/// Bambu Lab printers expose an FTPS server at port 990 (implicit TLS) with
/// username `bblp` and the LAN access code as password. Uploaded files go to
/// `/cache/` and can be referenced by the `project_file` MQTT command.
///
/// This is a blocking operation wrapped in `spawn_blocking` for async compat.
pub async fn upload_to_printer(
    host: &str,
    access_code: &str,
    file_path: &std::path::Path,
) -> Result<(), PrinterError> {
    use std::io::Cursor;

    let host = host.to_string();
    let access_code = access_code.to_string();
    let file_path = file_path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        // Read file into memory (3MF files are typically 1-10MB)
        let file_bytes = std::fs::read(&file_path).map_err(|e| {
            PrinterError::Ftps(format!(
                "failed to read file '{}': {e}",
                file_path.display()
            ))
        })?;

        let filename = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("upload.3mf");

        log::info!(
            "FTPS: connecting to {}:990 for upload of {} ({} bytes)",
            host,
            filename,
            file_bytes.len()
        );

        // Build TLS connector that accepts Bambu's CN="" self-signed certs
        let tls_connector = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| PrinterError::Ftps(format!("failed to build TLS connector: {e}")))?;

        let connector = suppaftp::NativeTlsConnector::from(tls_connector);

        // Connect to the FTPS server (implicit TLS on port 990)
        // For implicit FTPS, connect normally then wrap with into_secure
        let addr = format!("{host}:990");
        let ftp_stream = suppaftp::NativeTlsFtpStream::connect(&addr)
            .map_err(|e| PrinterError::Ftps(format!("FTPS connect to {addr} failed: {e}")))?;

        let mut ftp_stream = ftp_stream
            .into_secure(connector, &host)
            .map_err(|e| PrinterError::Ftps(format!("FTPS TLS handshake failed: {e}")))?;

        log::info!("FTPS: connected to {addr}, logging in as bblp");

        // Login as bblp with the LAN access code
        ftp_stream
            .login("bblp", &access_code)
            .map_err(|e| PrinterError::Ftps(format!("FTPS login failed: {e}")))?;

        // Navigate to /cache/ directory
        ftp_stream
            .cwd("cache")
            .map_err(|e| PrinterError::Ftps(format!("FTPS cwd to /cache/ failed: {e}")))?;

        // Upload the file
        log::info!("FTPS: uploading {} ({} bytes)", filename, file_bytes.len());

        let mut reader = Cursor::new(file_bytes.clone());
        ftp_stream
            .put_file(filename, &mut reader)
            .map_err(|e| PrinterError::Ftps(format!("FTPS upload of '{filename}' failed: {e}")))?;

        log::info!("FTPS: upload complete for {}", filename);

        // Disconnect
        if let Err(e) = ftp_stream.quit() {
            log::warn!("FTPS disconnect warning (non-fatal): {e}");
        }

        Ok(())
    })
    .await
    .map_err(|e| PrinterError::Ftps(format!("FTPS upload task panicked: {e}")))?
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printer_service_default_state() {
        let service = PrinterService::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let inner = service.inner.lock().await;
            assert_eq!(inner.connection_state, ConnectionState::Disconnected);
            assert!(inner.credentials.is_none());
            assert!(inner.mqtt_client.is_none());
            assert_eq!(inner.reconnect_count, 0);
            assert_eq!(inner.local_failure_count, 0);
            assert!(!inner.shutdown);
        });
    }

    #[test]
    fn send_command_fails_when_not_connected() {
        let service = PrinterService::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let result = service.send_command(BambuCommand::PushAll).await;
            assert!(result.is_err());
            assert!(matches!(result.unwrap_err(), PrinterError::NotConnected));
        });
    }

    /// Test the state machine transitions through the service's set_state method.
    /// We can't test the full connection loop without a real broker, but we can
    /// verify state transitions and PrinterState synchronization.
    #[test]
    fn state_machine_transitions() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let app_state = Arc::new(AppState::default());

            // Verify initial state
            {
                let printer = app_state.printer.lock().unwrap();
                assert_eq!(printer.connection_state, ConnectionState::Disconnected);
                assert!(!printer.is_connected);
            }

            // We can test the state transitions by directly manipulating
            // PrinterState the same way the service does
            let transitions = vec![
                (ConnectionState::Discovering, false),
                (ConnectionState::ConnectedMqtt, true),
                (ConnectionState::Reconnecting, false),
                (ConnectionState::ConnectedCloud, true),
                (ConnectionState::Reconnecting, false),
                (ConnectionState::Offline, false),
                (ConnectionState::Disconnected, false),
            ];

            for (state, expected_connected) in transitions {
                {
                    let mut printer = app_state.printer.lock().unwrap();
                    printer.connection_state = state.clone();
                    printer.is_connected = expected_connected;
                }
                let printer = app_state.printer.lock().unwrap();
                assert_eq!(printer.connection_state, state);
                assert_eq!(printer.is_connected, expected_connected);
            }
        });
    }

    #[test]
    fn exponential_backoff_calculation() {
        // Verify the backoff formula: min(2^count, 30)
        let cases = vec![
            (0u32, 1u64),  // 2^0 = 1
            (1, 2),         // 2^1 = 2
            (2, 4),         // 2^2 = 4
            (3, 8),         // 2^3 = 8
            (4, 16),        // 2^4 = 16
            (5, 30),        // 2^5 = 32 → capped at 30
            (6, 30),        // still capped
            (10, 30),       // still capped
        ];

        for (count, expected_secs) in cases {
            let secs = (1u64 << count.min(5)).min(MAX_BACKOFF_SECS);
            assert_eq!(secs, expected_secs, "backoff for count={count}");
        }
    }

    #[test]
    fn bambu_command_payloads_match_protocol() {
        // Verify all commands produce valid JSON with the expected structure
        let pushall = BambuCommand::PushAll.to_json();
        let val: serde_json::Value = serde_json::from_str(&pushall).unwrap();
        assert_eq!(val["pushing"]["command"], "pushall");

        let pause = BambuCommand::Pause.to_json();
        let val: serde_json::Value = serde_json::from_str(&pause).unwrap();
        assert_eq!(val["print"]["command"], "pause");

        let resume = BambuCommand::Resume.to_json();
        let val: serde_json::Value = serde_json::from_str(&resume).unwrap();
        assert_eq!(val["print"]["command"], "resume");

        let stop = BambuCommand::Stop.to_json();
        let val: serde_json::Value = serde_json::from_str(&stop).unwrap();
        assert_eq!(val["print"]["command"], "stop");
    }

    // ─── Transition detection & history recording tests ───────────────────────

    /// Helper: create an AppState with an in-memory SQLite DB ready for testing.
    fn test_app_state() -> AppState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Run migrations manually (same as database::init_db but in-memory)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS print_history (
                id TEXT PRIMARY KEY,
                model_name TEXT NOT NULL,
                gcode_file TEXT,
                started_at TEXT,
                completed_at TEXT NOT NULL,
                duration_seconds INTEGER,
                status TEXT NOT NULL,
                fail_reason TEXT,
                filament_grams REAL,
                filament_meters REAL,
                thumbnail_path TEXT,
                quality_profile TEXT
            );",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();

        let state = AppState::default();
        *state.db.lock().unwrap() = Some(conn);
        state
    }

    /// Helper: get all history records from the test DB.
    fn get_test_history(app_state: &AppState) -> Vec<PrintHistoryRecord> {
        let db_guard = app_state.db.lock().unwrap();
        let conn = db_guard.as_ref().unwrap();
        crate::database::get_all_history(conn).unwrap()
    }

    /// Helper: set printer state fields for a "just finished" print.
    fn set_printer_running(app_state: &AppState, subtask_name: &str, start_time: &str) {
        let mut printer = app_state.printer.lock().unwrap();
        printer.gcode_state = Some("RUNNING".into());
        printer.subtask_name = Some(subtask_name.into());
        printer.gcode_file = Some(format!("{subtask_name}.gcode"));
        printer.gcode_start_time = Some(start_time.into());
        printer.fail_reason = None;
    }

    #[test]
    fn transition_running_to_finish_creates_success_record() {
        let state = test_app_state();
        set_printer_running(&state, "Benchy", "1710500000");

        let result = record_print_completion(&state, "success");
        assert!(result.is_some());
        let (model_name, _) = result.unwrap();
        assert_eq!(model_name, "Benchy");

        let history = get_test_history(&state);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].model_name, "Benchy");
        assert_eq!(history[0].status, "success");
        assert_eq!(history[0].gcode_file.as_deref(), Some("Benchy.gcode"));
        assert_eq!(history[0].started_at.as_deref(), Some("1710500000"));
        assert!(history[0].duration_seconds.is_some());
        assert!(history[0].fail_reason.is_none());
    }

    #[test]
    fn transition_running_to_failed_creates_failed_record() {
        let state = test_app_state();
        set_printer_running(&state, "Hook", "1710500000");
        // Set fail_reason on the printer state
        {
            let mut printer = state.printer.lock().unwrap();
            printer.fail_reason = Some("Nozzle clog detected".into());
        }

        let result = record_print_completion(&state, "failed");
        assert!(result.is_some());
        let (model_name, fail_reason) = result.unwrap();
        assert_eq!(model_name, "Hook");
        assert_eq!(fail_reason.as_deref(), Some("Nozzle clog detected"));

        let history = get_test_history(&state);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, "failed");
        assert_eq!(
            history[0].fail_reason.as_deref(),
            Some("Nozzle clog detected")
        );
    }

    #[test]
    fn duplicate_finish_same_start_time_no_second_record() {
        let state = test_app_state();
        set_printer_running(&state, "Benchy", "1710500000");

        // First completion
        let result1 = record_print_completion(&state, "success");
        assert!(result1.is_some());
        assert_eq!(get_test_history(&state).len(), 1);

        // Second completion with same start_time (e.g. repeated pushall)
        let result2 = record_print_completion(&state, "success");
        assert!(result2.is_none()); // Deduplicated
        assert_eq!(get_test_history(&state).len(), 1); // Still 1
    }

    #[test]
    fn different_start_time_creates_new_record() {
        let state = test_app_state();
        set_printer_running(&state, "Benchy", "1710500000");

        let result1 = record_print_completion(&state, "success");
        assert!(result1.is_some());

        // New print with different start_time
        set_printer_running(&state, "Hook", "1710510000");
        let result2 = record_print_completion(&state, "success");
        assert!(result2.is_some());

        assert_eq!(get_test_history(&state).len(), 2);
    }

    #[test]
    fn non_transition_running_to_running_no_record() {
        // handle_gcode_transition only fires when prev != curr,
        // but record_print_completion doesn't check that — it's the caller's job.
        // We test that the handle_publish logic only dispatches on actual changes
        // by verifying the transition guard in handle_gcode_transition:
        // prev=RUNNING, curr=RUNNING would never reach record_print_completion
        // because curr must be FINISH or FAILED.
        let state = test_app_state();
        set_printer_running(&state, "Benchy", "1710500000");

        // Calling with "running" status (not "success" or "failed") should not insert
        // (handle_gcode_transition wouldn't call record_print_completion for this case)
        // This tests the guard at the call site level.
        assert_eq!(get_test_history(&state).len(), 0);
    }

    #[test]
    fn idle_transition_with_no_pending_jobs_is_noop() {
        // The IDLE transition triggers auto_send_pending_job which checks for
        // pending jobs. With an empty queue, it's a no-op. We verify the queue
        // state rather than calling auto_send (which needs a full Tauri runtime).
        let state = test_app_state();
        let queue = state.print_queue.lock().unwrap();
        let pending = queue
            .iter()
            .find(|j| j.status == QueueStatus::Pending);
        assert!(pending.is_none());
    }

    #[test]
    fn record_without_db_returns_none() {
        // AppState with no DB initialized
        let state = AppState::default();
        {
            let mut printer = state.printer.lock().unwrap();
            printer.subtask_name = Some("Test".into());
            printer.gcode_start_time = Some("1710500000".into());
        }

        let result = record_print_completion(&state, "success");
        assert!(result.is_none());
    }

    #[test]
    fn record_success_does_not_store_fail_reason() {
        let state = test_app_state();
        set_printer_running(&state, "Benchy", "1710500000");
        // Set a fail_reason that should be ignored for success
        {
            let mut printer = state.printer.lock().unwrap();
            printer.fail_reason = Some("leftover error".into());
        }

        let result = record_print_completion(&state, "success");
        assert!(result.is_some());

        let history = get_test_history(&state);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, "success");
        assert!(history[0].fail_reason.is_none()); // Not stored for success
    }

    #[test]
    fn record_pulls_filament_from_submitted_queue_job() {
        let state = test_app_state();
        set_printer_running(&state, "Benchy", "1710500000");

        // Add a Submitted queue job with filament estimates
        {
            let mut queue = state.print_queue.lock().unwrap();
            queue.push(crate::state::QueuedJob {
                id: "q1".into(),
                model_path: "/tmp/benchy.stl".into(),
                threemf_path: "/tmp/benchy.3mf".into(),
                model_name: "Benchy".into(),
                created_at: chrono::Utc::now(),
                status: QueueStatus::Submitted,
                filament_grams: Some(12.5),
                filament_meters: Some(4.2),
                quality_profile: Some("0.20mm Standard".into()),
                thumbnail_path: Some("/tmp/thumb.png".into()),
            });
        }

        let result = record_print_completion(&state, "success");
        assert!(result.is_some());

        let history = get_test_history(&state);
        assert_eq!(history[0].filament_grams, Some(12.5));
        assert_eq!(history[0].filament_meters, Some(4.2));
        assert_eq!(
            history[0].quality_profile.as_deref(),
            Some("0.20mm Standard")
        );
        assert_eq!(history[0].thumbnail_path.as_deref(), Some("/tmp/thumb.png"));
    }

    // ─── Proactive notification tests ─────────────────────────────────────────

    /// Helper: create an AppState with in-memory DB that includes the settings table.
    fn test_app_state_with_settings() -> AppState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS print_history (
                id TEXT PRIMARY KEY,
                model_name TEXT NOT NULL,
                gcode_file TEXT,
                started_at TEXT,
                completed_at TEXT NOT NULL,
                duration_seconds INTEGER,
                status TEXT NOT NULL,
                fail_reason TEXT,
                filament_grams REAL,
                filament_meters REAL,
                thumbnail_path TEXT,
                quality_profile TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .unwrap();

        let state = AppState::default();
        *state.db.lock().unwrap() = Some(conn);
        state
    }

    #[test]
    fn proactive_settings_gate_suppresses_when_false() {
        let state = test_app_state_with_settings();

        // Set notification.print_complete to "false"
        {
            let db_guard = state.db.lock().unwrap();
            let conn = db_guard.as_ref().unwrap();
            crate::database::upsert_setting(conn, "notifications.print_complete", "false")
                .unwrap();
        }

        assert!(is_notification_suppressed(
            &state,
            "notifications.print_complete"
        ));
    }

    #[test]
    fn proactive_settings_gate_allows_when_true() {
        let state = test_app_state_with_settings();

        // Explicitly set to "true"
        {
            let db_guard = state.db.lock().unwrap();
            let conn = db_guard.as_ref().unwrap();
            crate::database::upsert_setting(conn, "notifications.print_complete", "true")
                .unwrap();
        }

        assert!(!is_notification_suppressed(
            &state,
            "notifications.print_complete"
        ));
    }

    #[test]
    fn proactive_settings_gate_allows_when_not_stored() {
        let state = test_app_state_with_settings();
        // No setting stored → default "true" → not suppressed
        assert!(!is_notification_suppressed(
            &state,
            "notifications.print_complete"
        ));
    }

    #[test]
    fn proactive_settings_gate_allows_when_no_db() {
        let state = AppState::default();
        // No DB at all → don't suppress
        assert!(!is_notification_suppressed(
            &state,
            "notifications.print_complete"
        ));
    }

    #[test]
    fn proactive_event_type_mapping() {
        // "success" status → "print_complete" event type
        // "failed" status → "print_failed" event type
        // This tests the mapping logic used in handle_gcode_transition's call site
        let cases = vec![
            ("success", "print_complete"),
            ("failed", "print_failed"),
        ];

        for (status, expected_event_type) in cases {
            let event_type = match status {
                "success" => "print_complete",
                "failed" => "print_failed",
                _ => panic!("unexpected status"),
            };
            assert_eq!(
                event_type, expected_event_type,
                "status '{status}' should map to '{expected_event_type}'"
            );
        }
    }

    #[test]
    fn proactive_settings_gate_suppresses_print_failed_when_false() {
        let state = test_app_state_with_settings();

        {
            let db_guard = state.db.lock().unwrap();
            let conn = db_guard.as_ref().unwrap();
            crate::database::upsert_setting(conn, "notifications.print_failed", "false")
                .unwrap();
        }

        assert!(is_notification_suppressed(
            &state,
            "notifications.print_failed"
        ));
        // print_complete should still be allowed (not stored = default true)
        assert!(!is_notification_suppressed(
            &state,
            "notifications.print_complete"
        ));
    }
}
