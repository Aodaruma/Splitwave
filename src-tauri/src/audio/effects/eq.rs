use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use crate::audio::graph::{EqBand, EqData, EqFilter, EqMode};

use super::biquad::{biquad_for, BandShape, Biquad};
use super::util::{db_to_linear, load_f32, store_f32};
use super::{Effect, EffectControl};

/// Linkwitz-Riley 4th-order crossover points: geometric means between adjacent
/// band centres. Preserve the legacy sequential splits, including their phase
/// interaction: the full ten-band sum is not a unity-magnitude response.
const EQ_CROSSOVER_FREQS: [f32; 9] = [
    45.2548, 89.4427, 176.7767, 353.5534, 707.1068, 1414.2136, 2828.4271, 5656.8542, 11313.7085,
];

const BUTTER_Q: f32 = std::f32::consts::FRAC_1_SQRT_2; // 1/√2 ≈ 0.7071

/// Cascaded pair of Butterworth biquads — a 4th-order Linkwitz-Riley section.
#[derive(Clone, Copy, Default)]
struct Lr4 {
    a: Biquad,
    b: Biquad,
}

impl Lr4 {
    fn new(shape: BandShape, freq_hz: f32, sample_rate: u32) -> Self {
        let c = biquad_for(shape, freq_hz, BUTTER_Q, sample_rate);
        Lr4 { a: c, b: c }
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        self.b.process(self.a.process(x))
    }
}

/// Per-channel filter chain. The input cascades through 9 crossover splits:
/// each split peels off one band's slice via LPF and forwards the HPF residual
/// to the next stage. Band gains scale these slices and we sum.
struct ChannelChain {
    lpfs: [Lr4; 9],
    hpfs: [Lr4; 9],
}

impl ChannelChain {
    fn new(sample_rate: u32) -> Self {
        Self {
            lpfs: std::array::from_fn(|i| {
                Lr4::new(BandShape::Lpf, EQ_CROSSOVER_FREQS[i], sample_rate)
            }),
            hpfs: std::array::from_fn(|i| {
                Lr4::new(BandShape::Hpf, EQ_CROSSOVER_FREQS[i], sample_rate)
            }),
        }
    }

    #[inline]
    fn process(&mut self, x: f32, gains_linear: &[f32; 10]) -> f32 {
        let mut residual = x;
        let mut sum = 0.0;
        for i in 0..9 {
            let band = self.lpfs[i].process(residual);
            residual = self.hpfs[i].process(residual);
            sum += band * gains_linear[i];
        }
        sum + residual * gains_linear[9]
    }
}

/// Allocated on the control thread; workers only load atomics.
#[derive(Clone)]
pub struct EqControls {
    pub mode: EqMode,
    pub sample_rate: u32,
    gains: [Arc<AtomicU32>; 10],
    bands: [[Arc<AtomicU32>; 5]; 8],
}

impl EqControls {
    fn new(d: EqData, sample_rate: u32) -> Self {
        Self {
            mode: d.mode,
            sample_rate,
            gains: std::array::from_fn(|i| Arc::new(AtomicU32::new(d.gains_db[i].to_bits()))),
            bands: std::array::from_fn(|i| {
                Self::values(d.bands[i]).map(|v| Arc::new(AtomicU32::new(v)))
            }),
        }
    }

    fn values(b: EqBand) -> [u32; 5] {
        [
            b.frequency.to_bits(),
            b.gain_db.to_bits(),
            b.q.to_bits(),
            b.filter as u32,
            b.enabled as u32,
        ]
    }

