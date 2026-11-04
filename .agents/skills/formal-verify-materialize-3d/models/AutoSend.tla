----------------------------- MODULE AutoSend -----------------------------
(***************************************************************************)
(* The print queue's auto-send: src-tauri/src/printer/mod.rs               *)
(* auto_send_pending_job and submit_job. The status handler spawns a run   *)
(* when a report shows the printer became IDLE, and add_to_queue spawns    *)
(* one for each job it adds. The model lets a run spawn at any time, for   *)
(* the connection that is current then.                                    *)
(*                                                                         *)
(* Each action is one indivisible step of one run:                         *)
(*   Claim    lock the service for the run's connection. The connection is *)
(*            live, its readiness is Idle, and queue_held is false. Lock   *)
(*            the print queue, clone the first Pending job, and hold the   *)
(*            queue. Otherwise the run ends. A run refused because the     *)
(*            queue is held asks the holder for a fresh run, which the     *)
(*            model covers by letting any run spawn at any time.           *)
(*   Upload   read the 3MF, upload_to_printer (FTPS)                       *)
(*   Send     lock_for(id), publish ProjectFile, readiness Idle -> JobSent *)
(*   Mark     update_job_status(Submitted)                                 *)
(*   Release  lock the service and free the queue, whether or not the     *)
(*            run's connection ended                                       *)
(* A failed upload or send marks the job Failed through fail_job, which    *)
(* writes nothing once the run's connection ended. A 3MF that cannot be    *)
(* read ends the run with the job still Pending.                           *)
(*                                                                         *)
(* The connection: Switch is disconnect then start, end_connection moves   *)
(* the id and leaves the queue held. Drop and Connect are a reconnect      *)
(* inside one connection, set_state(Reconnecting) and set_connected.       *)
(* Report is a status report that states gcode_state.                      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Runs, Jobs, Mutant   \* Mutant: "none", "unguarded", or "released-on-switch"

Conns == 0..1

VARIABLES
  conn,       \* the current ConnectionId
  live,       \* connection_state is ConnectedMqtt or ConnectedCloud
  readiness,  \* "WaitingForIdle", "Idle", or "JobSent"
  held,       \* queue_held
  status,     \* job -> "Pending", "Submitted", or "Failed"
  sent,       \* job -> connection -> project_file commands sent for it
  pc,         \* run -> where it is
  rconn,      \* run -> the connection it was spawned for
  job         \* run -> the job it cloned, or 0

vars == <<conn, live, readiness, held, status, sent, pc, rconn, job>>

Init ==
  /\ conn = 0
  /\ live = FALSE
  /\ readiness = "WaitingForIdle"
  /\ held = FALSE
  /\ status = [j \in Jobs |-> "Pending"]
  /\ sent = [j \in Jobs |-> [c \in Conns |-> 0]]
  /\ pc = [r \in Runs |-> "idle"]
  /\ rconn = [r \in Runs |-> 0]
  /\ job = [r \in Runs |-> 0]

Pending == {j \in Jobs : status[j] = "Pending"}
First(s) == CHOOSE j \in s : \A k \in s : j <= k
Current(r) == rconn[r] = conn

Spawn(r) ==
  /\ pc[r] = "idle"
  /\ pc' = [pc EXCEPT ![r] = "claim"]
  /\ rconn' = [rconn EXCEPT ![r] = conn]
  /\ UNCHANGED <<conn, live, readiness, held, status, sent, job>>

Claim(r) ==
  /\ pc[r] = "claim"
  /\ IF /\ Current(r) /\ live /\ readiness = "Idle"
        /\ (Mutant = "unguarded" \/ ~held)
        /\ Pending # {}
       THEN /\ held' = TRUE
            /\ job' = [job EXCEPT ![r] = First(Pending)]
            /\ pc' = [pc EXCEPT ![r] = "upload"]
       ELSE /\ pc' = [pc EXCEPT ![r] = "done"]
            /\ UNCHANGED <<held, job>>
  /\ UNCHANGED <<conn, live, readiness, status, sent, rconn>>

Fail(r) ==
  /\ status' = IF Current(r) THEN [status EXCEPT ![job[r]] = "Failed"] ELSE status
  /\ pc' = [pc EXCEPT ![r] = "release"]
  /\ UNCHANGED <<conn, live, readiness, held, sent, rconn, job>>

ReadFails(r) ==
  /\ pc[r] = "upload" /\ pc' = [pc EXCEPT ![r] = "release"]
  /\ UNCHANGED <<conn, live, readiness, held, status, sent, rconn, job>>

UploadOk(r) ==
  /\ pc[r] = "upload" /\ pc' = [pc EXCEPT ![r] = "send"]
  /\ UNCHANGED <<conn, live, readiness, held, status, sent, rconn, job>>

UploadFails(r) == pc[r] = "upload" /\ Fail(r)

SendOk(r) ==
  /\ pc[r] = "send" /\ Current(r)
  /\ sent' = [sent EXCEPT ![job[r]][conn] = @ + 1]
  /\ readiness' = IF readiness = "Idle" THEN "JobSent" ELSE readiness
  /\ pc' = [pc EXCEPT ![r] = "mark"]
  /\ UNCHANGED <<conn, live, held, status, rconn, job>>

\* A publish error, or lock_for(id) finds the connection ended.
SendFails(r) == pc[r] = "send" /\ Fail(r)

Mark(r) ==
  /\ pc[r] = "mark"
  /\ status' = [status EXCEPT ![job[r]] = "Submitted"]
  /\ pc' = [pc EXCEPT ![r] = "release"]
  /\ UNCHANGED <<conn, live, readiness, held, sent, rconn, job>>

Release(r) ==
  /\ pc[r] = "release"
  /\ held' = FALSE
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<conn, live, readiness, status, sent, rconn, job>>

Report(idle) ==
  /\ live
  /\ readiness' = IF idle
                    THEN IF readiness = "WaitingForIdle" THEN "Idle" ELSE readiness
                    ELSE "WaitingForIdle"
  /\ UNCHANGED <<conn, live, held, status, sent, pc, rconn, job>>

Drop ==
  /\ live /\ live' = FALSE
  /\ UNCHANGED <<conn, readiness, held, status, sent, pc, rconn, job>>

Connect ==
  /\ ~live /\ live' = TRUE /\ readiness' = "WaitingForIdle"
  /\ UNCHANGED <<conn, held, status, sent, pc, rconn, job>>

Switch ==
  /\ conn + 1 \in Conns
  /\ conn' = conn + 1 /\ live' = FALSE
  /\ held' = (held /\ Mutant # "released-on-switch")
  /\ UNCHANGED <<readiness, status, sent, pc, rconn, job>>

Next ==
  \/ \E r \in Runs :
       Spawn(r) \/ Claim(r) \/ ReadFails(r) \/ UploadOk(r) \/ UploadFails(r)
       \/ SendOk(r) \/ SendFails(r) \/ Mark(r) \/ Release(r)
  \/ \E idle \in BOOLEAN : Report(idle)
  \/ Drop \/ Connect \/ Switch

Spec == Init /\ [][Next]_vars

\* The app sends each queued job to the printer at most once.
SentAtMostOnce == \A j \in Jobs : sent[j][0] + sent[j][1] <= 1

Holding == {"upload", "send", "mark", "release"}

\* At most one run works on the queue, across reconnects and switches.
OneRunAtATime == \A r1, r2 \in Runs : (pc[r1] \in Holding /\ pc[r2] \in Holding) => r1 = r2
=============================================================================
