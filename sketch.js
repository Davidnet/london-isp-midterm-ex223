// Meyda + p5.js audio visualisation.
// -----------------------------------------------------------------------------
// Each sound keeps the THREE Meyda features chosen for it, but renders them
// through a visual form that suits its character:
//
//   Ex2_sound1  "Ripple pond"     (dark, tonal, occasional events)
//       rms              -> concentric ring pulse (loudness breathing)
//       spectralFlux     -> emits an expanding ripple on each onset
//       spectralCentroid -> water hue, kept in a dark blue/violet band
//
//   Ex2_sound2  "Particle burst field"  (extremely dynamic; brightness swings)
//       spectralCentroid -> particle colour + brightness (dark -> hot)  [star]
//       rms              -> particle emission rate + size (quiet -> explosion)
//       spectralFlatness -> order vs chaos (tonal stream <-> noisy turbulence)
//
//   Ex2_sound3  "Spark shower"    (bright, high-pitched, rhythmic)
//       rms            -> spark size / brightness / shimmer density
//       spectralFlux   -> fires a burst of sparks on each onset (rhythm)
//       zcr            -> spark hue (its bright, high-frequency signature)
//
//   Kalte_Ohren  "Voice-controlled figure field"  (long remix; loud, rhythmic)
//       rms              -> figure size / pulse (loudness breathing, CV 0.54)
//       spectralFlux     -> spawns a burst of figures on each onset (CV 0.63)
//       spectralCentroid -> figure colour, dark -> hot (brightness swings, CV 0.50)
//     Voice commands (p5.speech):
//       black/white/red/blue/green      -> background colour
//       square/triangle/circle/pentagon -> figure shape
// -----------------------------------------------------------------------------

const SOUND_FILES = [
  "assets/Ex2_sound1.wav",
  "assets/Ex2_sound2.wav",
  "assets/Ex2_sound3.wav",
  "assets/Kalte_Ohren_(_Remix_).mp3",
];

const BUFFER = 512;            // Meyda analysis window
const MAX_PARTICLES = 700;
const MAX_SPARKS = 600;

let sounds = [];
let currentSound = null;
let currentIdx = 0;
let analyzer = null;

let raw = null;                // latest raw Meyda features
let prevSpectrum = null;       // previous amplitudeSpectrum, for deriving flux

// Smoothed, normalised features (0..1) so mappings stay stable/comparable.
let sm = { rms: 0, centroid: 0, flatness: 0, zcr: 0, flux: 0 };
let fluxMax = 1e-6;
let fluxBaseline = 0;
let spawnCooldown = 0;
let needsClear = true; // force one opaque wipe when the visual changes

// Per-visual particle stores.
let ripples = [];
let particles = [];
let sparks = [];
let figures = [];

const FEATURE_INFO = [
  ["rms → ring pulse", "spectralFlux → ripple", "spectralCentroid → dark hue"],
  ["spectralCentroid → particle colour", "rms → count & size", "spectralFlatness → chaos"],
  ["rms → spark size/brightness", "spectralFlux → burst", "zcr → hue"],
  ["rms → figure size", "spectralFlux → figure burst", "spectralCentroid → figure colour"],
];

// ---- voice control (p5.speech) ------------------------------------------------
// Active only for the Kalte_Ohren track: continuous recognition, restarted on
// end, scanning each utterance for the latest colour / shape keyword.

const VOICE_COLORS = {
  black: [0, 0, 8],
  white: [0, 0, 96],
  red:   [0, 85, 72],
  blue:  [225, 80, 68],
  green: [130, 70, 58],
};
const VOICE_SHAPES = ["square", "triangle", "circle", "pentagon"];

let speechRec = null;
let voiceState = { bg: "black", shape: "circle", lastCmd: "—", listening: false };

function preload() {
  sounds = SOUND_FILES.map((f) => loadSound(f));
}

function setup() {
  const cnv = createCanvas(900, 420);
  cnv.parent("sketch-holder");
  colorMode(HSB, 360, 100, 100, 1);
  updateLegend();

  document.getElementById("playBtn").addEventListener("click", play);
  document.getElementById("stopBtn").addEventListener("click", stop);
  // Keep the legend in sync with the selected sound, even before Play.
  document.getElementById("soundSelect").addEventListener("change", updateLegend);
}

function play() {
  userStartAudio(); // browser autoplay policy: resume on user gesture
  stop();

  currentIdx = parseInt(document.getElementById("soundSelect").value, 10);
  currentSound = sounds[currentIdx];
  currentSound.loop();

  ripples = [];
  particles = [];
  sparks = [];
  figures = [];
  fluxMax = 1e-6;
  fluxBaseline = 0;
  prevSpectrum = null;
  needsClear = true;

  createAnalyzer();
  updateLegend();

  // Voice control belongs to the Kalte_Ohren visual only.
  if (currentIdx === 3) startVoice();
}

