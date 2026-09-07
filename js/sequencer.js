import {
  createProjectSoundBank,
  createPatternSequence,
  createSequenceStep,
  createMelodicStep,
  createRhythmStep,
  normalizeProjectSoundBank,
  normalizeSequenceStep
} from "./sound-defaults.js";

export const STEP_COUNT = 32;
export const PAGE_STEP_COUNT = 32;
export const PATTERN_SLOT_COUNT = 40;

export const MELODIC_SOUND_IDS = Object.freeze(["1", "2", "3", "4"]);
export const RHYTHM_SOUND_IDS = Object.freeze(["a", "b", "c", "d"]);

export const CHORD_NAMES = Object.freeze([
  // 1 VOICE
  "off",

  // 2 VOICE
  "1-2",
  "5th",

  // 3 VOICE
  "maj",
  "min",
  "aug",
  "dim",
  "♭5",
  "sus2",
  "sus4",

  // 4 VOICE / basic
  "7",
  "maj7",
  "m7",
  "mMaj7",
  "6",
  "m6",
  "m7♭5",
  "dim7",
  "7sus4",
  "maj7sus2",

  // 4 VOICE / 9
  "9",
  "maj9",
  "m9",
  "mMaj9",
  "6/9",
  "m6/9",
  "9sus4",
  "7♭9",
  "7♯9",
  "aug♭9",
  "aug♯9",
  "m7♭5(9)",
  "1-♭5-6-9",

  // 4 VOICE / special
  "m7♯5",

  // 4 VOICE / 11-13
  "11",
  "sus7(13)",
  "7♭13"
]);

/*
 * Chord storage is now versioned.
 * New snapshots always store chord names, never list indexes.
 *
 * LEGACY_NUMERIC_CHORD_NAMES_V0 is frozen permanently: it represents the
 * numeric-index layout used immediately before name-based persistence was
 * introduced. Never derive migration from the live CHORD_NAMES array again.
 */
export const CHORD_STORAGE_SCHEMA = "name-v1";

const LEGACY_NUMERIC_CHORD_NAMES_V0 = Object.freeze([
  "off",
  "1-2",
  "5th",
  "maj",
  "min",
  "aug",
  "dim",
  "♭5",
  "sus2",
  "sus4",
  "7",
  "maj7",
  "m7",
  "mMaj7",
  "6",
  "m6",
  "m7♭5",
  "dim7",
  "7sus4",
  "maj7sus2",
  "9",
  "maj9",
  "m9",
  "mMaj9",
  "6/9",
  "m6/9",
  "9sus4",
  "7♭9",
  "7♯9",
  "aug♭9",
  "aug♯9",
  "m7♭5(9)",
  "1-♭5-6-9",
  "m7♯5",
  "11",
  "sus7(13)",
  "7♭13"
]);

const CHORD_DEFINITIONS = Object.freeze([
  // 1 VOICE
  [0],

  // 2 VOICE
  [0, 2],
  [0, 7],

  // 3 VOICE
  [0, 4, 7],      // maj
  [0, 3, 7],      // min
  [0, 4, 8],      // aug
  [0, 3, 6],      // dim
  [0, 4, 6],      // ♭5 = 1-3-♭5
  [0, 2, 7],      // sus2
  [0, 5, 7],      // sus4

  // 4 VOICE / basic
  [0, 4, 7, 10],  // 7
  [0, 4, 7, 11],  // maj7
  [0, 3, 7, 10],  // m7
  [0, 3, 7, 11],  // mMaj7
  [0, 4, 7, 9],   // 6
  [0, 3, 7, 9],   // m6
  [0, 3, 6, 10],  // m7♭5
  [0, 3, 6, 9],   // dim7
  [0, 5, 7, 10],  // 7sus4
  [0, 2, 7, 11],  // maj7sus2

  // 4 VOICE / 9
  [0, 4, 10, 14], // 9
  [0, 4, 11, 14], // maj9
  [0, 3, 10, 14], // m9
  [0, 3, 11, 14], // mMaj9
  [0, 4, 9, 14],  // 6/9
  [0, 3, 9, 14],  // m6/9
  [0, 5, 10, 14], // 9sus4
  [0, 4, 10, 13], // 7♭9
  [0, 4, 10, 15], // 7♯9
  [0, 4, 8, 13],  // aug♭9
  [0, 4, 8, 15],  // aug♯9
  [0, 6, 10, 14], // m7♭5(9)
  [0, 6, 9, 14],  // 1-♭5-6-9

  // 4 VOICE / special
  [0, 8, 10, 15], // m7♯5 = 1-♯5-♭7-♭3↑

  // 4 VOICE / 11-13
  [0, 7, 10, 17], // 11 = 1-5-♭7-11
  [0, 10, 17, 21],// sus7(13) = 1-♭7-11-13
  [0, 10, 16, 20] // 7♭13 = 1-♭7-3↑-♭13
]);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/*
 * Compatibility helper for audio.js while chord UI/data is redesigned.
 */
