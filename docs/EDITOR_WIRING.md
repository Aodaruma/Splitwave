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

Cutting follows the actual rendered SVG paths, including straight, Bézier, step, rounded-step and broken-connection wires. Geometry includes the SVG transform, viewport zoom/pan and the editor's screen offset. Curves are sampled at at most 2 CSS pixels of arc length, with a 1 pixel intersection tolerance. The stroke previews the pending cut count; cables remain connected until release. Esc, pointer cancellation, lost pointer capture, window blur or opening a modal discards the gesture. Its release does not open a context menu; the next ordinary right click does.

Alt + S treats all connections feeding one input as a bundle, preserving fan-in, IDs and source handles. One linked input advances to the next compatible displayed input and wraps. Two linked inputs exchange their bundles; three or more linked inputs rotate down through the occupied compatible inputs, wrapping at the bottom. Empty inputs participate only when one input is linked. Dynamic nodes use their currently displayed inputs, including the spare trailing input within the channel ceiling. Group ports use stable port IDs and display order, with compatibility resolved through nested groups.

L/R and numbered channels are compatible individual audio inputs: switching **deliberately moves L to R and R to L** when those two inputs are linked. Bus inputs form a separate family. Sidechain and other named roles stay in their own families. Missing inputs stay untouched. A switch that would remove the feed for an existing pass-through channel output is refused with an editor notice. Group validation rejects invalid expanded routes before saving. Selecting two nodes does not swap their outputs.

A shake requires three direction reversals on either screen axis within 700 ms, each traveling at least 24 CSS pixels from the preceding extreme, after an initial 24 pixel movement. Small jitter, one correction, slow movements, modifiers and dragging node controls do not count. The notice confirms a pending detach; release applies it together with the move. Repeated shakes in the same drag do nothing further. Esc, pointer cancellation or blur restores the starting positions and keeps the wires. Ordinary dragging retains XYFlow selection, snapping and group movement behavior.

Boundary nodes and their noneditable exposed-port mapping wires are excluded. A moved group instance loses its external editable cables; its stored definition is retained. Multiple moved selected nodes also lose the cables between them. Unrelated graph connections remain intact, and no bypass or route healing is performed.

## References and verification

Behavior references: Blender's [Cut Links and Detach Links](https://docs.blender.org/manual/en/3.4/interface/controls/nodes/editing.html) and Node Wrangler's [Swap Links and Lazy Connect](https://docs.blender.org/manual/en/4.0/addons/node/node_wrangler.html). Implementation is independent; no Blender GPL source was copied. Alt + left detaches; Alt + right connects. Hold Alt before starting the drag; additional modifiers retain their existing behaviors. An Alt + left click without movement leaves cables intact. The existing Alt multi-channel socket selection remains unchanged.

Developed on Windows. Pure geometry, input-assignment, shortcut-scope and shake/detach tests run with `bun test`; frontend validation uses `bun run check`. Native interaction and audio playback checks on Windows, macOS and Linux are not covered by these tests.

Manual integration checks: cut several crossing wire shapes at different zoom/pan settings, cancel before release, verify the next ordinary context menu, and undo/redo once. Exercise Alt + S on L/R, fan-in, dynamically growing and nested group inputs, then verify controls/modal focus. Drag a selected group slowly and with jitter, shake deliberately, pause before releasing, cancel once with Esc and once with window blur, and verify one undo restores both positions and every detached cable.
