import {
  STEP_COUNT,
  MELODIC_SOUND_IDS,
  RHYTHM_SOUND_IDS,
  CHORD_NAMES,
  soundBank,
  patterns,
  state,
  selectSound,
  selectPattern,
  queuePattern,
  currentPattern,
  currentStep,
  placeSelectedSound,
  clearStepLayer,
  saveHistory,
  shiftSequence,
  randomizeSequence,
  undo,
  performance,
  copyStepToEditClipboard,
  copyStepRangeToEditClipboard,
  pasteStepClipboardAt,
  hasEditClipboard,
  editClipboardOriginIsStep,
  clearEditClipboard,
  copyPatternRangeToClipboard,
  hasPatternClipboard,
  clearPatternClipboard,
  pastePatternClipboardAt,
  copyLayerRangeToClipboard,
  hasLayerClipboard,
  clearLayerClipboard,
  pasteLayerClipboardAt,
  song,
  togglePatternLoop,
  setPatternLoopRange,
  clearPatternLoopRange,
  patternLoopRange,
  sourceHasData,
  clamp
} from "./sequencer.js";

import {
  getCurrentProjectMeta
} from "./storage.js";

import {
  getMasterMixMeterData,
  setMasterMixEqBand,
  setMasterMixVolume,
  setMasterLimiterThreshold,
  setMasterReverb
} from "./audio.js";


/* =========================================================
 * mokton UI - Stage 1
 *
 * 旧sprootoの4 Track / Fill / Section / Offset UIを切り離し、
 * まず以下だけを画面へ出す。
 *
 * - Project固定 Sound Bank 1-4 / a-d
 * - 32 STEP / 1 Timeline
 * - STEP内 MELODIC + RHYTHM overlay
 * - Pattern 01-40
 *
 * - Sound Parameter editor
 * - STEP Performance editor
 *
 * Chord data model / final interaction designは次段階。
 * ========================================================= */

const currentProjectName =
  document.getElementById(
    "current-project-name"
  );

const currentSourceDisplay =
  document.getElementById(
    "current-source-display"
  );

const sequenceGrid =
  document.getElementById(
    "sequence-grid"
  );

const editor =
  document.getElementById(
    "editor"
  );

const patternGrid =
  document.getElementById(
    "pattern-grid"
  );

const patternLoopButton =
  document.getElementById(
    "pattern-loop-button"
  );

const patternEditButton =
  document.getElementById(
    "pattern-edit-button"
  );

const sequenceBackButton =
  currentSourceDisplay;

const sequencePageButton =
  document.getElementById(
    "sequence-page-button"
  );

const patternLengthInput =
  document.getElementById(
    "pattern-length-input"
  );

const patternPageButton =
  document.getElementById(
    "pattern-page-button"
  );

const sectionList =
  document.getElementById(
    "section-list"
  );

const songParts =
  document.getElementById(
    "song-parts"
  );

const songGrid =
  document.getElementById(
    "song-grid"
  );

const songMasterMix =
  document.getElementById(
    "song-master-mix"
  );

const songPageButton =
  document.getElementById(
    "song-page-button"
  );

const sequenceViewToggle =
  document.getElementById(
    "sequence-view-toggle"
  );

const songEditorViewToggle =
  document.getElementById(
    "song-editor-view-toggle"
  );


let selectedStepIndex =
  null;

/*
 * STEP clipboard UI state.
 * Clipboard data itself lives in sequencer.js; this only remembers where
 * the current clipboard was copied from so the source can be marked without
 * changing the normal STEP design.
 */
let clipboardSourceRange =
  null;

let patternClipboardSourceRange = null;
const layerClipboardSourceRanges = { melodic: null, rhythm: null };
let patternClipGesture = null;
let lastPatternTap = { index: null, time: 0 };
let lastOffsetTap = { index: null, layer: null, time: 0, original: null };

/*
 * Only one logical clipboard may exist at a time.
 * Data invalidation is enforced in sequencer.js; this mirrors it for
 * source-marker UI state so an old mini marker never reappears later.
 */
function keepOnlyClipboardSource(kind) {
  if (kind !== "step") {
    clipboardSourceRange = null;
  }

  if (kind !== "pattern") {
    patternClipboardSourceRange = null;
  }

  if (kind !== "layer-melodic") {
    layerClipboardSourceRanges.melodic = null;
  }

  if (kind !== "layer-rhythm") {
    layerClipboardSourceRanges.rhythm = null;
  }
}

function refreshClipboardUiEverywhere() {
  /*
   * A new clip invalidates the previous logical clipboard globally.
   * Refresh only functions that actually exist in this UI module.
   */
  renderPatternClipboardUi();
  renderSequenceTools();

  /*
   * Source markers are rebuilt with the current clipboard category.
   * appView uses "sequence" / "pattern" — never "edit".
   */
  if (appView === "pattern") {
    renderPatternManager();
  } else if (appView === "sequence") {
    renderSequence();
  }
}

/*
 * A completed double-tap / sweep rebuilds the STEP DOM immediately.
 * On iOS, the trailing synthetic click can then land on the newly-created
 * STEP and be mistaken for a paste. Keep this guard outside each STEP
 * element so it survives renderSequence().
 */
let suppressSequenceClickUntil =
  0;

function suppressTrailingSequenceClick() {
  suppressSequenceClickUntil =
    globalThis.performance.now() + 450;
}

function sequenceClickIsSuppressed() {
  return (
    globalThis.performance.now() <
    suppressSequenceClickUntil
  );
}

function setClipboardPreviewRange(
  startIndex,
  endIndex
) {
  const from =
    Math.min(
      startIndex,
      endIndex
    );

  const to =
    Math.max(
      startIndex,
      endIndex
    );

  sequenceGrid
    ?.querySelectorAll(
      ".mokton-step"
    )
    .forEach(step => {
      const index =
        Number(
          step.dataset.stepIndex
        );

      const inPreview =
        Number.isInteger(index) &&
        index >= from &&
        index <= to;

      step.classList.toggle(
        "clipboard-preview",
        inPreview
      );

      const marker =
        step.querySelector(
          ".mokton-step-clipboard-marker"
        );

      if (marker) {
        marker.hidden =
          !(
            inPreview ||
            step.classList.contains(
              "clipboard-source"
            )
          );
      }
    });
}

function clearClipboardPreview() {
  sequenceGrid
    ?.querySelectorAll(
      ".mokton-step.clipboard-preview"
    )
    .forEach(step => {
      step.classList.remove(
        "clipboard-preview"
      );

      const marker =
        step.querySelector(
          ".mokton-step-clipboard-marker"
        );

      if (marker) {
        marker.hidden =
          !step.classList.contains(
            "clipboard-source"
          );
      }
    });
}

let appView =
  "sequence";

function setAppView(
  view
) {
  appView =
    view === "sequence"
      ? "sequence"
      : "pattern";

  /*
   * View changes must not change the user's loop choice.
   * Pattern Edit and Song share the same persistent loop state/range.
   * When loop is already ON, entering Pattern Edit follows the selected
   * Pattern during playback; when loop is OFF, normal song playback is
   * left untouched.
   */
  if (
    appView === "sequence" &&
    state.patternLoopEnabled &&
    state.isPlaying &&
    state.playingPatternIndex !==
      null &&
    state.playingPatternIndex !==
      state.selectedPatternIndex &&
    state.queuedPatternIndex !==
      state.selectedPatternIndex
  ) {
    queuePattern(
      state.selectedPatternIndex
    );
  }

  document.body.dataset.moktonView =
    appView;
}

sequenceBackButton?.addEventListener(
  "click",
  () => {
    setAppView(
      "pattern"
    );

    renderPatternManager();
  }
);


/* =========================================================
 * Temporary stage CSS
 *
 * index.html / style.cssの全面整理はUI構造が固まってから行う。
 * それまではmokton骨格を確実に表示するため、
 * このファイルから最小CSSを1回だけ注入する。
 * ========================================================= */

function ensureMoktonStageStyles() {
  /*
   * Stage 4:
   * layout/style is now owned by style.css.
   */
}


/* =========================================================
 * Project name
 * ========================================================= */

export async function refreshProjectName() {
  if (!currentProjectName) {
    return;
  }

  try {
    const meta =
      await getCurrentProjectMeta();

    currentProjectName.textContent =
      meta?.name ??
      "mokton";
  } catch {
    currentProjectName.textContent =
      "mokton";
  }
}


/* =========================================================
 * Source display
 * ========================================================= */

function patternLabel(
  patternIndex =
    state.selectedPatternIndex
) {
  const pattern =
    patterns[
      patternIndex
    ];

  const id =
    pattern?.id ??
    Number(patternIndex) + 1;

  return String(id).padStart(
    2,
    "0"
  );
}


function renderCurrentSourceDisplay() {
  if (!currentSourceDisplay) {
    return;
  }

  currentSourceDisplay.className =
    "mokton-current-source";

  currentSourceDisplay.textContent =
    patternLabel();
}



const SVG_NS =
  "http://www.w3.org/2000/svg";

function createMono82Icon(
  name,
  extraClass = ""
) {
  const svg =
    document.createElementNS(
      SVG_NS,
      "svg"
    );

  svg.setAttribute(
    "viewBox",
    "0 0 24 24"
  );

  svg.setAttribute(
    "aria-hidden",
    "true"
  );

  svg.classList.add(
    "mono82-icon"
  );

  if (extraClass) {
    svg.classList.add(
      extraClass
    );
  }

  const addPath = (
    d,
    {
      fill = "none",
      stroke = "currentColor",
      strokeWidth = 2
    } = {}
  ) => {
    const path =
      document.createElementNS(
        SVG_NS,
        "path"
      );

    path.setAttribute(
      "d",
      d
    );

    path.setAttribute(
      "fill",
      fill
    );

    path.setAttribute(
      "stroke",
      stroke
    );

    path.setAttribute(
      "stroke-width",
      String(strokeWidth)
    );

    path.setAttribute(
      "stroke-linecap",
      "square"
    );

    path.setAttribute(
      "stroke-linejoin",
      "miter"
    );

    svg.appendChild(
      path
    );

    return path;
  };

  const addPolygon = (
    points,
    fill = "currentColor"
  ) => {
    const polygon =
      document.createElementNS(
        SVG_NS,
        "polygon"
      );

    polygon.setAttribute(
      "points",
      points
    );

    polygon.setAttribute(
      "fill",
      fill
    );

    svg.appendChild(
      polygon
    );

    return polygon;
  };

  switch (name) {
    case "play":
      addPolygon(
        "7,4 11,4 11,6 14,6 14,8 17,8 17,10 20,10 20,14 17,14 17,16 14,16 14,18 11,18 11,20 7,20"
      );
      break;

    case "undo":
      addPath(
        "M19 5v3h-2v2H8M11 6 7 10l4 4"
      );
      break;

    case "redo":
      addPath(
        "M5 5v3h2v2h9M13 6l4 4-4 4"
      );
      break;

    case "loop":
      addPath(
        "M4 11V9h2V7h11"
      );

      addPolygon(
        "21,7 17,3 17,11"
      );

      addPath(
        "M20 13v2h-2v2H7"
      );

      addPolygon(
        "3,17 7,13 7,21"
      );
      break;

    case "shift-left":
      addPolygon(
        "16,4 12,4 12,7 9,7 9,9 6,9 6,15 9,15 9,17 12,17 12,20 16,20"
      );
      break;

    case "shift-right":
      addPolygon(
        "8,4 12,4 12,7 15,7 15,9 18,9 18,15 15,15 15,17 12,17 12,20 8,20"
      );
      break;

    case "level":
      addPolygon(
        "3,9 7,9 12,5 12,19 7,15 3,15"
      );

      addPath(
        "M15 9h1v2h1v2h-1v2h-1M18 7h1v2h1v6h-1v2h-1",
        {
          strokeWidth: 1.8
        }
      );
      break;

    case "attack":
      addPolygon(
        "4,19 20,19 20,5"
      );
      break;

    case "hold-decay": {
      addPolygon(
        "3,7 11,7 21,19 3,19"
      );

      const guide =
        addPath(
          "M11 2v18",
          {
            stroke:
              "var(--bg)",
            strokeWidth: 1.4
          }
        );

      guide.setAttribute(
        "stroke-dasharray",
        "2 2"
      );

      const topGuide =
        addPath(
          "M11 2v4",
          {
            stroke:
              "currentColor",
            strokeWidth: 1.4
          }
        );

      topGuide.setAttribute(
        "stroke-dasharray",
        "2 2"
      );
      break;
    }

    case "clipboard": {
      const back = addPath(
        "M5 4h11v11H5z",
        { strokeWidth: 1.5 }
      );
      back.setAttribute(
        "stroke-dasharray",
        "2 2"
      );
      addPath(
        "M9 8h11v11H9z",
        { strokeWidth: 1.8 }
      );
      break;
    }

    default:
      return null;
  }

  return svg;
}


function createLfoWaveIcon(
  wave
) {
  const svg =
    document.createElementNS(
      SVG_NS,
      "svg"
    );

  svg.setAttribute(
    "viewBox",
    "0 0 32 18"
  );

  svg.setAttribute(
    "aria-hidden",
    "true"
  );

  svg.classList.add(
    "mono82-icon",
    "mono82-lfo-wave-icon"
  );

  const path =
    document.createElementNS(
      SVG_NS,
      "path"
    );

  const paths = {
    sine:
      "M2 9H4V6H6V4H8V3H10V4H12V6H14V9H16V12H18V14H20V15H22V14H24V12H26V9H28V6H30V4",
    triangle:
      "M2 14H4V12H6V9H8V6H10V4H12V6H14V9H16V12H18V14H20V12H22V9H24V6H26V4H28V7H30V10",
    square:
      "M2 14V4H10V14H18V4H26V14H30",
    sawUp:
      "M2 14H4V12H6V10H8V8H10V4H10V14H12V12H14V10H16V8H18V4H18V14H20V12H22V10H24V8H26V4H26V14H30",
    sawDown:
      "M2 4H4V6H6V8H8V10H10V14H10V4H12V6H14V8H16V10H18V14H18V4H20V6H22V8H24V10H26V14H26V4H30",
    random:
      "M2 10H4V6H6V5H8V12H10V8H12V7H14V11H16V5H18V4H20V13H22V9H24V8H26V12H28V8H30V6",
    rise:
      "M2 14H8V13H12V12H16V10H20V8H24V5H28V3H30",
    fall:
      "M2 3H8V4H12V5H16V7H20V9H24V12H28V14H30"
  };

  path.setAttribute(
    "d",
    paths[wave] ??
      paths.sine
  );

  path.setAttribute(
    "fill",
    "none"
  );

  path.setAttribute(
    "stroke",
    "currentColor"
  );

  path.setAttribute(
    "stroke-width",
    "2"
  );

  path.setAttribute(
    "stroke-linecap",
    "square"
  );

  path.setAttribute(
    "stroke-linejoin",
    "miter"
  );

  svg.appendChild(
    path
  );

  return svg;
}


