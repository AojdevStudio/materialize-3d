----------------------------- MODULE AutoSend -----------------------------
(***************************************************************************)
(* The print queue's auto-send: src-tauri/src/printer/mod.rs               *)
(* auto_send_pending_job. Two triggers spawn it as its own tokio task:     *)
(* the IDLE gcode_state transition in the status handler, and the connect  *)
(* handler 2 s after it connects. Nothing stops two runs overlapping.      *)
(*                                                                         *)
(* Each action is one indivisible step of one run:                         *)
(*   CheckIdle  lock the service for the run's connection, read           *)
(*              gcode_state == "IDLE" and the credentials. A run whose     *)
(*              connection ended reads as not IDLE.                        *)
(*   Pick       lock AppState.print_queue, clone the first Pending job     *)
(*   Upload     read the 3MF, upload_to_printer (FTPS)                     *)
(*   Send       service.send_command_for(id, ProjectFile)                  *)
(*   Mark       update_job_status(Submitted)                               *)
(* A failed upload or send marks the job Failed and ends the run. A 3MF   *)
(* that cannot be read, or missing credentials, ends the run with the job  *)
(* still Pending.                                                          *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Runs, Jobs   \* overlapping auto-send runs, and queued job ids (1..n)

VARIABLES
  printer,  \* gcode_state the app holds: "IDLE" or "RUNNING"
  status,   \* job -> "Pending", "Submitted", or "Failed"
  sent,     \* job -> project_file commands sent for it
  pc,       \* run -> where it is
  job       \* run -> the job it cloned, or 0

vars == <<printer, status, sent, pc, job>>

Init ==
  /\ printer = "IDLE"
  /\ status = [j \in Jobs |-> "Pending"]
  /\ sent = [j \in Jobs |-> 0]
  /\ pc = [r \in Runs |-> "check"]
  /\ job = [r \in Runs |-> 0]

Pending == {j \in Jobs : status[j] = "Pending"}
First(s) == CHOOSE j \in s : \A k \in s : j <= k

CheckIdle(r) ==
  /\ pc[r] = "check"
  /\ pc' = [pc EXCEPT ![r] = IF printer = "IDLE" THEN "pick" ELSE "done"]
  /\ UNCHANGED <<printer, status, sent, job>>

Pick(r) ==
  /\ pc[r] = "pick"
  /\ IF Pending = {}
       THEN pc' = [pc EXCEPT ![r] = "done"] /\ UNCHANGED job
       ELSE /\ job' = [job EXCEPT ![r] = First(Pending)]
            /\ pc' = [pc EXCEPT ![r] = "upload"]
  /\ UNCHANGED <<printer, status, sent>>

Fail(r) ==
  /\ status' = [status EXCEPT ![job[r]] = "Failed"]
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<printer, sent, job>>

UploadOk(r) ==
  /\ pc[r] = "upload" /\ pc' = [pc EXCEPT ![r] = "send"]
  /\ UNCHANGED <<printer, status, sent, job>>

UploadFails(r) == pc[r] = "upload" /\ Fail(r)

UploadAborts(r) ==
  /\ pc[r] = "upload" /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<printer, status, sent, job>>

SendOk(r) ==
  /\ pc[r] = "send"
  /\ sent' = [sent EXCEPT ![job[r]] = @ + 1]
  /\ pc' = [pc EXCEPT ![r] = "mark"]
  /\ UNCHANGED <<printer, status, job>>

SendFails(r) == pc[r] = "send" /\ Fail(r)

Mark(r) ==
  /\ pc[r] = "mark"
  /\ status' = [status EXCEPT ![job[r]] = "Submitted"]
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<printer, sent, job>>

\* A later status report shows the printer took a job.
PrinterStarts ==
  /\ printer = "IDLE" /\ \E j \in Jobs : sent[j] > 0
  /\ printer' = "RUNNING"
  /\ UNCHANGED <<status, sent, pc, job>>

Next ==
  \/ \E r \in Runs :
       CheckIdle(r) \/ Pick(r) \/ UploadOk(r) \/ UploadFails(r) \/ UploadAborts(r)
       \/ SendOk(r) \/ SendFails(r) \/ Mark(r)
  \/ PrinterStarts

Spec == Init /\ [][Next]_vars

\* The app sends each queued job to the printer at most once.
SentAtMostOnce == \A j \in Jobs : sent[j] <= 1
=============================================================================
