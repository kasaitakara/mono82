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
  refreshMasterMixMeterColor,
  selectedPatternRange
} from "./ui.js";

import {
  initializeAutosave,
  restoreAutosave,
  scheduleAutosave,
  getProjectList,
  getCurrentProjectMeta,
  getCurrentProjectId,
  createNewProject,
  openProject,
  saveCurrentProject,
  hasUnsavedChanges,
  saveAsProject,
  renameProject,
  deleteProject
} from "./storage.js";

import {
  renderExportWav
} from "./export.js";

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
const helpButton = document.getElementById("help-button");
const undoButton = document.getElementById("undo-button");
const redoButton = document.getElementById("redo-button");


let helpModeActive = false;
let helpPanel = null;
let currentHelpTarget = null;

const HELP_LANGUAGE_STORAGE_KEY =
  "mono82-help-language";

const HELP_CONTENT = {
  play: {
    en: {
      title: "play",
      body: "starts and stops playback."
    },
    ja: {
      title: "再生",
      body: "曲の再生／停止を切り替えます。"
    }
  },
  bpm: {
    en: {
      title: "bpm",
      body: "sets the tempo. swipe up/down to change."
    },
    ja: {
      title: "BPM",
      body: "テンポを設定します。上下にスイープして変更します。"
    }
  },
  volume: {
    en: {
      title: "volume",
      body: "sets the master output level. swipe up/down to change."
    },
    ja: {
      title: "ボリューム",
      body: "アプリ全体の出力音量を設定します。上下にスイープして変更します。"
    }
  },
  reverb: {
    en: {
      title: "reverb",
      body: "sets the overall amount of reverb. swipe up/down to change."
    },
    ja: {
      title: "リバーブ",
      body: "アプリ全体のリバーブのかかり具合を設定します。上下にスイープして変更します。"
    }
  },
  swing: {
    en: {
      title: "swing",
      body: "adds a swinging feel to the rhythm. swipe up/down to change."
    },
    ja: {
      title: "スウィング",
      body: "リズムに跳ねるようなスウィング感を加えます。上下にスイープして変更します。"
    }
  },
  audioSpectrum: {
    en: { title: "audio spectrum", body: "shows the current sound spectrum. low sounds are on the left, high sounds on the right." },
    ja: { title: "オーディオスペクトラム", body: "現在鳴っている音の分布を表示します。左側が低音域、右側が高音域です。" }
  },
  songTitle: {
    en: { title: "song title", body: "shows the song title. tap to rename." },
    ja: { title: "曲名", body: "曲名を表示します。タップすると名前を変更できます。" }
  },
  undo: {
    en: { title: "undo", body: "undoes the last edit." },
    ja: { title: "取り消し", body: "直前の編集を取り消します。" }
  },
  redo: {
    en: { title: "redo", body: "restores the last undone edit." },
    ja: { title: "やり直し", body: "取り消した編集をやり直します。" }
  },
  color: {
    en: { title: "color", body: "changes the app color theme." },
    ja: { title: "カラー", body: "アプリのカラーテーマを変更します。" }
  },
  mute: {
    en: { title: "mute", body: "mutes this sound." },
    ja: { title: "ミュート", body: "このサウンドをミュートします。" }
  },
  solo: {
    en: { title: "solo", body: "makes only this sound audible." },
    ja: { title: "ソロ", body: "このサウンドだけが鳴る状態にします。" }
  },
  reverbSend: {
    en: { title: "reverb send", body: "sets how much of this sound is sent to the reverb. swipe up/down to change." },
    ja: { title: "リバーブセンド", body: "このサウンドをリバーブに送る量を設定します。上下にスイープして変更します。" }
  },
  sound: {
    en: { title: "sound", body: "shows the selected sound. tap to open sound management, where you can choose factory presets, save user presets, and load saved presets." },
    ja: { title: "サウンド", body: "選択中のサウンドを表示します。タップするとサウンド管理画面が開き、Factoryプリセットへの切り替え、ユーザープリセットの登録、登録したプリセットへの切り替えができます。" }
  }
};

function getHelpLanguage() {
  const saved =
    localStorage.getItem(
      HELP_LANGUAGE_STORAGE_KEY
    );

  return saved === "ja" ? "ja" : "en";
}

function setHelpLanguage(language) {
  const next =
    language === "ja" ? "ja" : "en";

  localStorage.setItem(
    HELP_LANGUAGE_STORAGE_KEY,
    next
  );

  if (currentHelpTarget) {
    showHelpPanel(currentHelpTarget);
  }
}

function setHelpModeNotice(active) {
  clearTimeout(noticeTimer);

  let notice =
    document.getElementById("operation-notice");

  if (!notice) {
    notice = document.createElement("div");
    notice.id = "operation-notice";
    notice.className = "operation-notice";
    document.body.append(notice);
  }

  if (!active) {
    notice.classList.remove("show");
    return;
  }

  notice.textContent = "help mode · tap outlined controls";
  notice.classList.add("show");

  const titleRect =
    currentProjectNameElement?.getBoundingClientRect();

  if (titleRect) {
    const noticeRect = notice.getBoundingClientRect();
    notice.style.setProperty(
      "--notice-top",
      `${Math.max(
        4,
        titleRect.top - noticeRect.height - 4
      )}px`
    );
  }
}

