/* =========================
 * New sprooto model
 * ========================= */

export const PROJECT_STEP_COUNT = 32;

export const MELODIC_SOUND_IDS = Object.freeze([
  "1", "2", "3", "4"
]);

export const RHYTHM_SOUND_IDS = Object.freeze([
  "a", "b", "c", "d"
]);

export const LFO_DEFAULTS = Object.freeze({
  target: "pitch",
  wave: "sine",
  depth: 0,
  rate: 25,
  syncMode: "free"
});

export const MELODIC_SOUND_DEFAULTS = Object.freeze({
  gain: 70,
  attack: 1,
  holdDecay: 0,
  filterCutoff: 0,
  filterResonance: 0,
  fmDepth: 0,
  fmRatio: 1,
  lfo1: LFO_DEFAULTS,
  lfo2: LFO_DEFAULTS
});

export const RHYTHM_SOUND_DEFAULTS = Object.freeze({
  gain: 70,
  noiseMix: 0,
  note: 0,
  attack: 1,
  holdDecay: 0,
  filterCutoff: 0,
  filterResonance: 0,
  lfo1: LFO_DEFAULTS,
  lfo2: LFO_DEFAULTS
});

export const MELODIC_STEP_DEFAULTS = Object.freeze({
  soundId: null,
  note: 0,

  /*
   * Chord is stored as a stable name (e.g. "maj7"), not a list index.
   * This keeps saved projects stable even if the chord list is reordered.
   */
  chord: "off",

  gain: 100,
  pan: 0,
  probability: 100,
  subPattern: -1,
  nudge: 0,
  strum: 0
});

export const RHYTHM_STEP_DEFAULTS = Object.freeze({
  soundId: null,
  note: 0,
  gain: 100,
  pan: 0,
  probability: 100,
  subPattern: -1,
  subProbability: 100,
  nudge: 0
});

const LFO_TARGETS = Object.freeze([
  "level",
  "pitch",
  "pan",
  "fm",
  "filter"
]);

const LFO_WAVES = Object.freeze([
  "sine",
  "triangle",
  "sawUp",
  "sawDown",
  "square",
  "random",
  "rise",
  "fall"
]);

function normalizeLfoTarget(target) {
  const value =
    String(target ?? "")
      .trim()
      .toLowerCase();

  const legacyMap = {
    gain: "level",
    lvl: "level",
    cutoff: "filter",
    fmdepth: "fm",
    fmd: "fm"
  };

  const normalized =
    legacyMap[value] ?? value;

  return LFO_TARGETS.includes(normalized)
    ? normalized
    : LFO_DEFAULTS.target;
}

function cloneLfo(source = null) {
  const value =
    source && typeof source === "object"
      ? source
      : {};

  const wave =
    typeof value.wave === "string" &&
    LFO_WAVES.includes(value.wave)
      ? value.wave
      : LFO_DEFAULTS.wave;

  return {
    target:
      normalizeLfoTarget(
        value.target
      ),

    wave,

    depth:
      Math.min(
        100,
        Math.max(
          0,
          Number.isFinite(Number(value.depth))
            ? Number(value.depth)
            : LFO_DEFAULTS.depth
        )
      ),

    /*
     * rate is stored as tenths of a Hz in free mode.
     * Keeping the existing storage unit preserves old projects:
     * 25 = 2.5Hz, 100 = 10Hz. New range extends to 1000 = 100Hz.
     */
    rate:
      Math.min(
        1000,
        Math.max(
          1,
          Number.isFinite(Number(value.rate))
            ? Number(value.rate)
            : LFO_DEFAULTS.rate
        )
      ),

    syncMode:
      value.syncMode === "bpm"
        ? "bpm"
        : "free"
  };
}

export function createMelodicSound(
  id = "1"
) {
  return {
    id: MELODIC_SOUND_IDS.includes(id)
      ? id
      : "1",

    name: `sound ${id}`,
    muted: false,
    solo: false,
    rsend: 0,

    gain:
      MELODIC_SOUND_DEFAULTS.gain,
    attack:
      MELODIC_SOUND_DEFAULTS.attack,
    holdDecay:
      MELODIC_SOUND_DEFAULTS.holdDecay,
    filterCutoff:
      MELODIC_SOUND_DEFAULTS.filterCutoff,
    filterResonance:
      MELODIC_SOUND_DEFAULTS.filterResonance,
    fmDepth:
      MELODIC_SOUND_DEFAULTS.fmDepth,
    fmRatio:
      MELODIC_SOUND_DEFAULTS.fmRatio,

    lfo1: cloneLfo(),
    lfo2: cloneLfo()
  };
}

