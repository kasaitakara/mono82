import {
  STEP_COUNT,
  patterns,
  soundBank,
  state,
  clamp,
  undo,
  redo,
  canUndo,
  canRedo,
  beginSelectedPlayback,
  advancePlaybackSource,
  clearQueuedSource,
  soundIsAudible
} from "./sequencer.js";

import {
  initializeAudio,
  playSequenceStep,
  setMasterVolume,
  resumeAudio,
  beginPlaybackStartCapture,
  markPlaybackStartScheduler,
  markPlaybackExpectedAudio,
  resetAudioForForegroundPlayback
} from "./audio.js";

import {
  render,
  updatePlayingStep,
  schedulePlayingStepDisplay,
  resetPlayingStepDisplay,
  renderPatternManager,
  renderSongMode,
  refreshMasterMixMeterColor
} from "./ui.js";

import {
  initializeAutosave,
  restoreAutosave,
  scheduleAutosave
} from "./storage.js";

import "./keyboard-navigation.js";

let timer = null;
let nextTickTime = 0;
let playbackWasHidden = false;

/*
 * If the app enters the background while STOPPED, rebuild the AudioContext
 * before the next PLAY. This targets the stale-output condition seen after
 * long iPhone background periods without touching normal foreground starts.
 */
let audioNeedsForegroundReset = false;
/* =========================
 * Screen Wake Lock
 * アプリ表示中は画面スリープを抑止
 * ========================= */

let screenWakeLock = null;

async function requestScreenWakeLock() {
  if (
    !("wakeLock" in navigator) ||
    document.visibilityState !== "visible"
  ) {
    return;
  }

  // すでに取得済みなら重複取得しない
  if (
    screenWakeLock &&
    !screenWakeLock.released
  ) {
    return;
  }

  try {
    screenWakeLock =
      await navigator.wakeLock.request(
        "screen"
      );

    screenWakeLock.addEventListener(
      "release",
      () => {
        screenWakeLock = null;
      },
      { once: true }
    );
  } catch (error) {
    // Wake Lockが使えなくても
    // sprootoの再生自体は止めない
    screenWakeLock = null;

    console.warn(
      "Screen Wake Lock unavailable:",
      error
    );
  }
}

async function releaseScreenWakeLock() {
  const lock = screenWakeLock;

  screenWakeLock = null;

  if (!lock) {
    return;
  }

  try {
    await lock.release();
  } catch {
    // すでに解除済みなら何もしない
  }
}
/*
 * 発音時刻より少し前にtickを実行し、
 * Web Audioへ先行予約する。
 *
 * BPM 300の16分音符が50ms間隔なので、
 * それを超えない45msとする。
 */
const AUDIO_LOOKAHEAD_MS = 45;

/*
 * Audio先読み時間。
 *
 * UI / VS / ブラウザ切替などでMain Threadが一瞬止まっても、
 * すでにWeb Audioへ予約済みの音は正確な時刻で鳴る。
 *
 * ただしPattern / Fill / Section / SongのSource境界は越えて
 * 先読みしない。リアルタイム編集や予約切替への追従性を
 * 保つため、先読みは最大250msに限定する。
 */
const AUDIO_PREBUFFER_MS = 250;

/*
 * 現在Source内で、どの連続Playback Tickまで
 * Audio予約済みかを保持する。
 *
 * Source切替時は0起点へ戻るため、そこでリセットする。
 */
let audioScheduledThroughTick = null;

function resyncPlaybackClockAfterBackground() {
  if (!state.isPlaying) {
    return;
  }

  /*
   * Background中に溜まった
   * performance.now()上の遅れは捨てる。
   *
   * 過去のtickを高速消化せず、
   * 復帰時点を新しい時間基準にする。
   */
  clearTimeout(timer);

  timer = null;

  nextTickTime =
    performance.now();

  /*
   * 復帰直前までの予約位置を
   * 現在位置として扱う。
   */
  audioScheduledThroughTick =
    state.playbackTickIndex;

  resetPlayingStepDisplay(
    state.playbackTickIndex === null
      ? null
      : state.playbackTickIndex %
        STEP_COUNT
  );

  scheduleNextTick();
}