function parameterIconName(
  definition
) {
  const map = {
    gain: "level",
    attack: "attack",
    holdDecay:
      "hold-decay"
  };

  return (
    map[
      definition?.id
    ] ??
    null
  );
}


function applyParameterLabel(
  host,
  definition
) {
  const iconName =
    parameterIconName(
      definition
    );

  if (!iconName) {
    host.textContent =
      definition.label;

    return;
  }

  const icon =
    createMono82Icon(
      iconName,
      "mono82-parameter-icon"
    );

  if (icon) {
    host.replaceChildren(
      icon
    );
  }
}


const SOUND_PARAMETER_SCHEMA = Object.freeze({
  melodic: [
    {
      id: "gain",
      label: "lvl",
      min: 0,
      max: 150,
      step: 1
    },

    {
      id: "attack",
      label: "atk",
      min: 1,
      max: 100,
      step: 1
    },

    {
      id: "holdDecay",
      label: "h/d",
      min: -50,
      max: 50,
      step: 1
    },

    {
      id: "filterCutoff",
      label: "fil",
      min: -50,
      max: 50,
      step: 1
    },

    {
      id: "filterResonance",
      label: "res",
      min: 0,
      max: 50,
      step: 1
    },

    {
      id: "fmDepth",
      label: "fmd",
      min: 0,
      max: 20,
      step: 1
    },

    {
      id: "fmRatio",
      label: "fmr",
      min: 0.25,
      max: 8,
      step: 0.25
    }
  ],

  rhythm: [
    {
      id: "gain",
      label: "lvl",
      min: 0,
      max: 150,
      step: 1
    },

    {
      id: "attack",
      label: "atk",
      min: 1,
      max: 100,
      step: 1
    },

    {
      id: "holdDecay",
      label: "h/d",
      min: -50,
      max: 50,
      step: 1
    },

    {
      id: "filterCutoff",
      label: "fil",
      min: -50,
      max: 50,
      step: 1
    },

    {
      id: "filterResonance",
      label: "res",
      min: 0,
      max: 50,
      step: 1
    },

    {
      id: "noiseMix",
      label: "nse",
      min: 0,
      max: 100,
      step: 1
    },

    {
      id: "note",
      label: "nte",
      min: -48,
      max: 67,
      step: 1
    }
  ]
});

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

const LFO_TARGETS = Object.freeze([
  "level",
  "pitch",
  "pan",
  "fm",
  "filter"
]);

/*
 * LFO Rate UI is deliberately discrete.
 * Storage remains backward-compatible: Free values are tenths of a Hz,
 * BPM values are indexes into the existing sync-ratio table in audio.js.
 */
const LFO_FREE_RATE_VALUES = Object.freeze([
  1, 2, 3, 5, 7,
  10, 15, 20, 25, 30,
  40, 50, 60, 80, 100,
  120, 150, 200, 250, 300,
  400, 500, 600, 800, 1000
]);

const LFO_BPM_RATE_LABELS = Object.freeze([
  "1/16", "1/12", "1/8", "1/6",
  "1/4", "1/3", "1/2", "2/3",
  "1", "4/3", "2", "4", "8", "16"
]);

function selectedSound() {
  return (
    soundBank?.[
      state.selectedLayer
    ]?.[
      state.selectedSoundId
    ] ??
    null
  );
}

function formatParameterValue(
  definition,
  value
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return "0";
  }

  /*
   * FIL is a centered, bidirectional filter control.
   * Positive values move the sound upward via HPF / LOW CUT,
   * negative values move it downward via LPF / HIGH CUT.
   * Show direction instead of an ambiguous +/- sign.
   */
  if (
    definition?.id ===
      "filterCutoff"
  ) {
    const rounded =
      Math.round(number);

    if (rounded > 0) {
      return `↑${rounded}`;
    }

    if (rounded < 0) {
      return `↓${Math.abs(rounded)}`;
    }

    return "0";
  }

  if (
    definition.step < 1
  ) {
    return String(
      Math.round(
        number * 100
      ) / 100
    );
  }

  return String(
    Math.round(number)
  );
}

function createParameterRow(
  sound,
  definition
) {
  const row =
    document.createElement(
      "label"
    );

  row.className =
    "mokton-param-row";

  const name =
    document.createElement(
      "span"
    );

  name.className =
    "mokton-param-label";

  name.textContent =
    definition.label;

  const input =
    document.createElement(
      "input"
    );

  input.className =
    "mokton-param-range";

  input.type =
    "range";

  input.min =
    String(
      definition.min
    );

  input.max =
    String(
      definition.max
    );

  input.step =
    String(
      definition.step
    );

  input.value =
    String(
      sound[
        definition.id
      ]
    );

  const value =
    document.createElement(
      "span"
    );

  value.className =
    "mokton-param-value";

  const updateValue = () => {
    value.textContent =
      formatParameterValue(
        definition,
        input.value
      );
  };

  updateValue();

  let historySaved =
    false;

  const beginEdit = () => {
    if (historySaved) {
      return;
    }

    saveHistory();
    historySaved = true;
  };

  const endEdit = () => {
    historySaved = false;
  };

  input.addEventListener(
    "pointerdown",
    beginEdit
  );

  input.addEventListener(
    "keydown",
    beginEdit
  );

  input.addEventListener(
    "input",
    () => {
      if (!historySaved) {
        beginEdit();
      }

      sound[
        definition.id
      ] =
        Number(
          input.value
        );

      updateValue();
    }
  );

  input.addEventListener(
    "change",
    endEdit
  );

  input.addEventListener(
    "pointerup",
    endEdit
  );

  input.addEventListener(
    "blur",
    endEdit
  );

  row.append(
    name,
    input,
    value
  );

  return row;
}

function createChoiceButton({
  label,
  selected,
  onSelect
}) {
  const button =
    document.createElement(
      "button"
    );

  button.type =
    "button";

  button.className =
    "mokton-choice-button";

  button.textContent =
    label;

  button.classList.toggle(
    "selected",
    selected
  );

  button.addEventListener(
    "click",
    () => {
      saveHistory();
      onSelect();
      renderEditor();
    }
  );

  return button;
}

function createLfoCard(
  sound,
  lfoKey,
  label
) {
  const lfo =
    sound?.[
      lfoKey
    ];

  if (!lfo) {
    return null;
  }

  const card =
    document.createElement(
      "section"
    );

  card.className =
    "mokton-lfo-card";

  const head =
    document.createElement(
      "div"
    );

  head.className =
    "mokton-lfo-head";

  const title =
    document.createElement(
      "span"
    );

  title.textContent =
    label;

  const target =
    document.createElement(
      "span"
    );

  target.className =
    "mokton-lfo-target";

  /*
   * Target候補は未確定。
   * 現在値だけ表示し、UI側で新しい候補を発明しない。
   */
  target.textContent =
    `target:${lfo.target}`;

  head.append(
    title,
    target
  );

  card.appendChild(
    head
  );

  const waveRow =
    document.createElement(
      "div"
    );

  waveRow.className =
    "mokton-choice-row";

  const waveLabel =
    document.createElement(
      "span"
    );

  waveLabel.className =
    "mokton-param-label";

  waveLabel.textContent =
    "wave";

  const waveButtons =
    document.createElement(
      "div"
    );

  waveButtons.className =
    "mokton-choice-buttons";

  LFO_WAVES.forEach(
    wave => {
      waveButtons.appendChild(
        createChoiceButton({
          label:
            wave
              .replace(
                "triangle",
                "tri"
              )
              .replace(
                "square",
                "sqr"
              )
              .replace(
                "sawUp",
                "saw+"
              )
              .replace(
                "sawDown",
                "saw-"
              )
              .replace(
                "random",
                "rnd"
              ),

          selected:
            lfo.wave === wave,

          onSelect: () => {
            lfo.wave =
              wave;
          }
        })
      );
    }
  );

  waveRow.append(
    waveLabel,
    waveButtons
  );

  card.appendChild(
    waveRow
  );

  card.appendChild(
    createParameterRow(
      lfo,
      {
        id: "depth",
        label: "dep",
        min: 0,
        max: 100,
        step: 1
      }
    )
  );

  card.appendChild(
    createParameterRow(
      lfo,
      {
        id: "rate",
        label: "rat",
        min: 1,
        max: 100,
        step: 1
      }
    )
  );

  const syncRow =
    document.createElement(
      "div"
    );

  syncRow.className =
    "mokton-choice-row";

  const syncLabel =
    document.createElement(
      "span"
    );

  syncLabel.className =
    "mokton-param-label";

  syncLabel.textContent =
    "rate mode";

  const syncButtons =
    document.createElement(
      "div"
    );

  syncButtons.className =
    "mokton-choice-buttons";

  [
    ["free", "free"],
    ["bpm", "bpm"]
  ].forEach(
    ([mode, text]) => {
      syncButtons.appendChild(
        createChoiceButton({
          label: text,
          selected:
            lfo.syncMode ===
            mode,

          onSelect: () => {
            lfo.syncMode =
              mode;
          }
        })
      );
    }
  );

  syncRow.append(
    syncLabel,
    syncButtons
  );

  card.appendChild(
    syncRow
  );

  return card;
}

function createSoundParameterEditor() {
  const sound =
    selectedSound();

  if (!sound) {
    return null;
  }

  const root =
    document.createElement(
      "section"
    );

  root.className =
    "mokton-sound-editor";

  const heading =
    document.createElement(
      "div"
    );

  heading.className =
    "mokton-sound-editor-title";

  const title =
    document.createElement(
      "span"
    );

  title.textContent =
    "sound";

  const selected =
    document.createElement(
      "strong"
    );

  selected.textContent =
    state.selectedSoundId;

  heading.append(
    title,
    selected
  );

  root.appendChild(
    heading
  );

  const definitions =
    SOUND_PARAMETER_SCHEMA[
      state.selectedLayer
    ] ?? [];

  definitions.forEach(
    definition => {
      root.appendChild(
        createParameterRow(
          sound,
          definition
        )
      );
    }
  );

  [
    ["lfo1", "lfo1"],
    ["lfo2", "lfo2"]
  ].forEach(
    ([key, label]) => {
      const card =
        createLfoCard(
          sound,
          key,
          label
        );

      if (card) {
        root.appendChild(
          card
        );
      }
    }
  );

  return root;
}


const STEP_PARAMETER_SCHEMA =
  Object.freeze({
    melodic: [
      {
        id: "gain",
        label: "lvl",
        min: 0,
        max: 150,
        step: 1
      },

      {
        id: "note",
        label: "nte",
        min: -48,
        max: 67,
        step: 1
      },

      {
        id: "pan",
        label: "pan",
        min: -25,
        max: 25,
        step: 1
      },

      {
        id: "nudge",
        label: "ndg",
        min: -4,
        max: 4,
        step: 1
      },

      {
        id: "probability",
        label: "prb",
        min: 0,
        max: 100,
        step: 1
      },

      {
        id: "subPattern",
        label: "sub",
        min: -1,
        max: 6,
        step: 1
      },

      {
        id: "strum",
        label: "stm",
        min: -8,
        max: 8,
        step: 1
      }
    ],

    rhythm: [
      {
        id: "gain",
        label: "lvl",
        min: 0,
        max: 150,
        step: 1
      },

      {
        id: "note",
        label: "nte",
        min: -48,
        max: 67,
        step: 1
      },

      {
        id: "pan",
        label: "pan",
        min: -25,
        max: 25,
        step: 1
      },

      {
        id: "nudge",
        label: "ndg",
        min: -4,
        max: 4,
        step: 1
      },

      {
        id: "probability",
        label: "prb",
        min: 0,
        max: 100,
        step: 1
      },

      {
        id: "subPattern",
        label: "sub",
        min: -1,
        max: 6,
        step: 1
      },

      {
        id: "subProbability",
        label: "spr",
        min: 0,
        max: 100,
        step: 1
      }
    ]
  });

function selectedStepPerformance() {
  if (
    selectedStepIndex ===
    null
  ) {
    return null;
  }

  const step =
    currentStep(
      selectedStepIndex
    );

  if (!step) {
    return null;
  }

  return (
    step[
      state.selectedLayer
    ] ?? null
  );
}

const STEP_NOTE_NAMES =
  Object.freeze([
    "C",
    "C♯",
    "D",
    "D♯",
    "E",
    "F",
    "F♯",
    "G",
    "G♯",
    "A",
    "A♯",
    "B"
  ]);


const STEP_CHORD_NAMES =
  CHORD_NAMES;

const STEP_CHORD_DEFINITION =
  Object.freeze({
    id: "chord",
    label: "chd",
    min: 0,
    max:
      STEP_CHORD_NAMES.length - 1,
    step: 1
  });


const STEP_SUB_PATTERNS =
  Object.freeze([
    {
      divisions: 2,
      hits: [0, 1]
    },
    {
      divisions: 2,
      hits: [1]
    },
    {
      divisions: 3,
      hits: [0, 1, 2]
    },
    {
      divisions: 4,
      hits: [0, 1, 2, 3]
    },
    {
      divisions: 4,
      hits: [0, 2]
    },
    {
      divisions: 4,
      hits: [0, 1]
    },
    {
      divisions: 6,
      hits: [0, 1, 2, 3, 4, 5]
    }
  ]);


function stepNoteName(
  value
) {
  const note =
    Math.round(
      Number(value) || 0
    );

  const midiNote =
    Math.max(
      12,
      Math.min(
        127,
        60 + note
      )
    );

  const pitchClass =
    midiNote % 12;

  const octave =
    Math.floor(
      midiNote / 12
    ) - 1;

  return (
    `${
      STEP_NOTE_NAMES[
        pitchClass
      ] ?? "C"
    }${octave}`
  );
}


