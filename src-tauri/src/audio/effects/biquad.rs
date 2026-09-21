/// RBJ cookbook biquad in Transposed Direct Form II — one state pair (z1, z2)
/// per channel, half the rounding noise of DF I.
#[derive(Clone, Copy, Default)]
pub struct Biquad<T = f32> {
    pub b0: T,
    pub b1: T,
    pub b2: T,
    pub a1: T,
    pub a2: T,
    z1: T,
    z2: T,
}

// Low-frequency, high-Q sections at 384 kHz need double precision poles.
impl Biquad<f64> {
    pub(super) fn normalized(b: [f64; 3], a: [f64; 3]) -> Self {
        Self {
            b0: b[0] / a[0],
            b1: b[1] / a[0],
            b2: b[2] / a[0],
            a1: a[1] / a[0],
            a2: a[2] / a[0],
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub(super) fn process_f64(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

impl Biquad {
    /// Copy another biquad's coefficients while keeping this one's state — lets a
    /// filter be retuned live without a discontinuity.
    #[inline]
    pub(super) fn retune(&mut self, c: Biquad) {
        self.b0 = c.b0;
        self.b1 = c.b1;
        self.b2 = c.b2;
        self.a1 = c.a1;
        self.a2 = c.a2;
    }

    #[inline]
    pub(super) fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

#[derive(Clone, Copy)]
pub enum BandShape {
    Lpf,
    Hpf,
}

/// RBJ cookbook coefficients.
pub fn biquad_for(shape: BandShape, freq_hz: f32, q: f32, sample_rate: u32) -> Biquad {
    let fs = sample_rate as f32;
    let w0 = 2.0 * std::f32::consts::PI * (freq_hz.max(1.0) / fs);
    let (sinw, cosw) = (w0.sin(), w0.cos());
    let q = q.max(0.05);
    let alpha = sinw / (2.0 * q);

    let (b0, b1, b2, a0, a1, a2) = match shape {
        BandShape::Lpf => (
            (1.0 - cosw) * 0.5,
            1.0 - cosw,
            (1.0 - cosw) * 0.5,
            1.0 + alpha,
            -2.0 * cosw,
            1.0 - alpha,
        ),
        BandShape::Hpf => (
            (1.0 + cosw) * 0.5,
            -(1.0 + cosw),
            (1.0 + cosw) * 0.5,
            1.0 + alpha,
            -2.0 * cosw,
            1.0 - alpha,
        ),
    };
    let inv = 1.0 / a0;
    Biquad {
        b0: b0 * inv,
        b1: b1 * inv,
        b2: b2 * inv,
        a1: a1 * inv,
        a2: a2 * inv,
        z1: 0.0,
        z2: 0.0,
    }
}