export function createRhythmSound(
  id = "a"
) {
  return {
    id: RHYTHM_SOUND_IDS.includes(id)
      ? id
      : "a",

    name: `sound ${id}`,
    muted: false,
    solo: false,
    rsend: 0,

    gain:
      RHYTHM_SOUND_DEFAULTS.gain,
    noiseMix:
      RHYTHM_SOUND_DEFAULTS.noiseMix,
    note:
      RHYTHM_SOUND_DEFAULTS.note,
    attack:
      RHYTHM_SOUND_DEFAULTS.attack,
    holdDecay:
      RHYTHM_SOUND_DEFAULTS.holdDecay,
    filterCutoff:
      RHYTHM_SOUND_DEFAULTS.filterCutoff,
    filterResonance:
      RHYTHM_SOUND_DEFAULTS.filterResonance,

    lfo1: cloneLfo(),
    lfo2: cloneLfo()
  };
}

export function createMelodicStep(
  soundId = null
) {
  const step =
    structuredClone(
      MELODIC_STEP_DEFAULTS
    );

  step.soundId =
    MELODIC_SOUND_IDS.includes(
      String(soundId)
    )
      ? String(soundId)
      : null;

  return step;
}

export function createRhythmStep(
  soundId = null
) {
  const step =
    structuredClone(
      RHYTHM_STEP_DEFAULTS
    );

  step.soundId =
    RHYTHM_SOUND_IDS.includes(
      String(soundId)
    )
      ? String(soundId)
      : null;

  return step;
}

export function createSequenceStep() {
  return {
    melodic: createMelodicStep(),
    rhythm: createRhythmStep()
  };
}

export function createPatternSequence() {
  return Array.from(
    { length: PROJECT_STEP_COUNT },
    () => createSequenceStep()
  );
}

export function createProjectSoundBank() {
  return {
    melodic: Object.fromEntries(
      MELODIC_SOUND_IDS.map(id => [
        id,
        createMelodicSound(id)
      ])
    ),

    rhythm: Object.fromEntries(
      RHYTHM_SOUND_IDS.map(id => [
        id,
        createRhythmSound(id)
      ])
    )
  };
}

export function normalizeMelodicSound(
  sound,
  id = "1"
) {
  const source =
    sound && typeof sound === "object"
      ? sound
      : {};

  const normalized =
    createMelodicSound(id);

  [
    "name",
    "rsend",
    "gain",
    "attack",
    "holdDecay",
    "filterCutoff",
    "filterResonance",
    "fmDepth",
    "fmRatio"
  ].forEach(key => {
    if (!(key in source)) return;
    normalized[key] =
      structuredClone(source[key]);
  });

  normalized.muted =
    Boolean(source.muted);
  normalized.solo =
    Boolean(source.solo);
  normalized.rsend =
    Math.min(100, Math.max(0, Math.round(Number(normalized.rsend) || 0)));
  normalized.lfo1 =
    cloneLfo(source.lfo1);
  normalized.lfo2 =
    cloneLfo(source.lfo2);

  return normalized;
}

export function normalizeRhythmSound(
  sound,
  id = "a"
) {
  const source =
    sound && typeof sound === "object"
      ? sound
      : {};

  const normalized =
    createRhythmSound(id);

  [
    "name",
    "rsend",
    "gain",
    "noiseMix",
    "note",
    "attack",
    "holdDecay",
    "filterCutoff",
    "filterResonance"
  ].forEach(key => {
    if (!(key in source)) return;
    normalized[key] =
      structuredClone(source[key]);
  });

  normalized.muted =
    Boolean(source.muted);
  normalized.solo =
    Boolean(source.solo);
  normalized.rsend =
    Math.min(100, Math.max(0, Math.round(Number(normalized.rsend) || 0)));
  normalized.lfo1 =
    cloneLfo(source.lfo1);
  normalized.lfo2 =
    cloneLfo(source.lfo2);

  return normalized;
}


export function normalizeProjectSoundBank(
  bank
) {
  const source =
    bank &&
    typeof bank === "object"
      ? bank
      : {};

  return {
    melodic:
      Object.fromEntries(
        MELODIC_SOUND_IDS.map(
          id => [
            id,
            normalizeMelodicSound(
              source.melodic?.[id],
              id
            )
          ]
        )
      ),

    rhythm:
      Object.fromEntries(
        RHYTHM_SOUND_IDS.map(
          id => [
            id,
            normalizeRhythmSound(
              source.rhythm?.[id],
              id
            )
          ]
        )
      )
  };
}