function closeHelpPanel() {
  helpPanel?.remove();
  helpPanel = null;
  currentHelpTarget = null;
}

function positionHelpPanel(
  panel,
  target
) {
  const targetRect =
    target.getBoundingClientRect();
  const appRoot =
    document.querySelector(".app-shell") ??
    document.querySelector("main") ??
    document.body;
  const appRect =
    appRoot.getBoundingClientRect();
  const gap = 8;

  panel.style.left =
    `${Math.max(8, appRect.left + 8)}px`;
  panel.style.right = "auto";
  panel.style.width =
    `${Math.max(
      180,
      Math.min(
        appRect.width - 16,
        520
      )
    )}px`;

  const panelRect =
    panel.getBoundingClientRect();
  const viewportHeight =
    window.innerHeight;

  const roomBelow =
    viewportHeight - targetRect.bottom;
  const roomAbove =
    targetRect.top;
  const useBelow =
    roomBelow >= panelRect.height + gap ||
    roomBelow >= roomAbove;

  const top = useBelow
    ? Math.min(
        viewportHeight -
          panelRect.height -
          gap,
        targetRect.bottom + gap
      )
    : Math.max(
        gap,
        targetRect.top -
          panelRect.height -
          gap
      );

  panel.style.top = `${top}px`;
}

function showHelpPanel(target) {
  const key =
    target?.dataset?.helpKey;
  const content =
    HELP_CONTENT[key];

  if (!content) return;

  currentHelpTarget = target;
  helpPanel?.remove();

  const language =
    getHelpLanguage();
  const copy =
    content[language] ??
    content.en;

  const panel =
    document.createElement("div");

  panel.className =
    "help-description-panel";
  panel.dataset.language =
    language;

  const languageRow =
    document.createElement("div");
  languageRow.className =
    "help-language-row";

  const langLabel =
    document.createElement("span");
  langLabel.textContent = "lang";

  const enButton =
    document.createElement("button");
  enButton.type = "button";
  enButton.className =
    "help-language-control";
  enButton.textContent = "en";

  const slash =
    document.createElement("span");
  slash.textContent = "/";

  const jaButton =
    document.createElement("button");
  jaButton.type = "button";
  jaButton.className =
    "help-language-control";
  jaButton.textContent = "ja";

  enButton.classList.toggle(
    "active",
    language === "en"
  );
  jaButton.classList.toggle(
    "active",
    language === "ja"
  );

  enButton.addEventListener(
    "click",
    event => {
      event.preventDefault();
      event.stopPropagation();
      setHelpLanguage("en");
    }
  );

  jaButton.addEventListener(
    "click",
    event => {
      event.preventDefault();
      event.stopPropagation();
      setHelpLanguage("ja");
    }
  );

  languageRow.append(
    langLabel,
    enButton,
    slash,
    jaButton
  );

  const title =
    document.createElement("div");
  title.className =
    "help-description-title";
  title.textContent =
    copy.title;

  const body =
    document.createElement("div");
  body.className =
    "help-description-body";
  body.textContent =
    copy.body;

  panel.append(
    languageRow,
    title,
    body
  );

  document.body.append(panel);
  helpPanel = panel;

  positionHelpPanel(
    panel,
    target
  );
}


const HELP_TARGET_SELECTORS = [
  "#current-project-name",
  "#theme-button",
  "#global-menu-button",
  "#undo-button",
  "#redo-button",
  "#mini-eq-meter",
  "#play-button",
  ".master-control",
  ".bpm-control",
  "#current-source-display",
  "#sequence-grid",
  ".mokton-sequence-tools > button",
  "#pattern-edit-button",
  "#master-reverb-control",
  "#pattern-loop-button",
  "#pattern-grid",
  ".mokton-selected-sound-name",
  ".mokton-sound-reverb-send",
  ".mokton-ms-controls > button",
  ".mokton-step-parameter-button",
  ".mokton-direct-value-pad",
  ".mokton-lfo-access-button",
  ".mokton-lfo-target-cell",
  ".mokton-lfo-wave-cycle",
  ".mokton-lfo-inline-value",
  ".mokton-lfo-sync-button",
  ".mokton-lfo-parameter-pads .mokton-parameter-pad"
];

function clearHelpGroupOverlays() {
  document
    .querySelectorAll(".help-target-group-overlay")
    .forEach(element => element.remove());
}

