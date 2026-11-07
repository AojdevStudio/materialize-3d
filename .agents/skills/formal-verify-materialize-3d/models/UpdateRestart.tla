--------------------------- MODULE UpdateRestart ---------------------------
(***************************************************************************)
(* What "Update now" can cut off when it restarts the app.                 *)
(*                                                                         *)
(* Each action is one indivisible step in the code it names:               *)
(*   src-tauri/src/fabrication/build_gate.rs  BuildGate, Running, Closed   *)
(*   src-tauri/src/updater.rs                 update_install,              *)
(*                                            install_when_idle            *)
(*   src-tauri/src/fabrication/pipeline.rs    build_as takes a pass        *)
(*   src-tauri/src/commands.rs                slice_model takes a pass     *)
(*   src-tauri/src/sidecar.rs                 the sidecar's work takes a   *)
(*   sidecar/src/busy.ts                      pass (set_busy) before a     *)
(*                                            send's first commit, and     *)
(*                                            drops it once no task is     *)
(*                                            live, after its last commit  *)
(*   src-tauri/src/print_queue.rs             persist_queue                *)
(* Tauri's AppHandle::restart from an async command asks the event loop to *)
(* exit, then calls std::process::exit(0), which stops every other thread  *)
(* wherever it is. That is the Exit action.                                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Builds,      \* tasks that each hold at most one build pass at a time
  Slice,       \* the member of Builds that is commands.rs slice_model
  Turn,        \* the member of Builds that is the sidecar's work (busy.ts)
  MaxStarts,   \* starts per build task. 0 means no limit.
  MaxUpdates,  \* how many times update_install can run
  Mutant       \* "none" is the code. The others are broken variants.

Mutants == {"none", "split-close", "late-subscribe", "ungated-slice",
            "guard-dropped", "guard-leaked", "ungated-turn", "early-release"}
ASSUME Mutant \in Mutants /\ Slice \in Builds /\ Turn \in Builds /\ Turn /= Slice /\ MaxStarts \in Nat

VARIABLES
  running,    \* Builds.running in the gate's watch channel
  closed,     \* Builds.closed in the gate's watch channel
  unseen,     \* the updater's watch::Receiver holds a change it has not seen
  build,      \* build task -> "idle", "running", or "writing" (mutant
              \* early-release: the sidecar still committing after its pass
              \* is gone)
  starts,     \* build task -> starts so far, counted only when MaxStarts > 0
  upd,        \* where update_install is
  updates,    \* update_install runs so far
  qlock,      \* persist_queue holds the AppState.print_queue mutex
  queueFile   \* print_queue.json on disk: "whole", or "partial" after
              \* fs::write truncated it and before it finished writing

vars == <<running, closed, unseen, build, starts, upd, updates, qlock, queueFile>>

Waiting == {"top", "check", "close", "mark", "sleep"}
Alive == upd /= "exited"

Init ==
  /\ running = 0
  /\ closed = FALSE
  /\ unseen = FALSE
  /\ build = [b \in Builds |-> "idle"]
  /\ starts = [b \in Builds |-> 0]
  /\ upd = "idle"
  /\ updates = 0
  /\ qlock = FALSE
  /\ queueFile = "whole"

----------------------------------------------------------------------------
(* Builds. build_as and slice_model each call BuildGate::enter first and   *)
(* hold the Running pass until they return. The sidecar asks for a pass    *)
(* (BuildGate::enter_owned in set_busy) before a send commits, and gives   *)
(* it back once no task is live, after its last commit.                    *)

Gated(b) ==
  /\ ~(Mutant = "ungated-slice" /\ b = Slice)
  /\ ~(Mutant = "ungated-turn" /\ b = Turn)

\* Mutant early-release: the sidecar drops its pass before its last commit.
EarlyRelease(b) == Mutant = "early-release" /\ b = Turn

CanStart(b) ==
  /\ Alive
  /\ build[b] = "idle"
  /\ (MaxStarts = 0 \/ starts[b] < MaxStarts)

Started(b) ==
  /\ build' = [build EXCEPT ![b] = "running"]
  /\ starts' = IF MaxStarts = 0 THEN starts ELSE [starts EXCEPT ![b] = @ + 1]

\* BuildGate::enter. One send_if_modified. A refused enter changes nothing.
Enter(b) ==
  /\ CanStart(b) /\ Gated(b) /\ ~closed
  /\ running' = running + 1
  /\ unseen' = TRUE
  /\ Started(b)
  /\ UNCHANGED <<closed, upd, updates, qlock, queueFile>>

\* Mutants ungated-slice and ungated-turn: the task runs without a pass.
StartUngated(b) ==
  /\ CanStart(b) /\ ~Gated(b)
  /\ Started(b)
  /\ UNCHANGED <<running, closed, unseen, upd, updates, qlock, queueFile>>

\* Drop for Running. One send_modify, which always notifies.
Leave(b) ==
  /\ Alive /\ build[b] = "running" /\ ~EarlyRelease(b)
  /\ build' = [build EXCEPT ![b] = "idle"]
  /\ IF Gated(b)
       THEN running' = running - 1 /\ unseen' = TRUE
       ELSE UNCHANGED <<running, unseen>>
  /\ UNCHANGED <<closed, starts, upd, updates, qlock, queueFile>>

\* Mutant early-release: the pass drops while the sidecar still has its last
\* commit to make.
ReleaseEarly(b) ==
  /\ Alive /\ build[b] = "running" /\ EarlyRelease(b)
  /\ build' = [build EXCEPT ![b] = "writing"]
  /\ running' = running - 1 /\ unseen' = TRUE
  /\ UNCHANGED <<closed, starts, upd, updates, qlock, queueFile>>

FinishWrite(b) ==
  /\ Alive /\ build[b] = "writing"
  /\ build' = [build EXCEPT ![b] = "idle"]
  /\ UNCHANGED <<running, closed, unseen, starts, upd, updates, qlock, queueFile>>

----------------------------------------------------------------------------
(* update_install. It holds the PendingUpdate lock for the whole run, so   *)
(* only one runs at a time.                                                *)

Click ==
  /\ upd = "idle" /\ updates < MaxUpdates
  /\ upd' = "download" /\ updates' = updates + 1
  /\ UNCHANGED <<running, closed, unseen, build, starts, qlock, queueFile>>

DownloadFails ==
  /\ upd = "download" /\ upd' = "idle"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates, qlock, queueFile>>

\* The download verified. close_when_idle subscribes, which marks the
\* channel's current version as seen.
Downloaded ==
  /\ upd = "download" /\ upd' = "top" /\ unseen' = FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates, qlock, queueFile>>

\* Loop top: changes.borrow_and_update(). Mutant late-subscribe moves it
\* after the idle check (MarkSeen).
Top ==
  /\ upd = "top" /\ upd' = "check"
  /\ unseen' = IF Mutant = "late-subscribe" THEN unseen ELSE FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates, qlock, queueFile>>

Busy == running > 0 \/ closed

\* The idle check and the close in one send_if_modified.
CheckAndClose ==
  /\ upd = "check" /\ ~Busy /\ Mutant /= "split-close"
  /\ closed' = TRUE /\ unseen' = TRUE /\ upd' = "backup"
  /\ UNCHANGED <<running, build, starts, updates, qlock, queueFile>>

\* Mutant split-close: read running, then close in a second send.
CheckOnly ==
  /\ upd = "check" /\ ~Busy /\ Mutant = "split-close"
  /\ upd' = "close"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates, qlock, queueFile>>

CloseLate ==
  /\ upd = "close"
  /\ closed' = TRUE /\ unseen' = TRUE /\ upd' = "backup"
  /\ UNCHANGED <<running, build, starts, updates, qlock, queueFile>>

\* send_if_modified returned false: no change, no notification.
CheckBusy ==
  /\ upd = "check" /\ Busy
  /\ upd' = IF Mutant = "late-subscribe" THEN "mark" ELSE "sleep"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates, qlock, queueFile>>

MarkSeen ==
  /\ upd = "mark" /\ upd' = "sleep" /\ unseen' = FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates, qlock, queueFile>>

\* changes.changed().await returns once the channel holds an unseen change.
Wake ==
  /\ upd = "sleep" /\ unseen
  /\ upd' = "top" /\ unseen' = FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates, qlock, queueFile>>

\* Drop for Closed on an error return. Mutant guard-leaked never drops it.
Reopen ==
  /\ upd' = "idle"
  /\ IF Mutant = "guard-leaked"
       THEN UNCHANGED <<closed, unseen>>
       ELSE closed' = FALSE /\ unseen' = TRUE
  /\ UNCHANGED <<running, build, starts, updates, qlock, queueFile>>

\* back_up runs while it holds the db lock and the print queue lock.
BackupOk ==
  /\ upd = "backup" /\ ~qlock /\ upd' = "install"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates, qlock, queueFile>>

BackupFails == upd = "backup" /\ Reopen

\* update.install, then install_when_idle returns the Closed guard and
\* update_install binds it to _closed until the restart. Mutant
\* guard-dropped binds it to _, which drops it at once.
InstallOk ==
  /\ upd = "install" /\ upd' = "restarting"
  /\ IF Mutant = "guard-dropped"
       THEN closed' = FALSE /\ unseen' = TRUE
       ELSE UNCHANGED <<closed, unseen>>
  /\ UNCHANGED <<running, build, starts, updates, qlock, queueFile>>

InstallFails == upd = "install" /\ Reopen

\* app.restart() asked the event loop to exit. process::exit(0) follows.
Exit ==
  /\ upd = "restarting" /\ upd' = "exited"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates, qlock, queueFile>>

----------------------------------------------------------------------------
(* persist_queue, called by add_job, remove_job, update_job_status,        *)
(* send_project_file, and settle_print after a history row. The printer    *)
(* calls the last three at any time. It holds                              *)
(* the queue lock across fs::write, which truncates the file and then      *)
(* writes it. A failed write returns through ? and drops the lock with    *)
(* the file still partial.                                                 *)

WriteBegin ==
  /\ Alive /\ ~qlock
  /\ qlock' = TRUE /\ queueFile' = "partial"
  /\ UNCHANGED <<running, closed, unseen, build, starts, upd, updates>>

WriteEnd ==
  /\ Alive /\ qlock
  /\ qlock' = FALSE /\ queueFile' = "whole"
  /\ UNCHANGED <<running, closed, unseen, build, starts, upd, updates>>

WriteFails ==
  /\ Alive /\ qlock
  /\ qlock' = FALSE
  /\ UNCHANGED <<running, closed, unseen, build, starts, upd, updates, queueFile>>

----------------------------------------------------------------------------

Next ==
  \/ \E b \in Builds : Enter(b) \/ StartUngated(b) \/ Leave(b) \/ ReleaseEarly(b) \/ FinishWrite(b)
  \/ Click \/ DownloadFails \/ Downloaded
  \/ Top \/ CheckAndClose \/ CheckOnly \/ CloseLate \/ CheckBusy \/ MarkSeen \/ Wake
  \/ BackupOk \/ BackupFails \/ InstallOk \/ InstallFails \/ Exit
  \/ WriteBegin \/ WriteEnd \/ WriteFails

\* The updater's wait loop and every running build make progress. Nothing
\* forces a build, a click, or a queue write to start.
Fairness ==
  /\ WF_vars(Top) /\ WF_vars(CheckAndClose) /\ WF_vars(CheckOnly)
  /\ WF_vars(CloseLate) /\ WF_vars(CheckBusy) /\ WF_vars(MarkSeen) /\ WF_vars(Wake)
  /\ \A b \in Builds : WF_vars(Leave(b)) /\ WF_vars(ReleaseEarly(b)) /\ WF_vars(FinishWrite(b))
  /\ WF_vars(WriteEnd)

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* Properties. Each is one check in scripts/check.sh.                      *)

\* The restart never kills a build, a slice, or the sidecar's work, nor cuts
\* its last commit.
NoBuildCutOff == upd = "exited" => \A b \in Builds : build[b] = "idle"

\* From the idle check to the restart, the gate is closed and no build runs.
GateHeldUntilRestart ==
  upd \in {"backup", "install", "restarting", "exited"} =>
    closed /\ \A b \in Builds : build[b] = "idle"

\* A failed update leaves builds free to start again.
FailedUpdateReopens == upd = "idle" => ~closed

\* The restart never leaves print_queue.json half written.
QueueFileWholeAtRestart == upd = "exited" => queueFile = "whole"

\* A waiting update goes ahead once the builds let it.
UpdateGoesAhead == (upd \in Waiting) ~> (upd \notin Waiting)
=============================================================================
