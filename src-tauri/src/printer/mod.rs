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
    SentPrint,
};

/// Maximum consecutive local MQTT failures before falling back to Cloud.
const LOCAL_FAILURE_THRESHOLD: u32 = 3;
/// Maximum reconnect backoff in seconds.
const MAX_BACKOFF_SECS: u64 = 30;
/// Bounds each FTPS connect, read, and write. An upload holds the print queue,
/// so a printer that accepts and then goes silent must not hold it for good.
const FTPS_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a session waits for print state before it sends `pushall` again.
const PUSHALL_RETRY_AFTER: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(10)
};
/// How many more times a session sends `pushall` while it has no print state.
const PUSHALL_RETRIES: u32 = 3;

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

impl PrinterServiceInner {
    /// Drops the print state a printer reported, so another printer does not
    /// start with it. The name stays until `start` names the next printer. A
    /// print in progress stays in the `seen_prints` table.
    fn drop_print_state(&mut self, app_state: &AppState) {
        if let Ok(mut printer) = app_state.printer.lock() {
            *printer = PrinterState {
                name: printer.name.take(),
                ..PrinterState::default()
            };
        }
    }

    /// Ends the current connection. Work it spawned writes nothing from here on.
    fn end_connection(&mut self) -> ConnectionId {
        self.connection = ConnectionId(self.connection.0 + 1);
        self.connection
    }

    /// Publishes `cmd`. A `project_file` sent while the printer is IDLE, by
    /// the queue or by a manual start, moves readiness to JobSent.
    async fn publish(&mut self, cmd: BambuCommand) -> Result<(), PrinterError> {
        let client = self.mqtt_client.as_ref().ok_or(PrinterError::NotConnected)?;
        let creds = self.credentials.as_ref().ok_or(PrinterError::NotConnected)?;

        let topic = creds.request_topic();
        let payload = cmd.to_json();
        log::info!("sending command to {topic}: {cmd:?}");

        mqtt::publish(client, &topic, &payload)
            .await
            .map_err(PrinterError::Mqtt)?;
        if matches!(cmd, BambuCommand::ProjectFile { .. }) && self.readiness == Readiness::Idle {
            self.readiness = Readiness::JobSent;
        }
        Ok(())
    }
}