function stop() {
  if (analyzer) {
    analyzer.stop();
    analyzer = null;
  }
  if (currentSound && currentSound.isPlaying()) currentSound.stop();
  raw = null;
  stopVoice();
}

// ---- voice control -------------------------------------------------------------

function startVoice() {
  if (!speechRec) {
    speechRec = new p5.SpeechRec("en-US", onSpeechResult);
    // Continuous mode still ends on silence/errors; restart while we want it on.
    speechRec.onEnd = () => {
      if (voiceState.listening) speechRec.start(true, false);
    };
    speechRec.onError = (e) => {
      console.log("p5.SpeechRec error:", e.error);
      // Don't fight the browser: a denied mic would make onEnd loop forever.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        voiceState.listening = false;
        updateVoiceChip();
      }
    };
  }
  voiceState.listening = true;
  speechRec.start(true, false); // continuous, no interim results
  updateVoiceChip();
}

function stopVoice() {
  voiceState.listening = false;
  if (speechRec) speechRec.stop();
  updateVoiceChip();
}

function onSpeechResult() {
  if (speechRec && speechRec.resultString) handleVoiceCommand(speechRec.resultString);
}

// Scan an utterance for keywords; the last one spoken wins per category.
function handleVoiceCommand(str) {
  for (const w of str.toLowerCase().split(/\s+/)) {
    if (VOICE_COLORS[w]) {
      voiceState.bg = w;
      voiceState.lastCmd = w;
    } else if (VOICE_SHAPES.includes(w)) {
      voiceState.shape = w;
      voiceState.lastCmd = w;
    }
  }
  updateVoiceChip();
}

function updateVoiceChip() {
  const el = document.getElementById("voiceChip");
  if (!el) return;
  el.classList.toggle("on", voiceState.listening);
  el.classList.toggle("off", !voiceState.listening);
  el.textContent = voiceState.listening
    ? `VOICE · ON — ${voiceState.lastCmd}`
    : "VOICE · OFF";
}

function createAnalyzer() {
  analyzer = Meyda.createMeydaAnalyzer({
    audioContext: getAudioContext(),
    source: currentSound.output, // p5.SoundFile output node
    bufferSize: BUFFER,
    // Meyda's built-in spectralFlux needs a previousSignal the streaming
    // analyzer doesn't supply, so we derive flux from amplitudeSpectrum.
    featureExtractors: [
      "rms",
      "spectralCentroid",
      "spectralFlatness",
      "zcr",
      "amplitudeSpectrum",
    ],
    callback: (f) => {
      const spec = f.amplitudeSpectrum;
      let flux = 0;
      if (prevSpectrum && spec && prevSpectrum.length === spec.length) {
        for (let i = 0; i < spec.length; i++) {
          const d = spec[i] - prevSpectrum[i];
          if (d > 0) flux += d; // rectified: only rising energy (onsets)
        }
      }
      if (spec) prevSpectrum = Float32Array.from(spec);
      f.spectralFlux = flux;
      raw = f;
    },
  });
  analyzer.start();
}

// ---- feature normalisation ---------------------------------------------------

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function updateFeatures() {
  if (!raw) return;

  const rmsN = clamp01((raw.rms || 0) / 0.3);
  // Meyda centroid is a spectral bin index (0 .. BUFFER/2); half-band spreads it.
  const centN = clamp01((raw.spectralCentroid || 0) / (BUFFER / 4));
  const flatN = clamp01(raw.spectralFlatness || 0);
  const zcrN = clamp01((raw.zcr || 0) / 120); // Meyda zcr is a crossing count
  const rawFlux = raw.spectralFlux || 0;

  fluxMax = Math.max(fluxMax * 0.999, rawFlux); // decay so it re-adapts
  const fluxN = clamp01(rawFlux / fluxMax);

  const a = 0.2; // smoothing
  sm.rms = lerp(sm.rms, rmsN, a);
  sm.centroid = lerp(sm.centroid, centN, a);
  sm.flatness = lerp(sm.flatness, flatN, a);
  sm.zcr = lerp(sm.zcr, zcrN, a);
  sm.flux = lerp(sm.flux, fluxN, a);

  // Onset detection for the flux-driven sounds (ripple + spark).
  fluxBaseline = lerp(fluxBaseline, fluxN, 0.05);
  if (spawnCooldown > 0) spawnCooldown--;
  const isSpike = fluxN > 0.18 && fluxN > fluxBaseline * 1.8 && spawnCooldown === 0;
  if (isSpike) {
    if (currentIdx === 0) emitRipple();
    else if (currentIdx === 2) emitSparkBurst();
    else if (currentIdx === 3) emitFigureBurst();
    spawnCooldown = 5;
  }
}

