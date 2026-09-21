# Reusable node groups

Select nodes and press Ctrl/Cmd+G to collapse them. Double-click the group, press Enter with it selected, or use **Open group**. Breadcrumbs and **Back** return to the parent. **Ungroup** restores the interior and its external wiring.

Groups are organizational containers, not a sixth audio category. Boundary connections become named ports with stable IDs. Edit their labels and order on the group node; expose additional sockets from an interior node's context menu. A connected port cannot be removed, and a node that supplies an exposed port cannot be deleted until that port is removed. The interior's input/output nodes visualize the interface and are read-only.

Ctrl/Cmd+D and paste copy the group's definitions and nested dependencies. **Duplicate linked group** shares them; **Make Independent** copies them while preserving that occurrence's audio IDs. The usage label and breadcrumb notice show when edits affect other uses. **Add reusable group** lists the local library and saved pipelines, with independent copy or linked reference. Importing a pipeline retains its microphone, file, recording and device configuration. Each occurrence runs inside the one active pipeline; it does not start another engine. Copied recording destinations remain configured, so the existing recording overwrite/new-file policy still applies.

WebRTC sessions belong to individual runtime nodes. Grouping and navigating an existing session preserves its ID and connection. Reusing a group containing room-specific `peer:` or `mixed` routing is rejected with an explanation; disconnect those routes before copying or linking, then create each instance's room. Such routing cannot be added to a shared definition. This restriction avoids connecting a new instance to somebody else's runtime peer ID.

## Persistence and execution

Pipeline version 4 retains an expanded `nodes`/`edges` graph and adds `groups`. The latter contains a root definition, its complete dependency closure, occurrence-to-runtime IDs, and captured plugin states per runtime instance. Grouping is transparent to occurrence identity; duplicates add a new identity prefix. Ungrouping carries that prefix into the promoted nodes. Stable identity is separate from editor position and navigation.

`getSnapshot`, save, restore and pipeline loading materialize the entire document. Rust still receives only its existing graph node kinds. Activation, tray activation, auto-restore and reconciliation use the complete expanded graph. Runtime plugin captures are folded into occurrence state before saving, including captures made by desktop shutdown while the group is hidden.

The existing `pipelines.json` store holds the library, definitions and affected pipelines together under `groupLibrary`. Writes are serialized in the single application frontend, validated before mutation, and explicitly saved with store autosave disabled. Versioned legacy keys are written in the same save so older applications refuse the document rather than load an obsolete v2 copy. Legacy v0–v3 data migrates on read and is retained until the first successful save. Unsupported future versions stay gated.

Definitions carry revisions. Stale edits and stale shared snapshots are rejected, without unlinking or overwriting newer changes. An Undo/Redo that changes a current shared definition explains that every linked use will be restored and requests confirmation. The editor rebases only revisions acknowledged by its own successful writes. Unused reusable definitions remain in the local library and are also validated for missing nodes, missing ports and dependency cycles. There is no syncing service or cross-device resolution. Snapshots include their dependencies; this repository has no standalone pipeline file export to extend.

The application root owns Mute shortcut registration, audio-file loop/EOF handling and plugin-close capture. Recording-file prompts use the full document. Network receiver setup runs independently of node mounts. Live effect, input-volume and audio-file controls use existing control APIs after parameter changes and reconciliation. No audio callback or Rust graph type changes are needed.

Plugin-host GUI and inline plugin parameter changes are runtime edits in the existing host API. Their captured opaque state is saved per instance, including hidden instances at shutdown; it is not broadcast to linked instances. Group definition fields such as plugin selection and bypass are shared. Restoring a changed opaque state for the same plugin during playback is rejected: stop the pipeline, restore, then start it. Sharing plugin-owned parameter/state edits and restoring that state live require a separate host-state synchronization change.

## Validation

Developed on Windows. Pure Bun tests cover wiring and runtime-ID equivalence, nesting, clipboard duplication, copied/shared definitions, independent instances, library propagation, revision conflicts, missing references/ports, cycles, v2 migration, save/reload, plugin capture and ordered Alt connections. `bun run check` checks the Svelte/TypeScript integration.

Browser interaction and native audio/device/network tests are still required on Windows, macOS and Linux. In particular, verify navigation while a Mute shortcut is held, recording-file prompts in a closed group, file EOF with a hidden live input, WebRTC and Net Receiver continuity, linked parameter edits and Undo during playback, and plugin capture on desktop shutdown.