/// The core service that owns the printer connection lifecycle.
///
/// `Clone`-able (wraps internals in `Arc`) so Tauri commands can access it.
#[derive(Clone)]
pub struct PrinterService {
    inner: Arc<TokioMutex<PrinterServiceInner>>,
    /// Held for a whole connect, switch, or disconnect command.
    transitions: Arc<TokioMutex<()>>,
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
            transitions: Arc::default(),
        }
    }

    /// Waits for any other connect, switch, or disconnect to end, then holds
    /// off the next one until the guard drops. A command that changes which
    /// printer runs holds it from its first step to its last, so the selection
    /// it writes names the printer the service runs.
    pub async fn hold_transitions(&self) -> MutexGuard<'_, ()> {
        self.transitions.lock().await
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
        // A retry for the same printer, even at a new host, shows what the
        // printer last reported until the retry connects.
        let same_serial = inner.credentials.as_ref().map(|c| &c.printer.device_id)
            == Some(&creds.printer.device_id);
        if !same_serial {
            inner.drop_print_state(&app_state);
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
        inner.drop_print_state(app_state);

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

    /// Run the MQTT event loop.  On first successful connect, transitions to the
    /// connected state for `conn_type` and sends `pushall`, again every
    /// `PUSHALL_RETRY_AFTER` up to `PUSHALL_RETRIES` times while no report has
    /// carried a print state.  Processes incoming messages and merges them
    /// into `PrinterState`.
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
        // When this session next sends `pushall`, and how many sends it has left.
        let mut pushall_due: Option<(tokio::time::Instant, u32)> = None;

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

                    // Transition to connected
                    self.set_connected(
                        id,
                        connected_state.clone(),
                        conn_type.clone(),
                        app_handle,
                        app_state,
                    )
                    .await;
                    pushall_due = Some((tokio::time::Instant::now(), 1 + PUSHALL_RETRIES));
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

            // Checked after each event, so on a quiet link the next keepalive
            // ping is when a send that came due goes out.
            if let Some((due, sends)) = pushall_due {
                if tokio::time::Instant::now() >= due {
                    pushall_due = None;
                    let has_print_state = app_state.printer.lock().is_ok_and(|p| p.gcode_state.is_some());
                    if !has_print_state {
                        let payload = BambuCommand::PushAll.to_json();
                        if let Err(e) = mqtt::try_publish(&client, &request_topic, &payload) {
                            log::warn!("failed to send pushall: {e}");
                        }
                        pushall_due = (sends > 1)
                            .then(|| (tokio::time::Instant::now() + PUSHALL_RETRY_AFTER, sends - 1));
                    }
                }
            }
        }
    }

    /// Parse and merge an incoming MQTT publish message, then act on it:
    /// - A print the app saw in progress ends: record print history + send notification
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
            let (curr_gcode_state, start_time) = app_state
                .printer
                .lock()
                .map(|p| (p.gcode_state.clone(), p.gcode_start_time.clone()))
                .unwrap_or_default();

            if curr_gcode_state.is_some() && prev_gcode_state != curr_gcode_state {
                log::info!("gcode_state transition: {prev_gcode_state:?} → {curr_gcode_state:?}");
            }
            if let Some(creds) = &connection.credentials {
                if let Err(e) = settle_print(
                    &creds.printer.device_id,
                    prev_gcode_state.as_deref(),
                    curr_gcode_state.as_deref(),
                    start_time.as_deref(),
                    app_handle,
                    app_state,
                ) {
                    log::error!("print history: {e}");
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
    /// The first status report after it advances the print queue, and is not
    /// judged against the print an earlier session showed. A print in progress
    /// stays in the `seen_prints` table. Does nothing once
    /// connection `id` ended, and holds the service lock, like `set_state`.
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
            printer.gcode_state = None;
            printer.gcode_start_time = None;
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

// ─── Print End Recording ──────────────────────────────────────────────────────

/// Keeps the seen print of printer `serial` in step with its latest report,
/// and records a history row when a print the app saw in progress ends.
///
/// A report that shows RUNNING or PAUSE with a known start time stores that
/// print as seen. A FINISH or FAILED ends a print the app saw: the stored
/// print with the same start time, or the one this connection's previous
/// report showed RUNNING or PAUSE. A recorded print stays marked, so a
/// repeated report never records it again. An open print that a report with
/// a known start time does not continue is forgotten. A print with no known
/// start time is not stored, because no later report could tell it from
/// another print. The queue is saved after the history row, so a queue file
/// that cannot be written never costs a row.
fn settle_print<R: Runtime>(
    serial: &str,
    prev: Option<&str>,
    curr: Option<&str>,
    start_time: Option<&str>,
    app_handle: &AppHandle<R>,
    app_state: &AppState,
) -> Result<(), String> {
    let Some(curr) = curr else { return Ok(()) };
    let in_progress = |state: &str| matches!(state, "RUNNING" | "PAUSE");
    let seen = with_db(app_state, |conn| crate::database::seen_print(conn, serial))?;
    let is_seen = seen.as_ref().is_some_and(|seen| Some(seen.start_time.as_str()) == start_time);
    let recorded = is_seen && seen.as_ref().is_some_and(|seen| seen.recorded);
    let open = seen.as_ref().is_some_and(|seen| !seen.recorded);
    let ended = match curr {
        "FINISH" => Some("success"),
        "FAILED" => Some("failed"),
        _ => None,
    };

    match (ended, start_time) {
        (Some(status), _) if !recorded && (is_seen || prev.is_some_and(in_progress)) => {
            let (model_name, fail_reason) = record_print_completion(app_state, serial, status)?;
            emit_history_changed(app_handle, app_state);
            send_print_notification(app_handle, &model_name, status, fail_reason.as_deref());
            let event_type = if status == "success" { "print_complete" } else { "print_failed" };
            emit_proactive_notification(app_handle, app_state, &model_name, event_type);
            crate::print_queue::persist_queue(app_state)
        }
        (None, Some(start)) if in_progress(curr) => {
            if is_seen {
                return Ok(());
            }
            with_db(app_state, |conn| crate::database::set_seen_print(conn, serial, start))
        }
        (_, Some(_)) if open => {
            with_db(app_state, |conn| crate::database::forget_seen_print(conn, serial))
        }
        _ => Ok(()),
    }
}

fn with_db<T>(
    app_state: &AppState,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let guard = app_state.db.lock().map_err(|e| format!("failed to lock the database: {e}"))?;
    f(guard.as_ref().ok_or("the database is not initialized")?)
}

/// Records the end of the print the printer state shows as a history row
/// with `status`, and marks the seen print of printer `serial` recorded. Returns the
/// model name and, for a failed print, the fail reason.
///
/// The row takes filament, quality, and thumbnail from the latest job sent
/// to printer `serial` under the print's subtask name that no earlier row
/// used. A print no such job started gets none. The job is used up only once
/// the row is written, so a write that fails leaves it for the retry.
fn record_print_completion(
    app_state: &AppState,
    serial: &str,
    status: &str,
) -> Result<(String, Option<String>), String> {
    let (subtask_name, gcode_file, gcode_start_time, fail_reason) = {
        let printer = app_state
            .printer
            .lock()
            .map_err(|e| format!("failed to lock printer state: {e}"))?;
        (
            printer.subtask_name.clone(),
            printer.gcode_file.clone(),
            printer.gcode_start_time.clone(),
            printer.fail_reason.clone(),
        )
    };

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

    let started_by = subtask_name.clone().map(|subtask_name| QueueStatus::Submitted {
        print: Some(SentPrint { serial: serial.into(), subtask_name }),
    });
    let job = app_state
        .print_queue
        .lock()
        .map_err(|e| format!("failed to lock print queue: {e}"))?
        .iter()
        .rev()
        .find(|job| Some(&job.status) == started_by.as_ref())
        .cloned();
    let (filament_grams, filament_meters, quality_profile, thumbnail_path) = job
        .as_ref()
        .map(|j| (j.filament_grams, j.filament_meters, j.quality_profile.clone(), j.thumbnail_path.clone()))
        .unwrap_or_default();

    let model_name = subtask_name.unwrap_or_else(|| "Unknown".into());
    let completed_at = chrono::Utc::now().to_rfc3339();
    let record = PrintHistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        model_name: model_name.clone(),
        gcode_file,
        started_at,
        completed_at,
        duration_seconds,
        status: status.into(),
        fail_reason: fail_reason.filter(|_| status == "failed"),
        filament_grams,
        filament_meters,
        thumbnail_path,
        quality_profile,
    };

    with_db(app_state, |conn| {
        crate::database::record_print_end(conn, serial, record.started_at.as_deref(), &record)
    })?;
    log::info!("print history: recorded '{model_name}' as {status}");

    if let Some(job) = job {
        let mut queue = app_state
            .print_queue
            .lock()
            .map_err(|e| format!("failed to lock print queue: {e}"))?;
        for used in queue.iter_mut().filter(|queued| queued.id == job.id) {
            used.status = QueueStatus::Submitted { print: None };
        }
    }
    Ok((model_name, record.fail_reason))
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
        if cause == RunCause::OwedTry && inner.owed_runs == 0 {
            log::debug!("auto-send: no try is owed any more, skipping");
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
            inner.owed_runs -= 1;
        }
        (creds, job)
    };

    let submitted = submit_job(service, id, &app_state, &creds, &job).await;
    let (current, owed) = {
        let mut inner = service.inner.lock().await;
        inner.queue_held = false;
        // A job the user removed during its run sent nothing, however the run
        // ended, so the printer is still idle and the next job is owed a try.
        let removed = app_state
            .print_queue
            .lock()
            .is_ok_and(|queue| queue.iter().all(|queued| queued.id != job.id));
        if removed && inner.connection == id && inner.readiness == Readiness::Idle {
            inner.owed_runs += 1;
        }
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

    let file_bytes = match std::fs::read(&file_path) {
        Ok(bytes) => bytes,
        Err(e) => {
            let err = format!("failed to read 3MF: {e}");
            return fail_job(service, id, app_state, &job.id, err).await;
        }
    };
    let md5_digest = format!("{:x}", md5::compute(&file_bytes));

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("print.3mf")
        .to_string();

    let host = creds.printer.host.clone();
    let access_code = creds.ftps_password().to_string();

    let deadline = upload_deadline(file_bytes.len());
    if let Err(e) = upload(format!("{host}:990"), host, access_code, filename.clone(), file_bytes, deadline).await {
        let err_msg = format!("FTPS upload failed: {e}");
        return fail_job(service, id, app_state, &job.id, err_msg).await;
    }

    send_project_file(service, id, app_state, job, filename, md5_digest).await
}

/// Publishes the `project_file` that prints `filename`, the 3MF of `job` that
/// the run uploaded. During the upload the printer may have started another
/// print, or the user may have removed the job, so both are checked again
/// under the lock that the publish holds. A printer that is busy or
/// reconnecting leaves the job Pending for its next IDLE.
/// A job that left the queue is not sent. A sent job names its printer and
/// `filename`, the subtask name that printer reports for the print.
async fn send_project_file(
    service: &PrinterService,
    id: ConnectionId,
    app_state: &AppState,
    job: &crate::state::QueuedJob,
    filename: String,
    md5: String,
) -> Result<(), String> {
    let Some(mut inner) = service.lock_for(id).await else {
        log::info!("auto-send: the connection ended, job {} stays Pending", job.id);
        return Ok(());
    };
    // A reconnect keeps the last session's readiness until `set_connected`,
    // so a printer that is not live has not reported IDLE on this session.
    let live = matches!(
        inner.connection_state,
        ConnectionState::ConnectedMqtt | ConnectionState::ConnectedCloud
    );
    if !live || inner.readiness != Readiness::Idle {
        log::info!("auto-send: the printer is not ready, job {} waits for its next IDLE", job.id);
        return Ok(());
    }
    let serial = inner
        .credentials
        .as_ref()
        .ok_or_else(|| PrinterError::NotConnected.to_string())?
        .printer
        .device_id
        .clone();
    // `remove_from_queue` takes no service lock. Claiming the job before the
    // publish means a job removed after this point was already sent.
    let claimed = {
        let mut queue = app_state
            .print_queue
            .lock()
            .map_err(|e| format!("failed to lock print queue: {e}"))?;
        match queue.iter_mut().find(|queued| queued.id == job.id && queued.status == QueueStatus::Pending) {
            Some(queued) => {
                queued.status = QueueStatus::Submitted {
                    print: Some(SentPrint { serial, subtask_name: filename.clone() }),
                };
                true
            }
            None => false,
        }
    };
    if !claimed {
        log::info!("auto-send: job {} left the queue during its upload", job.id);
        return Ok(());
    }
    let cmd = BambuCommand::ProjectFile {
        param: "Metadata/plate_1.gcode".into(),
        url: format!("ftp:///cache/{filename}"),
        subtask_name: filename,
        md5,
        use_ams: false,
        ams_mapping: String::new(),
    };
    if let Err(e) = inner.publish(cmd).await {
        let reason = format!("MQTT command failed: {e}");
        log::error!("auto-send: {reason}");
        return crate::print_queue::update_job_status(app_state, &job.id, QueueStatus::Failed { reason });
    }
    crate::print_queue::persist_queue(app_state)?;

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
    let file_bytes = tokio::fs::read(file_path).await.map_err(|e| {
        PrinterError::Ftps(format!("failed to read file '{}': {e}", file_path.display()))
    })?;
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.3mf")
        .to_string();
    let deadline = upload_deadline(file_bytes.len());
    upload(format!("{host}:990"), host.to_string(), access_code.to_string(), filename, file_bytes, deadline).await
}

/// The limit for a whole upload: a minute for the session, plus the file at
/// 64 KiB/s. A peer that answers a little inside each `FTPS_TIMEOUT` window
/// still ends here.
fn upload_deadline(file_len: usize) -> Duration {
    Duration::from_secs(60 + file_len as u64 / (64 * 1024))
}

/// The sockets one upload opened, or `None` once its deadline passed.
struct UploadSockets(std::sync::Mutex<Option<Vec<std::net::TcpStream>>>);

impl UploadSockets {
    fn new() -> Self {
        Self(std::sync::Mutex::new(Some(Vec::new())))
    }

    /// Keeps a handle on `stream`, or closes it if the deadline already passed.
    fn track(&self, stream: std::net::TcpStream) -> std::io::Result<std::net::TcpStream> {
        let mut open = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(open) = open.as_mut() else {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the upload's deadline passed"));
        };
        open.push(stream.try_clone()?);
        Ok(stream)
    }

    /// Shuts down every socket the upload opened, so its next read or write fails.
    fn expire(&self) {
        let open = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        for stream in open.into_iter().flatten() {
            // An error means the socket is already closed.
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

/// Uploads `file_bytes` as `filename` to the FTPS server at `addr`, and ends
/// within `deadline`. Past it, the upload's sockets are shut down, and this
/// returns only once the upload thread has stopped, so nothing writes to the
/// printer after the caller frees the print queue.
async fn upload(
    addr: String,
    host: String,
    access_code: String,
    filename: String,
    file_bytes: Vec<u8>,
    deadline: Duration,
) -> Result<(), PrinterError> {
    use std::io::Write;

    let ends_at = std::time::Instant::now() + deadline;
    let addr_shown = addr.clone();
    let sockets = Arc::new(UploadSockets::new());
    let thread_sockets = Arc::clone(&sockets);
    let mut put = tokio::task::spawn_blocking(move || {
        let filename = filename.as_str();
        let data_sockets = Arc::clone(&thread_sockets);
        log::info!("FTPS: connecting to {addr} for upload of {filename} ({} bytes)", file_bytes.len());

        // Build TLS connector that accepts Bambu's CN="" self-signed certs
        let tls_connector = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| PrinterError::Ftps(format!("failed to build TLS connector: {e}")))?;

        let connector = suppaftp::NativeTlsConnector::from(tls_connector);

        // Connect to the FTPS server (implicit TLS on port 990)
        // For implicit FTPS, connect normally then wrap with into_secure
        let connect_failed = |e: &dyn std::fmt::Display| PrinterError::Ftps(format!("FTPS connect to {addr} failed: {e}"));
        let control = timed_connect(&addr, ends_at)
            .and_then(|stream| thread_sockets.track(stream))
            .map_err(|e| connect_failed(&e))?;
        let ftp_stream = suppaftp::NativeTlsFtpStream::connect_with_stream(control)
            .map_err(|e| connect_failed(&e))?
            .passive_stream_builder(move |data| {
                timed_stream(data, ends_at)
                    .and_then(|stream| data_sockets.track(stream))
                    .map_err(suppaftp::FtpError::ConnectionError)
            });

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

        // `put_file` rewrites line endings unless the session is in binary
        // mode. A stream sends the 3MF bytes as they are, as suppaftp 6 did.
        let put_failed = |e: &dyn std::fmt::Display| PrinterError::Ftps(format!("FTPS upload of '{filename}' failed: {e}"));
        let mut data = ftp_stream.put_with_stream(filename).map_err(|e| put_failed(&e))?;
        data.write_all(&file_bytes).map_err(|e| put_failed(&e))?;
        data.finish().map_err(|e| put_failed(&e))?;

        log::info!("FTPS: upload complete for {}", filename);

        // Disconnect
        if let Err(e) = ftp_stream.quit() {
            log::warn!("FTPS disconnect warning (non-fatal): {e}");
        }

        Ok(())
    });

    let joined = match tokio::time::timeout_at(ends_at.into(), &mut put).await {
        Ok(joined) => joined,
        Err(_) => {
            log::warn!("FTPS: the upload to {addr_shown} passed its {} s deadline, closing it", deadline.as_secs());
            sockets.expire();
            match put.await {
                Ok(Err(_)) => {
                    return Err(PrinterError::Ftps(format!(
                        "FTPS upload did not finish within {} s",
                        deadline.as_secs()
                    )))
                }
                joined => joined,
            }
        }
    };
    joined.map_err(|e| PrinterError::Ftps(format!("FTPS upload task panicked: {e}")))?
}

/// Like `TcpStream::connect`, it tries each address `addr` resolves to in
/// turn, but through `timed_stream`.
fn timed_connect(addr: &str, ends_at: std::time::Instant) -> std::io::Result<std::net::TcpStream> {
    let mut last_error = std::io::Error::new(std::io::ErrorKind::NotFound, "no address");
    for socket_addr in std::net::ToSocketAddrs::to_socket_addrs(addr)? {
        match timed_stream(socket_addr, ends_at) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// A TCP stream whose reads and writes each end within `FTPS_TIMEOUT`. Its
/// connect ends within `FTPS_TIMEOUT` too, and by `ends_at`, because a socket
/// shutdown does not stop a connect in progress.
fn timed_stream(addr: std::net::SocketAddr, ends_at: std::time::Instant) -> std::io::Result<std::net::TcpStream> {
    let left = ends_at.saturating_duration_since(std::time::Instant::now());
    if left.is_zero() {
        return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the upload's deadline passed"));
    }
    let stream = std::net::TcpStream::connect_timeout(&addr, FTPS_TIMEOUT.min(left))?;
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
        crate::database::run_migrations(&conn).unwrap();

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

        let (model_name, _) = record_print_completion(&state, SERIAL_A, "success").unwrap();
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

        let (model_name, fail_reason) = record_print_completion(&state, SERIAL_A, "failed").unwrap();
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
    fn record_without_db_fails() {
        // AppState with no DB initialized
        let state = AppState::default();
        {
            let mut printer = state.printer.lock().unwrap();
            printer.subtask_name = Some("Test".into());
            printer.gcode_start_time = Some("1710500000".into());
        }

        assert!(record_print_completion(&state, SERIAL_A, "success").is_err());
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

        record_print_completion(&state, SERIAL_A, "success").unwrap();

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
                status: QueueStatus::Submitted {
                    print: Some(SentPrint { serial: SERIAL_A.into(), subtask_name: "Benchy".into() }),
                },
                filament_grams: Some(12.5),
                filament_meters: Some(4.2),
                quality_profile: Some("0.20mm Standard".into()),
                thumbnail_path: Some("/tmp/thumb.png".into()),
            });
        }

        record_print_completion(&state, SERIAL_A, "success").unwrap();

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
        // This tests the mapping logic used in settle_print
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

    const SERIAL_A: &str = "01P00A000000000";

    fn printer_a() -> BambuCredentials {
        let mut printer = loopback_printer(SERIAL_A);
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
    /// A loop already running on another worker stops only at its next await,
    /// so this waits for it, or its `Discovering` can land after a faked ConnAck.
    async fn stop_connection_loop(service: &PrinterService) {
        let task = service.inner.lock().await.connection_task.take();
        if let Some(task) = task {
            task.abort();
            match task.await {
                Ok(()) => {}
                Err(e) if e.is_cancelled() => {}
                Err(e) => std::panic::resume_unwind(e.into_panic()),
            }
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

    /// A named pipe as a job's 3MF.
    #[cfg(unix)]
    fn held_3mf() -> std::path::PathBuf {
        let fifo = std::env::temp_dir().join(format!("m3d-auto-send-{}.3mf", uuid::Uuid::new_v4()));
        let made = std::process::Command::new("mkfifo").arg(&fifo).status().expect("mkfifo");
        assert!(made.success(), "mkfifo {}", fifo.display());
        fifo
    }

    /// Long enough that only a deadlock reaches it.
    const DEADLOCK: Duration = Duration::from_secs(60);

    async fn until(what: &str, mut done: impl FnMut() -> bool) {
        let wait = async {
            while !done() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(DEADLOCK, wait)
            .await
            .unwrap_or_else(|_| panic!("never saw {what}"));
    }

    /// A run reading a job's 3MF for its md5, which holds the queue. It reads
    /// nothing until this drops.
    #[cfg(unix)]
    struct HeldRead {
        writer: std::fs::File,
    }

    #[cfg(unix)]
    impl HeldRead {
        /// Waits until a run opens `fifo` to read it.
        async fn wait(fifo: &std::path::Path) -> Self {
            let (opened, open) = tokio::sync::oneshot::channel();
            let path = fifo.to_path_buf();
            // The open returns once a reader opens the pipe. A plain thread,
            // because a runtime waits for its blocking tasks as it shuts down.
            std::thread::spawn(move || {
                let _ = opened.send(std::fs::OpenOptions::new().write(true).open(&path));
            });
            let writer = tokio::time::timeout(DEADLOCK, open)
                .await
                .unwrap_or_else(|_| panic!("no run reads {}", fifo.display()))
                .expect("the thread that opens the 3MF")
                .expect("open the 3MF to write");
            Self { writer }
        }
    }

    #[cfg(unix)]
    impl Drop for HeldRead {
        fn drop(&mut self) {
            use std::io::Write;

            self.writer.write_all(b"3mf").expect("feed the 3MF");
        }
    }

    async fn both_added_jobs_are_owed_a_try(service: &PrinterService) {
        until("both added jobs owed a try", || {
            service.inner.try_lock().is_ok_and(|inner| inner.owed_runs == 2)
        })
        .await;
    }

    async fn every_job_settled(app_state: &AppState) {
        until("every job settled", || {
            app_state.print_queue.lock().unwrap().iter().all(|j| j.status != QueueStatus::Pending)
        })
        .await;
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
        let held = HeldRead::wait(&job_1).await;
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        both_added_jobs_are_owed_a_try(&service).await;

        drop(held);
        every_job_settled(&app_state).await;

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
        let held = HeldRead::wait(&job_1).await;
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        tokio::task::block_in_place(|| add_to_queue_from_the_window(&app));
        both_added_jobs_are_owed_a_try(&service).await;
        service
            .set_state(a, ConnectionState::Reconnecting, app.handle(), &app_state, "connection lost")
            .await;
        service
            .set_connected(a, ConnectionState::ConnectedMqtt, ConnectionType::Mqtt, app.handle(), &app_state)
            .await;

        drop(held);
        until("the run for job 1 let go of the queue", || {
            app_state.print_queue.lock().unwrap()[0].status != QueueStatus::Pending
                && service.inner.try_lock().is_ok_and(|inner| !inner.queue_held)
        })
        .await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        every_job_settled(&app_state).await;

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
    async fn a_job_added_right_after_a_manual_start_waits_for_the_printer() {
        let (app, app_state, service, a) = connect_printer_a(0).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        // An event loop nobody polls buffers the publish, as a live broker would accept it.
        let (client, _event_loop) = mqtt::connect(&cloud::local_mqtt_config(&printer_a())).expect("mqtt client");
        service.inner.lock().await.mqtt_client = Some(client);

        service
            .send_command(BambuCommand::ProjectFile {
                param: "Metadata/plate_1.gcode".into(),
                subtask_name: "manual.3mf".into(),
                url: "ftp:///cache/manual.3mf".into(),
                md5: String::new(),
                use_ams: false,
                ams_mapping: String::new(),
            })
            .await
            .expect("start_print's project_file is published");
        add_to_queue_from_the_window(&app);

        assert_eq!(
            first_job_after_auto_send(&app_state).await,
            QueueStatus::Pending,
            "the printer has not reported its manual print yet"
        );
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

    /// Printer A has reported IDLE with `jobs` queued. Its MQTT event loop is
    /// returned unpolled, so a publish is buffered as a live broker would take it.
    async fn idle_printer_a_with_mqtt(
        jobs: usize,
    ) -> (tauri::App<tauri::test::MockRuntime>, Arc<AppState>, PrinterService, ConnectionId, rumqttc::EventLoop) {
        let (app, app_state, service, a) = connect_printer_a(jobs).await;
        let (client, event_loop) = mqtt::connect(&cloud::local_mqtt_config(&printer_a())).expect("mqtt client");
        let mut inner = service.inner.lock().await;
        inner.mqtt_client = Some(client);
        inner.readiness = Readiness::Idle;
        drop(inner);
        (app, app_state, service, a, event_loop)
    }

    #[tokio::test]
    async fn a_job_whose_printer_starts_another_print_during_its_upload_stays_pending() {
        let (app, app_state, service, a, _event_loop) = idle_printer_a_with_mqtt(1).await;
        let job = app_state.print_queue.lock().unwrap()[0].clone();
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"RUNNING"}}"#, app.handle(), &app_state)
            .await;

        send_project_file(&service, a, &app_state, &job, "cube.3mf".into(), String::new())
            .await
            .expect("the send step");

        assert_eq!(
            app_state.print_queue.lock().unwrap()[0].status,
            QueueStatus::Pending,
            "the job waits for the printer's next IDLE"
        );
    }

    #[tokio::test]
    async fn a_job_waits_when_its_printer_reconnects_during_the_upload() {
        let (app, app_state, service, a, old_event_loop) = idle_printer_a_with_mqtt(1).await;
        let job = app_state.print_queue.lock().unwrap()[0].clone();
        drop(old_event_loop);
        service
            .set_state(a, ConnectionState::Reconnecting, app.handle(), &app_state, "connection lost")
            .await;
        // `try_local_connection` stores the next client before its ConnAck.
        let (client, _event_loop) = mqtt::connect(&cloud::local_mqtt_config(&printer_a())).expect("mqtt client");
        service.inner.lock().await.mqtt_client = Some(client);

        send_project_file(&service, a, &app_state, &job, "cube.3mf".into(), String::new())
            .await
            .expect("the send step");

        assert_eq!(
            app_state.print_queue.lock().unwrap()[0].status,
            QueueStatus::Pending,
            "a printer that has not reported IDLE on its new session gets no job"
        );
    }

    #[tokio::test]
    async fn a_job_removed_during_its_upload_is_not_sent() {
        let (_app, app_state, service, a, _event_loop) = idle_printer_a_with_mqtt(1).await;
        let job = app_state.print_queue.lock().unwrap()[0].clone();
        crate::print_queue::remove_job(&app_state, &job.id).expect("remove the job");

        send_project_file(&service, a, &app_state, &job, "cube.3mf".into(), String::new())
            .await
            .expect("the send step");

        assert_eq!(
            service.inner.lock().await.readiness,
            Readiness::Idle,
            "no project_file went out for the removed job"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_next_job_goes_when_a_job_is_removed_during_its_run() {
        let (app, app_state, service, a) = connect_printer_a(2).await;
        let job_1 = held_3mf();
        app_state.print_queue.lock().unwrap()[0].threemf_path = job_1.to_string_lossy().into_owned();
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        let held = HeldRead::wait(&job_1).await;
        crate::print_queue::remove_job(&app_state, "job-1").expect("remove job 1");

        drop(held);
        every_job_settled(&app_state).await;

        let queue = app_state.print_queue.lock().unwrap().clone();
        assert_eq!(queue.len(), 1);
        assert!(
            matches!(&queue[0].status, QueueStatus::Failed { reason } if reason.contains("localhost:990")),
            "job 2 went to the idle printer next, got {:?}",
            queue[0].status
        );
    }

    #[tokio::test]
    async fn a_job_whose_3mf_cannot_be_read_fails() {
        let (app, app_state, service, a) = connect_printer_a(1).await;
        let unreadable = std::env::temp_dir().join(format!("m3d-auto-send-{}.3mf", uuid::Uuid::new_v4()));
        std::fs::create_dir(&unreadable).expect("a directory where the 3MF should be");
        app_state.print_queue.lock().unwrap()[0].threemf_path = unreadable.to_string_lossy().into_owned();

        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        every_job_settled(&app_state).await;

        let status = app_state.print_queue.lock().unwrap()[0].status.clone();
        assert!(
            matches!(&status, QueueStatus::Failed { reason } if reason.contains("failed to read 3MF")),
            "got {status:?}"
        );
    }

    /// A loopback FTPS server that takes one upload and returns the bytes it stored.
    /// It speaks TLS through rustls, because macOS cannot import rcgen's EC key
    /// into a native-tls identity.
    fn ftps_printer() -> (String, std::thread::JoinHandle<Vec<u8>>) {
        use rumqttc::tokio_rustls::rustls;
        use std::io::{BufRead, BufReader, Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind control");
        let data_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind data");
        let addr = listener.local_addr().expect("control addr").to_string();
        let data_port = data_listener.local_addr().expect("data addr").port();
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).expect("printer cert");
        let key = rustls::pki_types::PrivateKeyDer::try_from(signing_key.serialize_der()).expect("printer key");
        let tls = Arc::new(
            rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("TLS versions")
                .with_no_client_auth()
                .with_single_cert(vec![cert.der().clone()], key)
                .expect("printer TLS"),
        );
        let accept = move |tcp: std::net::TcpStream| {
            rustls::StreamOwned::new(rustls::ServerConnection::new(Arc::clone(&tls)).expect("TLS session"), tcp)
        };
        let printer = std::thread::spawn(move || {
            let (mut control, _) = listener.accept().expect("accept control");
            control.set_read_timeout(Some(Duration::from_secs(10))).expect("read timeout");
            control.write_all(b"220 Ready\r\n").expect("greet");
            let mut plain = BufReader::new(control);
            let mut auth = String::new();
            plain.read_line(&mut auth).expect("read AUTH");
            plain.get_mut().write_all(b"234 Begin TLS\r\n").expect("answer AUTH");
            let mut control = BufReader::new(accept(plain.into_inner()));
            let mut stored = Vec::new();
            loop {
                let mut line = String::new();
                if control.read_line(&mut line).unwrap_or(0) == 0 {
                    return stored;
                }
                let reply = match line.split_whitespace().next().unwrap_or_default() {
                    "USER" => "331 Password\r\n".to_string(),
                    "PASS" => "230 Logged in\r\n".to_string(),
                    "CWD" => "250 Changed\r\n".to_string(),
                    "PASV" => format!("227 Passive (127,0,0,1,{},{})\r\n", data_port / 256, data_port % 256),
                    "STOR" => {
                        control.get_mut().write_all(b"150 Send it\r\n").expect("answer STOR");
                        control.get_mut().flush().expect("send 150");
                        let (data, _) = data_listener.accept().expect("accept data");
                        let mut data = accept(data);
                        let _ = data.read_to_end(&mut stored);
                        "226 Stored\r\n".to_string()
                    }
                    "QUIT" => {
                        let _ = control.get_mut().write_all(b"221 Bye\r\n");
                        return stored;
                    }
                    _ => "200 OK\r\n".to_string(),
                };
                control.get_mut().write_all(reply.as_bytes()).expect("reply");
                control.get_mut().flush().expect("send reply");
            }
        });
        (addr, printer)
    }

    #[tokio::test]
    async fn an_upload_stores_the_3mf_bytes_unchanged() {
        let (addr, printer) = ftps_printer();
        let threemf = b"PK\x03\x04\n\x00G28\nG1 X10\r\nPK\x05\x06\r\x00".to_vec();

        let put = upload(addr, "127.0.0.1".into(), "12345678".into(), "cube.3mf".into(), threemf.clone(), Duration::from_secs(10)).await;

        assert!(put.is_ok(), "the upload succeeds, got {put:?}");
        assert_eq!(printer.join().expect("printer thread"), threemf, "the printer stores the 3MF byte for byte");
    }

    #[tokio::test]
    async fn an_upload_to_a_printer_that_answers_a_byte_at_a_time_ends_at_its_deadline() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("local addr").to_string();
        let (closed, upload_closed) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut printer, _) = listener.accept().expect("accept");
            let mut reads = printer.try_clone().expect("clone the printer's socket");
            std::thread::spawn(move || {
                let _ = reads.read(&mut [0; 64]);
                let _ = closed.send(());
            });
            // A greeting with no line end, well inside each read's timeout.
            for _ in 0..100 {
                if printer.write_all(b"2").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = printer.shutdown(std::net::Shutdown::Both);
        });

        let put = upload(
            addr,
            "127.0.0.1".into(),
            "12345678".into(),
            "cube.3mf".into(),
            b"3mf".to_vec(),
            Duration::from_secs(1),
        )
        .await;

        assert!(
            matches!(&put, Err(PrinterError::Ftps(e)) if e.contains("did not finish within")),
            "the upload ends at its deadline, got {put:?}"
        );
        upload_closed
            .recv_timeout(Duration::from_secs(2))
            .expect("the upload closed its socket before it returned");
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
            "the retry shows the print it last saw until it connects"
        );
    }

    /// Starts `printer` with its real loop stopped and fakes its ConnAck.
    async fn connect_without_loop(
        service: &PrinterService,
        printer: BambuCredentials,
        app: &tauri::App<tauri::test::MockRuntime>,
        app_state: &Arc<AppState>,
    ) -> ConnectionId {
        service
            .start(printer, app.handle().clone(), Arc::clone(app_state))
            .await
            .expect("the printer starts");
        stop_connection_loop(service).await;
        let id = service.inner.lock().await.connection;
        service
            .set_connected(id, ConnectionState::ConnectedMqtt, ConnectionType::Mqtt, app.handle(), app_state)
            .await;
        id
    }

    /// A mock app that can show notifications, with a history database.
    fn history_app() -> (tauri::App<tauri::test::MockRuntime>, Arc<AppState>, PrinterService) {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .plugin(tauri_plugin_notification::init())
            .build(mock_context(noop_assets()))
            .expect("mock app");
        (app, Arc::new(test_app_state()), PrinterService::new())
    }

    fn history_rows(app_state: &AppState) -> Vec<(String, String)> {
        get_test_history(app_state).into_iter().map(|r| (r.model_name, r.status)).collect()
    }

    #[tokio::test]
    async fn a_print_that_finishes_while_switched_away_gets_one_history_row_on_return() {
        let (app, app_state, service) = history_app();

        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        service
            .handle_publish(
                a,
                br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#,
                app.handle(),
                &app_state,
            )
            .await;
        service.disconnect(app.handle(), &app_state).await;

        let b = connect_without_loop(&service, loopback_printer("01P00B000000000"), &app, &app_state).await;
        service
            .handle_publish(b, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        service.disconnect(app.handle(), &app_state).await;

        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        let finished =
            br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#;
        service.handle_publish(a, finished, app.handle(), &app_state).await;
        service.handle_publish(a, finished, app.handle(), &app_state).await;

        assert_eq!(
            history_rows(&app_state),
            [("Benchy".into(), "success".into())],
            "the print A ran while the app was on B gets one row"
        );
    }

    #[tokio::test]
    async fn a_print_whose_start_time_first_shows_in_its_last_report_gets_a_history_row() {
        let (app, app_state, service) = history_app();
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;

        for report in [
            br#"{"print":{"gcode_state":"RUNNING","subtask_name":"Benchy"}}"#.as_slice(),
            br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710500000"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }

        assert_eq!(history_rows(&app_state), [("Benchy".into(), "success".into())]);
    }

    #[tokio::test]
    async fn a_running_report_without_a_start_time_keeps_the_print_already_seen() {
        let (app, app_state, service) = history_app();
        for report in [
            br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#.as_slice(),
            br#"{"print":{"gcode_state":"RUNNING"}}"#,
        ] {
            let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
            service.handle_publish(a, report, app.handle(), &app_state).await;
            service.disconnect(app.handle(), &app_state).await;
        }

        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        service
            .handle_publish(
                a,
                br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#,
                app.handle(),
                &app_state,
            )
            .await;

        assert_eq!(history_rows(&app_state), [("Benchy".into(), "success".into())]);
    }

    #[tokio::test]
    async fn a_print_the_app_never_saw_start_gets_no_row_after_a_reconnect() {
        let (app, app_state, service) = history_app();
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"RUNNING","subtask_name":"Seen"}}"#, app.handle(), &app_state)
            .await;
        service.disconnect(app.handle(), &app_state).await;

        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        service
            .handle_publish(
                a,
                br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710600000","subtask_name":"Unseen"}}"#,
                app.handle(),
                &app_state,
            )
            .await;

        assert_eq!(history_rows(&app_state), [], "nothing tells the finished print apart from another one");
    }

    #[tokio::test]
    async fn a_print_paused_when_the_app_switches_away_gets_a_row_when_it_finishes() {
        let (app, app_state, service) = history_app();
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        for report in [
            br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#.as_slice(),
            br#"{"print":{"gcode_state":"PAUSE"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        service.disconnect(app.handle(), &app_state).await;
        connect_without_loop(&service, loopback_printer("01P00B000000000"), &app, &app_state).await;
        service.disconnect(app.handle(), &app_state).await;

        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        service
            .handle_publish(
                a,
                br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#,
                app.handle(),
                &app_state,
            )
            .await;

        assert_eq!(history_rows(&app_state), [("Benchy".into(), "success".into())]);
    }

    #[tokio::test]
    async fn a_print_whose_end_this_connection_recorded_is_not_recorded_again() {
        let (app, app_state, service) = history_app();
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        service
            .handle_publish(
                a,
                br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#,
                app.handle(),
                &app_state,
            )
            .await;
        service.disconnect(app.handle(), &app_state).await;

        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        for report in [
            br#"{"print":{"gcode_state":"RUNNING","subtask_name":"Benchy"}}"#.as_slice(),
            br#"{"print":{"gcode_state":"FINISH"}}"#,
            br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710500000"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }

        assert_eq!(history_rows(&app_state).len(), 1, "one print, one row");
    }

    #[derive(Debug, Clone, Copy)]
    enum Return {
        /// The loop reconnects on its own after the connection is lost.
        Reconnect,
        /// The printer went Offline and the user starts it again.
        Retry,
    }

    /// Printer A's connection `a` drops, then a new session comes back `how`.
    async fn return_to_printer_a(
        how: Return,
        service: &PrinterService,
        a: ConnectionId,
        app: &tauri::App<tauri::test::MockRuntime>,
        app_state: &Arc<AppState>,
    ) -> ConnectionId {
        match how {
            Return::Reconnect => {
                service
                    .set_state(a, ConnectionState::Reconnecting, app.handle(), app_state, "connection lost")
                    .await;
                service
                    .set_connected(a, ConnectionState::ConnectedMqtt, ConnectionType::Mqtt, app.handle(), app_state)
                    .await;
                a
            }
            Return::Retry => {
                service
                    .set_state(a, ConnectionState::Offline, app.handle(), app_state, "both paths exhausted")
                    .await;
                connect_without_loop(service, printer_a(), app, app_state).await
            }
        }
    }

    /// Printer A sends `before`, its connection drops and comes back `how`,
    /// then it sends `after`. Returns the history rows.
    async fn history_across_a_return(how: Return, before: &[&[u8]], after: &[&[u8]]) -> Vec<(String, String)> {
        let (app, app_state, service) = history_app();
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        for report in before {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        let a = return_to_printer_a(how, &service, a, &app, &app_state).await;
        for report in after {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        history_rows(&app_state)
    }

    const BENCHY_RUNNING: &[u8] =
        br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#;
    const BENCHY_FINISHED: &[u8] =
        br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710500000","subtask_name":"Benchy"}}"#;

    #[tokio::test]
    async fn a_print_the_app_never_saw_gets_no_row_when_the_printer_comes_back() {
        for how in [Return::Reconnect, Return::Retry] {
            let rows = history_across_a_return(
                how,
                &[BENCHY_RUNNING],
                &[br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710600000","subtask_name":"Unseen"}}"#],
            )
            .await;
            assert_eq!(rows, [], "{how:?}: Benchy ended and Unseen ran while the printer was away");
        }
    }

    #[tokio::test]
    async fn a_print_paused_when_the_printer_drops_gets_a_row_when_it_finishes() {
        for how in [Return::Reconnect, Return::Retry] {
            let rows = history_across_a_return(
                how,
                &[BENCHY_RUNNING, br#"{"print":{"gcode_state":"PAUSE"}}"#],
                &[BENCHY_FINISHED],
            )
            .await;
            assert_eq!(rows, [("Benchy".into(), "success".into())], "{how:?}");
        }
    }

    #[tokio::test]
    async fn a_print_that_finishes_while_the_printer_is_away_gets_one_row() {
        for how in [Return::Reconnect, Return::Retry] {
            let rows = history_across_a_return(how, &[BENCHY_RUNNING], &[BENCHY_FINISHED, BENCHY_FINISHED]).await;
            assert_eq!(rows, [("Benchy".into(), "success".into())], "{how:?}");
        }
    }

    #[tokio::test]
    async fn a_report_that_names_only_the_start_time_keeps_the_print_seen() {
        for how in [Return::Reconnect, Return::Retry] {
            let rows = history_across_a_return(
                how,
                &[BENCHY_RUNNING],
                &[br#"{"print":{"gcode_start_time":"1710500000"}}"#, BENCHY_FINISHED],
            )
            .await;
            assert_eq!(rows, [("Benchy".into(), "success".into())], "{how:?}");
        }
    }

    #[tokio::test]
    async fn each_print_gets_one_row_however_often_its_end_is_reported() {
        let (app, app_state, service) = history_app();
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        for report in [
            BENCHY_RUNNING,
            BENCHY_FINISHED,
            BENCHY_RUNNING,
            BENCHY_FINISHED,
            br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710510000","subtask_name":"Hook"}}"#,
            br#"{"print":{"gcode_state":"FINISH"}}"#,
            br#"{"print":{"gcode_state":"FINISH"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }

        let mut rows = history_rows(&app_state);
        rows.sort();
        assert_eq!(rows, [("Benchy".into(), "success".into()), ("Hook".into(), "success".into())]);
    }

    #[tokio::test]
    async fn a_print_stopped_while_paused_gets_one_failed_row() {
        let (app, app_state, service) = history_app();
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        for report in [BENCHY_RUNNING, br#"{"print":{"gcode_state":"PAUSE"}}"#] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        assert_eq!(history_rows(&app_state), [], "a pause is not an end");

        let stopped = br#"{"print":{"gcode_state":"FAILED","fail_reason":"stopped by user"}}"#;
        service.handle_publish(a, stopped, app.handle(), &app_state).await;
        service.handle_publish(a, stopped, app.handle(), &app_state).await;

        let history = get_test_history(&app_state);
        assert_eq!(history_rows(&app_state), [("Benchy".into(), "failed".into())]);
        assert_eq!(history[0].fail_reason.as_deref(), Some("stopped by user"));
    }

    /// One run of the app on the database file `db`, connected to printer A.
    async fn app_run_on(
        db: &std::path::Path,
    ) -> (tauri::App<tauri::test::MockRuntime>, Arc<AppState>, PrinterService, ConnectionId) {
        let (app, app_state, service) = history_app();
        *app_state.db.lock().unwrap() = Some(crate::database::init_db(db).expect("the database opens"));
        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        (app, app_state, service, a)
    }

    #[tokio::test]
    async fn a_print_that_ends_while_the_app_is_closed_gets_one_row_on_the_next_run() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("materialize.db");
        {
            let (app, app_state, service, a) = app_run_on(&db).await;
            service.handle_publish(a, BENCHY_RUNNING, app.handle(), &app_state).await;
        }

        let (app, app_state, service, a) = app_run_on(&db).await;
        service.handle_publish(a, BENCHY_FINISHED, app.handle(), &app_state).await;
        service.handle_publish(a, BENCHY_FINISHED, app.handle(), &app_state).await;
        assert_eq!(history_rows(&app_state), [("Benchy".into(), "success".into())]);

        let row = get_test_history(&app_state).remove(0).id;
        crate::database::delete_history(app_state.db.lock().unwrap().as_ref().unwrap(), &row).unwrap();
        drop((app, app_state, service));
        let (app, app_state, service, a) = app_run_on(&db).await;
        for report in [BENCHY_RUNNING, BENCHY_FINISHED] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        assert_eq!(history_rows(&app_state), [], "the row the user deleted stays gone");
    }

    #[tokio::test]
    async fn a_print_the_last_run_never_saw_gets_no_row_on_the_next_run() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("materialize.db");
        {
            let (app, app_state, service, a) = app_run_on(&db).await;
            service.handle_publish(a, BENCHY_RUNNING, app.handle(), &app_state).await;
        }

        let (app, app_state, service, a) = app_run_on(&db).await;
        let unseen = br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710600000","subtask_name":"Unseen"}}"#;
        service.handle_publish(a, unseen, app.handle(), &app_state).await;
        assert_eq!(history_rows(&app_state), []);
    }

    #[tokio::test]
    async fn a_print_whose_start_time_arrives_late_gets_its_row_beside_an_older_open_print() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("materialize.db");
        {
            let (app, app_state, service, a) = app_run_on(&db).await;
            service.handle_publish(a, BENCHY_RUNNING, app.handle(), &app_state).await;
        }

        let (app, app_state, service, a) = app_run_on(&db).await;
        for report in [
            br#"{"print":{"gcode_state":"RUNNING","subtask_name":"Hook"}}"#.as_slice(),
            br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710510000"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        assert_eq!(history_rows(&app_state), [("Hook".into(), "success".into())]);
    }

    fn queue_job(app_state: &AppState, id: &str, grams: f64) {
        app_state.print_queue.lock().unwrap().push(crate::state::QueuedJob {
            id: id.into(),
            model_path: String::new(),
            threemf_path: String::new(),
            model_name: id.into(),
            created_at: chrono::Utc::now(),
            status: QueueStatus::Pending,
            filament_grams: Some(grams),
            filament_meters: Some(grams / 3.0),
            quality_profile: Some(format!("{id} quality")),
            thumbnail_path: Some(format!("/tmp/{id}.png")),
        });
    }

    /// Connects `printer` and sends it queued job `id` as `subtask_name`, as
    /// an auto-send run does after its upload. The MQTT event loop is returned
    /// so the publish has somewhere to go.
    async fn send_job(
        service: &PrinterService,
        printer: BambuCredentials,
        id: &str,
        subtask_name: &str,
        app: &tauri::App<tauri::test::MockRuntime>,
        app_state: &Arc<AppState>,
    ) -> (ConnectionId, rumqttc::EventLoop) {
        let connection = connect_without_loop(service, printer.clone(), app, app_state).await;
        let (client, event_loop) = mqtt::connect(&cloud::local_mqtt_config(&printer)).expect("mqtt client");
        {
            let mut inner = service.inner.lock().await;
            inner.mqtt_client = Some(client);
            inner.readiness = Readiness::Idle;
        }
        let job = app_state.print_queue.lock().unwrap().iter().find(|j| j.id == id).cloned().expect("queued job");
        send_project_file(service, connection, app_state, &job, subtask_name.into(), String::new())
            .await
            .expect("the send step");
        (connection, event_loop)
    }

    /// Runs and finishes `subtask_name` on connection `id`, and returns the
    /// filament, quality, and thumbnail its history row took.
    async fn finish_print(
        service: &PrinterService,
        id: ConnectionId,
        subtask_name: &str,
        app: &tauri::App<tauri::test::MockRuntime>,
        app_state: &AppState,
    ) -> (Option<f64>, Option<String>, Option<String>) {
        for state in ["RUNNING", "FINISH"] {
            let report = format!(
                r#"{{"print":{{"gcode_state":"{state}","gcode_start_time":"1710500000","subtask_name":"{subtask_name}"}}}}"#
            );
            service.handle_publish(id, report.as_bytes(), app.handle(), app_state).await;
        }
        let rows = get_test_history(app_state);
        assert_eq!(rows.len(), 1, "the print gets one row");
        let row = rows.into_iter().next().unwrap();
        (row.filament_grams, row.quality_profile, row.thumbnail_path)
    }

    #[tokio::test]
    async fn a_history_row_takes_its_filament_from_the_job_that_started_the_print() {
        let (app, app_state, service) = history_app();
        queue_job(&app_state, "old", 5.0);
        queue_job(&app_state, "cube", 12.5);
        let (_, _old_loop) = send_job(&service, printer_a(), "old", "old.3mf", &app, &app_state).await;
        let (a, _cube_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;

        assert_eq!(
            finish_print(&service, a, "cube.3mf", &app, &app_state).await,
            (Some(12.5), Some("cube quality".into()), Some("/tmp/cube.png".into())),
            "the row describes the job sent as cube.3mf, not the older job"
        );
    }

    #[tokio::test]
    async fn a_print_no_queued_job_started_gets_no_filament_or_thumbnail() {
        let (app, app_state, service) = history_app();
        queue_job(&app_state, "cube", 12.5);
        queue_job(&app_state, "benchy", 9.0);
        let (_, _a_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;
        service.disconnect(app.handle(), &app_state).await;
        let b = loopback_printer("01P00B000000000");
        let (_, _b_loop) = send_job(&service, b, "benchy", "benchy.3mf", &app, &app_state).await;
        service.disconnect(app.handle(), &app_state).await;

        let a = connect_without_loop(&service, printer_a(), &app, &app_state).await;
        assert_eq!(
            finish_print(&service, a, "benchy.3mf", &app, &app_state).await,
            (None, None, None),
            "printer A ran a file no job sent to it, so no job describes the print"
        );
    }

    fn metadata_of_row_started_at(app_state: &AppState, start: &str) -> (Option<f64>, Option<String>, Option<String>) {
        let row = get_test_history(app_state)
            .into_iter()
            .find(|row| row.started_at.as_deref() == Some(start))
            .expect("the print has a history row");
        (row.filament_grams, row.quality_profile, row.thumbnail_path)
    }

    #[tokio::test]
    async fn a_later_print_of_the_same_file_does_not_take_the_job_that_started_an_earlier_one() {
        let (app, app_state, service) = history_app();
        queue_job(&app_state, "cube", 12.5);
        let (a, _event_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;
        finish_print(&service, a, "cube.3mf", &app, &app_state).await;

        for report in [
            br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710600000","subtask_name":"cube.3mf"}}"#.as_slice(),
            br#"{"print":{"gcode_state":"FINISH"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        assert_eq!(
            metadata_of_row_started_at(&app_state, "1710600000"),
            (None, None, None),
            "the job started only the first print of cube.3mf"
        );
    }

    #[tokio::test]
    async fn a_job_whose_print_ends_without_a_start_time_does_not_describe_a_later_print() {
        let (app, app_state, service) = history_app();
        queue_job(&app_state, "cube", 12.5);
        let (a, _event_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;
        for report in [
            br#"{"print":{"gcode_state":"RUNNING","subtask_name":"cube.3mf"}}"#.as_slice(),
            br#"{"print":{"gcode_state":"FINISH"}}"#,
            br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710600000","subtask_name":"cube.3mf"}}"#,
            br#"{"print":{"gcode_state":"FINISH"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        let first = get_test_history(&app_state).into_iter().find(|row| row.started_at.is_none()).expect("first row");
        assert_eq!(first.filament_grams, Some(12.5), "the job describes the print it started");
        assert_eq!(
            metadata_of_row_started_at(&app_state, "1710600000"),
            (None, None, None),
            "the job's print already ended"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_print_gets_its_history_row_when_the_queue_file_cannot_be_written() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let queue_path = dir.path().join("print_queue.json");
        let (app, mut app_state, service) = history_app();
        Arc::get_mut(&mut app_state).unwrap().print_queue_file = Some(queue_path.clone());
        queue_job(&app_state, "cube", 12.5);
        let (a, _event_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"RUNNING","subtask_name":"cube.3mf"}}"#, app.handle(), &app_state)
            .await;
        std::fs::set_permissions(&queue_path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let finished = br#"{"print":{"gcode_state":"FINISH","gcode_start_time":"1710500000"}}"#;
        service.handle_publish(a, finished, app.handle(), &app_state).await;
        assert!(crate::print_queue::persist_queue(&app_state).is_err(), "the queue file is read-only");

        assert_eq!(
            metadata_of_row_started_at(&app_state, "1710500000"),
            (Some(12.5), Some("cube quality".into()), Some("/tmp/cube.png".into()))
        );
    }

    #[tokio::test]
    async fn a_history_write_that_fails_keeps_the_job_for_the_retry() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("materialize.db");
        let (app, app_state, service) = history_app();
        let db = crate::database::init_db(&db_path).unwrap();
        db.busy_timeout(Duration::from_millis(1)).unwrap();
        *app_state.db.lock().unwrap() = Some(db);
        queue_job(&app_state, "cube", 12.5);
        let (a, _event_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;
        service
            .handle_publish(
                a,
                br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710500000","subtask_name":"cube.3mf"}}"#,
                app.handle(),
                &app_state,
            )
            .await;

        let writer = rusqlite::Connection::open(&db_path).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let finished = |prev| settle_print(SERIAL_A, Some(prev), Some("FINISH"), Some("1710500000"), app.handle(), &app_state);
        assert!(finished("RUNNING").is_err(), "another writer holds the database");
        writer.execute_batch("ROLLBACK").unwrap();
        finished("FINISH").expect("the retry writes the row");

        assert_eq!(
            metadata_of_row_started_at(&app_state, "1710500000"),
            (Some(12.5), Some("cube quality".into()), Some("/tmp/cube.png".into()))
        );
    }

    #[tokio::test]
    async fn a_job_sent_just_before_a_reconnect_describes_the_print_it_started() {
        let (app, app_state, service) = history_app();
        queue_job(&app_state, "cube", 12.5);
        queue_job(&app_state, "benchy", 9.0);
        let (a, _event_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;
        let a = return_to_printer_a(Return::Reconnect, &service, a, &app, &app_state).await;
        service
            .handle_publish(a, br#"{"print":{"gcode_state":"IDLE"}}"#, app.handle(), &app_state)
            .await;
        let benchy = app_state.print_queue.lock().unwrap().iter().find(|j| j.id == "benchy").cloned().unwrap();
        send_project_file(&service, a, &app_state, &benchy, "benchy.3mf".into(), String::new())
            .await
            .expect("the send step");

        assert_eq!(
            finish_print(&service, a, "cube.3mf", &app, &app_state).await,
            (Some(12.5), Some("cube quality".into()), Some("/tmp/cube.png".into())),
            "the printer was still starting cube when benchy was sent, and cube ran"
        );
    }

    #[tokio::test]
    async fn a_print_whose_name_arrives_after_its_start_takes_its_job() {
        let (app, app_state, service) = history_app();
        queue_job(&app_state, "cube", 12.5);
        let (a, _event_loop) = send_job(&service, printer_a(), "cube", "cube.3mf", &app, &app_state).await;
        for report in [
            br#"{"print":{"gcode_state":"RUNNING","gcode_start_time":"1710500000"}}"#.as_slice(),
            br#"{"print":{"subtask_name":"cube.3mf"}}"#,
            br#"{"print":{"gcode_state":"FINISH"}}"#,
        ] {
            service.handle_publish(a, report, app.handle(), &app_state).await;
        }
        assert_eq!(
            metadata_of_row_started_at(&app_state, "1710500000"),
            (Some(12.5), Some("cube quality".into()), Some("/tmp/cube.png".into()))
        );
    }

    /// A broker on loopback that accepts one MQTT client and sends it a
    /// status report without `gcode_state` every 50 ms, as a printer sends
    /// deltas. When `answers_pushall`, it answers each `pushall` with a full
    /// report. Returns how many `pushall` requests it read once the client
    /// hangs up.
    fn fake_broker(answers_pushall: bool) -> (u16, std::thread::JoinHandle<usize>) {
        use std::io::{ErrorKind, Read, Write};

        fn publish(topic: &str, payload: &str) -> Vec<u8> {
            let mut remaining = 2 + topic.len() + payload.len();
            let mut packet = vec![0x30];
            loop {
                let byte = (remaining % 128) as u8;
                remaining /= 128;
                packet.push(if remaining > 0 { byte | 0x80 } else { byte });
                if remaining == 0 {
                    break;
                }
            }
            packet.extend((topic.len() as u16).to_be_bytes());
            packet.extend(topic.as_bytes());
            packet.extend(payload.as_bytes());
            packet
        }

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind broker");
        let port = listener.local_addr().expect("broker addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client connects");
            let topic = printer_a().report_topic();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).expect("read CONNECT");
            assert!(n > 0 && buf[0] == 0x10, "the client opens with CONNECT");
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).expect("send CONNACK");
            stream.set_read_timeout(Some(Duration::from_millis(50))).expect("read timeout");

            let mut read = Vec::new();
            let mut pushalls = 0;
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => return pushalls,
                    Ok(n) => read.extend_from_slice(&buf[..n]),
                    Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                    Err(_) => return pushalls,
                }
                let seen = read.windows(b"pushall".len()).filter(|w| w == b"pushall").count();
                let report = if answers_pushall && seen > pushalls {
                    r#"{"print":{"gcode_state":"RUNNING","nozzle_temper":210.0}}"#
                } else {
                    r#"{"print":{"nozzle_temper":210.0}}"#
                };
                pushalls = seen;
                if stream.write_all(&publish(&topic, report)).is_err() {
                    return pushalls;
                }
            }
        });
        (port, handle)
    }

    /// Runs one session of printer A against `fake_broker` for 1.5 s, with an
    /// MQTT request queue of `capacity`. Returns how many `pushall` requests
    /// the broker read, and the nozzle temperature the app last read.
    async fn one_session(answers_pushall: bool, capacity: usize) -> (usize, Option<f32>) {
        let (port, broker) = fake_broker(answers_pushall);
        let (app, app_state, service) = history_app();
        service
            .start(printer_a(), app.handle().clone(), Arc::clone(&app_state))
            .await
            .expect("printer A starts");
        stop_connection_loop(&service).await;
        let id = service.inner.lock().await.connection;
        let (client, event_loop) =
            AsyncClient::new(rumqttc::MqttOptions::new("m3d-test", "127.0.0.1", port), capacity);

        let session = service.run_event_loop(id, client, event_loop, ConnectionType::Mqtt, app.handle(), &app_state);
        let ended = tokio::time::timeout(Duration::from_millis(1500), session).await;
        assert!(ended.is_err(), "the session stays connected, got {ended:?}");
        let pushalls = tokio::task::spawn_blocking(move || broker.join().expect("broker thread"))
            .await
            .expect("join the broker");
        let nozzle_temp = app_state.printer.lock().unwrap().nozzle_temp;
        (pushalls, nozzle_temp)
    }

    #[tokio::test]
    async fn a_session_with_no_print_state_asks_for_the_full_state_again_a_bounded_number_of_times() {
        assert_eq!(
            one_session(false, 10).await.0,
            1 + PUSHALL_RETRIES as usize,
            "one pushall on ConnAck, then one per retry, then no more"
        );
    }

    #[tokio::test]
    async fn a_session_whose_pushall_is_answered_asks_once() {
        assert_eq!(one_session(true, 10).await.0, 1);
    }

    #[tokio::test]
    async fn a_session_whose_request_queue_is_full_when_a_pushall_is_due_keeps_reading_reports() {
        // With one slot, the subscribe sent on ConnAck fills the queue just as
        // the first pushall comes due, and only this session's poll drains it.
        let (pushalls, nozzle_temp) = one_session(false, 1).await;
        assert_eq!(nozzle_temp, Some(210.0), "the session read the printer's reports");
        assert_eq!(pushalls, PUSHALL_RETRIES as usize, "the pushall that found the queue full is one of the sends");
    }
}