const playButton = document.getElementById("play-button");

const PERF_MAIN_DEBUG = false;
function perfMainLog(label, startedAt, detail = {}) {
  if (!PERF_MAIN_DEBUG) return;
  const ms = performance.now() - startedAt;
  if (ms >= 0.5) {
    console.log(`[PERF ${label}]`, { ms: Number(ms.toFixed(3)), ...detail });
  }
}

const bpmInput = document.getElementById("bpm-input");
const volumeInput = document.getElementById("master-volume");
const volumeValue = document.getElementById("master-volume-value");
const themeSelector = document.getElementById("theme-selector");
const themeButton = document.getElementById("theme-button");
const undoButton = document.getElementById("undo-button");
const redoButton = document.getElementById("redo-button");

function updateHistoryButtons() {
  undoButton.disabled = !canUndo();
  redoButton.disabled = !canRedo();
}

function preserveFocusDuringRender() {
  const activeElement =
    document.activeElement;

  const focusKey =
    activeElement?.dataset
      ?.focusKey;

  render();

  if (!focusKey) {
    return;
  }

  const nextElement =
    document.querySelector(
      `[data-focus-key="${focusKey}"]`
    );

  if (!nextElement) {
    return;
  }

  nextElement.focus({
    preventScroll: true
  });
}

window.addEventListener(
  "historychange",
  updateHistoryButtons
);

window.addEventListener(
  "sequencechange",
  () => {
    if (
      !state.isPlaying ||
      state.playbackTickIndex === null ||
      state.playingStepIndex === null
    ) {
      return;
    }

    /*
     * rand / shift can replace STEP data that was already prebuffered.
     * Drop the logical prebuffer watermark and rebuild from the current
     * playback position so future scheduler ticks are not skipped.
     */
    audioScheduledThroughTick =
      state.playbackTickIndex - 1;

    scheduleAudioAhead(
      state.playbackTickIndex,
      state.playingStepIndex,
      performance.now()
    );
  }
);

window.addEventListener(
  "projectchange",
  event => {
    /*
     * saveはProject内容を切り替えていないため、
     * 現在の再生状態をそのまま維持する。
     *
     * new / openなど、
     * 実際にProjectが切り替わった時だけ
     * Play表示を停止状態へ戻す。
     */
    if (
      event.detail?.type !== "save"
    ) {
      playButton.classList.remove(
        "playing"
      );
    }

    setMasterVolumeValue(
      Number(volumeInput.value)
    );

    updateHistoryButtons();
  }
);

function duration() {
  return 60000 / clamp(Number(bpmInput.value) || 120, 40, 300) / 4;
}

function scheduleNextTick() {
  nextTickTime += duration();

  /*
   * 実際の発音予定時刻より
   * AUDIO_LOOKAHEAD_MSだけ早く
   * tickを実行する。
   */
  const delay = Math.max(
    0,
    nextTickTime -
      performance.now() -
      AUDIO_LOOKAHEAD_MS
  );

  timer = setTimeout(
    tick,
    delay
  );
}