function stepChordIndex(
  value
) {
  if (typeof value === "string") {
    const index =
      STEP_CHORD_NAMES.indexOf(
        value
      );

    return index >= 0
      ? index
      : 0;
  }

  return Math.max(
    0,
    Math.min(
      STEP_CHORD_NAMES.length - 1,
      Math.round(
        Number(value) || 0
      )
    )
  );
}

function stepChordName(
  value
) {
  return (
    STEP_CHORD_NAMES[
      stepChordIndex(value)
    ] ?? "off"
  );
}


function appendNoteName(
  host,
  value
) {
  const text =
    stepNoteName(
      value
    );

  const sharpIndex =
    text.indexOf(
      "♯"
    );

  if (sharpIndex < 0) {
    host.textContent =
      text;
    return;
  }

  host.append(
    document.createTextNode(
      text.slice(
        0,
        sharpIndex
      )
    )
  );

  const sharp =
    document.createElement(
      "span"
    );

  sharp.className =
    "mokton-note-sharp";

  sharp.textContent =
    "♯";

  host.appendChild(
    sharp
  );

  host.append(
    document.createTextNode(
      text.slice(
        sharpIndex + 1
      )
    )
  );
}


function createNoteChordDisplay(
  noteValue,
  chordValue,
  activeTarget
) {
  const wrapper =
    document.createElement(
      "span"
    );

  wrapper.className =
    "mokton-note-chord-display";

  const noteLine =
    document.createElement(
      "span"
    );

  noteLine.className =
    "mokton-note-chord-line mokton-note-line";

  appendNoteName(
    noteLine,
    noteValue
  );

  const chordLine =
    document.createElement(
      "span"
    );

  chordLine.className =
    "mokton-note-chord-line mokton-chord-line";

  chordLine.textContent =
    stepChordName(
      chordValue
    );

  if (
    activeTarget === "note"
  ) {
    noteLine.classList.add(
      "is-edit-target"
    );
  }

  if (
    activeTarget === "chord"
  ) {
    chordLine.classList.add(
      "is-edit-target"
    );
  }

  wrapper.append(
    noteLine,
    chordLine
  );

  return wrapper;
}



function renderDirectionalOffset(
  host,
  value,
  zeroLabel = "c"
) {
  const amount =
    Math.round(
      Number(value) || 0
    );

  if (amount === 0) {
    host.textContent =
      zeroLabel;

    return;
  }

  const direction =
    document.createElement(
      "span"
    );

  direction.className =
    "mokton-step-offset-direction";

  direction.textContent =
    amount > 0
      ? ">"
      : "<";

  const number =
    document.createElement(
      "span"
    );

  number.className =
    "mokton-step-offset-number";

  number.textContent =
    String(
      Math.abs(amount)
    );

  host.replaceChildren(
    direction,
    number
  );
}


function createSubPatternDisplay(
  value
) {
  const number =
    Math.round(
      Number(value)
    );

  if (
    number < 0 ||
    !STEP_SUB_PATTERNS[
      number
    ]
  ) {
    return null;
  }

  const pattern =
    STEP_SUB_PATTERNS[
      number
    ];

  const svg =
    document.createElementNS(
      SVG_NS,
      "svg"
    );

  svg.setAttribute(
    "viewBox",
    "0 0 24 10"
  );

  svg.setAttribute(
    "aria-hidden",
    "true"
  );

  svg.classList.add(
    "mokton-step-subpattern-icon"
  );

  const usableWidth =
    20;

  const left =
    2;

  const slotWidth =
    usableWidth /
    pattern.divisions;

  pattern.hits.forEach(
    hit => {
      const rect =
        document.createElementNS(
          SVG_NS,
          "rect"
        );

      const gap =
        Math.min(
          0.7,
          slotWidth * 0.12
        );

      rect.setAttribute(
        "x",
        String(
          left +
          hit * slotWidth +
          gap / 2
        )
      );

      rect.setAttribute(
        "y",
        "1.5"
      );

      rect.setAttribute(
        "width",
        String(
          Math.max(
            1,
            slotWidth - gap
          )
        )
      );

      rect.setAttribute(
        "height",
        "7"
      );

      svg.appendChild(
        rect
      );
    }
  );

  return svg;
}

function createStrumDisplay(
  value
) {
  const amount =
    Math.max(
      -8,
      Math.min(
        8,
        Math.round(
          Number(value) || 0
        )
      )
    );

  const svg =
    document.createElementNS(
      SVG_NS,
      "svg"
    );

  svg.setAttribute(
    "viewBox",
    "0 0 28 14"
  );

  svg.setAttribute(
    "aria-hidden",
    "true"
  );

  svg.classList.add(
    "mokton-step-strum-icon"
  );

  /*
   * 横方向 = 発音タイミング。
   * 最初に鳴る1音は常に中央(x=14)。
   * 後続音だけ右方向へ遅らせる。
   *
   * 正値：低音側（下段）から上へ。
   * 負値：高音側（上段）から下へ。
   */
  const maximumDelay =
    (
      Math.abs(amount) /
      8
    ) * 8;

  const lineLength =
    8;

  const centerX =
    14;

  for (
    let row = 0;
    row < 4;
    row++
  ) {
    const line =
      document.createElementNS(
        SVG_NS,
        "line"
      );

    let delayOrder =
      0;

    if (amount > 0) {
      /*
       * row 3 = bottom = first sound
       */
      delayOrder =
        3 - row;
    } else if (amount < 0) {
      /*
       * row 0 = top = first sound
       */
      delayOrder =
        row;
    }

    const shift =
      amount === 0
        ? 0
        : (
            delayOrder /
            3
          ) *
          maximumDelay;

    const y =
      2 +
      row * 3.2;

    const x1 =
      centerX -
      lineLength / 2 +
      shift;

    const x2 =
      centerX +
      lineLength / 2 +
      shift;

    line.setAttribute(
      "x1",
      String(x1)
    );

    line.setAttribute(
      "x2",
      String(x2)
    );

    line.setAttribute(
      "y1",
      String(y)
    );

    line.setAttribute(
      "y2",
      String(y)
    );

    svg.appendChild(
      line
    );
  }

  return svg;
}

function renderStepOffsetValue(
  host,
  definition,
  value,
  performance = null
) {
  host.replaceChildren();

  switch (
    definition.id
  ) {
    case "note":
    case "chord": {
      host.appendChild(
        createNoteChordDisplay(
          performance?.note ?? 0,
          performance?.chord ?? 0,
          definition.id
        )
      );

      return;
    }

    case "pan":
      renderDirectionalOffset(
        host,
        value,
        "c"
      );
      return;

    case "nudge":
      renderDirectionalOffset(
        host,
        value,
        "0"
      );
      return;

    case "subPattern": {
      const icon =
        createSubPatternDisplay(
          value
        );

      if (icon) {
        host.appendChild(
          icon
        );
      } else {
        host.textContent =
          "off";
      }

      return;
    }

    case "strum":
      host.appendChild(
        createStrumDisplay(
          value
        )
      );
      return;

    default:
      host.textContent =
        formatStepValue(
          definition,
          value
        );
  }
}


function formatStepValue(
  definition,
  value
) {
  if (
    definition.id ===
    "subPattern"
  ) {
    const number =
      Math.round(
        Number(value)
      );

    return number < 0
      ? "off"
      : String(
          number + 1
        );
  }

  return formatParameterValue(
    definition,
    value
  );
}

function createStepParameterRow(
  performanceData,
  definition
) {
  const row =
    document.createElement(
      "label"
    );

  row.className =
    "mokton-param-row";

  const name =
    document.createElement(
      "span"
    );

  name.className =
    "mokton-param-label";

  name.textContent =
    definition.label;

  const input =
    document.createElement(
      "input"
    );

  input.className =
    "mokton-param-range";

  input.type =
    "range";

  input.min =
    String(
      definition.min
    );

  input.max =
    String(
      definition.max
    );

  input.step =
    String(
      definition.step
    );

  input.value =
    String(
      performanceData[
        definition.id
      ]
    );

  const value =
    document.createElement(
      "span"
    );

  value.className =
    "mokton-param-value";

  const updateValue = () => {
    value.textContent =
      formatStepValue(
        definition,
        input.value
      );
  };

  updateValue();

  let historySaved =
    false;

  const beginEdit = () => {
    if (historySaved) {
      return;
    }

    saveHistory();
    historySaved = true;
  };

  const endEdit = () => {
    historySaved = false;
  };

  input.addEventListener(
    "pointerdown",
    beginEdit
  );

  input.addEventListener(
    "keydown",
    beginEdit
  );

  input.addEventListener(
    "input",
    () => {
      if (!historySaved) {
        beginEdit();
      }

      performanceData[
        definition.id
      ] =
        Number(
          input.value
        );

      updateValue();
    }
  );

  input.addEventListener(
    "change",
    endEdit
  );

  input.addEventListener(
    "pointerup",
    endEdit
  );

  input.addEventListener(
    "blur",
    endEdit
  );

  row.append(
    name,
    input,
    value
  );

  return row;
}

function createChordPendingRow(
  performanceData
) {
  const row =
    document.createElement(
      "div"
    );

  row.className =
    "mokton-readonly-row";

  const name =
    document.createElement(
      "span"
    );

  name.className =
    "mokton-param-label";

  name.textContent =
    "chord";

  const value =
    document.createElement(
      "span"
    );

  value.className =
    "mokton-readonly-value";

  value.textContent =
    performanceData.chord ==
      null
      ? "single / pending"
      : "set / pending";

  row.append(
    name,
    value
  );

  return row;
}

function createStepPerformanceEditor() {
  const root =
    document.createElement(
      "section"
    );

  root.className =
    "mokton-step-editor";

  const heading =
    document.createElement(
      "div"
    );

  heading.className =
    "mokton-step-editor-title";

  const title =
    document.createElement(
      "span"
    );

  title.textContent =
    "step";

  const selected =
    document.createElement(
      "strong"
    );

  selected.textContent =
    selectedStepIndex ===
      null
      ? "--"
      : String(
          selectedStepIndex + 1
        ).padStart(
          2,
          "0"
        );

  heading.append(
    title,
    selected
  );

  root.appendChild(
    heading
  );

  if (
    selectedStepIndex ===
    null
  ) {
    const empty =
      document.createElement(
        "div"
      );

    empty.className =
      "mokton-step-editor-empty";

    empty.textContent =
      "tap step";

    root.appendChild(
      empty
    );

    return root;
  }

  const performanceData =
    selectedStepPerformance();

  if (
    !performanceData?.soundId
  ) {
    const empty =
      document.createElement(
        "div"
      );

    empty.className =
      "mokton-step-editor-empty";

    empty.textContent =
      `${state.selectedLayer} empty`;

    root.appendChild(
      empty
    );

    return root;
  }

  if (
    performanceData.soundId !==
    state.selectedSoundId
  ) {
    const empty =
      document.createElement(
        "div"
      );

    empty.className =
      "mokton-step-editor-empty";

    empty.textContent =
      `sound ${performanceData.soundId} on this layer`;

    root.appendChild(
      empty
    );

    return root;
  }

  if (
    state.selectedLayer ===
    "melodic"
  ) {
    root.appendChild(
      createChordPendingRow(
        performanceData
      )
    );
  }

  const definitions =
    STEP_PARAMETER_SCHEMA[
      state.selectedLayer
    ] ?? [];

  definitions.forEach(
    definition => {
      root.appendChild(
        createStepParameterRow(
          performanceData,
          definition
        )
      );
    }
  );

  return root;
}


