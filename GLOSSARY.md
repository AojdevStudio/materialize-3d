# Materialize 3D

These terms describe how a person works with models on a design.

## Language

### Roles

**Lead model**:
The model a person chooses to answer them in chat. It can give a task to the helper model.

**Helper model**:
The model a person chooses to handle tasks from the lead model and return a result.
_Avoid_: Astra (a model that can fill the role, not the role)

**Role pair**:
The lead model and the helper model of a chat, each chosen independently. Any pair is valid, including the same model in both roles.

**Lead-alone turn**:
A turn that the lead model runs with no helper model. A disabled helper produces a lead-alone turn.
_Avoid_: Lead-only turn

### Handoffs

**Handoff**:
A task the lead model gives the helper model. One entry in the main chat shows the task, its live status, and its result or failure, even when the activity trace is closed.

**Handoff entry**:
The one live entry a handoff has in the main chat. It names both roles and their models, and shows the task, its current status, and the result or failure.

### Model versions

**Saved version**:
The model version a chat keeps for a role. An existing chat keeps its selected versions while they remain available.

**Retired version**:
A saved version that its provider has retired. A missing login or temporary provider failure is different from a retired version.

### Phones and tablets

**Paired device**:
An iPhone or iPad that redeemed a pairing code on one computer. It can open, read, and send to that computer's chats until the computer forgets it.

**Pairing code**:
The code the computer shows as a QR image in Settings. It works once, for 5 minutes, and pairs one device.
_Avoid_: PIN, password

**Phone service**:
The small service on the computer that paired devices reach through the person's Tailscale Serve. It offers only what the mobile app needs.
_Avoid_: server, API (when talking to a person)