export function resolveChordNoteOffsets(chordValue) {
  let index = 0;

  if (typeof chordValue === "string") {
    const namedIndex = CHORD_NAMES.indexOf(chordValue);
    index = namedIndex >= 0 ? namedIndex : 0;
  } else {
    index = clamp(
      Math.round(Number(chordValue) || 0),
      0,
      CHORD_DEFINITIONS.length - 1
    );
  }

  return [...CHORD_DEFINITIONS[index]];
}

function makePatternData(id) {
  return {
    id,
    repeat: 1,
    sequence: createPatternSequence()
  };
}

function makeMasterMix() {
  return {
    eq: [0, 0, 0, 0, 0, 0, 0, 0],
    volume: 100,
    limiter: -1,
    reverb: 0
  };
}

function makeSongData() {
  /*
   * Song detail is intentionally minimal here.
   * Pattern order/repeat UI is migrated later; no Section/Fill model is created.
   */
  return {
    order: Array.from({ length: PATTERN_SLOT_COUNT }, (_, index) => index),
    masterMix: makeMasterMix()
  };
}

export let soundBank = createProjectSoundBank();

export const patterns = Array.from(
  { length: PATTERN_SLOT_COUNT },
  (_, index) => makePatternData(index + 1)
);

export const song = makeSongData();

/*
 * Temporary compatibility exports.
 * They deliberately contain no old Track/Fill/Section data.
 * Consumers are migrated in the following steps.
 */
export const tracks = [];
export const fills = [];
export const sections = [];
export const parameters = [];

function makeDefaultRuntimeState() {
  return {
    selectedSoundId: "1",
    selectedLayer: "melodic",
    selectedPatternIndex: 0,

    selectedParameterId: null,
    selectedChildId: null,

    playingStepIndex: null,
    playbackTickIndex: null,
    isPlaying: false,

    playingPatternIndex: null,
    queuedPatternIndex: null,

    /*
     * Number of completed passes of the currently playing Pattern.
     * 0 means the first pass is in progress.
     */
    playingPatternRepeatCount: 0,

    /*
     * When true, keep the currently playing Pattern at every
     * Pattern boundary instead of advancing through song.order.
     */
    patternLoopEnabled: false,

    /*
     * Pattern loop range is expressed as Pattern indexes.
     * null means single-Pattern loop behavior.
     */
    patternLoopRange: null,

    songMode: false,
    selectedSongPartIndex: 0,
    playingSongPartIndex: null,
    queuedSongPartIndex: null,

    /*
     * Compatibility fields kept only until main/ui migration.
     */
    selectedTrackIndex: 0,
    sequencePage: 0,
    patternLength: STEP_COUNT,
    selectedSourceType: "pattern",
    selectedFillIndex: null,
    selectedSectionIndex: 0,
    editingSectionIndex: 0,
    playingSourceType: null,
    playingFillIndex: null,
    queuedSourceType: null,
    queuedFillIndex: null,
    queuedSectionIndex: null,
    selectedPlaybackType: "source",
    playingSectionIndex: null,
    playingSectionItemIndex: null,
    fillReturnTarget: null,
    songPage: 0
  };
}

export const state = makeDefaultRuntimeState();

export function selectedLayer() {
  return state.selectedLayer;
}

