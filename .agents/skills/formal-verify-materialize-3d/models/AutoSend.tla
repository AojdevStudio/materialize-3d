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
(*   Send     lock_for(id). Unless the readiness is still Idle and the job *)
(*            is still Pending in the queue, leave the job as it is.       *)
(*            Otherwise mark it Submitted under the print queue lock,      *)
(*            then publish ProjectFile, readiness Idle -> JobSent, all     *)
(*            under the service lock. A Remove after the mark removes a    *)
(*            job already sent.                                            *)
(*   Release  lock the service and free the queue, whether or not the     *)
(*            run's connection ended                                       *)
(* A failed read or upload marks the job Failed through fail_job, which    *)
(* writes nothing once the run's connection ended. A failed publish marks  *)
(* it Failed under the same lock.                                          *)
(* update_job_status writes nothing for a job the user removed.            *)
(*                                                                         *)
(* The connection: Switch is disconnect then start, end_connection moves   *)
(* the id and leaves the queue held. Drop and Connect are a reconnect      *)
(* inside one connection, set_state(Reconnecting) and set_connected.       *)
(* Report is a status report that states gcode_state. Remove is the user's *)
(* remove_from_queue, which takes no service lock.                         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Runs, Jobs, Mutant   \* Mutant: "none", "unguarded", "released-on-switch", or "no-recheck"

Conns == 0..1

VARIABLES
  conn,       \* the current ConnectionId
  live,       \* connection_state is ConnectedMqtt or ConnectedCloud
  readiness,  \* "WaitingForIdle", "Idle", or "JobSent"
  held,       \* queue_held
  status,     \* job -> "Pending", "Submitted", "Failed", or "Removed"
  sent,       \* job -> connection -> project_file commands sent for it
  pc,         \* run -> where it is
  rconn,      \* run -> the connection it was spawned for
  job,        \* run -> the job it cloned, or 0
  unwanted    \* a project_file went to a busy printer or for a job not Pending

vars == <<conn, live, readiness, held, status, sent, pc, rconn, job, unwanted>>

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
  /\ unwanted = FALSE

Pending == {j \in Jobs : status[j] = "Pending"}
First(s) == CHOOSE j \in s : \A k \in s : j <= k
Current(r) == rconn[r] = conn
Wanted(r) == readiness = "Idle" /\ status[job[r]] = "Pending"
SetStatus(j, s) == IF status[j] = "Removed" THEN status ELSE [status EXCEPT ![j] = s]

Spawn(r) ==
  /\ pc[r] = "idle"
  /\ pc' = [pc EXCEPT ![r] = "claim"]
  /\ rconn' = [rconn EXCEPT ![r] = conn]
  /\ UNCHANGED <<conn, live, readiness, held, status, sent, job, unwanted>>

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
  /\ UNCHANGED <<conn, live, readiness, status, sent, rconn, unwanted>>

Fail(r) ==
  /\ status' = IF Current(r) THEN SetStatus(job[r], "Failed") ELSE status
  /\ pc' = [pc EXCEPT ![r] = "release"]
  /\ UNCHANGED <<conn, live, readiness, held, sent, rconn, job, unwanted>>

UploadOk(r) ==
  /\ pc[r] = "upload" /\ pc' = [pc EXCEPT ![r] = "send"]
  /\ UNCHANGED <<conn, live, readiness, held, status, sent, rconn, job, unwanted>>

UploadFails(r) == pc[r] = "upload" /\ Fail(r)

SendOk(r) ==
  /\ pc[r] = "send" /\ Current(r) /\ (Mutant = "no-recheck" \/ Wanted(r))
  /\ sent' = [sent EXCEPT ![job[r]][conn] = @ + 1]
  /\ unwanted' = (unwanted \/ ~Wanted(r))
  /\ status' = SetStatus(job[r], "Submitted")
  /\ readiness' = IF readiness = "Idle" THEN "JobSent" ELSE readiness
  /\ pc' = [pc EXCEPT ![r] = "release"]
  /\ UNCHANGED <<conn, live, held, rconn, job>>

\* lock_for(id) finds the connection ended, or the recheck finds the job
\* unwanted. The job stays as it is.
SendSkips(r) ==
  /\ pc[r] = "send" /\ ~(Current(r) /\ Wanted(r))
  /\ pc' = [pc EXCEPT ![r] = "release"]
  /\ UNCHANGED <<conn, live, readiness, held, status, sent, rconn, job, unwanted>>

\* A publish error.
SendFails(r) == pc[r] = "send" /\ Current(r) /\ Wanted(r) /\ Fail(r)

Release(r) ==
  /\ pc[r] = "release"
  /\ held' = FALSE
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<conn, live, readiness, status, sent, rconn, job, unwanted>>

Remove(j) ==
  /\ status[j] # "Removed"
  /\ status' = [status EXCEPT ![j] = "Removed"]
  /\ UNCHANGED <<conn, live, readiness, held, sent, pc, rconn, job, unwanted>>

Report(idle) ==
  /\ live
  /\ readiness' = IF idle
                    THEN IF readiness = "WaitingForIdle" THEN "Idle" ELSE readiness
                    ELSE "WaitingForIdle"
  /\ UNCHANGED <<conn, live, held, status, sent, pc, rconn, job, unwanted>>

Drop ==
  /\ live /\ live' = FALSE
  /\ UNCHANGED <<conn, readiness, held, status, sent, pc, rconn, job, unwanted>>

Connect ==
  /\ ~live /\ live' = TRUE /\ readiness' = "WaitingForIdle"
  /\ UNCHANGED <<conn, held, status, sent, pc, rconn, job, unwanted>>

Switch ==
  /\ conn + 1 \in Conns
  /\ conn' = conn + 1 /\ live' = FALSE
  /\ held' = (held /\ Mutant # "released-on-switch")
  /\ UNCHANGED <<readiness, status, sent, pc, rconn, job, unwanted>>

Next ==
  \/ \E r \in Runs :
       Spawn(r) \/ Claim(r) \/ UploadOk(r) \/ UploadFails(r)
       \/ SendOk(r) \/ SendSkips(r) \/ SendFails(r) \/ Release(r)
  \/ \E j \in Jobs : Remove(j)
  \/ \E idle \in BOOLEAN : Report(idle)
  \/ Drop \/ Connect \/ Switch

Spec == Init /\ [][Next]_vars

\* The app sends each queued job to the printer at most once.
SentAtMostOnce == \A j \in Jobs : sent[j][0] + sent[j][1] <= 1

\* A project_file goes out only to a printer that still reports IDLE, and
\* only for a job still Pending in the queue.
SentOnlyWhenWanted == ~unwanted

Holding == {"upload", "send", "release"}

\* At most one run works on the queue, across reconnects and switches.
OneRunAtATime == \A r1, r2 \in Runs : (pc[r1] \in Holding /\ pc[r2] \in Holding) => r1 = r2
=============================================================================