function createHelpGroupOverlay(
  buttons,
  groupId
) {
  const elements =
    [...buttons].filter(Boolean);

  if (!elements.length) {
    return;
  }

  const rects =
    elements.map(element =>
      element.getBoundingClientRect()
    );

  const left =
    Math.min(...rects.map(rect => rect.left));
  const top =
    Math.min(...rects.map(rect => rect.top));
  const right =
    Math.max(...rects.map(rect => rect.right));
  const bottom =
    Math.max(...rects.map(rect => rect.bottom));

  const overlay =
    document.createElement("div");

  overlay.className =
    "help-target-group-overlay";
  overlay.dataset.helpTarget = "true";
  overlay.dataset.helpGroup = groupId;

  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
  overlay.style.width =
    `${Math.max(1, right - left)}px`;
  overlay.style.height =
    `${Math.max(1, bottom - top)}px`;

  document.body.append(overlay);
}

function createSoundLayerHelpGroups() {
  const soundButtons =
    [...document.querySelectorAll(
      ".mokton-sound-button-compact"
    )];

  createHelpGroupOverlay(
    soundButtons.filter(button =>
      ["1", "2", "3", "4"].includes(
        button.dataset.soundId
      )
    ),
    "melodic-sounds"
  );

  createHelpGroupOverlay(
    soundButtons.filter(button =>
      ["a", "b", "c", "d"].includes(
        button.dataset.soundId
      )
    ),
    "rhythm-sounds"
  );
}

function refreshHelpTargets() {
  clearHelpGroupOverlays();

  document
    .querySelectorAll("[data-help-target]")
    .forEach(element => {
      if (
        !element.classList.contains(
          "help-target-group-overlay"
        )
      ) {
        element.removeAttribute(
          "data-help-target"
        );
        element.removeAttribute(
          "data-help-key"
        );
      }
    });

  if (!helpModeActive) {
    return;
  }

  HELP_TARGET_SELECTORS.forEach(
    selector => {
      document
        .querySelectorAll(selector)
        .forEach(element => {
          if (
            element.id ===
            "help-button"
          ) {
            return;
          }

          element.setAttribute(
            "data-help-target",
            "true"
          );

          if (element.id === "current-project-name") {
            element.dataset.helpKey = "songTitle";
          } else if (element.id === "theme-button") {
            element.dataset.helpKey = "color";
          } else if (element.id === "undo-button") {
            element.dataset.helpKey = "undo";
          } else if (element.id === "redo-button") {
            element.dataset.helpKey = "redo";
          } else if (element.matches(".mokton-selected-sound-name")) {
            element.dataset.helpKey = "sound";
          } else if (element.matches(".mokton-sound-reverb-send")) {
            element.dataset.helpKey = "reverbSend";
          } else if (element.matches(".mokton-ms-controls > button")) {
            element.dataset.helpKey = element.title === "solo" ? "solo" : "mute";
          } else if (
            element.id ===
            "play-button"
          ) {
            element.dataset.helpKey =
              "play";
          } else if (
            element.matches(
              ".bpm-control"
            )
          ) {
            element.dataset.helpKey =
              "bpm";
          } else if (
            element.matches(
              ".master-control"
            )
          ) {
            element.dataset.helpKey =
              "volume";
          } else if (
            element.id ===
            "master-reverb-control"
          ) {
            element.dataset.helpKey =
              "reverb";
          } else if (
            element.id ===
            "mini-eq-meter"
          ) {
            element.dataset.helpKey =
              "audioSpectrum";
          } else if (
            element.matches(
              "[data-parameter-id=\"swing\"], [data-parameter=\"swing\"], .swing-control"
            )
          ) {
            element.dataset.helpKey =
              "swing";
          }
        });
    }
  );

  createSoundLayerHelpGroups();
}

function setHelpMode(active) {
  helpModeActive = Boolean(active);

  refreshHelpTargets();

  document.body.classList.toggle(
    "help-mode",
    helpModeActive
  );
  helpButton?.setAttribute(
    "aria-pressed",
    helpModeActive ? "true" : "false"
  );

  closeHelpPanel();
  setHelpModeNotice(helpModeActive);

  if (!helpModeActive) {
    clearHelpGroupOverlays();
  }
}

helpButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setHelpMode(!helpModeActive);
});

/*
 * Help mode owns interaction before the normal UI sees it.
 * Only the ? button and elements explicitly marked data-help-target
 * remain tappable. Normal app actions never fire while help mode is on.
 */
const HELP_BLOCKED_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mousemove",
  "mouseup",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "click",
  "dblclick",
  "contextmenu",
  "input",
  "change"
];

for (const eventName of HELP_BLOCKED_EVENTS) {
  document.addEventListener(
    eventName,
    (event) => {
      if (!helpModeActive) return;

      const target =
        event.target instanceof Element
          ? event.target
          : null;

      if (
        target?.closest("#help-button") ||
        target?.closest(
          ".help-language-control"
        )
      ) {
        return;
      }

      const helpTarget =
        target?.closest("[data-help-target]");

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (
        eventName === "pointerup" &&
        helpTarget
      ) {
        if (
          helpPanel &&
          currentHelpTarget === helpTarget
        ) {
          closeHelpPanel();
        } else {
          showHelpPanel(helpTarget);
        }
      }
    },
    true
  );
}