export function selectSound(soundId) {
  if (MELODIC_SOUND_IDS.includes(String(soundId))) {
    state.selectedSoundId = String(soundId);
    state.selectedLayer = "melodic";
    return true;
  }

  if (RHYTHM_SOUND_IDS.includes(String(soundId))) {
    state.selectedSoundId = String(soundId);
    state.selectedLayer = "rhythm";
    return true;
  }

  return false;
}

export function currentPattern() {
  return patterns[state.selectedPatternIndex] ?? null;
}

export function currentSequence() {
  return currentPattern()?.sequence ?? [];
}

export function currentStep(stepIndex) {
  return currentSequence()[stepIndex] ?? null;
}

export function selectPattern(patternIndex) {
  if (
    !Number.isInteger(patternIndex) ||
    patternIndex < 0 ||
    patternIndex >= patterns.length
  ) {
    return false;
  }

  state.selectedPatternIndex = patternIndex;
  state.selectedSourceType = "pattern";
  state.selectedFillIndex = null;
  return true;
}

export function queuePattern(patternIndex) {
  if (
    !Number.isInteger(patternIndex) ||
    patternIndex < 0 ||
    patternIndex >= patterns.length
  ) {
    return false;
  }

  if (state.queuedPatternIndex === patternIndex) {
    clearQueuedSource();
    return true;
  }

  clearQueuedSource();
  state.queuedPatternIndex = patternIndex;
  state.queuedSourceType = "pattern";
  return true;
}

export function clearQueuedSource() {
  state.queuedPatternIndex = null;
  state.queuedSourceType = null;
  state.queuedSongPartIndex = null;
}

function normalizedSongOrder() {
  const valid =
    Array.from(
      { length: patterns.length },
      (_, index) => index
    );

  const source =
    Array.isArray(song.order)
      ? song.order
      : [];

  const seen =
    new Set();

  const order =
    source.filter(index => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= patterns.length ||
        seen.has(index)
      ) {
        return false;
      }

      seen.add(index);
      return true;
    });

  valid.forEach(index => {
    if (!seen.has(index)) {
      order.push(index);
    }
  });

  song.order =
    order;

  return order;
}

function nextPatternInSongOrder(
  patternIndex
) {
  const order =
    normalizedSongOrder();

  if (!order.length) {
    return patternIndex;
  }

  const position =
    order.indexOf(
      patternIndex
    );

  if (position < 0) {
    return order[0];
  }

  return order[
    (position + 1) %
    order.length
  ];
}


export function setPatternLoopRange(
  startPatternIndex,
  endPatternIndex
) {
  if (
    !Number.isInteger(startPatternIndex) ||
    !Number.isInteger(endPatternIndex)
  ) {
    state.patternLoopRange =
      null;

    return false;
  }

  const order =
    normalizedSongOrder();

  const startPosition =
    order.indexOf(
      startPatternIndex
    );

  const endPosition =
    order.indexOf(
      endPatternIndex
    );

  if (
    startPosition < 0 ||
    endPosition < 0
  ) {
    state.patternLoopRange =
      null;

    return false;
  }

  const from =
    Math.min(
      startPosition,
      endPosition
    );

  const to =
    Math.max(
      startPosition,
      endPosition
    );

  state.patternLoopRange =
    order.slice(
      from,
      to + 1
    );

  return (
    state.patternLoopRange.length >
    1
  );
}

export function clearPatternLoopRange() {
  state.patternLoopRange =
    null;
}

export function patternLoopRange() {
  return Array.isArray(
    state.patternLoopRange
  )
    ? [
        ...state.patternLoopRange
      ]
    : null;
}


export function setPatternLoopEnabled(
  enabled
) {
  state.patternLoopEnabled =
    Boolean(enabled);

  /*
   * Start a fresh repeat count when entering/leaving loop mode.
   * This avoids resuming halfway through an old repeat count.
   */
  state.playingPatternRepeatCount =
    0;

  return state.patternLoopEnabled;
}

export function togglePatternLoop() {
  return setPatternLoopEnabled(
    !state.patternLoopEnabled
  );
}


