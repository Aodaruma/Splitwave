# Editor wiring gestures

These gestures operate in the current editor scope. Focus the canvas or a node body; text fields, node controls, handles, resize controls and modal dialogs retain their own interactions.

| Gesture                              | Action                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Ctrl + right drag                    | Draw a freehand stroke across cables. Release to cut every crossed editable cable in one undo step.              |
| Alt + S                              | Switch the incoming assignments of exactly one selected node.                                                    |
| Left drag + deliberate shake         | Move nodes and detach all their editable incoming, outgoing and internal selected-group cables in one undo step. |
| Alt + left drag                      | Move nodes and detach all their editable cables on release, in one undo step.                                    |
| Alt + right drag between node bodies | Automatically connect matching audio channels while preserving L/R.                                              |
| Ordinary right click                 | Existing context menu.                                                                                           |

Selected nodes have an accent-colored outline in both themes. Rectangle and multiple selection keep node surfaces unchanged. Alt + right drag immediately shows a solid red line with circular endpoints, frames around both nodes, and matching visible socket highlights. The preview follows pointer movement even across controls or the multiple-selection overlay. Dynamically created sockets are highlighted only once present in the rendered node. Inside groups, this gesture can expose ports through the input/output boundaries; see [Node groups](NODE_GROUPS.md).

Cutting follows the actual rendered SVG paths, including straight, Bézier, step, rounded-step and broken-connection wires. Geometry includes the SVG transform, viewport zoom/pan and the editor's screen offset. Curves are sampled at at most 2 CSS pixels of arc length, with a 1 pixel intersection tolerance. The stroke previews the pending cut count; cables remain connected until release. Esc, pointer cancellation, lost pointer capture, window blur or opening a modal discards the gesture. Its release does not open a context menu; the next ordinary right click does.

Alt + S treats all connections feeding one input as a bundle, preserving fan-in, IDs and source handles. One linked input advances to the next compatible displayed input and wraps. Two linked inputs exchange their bundles; three or more linked inputs rotate down through the occupied compatible inputs, wrapping at the bottom. Empty inputs participate only when one input is linked. Dynamic nodes use their currently displayed inputs, including the spare trailing input within the channel ceiling. Group ports use stable port IDs and display order, with compatibility resolved through nested groups.

L/R and numbered channels are compatible individual audio inputs: switching **deliberately moves L to R and R to L** when those two inputs are linked. Bus inputs form a separate family. Sidechain and other named roles stay in their own families. Missing inputs stay untouched. A switch that would remove the feed for an existing pass-through channel output is refused with an editor notice. Group validation rejects invalid expanded routes before saving. Selecting two nodes does not swap their outputs.

A shake requires three direction reversals on either screen axis within 700 ms, each traveling at least 24 CSS pixels from the preceding extreme, after an initial 24 pixel movement. Small jitter, one correction, slow movements, modifiers and dragging node controls do not count. The notice confirms a pending detach; release applies it together with the move. Repeated shakes in the same drag do nothing further. Esc, pointer cancellation or blur restores the starting positions and keeps the wires. Ordinary dragging retains XYFlow selection, snapping and group movement behavior.

Boundary nodes and their noneditable exposed-port mapping wires are excluded. A moved group instance loses its external editable cables; its stored definition is retained. Multiple moved selected nodes also lose the cables between them. Unrelated graph connections remain intact, and no bypass or route healing is performed.

## References and verification