document.addEventListener(
  "keydown",
  (event) => {
    if (!helpModeActive) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  },
  true
);


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
    /*
     * Generic projectchange events are also emitted after ordinary edits
     * (STEP/offset/paste etc.). Those must never clear the PLAY highlight
     * while audio is still running. Keep the button visual synced to the
     * actual runtime state instead of inferring playback from event type.
     */
    playButton.classList.toggle(
      "playing",
      state.isPlaying
    );

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
  pixelsPerStep = 2,
  onStart,
  onFinish
}) {
  let pointerId = null;
  let startY = 0;
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

      event.preventDefault();

      pointerId =
        event.pointerId;

      startY =
        event.clientY;

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

      const movementY =
        startY -
        event.clientY;

      const rawValue =
        startValue +
        (
          movementY /
          Math.max(1, pixelsPerStep)
        ) * step;

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
  pixelsPerStep: 2,

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
  "theme-hachi",
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


/* =========================
 * Global project / export menu
 * ========================= */

const globalMenuButton =
  document.getElementById(
    "global-menu-button"
  );

const currentProjectNameElement =
  document.getElementById(
    "current-project-name"
  );

let globalOverlay = null;
let projectSortMode = "updated";
let noticeTimer = null;

function closeGlobalOverlay() {
  globalOverlay?.remove();
  globalOverlay = null;
}

function showNotice(text) {
  clearTimeout(noticeTimer);

  let notice =
    document.getElementById(
      "operation-notice"
    );

  if (!notice) {
    notice =
      document.createElement(
        "div"
      );

    notice.id =
      "operation-notice";
    notice.className =
      "operation-notice";

    document.body.append(
      notice
    );
  }

  const titleRect =
    currentProjectNameElement
      ?.getBoundingClientRect();

  if (titleRect) {
    notice.style.setProperty(
      "--notice-top",
      `${Math.max(
        4,
        titleRect.top - 18
      )}px`
    );
  }

  notice.textContent = text;
  notice.classList.add("show");

  noticeTimer =
    window.setTimeout(
      () => {
        notice?.classList.remove(
          "show"
        );
      },
      1000
    );
}

function makeOverlay(
  className = "global-overlay"
) {
  closeGlobalOverlay();

  const overlay =
    document.createElement(
      "div"
    );

  overlay.className =
    className;

  overlay.addEventListener(
    "pointerdown",
    event => {
      if (
        event.target === overlay
      ) {
        closeGlobalOverlay();
      }
    }
  );

  const headerRect =
    document.querySelector(
      ".app-header"
    )?.getBoundingClientRect();

  if (headerRect) {
    overlay.style.setProperty(
      "--overlay-top",
      `${Math.ceil(
        headerRect.bottom + 4
      )}px`
    );
  }

  document.body.append(
    overlay
  );

  globalOverlay = overlay;
  return overlay;
}

function makePanel(
  extraClass = ""
) {
  const panel =
    document.createElement(
      "div"
    );

  panel.className =
    `global-panel ${extraClass}`.trim();

  return panel;
}

function showConfirm(
  message
) {
  // Remove focus from the command/list control that opened the confirm.
  // On iOS/WebKit a focused transparent/native control can leave a tiny
  // underline-like focus artifact visible behind the transparent confirm layer.
  if (
    document.activeElement &&
    typeof document.activeElement.blur === "function"
  ) {
    document.activeElement.blur();
  }

  return new Promise(resolve => {
    const layer =
      document.createElement(
        "div"
      );

    layer.className =
      "global-confirm-layer";

    const panel =
      makePanel(
        "global-confirm-panel"
      );

    const text =
      document.createElement(
        "div"
      );

    text.className =
      "global-confirm-message";
    text.textContent = message;

    const actions =
      document.createElement(
        "div"
      );

    actions.className =
      "global-confirm-actions";

    const noButton =
      document.createElement(
        "button"
      );
    noButton.type = "button";
    noButton.textContent = "no";

    const yesButton =
      document.createElement(
        "button"
      );
    yesButton.type = "button";
    yesButton.textContent = "yes";

    const finish = value => {
      layer.remove();
      document.body.classList.remove("global-confirm-open");
      resolve(value);
    };

    noButton.addEventListener(
      "click",
      () => finish(false)
    );

    yesButton.addEventListener(
      "click",
      () => finish(true)
    );

    layer.addEventListener(
      "pointerdown",
      event => {
        if (
          event.target === layer
        ) {
          finish(false);
        }
      }
    );

    actions.append(
      noButton,
      yesButton
    );

    panel.append(
      text,
      actions
    );

    const titleRect =
      currentProjectNameElement
        ?.getBoundingClientRect();

    if (titleRect) {
      layer.style.setProperty(
        "--confirm-top",
        `${Math.max(
          4,
          titleRect.top - 28
        )}px`
      );
    }

    layer.append(panel);
    document.body.classList.add("global-confirm-open");
    document.body.append(layer);
    });
}

function sortProjectRecords(
  records
) {
  const copy = [...records];

  if (
    projectSortMode === "name"
  ) {
    return copy.sort(
      (a, b) =>
        String(a.name ?? "")
          .localeCompare(
            String(b.name ?? ""),
            undefined,
            {
              sensitivity: "base"
            }
          )
    );
  }

  return copy.sort(
    (a, b) =>
      Date.parse(
        b.updatedAt ?? ""
      ) -
      Date.parse(
        a.updatedAt ?? ""
      )
  );
}

function makeNameInput(
  onSubmit
) {
  const editor =
    document.createElement(
      "div"
    );
  editor.className =
    "project-name-editor";

  const display =
    document.createElement(
      "span"
    );
  display.className =
    "project-name-editor-text";

  const cursor =
    document.createElement(
      "span"
    );
  cursor.className =
    "project-name-editor-cursor";
  cursor.textContent = "_";

  const input =
    document.createElement(
      "input"
    );

  input.type = "text";
  input.className =
    "project-name-input";
  input.autocomplete = "off";
  input.autocapitalize = "none";
  input.spellcheck = false;
  input.enterKeyHint = "done";

  const refreshDisplay = () => {
    display.textContent =
      input.value;
  };

  input.addEventListener(
    "input",
    () => {
      const start =
        input.selectionStart;
      const end =
        input.selectionEnd;

      input.value =
        input.value.toLowerCase();

      if (
        start !== null &&
        end !== null
      ) {
        input.setSelectionRange(
          start,
          end
        );
      }

      refreshDisplay();
    }
  );

  input.addEventListener(
    "keydown",
    async event => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      await onSubmit(
        input.value
      );
    }
  );

  editor.addEventListener(
    "pointerdown",
    () => {
      input.focus();
    }
  );

  editor.append(
    display,
    cursor,
    input
  );

  input.nameEditorRoot = editor;
  input.refreshNameEditor =
    refreshDisplay;

  refreshDisplay();

  return input;
}

