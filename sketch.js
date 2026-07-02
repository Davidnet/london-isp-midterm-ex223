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
//     Voice commands (p5.speech), active for EVERY visual as an override layer:
//       black/white/red/blue/green      -> background colour
//       square/triangle/circle/pentagon -> shape of the generated figures
//       play / stop / next / "sound one..four" -> transport & track switching
//       louder / quieter                -> volume steps
//       faster / slower                 -> playback rate (pitch + speed warp)
//       bigger / smaller                -> figure scale multiplier
//       trails / clean                  -> force/remove motion-trail overpaint
//       invert                          -> flip background brightness
//       reset                           -> clear every voice override
//     Until a command is spoken each visual keeps its native look.
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
// Continuous recognition, restarted on end, scanning each utterance for the
// latest colour / shape keyword. Applies to every visual: bg/shape stay null
// (native look) until spoken.

const VOICE_COLORS = {
  black: [0, 0, 8],
  white: [0, 0, 96],
  red:   [0, 85, 72],
  blue:  [225, 80, 68],
  green: [130, 70, 58],
};
const VOICE_SHAPES = ["square", "triangle", "circle", "pentagon"];

// Spoken numbers for "sound one..four" (with common recognizer homophones).
const NUMBER_WORDS = {
  one: 0, won: 0, "1": 0,
  two: 1, to: 1, too: 1, "2": 1,
  three: 2, "3": 2,
  four: 3, for: 3, "4": 3,
};

let speechRec = null;
let voiceState = {
  bg: null,        // background colour override (null = native)
  shape: null,     // figure shape override (null = native)
  scale: 1,        // bigger/smaller multiplier on generated figures
  trails: null,    // trails/clean override (null = each visual's native wipe)
  invert: false,   // flip background brightness; elements adapt for contrast
  lastCmd: "—",
  listening: false,
};
let voiceVolume = 1;
let voiceRate = 1;

let bgIsBright = false; // set on every backdrop paint; drives contrast dimming
const onLightBg = () => bgIsBright;

// Backdrop for every visual. Voice colour overrides the native one, "invert"
// flips its brightness, and "trails"/"clean" force a translucent or opaque
// wipe. nativeAlpha is the visual's own overpaint alpha (1 = solid clear).
function paintBackdrop(h, s, b, nativeAlpha) {
  let c = voiceState.bg ? VOICE_COLORS[voiceState.bg] : [h, s, b];
  if (voiceState.invert) c = [c[0], c[1], 100 - c[2]];
  bgIsBright = c[2] > 55;

  let alpha = nativeAlpha;
  if (voiceState.trails === true) alpha = Math.min(alpha, 0.18);
  else if (voiceState.trails === false) alpha = 1;

  noStroke();
  fill(c[0], c[1], c[2], alpha);
  rect(0, 0, width, height);
}

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
  applyPlayback(); // keep the voice-set volume/rate across track changes

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

  // Voice control is available for every visual.
  startVoice();
}

function stop() {
  if (analyzer) {
    analyzer.stop();
    analyzer = null;
  }
  if (currentSound && currentSound.isPlaying()) currentSound.stop();
  raw = null;
  // Voice keeps listening after Stop so "play" still works hands-free.
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
  try {
    speechRec.start(true, false); // continuous, no interim results
  } catch (e) {
    // Already running (e.g. Play pressed again before the async stop landed):
    // fine — the onEnd handler keeps it alive while listening is true.
  }
  updateVoiceChip();
}

function onSpeechResult() {
  if (speechRec && speechRec.resultString) handleVoiceCommand(speechRec.resultString);
}

// -- transport helpers driven by voice --

function voicePlay() {
  if (!currentSound || !currentSound.isPlaying()) play();
}

// Switch track by POSITION (dropdown index), keeping the UI in sync.
function voiceSwitchTo(idx) {
  const sel = document.getElementById("soundSelect");
  sel.value = String(idx);
  sel.dispatchEvent(new Event("change")); // legend follows, as with a manual pick
  play();
}

function applyPlayback() {
  if (!currentSound) return;
  currentSound.setVolume(voiceVolume);
  currentSound.rate(voiceRate);
}

function voiceReset() {
  voiceState.bg = null;
  voiceState.shape = null;
  voiceState.scale = 1;
  voiceState.trails = null;
  voiceState.invert = false;
  voiceVolume = 1;
  voiceRate = 1;
  applyPlayback();
}