function createMiniButton(label, onClick, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mokton-mini-button";
  button.textContent = label;
  button.title = options.title ?? label;
  button.classList.toggle("active", Boolean(options.active));
  button.addEventListener("click", event => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderSequenceTools() {
  const host = document.querySelector(
    ".sequence-section .section-toolbar"
  );
  if (!host) return;

  host.querySelector(".mokton-sequence-tools")?.remove();

  const tools = document.createElement("div");
  tools.className = "mokton-sequence-tools";

  tools.append(
    createMiniButton("", () => {
      shiftSequence(-1);
      window.dispatchEvent(
        new CustomEvent(
          "sequencechange"
        )
      );
      renderSequence();
      renderEditor();
    }, { title: "shift sequence left" }),

    createMiniButton("", () => {
      shiftSequence(1);
      window.dispatchEvent(
        new CustomEvent(
          "sequencechange"
        )
      );
      renderSequence();
      renderEditor();
    }, { title: "shift sequence right" }),

    createMiniButton("rdm", () => {
      randomizeSequence();
      window.dispatchEvent(
        new CustomEvent(
          "sequencechange"
        )
      );
      renderSequence();
      renderEditor();
    }, { title: "shuffle existing steps" })
  );

  const sequenceToolButtons =
    tools.querySelectorAll(
      ".mokton-mini-button"
    );

  if (sequenceToolButtons[0]) {
    sequenceToolButtons[0].replaceChildren(
      createMono82Icon(
        "shift-left",
        "mono82-shift-icon"
      )
    );
  }

  if (sequenceToolButtons[1]) {
    sequenceToolButtons[1].replaceChildren(
      createMono82Icon(
        "shift-right",
        "mono82-shift-icon"
      )
    );
  }

  if (
    !selectedStepParameterId &&
    hasEditClipboard() &&
    editClipboardOriginIsStep()
  ) {
    let clipCleared =
      false;

    const clearStepClipboardUi = () => {
      if (clipCleared) {
        return;
      }

      clipCleared =
        true;

      clearEditClipboard();
      clipboardSourceRange =
        null;
      clearClipboardPreview();
      renderSequenceTools();
      renderSequence();
    };

    const clipButton =
      createMiniButton(
        "clip",
        clearStepClipboardUi,
        {
          active: false,
          title: "clear step clipboard"
        }
      );

    /*
     * On iOS a first tap on this transient control could be consumed before
     * the synthetic click. Commit the clear on pointerup instead. The guard
     * above keeps the subsequent click harmless.
     */
    clipButton.addEventListener(
      "pointerup",
      event => {
        event.preventDefault();
        event.stopPropagation();
        clearStepClipboardUi();
      }
    );

    clipButton.classList.add(
      "mokton-clip-button"
    );

    clipButton.replaceChildren(
      createMono82Icon(
        "clipboard",
        "mono82-clipboard-icon"
      )
    );

    tools.insertBefore(
      clipButton,
      tools.firstChild
    );
  }

  if (
    selectedStepParameterId &&
    hasLayerClipboard(state.selectedLayer)
  ) {
    const layer = state.selectedLayer;
    let cleared = false;
    const clearLayerClipUi = () => {
      if (cleared) return;
      cleared = true;
      clearLayerClipboard(layer);
      layerClipboardSourceRanges[layer] = null;
      renderSequenceTools();
      renderSequence();
    };
    const clipButton = createMiniButton("clip", clearLayerClipUi, { title: "clear layer clipboard" });
    clipButton.classList.add("mokton-clip-button");
    clipButton.replaceChildren(createMono82Icon("clipboard", "mono82-clipboard-icon"));
    clipButton.addEventListener("pointerup", event => {
      event.preventDefault(); event.stopPropagation(); clearLayerClipUi();
    });
    tools.insertBefore(clipButton, tools.firstChild);
  }

  host.appendChild(tools);
}

function createMuteSoloControls({
  muted = false,
  solo = false,
  onMute,
  onSolo
}) {
  const controls = document.createElement("span");
  controls.className = "mokton-ms-controls";
  controls.append(
    createMiniButton("m", onMute, {
      active: muted,
      title: "mute"
    }),
    createMiniButton("s", onSolo, {
      active: solo,
      title: "solo"
    })
  );
  return controls;
}

function layerPerformanceState(layer) {
  return performance.layers?.[layer] ?? {
    muted: false,
    solo: false
  };
}


/* =========================================================
 * Sound Bank selector
 * ========================================================= */

function createCompactSoundButton(
  soundId
) {
  const button =
    document.createElement(
      "button"
    );

  button.type =
    "button";

  button.className =
    "mokton-sound-button mokton-sound-button-compact";

  button.textContent =
    soundId;

  button.dataset.soundId =
    soundId;

  button.classList.toggle(
    "selected",
    state.selectedSoundId ===
      soundId
  );

  button.addEventListener(
    "click",
    () => {
      if (
        !selectSound(
          soundId
        )
      ) {
        return;
      }

      /*
       * Sound selection changes the target/layer.
       * Sound parameters remain permanently visible below;
       * STEP offset parameters live under the sequencer.
       */
      selectedLfoKey =
        null;

      /*
       * Preserve the selected STEP parameter by its visual slot.
       * Slots 1-6 are shared between layers.
       * Slot 7 maps melodic stm <-> rhythm spr.
       */
      if (
        selectedStepParameterId
      ) {
        const nextDefinitions =
          stepDefinitions();

        if (
          state.selectedLayer === "rhythm" &&
          selectedStepParameterId === "chord"
        ) {
          selectedStepParameterId =
            "note";
        } else if (
          !nextDefinitions.some(
            definition =>
              definition.id ===
              selectedStepParameterId
          )
        ) {
          selectedStepParameterId =
            nextDefinitions[6]?.id ??
            null;
        }
      }

      renderEditor();
      renderSequenceTools();
      renderSequence();
    }
  );

  return button;
}

function createCompactSoundBank() {
  const bank =
    document.createElement(
      "div"
    );

  bank.className =
    "mokton-sound-bank";

  [
    ...MELODIC_SOUND_IDS,
    ...RHYTHM_SOUND_IDS
  ].forEach(
    soundId => {
      bank.appendChild(
        createCompactSoundButton(
          soundId
        )
      );
    }
  );

  return bank;
}

function createSelectedSoundMuteSolo() {
  const sound =
    selectedSound();

  if (!sound) {
    return null;
  }

  const row =
    document.createElement(
      "div"
    );

  row.className =
    "mokton-selected-ms mokton-selected-sound-info";

  const label =
    document.createElement(
      "span"
    );

  label.className =
    "mokton-ms-label mokton-selected-sound-name";

  label.textContent =
    sound.name ||
    `sound ${state.selectedSoundId}`;

  row.append(
    label,

    createMuteSoloControls({
      muted:
        Boolean(sound.muted),

      solo:
        Boolean(sound.solo),

      onMute: () => {
        saveHistory();
        sound.muted =
          !sound.muted;
        renderEditor();
      },

      onSolo: () => {
        saveHistory();
        sound.solo =
          !sound.solo;
        renderEditor();
      }
    })
  );

  return row;
}


export let editorMode = "sound";
let selectedSoundParameterId = null;
let selectedStepParameterId = null;
let selectedLfoKey = null;
let selectedLfoParameterId = null;

const LFO_PARAMETER_SCHEMA = Object.freeze([
  {
    id: "depth",
    label: "dep",
    min: 0,
    max: 100,
    step: 1
  },
  {
    id: "rate",
    label: "rat",
    min: 1,
    max: 100,
    step: 1
  }
]);

function stepDefinitions() {
  return (
    STEP_PARAMETER_SCHEMA[
      state.selectedLayer
    ] ?? []
  );
}

function soundDefinitions() {
  return (
    SOUND_PARAMETER_SCHEMA[
      state.selectedLayer
    ] ?? []
  );
}

function activeStepOffsetDefinition() {
  if (!selectedStepParameterId) {
    return null;
  }

  if (
    state.selectedLayer === "melodic" &&
    selectedStepParameterId === "chord"
  ) {
    return STEP_CHORD_DEFINITION;
  }

  return (
    stepDefinitions().find(
      definition =>
        definition.id ===
        selectedStepParameterId
    ) ?? null
  );
}

function clampEditorValue(
  value,
  definition
) {
  return Math.min(
    definition.max,
    Math.max(
      definition.min,
      value
    )
  );
}

function dragValueWithCenterSnap(
  startValue,
  deltaPixels,
  definition
) {
  const step =
    Number(
      definition.step
    ) || 1;

  /*
   * Chord has many discrete choices, so give each item a larger physical
   * travel distance than ordinary offsets. This makes exact selection less
   * twitchy on a phone while keeping the rest of the UI unchanged.
   */
  const pixelsPerStep =
    definition.id === "chord"
      ? 12
      : definition.id === "rate"
        ? 1
        : 7;

  const continuousValue =
    Number(startValue) +
    (
      Number(deltaPixels) /
      pixelsPerStep
    ) *
      step;

  const isBipolar =
    Number(definition.min) < 0 &&
    Number(definition.max) > 0;

  if (!isBipolar) {
    if (definition.id === "rate") {
      const delta =
        Number(deltaPixels) || 0;

      const direction =
        delta < 0 ? -1 : 1;

      const magnitude =
        Math.abs(delta);

      /*
       * Fine around the touch-down point, progressively faster on long swipes.
       * About 200px can traverse the extended 0.1-100Hz range.
       */
      const acceleratedSteps =
        magnitude +
        Math.pow(
          magnitude / 7,
          2
        );

      return clampEditorValue(
        Number(startValue) +
          direction *
          Math.round(
            acceleratedSteps
          ) *
          step,
        definition
      );
    }

    return clampEditorValue(
      Number(startValue) +
        Math.round(
          Number(deltaPixels) /
          pixelsPerStep
        ) *
          step,
      definition
    );
  }

  /*
   * 0だけ約2.6段階分の広い吸着帯にする。
   * 吸着帯を抜けたら、すぐ±1から再開するため、
   * NUDGEのような狭い範囲でも隣接値を失わない。
   */
  const snapRadius =
    step * 1.3;

  if (
    Math.abs(
      continuousValue
    ) <= snapRadius
  ) {
    return 0;
  }

  const direction =
    continuousValue < 0
      ? -1
      : 1;

  const beyondSnap =
    Math.max(
      0,
      Math.abs(
        continuousValue
      ) -
        snapRadius
    );

  const steppedMagnitude =
    step +
    Math.round(
      beyondSnap /
      step
    ) *
      step;

  return clampEditorValue(
    direction *
      steppedMagnitude,
    definition
  );
}


function createDirectValuePad(
  target,
  definition,
  {
    formatter =
      formatParameterValue,
    extraClass = ""
  } = {}
) {
  const button =
    document.createElement(
      "button"
    );

  button.type =
    "button";

  button.className =
    `mokton-direct-value-pad ${extraClass}`
      .trim();

  const label =
    document.createElement(
      "span"
    );

  label.className =
    "mokton-direct-value-label";

  applyParameterLabel(
    label,
    definition
  );

  const value =
    document.createElement(
      "strong"
    );

  value.className =
    "mokton-direct-value-number";

  const renderValue = () => {
    value.textContent =
      formatter(
        definition,
        target[
          definition.id
        ]
      );
  };

  renderValue();

  let drag =
    null;

  button.addEventListener(
    "pointerdown",
    event => {
      if (
        event.button !==
        undefined &&
        event.button !== 0
      ) {
        return;
      }

      /*
       * iOS gesture hardening:
       * direct-value vertical sweeps must stay owned by the app once begun.
       * touch-action:none is already set in CSS; preventDefault + pointerId
       * lock keeps Safari's own scrolling/gesture handling from taking over
       * during the active edit as far as the browser is allowed to.
       */
      event.preventDefault();

      drag = {
        pointerId:
          event.pointerId,
        startY:
          event.clientY,
        startValue:
          Number(
            target[
              definition.id
            ]
          ) || 0,
        saved:
          false
      };

      button.setPointerCapture?.(
        event.pointerId
      );
    }
  );

  button.addEventListener(
    "pointermove",
    event => {
      if (
        !drag ||
        drag.pointerId !==
          event.pointerId
      ) {
        return;
      }

      event.preventDefault();

      const delta =
        drag.startY -
        event.clientY;

      const units =
        Math.round(
          delta / 7
        );

      if (!units) {
        return;
      }

      if (!drag.saved) {
        saveHistory();
        drag.saved = true;
      }

      const next =
        dragValueWithCenterSnap(
          drag.startValue,
          delta,
          definition
        );

      target[
        definition.id
      ] =
        next;

      renderValue();
    }
  );

  const finishDrag = (
    event
  ) => {
    if (
      !drag ||
      drag.pointerId !==
        event.pointerId
    ) {
      return;
    }

    event.preventDefault();

    button.releasePointerCapture?.(
      event.pointerId
    );

    drag =
      null;
  };

  button.addEventListener(
    "pointerup",
    finishDrag
  );

  button.addEventListener(
    "pointercancel",
    finishDrag
  );

  button.addEventListener(
    "keydown",
    event => {
      if (
        event.key !==
          "ArrowUp" &&
        event.key !==
          "ArrowDown"
      ) {
        return;
      }

      event.preventDefault();
      saveHistory();

      const direction =
        event.key ===
        "ArrowUp"
          ? 1
          : -1;

      target[
        definition.id
      ] =
        clampEditorValue(
          Number(
            target[
              definition.id
            ]
          ) +
          definition.step *
          direction,
          definition
        );

      renderValue();
    }
  );

  button.append(
    label,
    value
  );

  return button;
}

function shortTargetLabel(
  target
) {
  const value =
    String(
      target ?? ""
    ).toLowerCase();

  const map = {
    pitch: "pit",
    filter: "fil",
    cutoff: "fil",
    gain: "lvl",
    level: "lvl",
    pan: "pan",
    fm: "fm",
    fmdepth: "fm",
    fmratio: "fmr",
    noise: "nse"
  };

  return (
    map[value] ??
    value.slice(0, 3) ??
    "---"
  );
}

function shortWaveLabel(
  wave
) {
  const map = {
    sine: "sin",
    triangle: "tri",
    square: "sqr",
    sawUp: "sw+",
    sawDown: "sw-",
    random: "rnd",
    rise: "ris",
    fall: "fal"
  };

  return (
    map[wave] ??
    String(wave ?? "")
      .slice(0, 3)
  );
}

function createLfoStaticCell(
  labelText,
  valueText,
  extraClass = ""
) {
  const cell =
    document.createElement(
      "div"
    );

  cell.className =
    `mokton-lfo-cell ${extraClass}`
      .trim();

  const label =
    document.createElement(
      "span"
    );

  label.className =
    "mokton-lfo-cell-label";

  label.textContent =
    labelText;

  const value =
    document.createElement(
      "span"
    );

  value.className =
    "mokton-lfo-cell-value";

  value.textContent =
    valueText;

  cell.append(
    label,
    value
  );

  return cell;
}

function nearestOptionIndex(
  value,
  options
) {
  const numeric =
    Number(value);

  let bestIndex = 0;
  let bestDistance = Infinity;

  options.forEach(
    (option, index) => {
      const distance =
        Math.abs(
          Number(option) - numeric
        );

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
  );

  return bestIndex;
}

function enableVerticalChoiceSweep({
  button,
  values,
  getValue,
  setValue,
  normalizeValue = value => value,
  pixelsPerItem = 14,
  onRender
}) {
  let drag = null;

  button.style.touchAction = "none";

  button.addEventListener(
    "pointerdown",
    event => {
      if (
        event.button !== undefined &&
        event.button !== 0
      ) {
        return;
      }

      const current =
        normalizeValue(
          getValue()
        );

      drag = {
        pointerId:
          event.pointerId,
        startY:
          event.clientY,
        startIndex:
          Math.max(
            0,
            values.indexOf(
              current
            )
          ),
        lastIndex:
          Math.max(
            0,
            values.indexOf(
              current
            )
          ),
        saved: false
      };

      button.setPointerCapture?.(
        event.pointerId
      );
    }
  );

  button.addEventListener(
    "pointermove",
    event => {
      if (
        !drag ||
        drag.pointerId !==
          event.pointerId
      ) {
        return;
      }

      const delta =
        drag.startY -
        event.clientY;

      const offset =
        Math.round(
          delta /
          pixelsPerItem
        );

      const nextIndex =
        Math.min(
          values.length - 1,
          Math.max(
            0,
            drag.startIndex +
              offset
          )
        );

      if (
        nextIndex ===
        drag.lastIndex
      ) {
        return;
      }

      if (!drag.saved) {
        saveHistory();
        drag.saved = true;
      }

      drag.lastIndex =
        nextIndex;

      setValue(
        values[nextIndex]
      );

      onRender?.();
    }
  );

  const finish = event => {
    if (
      !drag ||
      drag.pointerId !==
        event.pointerId
    ) {
      return;
    }

    button.releasePointerCapture?.(
      event.pointerId
    );

    drag = null;
  };

  button.addEventListener(
    "pointerup",
    finish
  );

  button.addEventListener(
    "pointercancel",
    finish
  );

  button.addEventListener(
    "keydown",
    event => {
      if (
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown"
      ) {
        return;
      }

      event.preventDefault();

      const current =
        normalizeValue(
          getValue()
        );

      const currentIndex =
        Math.max(
          0,
          values.indexOf(
            current
          )
        );

      const direction =
        event.key === "ArrowUp"
          ? 1
          : -1;

      const nextIndex =
        Math.min(
          values.length - 1,
          Math.max(
            0,
            currentIndex +
              direction
          )
        );

      if (
        nextIndex ===
        currentIndex
      ) {
        return;
      }

      saveHistory();
      setValue(values[nextIndex]);
      onRender?.();
    }
  );
}

function createLfoRatePad(
  lfo
) {
  const button =
    document.createElement(
      "button"
    );

  button.type = "button";
  button.className =
    "mokton-direct-value-pad mokton-lfo-inline-value";

  const label =
    document.createElement(
      "span"
    );

  label.className =
    "mokton-direct-value-label";
  label.textContent = "rat";

  const value =
    document.createElement(
      "strong"
    );

  value.className =
    "mokton-direct-value-number";

  const renderValue = () => {
    if (
      lfo.syncMode === "bpm"
    ) {
      const index =
        Math.min(
          LFO_BPM_RATE_LABELS.length - 1,
          Math.max(
            0,
            Math.round(
              Number(lfo.rate) || 0
            )
          )
        );

      value.textContent =
        LFO_BPM_RATE_LABELS[index];
      return;
    }

    const storageValue =
      LFO_FREE_RATE_VALUES[
        nearestOptionIndex(
          lfo.rate,
          LFO_FREE_RATE_VALUES
        )
      ];

    const hz =
      storageValue / 10;

    value.textContent =
      `${Number.isInteger(hz) ? hz : hz.toFixed(1)}hz`;
  };

  renderValue();

  const values =
    lfo.syncMode === "bpm"
      ? Array.from(
          {
            length:
              LFO_BPM_RATE_LABELS.length
          },
          (_, index) => index
        )
      : [...LFO_FREE_RATE_VALUES];

  const normalizeValue =
    lfo.syncMode === "bpm"
      ? raw =>
          Math.min(
            LFO_BPM_RATE_LABELS.length - 1,
            Math.max(
              0,
              Math.round(
                Number(raw) || 0
              )
            )
          )
      : raw =>
          LFO_FREE_RATE_VALUES[
            nearestOptionIndex(
              raw,
              LFO_FREE_RATE_VALUES
            )
          ];

  enableVerticalChoiceSweep({
    button,
    values,
    getValue: () => lfo.rate,
    setValue: next => {
      lfo.rate = next;
    },
    normalizeValue,
    pixelsPerItem: 12,
    onRender: renderValue
  });

  button.append(
    label,
    value
  );

  return button;
}

function createLfoRow(
  lfoKey
) {
  const sound =
    selectedSound();

  const lfo =
    sound?.[
      lfoKey
    ];

  if (!lfo) {
    return null;
  }

  const row =
    document.createElement(
      "div"
    );

  row.className =
    "mokton-lfo-row";

  const title =
    document.createElement(
      "div"
    );

  title.className =
    "mokton-lfo-row-title";

  title.textContent =
    lfoKey;

  row.appendChild(
    title
  );

  const targetButton =
    document.createElement(
      "button"
    );

  targetButton.type =
    "button";

  targetButton.className =
    "mokton-lfo-cell mokton-lfo-target-cell";

  const targetLabel =
    document.createElement(
      "span"
    );

  targetLabel.className =
    "mokton-lfo-cell-label";
  targetLabel.textContent =
    "tgt";

  const targetValue =
    document.createElement(
      "span"
    );

  targetValue.className =
    "mokton-lfo-cell-value";

  const normalizeTarget = value => {
    const legacyMap = {
      gain: "level",
      fmDepth: "fm",
      cutoff: "filter"
    };

    const normalized =
      legacyMap[value] ?? value;

    return LFO_TARGETS.includes(
      normalized
    )
      ? normalized
      : "pitch";
  };

  const renderTarget = () => {
    targetValue.textContent =
      shortTargetLabel(
        lfo.target
      );
  };

  renderTarget();

  targetButton.append(
    targetLabel,
    targetValue
  );

  enableVerticalChoiceSweep({
    button: targetButton,
    values: LFO_TARGETS,
    getValue: () => lfo.target,
    setValue: next => {
      lfo.target = next;
    },
    normalizeValue: normalizeTarget,
    pixelsPerItem: 16,
    onRender: renderTarget
  });

  row.appendChild(
    targetButton
  );

  const waveButton =
    document.createElement(
      "button"
    );

  waveButton.type =
    "button";

  waveButton.className =
    "mokton-lfo-cell mokton-lfo-wave-cycle";

  const waveLabel =
    document.createElement(
      "span"
    );

  waveLabel.className =
    "mokton-lfo-cell-label";
  waveLabel.textContent =
    "wav";

  const waveValue =
    document.createElement(
      "span"
    );

  waveValue.className =
    "mokton-lfo-cell-value";

  const renderWave = () => {
    waveValue.replaceChildren(
      createLfoWaveIcon(
        lfo.wave
      )
    );
  };

  renderWave();

  waveButton.append(
    waveLabel,
    waveValue
  );

  enableVerticalChoiceSweep({
    button: waveButton,
    values: LFO_WAVES,
    getValue: () => lfo.wave,
    setValue: next => {
      lfo.wave = next;
    },
    normalizeValue: value =>
      LFO_WAVES.includes(value)
        ? value
        : "sine",
    pixelsPerItem: 16,
    onRender: renderWave
  });

  row.appendChild(
    waveButton
  );

  const depthDefinition = {
    id: "depth",
    label: "dep",
    min: 0,
    max: 100,
    step: 1
  };

  row.appendChild(
    createDirectValuePad(
      lfo,
      depthDefinition,
      {
        extraClass:
          "mokton-lfo-inline-value"
      }
    )
  );

  row.appendChild(
    createLfoRatePad(
      lfo
    )
  );

  const syncButton =
    document.createElement(
      "button"
    );

  syncButton.type =
    "button";

  syncButton.className =
    "mokton-lfo-cell mokton-lfo-sync-button";

  const syncLabel =
    document.createElement(
      "span"
    );

  syncLabel.className =
    "mokton-lfo-cell-label";
  syncLabel.textContent =
    "syn";

  const syncValue =
    document.createElement(
      "span"
    );

  syncValue.className =
    "mokton-lfo-cell-value";

  syncValue.textContent =
    lfo.syncMode === "bpm"
      ? "bpm"
      : "fre";

  syncButton.append(
    syncLabel,
    syncValue
  );

  syncButton.addEventListener(
    "click",
    () => {
      saveHistory();

      if (
        lfo.syncMode === "bpm"
      ) {
        lfo.syncMode = "free";

        if (
          !LFO_FREE_RATE_VALUES.includes(
            Number(lfo.rate)
          )
        ) {
          lfo.rate = 25;
        }
      } else {
        lfo.syncMode = "bpm";

        lfo.rate =
          Math.min(
            LFO_BPM_RATE_LABELS.length - 1,
            Math.max(
              0,
              Math.round(
                Number(lfo.rate) || 8
              )
            )
          );
      }

      renderEditor();
    }
  );

  row.appendChild(
    syncButton
  );

  return row;
}


function renderEditor() {
  if (!editor) {
    return;
  }

  editor.innerHTML =
    "";

  const root =
    document.createElement(
      "div"
    );

  root.className =
    "mokton-editor mokton-editor-compact mokton-editor-sound";

  const sounds =
    document.createElement(
      "div"
    );

  sounds.className =
    "mokton-compact-sounds";

  sounds.appendChild(
    createCompactSoundBank()
  );

  const selectedMs =
    createSelectedSoundMuteSolo();

  if (selectedMs) {
    sounds.appendChild(
      selectedMs
    );
  }

  root.appendChild(
    sounds
  );

  const sound =
    selectedSound();

  if (sound) {
    const pads =
      document.createElement(
        "div"
      );

    pads.className =
      "mokton-sound-parameter-values";

    soundDefinitions().forEach(
      definition => {
        pads.appendChild(
          createDirectValuePad(
            sound,
            definition
          )
        );
      }
    );

    root.appendChild(
      pads
    );

    const lfo1 =
      createLfoRow(
        "lfo1"
      );

    const lfo2 =
      createLfoRow(
        "lfo2"
      );

    if (lfo1) {
      root.appendChild(
        lfo1
      );
    }

    if (lfo2) {
      root.appendChild(
        lfo2
      );
    }
  }

  editor.appendChild(
    root
  );
}


/* =========================================================
 * 32 STEP / ONE TIMELINE
 * ========================================================= */

function createStepParameterStrip() {
  const row =
    document.createElement(
      "div"
    );

  row.className =
    "mokton-step-parameter-strip";

  stepDefinitions().forEach(
    definition => {
      const button =
        document.createElement(
          "button"
        );

      button.type =
        "button";

      button.className =
        "mokton-step-parameter-button";

      const isMelodicNoteSlot =
        state.selectedLayer === "melodic" &&
        definition.id === "note";

      const displayedDefinition =
        isMelodicNoteSlot &&
        selectedStepParameterId === "chord"
          ? STEP_CHORD_DEFINITION
          : definition;

      applyParameterLabel(
        button,
        displayedDefinition
      );

      button.classList.toggle(
        "active",
        selectedStepParameterId ===
          definition.id ||
        (
          isMelodicNoteSlot &&
          selectedStepParameterId === "chord"
        )
      );

      button.addEventListener(
        "click",
        () => {
          if (isMelodicNoteSlot) {
            if (
              selectedStepParameterId === "note"
            ) {
              selectedStepParameterId =
                "chord";
            } else if (
              selectedStepParameterId === "chord"
            ) {
              selectedStepParameterId =
                null;
            } else {
              selectedStepParameterId =
                "note";
            }
          } else {
            selectedStepParameterId =
              selectedStepParameterId ===
                definition.id
                ? null
                : definition.id;
          }

          /*
           * STEP <-> Offset is an editing-category change.
           * Rebuild the tool strip immediately so a clipboard icon from
           * the previous category cannot remain visually stale.
           */
          renderSequenceTools();
          renderSequence();
        }
      );

      row.appendChild(
        button
      );
    }
  );

  return row;
}


function toggleSelectedLayerAtStep(
  stepIndex
) {
  const step =
    currentStep(
      stepIndex
    );

  if (!step) {
    return;
  }

  const layer =
    state.selectedLayer;

  const currentSoundId =
    step[layer]?.soundId ??
    null;

  if (
    currentSoundId ===
      state.selectedSoundId
  ) {
    clearStepLayer(
      stepIndex,
      layer
    );

    window.dispatchEvent(
      new Event("projectchange")
    );

    return;
  }

  /*
   * 同Layerの別Soundが置かれていても、
   * 選択Soundで上書きする。
   * 1 STEP / 1 Layerにつき1 Sound。
   */
  placeSelectedSound(
    stepIndex
  );

  window.dispatchEvent(
    new Event("projectchange")
  );
}

function copyWholeStep(stepIndex) {
  if (
    !copyStepToEditClipboard(
      stepIndex
    )
  ) {
    return false;
  }

  selectedStepIndex =
    stepIndex;

  keepOnlyClipboardSource("step");

  clipboardSourceRange = {
    patternIndex:
      state.selectedPatternIndex,
    startIndex:
      stepIndex,
    endIndex:
      stepIndex
  };

  refreshClipboardUiEverywhere();

  renderSequenceTools();
  renderSequence();
  renderEditor();

  return true;
}

function pasteWholeStep(stepIndex) {
  if (
    !hasEditClipboard() ||
    !editClipboardOriginIsStep()
  ) {
    return false;
  }

  if (
    !pasteStepClipboardAt(
      stepIndex
    )
  ) {
    return false;
  }

  selectedStepIndex =
    stepIndex;

  /*
   * mono82 is now optimized for one-shot STEP paste:
   * a successful paste consumes the clipboard immediately.
   * Manual icon clear remains available before pasting.
   */
  clearEditClipboard();
  clipboardSourceRange = null;
  clearClipboardPreview();

  window.dispatchEvent(
    new Event("projectchange")
  );

  renderSequenceTools();
  renderSequence();
  renderEditor();

  return true;
}

function copyWholeStepRange(
  startIndex,
  endIndex
) {
  if (
    !copyStepRangeToEditClipboard(
      startIndex,
      endIndex
    )
  ) {
    return false;
  }

  selectedStepIndex =
    endIndex;

  keepOnlyClipboardSource("step");

  clipboardSourceRange = {
    patternIndex:
      state.selectedPatternIndex,
    startIndex:
      Math.min(
        startIndex,
        endIndex
      ),
    endIndex:
      Math.max(
        startIndex,
        endIndex
      )
  };

  refreshClipboardUiEverywhere();

  renderSequenceTools();
  renderSequence();
  renderEditor();

  return true;
}



function createStepButton(
  stepIndex
) {
  const step =
    currentStep(
      stepIndex
    );

  const button =
    document.createElement(
      "button"
    );

  button.type =
    "button";

  button.className =
    "mokton-step";

  button.dataset.stepIndex =
    String(stepIndex);

  const melodicSoundId =
    step?.melodic?.soundId ??
    null;

  const rhythmSoundId =
    step?.rhythm?.soundId ??
    null;

  button.classList.toggle(
    "has-melodic",
    Boolean(
      melodicSoundId
    )
  );

  button.classList.toggle(
    "has-rhythm",
    Boolean(
      rhythmSoundId
    )
  );

  const playingStep =
    state.playbackTickIndex ===
      null
      ? -1
      : state.playbackTickIndex %
        STEP_COUNT;

  button.classList.toggle(
    "playing",
    playingStep ===
      stepIndex
  );

  button.classList.toggle(
    "selected",
    selectedStepIndex ===
      stepIndex
  );

  const activeClipboardRange = selectedStepParameterId
    ? layerClipboardSourceRanges[state.selectedLayer]
    : clipboardSourceRange;

  const clipboardSourceActive =
    Boolean(activeClipboardRange) &&
    activeClipboardRange.patternIndex === state.selectedPatternIndex &&
    stepIndex >= activeClipboardRange.startIndex &&
    stepIndex <= activeClipboardRange.endIndex;

  button.classList.toggle(
    "clipboard-source",
    Boolean(
      clipboardSourceActive
    )
  );

  const number =
    document.createElement(
      "span"
    );

  number.className =
    "mokton-step-number";

  number.textContent =
    String(
      stepIndex + 1
    ).padStart(
      2,
      "0"
    );

  const visual =
    document.createElement(
      "span"
    );

  visual.className =
    "mokton-step-visual";

  const offsetDefinition =
    activeStepOffsetDefinition();

  let offsetPerformance =
    step?.[
      state.selectedLayer
    ];

  const offsetLayerOccupiedByOtherSound =
    Boolean(
      offsetDefinition &&
      offsetPerformance?.soundId &&
      offsetPerformance.soundId !==
        state.selectedSoundId
    );

  const canEditOffset =
    Boolean(
      offsetDefinition &&
      offsetPerformance?.soundId ===
        state.selectedSoundId
    );

  let offsetValue =
    null;

  if (offsetDefinition) {
    button.classList.add(
      "offset-view"
    );

    offsetValue =
      document.createElement(
        "span"
      );

    offsetValue.className =
      "mokton-step-offset-value";

    if (canEditOffset) {
      renderStepOffsetValue(
        offsetValue,
        offsetDefinition,
        offsetPerformance[
          offsetDefinition.id
        ],
        offsetPerformance
      );

      button.classList.add(
        "offset-active"
      );
    } else if (
      offsetLayerOccupiedByOtherSound
    ) {
      offsetValue.textContent =
        "▪";

      offsetValue.classList.add(
        "occupied-by-other-sound"
      );

      button.classList.add(
        "offset-occupied"
      );
    } else {
      offsetValue.textContent =
        "";
    }

    visual.appendChild(
      offsetValue
    );
  } else {
    const melodicMark =
      document.createElement(
        "span"
      );

    melodicMark.className =
      "mokton-step-melodic-mark";

    melodicMark.classList.toggle(
      "active",
      Boolean(
        melodicSoundId
      )
    );

    melodicMark.classList.toggle(
      "selected-sound",
      melodicSoundId ===
        state.selectedSoundId
    );

    const rhythmMark =
      document.createElement(
        "span"
      );

    rhythmMark.className =
      "mokton-step-rhythm-mark";

    rhythmMark.classList.toggle(
      "active",
      Boolean(
        rhythmSoundId
      )
    );

    rhythmMark.classList.toggle(
      "selected-sound",
      rhythmSoundId ===
        state.selectedSoundId
    );

    visual.append(
      melodicMark,
      rhythmMark
    );
  }

  button.append(
    visual
  );

  /*
   * Dedicated STEP clipboard-range marker.
   * Do not reuse ::before/::after because those pseudo-elements are also
   * used by selection/playback rules elsewhere in the accumulated CSS.
   */
  const clipboardMarker =
    document.createElement(
      "span"
    );

  clipboardMarker.className =
    "mokton-step-clipboard-marker";

  clipboardMarker.setAttribute(
    "aria-hidden",
    "true"
  );

  /*
   * Do not rely only on accumulated CSS class rules for visibility.
   * The marker is explicitly shown for the copied source range and
   * temporarily shown by setClipboardPreviewRange() while sweeping.
   */
  clipboardMarker.hidden =
    !clipboardSourceActive;

  button.append(
    clipboardMarker
  );

  let offsetDrag =
    null;

  let offsetGestureMoved =
    false;

  /*
   * Offset編集でpointerdown時に空STEP／別Soundから
   * 現在Soundを配置したかをclickまで保持する。
   * 1タップ目で配置した直後に、そのclickでOFFへ戻るのを防ぐ。
   */
  let offsetPlacedOnPointerDown =
    false;

  let clipGesture = null;
  let clipGestureCompleted = false;

  button.addEventListener(
    "pointerdown",
    event => {
      if (
        !offsetDefinition &&
        !hasEditClipboard() &&
        singleTapTimer
      ) {
        clearTimeout(
          singleTapTimer
        );

        singleTapTimer =
          null;

        clipGesture = {
          startIndex: stepIndex,
          endIndex: stepIndex,
          pointerId: event.pointerId
        };

        clipGestureCompleted =
          false;

        setClipboardPreviewRange(
          stepIndex,
          stepIndex
        );

        button.setPointerCapture?.(
          event.pointerId
        );

        event.preventDefault();
        return;
      }

      if (!offsetDefinition) {
        return;
      }

      /* Offset Edit: current layer has its own independent clipboard. */
      if (hasLayerClipboard(state.selectedLayer)) {
        return;
      }

      const now = Date.now();
      if (
        lastOffsetTap.index === stepIndex &&
        lastOffsetTap.layer === state.selectedLayer &&
        now - lastOffsetTap.time < 320
      ) {
        /* Undo the first tap's UI mutation before taking the clipboard. */
        const targetStep = currentStep(stepIndex);
        if (targetStep && lastOffsetTap.original) {
          targetStep[state.selectedLayer] = structuredClone(lastOffsetTap.original);
        }
        lastOffsetTap = { index: null, layer: null, time: 0, original: null };
        clipGesture = { startIndex: stepIndex, endIndex: stepIndex, pointerId: event.pointerId, layerOnly: true };
        setClipboardPreviewRange(stepIndex, stepIndex);
        button.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      lastOffsetTap = {
        index: stepIndex,
        layer: state.selectedLayer,
        time: now,
        original: structuredClone(currentStep(stepIndex)?.[state.selectedLayer] ?? null)
      };

      /*
       * Clipboard保持中は従来どおりpasteを優先する。
       */
      if (
        hasEditClipboard() &&
        editClipboardOriginIsStep()
      ) {
        return;
      }

      offsetGestureMoved =
        false;

      offsetPlacedOnPointerDown =
        false;

      let placedOnPointerDown =
        false;

      if (
        offsetPerformance?.soundId !==
          state.selectedSoundId
      ) {
        /*
         * Offset編集では、空STEPも同Layerの別Soundも
         * pointerdown時点で現在Soundへ置き換える。
         * placeSelectedSound() 側で履歴保存も行われるため、
         * そのまま続くスイープを同じUndo単位へまとめる。
         */
        if (
          !placeSelectedSound(
            stepIndex
          )
        ) {
          return;
        }

        placedOnPointerDown =
          true;

        offsetPlacedOnPointerDown =
          true;

        offsetPerformance =
          currentStep(
            stepIndex
          )?.[
            state.selectedLayer
          ] ?? null;

        if (!offsetPerformance) {
          return;
        }

        selectedStepIndex =
          stepIndex;

        button.classList.remove(
          "offset-occupied"
        );

        button.classList.add(
          "offset-active"
        );

        offsetValue?.classList.remove(
          "occupied-by-other-sound"
        );

        if (offsetValue) {
          renderStepOffsetValue(
            offsetValue,
            offsetDefinition,
            offsetPerformance[
              offsetDefinition.id
            ],
            offsetPerformance
          );
        }
      }

      offsetDrag = {
        startY:
          event.clientY,
        startValue:
          offsetDefinition.id === "chord"
            ? stepChordIndex(
                offsetPerformance?.chord
              )
            : (
                Number(
                  offsetPerformance?.[
                    offsetDefinition.id
                  ]
                ) || 0
              ),
        saved:
          placedOnPointerDown
      };

      button.setPointerCapture?.(
        event.pointerId
      );
    }
  );

  button.addEventListener(
    "pointermove",
    event => {
      if (clipGesture) {
        const target =
          document.elementFromPoint(
            event.clientX,
            event.clientY
          )?.closest?.(
            ".mokton-step"
          );

        const targetIndex =
          Number(
            target?.dataset?.stepIndex
          );

        if (
          Number.isInteger(
            targetIndex
          ) &&
          targetIndex >= 0 &&
          targetIndex < STEP_COUNT
        ) {
          clipGesture.endIndex =
            targetIndex;

          setClipboardPreviewRange(
            clipGesture.startIndex,
            clipGesture.endIndex
          );
        }

        event.preventDefault();
        return;
      }

      if (
        !offsetDrag ||
        !offsetDefinition
      ) {
        return;
      }

      const delta =
        offsetDrag.startY -
        event.clientY;

      const units =
        Math.round(
          delta / 7
        );

      if (!units) {
        return;
      }

      offsetGestureMoved =
        true;

      if (!offsetDrag.saved) {
        saveHistory();
        offsetDrag.saved =
          true;
      }

      const next =
        dragValueWithCenterSnap(
          offsetDrag.startValue,
          delta,
          offsetDefinition
        );

      offsetPerformance[
        offsetDefinition.id
      ] =
        offsetDefinition.id === "chord"
          ? (
              STEP_CHORD_NAMES[next] ??
              "off"
            )
          : next;

      if (offsetValue) {
        renderStepOffsetValue(
          offsetValue,
          offsetDefinition,
          next,
          offsetPerformance
        );
      }
    }
  );

  const finishOffsetDrag = (
    event
  ) => {
    if (clipGesture) {
      button.releasePointerCapture?.(
        event.pointerId
      );

      const {
        startIndex,
        endIndex,
        layerOnly = false
      } = clipGesture;

      clipGesture = null;
      clipGestureCompleted =
        true;

      /*
       * Prevent the trailing synthetic click from turning the just-created
       * clipboard into an immediate paste/clear after renderSequence().
       */
      suppressTrailingSequenceClick();

      clearClipboardPreview();

      if (layerOnly) {
        const layer = state.selectedLayer;
        copyLayerRangeToClipboard(layer, startIndex, endIndex);
        keepOnlyClipboardSource(`layer-${layer}`);
        layerClipboardSourceRanges[layer] = {
          patternIndex: state.selectedPatternIndex,
          startIndex: Math.min(startIndex, endIndex),
          endIndex: Math.max(startIndex, endIndex)
        };
        refreshClipboardUiEverywhere();
        renderSequenceTools();
        renderSequence();
      } else if (startIndex === endIndex) {
        copyWholeStep(startIndex);
      } else {
        copyWholeStepRange(startIndex, endIndex);
      }

      event.preventDefault();
      return;
    }

    if (!offsetDrag) {
      return;
    }

    button.releasePointerCapture?.(
      event.pointerId
    );

    offsetDrag =
      null;

    /*
     * スイープ時はclick側が再描画を抑止するため、
     * pointerupで現在状態を確定表示する。
     */
    if (offsetGestureMoved) {
      /*
       * saveHistory() is intentionally called before the first mutation so
       * Undo can restore the pre-drag state. That event must NOT be the only
       * autosave trigger: a long sweep may continue after the debounce timer
       * has already saved an intermediate value.
       *
       * Emit projectchange here, after the finger is released and the final
       * offset/chord value is settled.
       */
      window.dispatchEvent(
        new Event("projectchange")
      );

      renderSequence();
      renderEditor();
    }
  };

  button.addEventListener(
    "pointerup",
    finishOffsetDrag
  );

  button.addEventListener(
    "pointercancel",
    finishOffsetDrag
  );

  let singleTapTimer =
    null;

  button.addEventListener(
    "click",
    event => {
      if (
        sequenceClickIsSuppressed()
      ) {
        event.preventDefault();
        event.stopPropagation();
        clipGestureCompleted =
          false;
        return;
      }

      if (clipGestureCompleted) {
        clipGestureCompleted =
          false;
        return;
      }

      /*
       * Clipboard保持中は1タップ＝paste。
       * 通常時はdouble tap判定待ちのため、
       * single tap動作を少しだけ遅延する。
       */
      if (
        hasEditClipboard() &&
        editClipboardOriginIsStep()
      ) {
        if (singleTapTimer) {
          clearTimeout(
            singleTapTimer
          );

          singleTapTimer =
            null;
        }

        pasteWholeStep(
          stepIndex
        );

        return;
      }

      if (
        selectedStepParameterId &&
        hasLayerClipboard(state.selectedLayer)
      ) {
        const layer = state.selectedLayer;
        if (pasteLayerClipboardAt(layer, stepIndex)) {
          clearLayerClipboard(layer);
          layerClipboardSourceRanges[layer] = null;
          window.dispatchEvent(new Event("projectchange"));
          renderSequenceTools(); renderSequence(); renderEditor();
        }
        return;
      }

      if (
        selectedStepParameterId
      ) {
        if (offsetGestureMoved) {
          offsetGestureMoved =
            false;
          offsetPlacedOnPointerDown =
            false;
          return;
        }

        selectedStepIndex =
          stepIndex;

        /*
         * 空STEP／別Soundはpointerdownですでに現在Soundへ
         * 配置・置換済み。ここでtoggleすると即OFFへ戻るため、
         * その1タップ目だけはON状態を維持する。
         *
         * もともと現在Soundが置かれていたSTEPの単純タップは
         * Offset編集画面内でも通常どおりON/OFFできる。
         */
        if (offsetPlacedOnPointerDown) {
          offsetPlacedOnPointerDown =
            false;

          renderSequence();
          renderEditor();
          return;
        }

        toggleSelectedLayerAtStep(
          stepIndex
        );

        renderSequence();
        renderEditor();

        return;
      }

      if (
        event.detail >= 2
      ) {
        if (singleTapTimer) {
          clearTimeout(
            singleTapTimer
          );

          singleTapTimer =
            null;
        }

        copyWholeStep(
          stepIndex
        );

        return;
      }

      if (singleTapTimer) {
        clearTimeout(
          singleTapTimer
        );
      }

      singleTapTimer =
        setTimeout(
          () => {
            singleTapTimer =
              null;

            selectedStepIndex =
              stepIndex;

            toggleSelectedLayerAtStep(
              stepIndex
            );

            renderSequence();
          },
          220
        );
    }
  );

  button.addEventListener(
    "dblclick",
    event => {
      event.preventDefault();

      if (
        selectedStepParameterId
      ) {
        return;
      }

      if (
        hasEditClipboard() &&
        editClipboardOriginIsStep()
      ) {
        return;
      }

      if (singleTapTimer) {
        clearTimeout(
          singleTapTimer
        );

        singleTapTimer =
          null;
      }

      copyWholeStep(
        stepIndex
      );
    }
  );

  return button;
}

export function renderSequence() {
  if (!sequenceGrid) {
    return;
  }

  sequenceGrid.innerHTML =
    "";

  const wrapper =
    document.createElement(
      "div"
    );

  wrapper.className =
    "mokton-sequence";

  for (
    let stepIndex = 0;
    stepIndex <
      STEP_COUNT;
    stepIndex++
  ) {
    wrapper.appendChild(
      createStepButton(
        stepIndex
      )
    );
  }

  sequenceGrid.appendChild(
    wrapper
  );

  sequenceGrid.appendChild(
    createStepParameterStrip()
  );

  /*
   * renderSequence() replaces the STEP DOM.
   * Re-bind previousPlayingStep immediately so the next playback tick
   * removes the highlight from the current live element, not from
   * an already detached old element.
   */
  updatePlayingStep();
}


function renderPatternLoopButton() {
  if (!patternLoopButton) {
    return;
  }

  const active =
    Boolean(
      state.patternLoopEnabled
    );

  patternLoopButton.classList.toggle(
    "active",
    active
  );

  patternLoopButton.setAttribute(
    "aria-pressed",
    String(active)
  );
}

patternLoopButton?.addEventListener(
  "click",
  () => {
    const enabled =
      togglePatternLoop();

    if (enabled) {
      applyPatternRangeToLoop();
    } else {
      clearPatternLoopRange();
    }

    renderPatternLoopButton();
    renderPatternManager();
  }
);

patternEditButton?.addEventListener(
  "click",
  () => {
    selectedStepIndex =
      null;

    setAppView(
      "sequence"
    );

    renderCurrentSourceDisplay();
    renderSequence();
    renderPatternManager();
    renderEditor();
  }
);


let patternRangeAnchorIndex =
  null;

let patternRangeEndIndex =
  null;

function selectedPatternRange() {
  if (
    patternRangeAnchorIndex ===
      null ||
    patternRangeEndIndex ===
      null
  ) {
    return null;
  }

  const order =
    normalizePatternOrder();

  const startPosition =
    order.indexOf(
      patternRangeAnchorIndex
    );

  const endPosition =
    order.indexOf(
      patternRangeEndIndex
    );

  if (
    startPosition < 0 ||
    endPosition < 0
  ) {
    return null;
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

  return order.slice(
    from,
    to + 1
  );
}

function clearPatternRangeSelection() {
  patternRangeAnchorIndex =
    null;

  patternRangeEndIndex =
    null;

  clearPatternLoopRange();
}

function applyPatternRangeToLoop() {
  const range =
    selectedPatternRange();

  if (
    !range ||
    range.length < 2
  ) {
    clearPatternLoopRange();
    return;
  }

  setPatternLoopRange(
    range[0],
    range[
      range.length - 1
    ]
  );
}


/* =========================================================
 * Pattern 01-40
 *
 * Pattern ID is fixed.
 * song.order controls playback/display order only.
 * tap        = select
 * vertical   = repeat
 * long press = reorder
 * ========================================================= */

let patternDragState =
  null;

function normalizePatternOrder() {
  const valid =
    Array.from(
      { length: patterns.length },
      (_, index) => index
    );

  const existing =
    Array.isArray(song.order)
      ? song.order.filter(
          index =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < patterns.length
        )
      : [];

  const seen =
    new Set();

  const order =
    existing.filter(index => {
      if (seen.has(index)) {
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

function movePatternOrder(
  fromPatternIndex,
  toPatternIndex
) {
  const order =
    normalizePatternOrder();

  const from =
    order.indexOf(
      fromPatternIndex
    );

  const to =
    order.indexOf(
      toPatternIndex
    );

  if (
    from < 0 ||
    to < 0 ||
    from === to
  ) {
    return false;
  }

  saveHistory();

  const [
    moved
  ] =
    order.splice(
      from,
      1
    );

  order.splice(
    to,
    0,
    moved
  );

  song.order =
    order;

  return true;
}

function clearPatternDragVisuals() {
  patternGrid
    ?.querySelectorAll(
      ".dragging, .drop-target"
    )
    .forEach(
      element => {
        element.classList.remove(
          "dragging",
          "drop-target"
        );
      }
    );
}

function patternButtonAtPoint(
  x,
  y
) {
  return document
    .elementFromPoint(
      x,
      y
    )
    ?.closest(
      ".mokton-pattern-button"
    ) ??
    null;
}

function refreshPatternRangeVisuals() {
  if (!patternGrid) {
    return;
  }

  const range =
    selectedPatternRange();

  const activeLoopRange =
    patternLoopRange();

  patternGrid
    .querySelectorAll(
      ".mokton-pattern-button"
    )
    .forEach(button => {
      const index =
        Number(
          button.dataset
            .patternIndex
        );

      button.classList.toggle(
        "range-selected",
        Boolean(
          range?.includes(index)
        )
      );

      button.classList.toggle(
        "loop-range-active",
        Boolean(
          state.patternLoopEnabled &&
          activeLoopRange?.includes(
            index
          )
        )
      );
    });
}

function renderPatternClipboardUi() {
  const toolbar = document.querySelector(
    ".pattern-section .section-toolbar"
  );

  if (!toolbar) {
    return;
  }

  toolbar
    .querySelector(
      ".mokton-pattern-clip-button"
    )
    ?.remove();

  if (
    appView !== "pattern" ||
    !hasPatternClipboard()
  ) {
    return;
  }

  let clipCleared =
    false;

  const clearPatternClipboardUi =
    () => {
      if (clipCleared) {
        return;
      }

      clipCleared =
        true;

      clearPatternClipboard();
      patternClipboardSourceRange =
        null;

      /*
       * Do not rebuild toolbar order when clearing.
       * Only remove clipboard UI and refresh pattern cells.
       */
      button.remove();
      renderPatternManager();
    };

  const button =
    createMiniButton(
      "clip",
      clearPatternClipboardUi,
      {
        title:
          "clear pattern clipboard"
      }
    );

  button.classList.add(
    "mokton-clip-button",
    "mokton-pattern-clip-button"
  );

  button.replaceChildren(
    createMono82Icon(
      "clipboard",
      "mono82-clipboard-icon"
    )
  );

  button.addEventListener(
    "pointerup",
    event => {
      event.preventDefault();
      event.stopPropagation();
      clearPatternClipboardUi();
    }
  );

  /*
   * Fixed overlay slot: right-from-second column of the
   * 8-column pattern grid, immediately left of Loop.
   * Because it is absolutely positioned, Pattern Edit never moves.
   */
  toolbar.append(button);
}

function patternClipboardIndexes(startIndex, endIndex) {
  const order = normalizePatternOrder();
  const a = order.indexOf(startIndex), b = order.indexOf(endIndex);
  if (a < 0 || b < 0) return [startIndex];
  return order.slice(Math.min(a,b), Math.max(a,b)+1);
}

function createPatternButton(
  patternIndex
) {
  const pattern =
    patterns[
      patternIndex
    ];

  const button =
    document.createElement(
      "button"
    );

  button.type =
    "button";

  button.className =
    "mokton-pattern-button";

  button.dataset.patternIndex =
    String(
      patternIndex
    );

  const id =
    document.createElement(
      "span"
    );

  id.className =
    "mokton-pattern-id";

  id.textContent =
    sourceHasData(
      pattern
    )
      ? patternLabel(
          patternIndex
        )
      : "▪";

  const preview =
    document.createElement(
      "span"
    );

  preview.className =
    "mokton-pattern-preview";

  const sequence =
    Array.isArray(pattern?.sequence)
      ? pattern.sequence
      : [];

  for (
    let stepIndex = 0;
    stepIndex < STEP_COUNT;
    stepIndex += 1
  ) {
    const step =
      sequence[stepIndex];

    const miniStep =
      document.createElement(
        "span"
      );

    miniStep.className =
      "mokton-pattern-preview-step";

    miniStep.dataset.stepIndex =
      String(stepIndex);

    /*
     * Song preview deliberately ignores Layer/Sound identity.
     * Any content in either layer = one foreground square.
     */
    miniStep.classList.toggle(
      "occupied",
      Boolean(
        step?.melodic?.soundId ||
        step?.rhythm?.soundId
      )
    );

    preview.appendChild(
      miniStep
    );
  }

  const header =
    document.createElement(
      "span"
    );

  header.className =
    "mokton-pattern-header";

  header.append(
    id
  );

  button.append(
    header,
    preview
  );

  const clipMarker = document.createElement("span");
  clipMarker.className = "mokton-pattern-clipboard-marker";
  clipMarker.setAttribute("aria-hidden", "true");
  const src = patternClipboardSourceRange;
  clipMarker.hidden = !(src && patternClipboardIndexes(src.startIndex, src.endIndex).includes(patternIndex));
  button.appendChild(clipMarker);

  button.classList.toggle(
    "has-data",
    sourceHasData(
      pattern
    )
  );

  button.classList.toggle(
    "selected",
    state.selectedPatternIndex ===
      patternIndex
  );

  const range =
    selectedPatternRange();

  button.classList.toggle(
    "range-selected",
    Boolean(
      range?.includes(
        patternIndex
      )
    )
  );

  const activeLoopRange =
    patternLoopRange();

  button.classList.toggle(
    "loop-range-active",
    Boolean(
      state.patternLoopEnabled &&
      activeLoopRange?.includes(
        patternIndex
      )
    )
  );

  let startX =
    0;

  let startY =
    0;

  let moved =
    false;

  let rangeSelecting =
    false;

  let longPressTimer =
    null;

  const stopLongPress = () => {
    if (!longPressTimer) {
      return;
    }

    clearTimeout(
      longPressTimer
    );

    longPressTimer =
      null;
  };

  button.addEventListener(
    "pointerdown",
    event => {
      if (
        event.button !==
        undefined &&
        event.button !== 0
      ) {
        return;
      }

      const now = Date.now();
      if (!hasPatternClipboard() && lastPatternTap.index === patternIndex && now - lastPatternTap.time < 320) {
        lastPatternTap = { index: null, time: 0 };
        patternClipGesture = { startIndex: patternIndex, endIndex: patternIndex, pointerId: event.pointerId };
        button.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      lastPatternTap = { index: patternIndex, time: now };

      startX =
        event.clientX;

      startY =
        event.clientY;

      moved =
        false;

      rangeSelecting =
        false;

      patternDragState =
        null;

      button.setPointerCapture?.(
        event.pointerId
      );

      longPressTimer =
        setTimeout(
          () => {
            longPressTimer =
              null;

            patternDragState = {
              pointerId:
                event.pointerId,

              patternIndex
            };

            button.classList.add(
              "dragging"
            );
          },
          420
        );
    }
  );

  button.addEventListener(
    "pointermove",
    event => {
      if (patternClipGesture?.pointerId === event.pointerId) {
        const target = patternButtonAtPoint(event.clientX, event.clientY);
        const targetIndex = Number(target?.dataset?.patternIndex);
        if (Number.isInteger(targetIndex)) {
          patternClipGesture.endIndex = targetIndex;
          const preview = new Set(patternClipboardIndexes(patternClipGesture.startIndex, targetIndex));
          patternGrid?.querySelectorAll(".mokton-pattern-button").forEach(el => {
            el.classList.toggle("clipboard-preview", preview.has(Number(el.dataset.patternIndex)));
          });
        }
        event.preventDefault();
        return;
      }

      const dx =
        event.clientX -
        startX;

      const dy =
        event.clientY -
        startY;

      const distance =
        Math.hypot(
          dx,
          dy
        );

      if (
        patternDragState?.patternIndex ===
        patternIndex
      ) {
        const target =
          patternButtonAtPoint(
            event.clientX,
            event.clientY
          );

        patternGrid
          ?.querySelectorAll(
            ".drop-target"
          )
          .forEach(
            element => {
              element.classList.remove(
                "drop-target"
              );
            }
          );

        if (
          target &&
          target !== button
        ) {
          target.classList.add(
            "drop-target"
          );
        }

        return;
      }

      if (
        distance > 8
      ) {
        moved =
          true;
      }

      /*
       * Start range selection with a horizontal gesture.
       * Once started, keep following the finger across rows as well.
       * Do not re-render the Pattern grid while the pointer is captured:
       * replacing the active button mid-gesture breaks pointer tracking on iOS.
       */
      if (
        rangeSelecting ||
        (
          Math.abs(dx) >
            12 &&
          Math.abs(dx) >
            Math.abs(dy)
        )
      ) {
        stopLongPress();

        const rangeSelectingWasStarted =
          rangeSelecting;

        rangeSelecting =
          true;

        /*
         * Every new range gesture owns a fresh anchor.
         * A previous 01-03 selection must not leak into a later 17-20 sweep.
         */
        if (!rangeSelectingWasStarted) {
          patternRangeAnchorIndex =
            patternIndex;

          patternRangeEndIndex =
            patternIndex;

          selectPattern(
            patternIndex
          );

          if (
            state.isPlaying &&
            state.playingPatternIndex !==
              patternIndex
          ) {
            queuePattern(
              patternIndex
            );
          }
        }

        const target =
          patternButtonAtPoint(
            event.clientX,
            event.clientY
          );

        const targetIndex =
          Number(
            target?.dataset
              ?.patternIndex
          );

        if (
          Number.isInteger(
            targetIndex
          )
        ) {
          patternRangeEndIndex =
            targetIndex;

          if (
            state.patternLoopEnabled
          ) {
            applyPatternRangeToLoop();
          }

          refreshPatternRangeVisuals();
        }

        return;
      }

    }
  );

  const finishPointer =
    event => {
      stopLongPress();

      if (patternClipGesture?.pointerId === event.pointerId) {
        const { startIndex, endIndex } = patternClipGesture;
        patternClipGesture = null;
        const indexes = patternClipboardIndexes(startIndex, endIndex);
        copyPatternRangeToClipboard(indexes);
        keepOnlyClipboardSource("pattern");
        patternClipboardSourceRange = { startIndex, endIndex };
        refreshClipboardUiEverywhere();
        renderPatternManager();
        event.preventDefault();
        return;
      }

      if (hasPatternClipboard()) {
        if (pastePatternClipboardAt(patternIndex)) {
          clearPatternClipboard(); patternClipboardSourceRange = null;
          window.dispatchEvent(new Event("projectchange"));
          renderPatternManager();
        }
        return;
      }

      if (
        patternDragState?.patternIndex ===
        patternIndex
      ) {
        const target =
          patternButtonAtPoint(
            event.clientX,
            event.clientY
          );

        const targetIndex =
          Number(
            target?.dataset
              ?.patternIndex
          );

        if (
          Number.isInteger(
            targetIndex
          ) &&
          targetIndex !==
            patternIndex
        ) {
          movePatternOrder(
            patternIndex,
            targetIndex
          );
        }

        patternDragState =
          null;

        clearPatternDragVisuals();
        renderPatternManager();

        return;
      }

      if (
        rangeSelecting
      ) {
        if (
          state.patternLoopEnabled
        ) {
          applyPatternRangeToLoop();
        }

        refreshPatternRangeVisuals();
        return;
      }

      if (moved) {
        return;
      }

      clearPatternRangeSelection();

      if (
        !selectPattern(
          patternIndex
        )
      ) {
        return;
      }

      /*
       * Song view tap = playback target selection.
       * During playback, switch at the next Pattern boundary;
       * after the jump, normal song.order progression continues
       * from the newly selected Pattern.
       */
      if (
        state.isPlaying &&
        state.playingPatternIndex !==
          patternIndex
      ) {
        queuePattern(
          patternIndex
        );
      }

      renderCurrentSourceDisplay();
      renderPatternManager();
    };

  button.addEventListener(
    "pointerup",
    finishPointer
  );

  button.addEventListener(
    "pointercancel",
    event => {
      stopLongPress();

      if (
        patternDragState?.patternIndex ===
        patternIndex
      ) {
        patternDragState =
          null;

        clearPatternDragVisuals();
      }

      button.releasePointerCapture?.(
        event.pointerId
      );
    }
  );

  return button;
}

export function renderPatternManager() {
  renderPatternLoopButton();
  renderPatternClipboardUi();

  if (!patternGrid) {
    return;
  }

  patternGrid.innerHTML =
    "";

  normalizePatternOrder()
    .forEach(
      patternIndex => {
        patternGrid.appendChild(
          createPatternButton(
            patternIndex
          )
        );
      }
    );
}


/* =========================================================
 * Playback highlight
 * ========================================================= */

let previousPlayingStep =
  null;

/*
 * AudioはWeb Audioへ先行予約される一方、main.jsのtickは
 * メインスレッド上で動く。
 *
 * pointermove等でUI処理が一時的に詰まると、予約済みAudioは
 * 正しい時刻で先へ進めるが、tick由来の表示更新だけが遅れる。
 *
 * そのため再生ハイライトは「tickを何回処理したか」ではなく、
 * Audio予約時に使ったplannedPerformanceTimeと同じ時刻表を持つ。
 * タイマーが遅延した場合も、復帰時に期限切れ予約をまとめて消化し、
 * 最新の実発声位置へ一度で追いつく。
 */
let visualPlayingStepIndex =
  null;

let scheduledPlayingSteps =
  [];

let playingStepTimer =
  null;

function paintPlayingStep(
  stepIndex
) {
  previousPlayingStep
    ?.classList.remove(
      "playing"
    );

  previousPlayingStep =
    null;

  visualPlayingStepIndex =
    Number.isFinite(stepIndex)
      ? (
          Math.round(stepIndex) %
          STEP_COUNT +
          STEP_COUNT
        ) % STEP_COUNT
      : null;

  /*
   * Song overview uses the exact same scheduled visual step as
   * Pattern Edit, so the accent travels through the 8x4 mini preview.
   */
  patternGrid
    ?.querySelectorAll(
      ".mokton-pattern-preview-step.playing"
    )
    .forEach(
      element => {
        element.classList.remove(
          "playing"
        );
      }
    );

  if (
    visualPlayingStepIndex ===
    null
  ) {
    return;
  }

  const element =
    sequenceGrid?.querySelector(
      `.mokton-step[data-step-index="${visualPlayingStepIndex}"]`
    );

  if (element) {
    element.classList.add(
      "playing"
    );

    previousPlayingStep =
      element;
  }

  if (
    state.isPlaying &&
    Number.isInteger(
      state.playingPatternIndex
    )
  ) {
    const miniStep =
      patternGrid?.querySelector(
        `.mokton-pattern-button[data-pattern-index="${state.playingPatternIndex}"] ` +
        `.mokton-pattern-preview-step[data-step-index="${visualPlayingStepIndex}"]`
      );

    miniStep?.classList.add(
      "playing"
    );
  }
}

function armPlayingStepTimer() {
  if (playingStepTimer !== null) {
    clearTimeout(
      playingStepTimer
    );

    playingStepTimer =
      null;
  }

  if (
    !state.isPlaying ||
    scheduledPlayingSteps.length === 0
  ) {
    return;
  }

  const now =
    window.performance.now();

  const delay =
    Math.max(
      0,
      scheduledPlayingSteps[0]
        .plannedPerformanceTime -
        now
    );

  playingStepTimer =
    setTimeout(
      flushScheduledPlayingSteps,
      delay
    );
}

function flushScheduledPlayingSteps() {
  playingStepTimer =
    null;

  if (!state.isPlaying) {
    scheduledPlayingSteps =
      [];

    return;
  }

  const now =
    window.performance.now();

  let latestStepIndex =
    null;

  while (
    scheduledPlayingSteps.length > 0 &&
    scheduledPlayingSteps[0]
      .plannedPerformanceTime <=
      now + 1
  ) {
    latestStepIndex =
      scheduledPlayingSteps.shift()
        .stepIndex;
  }

  if (
    latestStepIndex !== null
  ) {
    paintPlayingStep(
      latestStepIndex
    );
  }

  armPlayingStepTimer();
}

export function schedulePlayingStepDisplay(
  stepIndex,
  plannedPerformanceTime
) {
  if (!state.isPlaying) {
    return;
  }

  const normalizedStepIndex =
    (
      Math.round(
        Number(stepIndex) || 0
      ) % STEP_COUNT +
      STEP_COUNT
    ) % STEP_COUNT;

  const normalizedTime =
    Number.isFinite(
      plannedPerformanceTime
    )
      ? plannedPerformanceTime
      : window.performance.now();

  const duplicate =
    scheduledPlayingSteps.some(
      item =>
        item.stepIndex ===
          normalizedStepIndex &&
        Math.abs(
          item.plannedPerformanceTime -
          normalizedTime
        ) < 0.5
    );

  if (!duplicate) {
    scheduledPlayingSteps.push({
      stepIndex:
        normalizedStepIndex,
      plannedPerformanceTime:
        normalizedTime
    });

    scheduledPlayingSteps.sort(
      (a, b) =>
        a.plannedPerformanceTime -
        b.plannedPerformanceTime
    );
  }

  flushScheduledPlayingSteps();
}

export function resetPlayingStepDisplay(
  stepIndex = null
) {
  if (playingStepTimer !== null) {
    clearTimeout(
      playingStepTimer
    );

    playingStepTimer =
      null;
  }

  scheduledPlayingSteps =
    [];

  paintPlayingStep(
    stepIndex
  );
}

export function updatePlayingStep() {
  const fallbackStep =
    state.playbackTickIndex ===
    null
      ? null
      : state.playbackTickIndex %
        STEP_COUNT;

  paintPlayingStep(
    visualPlayingStepIndex ??
      fallbackStep
  );
}


/* =========================================================
 * Master display / reverb
 * ========================================================= */

let miniEqBands = [];
let mixerMeterRaf = null;
let lastMasterMixSyncKey = "";

const masterReverbControl =
  document.getElementById("master-reverb-control");
const masterReverbValue =
  document.getElementById("master-reverb-value");

function masterMix() {
  song.masterMix ??= {
    eq: Array(8).fill(0),
    volume: 100,
    limiter: -1,
    reverb: 0
  };

  // Mixer is retired. Keep legacy saved values neutral so old projects
  // cannot silently alter the master sound. Reverb remains user-facing.
  song.masterMix.eq = Array(8).fill(0);
  song.masterMix.volume = 100;
  song.masterMix.limiter = -1;
  song.masterMix.reverb = clamp(
    Math.round(Number(song.masterMix.reverb) || 0),
    0,
    100
  );

  return song.masterMix;
}

function syncMasterMixAudio() {
  const mix = masterMix();
  const key = String(mix.reverb);

  if (key === lastMasterMixSyncKey) return;
  lastMasterMixSyncKey = key;

  for (let index = 0; index < 8; index++) {
    setMasterMixEqBand(index, 0);
  }
  setMasterMixVolume(100);
  setMasterLimiterThreshold(-1);
  setMasterReverb(mix.reverb);

  if (masterReverbValue) {
    masterReverbValue.textContent = String(mix.reverb);
  }
}

function setMasterReverbFromUi(value) {
  const mix = masterMix();
  const next = clamp(Math.round(value), 0, 100);
  mix.reverb = next;
  setMasterReverb(next);
  lastMasterMixSyncKey = String(next);

  if (masterReverbValue) {
    masterReverbValue.textContent = String(next);
  }
}

function enableReverbVerticalSwipe() {
  if (!masterReverbControl) return;

  let pointerId = null;
  let startY = 0;
  let startValue = 0;
  let historySaved = false;

  masterReverbControl.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();
    pointerId = event.pointerId;
    startY = event.clientY;
    startValue = masterMix().reverb;
    historySaved = false;
    masterReverbControl.setPointerCapture(event.pointerId);
  });

  masterReverbControl.addEventListener("pointermove", event => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();

    if (!historySaved) {
      saveHistory();
      historySaved = true;
    }

    setMasterReverbFromUi(
      startValue + (startY - event.clientY) / 2
    );
  });

  const finish = event => {
    if (event.pointerId !== pointerId) return;
    if (masterReverbControl.hasPointerCapture(event.pointerId)) {
      masterReverbControl.releasePointerCapture(event.pointerId);
    }
    pointerId = null;
  };

  masterReverbControl.addEventListener("pointerup", finish);
  masterReverbControl.addEventListener("pointercancel", finish);
}

function updateMiniEqMeter() {
  const data = getMasterMixMeterData();
  const meterActive = Boolean(state.isPlaying);

  miniEqBands.forEach((band, index) => {
    const level = meterActive
      ? clamp(Number(data.bands[index]) || 0, 0, 1)
      : 0;
    const activeCount = Math.round(level * 8);

    band.forEach((block, blockIndex) => {
      block.classList.toggle("on", blockIndex < activeCount);
    });
  });

  mixerMeterRaf = requestAnimationFrame(updateMiniEqMeter);
}

function ensureMiniEqMeterLoop() {
  miniEqBands = Array.from(
    document.querySelectorAll("#mini-eq-meter > span")
  ).map(band => Array.from(band.querySelectorAll("i")));

  if (mixerMeterRaf === null) {
    mixerMeterRaf = requestAnimationFrame(updateMiniEqMeter);
  }
}

enableReverbVerticalSwipe();

/* =========================================================
 * Main.js compatibility exports
 * ========================================================= */

export function renderSongMode() {
  syncMasterMixAudio();
  ensureMiniEqMeterLoop();
}

export function refreshMasterMixMeterColor() {
  /* Meter colors are CSS-variable driven; repaint is automatic. */
}


/* =========================================================
 * Full render
 * ========================================================= */

export function render() {
  ensureMoktonStageStyles();

  setAppView(
    appView
  );

  void refreshProjectName();

  renderCurrentSourceDisplay();
  renderSequenceTools();
  renderEditor();
  renderSequence();
  renderPatternManager();
  renderSongMode();
  updatePlayingStep();
}


/* =========================================================
 * Stage 30: fit the complete app to the PWA viewport
 * ========================================================= */

function fitMoktonToViewport() {
  const app =
    document.querySelector(".app");

  if (!app) {
    return;
  }

  const root =
    document.documentElement;

  /*
   * Measure at scale 1 first.
   * Use scrollWidth / scrollHeight rather than only getBoundingClientRect(),
   * because some fixed-width children can visually overflow the .app box.
   */
  root.style.setProperty(
    "--mokton-app-scale",
    "1"
  );

  const appRect =
    app.getBoundingClientRect();

  const naturalWidth =
    Math.max(
      app.scrollWidth,
      appRect.width
    );

  const naturalHeight =
    Math.max(
      app.scrollHeight,
      appRect.height
    );

  const viewportWidth =
    document.documentElement.clientWidth;

  const viewportHeight =
    document.documentElement.clientHeight;

  const margin =
    20;

  const availableWidth =
    Math.max(
      1,
      viewportWidth -
        margin * 2
    );

  const availableHeight =
    Math.max(
      1,
      viewportHeight -
        margin * 2
    );

  const scale =
    Math.min(
      availableWidth /
        naturalWidth,
      availableHeight /
        naturalHeight
    );

  root.style.setProperty(
    "--mokton-app-scale",
    String(
      Number.isFinite(scale)
        ? Math.max(
            0.1,
            scale
          )
        : 1
    )
  );
}

let moktonFitFrame =
  null;

function scheduleMoktonViewportFit() {
  if (moktonFitFrame) {
    cancelAnimationFrame(
      moktonFitFrame
    );
  }

  moktonFitFrame =
    requestAnimationFrame(
      () => {
        moktonFitFrame =
          null;

        fitMoktonToViewport();
      }
    );
}

window.addEventListener(
  "resize",
  scheduleMoktonViewportFit,
  {
    passive: true
  }
);

window.addEventListener(
  "orientationchange",
  scheduleMoktonViewportFit,
  {
    passive: true
  }
);

window.addEventListener(
  "load",
  scheduleMoktonViewportFit,
  {
    once: true
  }
);

scheduleMoktonViewportFit();


/* =========================================================
 * Stage 34: hide diagnostics overlay
 * ========================================================= */

function hideMoktonDiagnosticsOverlay() {
  const selectors = [
    "#performance-monitor",
    "#performanceMonitor",
    "#load-monitor",
    "#loadMonitor",
    ".performance-monitor",
    ".performanceMonitor",
    ".load-monitor",
    ".loadMonitor",
    ".debug-monitor",
    ".debug-overlay",
    ".performance-overlay",
    ".monitor-overlay"
  ];

  document
    .querySelectorAll(
      selectors.join(",")
    )
    .forEach(
      (element) => {
        element.style.setProperty(
          "display",
          "none",
          "important"
        );
      }
    );
}

hideMoktonDiagnosticsOverlay();

window.addEventListener(
  "load",
  hideMoktonDiagnosticsOverlay,
  {
    once: true
  }
);