    pub fn apply_update(&self, data: &serde_json::Value) {
        if let Some(gains) = data.get("gainsDb") {
            if let Ok(gains) = serde_json::from_value::<[f32; 10]>(gains.clone()) {
                if gains
                    .iter()
                    .all(|g| g.is_finite() && (-18.0..=18.0).contains(g))
                {
                    for (slot, g) in self.gains.iter().zip(gains) {
                        store_f32(slot, g);
                    }
                }
            }
        }
        if let Some(bands) = data.get("bands") {
            if let Ok(bands) = serde_json::from_value::<[EqBand; 8]>(bands.clone()) {
                let d = EqData {
                    mode: EqMode::Parametric,
                    bands,
                    gains_db: [0.0; 10],
                    bypassed: false,
                };
                if d.validate_parameters().is_ok() {
                    for (slots, b) in self.bands.iter().zip(bands) {
                        for (slot, value) in slots.iter().zip(Self::values(b)) {
                            slot.store(value, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
    }

    fn load_bands(&self) -> [EqBand; 8] {
        self.bands.each_ref().map(|b| EqBand {
            frequency: load_f32(&b[0]),
            gain_db: load_f32(&b[1]),
            q: load_f32(&b[2]),
            filter: match b[3].load(Ordering::Relaxed) {
                1 => EqFilter::LowShelf,
                2 => EqFilter::HighShelf,
                3 => EqFilter::LowCut,
                4 => EqFilter::HighCut,
                _ => EqFilter::Bell,
            },
            enabled: b[4].load(Ordering::Relaxed) != 0,
        })
    }
}

/// RBJ Q form, including shelf resonance: https://www.w3.org/TR/audio-eq-cookbook/
/// Mirrored by pipeline/eq.ts; shared coefficient fixtures test this contract.
pub fn parametric_coefficients(b: EqBand, sample_rate: u32) -> Biquad<f64> {
    if !b.enabled {
        return Biquad::normalized([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]);
    }
    let f = (b.frequency as f64).clamp(20.0, (sample_rate as f64 * 0.49).min(20000.0));
    let w = 2.0 * std::f64::consts::PI * f / sample_rate as f64;
    let (sin, cos) = w.sin_cos();
    let alpha = sin / (2.0 * b.q as f64);
    let a = 10.0_f64.powf(b.gain_db as f64 / 40.0);
    let beta = 2.0 * a.sqrt() * alpha;
    let (num, den) = match b.filter {
        EqFilter::Bell => (
            [1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a],
        ),
        EqFilter::LowCut => (
            [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        ),
        EqFilter::HighCut => (
            [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        ),
        EqFilter::LowShelf => (
            [
                a * ((a + 1.0) - (a - 1.0) * cos + beta),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - beta),
            ],
            [
                (a + 1.0) + (a - 1.0) * cos + beta,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - beta,
            ],
        ),
        EqFilter::HighShelf => (
            [
                a * ((a + 1.0) + (a - 1.0) * cos + beta),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - beta),
            ],
            [
                (a + 1.0) - (a - 1.0) * cos + beta,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - beta,
            ],
        ),
    };
    Biquad::normalized(num, den)
}

#[derive(Clone, Copy)]
struct ParametricBand {
    filter: Biquad<f64>,
    x: [f64; 2],
    y: [f64; 2],
}

impl ParametricBand {
    fn new(filter: Biquad<f64>) -> Self {
        Self {
            filter,
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.filter.process_f64(x);
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

struct Parametric {
    chains: [[[ParametricBand; 8]; 2]; 2],
    active: usize,
    target: [EqBand; 8],
    remaining: usize,
    fade_frames: usize,
}

fn can_preserve_history(old: Biquad<f64>, new: Biquad<f64>, from: EqBand, to: EqBand) -> bool {
    // DC/Nyquist denominator margins and damping detect even tiny pole moves near an endpoint.
    from.filter == to.filter
        && from.enabled == to.enabled
        && (from.gain_db - to.gain_db).abs() <= 0.5
        && [
            (1.0 + old.a1 + old.a2, 1.0 + new.a1 + new.a2),
            (1.0 - old.a1 + old.a2, 1.0 - new.a1 + new.a2),
            (1.0 - old.a2, 1.0 - new.a2),
        ]
        .iter()
        .all(|&(a, b)| (a - b).abs() <= 0.1 * a.min(b))
}

impl Parametric {
    fn new(bands: [EqBand; 8], sr: u32) -> Self {
        let chain = bands.map(|b| ParametricBand::new(parametric_coefficients(b, sr)));
        Self {
            chains: [[chain; 2]; 2],
            active: 0,
            target: bands,
            remaining: 0,
            fade_frames: (sr as usize / 50).max(1),
        }
    }

    fn update(&mut self, bands: [EqBand; 8], sr: u32) {
        // Finish each 20 ms fade before consuming the latest target; drags cannot restart it.
        if self.remaining == 0 && bands != self.target {
            let coefficients = bands.map(|b| parametric_coefficients(b, sr));
            let preserve: [bool; 8] = std::array::from_fn(|i| {
                can_preserve_history(
                    self.chains[self.active][0][i].filter,
                    coefficients[i],
                    self.target[i],
                    bands[i],
                )
            });
            for ch in 0..2 {
                for i in 0..8 {
                    self.chains[1 - self.active][ch][i] = if preserve[i] {
                        let mut band = self.chains[self.active][ch][i];
                        if bands[i] != self.target[i] {
                            band.filter.retune(coefficients[i], band.x, band.y);
                        }
                        band
                    } else {
                        ParametricBand::new(coefficients[i])
                    };
                }
            }
            self.target = bands;
            self.remaining = self.fade_frames;
        }
    }

    fn process(&mut self, frame: &mut [f32]) {
        let mix = 1.0 - self.remaining as f64 / self.fade_frames as f64;
        for (ch, sample) in frame.iter_mut().enumerate() {
            let run =
                |chain: &mut [ParametricBand; 8], x| chain.iter_mut().fold(x, |x, b| b.process(x));
            let a = run(&mut self.chains[self.active][ch], *sample as f64);
            *sample = if self.remaining > 0 {
                let b = run(&mut self.chains[1 - self.active][ch], *sample as f64);
                (a + (b - a) * mix) as f32
            } else {
                a as f32
            };
        }
        if self.remaining > 0 {
            self.remaining -= 1;
            if self.remaining == 0 {
                self.active = 1 - self.active;
            }
        }
    }
}

pub struct EqEffect {
    channels: [ChannelChain; 2],
    controls: EqControls,
    gains_linear: [f32; 10],
    gain_smoothing: f32,
    parametric: Parametric,
    sample_rate: u32,
}

impl EqEffect {
    pub fn new(d: EqData, sample_rate: u32) -> (Self, EffectControl) {
        let controls = EqControls::new(d, sample_rate);
        let effect = Self::from_state(controls.clone(), sample_rate);
        (effect, EffectControl::Eq { controls })
    }

    pub fn from_state(controls: EqControls, sample_rate: u32) -> Self {
        Self {
            channels: [
                ChannelChain::new(sample_rate),
                ChannelChain::new(sample_rate),
            ],
            gains_linear: std::array::from_fn(|i| db_to_linear(load_f32(&controls.gains[i]))),
            gain_smoothing: 1.0 - (-1.0 / (0.01 * sample_rate as f32)).exp(),
            parametric: Parametric::new(controls.load_bands(), sample_rate),
            controls,
            sample_rate,
        }
    }
}

impl Effect for EqEffect {
    fn process(&mut self, samples: &mut [f32], frames: usize) {
        if self.controls.mode == EqMode::Parametric {
            self.parametric
                .update(self.controls.load_bands(), self.sample_rate);
            for frame in samples[..frames * 2].chunks_exact_mut(2) {
                self.parametric.process(frame);
            }
        } else {
            let target: [f32; 10] =
                std::array::from_fn(|i| db_to_linear(load_f32(&self.controls.gains[i])));
            for frame in samples[..frames * 2].chunks_exact_mut(2) {
                for (gain, target) in self.gains_linear.iter_mut().zip(target) {
                    *gain += (target - *gain) * self.gain_smoothing;
                }
                frame[0] = self.channels[0].process(frame[0], &self.gains_linear);
                frame[1] = self.channels[1].process(frame[1], &self.gains_linear);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::graph::default_eq_bands;

    fn data() -> EqData {
        EqData {
            mode: EqMode::Parametric,
            bands: default_eq_bands(),
            gains_db: [0.0; 10],
            bypassed: false,
        }
    }

    fn band_update(bands: [EqBand; 8]) -> serde_json::Value {
        serde_json::json!({"bands": bands.map(|b| serde_json::json!({
            "frequency": b.frequency, "q": b.q, "gainDb": b.gain_db, "enabled": b.enabled,
            "filter": match b.filter {
                EqFilter::Bell => "bell",
                EqFilter::LowShelf => "lowShelf",
                EqFilter::HighShelf => "highShelf",
                EqFilter::LowCut => "lowCut",
                EqFilter::HighCut => "highCut",
            }
        }))})
    }

    fn tone_db(mut d: EqData, freq: f32, sr: u32) -> f32 {
        d.mode = EqMode::Parametric;
        let (mut e, _) = EqEffect::new(d, sr);
        let mut energy = 0.0_f64;
        let mut input = 0.0_f64;
        let frames = sr as usize / 2;
        for n in 0..frames {
            let x = (2.0 * std::f32::consts::PI * freq * n as f32 / sr as f32).sin() * 0.01;
            let mut frame = [x, x];
            e.process(&mut frame, 1);
            assert_eq!(frame[0], frame[1]);
            if n > frames / 2 {
                energy += (frame[0] as f64).powi(2);
                input += (x as f64).powi(2);
            }
        }
        (10.0 * (energy / input).log10()) as f32
    }

    #[test]
    fn flat_and_disabled_bands_are_passthrough() {
        for disabled in [false, true] {
            let mut d = data();
            if disabled {
                for b in &mut d.bands {
                    b.gain_db = 18.0;
                    b.filter = EqFilter::LowCut;
                    b.enabled = false;
                }
            }
            let (mut e, _) = EqEffect::new(d, 48000);
            for n in 0..4096 {
                let x = (n as f32 * 0.13).sin();
                let mut frame = [x, -x];
                e.process(&mut frame, 1);
                assert!((frame[0] - x).abs() < 1e-6);
                assert!((frame[1] + x).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn bell_gain_frequency_and_q_match_measured_audio() {
        for sr in [8000, 44100, 48000, 96000, 192000, 384000] {
            for gain in [-18.0, 12.0] {
                let mut d = data();
                d.bands[0].frequency = 1000.0;
                d.bands[0].gain_db = gain;
                d.bands[0].q = 4.0;
                assert!((tone_db(d, 1000.0, sr) - gain).abs() < 0.03);
            }
        }
        let mut d = data();
        d.bands[0].frequency = 1000.0;
        d.bands[0].gain_db = 12.0;
        let wide = tone_db(d, 700.0, 48000);
        d.bands[0].q = 8.0;
        assert!(tone_db(d, 700.0, 48000) < wide - 4.0);
        d.bands[0].frequency = 2000.0;
        assert!((tone_db(d, 2000.0, 48000) - 12.0).abs() < 0.03);
        assert!(tone_db(d, 1000.0, 48000) < 1.0);
    }

    #[test]
    fn shelves_and_cuts_have_expected_sides() {
        let mut d = data();
        d.bands[0].frequency = 1000.0;
        d.bands[0].q = BUTTER_Q;
        d.bands[0].gain_db = 12.0;
        for filter in [EqFilter::LowShelf, EqFilter::HighShelf] {
            d.bands[0].filter = filter;
            let (low, high) = (tone_db(d, 50.0, 48000), tone_db(d, 15000.0, 48000));
            let (boost, flat) = if filter == EqFilter::LowShelf {
                (low, high)
            } else {
                (high, low)
            };
            assert!((boost - 12.0).abs() < 0.05);
            assert!(flat.abs() < 0.05);
        }
        for filter in [EqFilter::LowCut, EqFilter::HighCut] {
            d.bands[0].filter = filter;
            assert!((tone_db(d, 1000.0, 48000) + 3.0103).abs() < 0.03);
            let rejected = if filter == EqFilter::LowCut {
                50.0
            } else {
                15000.0
            };
            assert!(tone_db(d, rejected, 48000) < -40.0);
        }
    }

    #[test]
    fn bounds_and_all_sample_rates_have_stable_poles() {
        for sr in [
            8000, 16000, 22050, 24000, 44100, 48000, 96000, 192000, 384000,
        ] {
            for filter in [
                EqFilter::Bell,
                EqFilter::LowShelf,
                EqFilter::HighShelf,
                EqFilter::LowCut,
                EqFilter::HighCut,
            ] {
                for frequency in [20.0, 1000.0, 20000.0] {
                    for gain_db in [-18.0, 0.0, 18.0] {
                        for q in [0.1, 1.0, 12.0] {
                            let b = EqBand {
                                filter,
                                frequency,
                                gain_db,
                                q,
                                enabled: true,
                            };
                            let c = parametric_coefficients(b, sr);
                            assert!(
                                c.a2.abs() < 1.0
                                    && 1.0 + c.a1 + c.a2 > 0.0
                                    && 1.0 - c.a1 + c.a2 > 0.0,
                                "{b:?} at {sr}"
                            );
                            assert!([c.b0, c.b1, c.b2, c.a1, c.a2].iter().all(|v| v.is_finite()));
                        }
                    }
                }
            }
        }
        let mut d = data();
        for bad in [f32::NAN, f32::INFINITY, -1.0, 20001.0] {
            d.bands[0].frequency = bad;
            assert!(d.validate(48000).is_err());
        }
        d = data();
        d.bands[0].q = 0.0;
        assert!(d.validate(48000).is_err());
        d = data();
        d.bands[0].gain_db = 19.0;
        assert!(d.validate(48000).is_err());
        d = data();
        d.gains_db[0] = f32::INFINITY;
        assert!(d.validate(48000).is_err());
        assert!(serde_json::from_value::<EqData>(
            serde_json::json!({"mode":"parametric","bands":[]})
        )
        .is_err());
        let b = EqBand {
            frequency: 20000.0,
            ..data().bands[0]
        };
        let c = parametric_coefficients(b, 8000);
        let limited = parametric_coefficients(
            EqBand {
                frequency: 3920.0,
                ..b
            },
            8000,
        );
        assert_eq!(c.b0, limited.b0);
    }

    #[test]
    fn legacy_deserialization_and_audio_are_unchanged() {
        let gains = [-18.0, -9.0, 0.0, -2.0, -1.0, 0.0, 3.0, 2.0, 1.0, 0.0];
        let d: EqData = serde_json::from_value(serde_json::json!({"gainsDb":gains})).unwrap();
        assert_eq!(d.mode, EqMode::Graphic);
        assert!(d.validate(22050).is_err());
        for sr in [24000, 44100, 48000, 96000] {
            let (mut e, _) = EqEffect::new(d, sr);
            let mut reference = ChannelChain::new(sr);
            let linear = gains.map(db_to_linear);
            for n in 0..10000 {
                let x = if n == 0 {
                    1.0
                } else {
                    (n as f32 * 0.23).sin() * 0.1
                };
                let mut frame = [x, x];
                e.process(&mut frame, 1);
                assert_eq!(frame[0], reference.process(x, &linear));
            }
        }
    }

    #[test]
    fn live_updates_crossfade_without_first_sample_jump_and_converge() {
        let mut d = data();
        d.bands[0].frequency = 1000.0;
        let (mut e, c) = EqEffect::new(d, 48000);
        let mut baseline = EqEffect::new(d, 48000).0;
        for n in 0..2400 {
            let x = (n as f32 * 0.13).sin() * 0.1;
            e.process(&mut [x, x], 1);
            baseline.process(&mut [x, x], 1);
        }
        d.bands[0].gain_db = 18.0;
        let bands = serde_json::json!({"bands":d.bands.iter().map(|b|serde_json::json!({"frequency":b.frequency,"gainDb":b.gain_db,"q":b.q,"filter":"bell","enabled":true})).collect::<Vec<_>>()});
        c.apply_update(&bands);
        let mut frame = [0.1, 0.1];
        let mut unchanged = frame;
        e.process(&mut frame, 1);
        baseline.process(&mut unchanged, 1);
        assert_eq!(frame, unchanged);
        let abrupt = parametric_coefficients(d.bands[0], 48000).process_f64(0.1) as f32;
        assert!((abrupt - unchanged[0]).abs() > 0.005);
        for _ in 0..1000 {
            e.process(&mut [0.1, 0.1], 1);
        }
        assert_eq!(e.parametric.remaining, 0);
        assert_eq!(e.parametric.target, d.bands);
        let before = e.controls.load_bands();
        c.apply_update(&serde_json::json!({"bands":[]}));
        assert_eq!(e.controls.load_bands(), before);
    }

    #[test]
    fn tiny_gain_drag_preserves_settled_low_frequency_resonance() {
        let mut d = data();
        d.bands[0].frequency = 40.0;
        d.bands[0].q = 12.0;
        d.bands[0].gain_db = 18.0;
        let (mut e, control) = EqEffect::new(d, 48000);
        let tone =
            |n: usize| (2.0 * std::f64::consts::PI * 40.0 * n as f64 / 48000.0).sin() as f32 * 0.01;
        for n in 0..144000 {
            let x = tone(n);
            e.process(&mut [x, -x], 1);
        }
        d.bands[0].gain_db = 17.9;
        control.apply_update(&band_update(d.bands));
        let mut energy = 0.0_f64;
        let mut input = 0.0_f64;
        for n in 0..2400 {
            let x = tone(n);
            let mut frame = [x, -x];
            e.process(&mut frame, 1);
            assert_eq!(frame[0], -frame[1]);
            if n >= 1200 {
                energy += (frame[0] as f64).powi(2);
                input += (x as f64).powi(2);
            }
        }
        let db = 10.0 * (energy / input).log10();
        eprintln!("40 Hz / Q12 gain drag, 25–50 ms: {db:.6} dB (target 17.9 dB)");
        assert!((db - 17.9).abs() < 0.15, "25–50 ms level: {db} dB");
        for n in 2400..144000 {
            let x = tone(n);
            let mut frame = [x, -x];
            e.process(&mut frame, 1);
            if n >= 142800 {
                assert!((frame[0] - x * db_to_linear(17.9)).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn small_retunes_keep_history_across_rates_and_filter_bounds() {
        for sr in [8000, 48000, 384000] {
            let mut minimum = 1.0_f64;
            let mut maximum = 1.0_f64;
            for filter in [
                EqFilter::Bell,
                EqFilter::LowShelf,
                EqFilter::HighShelf,
                EqFilter::LowCut,
                EqFilter::HighCut,
            ] {
                for frequency in [20.0, 40.0, 1000.0, (sr as f32 * 0.49).min(20000.0)] {
                    for q in [0.1, 12.0] {
                        for gain_db in [-18.0, 18.0] {
                            let from = EqBand {
                                filter,
                                frequency,
                                q,
                                gain_db,
                                enabled: true,
                            };
                            let to = EqBand {
                                frequency: (frequency * 1.02).min(20000.0),
                                q: if q == 12.0 { q / 1.02 } else { q * 1.02 },
                                gain_db: gain_db - gain_db.signum() * 0.5,
                                ..from
                            };
                            let old = parametric_coefficients(from, sr);
                            let new = parametric_coefficients(to, sr);
                            assert!(
                                can_preserve_history(old, new, from, to),
                                "{from:?} -> {to:?} at {sr}"
                            );
                            let mut old = [ParametricBand::new(old); 2];
                            let mut new = [ParametricBand::new(new); 2];
                            let tone = |n: usize| {
                                let (s, c) =
                                    (2.0 * std::f64::consts::PI * frequency as f64 * n as f64
                                        / sr as f64)
                                        .sin_cos();
                                [s as f32 * 0.01, c as f32 * 0.01]
                            };
                            for n in 0..sr as usize * 3 {
                                for (ch, x) in tone(n).into_iter().enumerate() {
                                    old[ch].process(x as f64);
                                    new[ch].process(x as f64);
                                }
                            }
                            let mut bands = default_eq_bands();
                            bands[0] = from;
                            let mut e = Parametric::new(bands, sr);
                            for ch in 0..2 {
                                e.chains[e.active][ch][0] = old[ch];
                            }
                            bands[0] = to;
                            e.update(bands, sr);
                            for n in 0..sr as usize / 4 {
                                let mut frame = tone(sr as usize * 3 + n);
                                let mut before = [0.0; 2];
                                let mut after = [0.0; 2];
                                for ch in 0..2 {
                                    before[ch] = old[ch].process(frame[ch] as f64);
                                    after[ch] = new[ch].process(frame[ch] as f64);
                                }
                                e.process(&mut frame);
                                let level = (frame[0] as f64).hypot(frame[1] as f64);
                                let before = before[0].hypot(before[1]);
                                let after = after[0].hypot(after[1]);
                                minimum = minimum.min(level / before.min(after));
                                maximum = maximum.max(level / before.max(after));
                                assert!(level >= 0.85 * before.min(after) && level <= 1.15 * before.max(after),
                                    "{from:?} -> {to:?} at {sr}, frame {n}: {level} vs {before}/{after}");
                            }
                        }
                    }
                }
            }
            eprintln!("nearby retunes at {sr} Hz: envelope {minimum:.6}..{maximum:.6} relative to settled endpoints");
        }
        let from = EqBand {
            frequency: 3920.0,
            ..data().bands[0]
        };
        let to = EqBand {
            frequency: 3880.0,
            ..from
        };
        // A 1% frequency change this close to Nyquist moves the endpoint margin by over 2x.
        assert!(!can_preserve_history(
            parametric_coefficients(from, 8000),
            parametric_coefficients(to, 8000),
            from,
            to
        ));
    }

    #[test]
    fn large_retunes_do_not_amplify_inherited_state_into_impulses() {
        let from = EqBand {
            frequency: 40.0,
            gain_db: 18.0,
            q: 12.0,
            ..data().bands[0]
        };
        let changes = [
            EqBand {
                frequency: 20000.0,
                ..from
            },
            EqBand { q: 0.1, ..from },
            EqBand {
                gain_db: -18.0,
                ..from
            },
            EqBand {
                filter: EqFilter::LowShelf,
                ..from
            },
            EqBand {
                filter: EqFilter::HighShelf,
                ..from
            },
            EqBand {
                filter: EqFilter::LowCut,
                ..from
            },
            EqBand {
                filter: EqFilter::HighCut,
                ..from
            },
            EqBand {
                enabled: false,
                ..from
            },
        ];
        let high_cut = EqBand {
            frequency: 20000.0,
            filter: EqFilter::HighCut,
            ..from
        };
        let low_cut = EqBand {
            frequency: 20.0,
            ..high_cut
        };
        for sr in [8000, 48000, 384000] {
            let mut worst_peak = 0.0_f32;
            for (from, to) in changes
                .into_iter()
                .flat_map(|to| [(from, to), (to, from)])
                .chain([(high_cut, low_cut), (low_cut, high_cut)])
            {
                let mut bands = default_eq_bands();
                bands[0] = from;
                let mut e = Parametric::new(bands, sr);
                let frequency = from.frequency.min(sr as f32 * 0.49) as f64;
                let tone = |n: usize| {
                    let (s, c) =
                        (2.0 * std::f64::consts::PI * frequency * n as f64 / sr as f64).sin_cos();
                    [s as f32 * 0.01, c as f32 * 0.01]
                };
                for n in 0..sr as usize * 3 {
                    e.process(&mut tone(n));
                }
                let mut unchanged = tone(sr as usize * 3);
                for (ch, x) in unchanged.iter_mut().enumerate() {
                    *x = e.chains[e.active][ch].iter_mut().fold(*x as f64, |x, b| {
                        let mut copy = *b;
                        copy.process(x)
                    }) as f32;
                }
                bands[0] = to;
                e.update(bands, sr);
                let mut peak = 0.0_f32;
                for n in 0..sr as usize / 4 {
                    let mut frame = tone(sr as usize * 3 + n);
                    e.process(&mut frame);
                    if n == 0 {
                        assert_eq!(frame, unchanged);
                    }
                    for x in frame {
                        assert!(x.is_finite());
                        peak = peak.max(x.abs());
                    }
                }
                // Q=12 cutoff resonance reaches 0.12; allow 25% transient headroom.
                assert!(peak < 0.15, "{from:?} -> {to:?} at {sr}: peak {peak}");
                worst_peak = worst_peak.max(peak);
            }
            eprintln!("large retunes at {sr} Hz: peak {worst_peak:.6} (input 0.01)");
        }
    }

    #[test]
    fn rapid_retuning_is_finite_and_bounded() {
        for sr in [8000, 48000, 384000] {
            let d = data();
            let (mut e, c) = EqEffect::new(d, sr);
            for n in 0..500 {
                let mut bands = serde_json::json!({"bands":d.bands.iter().map(|b|serde_json::json!({"frequency":b.frequency,"gainDb":0,"q":1,"filter":"bell","enabled":true})).collect::<Vec<_>>()});
                bands["bands"][0] = serde_json::json!({"frequency":if n%2==0 {20.0}else{20000.0},"gainDb":if n%2==0 {-18}else{18},"q":if n%3==0 {0.1}else{12.0},"filter":(["bell","lowShelf","highShelf","lowCut","highCut"][n%5]),"enabled":n%7!=0});
                c.apply_update(&bands);
                let mut block = [0.0; 128];
                for (i, x) in block.iter_mut().enumerate() {
                    *x = ((n * 64 + i / 2) as f32 * 0.1).sin() * 0.01;
                }
                e.process(&mut block, 64);
                assert!(block.iter().all(|v| v.is_finite() && v.abs() < 100.0));
            }
            let mut silence = [0.0; 2048];
            for _ in 0..100 {
                e.process(&mut silence, 1024);
                silence.fill(0.0);
            }
        }
    }

    #[test]
    fn frontend_fixtures_match_dsp_coefficients() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../../tests/fixtures/eq-response.json"))
                .unwrap();
        for fixture in fixtures["parametric"].as_array().unwrap() {
            let band: EqBand = serde_json::from_value(fixture["band"].clone()).unwrap();
            let c = parametric_coefficients(band, fixture["sampleRate"].as_u64().unwrap() as u32);
            for (actual, expected) in [c.b0, c.b1, c.b2, c.a1, c.a2]
                .iter()
                .zip(fixture["coefficients"].as_array().unwrap())
            {
                assert!((actual - expected.as_f64().unwrap()).abs() < 1e-9);
            }
        }
    }
    #[test]
    fn legacy_graph_fixtures_match_measured_audio() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../../tests/fixtures/eq-response.json"))
                .unwrap();
        for f in fixtures["graphic"].as_array().unwrap() {
            let sr = f["sampleRate"].as_u64().unwrap() as u32;
            let freq = f["frequency"].as_f64().unwrap();
            let d: EqData =
                serde_json::from_value(serde_json::json!({"gainsDb":f["gainsDb"]})).unwrap();
            let (mut e, _) = EqEffect::new(d, sr);
            let mut energy = 0.0_f64;
            let mut input = 0.0_f64;
            for n in 0..sr / 2 {
                let x =
                    (2.0 * std::f64::consts::PI * freq * n as f64 / sr as f64).sin() as f32 * 0.01;
                let mut frame = [x, x];
                e.process(&mut frame, 1);
                if n >= sr / 4 {
                    energy += (frame[0] as f64).powi(2);
                    input += (x as f64).powi(2);
                }
            }
            let db = 10.0 * (energy / input).log10();
            assert!(
                (db - f["db"].as_f64().unwrap()).abs() < 0.025,
                "{sr} Hz, {freq} Hz: {db} vs {}",
                f["db"]
            );
        }
    }
    #[test]
    fn mode_and_rate_rebuilds_replace_controls_and_keep_bypass() {
        use super::super::{instantiate_effect, EffectRegistry};
        use crate::audio::graph::EffectSpec;
        let mut registry = EffectRegistry::new();
        let mut d = data();
        d.mode = EqMode::Graphic;
        d.bypassed = true;
        let first = instantiate_effect(
            &EffectSpec::Eq(d),
            "eq",
            48000,
            false,
            false,
            2,
            &mut registry,
        );
        assert!(first.bypass.load(Ordering::Relaxed));
        assert!(first.control.is_some());
        let reused = instantiate_effect(
            &EffectSpec::Eq(d),
            "eq",
            48000,
            false,
            false,
            2,
            &mut registry,
        );
        assert!(reused.control.is_none());
        assert!(Arc::ptr_eq(&first.bypass, &reused.bypass));
        d.mode = EqMode::Parametric;
        for sr in [48000, 8000] {
            let rebuilt =
                instantiate_effect(&EffectSpec::Eq(d), "eq", sr, false, false, 2, &mut registry);
            let Some(EffectControl::Eq { controls }) = rebuilt.control else {
                panic!("stale EQ controls");
            };
            assert_eq!(controls.mode, EqMode::Parametric);
            assert_eq!(controls.sample_rate, sr);
            assert!(Arc::ptr_eq(&first.bypass, &rebuilt.bypass));
        }
    }

    #[test]
    fn crossfade_limits_step_through_entire_transition() {
        let mut bands = default_eq_bands();
        bands[0].filter = EqFilter::LowShelf;
        bands[0].frequency = 20000.0;
        let mut e = Parametric::new(bands, 48000);
        for _ in 0..1024 {
            e.process(&mut [0.1, 0.1]);
        }
        bands[0].gain_db = 18.0;
        e.update(bands, 48000);
        let mut previous = 0.1_f32;
        let mut max_step = 0.0_f32;
        for _ in 0..2000 {
            let mut frame = [0.1, 0.1];
            e.process(&mut frame);
            max_step = max_step.max((frame[0] - previous).abs());
            previous = frame[0];
        }
        assert!(max_step < 0.002, "transition step {max_step}");
        assert!((previous - 0.1 * db_to_linear(18.0)).abs() < 1e-5);
    }
}
