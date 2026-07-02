import librosa
import numpy as np

FILES = ["assets/Ex2_sound1.wav", "assets/Ex2_sound2.wav", "assets/Ex2_sound3.wav"]

# Meyda default: bufferSize 512. Match that framing for comparable numbers.
FRAME = 512
HOP = 512


def summarize(name, x):
    """Return low-numbers about how much a per-frame feature changes over time."""
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return f"    {name:24s} (empty)"
    mean = x.mean()
    std = x.std()
    # coefficient of variation = how dramatically it swings relative to its level
    cv = std / (abs(mean) + 1e-9)
    rng = x.max() - x.min()
    return f"    {name:24s} mean={mean:9.3f}  std={std:9.3f}  range={rng:9.3f}  CV={cv:5.2f}"


for f in FILES:
    y, sr = librosa.load(f, sr=None, mono=True)
    dur = len(y) / sr

    S = np.abs(librosa.stft(y, n_fft=FRAME, hop_length=HOP)) + 1e-10

    rms = librosa.feature.rms(y=y, frame_length=FRAME, hop_length=HOP)[0]
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]        # brightness
    rolloff = librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=0.85)[0]
    flatness = librosa.feature.spectral_flatness(S=S)[0]              # tonal vs noisy
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=FRAME, hop_length=HOP)[0]
    bandwidth = librosa.feature.spectral_bandwidth(S=S, sr=sr)[0]
    flux = np.sqrt(np.sum(np.diff(S, axis=1) ** 2, axis=0))            # spectral change/onsets

    print("=" * 78)
    print(f"{f}   sr={sr} Hz   duration={dur:.2f}s   frames={S.shape[1]}")
    print("-" * 78)
    print(summarize("RMS (loudness)", rms))
    print(summarize("Spectral centroid Hz", centroid))
    print(summarize("Spectral rolloff Hz", rolloff))
    print(summarize("Spectral flatness", flatness))
    print(summarize("Zero-crossing rate", zcr))
    print(summarize("Spectral bandwidth Hz", bandwidth))
    print(summarize("Spectral flux", flux))
print("=" * 78)