const SUB_PATTERNS = Object.freeze([
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

function currentPlaybackPattern() {
  const patternIndex =
    state.playingPatternIndex ??
    state.selectedPatternIndex ??
    0;

  return (
    patterns[patternIndex] ??
    patterns[0] ??
    null
  );
}

function layerStepOnly(
  layer,
  performanceData
) {
  return {
    melodic:
      layer === "melodic"
        ? performanceData
        : null,

    rhythm:
      layer === "rhythm"
        ? performanceData
        : null
  };
}

function scheduleLayerHit({
  layer,
  performanceData,
  delaySeconds,
  bpm,
  velocityScale = 1
}) {
  if (
    !performanceData?.soundId ||
    !soundIsAudible(
      layer,
      performanceData.soundId
    )
  ) {
    return;
  }

  playSequenceStep(
    layerStepOnly(
      layer,
      performanceData
    ),
    soundBank,
    delaySeconds,
    {
      bpm,
      velocityScale,
      ignoreProbability: true
    }
  );
}

function scheduleLayer({
  layer,
  performanceData,
  baseDelaySeconds,
  bpm
}) {
  if (
    !performanceData?.soundId ||
    !soundIsAudible(
      layer,
      performanceData.soundId
    )
  ) {
    return;
  }

  const probability =
    clamp(
      Number(
        performanceData.probability
      ) || 0,
      0,
      100
    );

  /*
   * STEP Probabilityは
   * そのSTEPについて1回だけ判定する。
   * SUBの各Hitごとには振り直さない。
   */
  if (
    probability < 100 &&
    Math.random() * 100 >=
      probability
  ) {
    return;
  }

  const patternIndex =
    Math.round(
      Number(
        performanceData.subPattern
      ) || -1
    );

  const subPattern =
    patternIndex >= 0
      ? SUB_PATTERNS[
          patternIndex
        ]
      : null;

  if (!subPattern) {
    scheduleLayerHit({
      layer,
      performanceData,
      delaySeconds:
        baseDelaySeconds,
      bpm
    });

    return;
  }

  /*
   * RHYTHMだけSUB PROBを持つ。
   * MELODICはSUBを選んだ時点で発動する。
   */
  if (
    layer === "rhythm"
  ) {
    const subProbability =
      clamp(
        Number(
          performanceData
            .subProbability
        ) || 0,
        0,
        100
      );

    if (
      subProbability < 100 &&
      Math.random() * 100 >=
        subProbability
    ) {
      scheduleLayerHit({
        layer,
        performanceData,
        delaySeconds:
          baseDelaySeconds,
        bpm
      });

      return;
    }
  }

  const stepSeconds =
    duration() / 1000;

  subPattern.hits.forEach(
    subIndex => {
      scheduleLayerHit({
        layer,
        performanceData,
        delaySeconds:
          baseDelaySeconds +
          stepSeconds *
            (
              subIndex /
              subPattern.divisions
            ),
        bpm
      });
    }
  );
}

function playStepAtTick(
  playbackTickIndex,
  plannedPerformanceTime =
    performance.now()
) {
  const perfStartedAt =
    performance.now();

  const pattern =
    currentPlaybackPattern();

  if (!pattern) {
    return;
  }

  const stepIndex =
    playbackTickIndex %
    STEP_COUNT;

  schedulePlayingStepDisplay(
    stepIndex,
    plannedPerformanceTime
  );

  const step =
    pattern.sequence?.[
      stepIndex
    ];

  if (!step) {
    return;
  }

  /*
   * AudioContextへ渡す、
   * 現在から発音予定時刻までの待ち時間。
   */
  const scheduleDelaySeconds =
    Math.max(
      0,
      (
        plannedPerformanceTime -
        performance.now()
      ) /
        1000
    );

  const bpm =
    clamp(
      Number(
        bpmInput.value
      ) || 120,
      40,
      300
    );

  let hasExpectedAudio =
    false;

  if (
    step.melodic?.soundId &&
    soundIsAudible(
      "melodic",
      step.melodic.soundId
    )
  ) {
    hasExpectedAudio = true;

    scheduleLayer({
      layer: "melodic",
      performanceData:
        step.melodic,
      baseDelaySeconds:
        scheduleDelaySeconds,
      bpm
    });
  }

  if (
    step.rhythm?.soundId &&
    soundIsAudible(
      "rhythm",
      step.rhythm.soundId
    )
  ) {
    hasExpectedAudio = true;

    scheduleLayer({
      layer: "rhythm",
      performanceData:
        step.rhythm,
      baseDelaySeconds:
        scheduleDelaySeconds,
      bpm
    });
  }

  if (hasExpectedAudio) {
    markPlaybackExpectedAudio(
      playbackTickIndex,
      scheduleDelaySeconds
    );
  }

  perfMainLog(
    "PLAY_STEP_AT_TICK",
    perfStartedAt,
    {
      tick:
        playbackTickIndex,

      pattern:
        (
          state.playingPatternIndex ??
          state.selectedPatternIndex ??
          0
        ) + 1
    }
  );
}

/*
 * 現在位置から最大AUDIO_PREBUFFER_MS先まで、
 * 同じSource内のAudioだけをWeb Audioへ先行予約する。
 *
 * UI stateは進めないため、
 * 画面表示・編集位置・Pattern予約操作は従来どおり。
 *
 * Source境界は越えない。
 */
function scheduleAudioAhead(
  currentPlaybackTickIndex,
  currentPlayingStepIndex,
  currentPlannedPerformanceTime
) {
  if (
    !state.isPlaying ||
    currentPlaybackTickIndex === null ||
    currentPlayingStepIndex === null
  ) {
    return;
  }

  const stepDurationMs =
    duration();

  const remainingSteps =
    Math.max(
      0,
      STEP_COUNT -
        1 -
        currentPlayingStepIndex
    );

  const maximumAheadSteps =
    Math.min(
      remainingSteps,
      Math.floor(
        AUDIO_PREBUFFER_MS /
          Math.max(
            1,
            stepDurationMs
          )
      )
    );

  for (
    let ahead = 0;
    ahead <= maximumAheadSteps;
    ahead++
  ) {
    const playbackTickIndex =
      currentPlaybackTickIndex +
      ahead;

    if (
      audioScheduledThroughTick !== null &&
      playbackTickIndex <=
        audioScheduledThroughTick
    ) {
      continue;
    }

    const plannedPerformanceTime =
      currentPlannedPerformanceTime +
      stepDurationMs * ahead;

    playStepAtTick(
      playbackTickIndex,
      plannedPerformanceTime
    );

    audioScheduledThroughTick =
      playbackTickIndex;
  }
}

function stopPlayback() {
  state.isPlaying = false;

  state.playingStepIndex =
    null;

  state.playbackTickIndex =
    null;

  state.playingSourceType =
    null;

  state.playingPatternIndex =
    null;

  state.playingFillIndex =
    null;

  state.playingSectionIndex =
    null;

  state.playingSectionItemIndex =
    null;

  state.playingSongPartIndex =
    null;

  state.fillReturnTarget =
    null;

  clearQueuedSource();

  clearTimeout(timer);
  timer = null;
  nextTickTime = 0;
  audioScheduledThroughTick = null;

  playButton.classList.remove(
    "playing"
  );

  resetPlayingStepDisplay();
  updatePlayingStep();
  renderPatternManager();
  renderSongMode();
}

function tick() {
  if (!state.isPlaying) {
    return;
  }

  const nextStepIndex =
    state.playingStepIndex + 1;

  if (
    nextStepIndex >=
    STEP_COUNT
  ) {
    const perfSwitchStartedAt =
      performance.now();

    const beforePattern =
      state.playingPatternIndex;

    const sourceChanged =
      advancePlaybackSource();

    perfMainLog(
      "PATTERN_BOUNDARY",
      perfSwitchStartedAt,
      {
        changed:
          sourceChanged,

        before:
          beforePattern,

        after:
          state.playingPatternIndex
      }
    );

    state.playingStepIndex =
      0;

    /*
     * 1 Timelineなので
     * Pattern境界ではSTEP位置だけ0へ戻す。
     * 予約Patternへ切り替わった場合だけ
     * Audio先読み位置もリセットする。
     */
    if (sourceChanged) {
      state.playbackTickIndex =
        0;

      audioScheduledThroughTick =
        null;
    } else {
      state.playbackTickIndex +=
        1;
    }

    scheduleAudioAhead(
      state.playbackTickIndex,
      state.playingStepIndex,
      nextTickTime
    );

    scheduleNextTick();

    if (sourceChanged) {
      window.requestAnimationFrame(
        () => {
          if (!state.isPlaying) {
            return;
          }

          preserveFocusDuringRender();
        }
      );
    } else {
      updatePlayingStep();
    }

    return;
  }

  state.playingStepIndex =
    nextStepIndex;

  state.playbackTickIndex +=
    1;

  scheduleAudioAhead(
    state.playbackTickIndex,
    state.playingStepIndex,
    nextTickTime
  );

  scheduleNextTick();

  updatePlayingStep();
}

async function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
    return;
  }

beginPlaybackStartCapture();

if (
  audioNeedsForegroundReset
) {
  audioNeedsForegroundReset =
    false;

  await resetAudioForForegroundPlayback();
}

await initializeAudio();

setMasterVolumeValue(
  Number(
    volumeInput.value
  )
);

state.isPlaying = true;

const started =
  beginSelectedPlayback();

if (!started) {
  stopPlayback();
  return;
}

/*
 * beginSelectedPlayback() establishes the playback source and clears
 * the runtime step indices. Set the initial position only AFTER that,
 * otherwise STEP 0 is lost and playback begins from STEP 1.
 */
state.playingStepIndex =
  0;

state.playbackTickIndex =
  0;

resetPlayingStepDisplay(0);

clearQueuedSource();

requestScreenWakeLock();

playButton.classList.add("playing");

/*
 * 停止状態から再生開始した時点で、
 * Pattern / Fill / Sectionの
 * playing表示も即反映する。
 */
renderPatternManager();
renderSongMode();

updatePlayingStep();

/*
 * 再生開始時点で基準時刻を先に固定し、
 * Step 1から以後のStepまで
 * 同じperformance.now()基準で予約する。
 */
nextTickTime =
  performance.now();

markPlaybackStartScheduler();

audioScheduledThroughTick =
  null;

scheduleAudioAhead(
  state.playbackTickIndex,
  state.playingStepIndex,
  nextTickTime
);

scheduleNextTick();
}