export function beginSelectedPlayback() {
  state.playingPatternIndex =
    state.selectedPatternIndex;

  state.playingPatternRepeatCount =
    0;

  state.playingSourceType =
    "pattern";

  state.playingStepIndex =
    null;

  state.playbackTickIndex =
    null;

  return true;
}

export function advancePlaybackSource() {
  /*
   * A queued Pattern always wins at the next Pattern boundary.
   */
  if (
    state.queuedPatternIndex !==
    null
  ) {
    const index =
      state.queuedPatternIndex;

    clearQueuedSource();

    selectPattern(index);

    state.playingPatternIndex =
      index;

    state.playingPatternRepeatCount =
      0;

    state.playingSourceType =
      "pattern";

    return true;
  }

  if (
    state.patternLoopEnabled
  ) {
    const currentIndex =
      state.playingPatternIndex ??
      state.selectedPatternIndex ??
      0;

    const range =
      Array.isArray(
        state.patternLoopRange
      )
        ? state.patternLoopRange
        : null;

    /*
     * No valid range = single Pattern loop.
     */
    if (
      !range ||
      range.length < 2
    ) {
      state.playingPatternRepeatCount =
        0;

      return false;
    }

    const position =
      range.indexOf(
        currentIndex
      );

    const nextIndex =
      position < 0
        ? range[0]
        : range[
            (position + 1) %
            range.length
          ];

    state.playingPatternRepeatCount =
      0;

    if (
      nextIndex ===
      currentIndex
    ) {
      return false;
    }

    selectPattern(
      nextIndex
    );

    state.playingPatternIndex =
      nextIndex;

    state.playingSourceType =
      "pattern";

    return true;
  }

  const currentIndex =
    state.playingPatternIndex ??
    state.selectedPatternIndex ??
    0;

  /*
   * Pattern repeat has been retired from the Song screen.
   * Every completed Pattern now advances directly through song.order.
   * The legacy repeat field may remain in saved data for compatibility,
   * but playback intentionally ignores it.
   */
  const nextIndex =
    nextPatternInSongOrder(
      currentIndex
    );

  state.playingPatternRepeatCount =
    0;

  if (
    nextIndex ===
    currentIndex
  ) {
    return false;
  }

  /*
   * Follow playback with the selected Pattern so UI editing/display
   * stays on the Pattern currently being heard.
   */
  selectPattern(
    nextIndex
  );

  state.playingPatternIndex =
    nextIndex;

  state.playingSourceType =
    "pattern";

  return true;
}


export function setPatternRepeat(patternIndex, repeat) {
  const pattern = patterns[patternIndex];
  if (!pattern) return false;

  pattern.repeat = clamp(
    Math.round(Number(repeat) || 1),
    1,
    99
  );
  return true;
}

export function setStepLayer(stepIndex, layer, data) {
  const step = currentStep(stepIndex);
  if (!step || !["melodic", "rhythm"].includes(layer)) {
    return false;
  }

  saveHistory();

  if (data == null) {
    step[layer] =
      layer === "melodic"
        ? createMelodicStep()
        : createRhythmStep();

    return true;
  }

  step[layer] = layer === "melodic"
    ? normalizeSequenceStep({
        melodic: data,
        rhythm: null
      }).melodic
    : normalizeSequenceStep({
        melodic: null,
        rhythm: data
      }).rhythm;

  return true;
}

export function clearStepLayer(stepIndex, layer) {
  const step = currentStep(stepIndex);
  if (!step || !["melodic", "rhythm"].includes(layer)) {
    return false;
  }

  const layerData = step[layer];
  if (!layerData) {
    return false;
  }

  saveHistory();
  layerData.soundId = null;
  return true;
}

export function clearStep(stepIndex) {
  const sequence = currentSequence();
  if (!sequence[stepIndex]) return false;

  saveHistory();
  sequence[stepIndex] = createSequenceStep();
  return true;
}

export function placeSelectedSound(stepIndex) {
  const step = currentStep(stepIndex);
  if (!step) return false;

  saveHistory();

  const layer = state.selectedLayer;
  const existing = step[layer];

  if (existing && existing.soundId == null) {
    existing.soundId = state.selectedSoundId;
    return true;
  }

  if (layer === "melodic") {
    step.melodic = createMelodicStep(state.selectedSoundId);
  } else {
    step.rhythm = createRhythmStep(state.selectedSoundId);
  }

  return true;
}