function makeProjectListItem({
  record,
  onOpen,
  onDeleted
}) {
  const row =
    document.createElement(
      "div"
    );
  row.className =
    "project-list-row";

  const deleteButton =
    document.createElement(
      "button"
    );
  deleteButton.type = "button";
  deleteButton.className =
    "project-delete-button";
  deleteButton.textContent =
    "delete";

  const item =
    document.createElement(
      "button"
    );
  item.type = "button";
  item.className =
    "project-list-item";
  item.textContent =
    record.name;

  let pointerId = null;
  let startX = 0;
  let currentX = 0;
  let swiped = false;

  item.addEventListener(
    "pointerdown",
    event => {
      if (
        event.pointerType === "mouse" &&
        event.button !== 0
      ) {
        return;
      }

      pointerId = event.pointerId;
      startX = event.clientX;
      currentX = event.clientX;
      swiped = false;
      item.setPointerCapture?.(
        pointerId
      );
    }
  );

  item.addEventListener(
    "pointermove",
    event => {
      if (
        event.pointerId !== pointerId
      ) {
        return;
      }

      currentX = event.clientX;
      const delta =
        Math.min(
          0,
          currentX - startX
        );

      if (delta < -8) {
        event.preventDefault();
      }

      item.style.transform =
        `translateX(${Math.max(-62, delta)}px)`;
    }
  );

  const finishSwipe = event => {
    if (
      event.pointerId !== pointerId
    ) {
      return;
    }

    const delta =
      currentX - startX;

    swiped = delta < -28;
    item.style.transform =
      swiped
        ? "translateX(-62px)"
        : "translateX(0)";

    pointerId = null;
  };

  item.addEventListener(
    "pointerup",
    finishSwipe
  );

  item.addEventListener(
    "pointercancel",
    event => {
      pointerId = null;
      item.style.transform =
        "translateX(0)";
    }
  );

  item.addEventListener(
    "click",
    event => {
      if (swiped) {
        event.preventDefault();
        swiped = false;
        return;
      }

      void onOpen(record);
    }
  );

  deleteButton.addEventListener(
    "click",
    async () => {
      const confirmed =
        await showConfirm(
          "delete this project?"
        );

      if (!confirmed) {
        item.style.transform =
          "translateX(0)";
        return;
      }

      if (
        await deleteProject(
          record.id
        )
      ) {
        await onDeleted();
      }
    }
  );

  row.append(
    deleteButton,
    item
  );

  return row;
}