const BPM_MIN = 40;
const BPM_MAX = 300;
const BPM_SWIPE_PIXELS = 2;

let bpmSwipeActive = false;
let bpmSwipeStartY = 0;
let bpmSwipeStartValue = 120;
let bpmSwipePointerId = null;

function setBpmValue(value) {
  bpmInput.value = clamp(
    Math.round(value),
    BPM_MIN,
    BPM_MAX
  );
}

function isTouchLikePointer(event) {
  return (
    event.pointerType === "touch" ||
    event.pointerType === "pen"
  );
}

function isTouchDevice() {
  return window.matchMedia(
    "(pointer: coarse)"
  ).matches;
}

if (isTouchDevice()) {
  bpmInput.readOnly = true;
}

bpmInput.addEventListener(
  "pointerdown",
  event => {
    if (!isTouchLikePointer(event)) {
      return;
    }

    event.preventDefault();

    bpmInput.blur();

    bpmSwipeActive = true;
    bpmSwipePointerId =
      event.pointerId;

    bpmSwipeStartY =
      event.clientY;

    bpmSwipeStartValue =
      clamp(
        Number(bpmInput.value) || 120,
        BPM_MIN,
        BPM_MAX
      );

    bpmInput.setPointerCapture(
      event.pointerId
    );
  }
);