export function stepHasData(step) {
  return Boolean(
    step?.melodic?.soundId ||
    step?.rhythm?.soundId
  );
}

export function sourceHasData(source) {
  return Boolean(
    source?.sequence?.some(stepHasData)
  );
}

export function currentSourceLabel() {
  return String(state.selectedPatternIndex + 1).padStart(2, "0");
}

/* =========================
 * Whole-STEP clipboard
 * ========================= */

let editClipboard = null;

export function copyStepToEditClipboard(stepIndex) {
  const step = currentStep(stepIndex);
  if (!step) return false;

  /*
   * mono82 has one logical clipboard.
   * Creating a STEP clip invalidates Pattern / Layer clips.
   */
  patternClipboard = null;
  layerClipboards.melodic = null;
  layerClipboards.rhythm = null;

  editClipboard = {
    type: "step",
    step: structuredClone(step)
  };
  return true;
}

export function pasteStepFromEditClipboard(stepIndex) {
  if (!editClipboard?.step) return false;

  const sequence = currentSequence();
  if (!sequence[stepIndex]) return false;

  saveHistory();
  sequence[stepIndex] = normalizeSequenceStep(
    structuredClone(editClipboard.step)
  );
  return true;
}

export function hasEditClipboard() {
  return Boolean(editClipboard);
}

export function editClipboardType() {
  return editClipboard?.type ?? null;
}

export function editClipboardOriginIsStep() {
  return (
    editClipboard?.type === "step" ||
    editClipboard?.type === "step-range"
  );
}

export function clearEditClipboard() {
  editClipboard = null;
}

export function copyStepRangeToEditClipboard(startIndex, endIndex) {
  const sequence = currentSequence();
  const start = clamp(Math.min(startIndex, endIndex), 0, STEP_COUNT - 1);
  const end = clamp(Math.max(startIndex, endIndex), 0, STEP_COUNT - 1);

  patternClipboard = null;
  layerClipboards.melodic = null;
  layerClipboards.rhythm = null;

  editClipboard = {
    type: "step-range",
    steps: structuredClone(sequence.slice(start, end + 1))
  };
  return true;
}

export function pasteStepClipboardAt(stepIndex) {
  if (!editClipboard) return false;

  const sequence = currentSequence();
  const start = clamp(stepIndex, 0, STEP_COUNT - 1);

  if (editClipboard.type === "step") {
    if (!editClipboard.step || !sequence[start]) return false;

    saveHistory();
    sequence[start] = normalizeSequenceStep(
      structuredClone(editClipboard.step)
    );
    return true;
  }

  if (editClipboard.type === "step-range") {
    const steps = Array.isArray(editClipboard.steps)
      ? editClipboard.steps
      : [];

    if (!steps.length || !sequence[start]) return false;

    saveHistory();

    steps.forEach((step, offset) => {
      const targetIndex = start + offset;
      if (targetIndex >= STEP_COUNT || !sequence[targetIndex]) return;

      sequence[targetIndex] = normalizeSequenceStep(
        structuredClone(step)
      );
    });

    return true;
  }

  return false;
}


/* =========================
 * Hierarchical clipboards
 * Song = Pattern / Offset = Layer
 * Each category is independent and survives view changes.
 * ========================= */

let patternClipboard = null;
const layerClipboards = { melodic: null, rhythm: null };

export function copyPatternRangeToClipboard(patternIndexes) {
  const indexes = Array.isArray(patternIndexes) ? patternIndexes : [];
  const items = indexes
    .filter(index => Number.isInteger(index) && patterns[index])
    .map(index => structuredClone(patterns[index]));
  if (!items.length) return false;

  editClipboard = null;
  layerClipboards.melodic = null;
  layerClipboards.rhythm = null;

  patternClipboard = { items };
  return true;
}

export function hasPatternClipboard() { return Boolean(patternClipboard?.items?.length); }
export function clearPatternClipboard() { patternClipboard = null; }

