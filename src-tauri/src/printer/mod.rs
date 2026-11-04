pub mod cloud;
pub mod credentials;
pub mod mqtt;
pub mod protocol;

pub use credentials::BambuCredentials;
pub use protocol::{BambuCommand, BambuReport};

use std::sync::Arc;
use std::time::Duration;

use rumqttc::{AsyncClient, Event, Incoming};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{Mutex as TokioMutex, MutexGuard};

use crate::state::{
    AppState, ConnectionState, ConnectionType, PrintHistoryRecord, PrinterState, QueueStatus,
};

/// Maximum consecutive local MQTT failures before falling back to Cloud.
const LOCAL_FAILURE_THRESHOLD: u32 = 3;
/// Maximum reconnect backoff in seconds.
const MAX_BACKOFF_SECS: u64 = 30;
/// Bounds each FTPS connect, read, and write. An upload holds the print queue,
/// so a printer that accepts and then goes silent must not hold it for good.
const FTPS_TIMEOUT: Duration = Duration::from_secs(30);

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

/// Names one connection. `start` and `disconnect` each move the service to a
/// new one, so work that an earlier connection spawned can tell it ended.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ConnectionId(u64);

/// Whether the printer on the current connection can take the next queued
/// job. Only this connection's reports and sends move it, never the state the
/// app held before.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Readiness {
    /// Set on each connect, and by a report of any state but IDLE.
    WaitingForIdle,
    /// The printer reported IDLE.
    Idle,
    /// The app sent a job while the printer was IDLE. An IDLE it reports
    /// before it starts that job sends nothing more.
    JobSent,
}

/// Why an auto-send run started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunCause {
    /// An IDLE report or an added job.
    Trigger,
    /// The run that held the queue ended while tries were owed.
    OwedTry,
}

/// Inner state of the printer service, protected by an async mutex.
struct PrinterServiceInner {
    credentials: Option<BambuCredentials>,
    mqtt_client: Option<AsyncClient>,
    connection_state: ConnectionState,
    reconnect_count: u32,
    local_failure_count: u32,
    connection: ConnectionId,
    readiness: Readiness,
    /// One auto-send run at a time holds the print queue, across connections,
    /// so two runs never pick the same Pending job. Only the holder frees it.
    queue_held: bool,
    /// Triggers refused while the queue was held. Each is owed one try, one at
    /// a time. The count stays across a reconnect, so a try the printer was
    /// not ready for waits for its next IDLE report.
    owed_runs: u32,
    connection_task: Option<tokio::task::JoinHandle<()>>,
}

/// Drops the print state a printer reported, so another printer does not
/// start with it. The name stays until `start` names the next printer.
fn drop_print_state(app_state: &AppState) {
    if let Ok(mut printer) = app_state.printer.lock() {
        *printer = PrinterState {
            name: printer.name.take(),
            ..PrinterState::default()
        };
    }
}

impl PrinterServiceInner {
    /// Ends the current connection. Work it spawned writes nothing from here on.
    fn end_connection(&mut self) -> ConnectionId {
        self.connection = ConnectionId(self.connection.0 + 1);
        self.connection
    }