bpmInput.addEventListener(
  "pointermove",
  event => {
    if (
      !bpmSwipeActive ||
      event.pointerId !==
        bpmSwipePointerId
    ) {
      return;
    }

    event.preventDefault();

    const movement =
      bpmSwipeStartY -
      event.clientY;

    const bpmChange =
      movement /
      BPM_SWIPE_PIXELS;

    setBpmValue(
      bpmSwipeStartValue +
      bpmChange
    );
  }
);

function endBpmSwipe(event) {
  if (
    event.pointerId !==
      bpmSwipePointerId
  ) {
    return;
  }

  const changed =
    Number(bpmInput.value) !==
    bpmSwipeStartValue;

  bpmSwipeActive = false;
  bpmSwipePointerId = null;

  if (
    bpmInput.hasPointerCapture(
      event.pointerId
    )
  ) {
    bpmInput.releasePointerCapture(
      event.pointerId
    );
  }

  if (changed) {
    scheduleAutosave();
  }
}

bpmInput.addEventListener(
  "pointerup",
  endBpmSwipe
);

bpmInput.addEventListener(
  "pointercancel",
  endBpmSwipe
);

playButton.addEventListener("click", togglePlayback);
function enableRelativeVolumeDrag({
  slider,
  hitTarget,
  getValue,
  setValue,
  min = 0,
  max = 100,
  step = 1,
  onStart,
  onFinish
}) {
  let pointerId = null;
  let startX = 0;
  let startValue = 0;
  let currentValue = 0;
  let moved = false;

  hitTarget.style.touchAction =
    "none";

  hitTarget.addEventListener(
    "pointerdown",
    event => {
      if (
        event.pointerType === "mouse" &&
        event.button !== 0
      ) {
        return;
      }

      /*
       * スライダー表示部分を触った場合だけ
       * ボリューム操作を開始する。
       */
      const sliderRect =
        slider.getBoundingClientRect();

      const insideSlider =
        event.clientX >= sliderRect.left &&
        event.clientX <= sliderRect.right &&
        event.clientY >= sliderRect.top &&
        event.clientY <= sliderRect.bottom;

      if (!insideSlider) {
        return;
      }

      event.preventDefault();

      pointerId =
        event.pointerId;

      startX =
        event.clientX;

      startValue =
        clamp(
          Number(getValue()),
          min,
          max
        );

      currentValue =
        startValue;

      moved = false;

      onStart?.();

      hitTarget.setPointerCapture(
        event.pointerId
      );
    }
  );

  hitTarget.addEventListener(
    "pointermove",
    event => {
      if (
        pointerId !==
        event.pointerId
      ) {
        return;
      }

      event.preventDefault();

      const sliderRect =
        slider.getBoundingClientRect();

      /*
       * 58pxで0～100だと敏感すぎるため、
       * スライダー幅の約2倍を全変化幅にする。
       */
      const dragWidth =
        Math.max(
          1,
          sliderRect.width * 2
        );

      const movementX =
        event.clientX -
        startX;

      const rawValue =
        startValue +
        (
          movementX /
          dragWidth
        ) *
        (max - min);

      const steppedValue =
        Math.round(
          rawValue / step
        ) * step;

      const nextValue =
        clamp(
          steppedValue,
          min,
          max
        );

      if (
        nextValue ===
        currentValue
      ) {
        return;
      }

      currentValue =
        nextValue;

      moved = true;

      setValue(
        nextValue
      );
    }
  );

  function finish(event) {
    if (
      pointerId !==
        event.pointerId
    ) {
      return;
    }

    if (
      hitTarget.hasPointerCapture(
        event.pointerId
      )
    ) {
      hitTarget.releasePointerCapture(
        event.pointerId
      );
    }

    pointerId =
      null;

    /*
     * 指を離した瞬間の値を
     * 改めて確定表示する。
     */
    setValue(
      currentValue
    );

    onFinish?.(
      startValue,
      currentValue,
      moved
    );
  }

  hitTarget.addEventListener(
    "pointerup",
    finish
  );

  hitTarget.addEventListener(
    "pointercancel",
    finish
  );
}