// ---- draw dispatch -----------------------------------------------------------

function draw() {
  updateFeatures();

  if (!raw) {
    background(0, 0, 8);
    fill(0, 0, 70);
    textAlign(CENTER, CENTER);
    textSize(16);
    text("Press Play to start the visualisation", width / 2, height / 2);
    return;
  }

  if (needsClear) {
    background(0, 0, 6); // wipe any residue from the previous visual
    needsClear = false;
  }

  if (currentIdx === 0) drawRipplePond();
  else if (currentIdx === 1) drawParticleField();
  else if (currentIdx === 2) drawSparkShower();
  else drawFigureField();

  drawReadout();
}

// ---- Sound 1: ripple pond ----------------------------------------------------

function emitRipple() {
  ripples.push({ r: 30, alpha: 0.9, hue: 245 + sm.centroid * 75 });
}

function drawRipplePond() {
  const hue = 245 + sm.centroid * 75; // 245..320 blues -> violets
  background(hue, 60, 10);            // dark water, tinted by brightness
  const cx = width / 2;
  const cy = height / 2;

  // Concentric rings breathing with loudness.
  noFill();
  for (let i = 1; i <= 5; i++) {
    const r = i * (26 + sm.rms * 55);
    stroke(hue, 55, 45 + i * 6, 0.5 - i * 0.07);
    strokeWeight(2);
    ellipse(cx, cy, r * 2);
  }

  // Central breathing disc (kept dark for this sound's identity).
  noStroke();
  fill(hue, 55, 28 + 42 * sm.rms, 0.55);
  ellipse(cx, cy, 60 + 150 * sm.rms);

  // Onset ripples travelling outward.
  noFill();
  for (let k = ripples.length - 1; k >= 0; k--) {
    const rp = ripples[k];
    rp.r += 3.2;
    rp.alpha -= 0.012;
    stroke(rp.hue, 60, 78, rp.alpha);
    strokeWeight(3);
    ellipse(cx, cy, rp.r * 2);
    if (rp.alpha <= 0 || rp.r > width) ripples.splice(k, 1);
  }
}

// ---- Sound 2: particle burst field ------------------------------------------

function emitParticle() {
  const cx = width / 2;
  const cy = height / 2;
  const angle = random(TWO_PI);
  const speed = 1 + sm.rms * 6;
  particles.push({
    x: cx + random(-8, 8),
    y: cy + random(-8, 8),
    vx: cos(angle) * speed,
    vy: sin(angle) * speed,
    hue: 200 + sm.centroid * 160, // dark cyan -> hot magenta
    bri: 35 + 60 * sm.centroid,
    size: 4 + sm.rms * 12,
    life: 1,
  });
}

function drawParticleField() {
  const hue = 200 + sm.centroid * 160;
  // Translucent overpaint = motion trails.
  noStroke();
  fill(hue, 70, 8, 0.18);
  rect(0, 0, width, height);

  const n = floor(sm.rms * 18); // rms drives emission rate
  for (let i = 0; i < n; i++) emitParticle();

  for (let k = particles.length - 1; k >= 0; k--) {
    const p = particles[k];
    // spectralFlatness -> turbulence: tonal = clean radial streams, noisy = chaos.
    const jitter = sm.flatness * 1.6;
    p.vx += random(-jitter, jitter);
    p.vy += random(-jitter, jitter);
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.975;
    p.vy *= 0.975;
    p.life -= 0.015;

    fill(p.hue % 360, 85, p.bri, p.life);
    ellipse(p.x, p.y, p.size * (0.4 + p.life));
    if (p.life <= 0) particles.splice(k, 1);
  }
  while (particles.length > MAX_PARTICLES) particles.shift();
}

// ---- Sound 3: spark shower ---------------------------------------------------

function makeSpark(x, y, speed) {
  const angle = random(TWO_PI);
  return {
    x,
    y,
    vx: cos(angle) * speed,
    vy: sin(angle) * speed,
    hue: 30 + sm.zcr * 90,        // amber -> yellow-green with high frequency
    size: 1 + sm.rms * 4,         // rms -> spark size
    life: 1,
  };
}

function emitSparkBurst() {
  const x = random(width * 0.15, width * 0.85);
  const y = random(height * 0.2, height * 0.6);
  const count = floor(12 + sm.rms * 34); // rms -> burst density
  for (let i = 0; i < count; i++) sparks.push(makeSpark(x, y, random(1, 4 + sm.rms * 6)));
}