async function showProjectList(
  mode
) {
  const overlay =
    makeOverlay();
  const panel =
    makePanel(
      "project-list-panel"
    );

  overlay.append(panel);

  const toolbar =
    document.createElement(
      "div"
    );
  toolbar.className =
    "project-list-toolbar";

  const sortButton =
    document.createElement(
      "button"
    );
  sortButton.type = "button";

  const list =
    document.createElement(
      "div"
    );
  list.className =
    "project-list";

  const renderList = async () => {
    const records =
      sortProjectRecords(
        await getProjectList()
      );

    sortButton.textContent =
      projectSortMode === "updated"
        ? "sort updated ↓"
        : "sort name a-z";

    list.replaceChildren();

    if (
      mode === "new" ||
      mode === "saveas"
    ) {
      const input =
        makeNameInput(
          async value => {
            if (mode === "new") {
              const id =
                await createNewProject(
                  value
                );

              if (id) {
                closeGlobalOverlay();
                render();
                updateHistoryButtons();
                showNotice("created…");
              }
            } else {
              const id =
                await saveAsProject(
                  value
                );

              if (id) {
                closeGlobalOverlay();
                render();
                updateHistoryButtons();
                showNotice("saved…");
              }
            }
          }
        );

      list.append(
        input.nameEditorRoot ??
        input
      );
      requestAnimationFrame(
        () => input.focus()
      );
    }

    for (
      const record of records
    ) {
      list.append(
        makeProjectListItem({
          record,
          onOpen:
            async target => {
              if (mode !== "load") {
                return;
              }

              if (
                hasUnsavedChanges()
              ) {
                const confirmed =
                  await showConfirm(
                    "unsaved changes. continue?"
                  );

                if (!confirmed) {
                  return;
                }
              }

              if (
                await openProject(
                  target.id
                )
              ) {
                closeGlobalOverlay();
                render();
                updateHistoryButtons();
                showNotice("loaded…");
              }
            },
          onDeleted:
            async () => {
              await renderList();
              render();
              updateHistoryButtons();
            }
        })
      );
    }
  };

  sortButton.addEventListener(
    "click",
    async () => {
      projectSortMode =
        projectSortMode === "updated"
          ? "name"
          : "updated";

      await renderList();
    }
  );

  toolbar.append(sortButton);
  panel.append(toolbar, list);
  await renderList();
}

async function beginNewProjectFlow() {
  if (hasUnsavedChanges()) {
    const confirmed =
      await showConfirm(
        "unsaved changes. continue?"
      );

    if (!confirmed) {
      openGlobalMenu();
      return;
    }
  }

  await showProjectList("new");
}

function openGlobalMenu() {
  const overlay =
    makeOverlay();
  const panel =
    makePanel(
      "global-menu-panel"
    );

  const commands = [
    ["new", () => void beginNewProjectFlow()],
    ["load", () => void showProjectList("load")],
    ["save", async () => {
      if (
        await saveCurrentProject()
      ) {
        closeGlobalOverlay();
        render();
        updateHistoryButtons();
        showNotice("saved…");
      }
    }],
    ["save as", () => void showProjectList("saveas")],
    ["export", () => void openExportModal()]
  ];

  commands.forEach(
    ([label, action]) => {
      const button =
        document.createElement(
          "button"
        );
      button.type = "button";
      button.textContent = label;
      button.addEventListener(
        "click",
        action
      );
      panel.append(button);
    }
  );

  overlay.append(panel);
}

globalMenuButton?.addEventListener(
  "click",
  openGlobalMenu
);

async function startInlineRename() {
  if (
    !currentProjectNameElement ||
    currentProjectNameElement.querySelector(
      "input"
    )
  ) {
    return;
  }

  const meta =
    await getCurrentProjectMeta();

  if (!meta?.id) {
    return;
  }

  const original =
    meta.name ?? "";

  const input =
    makeNameInput(
      async value => {
        if (
          await renameProject(
            meta.id,
            value
          )
        ) {
          render();
          showNotice("renamed…");
        }
      }
    );

  input.value = original;
  input.refreshNameEditor?.();
  currentProjectNameElement
    .replaceChildren(
      input.nameEditorRoot ??
      input
    );

  const cancel = event => {
    if (
      event.target === input ||
      currentProjectNameElement
        .contains(event.target)
    ) {
      return;
    }

    document.removeEventListener(
      "pointerdown",
      cancel,
      true
    );

    if (
      document.body.contains(input)
    ) {
      currentProjectNameElement
        .textContent = original;
    }
  };

  input.addEventListener(
    "keydown",
    event => {
      if (event.key === "Enter") {
        document.removeEventListener(
          "pointerdown",
          cancel,
          true
        );
      }
    }
  );

  document.addEventListener(
    "pointerdown",
    cancel,
    true
  );

  requestAnimationFrame(
    () => {
      input.focus();
      const end =
        input.value.length;
      input.setSelectionRange(
        end,
        end
      );
    }
  );
}

currentProjectNameElement
  ?.addEventListener(
    "click",
    () => void startInlineRename()
  );

/* =========================
 * Existing sprooto export UI, reconnected
 * ========================= */

let exportModal = null;