function setMasterVolumeValue(
  nextValue
) {
  const value =
    clamp(
      Math.round(nextValue),
      0,
      100
    );

  volumeInput.value =
    String(value);

  volumeValue.value =
    String(value);

  volumeValue.textContent =
    String(value);

  setMasterVolume(
    value / 100
  );
}

enableRelativeVolumeDrag({
  slider:
    volumeInput,

  hitTarget:
    volumeInput.closest(
      ".master-control"
    ),

  getValue: () =>
    Number(
      volumeInput.value
    ),

  setValue:
    setMasterVolumeValue,

  min: 0,
  max: 100,
  step: 1,

  onFinish: (
    startValue,
    currentValue,
    moved
  ) => {
    if (
      moved &&
      currentValue !==
        startValue
    ) {
      scheduleAutosave();
    }
  }
});

/*
 * キーボード操作は
 * range本来の操作を残す。
 */
volumeInput.addEventListener(
  "input",
  () => {
    setMasterVolumeValue(
      Number(
        volumeInput.value
      )
    );
  }
);

const THEME_CLASSES = Object.freeze([
  "theme-mono82",
  "theme-sprooto",
  "theme-kasai",
  "theme-mei",
  "theme-ryuichi",
  "theme-aya",
  "theme-tobokegao",
  "theme-hachipro",
  "theme-electro",
  "theme-game"
]);