Behavior references: Blender's [Cut Links and Detach Links](https://docs.blender.org/manual/en/3.4/interface/controls/nodes/editing.html) and Node Wrangler's [Swap Links and Lazy Connect](https://docs.blender.org/manual/en/4.0/addons/node/node_wrangler.html). Implementation is independent; no Blender GPL source was copied. Alt + left detaches; Alt + right connects. Hold Alt before starting the drag; additional modifiers retain their existing behaviors. An Alt + left click without movement leaves cables intact. The existing Alt multi-channel socket selection remains unchanged.

Developed on Windows. Pure geometry, input-assignment, shortcut-scope and shake/detach tests run with `bun test`; frontend validation uses `bun run check`. Native interaction and audio playback checks on Windows, macOS and Linux are not covered by these tests.

Manual integration checks: cut several crossing wire shapes at different zoom/pan settings, cancel before release, verify the next ordinary context menu, and undo/redo once. Exercise Alt + S on L/R, fan-in, dynamically growing and nested group inputs, then verify controls/modal focus. Drag a selected group slowly and with jitter, shake deliberately, pause before releasing, cancel once with Esc and once with window blur, and verify one undo restores both positions and every detached cable.

## Selection layout and bypass

Shift + = (Shift + + on keyboards reporting `+`) aligns and evenly distributes selected movable nodes along the dominant axis of their measured bounds. The canvas and node context menus also provide explicit horizontal and vertical actions. Group instances participate; boundary nodes and locked nodes do not. At least two fully measured nodes are required. The bounding-box center is preserved, nodes are ordered by their current centers (ID breaks ties), and free space is equal with at least 24 flow pixels between nodes. Crowded selections expand symmetrically. This is one undo step and changes only positions.

M toggles bypass for selected effects that support the existing `bypassed` property, including hosted effects. If any eligible effect is engaged, all eligible effects are bypassed; otherwise all are engaged. This does not change the Mute node's `muted` parameter. Inputs, outputs, monitors, network nodes, groups and boundaries are excluded. The context menu names the resulting action. It uses the normal editor save/live-control path, including linked group instances, and produces one undo step. Individual ON/BYP controls remain available. These shortcuts ignore repeated keydowns, form/numeric controls and modals.

## Insert an unwired effect into a cable

Drag one entirely unconnected ordinary effect over a rendered cable. The pending channel bundle glows amber; release inserts the effect and records the move and wiring together in one undo step. Escape, pointer cancellation, blur or a modal restores the starting position and leaves every cable intact. Alt-detach and shake-detach take precedence.

Insertion requires symmetric channel I/O within the effect's capacity. Gain, EQ and other ordinary registry effects with channel pass-through I/O qualify; plugins, buses, named roles and boundary nodes do not. All channels between the same two endpoints are treated as one bundle, including L/R and crossed channel assignments. Existing target cable IDs/handles and other fanout/fan-in routes are retained. Multiple overlapping endpoint bundles, repeated channel assignments, existing node connections and cycles are refused. Ordinary internal cables in nested scopes work; cables to/from group instances and exposed boundary mappings are intentionally excluded. The preview never changes audio routing.

## Editable cable points

Double-click a cable, or use its **Add editable cable point** context action, to add a bend at that flow position. Drag its circular handle to shape the cable. Handles brighten when the cable is selected/hovered or a point has keyboard focus. Right-click a handle to remove it, or press Delete/Backspace while that handle has focus. A held deletion key removes only that point. Point controls do not drag nodes or pan the canvas. Add, remove and each completed drag are separate single undo steps; Escape, pointer cancellation, lost capture, blur and modals cancel a drag.

These are editor-only cable points, not DSP nodes or audio branching junctions. A cable with points is drawn as a polyline through them; removing its last point restores the configured cable shape. Ctrl + right drag cuts the actual shaped path. Optional `edge.data.reroutes` coordinates belong to the stored editor scope. They survive JSON save/load/import, undo/redo, translated copy/paste, grouping/ungrouping and independent or linked reusable groups. Internal points translate with their group scope; outer cables retain their own points. Exposed boundary mapping wires have no editable points. Expanded runtime edges omit layout, so moving points does not change the audio routing signature or reconcile the engine.

Additional pure tests cover measured mixed-size alignment, stereo insertion with crossed handles and unrelated fanout/fan-in, cycle/capacity/role refusals, reroute insertion order and persistence through clipboard/group/library round trips, and mixed-state bypass. Native UI and playback testing remains pending on all platforms. Integration checks should exercise one-step undo/redo for a drop insertion and point drag, cancellation after a long paused drag, point deletion while other nodes are selected, nested scope navigation, and linked-group bypass during playback.