export function pastePatternClipboardAt(patternIndex) {
  if (!hasPatternClipboard() || !patterns[patternIndex]) return false;
  const order = Array.isArray(song.order) ? song.order : [];
  const startPosition = order.indexOf(patternIndex);
  saveHistory();
  patternClipboard.items.forEach((source, offset) => {
    const targetIndex = startPosition >= 0
      ? order[startPosition + offset]
      : patternIndex + offset;
    const target = patterns[targetIndex];
    if (!target) return;
    const keepId = target.id;
    Object.assign(target, structuredClone(source), { id: keepId });
    normalizePattern(target, keepId);
  });
  return true;
}

export function copyLayerRangeToClipboard(layer, startIndex, endIndex) {
  if (!(layer in layerClipboards)) return false;
  const sequence = currentSequence();
  const start = clamp(Math.min(startIndex, endIndex), 0, STEP_COUNT - 1);
  const end = clamp(Math.max(startIndex, endIndex), 0, STEP_COUNT - 1);

  /*
   * A new Offset clip replaces every previous clip,
   * including the opposite melodic/rhythm layer.
   */
  editClipboard = null;
  patternClipboard = null;
  layerClipboards.melodic = null;
  layerClipboards.rhythm = null;

  layerClipboards[layer] = {
    items: structuredClone(sequence.slice(start, end + 1).map(step => step?.[layer] ?? null))
  };
  return true;
}

export function hasLayerClipboard(layer) { return Boolean(layerClipboards[layer]?.items?.length); }
export function clearLayerClipboard(layer) { if (layer in layerClipboards) layerClipboards[layer] = null; }

export function pasteLayerClipboardAt(layer, stepIndex) {
  const clip = layerClipboards[layer];
  if (!clip?.items?.length) return false;
  const sequence = currentSequence();
  const start = clamp(stepIndex, 0, STEP_COUNT - 1);
  if (!sequence[start]) return false;
  saveHistory();
  clip.items.forEach((item, offset) => {
    const targetIndex = start + offset;
    if (!sequence[targetIndex]) return;
    sequence[targetIndex][layer] = structuredClone(item);
  });
  return true;
}

/* =========================
 * Pattern clipboard
 * ========================= */

let sourceClipboard = null;

export function copySource() {
  sourceClipboard = structuredClone(currentPattern());
  return Boolean(sourceClipboard);
}

export function pasteSource() {
  if (!sourceClipboard) return false;

  saveHistory();
  const target = patterns[state.selectedPatternIndex];
  const keepId = target.id;

  Object.assign(
    target,
    structuredClone(sourceClipboard),
    { id: keepId }
  );
  normalizePattern(target, keepId);
  return true;
}

export function hasSourceClipboard() {
  return Boolean(sourceClipboard);
}

export function clearSourceClipboard() {
  sourceClipboard = null;
}

/* =========================
 * Sequence operations
 * ========================= */

export function shiftSequence(direction) {
  const sequence = currentSequence();
  if (!sequence.length) return false;

  saveHistory();

  if (direction < 0) {
    sequence.push(sequence.shift());
  } else {
    sequence.unshift(sequence.pop());
  }

  return true;
}

export function randomizeSequence() {
  const sequence = currentSequence();
  if (!sequence.length) return false;

  saveHistory();

  for (let i = sequence.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
  }

  return true;
}

/* =========================
 * Mute / Solo
 * ========================= */

export const performance = {
  layers: {
    melodic: {
      muted: false,
      solo: false
    },

    rhythm: {
      muted: false,
      solo: false
    }
  }
};

export function soundIsAudible(
  layer,
  soundId
) {
  const layerState =
    performance.layers[layer];

  const sound =
    soundBank?.[layer]?.[
      soundId
    ];

  if (
    !layerState ||
    !sound
  ) {
    return false;
  }

  const anyLayerSolo =
    Object.values(
      performance.layers
    ).some(
      item => item.solo
    );

  const allSounds = [
    ...Object.values(
      soundBank.melodic ?? {}
    ),

    ...Object.values(
      soundBank.rhythm ?? {}
    )
  ];

  const anySoundSolo =
    allSounds.some(
      item => item.solo
    );

  return (
    !layerState.muted &&
    !sound.muted &&
    (
      !anyLayerSolo ||
      layerState.solo
    ) &&
    (
      !anySoundSolo ||
      sound.solo
    )
  );
}

