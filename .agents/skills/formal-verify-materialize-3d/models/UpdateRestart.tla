--------------------------- MODULE UpdateRestart ---------------------------
(***************************************************************************)
(* What "Update now" can cut off when it restarts the app.                 *)
(*                                                                         *)
(* Each action is one indivisible step in the code it names:               *)
(*   src-tauri/src/build_gate.rs              BuildGate, OwnedRunning,     *)
(*                                            Closed                       *)
(*   src-tauri/src/updater.rs                 update_install,              *)
(*                                            install_when_idle            *)
(*   src-tauri/src/sidecar.rs                 a slice takes its own pass   *)
(*                                            (with_own_pass), and the     *)
(*   sidecar/src/busy.ts                      sidecar's work takes a pass  *)
(*   sidecar/src/chat.ts                      (set_busy) before a send's   *)
(*   sidecar/src/app.ts                       first commit and before work *)
(*                                            a crash cut off resumes, and *)
(*                                            drops it once no task is     *)
(*                                            pending or running, after    *)
(*                                            its last commit              *)
(* Tauri's AppHandle::restart from an async command asks the event loop to *)
(* exit, then calls std::process::exit(0), which stops every other thread  *)
(* wherever it is. That is the Exit action.                                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Builds,      \* tasks that each hold at most one build pass at a time
  Slice,       \* the member of Builds that is a slice Rust runs for the sidecar
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
  updates     \* update_install runs so far

vars == <<running, closed, unseen, build, starts, upd, updates>>

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

----------------------------------------------------------------------------
(* Builds. A slice Rust runs for the sidecar takes its own pass           *)
(* (with_own_pass, through BuildGate::enter_owned) and holds it until it   *)
(* returns. The sidecar asks for a pass (set_busy) before a send commits   *)
(* and before work a crash cut off resumes, and gives it back once no task *)
(* is pending or running, after its last commit. Turn is that work. A task *)
(* that waits, sleeps, or holds a sign-in wait does none until something   *)
(* wakes it, and it resumes after a restart, so the model has no step for  *)
(* it. A request from a sidecar run that ended takes no pass.              *)

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

\* BuildGate::enter_owned. One send_if_modified. A refused enter changes nothing.
Enter(b) ==
  /\ CanStart(b) /\ Gated(b) /\ ~closed
  /\ running' = running + 1
  /\ unseen' = TRUE
  /\ Started(b)
  /\ UNCHANGED <<closed, upd, updates>>

\* Mutants ungated-slice and ungated-turn: the task runs without a pass.
StartUngated(b) ==
  /\ CanStart(b) /\ ~Gated(b)
  /\ Started(b)
  /\ UNCHANGED <<running, closed, unseen, upd, updates>>

\* Drop for OwnedRunning. One send_modify, which always notifies.
Leave(b) ==
  /\ Alive /\ build[b] = "running" /\ ~EarlyRelease(b)
  /\ build' = [build EXCEPT ![b] = "idle"]
  /\ IF Gated(b)
       THEN running' = running - 1 /\ unseen' = TRUE
       ELSE UNCHANGED <<running, unseen>>
  /\ UNCHANGED <<closed, starts, upd, updates>>

\* Mutant early-release: the pass drops while the sidecar still has its last
\* commit to make.
ReleaseEarly(b) ==
  /\ Alive /\ build[b] = "running" /\ EarlyRelease(b)
  /\ build' = [build EXCEPT ![b] = "writing"]
  /\ running' = running - 1 /\ unseen' = TRUE
  /\ UNCHANGED <<closed, starts, upd, updates>>

FinishWrite(b) ==
  /\ Alive /\ build[b] = "writing"
  /\ build' = [build EXCEPT ![b] = "idle"]
  /\ UNCHANGED <<running, closed, unseen, starts, upd, updates>>

----------------------------------------------------------------------------
(* update_install. It holds the PendingUpdate lock for the whole run, so   *)
(* only one runs at a time.                                                *)

Click ==
  /\ upd = "idle" /\ updates < MaxUpdates
  /\ upd' = "download" /\ updates' = updates + 1
  /\ UNCHANGED <<running, closed, unseen, build, starts>>

DownloadFails ==
  /\ upd = "download" /\ upd' = "idle"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates>>

\* The download verified. close_when_idle subscribes, which marks the
\* channel's current version as seen.
Downloaded ==
  /\ upd = "download" /\ upd' = "top" /\ unseen' = FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates>>

\* Loop top: changes.borrow_and_update(). Mutant late-subscribe moves it
\* after the idle check (MarkSeen).
Top ==
  /\ upd = "top" /\ upd' = "check"
  /\ unseen' = IF Mutant = "late-subscribe" THEN unseen ELSE FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates>>

Busy == running > 0 \/ closed

\* The idle check and the close in one send_if_modified.
CheckAndClose ==
  /\ upd = "check" /\ ~Busy /\ Mutant /= "split-close"
  /\ closed' = TRUE /\ unseen' = TRUE /\ upd' = "install"
  /\ UNCHANGED <<running, build, starts, updates>>

\* Mutant split-close: read running, then close in a second send.
CheckOnly ==
  /\ upd = "check" /\ ~Busy /\ Mutant = "split-close"
  /\ upd' = "close"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates>>

CloseLate ==
  /\ upd = "close"
  /\ closed' = TRUE /\ unseen' = TRUE /\ upd' = "install"
  /\ UNCHANGED <<running, build, starts, updates>>

\* send_if_modified returned false: no change, no notification.
CheckBusy ==
  /\ upd = "check" /\ Busy
  /\ upd' = IF Mutant = "late-subscribe" THEN "mark" ELSE "sleep"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates>>

MarkSeen ==
  /\ upd = "mark" /\ upd' = "sleep" /\ unseen' = FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates>>

\* changes.changed().await returns once the channel holds an unseen change.
Wake ==
  /\ upd = "sleep" /\ unseen
  /\ upd' = "top" /\ unseen' = FALSE
  /\ UNCHANGED <<running, closed, build, starts, updates>>

\* Drop for Closed on an error return. Mutant guard-leaked never drops it.
Reopen ==
  /\ upd' = "idle"
  /\ IF Mutant = "guard-leaked"
       THEN UNCHANGED <<closed, unseen>>
       ELSE closed' = FALSE /\ unseen' = TRUE
  /\ UNCHANGED <<running, build, starts, updates>>

\* update.install, then install_when_idle returns the Closed guard and
\* update_install binds it to _closed until the restart. Mutant
\* guard-dropped binds it to _, which drops it at once.
InstallOk ==
  /\ upd = "install" /\ upd' = "restarting"
  /\ IF Mutant = "guard-dropped"
       THEN closed' = FALSE /\ unseen' = TRUE
       ELSE UNCHANGED <<closed, unseen>>
  /\ UNCHANGED <<running, build, starts, updates>>

InstallFails == upd = "install" /\ Reopen

\* app.restart() asked the event loop to exit. process::exit(0) follows.
Exit ==
  /\ upd = "restarting" /\ upd' = "exited"
  /\ UNCHANGED <<running, closed, unseen, build, starts, updates>>

----------------------------------------------------------------------------
Next ==
  \/ \E b \in Builds : Enter(b) \/ StartUngated(b) \/ Leave(b) \/ ReleaseEarly(b) \/ FinishWrite(b)
  \/ Click \/ DownloadFails \/ Downloaded
  \/ Top \/ CheckAndClose \/ CheckOnly \/ CloseLate \/ CheckBusy \/ MarkSeen \/ Wake
  \/ InstallOk \/ InstallFails \/ Exit

\* The updater's wait loop and every running build make progress. Nothing
\* forces a build or a click to start.
Fairness ==
  /\ WF_vars(Top) /\ WF_vars(CheckAndClose) /\ WF_vars(CheckOnly)
  /\ WF_vars(CloseLate) /\ WF_vars(CheckBusy) /\ WF_vars(MarkSeen) /\ WF_vars(Wake)
  /\ \A b \in Builds : WF_vars(Leave(b)) /\ WF_vars(ReleaseEarly(b)) /\ WF_vars(FinishWrite(b))

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* Properties. Each is one check in scripts/check.sh.                      *)

\* The restart never kills a build, a slice, or the sidecar's work, nor cuts
\* its last commit.
NoBuildCutOff == upd = "exited" => \A b \in Builds : build[b] = "idle"

\* From the idle check to the restart, the gate is closed and no build runs.
GateHeldUntilRestart ==
  upd \in {"install", "restarting", "exited"} =>
    closed /\ \A b \in Builds : build[b] = "idle"

\* A failed update leaves builds free to start again.
FailedUpdateReopens == upd = "idle" => ~closed

\* A waiting update goes ahead once the builds let it.
UpdateGoesAhead == (upd \in Waiting) ~> (upd \notin Waiting)
=============================================================================