function safeExportFileName(name) {
  const cleaned =
    String(name || "project")
      .replace(
        /[\\/:*?"<>|\u0000-\u001f]+/g,
        "-"
      )
      .replace(/[. ]+$/g, "-")
      .trim();

  return cleaned || "project";
}

function downloadExportBlob(
  blob,
  fileName
) {
  const url =
    URL.createObjectURL(blob);
  const anchor =
    document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(
    () => URL.revokeObjectURL(url),
    1000
  );
}

async function shareOrDownloadExport(
  blob,
  fileName
) {
  const isMobile =
    /iPhone|iPad|iPod|Android/i.test(
      navigator.userAgent
    ) ||
    (
      navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1
    );

  if (isMobile) {
    const file =
      new File(
        [blob],
        fileName,
        { type: "audio/wav" }
      );

    if (
      navigator.share &&
      navigator.canShare?.({
        files: [file]
      })
    ) {
      try {
        await navigator.share({
          files: [file]
        });
        return;
      } catch (error) {
        if (
          error?.name ===
          "AbortError"
        ) {
          return;
        }
      }
    }
  }

  downloadExportBlob(
    blob,
    fileName
  );
}

function makeExportChoice(
  label,
  value
) {
  const button =
    document.createElement(
      "button"
    );
  button.type = "button";
  button.className =
    "export-choice";
  button.textContent = label;
  button.dataset.value = value;
  return button;
}

function makeExportNumberRow({
  label,
  min,
  max,
  step,
  value
}) {
  const row =
    document.createElement("div");
  row.className = "export-row";

  const labelNode =
    document.createElement("div");
  labelNode.className =
    "export-label";
  labelNode.textContent = label;

  const control =
    document.createElement("div");
  control.className =
    "export-value-control";

  const minus =
    document.createElement("button");
  minus.type = "button";
  minus.textContent = "−";

  const output =
    document.createElement("output");

  const plus =
    document.createElement("button");
  plus.type = "button";
  plus.textContent = "+";

  function setValue(nextValue) {
    const next =
      clamp(
        Math.round(
          Number(nextValue) /
          step
        ) * step,
        min,
        max
      );

    output.dataset.value =
      String(next);
    output.textContent =
      step === 0.5
        ? `${next.toFixed(1)}s`
        : `${Math.round(next)}s`;
  }

  minus.addEventListener(
    "click",
    () => setValue(
      Number(output.dataset.value) -
      step
    )
  );

  plus.addEventListener(
    "click",
    () => setValue(
      Number(output.dataset.value) +
      step
    )
  );

  setValue(value);
  control.append(
    minus,
    output,
    plus
  );
  row.append(
    labelNode,
    control
  );

  return {
    row,
    getValue: () =>
      Number(
        output.dataset.value
      ) || 0,
    setValue,
    setDisabled(disabled) {
      row.classList.toggle(
        "disabled",
        disabled
      );
      minus.disabled = disabled;
      plus.disabled = disabled;
    }
  };
}

async function openExportModal() {
  closeGlobalOverlay();

  if (exportModal) {
    return;
  }

  const overlay =
    document.createElement("div");
  overlay.className =
    "export-overlay";

  const modal =
    document.createElement("div");
  modal.className =
    "export-modal";

  const title =
    document.createElement("div");
  title.className =
    "export-modal-title";
  title.textContent = "export";

  const targetRow =
    document.createElement("div");
  targetRow.className = "export-row";
  const targetLabel =
    document.createElement("div");
  targetLabel.className =
    "export-label";
  targetLabel.textContent = "target";
  const targetGroup =
    document.createElement("div");
  targetGroup.className =
    "export-choice-group";
  const targetSong =
    makeExportChoice("song", "song");
  const targetPart =
    makeExportChoice("ptrn", "part");
  targetGroup.append(
    targetSong,
    targetPart
  );
  targetRow.append(
    targetLabel,
    targetGroup
  );

  const endRow =
    document.createElement("div");
  endRow.className = "export-row";
  const endLabel =
    document.createElement("div");
  endLabel.className =
    "export-label";
  endLabel.textContent = "end";
  const endGroup =
    document.createElement("div");
  endGroup.className =
    "export-choice-group";
  const endTail =
    makeExportChoice("tail", "tail");
  const endLoop =
    makeExportChoice("loop", "loop");
  endGroup.append(
    endTail,
    endLoop
  );
  endRow.append(
    endLabel,
    endGroup
  );

  const headControl =
    makeExportNumberRow({
      label: "head",
      min: 0,
      max: 5,
      step: 0.5,
      value: 0
    });

  const fadeInControl =
    makeExportNumberRow({
      label: "fade in",
      min: 0,
      max: 30,
      step: 1,
      value: 0
    });

  const fadeOutControl =
    makeExportNumberRow({
      label: "fade out",
      min: 0,
      max: 30,
      step: 1,
      value: 0
    });

  const formatRow =
    document.createElement("div");
  formatRow.className = "export-row";
  formatRow.innerHTML =
    '<div class="export-label">format</div><div>wav / 24bit / 48khz</div>';

  const progress =
    document.createElement("div");
  progress.className =
    "export-progress";
  progress.hidden = true;

  const progressText =
    document.createElement("div");
  const progressTrack =
    document.createElement("div");
  progressTrack.className =
    "export-progress-track";
  const progressBar =
    document.createElement("i");
  progressTrack.append(progressBar);
  progress.append(
    progressText,
    progressTrack
  );

  const actions =
    document.createElement("div");
  actions.className =
    "export-actions";
  const exportAction =
    document.createElement("button");
  exportAction.type = "button";
  exportAction.textContent = "export";
  actions.append(exportAction);

  modal.append(
    title,
    targetRow,
    endRow,
    headControl.row,
    fadeInControl.row,
    fadeOutControl.row,
    formatRow,
    progress,
    actions
  );
  const headerRect =
    document.querySelector(
      ".app-header"
    )?.getBoundingClientRect();

  if (headerRect) {
    overlay.style.setProperty(
      "--overlay-top",
      `${Math.ceil(
        headerRect.bottom + 4
      )}px`
    );
  }

  overlay.append(modal);
  document.body.append(overlay);
  exportModal = overlay;

  let target = "song";
  let endMode = "tail";
  let working = false;
  let signal = null;

  const close = () => {
    if (working) {
      signal.cancelled = true;
      return;
    }

    overlay.remove();
    exportModal = null;
  };

  function applyState() {
    targetSong.classList.toggle(
      "active",
      target === "song"
    );
    targetPart.classList.toggle(
      "active",
      target === "part"
    );
    endTail.classList.toggle(
      "active",
      endMode === "tail"
    );
    endLoop.classList.toggle(
      "active",
      endMode === "loop"
    );

    const loop =
      endMode === "loop";

    if (loop) {
      headControl.setValue(0);
      fadeInControl.setValue(0);
      fadeOutControl.setValue(0);
    }

    headControl.setDisabled(
      working || loop
    );
    fadeInControl.setDisabled(
      working || loop
    );
    fadeOutControl.setDisabled(
      working || loop
    );

    targetSong.disabled = working;
    targetPart.disabled = working;
    endTail.disabled = working;
    endLoop.disabled = working;
    exportAction.disabled = working;
  }

  targetSong.addEventListener(
    "click",
    () => {
      target = "song";
      applyState();
    }
  );
  targetPart.addEventListener(
    "click",
    () => {
      target = "part";
      applyState();
    }
  );
  endTail.addEventListener(
    "click",
    () => {
      endMode = "tail";
      applyState();
    }
  );
  endLoop.addEventListener(
    "click",
    () => {
      endMode = "loop";
      applyState();
    }
  );

  overlay.addEventListener(
    "pointerdown",
    event => {
      if (
        event.target === overlay &&
        !working
      ) {
        close();
      }
    }
  );

  exportAction.addEventListener(
    "click",
    async () => {
      working = true;
      signal = { cancelled: false };
      progress.hidden = false;
      progressText.textContent =
        "exporting 0%";
      progressBar.style.width = "0%";
      applyState();

      try {
        const partPatternIndexes =
          target === "part"
            ? (
                selectedPatternRange() ??
                [state.selectedPatternIndex]
              )
            : null;

        const result =
          await renderExportWav({
            target,
            patternIndexes:
              partPatternIndexes,
            endMode,
            headSeconds:
              headControl.getValue(),
            fadeInSeconds:
              fadeInControl.getValue(),
            fadeOutSeconds:
              fadeOutControl.getValue(),
            bpm:
              Number(bpmInput.value) ||
              120,
            masterVolume:
              Number(volumeInput.value) ||
              70,
            signal,
            onProgress:
              value => {
                const percent =
                  clamp(
                    Math.round(value),
                    0,
                    100
                  );
                progressText.textContent =
                  `exporting ${percent}%`;
                progressBar.style.width =
                  `${percent}%`;
              }
          });

        if (signal.cancelled) {
          return;
        }

        const meta =
          await getCurrentProjectMeta();
        const baseName =
          safeExportFileName(
            meta?.name ??
            "project"
          );

        const partRange =
          target === "part"
            ? (
                selectedPatternRange() ??
                [state.selectedPatternIndex]
              )
            : null;

        const suffix =
          partRange?.length
            ? (
                partRange.length === 1
                  ? `-${String(
                      partRange[0] + 1
                    ).padStart(2, "0")}`
                  : `-${String(
                      partRange[0] + 1
                    ).padStart(2, "0")}-${String(
                      partRange[
                        partRange.length - 1
                      ] + 1
                    ).padStart(2, "0")}`
              )
            : "";

        await shareOrDownloadExport(
          result.blob,
          `${baseName}${suffix}.wav`
        );
      } catch (error) {
        if (
          error?.name !==
            "ExportCancelledError"
        ) {
          console.error(
            "mono82 export failed:",
            error
          );
          progressText.textContent =
            "export failed";
        }
      } finally {
        working = false;
        signal = null;
        applyState();
      }
    }
  );

  applyState();
}

async function initializeApp() {
  applyTheme(
    themeSelector.value
  );

  await restoreAutosave();

  render();
  updateHistoryButtons();

  requestScreenWakeLock();

  initializeAutosave();

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