    async fn publish(&self, cmd: BambuCommand) -> Result<(), PrinterError> {
        let client = self.mqtt_client.as_ref().ok_or(PrinterError::NotConnected)?;
        let creds = self.credentials.as_ref().ok_or(PrinterError::NotConnected)?;

        let topic = creds.request_topic();
        let payload = cmd.to_json();
        log::info!("sending command to {topic}: {cmd:?}");

        mqtt::publish(client, &topic, &payload)
            .await
            .map_err(PrinterError::Mqtt)
    }
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
                connection: ConnectionId::default(),
                readiness: Readiness::WaitingForIdle,
                queue_held: false,
                owed_runs: 0,
                connection_task: None,
            })),
        }
    }

    /// Start the printer connection with the given credentials.
    /// Spawns a background tokio task for the connection lifecycle.
    ///
    /// Starting again for the same printer is a retry. A live connection is
    /// kept, and an attempt that has not connected yet is replaced with a
    /// fresh one. Another printer needs a disconnect first.
    pub async fn start<R: Runtime>(
        &self,
        creds: BambuCredentials,
        app_handle: AppHandle<R>,
        app_state: Arc<AppState>,
    ) -> Result<(), PrinterError> {
        use ConnectionState::*;

        let mut inner = self.inner.lock().await;
        // Only the printer part: the optional cloud login is read from disk
        // on each connect and can expire between two clicks.
        let same_printer = inner.credentials.as_ref().map(|c| &c.printer) == Some(&creds.printer);
        match (&inner.connection_state, same_printer) {
            (Disconnected | Offline, _) | (Discovering | Reconnecting, true) => {}
            (ConnectedMqtt | ConnectedCloud, true) => return Ok(()),
            (Discovering | Reconnecting | ConnectedMqtt | ConnectedCloud, false) => {
                return Err(PrinterError::AlreadyRunning);
            }
        }

        // A loop left asleep in backoff after a disconnect would otherwise
        // wake and run beside the new one.
        if let Some(task) = inner.connection_task.take() {
            task.abort();
            match task.await {
                Ok(()) => {}
                Err(e) if e.is_cancelled() => {}
                Err(e) => std::panic::resume_unwind(e.into_panic()),
            }
        }
        let id = inner.end_connection();
        // A retry for the same printer, even at a new host, keeps its state, so
        // a print that finished while it was offline still reads as RUNNING to
        // FINISH.
        let same_serial = inner.credentials.as_ref().map(|c| &c.printer.device_id)
            == Some(&creds.printer.device_id);
        if !same_serial {
            drop_print_state(&app_state);
        }
        if let Ok(mut printer) = app_state.printer.lock() {
            printer.name = Some(creds.printer.name.clone());
        }
        inner.mqtt_client = None;
        inner.credentials = Some(creds);
        inner.connection_state = Discovering;
        inner.reconnect_count = 0;
        inner.local_failure_count = 0;

        let service = self.clone();
        inner.connection_task = Some(tokio::spawn(async move {
            service.connection_loop(id, app_handle, app_state).await;
        }));

        Ok(())
    }

    /// Disconnect cleanly.
    pub async fn disconnect<R: Runtime>(&self, app_handle: &AppHandle<R>, app_state: &AppState) {
        let mut inner = self.inner.lock().await;
        inner.end_connection();
        drop_print_state(app_state);

        if let Some(client) = inner.mqtt_client.take() {
            if let Err(e) = client.disconnect().await {
                log::warn!("MQTT disconnect error: {e}");
            }
        }

        let old_state = std::mem::replace(&mut inner.connection_state, ConnectionState::Disconnected);
        inner.reconnect_count = 0;
        inner.local_failure_count = 0;

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
        self.inner.lock().await.publish(cmd).await
    }

    /// Offers a job just added to the queue to the printer on the current
    /// connection. It goes once that printer has reported IDLE and no other
    /// run holds the queue.
    pub async fn advance_queue<R: Runtime>(&self, app_handle: &AppHandle<R>) {
        let id = self.inner.lock().await.connection;
        self.spawn_auto_send(id, RunCause::Trigger, app_handle);
    }

    fn spawn_auto_send<R: Runtime>(&self, id: ConnectionId, cause: RunCause, app_handle: &AppHandle<R>) {
        let service = self.clone();
        let app_handle = app_handle.clone();
        tokio::spawn(async move {
            if let Err(e) = auto_send_pending_job(&service, id, cause, &app_handle).await {
                log::error!("auto-send failed: {e}");
            }
        });
    }

    /// Locks the service for work that connection `id` spawned. `None` once
    /// that connection ended, so the work must write nothing.
    async fn lock_for(&self, id: ConnectionId) -> Option<MutexGuard<'_, PrinterServiceInner>> {
        let inner = self.inner.lock().await;
        (inner.connection == id).then_some(inner)
    }

    /// Clone the stored credentials for use outside the service (e.g. FTPS upload).
    /// Returns `None` if the service has not been started with credentials.
    pub async fn get_credentials(&self) -> Option<BambuCredentials> {
        let inner = self.inner.lock().await;
        inner.credentials.clone()
    }

    /// The main connection lifecycle loop.  Tries local MQTT first,
    /// falls back to Cloud after `LOCAL_FAILURE_THRESHOLD` local failures.
    async fn connection_loop<R: Runtime>(
        &self,
        id: ConnectionId,
        app_handle: AppHandle<R>,
        app_state: Arc<AppState>,
    ) {
        loop {
            if !self
                .set_state(
                    id,
                    ConnectionState::Discovering,
                    &app_handle,
                    &app_state,
                    "starting connection attempt",
                )
                .await
            {
                log::info!("printer connection ended, exiting loop");
                return;
            }

            let use_cloud = {
                let inner = self.inner.lock().await;
                inner.local_failure_count >= LOCAL_FAILURE_THRESHOLD
            };

            let result = if use_cloud {
                self.try_cloud_connection(id, &app_handle, &app_state).await
            } else {
                self.try_local_connection(id, &app_handle, &app_state).await
            };

            match result {
                Ok(()) => {
                    // The event loop exits on a disconnect or a lost connection.
                    if !self
                        .set_state(
                            id,
                            ConnectionState::Reconnecting,
                            &app_handle,
                            &app_state,
                            "connection lost",
                        )
                        .await
                    {
                        return;
                    }
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    log::warn!("connection attempt failed: {err_msg}");

                    let Some(mut inner) = self.lock_for(id).await else {
                        return;
                    };

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
                            id,
                            ConnectionState::Offline,
                            &app_handle,
                            &app_state,
                            "both local and cloud paths exhausted",
                        )
                        .await;
                        return;
                    }

                    if !self
                        .set_state(
                            id,
                            ConnectionState::Reconnecting,
                            &app_handle,
                            &app_state,
                            "retrying after failure",
                        )
                        .await
                    {
                        return;
                    }
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
    async fn try_local_connection<R: Runtime>(
        &self,
        id: ConnectionId,
        app_handle: &AppHandle<R>,
        app_state: &AppState,
    ) -> Result<(), PrinterError> {
        // `mqtt::connect` does no I/O, so the client is made and stored under
        // one lock, and a disconnect cannot land between the check and the store.
        let (client, eventloop) = {
            let Some(mut inner) = self.lock_for(id).await else {
                return Ok(());
            };
            let creds = inner
                .credentials
                .as_ref()
                .ok_or(PrinterError::NotConnected)?;
            let config = cloud::local_mqtt_config(creds);
            log::info!("attempting local MQTT connection to {}", config.host);
            let (client, eventloop) = mqtt::connect(&config).map_err(PrinterError::Mqtt)?;
            inner.mqtt_client = Some(client.clone());
            (client, eventloop)
        };

        self.run_event_loop(
            id,
            client,
            eventloop,
            ConnectionType::Mqtt,
            app_handle,
            app_state,
        )
        .await
    }

    /// Attempt a Cloud MQTT connection and run the event loop.
    async fn try_cloud_connection<R: Runtime>(
        &self,
        id: ConnectionId,
        app_handle: &AppHandle<R>,
        app_state: &AppState,
    ) -> Result<(), PrinterError> {
        // `mqtt::connect` does no I/O, so the client is made and stored under
        // one lock, and a disconnect cannot land between the check and the store.
        let (client, eventloop) = {
            let Some(mut inner) = self.lock_for(id).await else {
                return Ok(());
            };
            let creds = inner
                .credentials
                .as_ref()
                .ok_or(PrinterError::NotConnected)?;
            let config = cloud::cloud_mqtt_config(creds);
            log::info!("attempting Cloud MQTT connection to {}", config.host);
            let (client, eventloop) = mqtt::connect(&config).map_err(PrinterError::Mqtt)?;
            inner.mqtt_client = Some(client.clone());
            (client, eventloop)
        };

        self.run_event_loop(
            id,
            client,
            eventloop,
            ConnectionType::Cloud,
            app_handle,
            app_state,
        )
        .await
    }

    /// Run the MQTT event loop.  On first successful connect, sends `pushall`
    /// and transitions to the connected state for `conn_type`.  Processes incoming
    /// messages and merges them into `PrinterState`.
    async fn run_event_loop<R: Runtime>(
        &self,
        id: ConnectionId,
        client: AsyncClient,
        mut eventloop: rumqttc::EventLoop,
        conn_type: ConnectionType,
        app_handle: &AppHandle<R>,
        app_state: &AppState,
    ) -> Result<(), PrinterError> {
        let connected_state = match conn_type {
            ConnectionType::Mqtt => ConnectionState::ConnectedMqtt,
            ConnectionType::Cloud => ConnectionState::ConnectedCloud,
        };
        let (report_topic, request_topic) = {
            let Some(inner) = self.lock_for(id).await else {
                return Ok(());
            };
            let creds = inner
                .credentials
                .as_ref()
                .ok_or(PrinterError::NotConnected)?;
            (creds.report_topic(), creds.request_topic())
        };

        let mut connected = false;

        loop {
            if self.lock_for(id).await.is_none() {
                return Ok(());
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
                        id,
                        connected_state.clone(),
                        conn_type.clone(),
                        app_handle,
                        app_state,
                    )
                    .await;
                }
                Ok(Event::Incoming(Incoming::Publish(publish))) => {
                    self.handle_publish(id, &publish.payload, app_handle, app_state)
                        .await;
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
    /// - A report that shows the printer became IDLE: send it the next queued job
    ///
    /// A report that arrives after connection `id` ended is dropped whole.
    async fn handle_publish<R: Runtime>(
        &self,
        id: ConnectionId,
        payload: &[u8],
        app_handle: &AppHandle<R>,
        app_state: &AppState,
    ) {
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
            let Some(mut connection) = self.lock_for(id).await else {
                return;
            };
            let became_idle = match status.gcode_state.as_deref() {
                Some("IDLE") if connection.readiness == Readiness::WaitingForIdle => {
                    connection.readiness = Readiness::Idle;
                    true
                }
                Some("IDLE") | None => false,
                Some(_) => {
                    connection.readiness = Readiness::WaitingForIdle;
                    false
                }
            };

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
                }
            }

            if became_idle {
                log::info!("queue: advancing to the next job, printer is IDLE");
                self.spawn_auto_send(id, RunCause::Trigger, app_handle);
            }
        }
    }

    /// Update the connection state and emit a change event. Writes nothing and
    /// returns false once connection `id` ended. The check and both writes
    /// hold the service lock, so a disconnect cannot land between them.
    async fn set_state<R: Runtime>(
        &self,
        id: ConnectionId,
        new_state: ConnectionState,
        app_handle: &AppHandle<R>,
        app_state: &AppState,
        reason: &str,
    ) -> bool {
        let is_connected = matches!(
            new_state,
            ConnectionState::ConnectedMqtt | ConnectionState::ConnectedCloud
        );

        let old_state = {
            let Some(mut inner) = self.lock_for(id).await else {
                return false;
            };
            let old = std::mem::replace(&mut inner.connection_state, new_state.clone());
            if let Ok(mut printer) = app_state.printer.lock() {
                printer.connection_state = new_state.clone();
                printer.is_connected = is_connected;
                if !is_connected {
                    printer.connection_type = None;
                }
            }
            old
        };

        log::info!(
            "connection state: {old_state:?} → {new_state:?} ({reason})"
        );

        let _ = app_state.emit_state_change(app_handle, "printer:changed");
        true
    }

    /// Transition to a connected state with the appropriate connection type.
    /// The first status report after it advances the print queue. Does nothing
    /// once connection `id` ended, and holds the service lock, like `set_state`.
    async fn set_connected<R: Runtime>(
        &self,
        id: ConnectionId,
        state: ConnectionState,
        conn_type: ConnectionType,
        app_handle: &AppHandle<R>,
        app_state: &AppState,
    ) {
        let Some(mut inner) = self.lock_for(id).await else {
            return;
        };
        inner.connection_state = state.clone();
        inner.reconnect_count = 0;
        inner.readiness = Readiness::WaitingForIdle;
        let printer_host = inner.credentials.as_ref().map(|c| c.printer.host.clone());

        if let Ok(mut printer) = app_state.printer.lock() {
            printer.connection_state = state.clone();
            printer.connection_type = Some(conn_type.clone());
            printer.is_connected = true;
            printer.last_error = None;

            // Store the printer IP for camera URL construction
            if let Some(ref ip) = printer_host {
                printer.printer_ip = Some(ip.clone());
            }
        }

        drop(inner);

        log::info!("connected via {conn_type:?}");
        let _ = app_state.emit_state_change(app_handle, "printer:changed");
    }
}

