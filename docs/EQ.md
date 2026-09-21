# EQ controls

EQ is one effect node with two explicitly selected algorithms. New nodes and the preview start with eight enabled, flat Bell bands in Parametric mode. Each band supports Bell, low/high shelf, and second-order low/high cut (12 dB/octave), with frequency, gain, Q, and enable controls inline.

Drag a numbered point horizontally for logarithmic frequency and vertically for gain. Select a band to edit the circular knobs or numeric inputs. Shift makes pointer and arrow-key adjustments finer. Arrow keys move a point; Home or double-click resets its frequency, gain and Q. Knob arrows adjust the value, Enter or double-click resets it, and Home/End select its bounds. Cut filters retain their saved gain but do not use it; the gain control is disabled. Q controls shelf/cut resonance as well as Bell bandwidth. Controls capture pointers and isolate canvas drag, pan, wheel and keyboard interactions.

## Compatibility

- `NodeKind::Eq` remains unchanged. Missing `mode` means `graphic`, in Rust, pipeline loading and preset loading. `gainsDb[10]` always means the original sequential LR4 crossover gains, never parametric peaks.
- Pipeline schema 3 adds explicit legacy mode and the inactive parametric defaults. Older builds with future-version protection will not open these pipelines. Existing factory and user EQ presets retain the graphic algorithm; old EQ presets are not discarded merely for lacking a preset version. Preset recall preserves the node's bypass state.
- Graphic mode uses fixed graph points and a gain knob, with frequency and Q disabled. Its steady-state audio, including the original phase interaction, is preserved. The displayed response includes that phase; zero graphic gains do not imply a magnitude-flat ten-band sum.
- Both parameter sets are saved. Switching mode recalls the other set and explicitly changes the algorithm and sound; it is not an equivalent conversion. Applying a preset recalls its mode and parameter sets.

## DSP and limits

Parametric sections use the RBJ cookbook's Q form, including shelving resonance. The existing biquad supports double precision for these sections so low-frequency poles remain accurate at high sample rates; the legacy path keeps its original f32 processing. Frequency is stored in 20–20,000 Hz, gain in ±18 dB, and Q in 0.1–12. Deserialization enforces exactly eight bands and ten legacy gains; graph construction and live updates reject nonfinite or out-of-range values.

The effective parametric frequency is capped at `min(20,000, sampleRate * 0.49)`. The UI displays that limit without changing saved values until edited. The response is the target steady-state response, calculated from the DSP's digital coefficients; during a transition audio approaches that target. An empty `update_effect` patch returns the running EQ's processing rate (or null when inactive), allowing the UI to use the actual rate of a recording/network output. The UI refreshes it once per second and on parameter edits. Legacy graphic mode rejects rates at or below 22,628 Hz because its highest crossover would exceed Nyquist.

Only mode and processing-rate changes rebuild the effect. All band values, shape and enable changes use the existing atomic control path. Parametric updates crossfade two preallocated, fixed-coefficient chains over 20 ms, preserving unchanged band state. A fade completes before accepting the latest target, preventing continuous drags from repeatedly restarting a fade. Graphic gains use a 10 ms one-pole smoother. The callback performs bounded loops and arithmetic without allocating, locking or calling IPC. Effect bypass uses the existing graph bypass control.

## Checks

Run `bun test tests/eq.test.ts`, `bun run check`, `cargo check` from `src-tauri`, and `cargo test --lib audio::effects::eq::tests`. `cargo test --lib audio::pipeline::sig::tests` checks reconcile classification. `bun run generate --lib export_bindings` regenerates the TypeScript schema through ts-rs without running unrelated audio tests.

The shared response fixtures are checked by TypeScript math and Rust coefficients/audio measurements. DSP tests cover flat/disabled bands, Bell gain/frequency/Q, shelf and cut response, bounds and stable poles at 8–384 kHz, rapid updates, transition step size/convergence, legacy sample equality, bypass/control reuse, and mode/rate rebuilds. Audio paths are platform independent; native device playback and UI interaction still require per-platform testing.