function drawSparkShower() {
  // Dark sky with short trails for streaky sparks.
  noStroke();
  fill(0, 0, 4, 0.28);
  rect(0, 0, width, height);

  // Continuous shimmer so the always-bright sound keeps sparkling.
  const shimmer = floor(sm.rms * 6);
  for (let i = 0; i < shimmer; i++) {
    sparks.push(makeSpark(random(width), random(height * 0.7), random(0.5, 2)));
  }

  for (let k = sparks.length - 1; k >= 0; k--) {
    const s = sparks[k];
    s.x += s.vx;
    s.y += s.vy;
    s.vy += 0.14; // gravity -> shower
    s.life -= 0.02;

    stroke(s.hue, 90, 95, s.life);
    strokeWeight(s.size);
    line(s.x, s.y, s.x - s.vx * 1.6, s.y - s.vy * 1.6);
    if (s.life <= 0) sparks.splice(k, 1);
  }
  while (sparks.length > MAX_SPARKS) sparks.shift();
}

// ---- Kalte_Ohren: voice-controlled figure field --------------------------------

const MAX_FIGURES = 90;

function emitFigureBurst() {
  const count = floor(3 + sm.rms * 8); // louder onset -> bigger burst
  for (let i = 0; i < count; i++) {
    figures.push({
      x: random(width * 0.08, width * 0.92),
      y: random(height * 0.1, height * 0.9),
      base: 18 + sm.rms * 70,          // rms -> figure size
      hue: 200 + sm.centroid * 160,    // spectralCentroid -> dark cyan -> hot magenta
      rot: random(TWO_PI),
      vr: random(-0.03, 0.03),
      life: 1,
    });
  }
}

function drawFigureField() {
  const [h, s, b] = VOICE_COLORS[voiceState.bg];
  background(h, s, b); // voice-selected background colour

  // Figures must read on any background: dark fills on white, bright otherwise.
  const onLight = voiceState.bg === "white";

  for (let k = figures.length - 1; k >= 0; k--) {
    const fg = figures[k];
    fg.rot += fg.vr;
    fg.life -= 0.008;

    const size = fg.base * (0.6 + sm.rms * 0.9); // whole field pulses with loudness
    stroke(fg.hue % 360, 80, onLight ? 30 : 95, fg.life);
    strokeWeight(2);
    fill(fg.hue % 360, 75, onLight ? 45 : 80, fg.life * 0.55);
    drawFigure(voiceState.shape, fg.x, fg.y, size, fg.rot);
    if (fg.life <= 0) figures.splice(k, 1);
  }
  while (figures.length > MAX_FIGURES) figures.shift();
}

// Draw one figure of the voice-selected shape, centred on (x, y).
function drawFigure(shape, x, y, size, rot) {
  if (shape === "circle") {
    ellipse(x, y, size * 2);
    return;
  }
  const sides = shape === "triangle" ? 3 : shape === "square" ? 4 : 5;
  push();
  translate(x, y);
  rotate(rot);
  beginShape();
  for (let i = 0; i < sides; i++) {
    const a = -HALF_PI + (TWO_PI * i) / sides;
    vertex(cos(a) * size, sin(a) * size);
  }
  endShape(CLOSE);
  pop();
}

// ---- overlay -----------------------------------------------------------------

function drawReadout() {
  noStroke();
  // Opaque backing so the text stays crisp over the trail-based visuals.
  fill(0, 0, 6, 0.9);
  rect(6, 8, 188, 90);
  fill(0, 0, 100, 0.9);
  textAlign(LEFT, TOP);
  textSize(12);
  textFont("monospace");
  const lines = [
    `rms              ${sm.rms.toFixed(2)}`,
    `spectralCentroid ${sm.centroid.toFixed(2)}`,
    `spectralFlatness ${sm.flatness.toFixed(2)}`,
    `zcr              ${sm.zcr.toFixed(2)}`,
    `spectralFlux     ${sm.flux.toFixed(2)}`,
  ];
  lines.forEach((t, i) => text(t, 12, 12 + i * 16));
}

function updateLegend() {
  const el = document.getElementById("legend");
  if (!el) return;
  // Follow the dropdown so the legend reflects the selected sound immediately,
  // whether or not it is currently playing.
  const sel = document.getElementById("soundSelect");
  const idx = sel ? parseInt(sel.value, 10) : currentIdx;
  const name = SOUND_FILES[idx].split("/").pop();
  el.innerHTML =
    `<strong>${name}</strong> &mdash; ` +
    FEATURE_INFO[idx].map((t) => `<span>${t}</span>`).join("");
}