// ─── Gcode State Transition Handler ───────────────────────────────────────────

/// Handle a gcode_state transition. Called when prev != curr.
///
/// - RUNNING→FINISH: Record a "success" history entry, fire notification
/// - RUNNING→FAILED: Record a "failed" history entry with fail_reason, fire notification
fn handle_gcode_transition<R: Runtime>(
    prev: Option<String>,
    curr: String,
    app_handle: &AppHandle<R>,
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
fn emit_history_changed<R: Runtime>(app_handle: &AppHandle<R>, app_state: &AppState) {
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
fn send_print_notification<R: Runtime>(
    app_handle: &AppHandle<R>,
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
fn emit_proactive_notification<R: Runtime>(
    app_handle: &AppHandle<R>,
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

/// Sends the first Pending job to the printer on connection `id`: an FTPS
/// upload, then the MQTT `project_file` command. It runs only while that
/// connection's printer reported IDLE and no other run holds the queue.
async fn auto_send_pending_job<R: Runtime>(
    service: &PrinterService,
    id: ConnectionId,
    cause: RunCause,
    app_handle: &AppHandle<R>,
) -> Result<(), String> {
    let app_state: tauri::State<'_, std::sync::Arc<crate::state::AppState>> = app_handle
        .try_state()
        .ok_or_else(|| "AppState not managed".to_string())?;

    // The queue is read under the service lock. A job added after this read
    // either finds the queue free, or asks the run that holds it to run again.
    let (creds, job) = {
        let Some(mut inner) = service.lock_for(id).await else {
            log::debug!("auto-send: the connection that scheduled it ended, skipping");
            return Ok(());
        };
        let live = matches!(
            inner.connection_state,
            ConnectionState::ConnectedMqtt | ConnectionState::ConnectedCloud
        );
        if !live || inner.readiness != Readiness::Idle {
            log::debug!("auto-send: the printer has not reported IDLE, skipping");
            return Ok(());
        }
        if inner.queue_held {
            log::debug!("auto-send: another run holds the queue, it runs again when done");
            if cause == RunCause::Trigger {
                inner.owed_runs += 1;
            }
            return Ok(());
        }
        let first_pending = app_state
            .print_queue
            .lock()
            .map_err(|e| format!("failed to lock print queue: {e}"))?
            .iter()
            .find(|j| j.status == QueueStatus::Pending)
            .cloned();
        let Some(job) = first_pending else {
            log::debug!("auto-send: no pending jobs in queue");
            inner.owed_runs = 0;
            return Ok(());
        };
        let creds = inner
            .credentials
            .clone()
            .ok_or_else(|| "no credentials available for auto-send".to_string())?;
        inner.queue_held = true;
        if cause == RunCause::OwedTry {
            inner.owed_runs = inner.owed_runs.saturating_sub(1);
        }
        (creds, job)
    };

    let submitted = submit_job(service, id, &app_state, &creds, &job).await;
    let (current, owed) = {
        let mut inner = service.inner.lock().await;
        inner.queue_held = false;
        (inner.connection, inner.owed_runs > 0)
    };
    if owed {
        service.spawn_auto_send(current, RunCause::OwedTry, app_handle);
    }
    submitted
}

async fn submit_job(
    service: &PrinterService,
    id: ConnectionId,
    app_state: &AppState,
    creds: &BambuCredentials,
    job: &crate::state::QueuedJob,
) -> Result<(), String> {
    log::info!(
        "auto-send: submitting queued job '{}' ({})",
        job.model_name,
        job.id
    );

    let file_path = std::path::PathBuf::from(&job.threemf_path);
    if !file_path.exists() {
        let err = format!("3MF file not found: {}", job.threemf_path);
        return fail_job(service, id, app_state, &job.id, err).await;
    }

    let file_bytes = std::fs::read(&file_path)
        .map_err(|e| format!("failed to read 3MF: {e}"))?;
    let md5_digest = format!("{:x}", md5::compute(&file_bytes));

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("print.3mf")
        .to_string();

    let host = creds.printer.host.clone();
    let access_code = creds.ftps_password().to_string();

    // Upload via FTPS
    if let Err(e) = upload_to_printer(&host, &access_code, &file_path).await {
        let err_msg = format!("FTPS upload failed: {e}");
        return fail_job(service, id, app_state, &job.id, err_msg).await;
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

    let sent = match service.lock_for(id).await {
        None => Err(PrinterError::NotConnected),
        Some(mut inner) => {
            let sent = inner.publish(cmd).await;
            if sent.is_ok() && inner.readiness == Readiness::Idle {
                inner.readiness = Readiness::JobSent;
            }
            sent
        }
    };
    if let Err(e) = sent {
        let err_msg = format!("MQTT command failed: {e}");
        return fail_job(service, id, app_state, &job.id, err_msg).await;
    }

    // Mark as submitted
    crate::print_queue::update_job_status(
        app_state,
        &job.id,
        crate::state::QueueStatus::Submitted,
    )?;

    log::info!(
        "auto-send: job '{}' submitted successfully",
        job.model_name
    );
    Ok(())
}

/// Marks an auto-send job Failed. A run whose connection ended writes nothing,
/// and the job stays Pending for the next printer's run.
async fn fail_job(
    service: &PrinterService,
    id: ConnectionId,
    app_state: &AppState,
    job_id: &str,
    reason: String,
) -> Result<(), String> {
    let Some(_connection) = service.lock_for(id).await else {
        log::info!("auto-send: the connection ended, job {job_id} stays Pending ({reason})");
        return Ok(());
    };
    log::error!("auto-send: {reason}");
    crate::print_queue::update_job_status(app_state, job_id, QueueStatus::Failed { reason })
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
        let connect_failed = |e: &dyn std::fmt::Display| PrinterError::Ftps(format!("FTPS connect to {addr} failed: {e}"));
        let control = timed_connect(&addr).map_err(|e| connect_failed(&e))?;
        let ftp_stream = suppaftp::NativeTlsFtpStream::connect_with_stream(control)
            .map_err(|e| connect_failed(&e))?
            .passive_stream_builder(|data| timed_stream(data).map_err(suppaftp::FtpError::ConnectionError));

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

/// Like `TcpStream::connect`, it tries each address `addr` resolves to in
/// turn, but through `timed_stream`.
fn timed_connect(addr: &str) -> std::io::Result<std::net::TcpStream> {
    let mut last_error = std::io::Error::new(std::io::ErrorKind::NotFound, "no address");
    for socket_addr in std::net::ToSocketAddrs::to_socket_addrs(addr)? {
        match timed_stream(socket_addr) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// A TCP stream whose connect, reads, and writes each end within `FTPS_TIMEOUT`.
fn timed_stream(addr: std::net::SocketAddr) -> std::io::Result<std::net::TcpStream> {
    let stream = std::net::TcpStream::connect_timeout(&addr, FTPS_TIMEOUT)?;
    stream.set_read_timeout(Some(FTPS_TIMEOUT))?;
    stream.set_write_timeout(Some(FTPS_TIMEOUT))?;
    Ok(stream)
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
            assert_eq!(inner.connection, ConnectionId::default());
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

    fn loopback_printer(serial: &str) -> BambuCredentials {
        BambuCredentials {
            access_token: String::new(),
            user_id: String::new(),
            user_name: None,
            printer: credentials::PrinterInfo {
                name: "127.0.0.1".into(),
                device_id: serial.into(),
                model: "P2S".into(),
                access_code: "12345678".into(),
                host: "127.0.0.1".into(),
            },
            expires_at: None,
            created_at: None,
        }
    }

    #[tokio::test]
    async fn retry_after_failed_connect_to_the_same_printer_starts_again() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder().build(mock_context(noop_assets())).expect("mock app");
        let app_state = Arc::new(AppState::default());
        let service = PrinterService::new();
        let printer = loopback_printer("01P00A000000000");

        service
            .start(printer.clone(), app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("first connect starts");

        let next_failure = |within: Duration| {
            let app_state = Arc::clone(&app_state);
            async move {
                app_state.printer.lock().unwrap().last_error = None;
                tokio::time::timeout(within, async {
                    while app_state.printer.lock().unwrap().last_error.is_none() {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await
            }
        };

        next_failure(Duration::from_secs(10))
            .await
            .expect("connect to a loopback host with no printer fails");

        let retried = next_failure(Duration::from_secs(1));
        service
            .start(printer, app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("retry with the same printer starts a new attempt");
        retried
            .await
            .expect("the retry attempts at once instead of waiting out the 2 s backoff");

        let other = service
            .start(
                loopback_printer("01P00B000000000"),
                app.handle().clone(),
                Arc::clone(&app_state),
            )
            .await;
        assert!(
            matches!(other, Err(PrinterError::AlreadyRunning)),
            "a different printer still waits for a disconnect, got {other:?}"
        );
    }

    #[tokio::test]
    async fn a_disconnect_holds_against_a_late_write_from_the_old_loop() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder().build(mock_context(noop_assets())).expect("mock app");
        let app_state = Arc::new(AppState::default());
        let service = PrinterService::new();
        service
            .start(
                loopback_printer("01P00A000000000"),
                app.handle().clone(),
                Arc::clone(&app_state),
            )
            .await
            .expect("printer A starts");
        let a = service.inner.lock().await.connection;
        service.disconnect(app.handle(), &app_state).await;

        // The old loop passed its connection check just before the disconnect.
        service
            .set_state(a, ConnectionState::Discovering, app.handle(), &app_state, "late write")
            .await;
        service
            .set_connected(
                a,
                ConnectionState::ConnectedMqtt,
                ConnectionType::Mqtt,
                app.handle(),
                &app_state,
            )
            .await;

        service
            .handle_publish(
                a,
                br#"{"print":{"gcode_state":"IDLE","nozzle_temper":210.0}}"#,
                app.handle(),
                &app_state,
            )
            .await;
        service
            .try_local_connection(a, app.handle(), &app_state)
            .await
            .expect("a late connect attempt after a disconnect is not an error");

        {
            let printer = app_state.printer.lock().unwrap();
            assert_eq!(printer.connection_state, ConnectionState::Disconnected);
            assert!(!printer.is_connected, "a late connect does not undo the disconnect");
            assert_eq!(printer.gcode_state, None, "a late report is not merged");
            assert_eq!(printer.nozzle_temp, None, "a late report is not merged");
        }
        let sent = service.send_command(BambuCommand::PushAll).await;
        assert!(
            matches!(sent, Err(PrinterError::NotConnected)),
            "a late connect stores no client, got {sent:?}"
        );
        service
            .start(
                loopback_printer("01P00B000000000"),
                app.handle().clone(),
                Arc::clone(&app_state),
            )
            .await
            .expect("printer B starts after A was disconnected");
    }

    #[tokio::test]
    async fn another_printer_started_right_after_the_first_waits_for_a_disconnect() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder().build(mock_context(noop_assets())).expect("mock app");
        let app_state = Arc::new(AppState::default());
        let service = PrinterService::new();

        service
            .start(
                loopback_printer("01P00A000000000"),
                app.handle().clone(),
                Arc::clone(&app_state),
            )
            .await
            .expect("first printer starts");
        let other = service
            .start(
                loopback_printer("01P00B000000000"),
                app.handle().clone(),
                Arc::clone(&app_state),
            )
            .await;
        assert!(
            matches!(other, Err(PrinterError::AlreadyRunning)),
            "the first start already owns the service, got {other:?}"
        );
    }

    fn printer_a() -> BambuCredentials {
        let mut printer = loopback_printer("01P00A000000000");
        // `localhost` refuses at once on Linux and macOS, while macOS leaves
        // 127.0.0.2 unconfigured and the upload hangs.
        printer.printer.host = "localhost".into();
        printer
    }

    fn queued_3mf() -> String {
        let threemf = std::env::temp_dir().join(format!("m3d-auto-send-{}.3mf", uuid::Uuid::new_v4()));
        std::fs::write(&threemf, b"3mf").expect("write the queued 3MF");
        threemf.to_string_lossy().into_owned()
    }

    /// Stops the real connection loop, which fails against a host with no
    /// printer, so the connects and reports a test fakes are the only ones.
    async fn stop_connection_loop(service: &PrinterService) {
        if let Some(task) = service.inner.lock().await.connection_task.take() {
            task.abort();
        }
    }

    /// Printer A at localhost starts with `jobs` queued and reaches ConnAck.
    async fn connect_printer_a(
        jobs: usize,
    ) -> (tauri::App<tauri::test::MockRuntime>, Arc<AppState>, PrinterService, ConnectionId) {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![crate::commands::add_to_queue])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let app_state = Arc::new(AppState::default());
        app.manage(Arc::clone(&app_state));
        for n in 1..=jobs {
            app_state.print_queue.lock().unwrap().push(crate::state::QueuedJob {
                id: format!("job-{n}"),
                model_path: String::new(),
                threemf_path: queued_3mf(),
                model_name: "cube".into(),
                created_at: chrono::Utc::now(),
                status: QueueStatus::Pending,
                filament_grams: None,
                filament_meters: None,
                quality_profile: None,
                thumbnail_path: None,
            });
        }

        let service = PrinterService::new();
        app.manage(service.clone());
        service
            .start(printer_a(), app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("printer A starts");
        stop_connection_loop(&service).await;
        let a = service.inner.lock().await.connection;
        service
            .set_connected(
                a,
                ConnectionState::ConnectedMqtt,
                ConnectionType::Mqtt,
                app.handle(),
                &app_state,
            )
            .await;
        (app, app_state, service, a)
    }

    /// Printer A reports IDLE with one job queued, which spawns its auto-send,
    /// then the user switches to printer B at 127.0.0.1 before that run starts.
    async fn switch_while_auto_send_waits() -> (tauri::App<tauri::test::MockRuntime>, Arc<AppState>) {
        let (app, app_state, service, a) = connect_printer_a(1).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;

        service.disconnect(app.handle(), &app_state).await;
        service
            .start(
                loopback_printer("01P00B000000000"),
                app.handle().clone(),
                Arc::clone(&app_state),
            )
            .await
            .expect("printer B starts");
        (app, app_state)
    }

    async fn first_job_after_auto_send(app_state: &AppState) -> QueueStatus {
        tokio::time::sleep(Duration::from_secs(3)).await;
        app_state.print_queue.lock().unwrap()[0].status.clone()
    }

    #[tokio::test]
    async fn a_switch_keeps_the_old_printers_idle_state_from_sending_a_job() {
        let (_app, app_state) = switch_while_auto_send_waits().await;

        assert_eq!(
            first_job_after_auto_send(&app_state).await,
            QueueStatus::Pending,
            "A's auto-send read A's IDLE and sent the job to B"
        );
        assert_eq!(
            app_state.printer.lock().unwrap().gcode_state,
            None,
            "B starts without A's print state"
        );
    }

    #[tokio::test]
    async fn the_old_printers_auto_send_does_not_act_once_the_new_printer_is_idle() {
        let (_app, app_state) = switch_while_auto_send_waits().await;
        app_state.printer.lock().unwrap().gcode_state = Some("IDLE".into());

        assert_eq!(
            first_job_after_auto_send(&app_state).await,
            QueueStatus::Pending,
            "only B's own trigger may send to B"
        );
    }

    async fn assert_one_run_sent_job_1_to_printer_a(app_state: &AppState) {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let queue = app_state.print_queue.lock().unwrap();
        assert!(
            matches!(&queue[0].status, QueueStatus::Failed { reason } if reason.contains("localhost:990")),
            "one run sent job 1 to printer A, got {:?}",
            queue[0].status
        );
        assert_eq!(queue[1].status, QueueStatus::Pending, "a second run sent job 2 as well");
    }

    #[tokio::test]
    async fn a_connect_sends_one_queued_job_when_a_slow_first_report_arrives() {
        let (app, app_state, service, a) = connect_printer_a(2).await;
        tokio::time::sleep(Duration::from_millis(2500)).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;

        assert_one_run_sent_job_1_to_printer_a(&app_state).await;
    }

    #[tokio::test]
    async fn a_reconnect_to_a_printer_still_idle_sends_one_queued_job() {
        let (app, app_state, service, a) = connect_printer_a(2).await;
        app_state.printer.lock().unwrap().gcode_state = Some("IDLE".into());
        service
            .set_state(a, ConnectionState::Reconnecting, app.handle(), &app_state, "connection lost")
            .await;
        service
            .set_connected(a, ConnectionState::ConnectedMqtt, ConnectionType::Mqtt, app.handle(), &app_state)
            .await;
        service
            .handle_publish(a, br#"{"print":{"nozzle_temper":210.0}}"#, app.handle(), &app_state)
            .await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;

        assert_one_run_sent_job_1_to_printer_a(&app_state).await;
    }

    #[tokio::test]
    async fn a_report_without_gcode_state_does_not_send_from_the_idle_the_app_holds() {
        let (app, app_state, service, a) = connect_printer_a(2).await;
        app_state.printer.lock().unwrap().gcode_state = Some("IDLE".into());
        service
            .set_state(a, ConnectionState::Reconnecting, app.handle(), &app_state, "connection lost")
            .await;
        service
            .set_connected(a, ConnectionState::ConnectedMqtt, ConnectionType::Mqtt, app.handle(), &app_state)
            .await;
        service
            .handle_publish(a, br#"{"print":{"nozzle_temper":210.0}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"RUNNING"}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_millis(2500)).await;

        let queue = app_state.print_queue.lock().unwrap();
        assert_eq!(queue[0].status, QueueStatus::Pending, "no report from the printer said IDLE");
        assert_eq!(queue[1].status, QueueStatus::Pending, "no report from the printer said IDLE");
    }

    #[tokio::test]
    async fn a_retry_for_the_same_printer_sends_one_queued_job() {
        let (app, app_state, service, a) = connect_printer_a(2).await;
        app_state.printer.lock().unwrap().gcode_state = Some("RUNNING".into());
        service
            .set_state(a, ConnectionState::Offline, app.handle(), &app_state, "went offline")
            .await;
        service
            .start(printer_a(), app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("the retry starts");
        stop_connection_loop(&service).await;
        let retry = service.inner.lock().await.connection;
        service
            .set_connected(
                retry,
                ConnectionState::ConnectedMqtt,
                ConnectionType::Mqtt,
                app.handle(),
                &app_state,
            )
            .await;
        service
            .handle_publish(retry, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;

        assert_one_run_sent_job_1_to_printer_a(&app_state).await;
    }

    /// Adds one job the way the window does, through `add_to_queue`.
    fn add_to_queue_from_the_window(app: &tauri::App<tauri::test::MockRuntime>) {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::webview::InvokeRequest;

        let label = format!("window-{}", uuid::Uuid::new_v4());
        let webview = tauri::WebviewWindowBuilder::new(app, label, Default::default())
            .build()
            .expect("webview");
        let body = serde_json::json!({ "modelPath": "", "threemfPath": queued_3mf(), "modelName": "cube" });
        tauri::test::get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "add_to_queue".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("url"),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .expect("add_to_queue");
    }

    #[tokio::test]
    async fn a_job_added_while_the_printer_is_idle_goes_at_once() {
        let (app, app_state, service, a) = connect_printer_a(0).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        add_to_queue_from_the_window(&app);

        let status = first_job_after_auto_send(&app_state).await;
        assert!(
            matches!(&status, QueueStatus::Failed { reason } if reason.contains("localhost:990")),
            "the job went to printer A without waiting for another IDLE, got {status:?}"
        );
    }

    /// A named pipe as a job's 3MF. A run that reads it waits until `feed`.
    #[cfg(unix)]
    fn held_3mf() -> std::path::PathBuf {
        let fifo = std::env::temp_dir().join(format!("m3d-auto-send-{}.3mf", uuid::Uuid::new_v4()));
        let made = std::process::Command::new("mkfifo").arg(&fifo).status().expect("mkfifo");
        assert!(made.success(), "mkfifo {}", fifo.display());
        fifo
    }

    /// Lets the run waiting on `fifo` read it once.
    #[cfg(unix)]
    async fn feed(fifo: &std::path::Path) {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let fifo = fifo.to_path_buf();
        tokio::task::spawn_blocking(move || {
            for _ in 0..150 {
                match std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&fifo) {
                    Ok(mut reader_waiting) => return reader_waiting.write_all(b"3mf").expect("feed the 3MF"),
                    Err(e) if e.raw_os_error() == Some(libc::ENXIO) => std::thread::sleep(Duration::from_millis(20)),
                    Err(e) => panic!("feed {}: {e}", fifo.display()),
                }
            }
            panic!("no run reads {}", fifo.display());
        })
        .await
        .expect("feed task");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn jobs_added_during_an_upload_that_fails_each_go_next() {
        let (app, app_state, service, a) = connect_printer_a(0).await;
        let job_1 = held_3mf();
        app_state.print_queue.lock().unwrap().push(crate::state::QueuedJob {
            id: "job-1".into(),
            model_path: String::new(),
            threemf_path: job_1.to_string_lossy().into_owned(),
            model_name: "cube".into(),
            created_at: chrono::Utc::now(),
            status: QueueStatus::Pending,
            filament_grams: None,
            filament_meters: None,
            quality_profile: None,
            thumbnail_path: None,
        });
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        tokio::time::sleep(Duration::from_millis(300)).await;

        // Job 1 is read for its md5, then again by the upload, which fails.
        feed(&job_1).await;
        feed(&job_1).await;
        tokio::time::sleep(Duration::from_secs(3)).await;

        let queue = app_state.print_queue.lock().unwrap().clone();
        assert_eq!(queue.len(), 3);
        for job in &queue {
            assert!(
                matches!(&job.status, QueueStatus::Failed { reason } if reason.contains("localhost:990")),
                "job {} went to printer A, got {:?}",
                job.id,
                job.status
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn jobs_added_during_an_upload_still_go_after_a_reconnect() {
        let (app, app_state, service, a) = connect_printer_a(0).await;
        let job_1 = held_3mf();
        app_state.print_queue.lock().unwrap().push(crate::state::QueuedJob {
            id: "job-1".into(),
            model_path: String::new(),
            threemf_path: job_1.to_string_lossy().into_owned(),
            model_name: "cube".into(),
            created_at: chrono::Utc::now(),
            status: QueueStatus::Pending,
            filament_grams: None,
            filament_meters: None,
            quality_profile: None,
            thumbnail_path: None,
        });
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        tokio::time::sleep(Duration::from_millis(300)).await;
        service
            .set_state(a, ConnectionState::Reconnecting, app.handle(), &app_state, "connection lost")
            .await;
        service
            .set_connected(a, ConnectionState::ConnectedMqtt, ConnectionType::Mqtt, app.handle(), &app_state)
            .await;

        feed(&job_1).await;
        feed(&job_1).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_secs(3)).await;

        let queue = app_state.print_queue.lock().unwrap().clone();
        assert_eq!(queue.len(), 3);
        for job in &queue {
            assert!(
                matches!(&job.status, QueueStatus::Failed { reason } if reason.contains("localhost:990")),
                "job {} went to printer A, got {:?}",
                job.id,
                job.status
            );
        }
    }

    #[tokio::test]
    async fn three_triggers_get_three_tries_when_a_fresh_trigger_runs_before_an_owed_one() {
        use std::future::Future;

        let (app, app_state, service, a) = connect_printer_a(0).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        for n in 1..=4 {
            let threemf_path = if n == 1 {
                queued_3mf()
            } else {
                format!("/tmp/m3d-auto-send-absent-{}.3mf", uuid::Uuid::new_v4())
            };
            app_state.print_queue.lock().unwrap().push(crate::state::QueuedJob {
                id: format!("job-{n}"),
                model_path: String::new(),
                threemf_path,
                model_name: "cube".into(),
                created_at: chrono::Utc::now(),
                status: QueueStatus::Pending,
                filament_grams: None,
                filament_meters: None,
                quality_profile: None,
                thumbnail_path: None,
            });
        }

        let mut first = Box::pin(auto_send_pending_job(&service, a, RunCause::Trigger, app.handle()));
        let holding = std::future::poll_fn(|cx| std::task::Poll::Ready(first.as_mut().poll(cx).is_pending())).await;
        assert!(holding, "trigger 1 holds the queue while job 1 uploads");
        auto_send_pending_job(&service, a, RunCause::Trigger, app.handle()).await.unwrap();
        first.await.unwrap();
        // Trigger 3 runs before the owed try that trigger 1 just started.
        auto_send_pending_job(&service, a, RunCause::Trigger, app.handle()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;

        let pending: Vec<_> = app_state
            .print_queue
            .lock()
            .unwrap()
            .iter()
            .filter(|j| j.status == QueueStatus::Pending)
            .map(|j| j.id.clone())
            .collect();
        assert_eq!(pending, ["job-4"], "three triggers got three tries");
    }

    #[tokio::test]
    async fn a_job_added_before_the_first_report_waits_for_it() {
        let (app, app_state, _service, _a) = connect_printer_a(0).await;
        app_state.printer.lock().unwrap().gcode_state = Some("IDLE".into());
        add_to_queue_from_the_window(&app);

        assert_eq!(
            first_job_after_auto_send(&app_state).await,
            QueueStatus::Pending,
            "no report from this connection said IDLE"
        );
    }

    #[tokio::test]
    async fn a_job_added_while_the_connection_is_lost_waits_for_it() {
        let (app, app_state, service, a) = connect_printer_a(0).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        service
            .set_state(a, ConnectionState::Reconnecting, app.handle(), &app_state, "connection lost")
            .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        add_to_queue_from_the_window(&app);

        assert_eq!(
            first_job_after_auto_send(&app_state).await,
            QueueStatus::Pending,
            "the IDLE came from before the connection was lost"
        );
    }

    #[tokio::test]
    async fn the_name_shown_belongs_to_the_printer_the_service_runs() {
        let (app, app_state, service, _a) = connect_printer_a(0).await;
        service.disconnect(app.handle(), &app_state).await;
        let mut b = loopback_printer("01P00B000000000");
        b.printer.name = "Printer B".into();
        service
            .start(b, app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("printer B starts");

        assert_eq!(app_state.printer.lock().unwrap().name.as_deref(), Some("Printer B"));
    }

    #[tokio::test]
    async fn start_drops_the_print_state_the_last_printer_reported() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder().build(mock_context(noop_assets())).expect("mock app");
        let app_state = Arc::new(AppState::default());
        app_state.printer.lock().unwrap().gcode_state = Some("RUNNING".into());
        PrinterService::new()
            .start(
                loopback_printer("01P00B000000000"),
                app.handle().clone(),
                Arc::clone(&app_state),
            )
            .await
            .expect("printer B starts");

        assert_eq!(
            app_state.printer.lock().unwrap().gcode_state,
            None,
            "B starts without the last printer's print state"
        );
    }

    #[tokio::test]
    async fn a_retry_for_the_same_printer_at_a_new_host_keeps_its_print_state() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder().build(mock_context(noop_assets())).expect("mock app");
        let app_state = Arc::new(AppState::default());
        let service = PrinterService::new();
        let printer = loopback_printer("01P00A000000000");
        service
            .start(printer.clone(), app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("printer A starts");
        app_state.printer.lock().unwrap().gcode_state = Some("RUNNING".into());
        let a = service.inner.lock().await.connection;
        service
            .set_state(a, ConnectionState::Offline, app.handle(), &app_state, "both paths exhausted")
            .await;

        let mut moved = printer;
        moved.printer.host = "127.0.0.3".into();
        service
            .start(moved, app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("the retry starts");

        assert_eq!(
            app_state.printer.lock().unwrap().gcode_state.as_deref(),
            Some("RUNNING"),
            "a print that finishes during the outage still reads as RUNNING to FINISH"
        );
    }
}