/* =========================
 * Snapshot / normalization
 * ========================= */

function normalizePattern(
  pattern,
  fallbackId,
  chordStorageSchema = null
) {
  if (!pattern || typeof pattern !== "object") {
    return makePatternData(fallbackId);
  }

  pattern.id = Number.isInteger(pattern.id) ? pattern.id : fallbackId;
  pattern.repeat = clamp(
    Math.round(Number(pattern.repeat) || 1),
    1,
    99
  );

  const oldSequence = Array.isArray(pattern.sequence)
    ? pattern.sequence
    : [];

  pattern.sequence = Array.from(
    { length: STEP_COUNT },
    (_, index) => {
      const step = normalizeSequenceStep(oldSequence[index]);

      if (step.melodic) {
        const chord = step.melodic.chord;

        if (typeof chord === "string") {
          /*
           * Name-based snapshots are stable. Do not reinterpret a valid name
           * through an index under any circumstances.
           */
          step.melodic.chord = CHORD_NAMES.includes(chord)
            ? chord
            : "off";
        } else {
          /*
           * Only legacy snapshots may contain numeric indexes.
           * Convert through the permanently frozen v0 table, never through
           * the current live CHORD_NAMES ordering.
           */
          const legacyIndex = Math.max(
            0,
            Math.min(
              LEGACY_NUMERIC_CHORD_NAMES_V0.length - 1,
              Math.round(Number(chord) || 0)
            )
          );

          step.melodic.chord =
            LEGACY_NUMERIC_CHORD_NAMES_V0[legacyIndex] ?? "off";
        }
      }

      return step;
    }
  );

  return pattern;
}

function normalizeProjectSnapshot(snapshot) {
  const data = snapshot && typeof snapshot === "object"
    ? structuredClone(snapshot)
    : {};

  const chordStorageSchema =
    typeof data.chordStorageSchema === "string"
      ? data.chordStorageSchema
      : null;

  data.soundBank = normalizeProjectSoundBank(data.soundBank);

  data.patterns = Array.from(
    { length: PATTERN_SLOT_COUNT },
    (_, index) =>
      normalizePattern(
        data.patterns?.[index],
        index + 1,
        chordStorageSchema
      )
  );

  data.song ??= makeSongData();
  data.song.order = Array.isArray(data.song.order)
    ? data.song.order.filter(index =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < PATTERN_SLOT_COUNT
      )
    : makeSongData().order;

  data.song.masterMix = {
    ...makeMasterMix(),
    ...(data.song.masterMix ?? {})
  };

  data.chordStorageSchema = CHORD_STORAGE_SCHEMA;

  return data;
}

export function createProjectSnapshot() {
  return structuredClone({
    chordStorageSchema: CHORD_STORAGE_SCHEMA,
    soundBank,
    patterns,
    song
  });
}

export function createNewProjectSnapshot() {
  return structuredClone({
    chordStorageSchema: CHORD_STORAGE_SCHEMA,
    soundBank: createProjectSoundBank(),
    patterns: Array.from(
      { length: PATTERN_SLOT_COUNT },
      (_, index) => makePatternData(index + 1)
    ),
    song: makeSongData()
  });
}

export function createSnapshot() {
  return structuredClone({
    ...createProjectSnapshot(),
    state
  });
}

export function restoreProjectSnapshot(projectSnapshot) {
  if (!projectSnapshot) return false;

  const normalized = normalizeProjectSnapshot(projectSnapshot);

  soundBank = normalized.soundBank;

  patterns.splice(
    0,
    patterns.length,
    ...normalized.patterns
  );

  Object.assign(song, normalized.song);

  Object.assign(state, makeDefaultRuntimeState());

  clearHistory();
  return true;
}