export function normalizeMelodicStep(
  step
) {
  const source =
    step &&
    typeof step === "object"
      ? step
      : {};

  const normalized =
    createMelodicStep(
      source.soundId
    );

  [
    "note",
    "chord",
    "gain",
    "pan",
    "probability",
    "subPattern",
    "nudge",
    "strum"
  ].forEach(key => {
    if (!(key in source)) {
      return;
    }

    normalized[key] =
      structuredClone(
        source[key]
      );
  });

  return normalized;
}

export function normalizeRhythmStep(
  step
) {
  const source =
    step &&
    typeof step === "object"
      ? step
      : {};

  const normalized =
    createRhythmStep(
      source.soundId
    );

  [
    "note",
    "gain",
    "pan",
    "probability",
    "subPattern",
    "subProbability",
    "nudge"
  ].forEach(key => {
    if (!(key in source)) {
      return;
    }

    normalized[key] =
      structuredClone(
        source[key]
      );
  });

  return normalized;
}

export function normalizeSequenceStep(
  step
) {
  const source =
    step &&
    typeof step === "object"
      ? step
      : {};

  return {
    melodic:
      normalizeMelodicStep(
        source.melodic
      ),

    rhythm:
      normalizeRhythmStep(
        source.rhythm
      )
  };
}

/* =========================
 * Legacy sprooto compatibility
 *
 * sequencer.js / ui.js / audio.jsを
 * 新モデルへ載せ替えるまでだけ残す。
 * 新コードでは使用しない。
 * ========================= */

export const SOUND_BASE_DEFAULTS = Object.freeze({
  note: 0,
  chord: 0,
  voices: 4,
  inversion: 0,
  sineVolume: 100,
  velocity: 70,
  attack: 1,
  holdDecay: 0,
  fmDepth: 0,
  fmRatio: 1,
  fmFeedback: 0,
  filterCutoff: 0,
  filterResonance: 0,
  pan: 0,
  probability: 100,
  subPattern: -1,
  subCrescendo: 0,
  subProbability: 100,
  glide: 0,
  nudge: 0,
  strum: 0,
  lfo1Target: "pitch",
  lfo1Wave: "sine",
  lfo1Depth: 0,
  lfo1Rate: 25,
  lfo1SyncMode: "free",
  lfo2Target: "pitch",
  lfo2Wave: "sine",
  lfo2Depth: 0,
  lfo2Rate: 25,
  lfo2SyncMode: "free"
});

export const SOUND_OFFSET_IDS = Object.freeze([
  "note", "chord", "voices", "inversion",
  "attack", "holdDecay",
  "sineVolume",
  "fmDepth", "fmRatio", "fmFeedback",
  "filterCutoff", "filterResonance", "pan",
  "probability",
  "subPattern", "subCrescendo", "subProbability",
  "glide", "nudge", "strum",
  "lfo1Depth", "lfo1Rate", "lfo2Depth", "lfo2Rate"
]);

const LEGACY_STEP_COUNT = 64;

function zeroOffsets() {
  return Object.fromEntries(
    SOUND_OFFSET_IDS.map(id => [
      id,
      Array(LEGACY_STEP_COUNT).fill(0)
    ])
  );
}

export function createDefaultSound() {
  return {
    base:
      structuredClone(
        SOUND_BASE_DEFAULTS
      ),

    offsets:
      zeroOffsets(),

    envelopeSelectedId:
      "holdDecay",

    articulationSelectedId:
      "glide",

    lfoSelected: 1
  };
}

export function normalizeSound(sound) {
  const source =
    sound && typeof sound === "object"
      ? sound
      : {};

  const normalized =
    createDefaultSound();

  if (
    source.base &&
    typeof source.base === "object"
  ) {
    Object.keys(
      SOUND_BASE_DEFAULTS
    ).forEach(id => {
      if (!(id in source.base)) {
        return;
      }

      normalized.base[id] =
        structuredClone(
          source.base[id]
        );
    });
  }

  if (
    source.offsets &&
    typeof source.offsets === "object"
  ) {
    SOUND_OFFSET_IDS.forEach(id => {
      const values =
        source.offsets[id];

      if (!Array.isArray(values)) {
        return;
      }

      normalized.offsets[id] =
        Array.from(
          {
            length:
              LEGACY_STEP_COUNT
          },
          (_, index) =>
            Number(
              values[index]
            ) || 0
        );
    });
  }

  if (
    [
      "attack",
      "holdDecay"
    ].includes(
      source.envelopeSelectedId
    )
  ) {
    normalized.envelopeSelectedId =
      source.envelopeSelectedId;
  }

  if (
    [
      "glide",
      "nudge",
      "strum"
    ].includes(
      source.articulationSelectedId
    )
  ) {
    normalized.articulationSelectedId =
      source.articulationSelectedId;
  }

  normalized.lfoSelected =
    source.lfoSelected === 2
      ? 2
      : 1;

  return normalized;
}