// Scan an utterance for keywords; later words win within a category.
function handleVoiceCommand(str) {
  const words = str.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  let heard = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (VOICE_COLORS[w]) { voiceState.bg = w; heard = w; }
    else if (VOICE_SHAPES.includes(w)) { voiceState.shape = w; heard = w; }
    // transport
    else if (w === "play") { voicePlay(); heard = w; }
    else if (w === "stop") { stop(); heard = w; }
    else if (w === "next") { voiceSwitchTo((currentIdx + 1) % SOUND_FILES.length); heard = w; }
    else if ((w === "sound" || w === "track" || w === "song") &&
             NUMBER_WORDS[words[i + 1]] !== undefined) {
      const n = NUMBER_WORDS[words[i + 1]];
      voiceSwitchTo(n);
      heard = `sound ${n + 1}`;
      i++; // consume the number word
    }
    // volume & speed
    else if (w === "louder") { voiceVolume = Math.min(1, voiceVolume + 0.2); applyPlayback(); heard = w; }
    else if (w === "quieter") { voiceVolume = Math.max(0.1, voiceVolume - 0.2); applyPlayback(); heard = w; }
    else if (w === "faster") { voiceRate = Math.min(2, voiceRate * 1.25); applyPlayback(); heard = w; }
    else if (w === "slower") { voiceRate = Math.max(0.5, voiceRate / 1.25); applyPlayback(); heard = w; }
    // figure & effect overrides
    else if (w === "bigger") { voiceState.scale = Math.min(3, voiceState.scale * 1.3); heard = w; }
    else if (w === "smaller") { voiceState.scale = Math.max(0.4, voiceState.scale / 1.3); heard = w; }
    else if (w === "trails") { voiceState.trails = true; heard = w; }
    else if (w === "clean") { voiceState.trails = false; heard = w; }
    else if (w === "invert") { voiceState.invert = !voiceState.invert; heard = w; }
    else if (w === "reset") { voiceReset(); heard = w; }
  }
  if (heard) voiceState.lastCmd = heard;
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
  const hue = 245 + sm.centroid * 75;   // 245..320 blues -> violets
  paintBackdrop(hue, 60, 10, 1);        // dark water unless voice overrides
  const light = onLightBg();
  const shape = voiceState.shape || "circle";
  const cx = width / 2;
  const cy = height / 2;

  // Concentric rings breathing with loudness.
  noFill();
  for (let i = 1; i <= 5; i++) {
    const r = i * (26 + sm.rms * 55);
    stroke(hue, 55, light ? 30 : 45 + i * 6, 0.5 - i * 0.07);
    strokeWeight(2);
    drawFigure(shape, cx, cy, r, 0);
  }

  // Central breathing disc (kept dark for this sound's identity).
  noStroke();
  fill(hue, 55, 28 + 42 * sm.rms, 0.55);
  drawFigure(shape, cx, cy, 30 + 75 * sm.rms, 0);

  // Onset ripples travelling outward.
  noFill();
  for (let k = ripples.length - 1; k >= 0; k--) {
    const rp = ripples[k];
    rp.r += 3.2;
    rp.alpha -= 0.012;
    stroke(rp.hue, 60, light ? 35 : 78, rp.alpha);
    strokeWeight(3);
    drawFigure(shape, cx, cy, rp.r, 0);
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
    rot: random(TWO_PI),          // only visible when voice picks a polygon shape
    life: 1,
  });
}

function drawParticleField() {
  const hue = 200 + sm.centroid * 160;
  // Translucent overpaint = motion trails (voice colour/trails override).
  paintBackdrop(hue, 70, 8, 0.18);
  const light = onLightBg();
  const shape = voiceState.shape || "circle";

  const n = floor(sm.rms * 18); // rms drives emission rate
  for (let i = 0; i < n; i++) emitParticle();

  noStroke();
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

    fill(p.hue % 360, 85, light ? Math.min(p.bri, 45) : p.bri, p.life);
    drawFigure(shape, p.x, p.y, (p.size * (0.4 + p.life)) / 2, p.rot);
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
  // Dark sky with short trails for streaky sparks (voice colour/trails override).
  paintBackdrop(0, 0, 4, 0.28);
  const light = onLightBg();

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

    const bri = light ? 35 : 95;
    if (voiceState.shape) {
      // Voice picked a figure: draw sparks as tiny tumbling figures.
      noStroke();
      fill(s.hue, 90, bri, s.life);
      drawFigure(voiceState.shape, s.x, s.y, s.size * 2.2, atan2(s.vy, s.vx));
    } else {
      // Native look: streaky line sparks ("bigger"/"smaller" scale them too).
      stroke(s.hue, 90, bri, s.life);
      strokeWeight(s.size * voiceState.scale);
      const st = 1.6 * voiceState.scale;
      line(s.x, s.y, s.x - s.vx * st, s.y - s.vy * st);
    }
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
  paintBackdrop(0, 0, 8, 1); // black by default, voice-selected colour otherwise
  const shape = voiceState.shape || "circle";

  // Figures must read on any background: dark fills on white, bright otherwise.
  const onLight = onLightBg();

  for (let k = figures.length - 1; k >= 0; k--) {
    const fg = figures[k];
    fg.rot += fg.vr;
    fg.life -= 0.008;

    const size = fg.base * (0.6 + sm.rms * 0.9); // whole field pulses with loudness
    stroke(fg.hue % 360, 80, onLight ? 30 : 95, fg.life);
    strokeWeight(2);
    fill(fg.hue % 360, 75, onLight ? 45 : 80, fg.life * 0.55);
    drawFigure(shape, fg.x, fg.y, size, fg.rot);
    if (fg.life <= 0) figures.splice(k, 1);
  }
  while (figures.length > MAX_FIGURES) figures.shift();
}

// Draw one figure of the voice-selected shape, centred on (x, y).
// All generated figures pass through here, so "bigger"/"smaller" scale globally.
function drawFigure(shape, x, y, size, rot) {
  size *= voiceState.scale;
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
  rect(6, 8, 188, 106);
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
    `vol ${voiceVolume.toFixed(2)}   rate ${voiceRate.toFixed(2)}`,
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