export function restoreSnapshot(snapshot) {
  if (!snapshot) return false;

  const normalized = normalizeProjectSnapshot(snapshot);

  soundBank = normalized.soundBank;

  patterns.splice(
    0,
    patterns.length,
    ...normalized.patterns
  );

  Object.assign(song, normalized.song);

  Object.assign(
    state,
    makeDefaultRuntimeState(),
    structuredClone(snapshot.state ?? {})
  );

  return true;
}

/* =========================
 * Undo / Redo
 * ========================= */

const HISTORY_LIMIT = 10;
const undoStack = [];
const redoStack = [];

export function saveHistorySnapshot(snapshot) {
  if (!snapshot) return false;

  undoStack.push(structuredClone(snapshot));

  if (undoStack.length > HISTORY_LIMIT) {
    undoStack.shift();
  }

  redoStack.length = 0;
  window.dispatchEvent(new Event("historychange"));
  return true;
}

export function saveHistory() {
  /*
   * Undo / Redo is edit history, not transport history.
   * Keep playback/runtime state out of the stack so restoring an edit
   * can never rewind isPlaying / playbackTickIndex / playingStepIndex.
   */
  return saveHistorySnapshot(createProjectSnapshot());
}

export function saveTrackHistory() {
  /*
   * Old name retained temporarily for ui.js compatibility.
   * New model has no Track-local history.
   */
  return saveHistory();
}

export function saveMasterMixHistory() {
  return saveHistory();
}

export function discardLatestUndoEntry() {
  if (!undoStack.length) return false;
  undoStack.pop();
  window.dispatchEvent(new Event("historychange"));
  return true;
}

function restoreHistorySnapshot(snapshot) {
  if (!snapshot) return false;

  const normalized = normalizeProjectSnapshot(snapshot);

  soundBank = normalized.soundBank;

  patterns.splice(
    0,
    patterns.length,
    ...normalized.patterns
  );

  Object.assign(song, normalized.song);

  /*
   * Deliberately do NOT restore state here.
   * Transport/runtime state belongs to the live session and must continue
   * through Undo / Redo without stopping or jumping playback.
   */
  return true;
}

export function undo() {
  if (!undoStack.length) return false;

  const current = createProjectSnapshot();
  const previous = undoStack.pop();

  redoStack.push(current);
  restoreHistorySnapshot(previous);

  window.dispatchEvent(new Event("historychange"));
  return true;
}

export function redo() {
  if (!redoStack.length) return false;

  const current = createProjectSnapshot();
  const next = redoStack.pop();

  undoStack.push(current);
  restoreHistorySnapshot(next);

  window.dispatchEvent(new Event("historychange"));
  return true;
}

export function canUndo() {
  return undoStack.length > 0;
}

export function canRedo() {
  return redoStack.length > 0;
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  window.dispatchEvent(new Event("historychange"));
}

/* =========================
 * Compatibility stubs
 * Removed concepts must not create new data.
 * ========================= */

export function getMaxTrackLength() {
  return STEP_COUNT;
}

export function syncPatternLength() {
  state.patternLength = STEP_COUNT;
}

export function selectedTrack() {
  return null;
}

export function parameterById() {
  return null;
}

export function clearSelectedTrackSequence() {
  return false;
}

export function clearSelectedParameterOffsets() {
  return false;
}

export function selectFill() {
  return false;
}

export function queueFill() {
  return false;
}

export function selectSection() {
  return false;
}

export function queueSection() {
  return false;
}

export function selectEditingSection() {
  return false;
}

export function currentEditingSection() {
  return null;
}

export function currentEditingSectionLabel() {
  return "";
}

export function addCurrentSourceToSection() {
  return false;
}

export function addSourceToSection() {
  return false;
}

export function moveSectionSource() {
  return false;
}

export function removeSectionSource() {
  return false;
}

export function sectionHasData() {
  return false;
}

export function addSourceToSong() {
  return false;
}

export function moveSongSource() {
  return false;
}

export function removeSongSource() {
  return false;
}

export function selectSongPart(index) {
  if (!Number.isInteger(index)) return false;
  state.selectedSongPartIndex = index;
  return true;
}

export function queueSongPart(index) {
  if (!Number.isInteger(index)) return false;
  state.queuedSongPartIndex = index;
  return true;
}