function applyTheme(themeClass) {
  document.documentElement.classList.remove(
    ...THEME_CLASSES
  );

  document.documentElement.classList.add(
    themeClass
  );

  /*
   * Palette values live only in CSS.
   * JS switches the theme class and reads the resulting background
   * for the PWA theme-color meta tag. This avoids CSS/JS palette
   * definitions drifting apart and makes CSS edits immediately authoritative.
   */
  const computedStyle =
    getComputedStyle(document.documentElement);

  const backgroundColor =
    computedStyle
      .getPropertyValue("--bg")
      .trim();

  const themeColorMeta =
    document.querySelector(
      'meta[name="theme-color"]'
    );

  if (backgroundColor) {
    themeColorMeta?.setAttribute(
      "content",
      backgroundColor
    );
  }

  refreshMasterMixMeterColor();
}

themeButton.addEventListener(
  "click",
  () => {
    const nextIndex =
      (themeSelector.selectedIndex + 1) %
      themeSelector.options.length;

    themeSelector.selectedIndex =
      nextIndex;

    themeSelector.dispatchEvent(
      new Event("change")
    );
  }
);

themeSelector.addEventListener(
  "change",
  () => {
    applyTheme(
      themeSelector.value
    );
  }
);

undoButton.addEventListener("click", () => {
  if (!undo()) {
    return;
  }

  render();
  updateHistoryButtons();
});

redoButton.addEventListener("click", () => {
  if (!redo()) {
    return;
  }

  render();
  updateHistoryButtons();
});

async function initializeApp() {
  applyTheme(
    themeSelector.value
  );

  await restoreAutosave();

  render();
  updateHistoryButtons();

  requestScreenWakeLock();

  initializeAutosave();

  window.addEventListener(
    "historychange",
    scheduleAutosave
  );
}

void initializeApp();

document.addEventListener(
  "visibilitychange",
  () => {
    if (
      document.visibilityState !==
        "visible"
    ) {
      if (state.isPlaying) {
        playbackWasHidden = true;
      } else {
        audioNeedsForegroundReset =
          true;
      }

      return;
    }

    /*
     * Keep the lightweight resume path on foreground.
     * If the app was hidden while stopped, the next user-initiated PLAY
     * performs a full AudioContext reset from togglePlayback().
     */
    resumeAudio();
    requestScreenWakeLock();

    if (!state.isPlaying) {
      playbackWasHidden = false;
      return;
    }

    if (playbackWasHidden) {
      playbackWasHidden = false;

      resyncPlaybackClockAfterBackground();
    }
  }
);

window.addEventListener(
  "pageshow",
  resumeAudio
);

window.addEventListener(
  "focus",
  resumeAudio
);