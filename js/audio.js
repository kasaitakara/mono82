import { clamp, resolveChordNoteOffsets, CHORD_NAMES } from "./sequencer.js";


let context;
let master;
let mixInput;
let mixGain;
let limiter;
let reverbConvolver;
let reverbDryGain;
let reverbWetGain;
let reverbPathConnected = false;
let reverbDisconnectTimer = null;
let spectrumAnalyser;
let outputAnalyser;
let eqNodes = [];
let spectrumData;
let outputTimeData;
let fmVoiceWorkletReady = null;

let audioClockReady = false;
let audioClockReadyPromise = null;
let offlineRenderMode = false;

let sprootoDebugStarted = false;
let sprootoDebugInterval = null;
let sprootoDebugPlayCallsTotal = 0;
let sprootoDebugPlayCallsWindow = 0;
let sprootoDebugNodesCreated = 0;
let sprootoDebugNodesReleased = 0;
let sprootoDebugNodesCreatedWindow = 0;
let sprootoDebugNodesReleasedWindow = 0;
let sprootoDebugCleanups = 0;
let sprootoDebugTimersScheduled = 0;
let sprootoDebugTimersFired = 0;
let sprootoDebugTimerMaxLateMsWindow = 0;
let sprootoDebugOscEndedWindow = 0;

let sprootoDebugWallStart = 0;
let sprootoDebugAudioStart = 0;

let sprootoDebugRafStarted = false;
let sprootoDebugRafLast = 0;
let sprootoDebugMainLagMaxWindow = 0;
let sprootoDebugRafFramesWindow = 0;

let sprootoDebugHeartbeatNode = null;
let sprootoDebugHeartbeatReady = null;
let sprootoDebugHeartbeatLastWall = 0;
let sprootoDebugHeartbeatMaxGapWindow = 0;
let sprootoDebugHeartbeatCount = 0;
let sprootoDebugHeartbeatFrame = 0;
let sprootoDebugHeartbeatAudioTime = 0;
let sprootoDebugHeartbeatFrameGapMaxWindow = 0;

let sprootoDebugStateChanges = 0;
let sprootoDebugLastState = "none";

let sprootoDebugFmWorkletCreatedTotal = 0;

/* =========================
 * Playback start auto capture
 * 再生開始ズレ調査用。
 * 再生動作そのものには影響しない。
 * ========================= */

let playbackStartCapture = null;
let playbackStartSerial = 0;
let playbackStartWorst = null;

let playbackStartProbeRaf = null;
let playbackStartProbeData = null;

function updatePlaybackStartCapture() {
  if (!playbackStartCapture) {
    return;
  }

  if (
    Number.isFinite(
      playbackStartCapture.firstExpectedAt
    ) &&
    Number.isFinite(
      playbackStartCapture.firstAnalyserAt
    )
  ) {
    playbackStartCapture.analyserDelayMs =
      playbackStartCapture.firstAnalyserAt -
      playbackStartCapture.firstExpectedAt;

    if (
      !playbackStartWorst ||
      playbackStartCapture.analyserDelayMs >
        (
          playbackStartWorst
            .analyserDelayMs ??
          -Infinity
        )
    ) {
      playbackStartWorst = {
        ...playbackStartCapture
      };
    }
  }
}

export function beginPlaybackStartCapture() {
  stopPlaybackStartProbe();

  playbackStartSerial += 1;

  playbackStartCapture = {
    id:
      playbackStartSerial,

    tapAt:
      performance.now(),

    stateAtTap:
      context?.state ??
      "none",

    initEnteredAt:
      null,

    audioReadyAt:
      null,

    schedulerAt:
      null,

    firstExpectedAt:
      null,

    firstExpectedTick:
      null,

    firstTrackCallAt:
      null,

    firstAnalyserAt:
      null,

    stateAtAnalyser:
      null,

    analyserDelayMs:
      null
  };
}

export function markPlaybackStartScheduler() {
  if (!playbackStartCapture) {
    return;
  }

  if (
    playbackStartCapture.schedulerAt ===
    null
  ) {
    playbackStartCapture.schedulerAt =
      performance.now();
  }
}

export function markPlaybackExpectedAudio(
  playbackTickIndex,
  delaySeconds
) {
  if (!playbackStartCapture) {
    return;
  }

  const expectedAt =
    performance.now() +
    Math.max(
      0,
      Number(delaySeconds) || 0
    ) *
      1000;

  /*
   * 複数Trackが同時予約された場合は
   * 最も早い実音予定時刻を採用する。
   */
  if (
  playbackStartCapture.firstExpectedAt ===
    null ||
  expectedAt <
    playbackStartCapture.firstExpectedAt
) {
  playbackStartCapture.firstExpectedAt =
    expectedAt;

  playbackStartCapture.firstExpectedTick =
    playbackTickIndex;
}

startPlaybackStartProbe();
}

function playbackStartSummary(
  record
) {
  if (!record) {
    return "start -";
  }

  const fromTap =
    value =>
      Number.isFinite(value)
        ? Math.round(
            value -
            record.tapAt
          )
        : "-";

  const gap =
    Number.isFinite(
      record.analyserDelayMs
    )
      ? Math.round(
          record.analyserDelayMs
        )
      : "-";

  return (
    `#${record.id} ` +
    `ctx ${record.stateAtTap}` +
    `>${record.stateAtAnalyser ?? "-"} ` +
    `ready ${fromTap(
      record.audioReadyAt
    )} ` +
    `sched ${fromTap(
      record.schedulerAt
    )} ` +
    `exp ${fromTap(
      record.firstExpectedAt
    )} ` +
    `meter ${fromTap(
      record.firstAnalyserAt
    )} ` +
    `gap ${gap}ms`
  );
}

function stopPlaybackStartProbe() {
  if (
    playbackStartProbeRaf !== null &&
    typeof window !== "undefined"
  ) {
    window.cancelAnimationFrame(
      playbackStartProbeRaf
    );
  }

  playbackStartProbeRaf = null;
}

function startPlaybackStartProbe() {
  if (
    offlineRenderMode ||
    !outputAnalyser ||
    !playbackStartCapture ||
    playbackStartCapture
      .firstAnalyserAt !== null ||
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !==
      "function"
  ) {
    return;
  }

  /*
   * 同じ再生開始に対して
   * Probeを複数起動しない。
   */
  if (
    playbackStartProbeRaf !== null
  ) {
    return;
  }

  if (
    !playbackStartProbeData ||
    playbackStartProbeData.length !==
      outputAnalyser.fftSize
  ) {
    playbackStartProbeData =
      new Uint8Array(
        outputAnalyser.fftSize
      );
  }

  const captureId =
    playbackStartCapture.id;

  const probe = () => {
    /*
     * 別の再生開始へ切り替わったら
     * 古いProbeは終了。
     */
    if (
      !playbackStartCapture ||
      playbackStartCapture.id !==
        captureId
    ) {
      playbackStartProbeRaf = null;
      return;
    }

    const expectedAt =
      playbackStartCapture
        .firstExpectedAt;

    if (
      Number.isFinite(expectedAt) &&
      performance.now() >=
        expectedAt
    ) {
      outputAnalyser
        .getByteTimeDomainData(
          playbackStartProbeData
        );

      let peak = 0;

      for (
        let index = 0;
        index <
          playbackStartProbeData.length;
        index++
      ) {
        const value =
          Math.abs(
            playbackStartProbeData[index] -
              128
          ) /
          128;

        if (value > peak) {
          peak = value;
        }
      }

      /*
       * 最初の実質的なAudio信号を検出。
       */
      if (peak > 0.001) {
        playbackStartCapture
          .firstAnalyserAt =
          performance.now();

        playbackStartCapture
          .stateAtAnalyser =
          context?.state ??
          "none";

        updatePlaybackStartCapture();

        playbackStartProbeRaf = null;
        return;
      }
    }

    /*
     * 異常時も無限監視しない。
     * PLAYから3秒でProbe終了。
     *
     * meterが "-" のままなら、
     * 3秒以内にAudioグラフへ
     * 信号が来なかったことになる。
     */
    if (
      performance.now() -
        playbackStartCapture.tapAt >
      3000
    ) {
      playbackStartProbeRaf = null;
      return;
    }

    playbackStartProbeRaf =
      window.requestAnimationFrame(
        probe
      );
  };

  playbackStartProbeRaf =
    window.requestAnimationFrame(
      probe
    );
}

const sprootoDebugReleasedNodes = new WeakSet();
const sprootoDebugNodeTypes = new WeakMap();
const sprootoDebugNodeRoles = new WeakMap();
const sprootoDebugLiveByType = Object.create(null);
const sprootoDebugLiveByRole = Object.create(null);

function sprootoDebugType(node) {
  const name = node?.constructor?.name ?? "other";

  if (/AudioWorkletNode/i.test(name)) return "worklet";
  if (/GainNode/i.test(name)) return "gain";
  if (/StereoPannerNode/i.test(name)) return "pan";
  if (/BiquadFilterNode/i.test(name)) return "filter";
  if (/OscillatorNode|AudioBufferSourceNode|ConstantSourceNode/i.test(name)) return "source";
  if (/ConvolverNode/i.test(name)) return "conv";
  return "other";
}

function sprootoDebugNode(node, role = null) {
  if (node) {
    const type = sprootoDebugType(node);
    sprootoDebugNodesCreated += 1;
    sprootoDebugNodesCreatedWindow += 1;
    sprootoDebugNodeTypes.set(node, type);
    sprootoDebugLiveByType[type] = (sprootoDebugLiveByType[type] || 0) + 1;

    if (role) {
      sprootoDebugNodeRoles.set(node, role);
      sprootoDebugLiveByRole[role] =
        (sprootoDebugLiveByRole[role] || 0) + 1;
    }
  }
  return node;
}

function sprootoDebugReleaseNode(node) {
  if (!node || sprootoDebugReleasedNodes.has(node)) {
    return;
  }

  sprootoDebugReleasedNodes.add(node);
  sprootoDebugNodesReleased += 1;
  sprootoDebugNodesReleasedWindow += 1;

  const type = sprootoDebugNodeTypes.get(node);
  if (type) {
    sprootoDebugLiveByType[type] = Math.max(0, (sprootoDebugLiveByType[type] || 0) - 1);
  }

  const role = sprootoDebugNodeRoles.get(node);
  if (role) {
    sprootoDebugLiveByRole[role] =
      Math.max(0, (sprootoDebugLiveByRole[role] || 0) - 1);
  }

  try {
    node.disconnect();
  } catch {}
}


function sprootoDebugStartRafMonitor() {
  if (
    sprootoDebugRafStarted ||
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function"
  ) {
    return;
  }

  sprootoDebugRafStarted = true;

  const tick = timestamp => {
    if (sprootoDebugRafLast > 0) {
      const gap =
        timestamp -
        sprootoDebugRafLast;

      sprootoDebugMainLagMaxWindow =
        Math.max(
          sprootoDebugMainLagMaxWindow,
          Math.max(
            0,
            gap - 16.7
          )
        );
    }

    sprootoDebugRafLast =
      timestamp;

    sprootoDebugRafFramesWindow +=
      1;

    window.requestAnimationFrame(
      tick
    );
  };

  window.requestAnimationFrame(
    tick
  );
}

async function sprootoDebugStartHeartbeat() {
  if (
    offlineRenderMode ||
    !context?.audioWorklet ||
    sprootoDebugHeartbeatNode
  ) {
    return;
  }

  try {
    if (!sprootoDebugHeartbeatReady) {
      const processorSource = `
        class SprootoDebugHeartbeatProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.frames = 0;
          }

          process(inputs, outputs) {
            const channel =
              outputs[0]?.[0];

            if (channel) {
              channel.fill(0);
            }

            this.frames += 128;

            if (
              this.frames >=
              sampleRate * 0.25
            ) {
              this.frames = 0;

              this.port.postMessage({
                frame: currentFrame,
                time: currentTime
              });
            }

            return true;
          }
        }

        registerProcessor(
          "sprooto-debug-heartbeat-v12",
          SprootoDebugHeartbeatProcessor
        );
      `;

      const blob =
        new Blob(
          [processorSource],
          {
            type: "application/javascript"
          }
        );

      const url =
        URL.createObjectURL(
          blob
        );

      sprootoDebugHeartbeatReady =
        context.audioWorklet
          .addModule(url)
          .finally(
            () => {
              URL.revokeObjectURL(
                url
              );
            }
          );
    }

    await sprootoDebugHeartbeatReady;

    if (sprootoDebugHeartbeatNode) {
      return;
    }

    const node =
      new AudioWorkletNode(
        context,
        "sprooto-debug-heartbeat-v12",
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        }
      );

    const silent =
      context.createGain();

    silent.gain.value =
      0;

    node
      .connect(silent)
      .connect(context.destination);

    node.port.onmessage =
      event => {
        const wallNow =
          performance.now();

        const frame =
          Number(
            event?.data?.frame
          ) || 0;

        const audioTime =
          Number(
            event?.data?.time
          ) || 0;

        if (
          sprootoDebugHeartbeatLastWall >
          0
        ) {
          sprootoDebugHeartbeatMaxGapWindow =
            Math.max(
              sprootoDebugHeartbeatMaxGapWindow,
              wallNow -
                sprootoDebugHeartbeatLastWall
            );
        }

        if (
          sprootoDebugHeartbeatFrame >
          0 &&
          frame >
            sprootoDebugHeartbeatFrame
        ) {
          const expectedFrameGap =
            context.sampleRate * 0.25;

          const actualFrameGap =
            frame -
            sprootoDebugHeartbeatFrame;

          sprootoDebugHeartbeatFrameGapMaxWindow =
            Math.max(
              sprootoDebugHeartbeatFrameGapMaxWindow,
              Math.abs(
                actualFrameGap -
                  expectedFrameGap
              )
            );
        }

        sprootoDebugHeartbeatLastWall =
          wallNow;

        sprootoDebugHeartbeatFrame =
          frame;

        sprootoDebugHeartbeatAudioTime =
          audioTime;

        sprootoDebugHeartbeatCount +=
          1;
      };

    sprootoDebugHeartbeatNode =
      node;
  } catch (error) {
    console.warn(
      "Debug heartbeat unavailable:",
      error
    );
  }
}

function sprootoDebugTimeout(callback, delay) {
  sprootoDebugTimersScheduled += 1;

  const safeDelay =
    Math.max(0, Number(delay) || 0);

  const expectedAt =
    performance.now() + safeDelay;

  return window.setTimeout(
    () => {
      sprootoDebugTimersFired += 1;

      const lateMs =
        Math.max(
          0,
          performance.now() - expectedAt
        );

      sprootoDebugTimerMaxLateMsWindow =
        Math.max(
          sprootoDebugTimerMaxLateMsWindow,
          lateMs
        );

      callback();
    },
    safeDelay
  );
}

function startSprootoDebugOverlay() {
  /*
   * Stage 35:
   * Keep diagnostics code available in source,
   * but disable the visible audio/load monitor.
   */
  return;

  if (
    sprootoDebugStarted ||
    typeof window === "undefined"
  ) {
    return;
  }

  sprootoDebugStarted = true;

  sprootoDebugWallStart =
    performance.now();

  sprootoDebugAudioStart =
    context?.currentTime || 0;

  sprootoDebugLastState =
    context?.state ?? "none";

  sprootoDebugStartRafMonitor();

  let panel =
    document.getElementById(
      "sprooto-audio-debug-panel"
    );

  if (!panel) {
    panel =
      document.createElement(
        "div"
      );

    panel.id =
      "sprooto-audio-debug-panel";

    Object.assign(
  panel.style,
  {
    position: "fixed",

    top: "8px",
    left: "8px",
    right: "8px",

    zIndex: "999999",

    boxSizing: "border-box",

    padding: "6px 8px",

    fontFamily:
      '"DM Mono", monospace',

    fontSize: "10px",
    lineHeight: "1.25",

    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",

    pointerEvents: "none",

    background:
      "rgba(21, 21, 21, 0.78)",

    color: "#fff",

    borderRadius: "6px"
  }
);

    const debugHost =
      document.body ||
      document.documentElement;

    debugHost?.appendChild(
      panel
    );
  }

  sprootoDebugInterval =
    window.setInterval(
      () => {
        if (!panel) {
          return;
        }

        const wall =
          (
            performance.now() -
            sprootoDebugWallStart
          ) / 1000;

        const audio =
          context
            ? context.currentTime -
              sprootoDebugAudioStart
            : 0;

        const drift =
          wall -
          audio;

        const hbAge =
          sprootoDebugHeartbeatLastWall > 0
            ? performance.now() -
              sprootoDebugHeartbeatLastWall
            : -1;

        const hbAudioDrift =
          sprootoDebugHeartbeatAudioTime > 0
            ? wall -
              (
                sprootoDebugHeartbeatAudioTime -
                sprootoDebugAudioStart
              )
            : 0;

        let outputWallDrift = NaN;

        try {
          if (
            typeof context?.getOutputTimestamp ===
            "function"
          ) {
            const stamp =
              context.getOutputTimestamp();

            const outputContextTime =
              Number(
                stamp?.contextTime
              );

            const outputPerformanceTime =
              Number(
                stamp?.performanceTime
              );

            if (
              Number.isFinite(outputContextTime) &&
              Number.isFinite(outputPerformanceTime)
            ) {
              const stampWall =
                (
                  outputPerformanceTime -
                  sprootoDebugWallStart
                ) / 1000;

              const stampAudio =
                outputContextTime -
                sprootoDebugAudioStart;

              outputWallDrift =
                stampWall -
                stampAudio;
            }
          }
        } catch {}

        const baseLatency =
          Number(
            context?.baseLatency
          );

        const outputLatency =
          Number(
            context?.outputLatency
          );

        panel.textContent =
  [
    `t ${audio.toFixed(0)} drift ${drift >= 0 ? "+" : ""}${drift.toFixed(2)} ${context?.state ?? "none"}`,
    `main ${Math.round(sprootoDebugMainLagMaxWindow)}ms timer ${Math.round(sprootoDebugTimerMaxLateMsWindow)}ms`,
    `hb ${hbAge < 0 ? "-" : Math.round(hbAge)}ms gap ${Math.round(sprootoDebugHeartbeatMaxGapWindow)}ms`,
    `nodes ${sprootoDebugNodesCreated} live ${Math.max(0, sprootoDebugNodesCreated - sprootoDebugNodesReleased)} src ${sprootoDebugLiveByType.source || 0} wrk ${sprootoDebugLiveByType.worklet || 0}`,
`calls ${sprootoDebugPlayCallsWindow}/s new ${sprootoDebugNodesCreatedWindow}/s free ${sprootoDebugNodesReleasedWindow}/s pan ${sprootoDebugLiveByType.pan || 0}`,

`start ${playbackStartSummary(
  playbackStartCapture
)}`,

`worst ${playbackStartSummary(
  playbackStartWorst
)}`
  ].join("\n");

        sprootoDebugPlayCallsWindow = 0;
        sprootoDebugNodesCreatedWindow = 0;
        sprootoDebugNodesReleasedWindow = 0;
        sprootoDebugMainLagMaxWindow = 0;
        sprootoDebugRafFramesWindow = 0;
        sprootoDebugTimerMaxLateMsWindow = 0;
        sprootoDebugHeartbeatMaxGapWindow = 0;
        sprootoDebugHeartbeatFrameGapMaxWindow = 0;
        sprootoDebugOscEndedWindow = 0;
      },
      1000
    );
}

const EQ_FREQUENCIES = [
  60, 120, 250, 500,
  1000, 2000, 4000, 8000
];

const EQ_BAND_EDGES = [
  35, 85, 175, 350, 700,
  1400, 2800, 5600, 12000
];

/*
 * Master Mix meter用の値は
 * 毎回新規生成せず、同じ領域を再利用する。
 */
const masterMixMeterData = {
  bands: new Float32Array(8),
  level: 0,
  limiterReduction: 0
};

const masterMixSettings = {
  eq: Array(8).fill(0),
  volume: 100,
  limiter: -1,
  reverb: 0
};

/*
 * Trackごとに最後に予約した発音の
 * GainNodeを保持する。
 *
 * 次のトリガー時に前音を短く閉じて、
 * FM波形同士の位相干渉を防ぐ。
 */
const activeTrackVoices =
  new Map();

async function ensureAudioClockReady() {
  if (!context) {
    return;
  }

  if (audioClockReady) {
    return;
  }

  if (!audioClockReadyPromise) {
    audioClockReadyPromise =
      new Promise(resolve => {
        const startAudioTime =
          context.currentTime;

        const checkClock = () => {
          if (!context) {
            audioClockReadyPromise = null;
            resolve();
            return;
          }

          if (
            context.state === "running" &&
            context.currentTime -
              startAudioTime >= 0.03
          ) {
            audioClockReady = true;
            audioClockReadyPromise = null;
            resolve();
            return;
          }

          sprootoDebugTimeout(
            checkClock,
            4
          );
        };

        checkClock();
      });
  }

  await audioClockReadyPromise;
}

function resumeAudioContext() {
  if (
    context &&
    context.state === "suspended"
  ) {
    audioClockReady = false;
    audioClockReadyPromise = null;

    context
      .resume()
      .then(() =>
        ensureAudioClockReady()
      )
      .catch(() => {});
  }
}

async function initializeFmVoiceWorklet() {
  if (!context?.audioWorklet) {
    return false;
  }

  if (!fmVoiceWorkletReady) {
    const processorSource = `
      class MoktonFmVoiceProcessor extends AudioWorkletProcessor {
        constructor(options) {
          super();

          const p =
            options.processorOptions || {};

          this.startTime =
            Number(p.startTime) || 0;

          this.stopTime =
            Number(p.stopTime) ||
            this.startTime;

          this.note =
            Number(p.note) || 60;

          this.fmDepth =
            Math.max(
              0,
              Number(p.fmDepth) || 0
            );

          this.fmRatio =
            Math.max(
              0.25,
              Number(p.fmRatio) || 1
            );

          this.pitchLfos =
            Array.isArray(p.pitchLfos)
              ? p.pitchLfos
              : [];

          this.carrierPhase = 0;
          this.modulatorPhase = 0;

          this.randomStates =
            this.pitchLfos.map(
              config =>
                this.makeRandomState(
                  config
                )
            );
        }

        frequency(note) {
          return (
            440 *
            Math.pow(
              2,
              (note - 69) / 12
            )
          );
        }

        clamp(value, min, max) {
          return Math.min(
            max,
            Math.max(
              min,
              value
            )
          );
        }

        makeRandomState(config) {
          if (
            config.wave !== "random"
          ) {
            return null;
          }

          return {
            interval:
              1 /
              Math.max(
                0.001,
                Number(
                  config.rateHz
                ) || 1
              ),

            nextTime: 0,

            value:
              Math.random() * 2 - 1
          };
        }

        lfoWaveValue(
          config,
          elapsedSeconds,
          randomState
        ) {
          const wave =
            config.wave;

          const rateHz =
            Math.max(
              0.001,
              Number(
                config.rateHz
              ) || 1
            );

          if (wave === "random") {
            while (
              elapsedSeconds >=
              randomState.nextTime
            ) {
              randomState.value =
                Math.random() * 2 - 1;

              randomState.nextTime +=
                randomState.interval;
            }

            return randomState.value;
          }

          if (
            wave === "rise" ||
            wave === "fall"
          ) {
            const progress =
              this.clamp(
                elapsedSeconds *
                  rateHz,
                0,
                1
              );

            return (
              wave === "fall"
                ? 1
                : -1
            ) *
              (1 - progress);
          }

          const phase =
            2 *
            Math.PI *
            rateHz *
            elapsedSeconds;

          switch (wave) {
            case "triangle":
              return (
                2 /
                Math.PI
              ) *
                Math.asin(
                  Math.sin(
                    phase
                  )
                );

            case "square":
              return (
                Math.sin(
                  phase
                ) >= 0
                  ? 1
                  : -1
              );

            case "sawUp":
              return (
                (
                  elapsedSeconds *
                  rateHz
                ) % 1
              ) *
                2 -
                1;

            case "sawDown":
              return (
                1 -
                (
                  (
                    elapsedSeconds *
                    rateHz
                  ) % 1
                ) *
                  2
              );

            default:
              return Math.sin(
                phase
              );
          }
        }

        pitchDepthToCents(config) {
          const depth =
            this.clamp(
              Number(
                config.depth
              ) || 0,
              0,
              100
            );

          return (
            config.wave === "rise" ||
            config.wave === "fall"
          )
            ? depth * 36
            : depth * 12;
        }

        process(inputs, outputs) {
          const channel =
            outputs[0]?.[0];

          if (!channel) {
            return true;
          }

          const blockStart =
            currentTime;

          if (
            blockStart >=
            this.stopTime
          ) {
            return false;
          }

          const baseFrequency =
            this.frequency(
              this.note
            );

          for (
            let i = 0;
            i < channel.length;
            i++
          ) {
            const sampleTime =
              blockStart +
              i / sampleRate;

            if (
              sampleTime <
                this.startTime ||
              sampleTime >=
                this.stopTime
            ) {
              channel[i] = 0;
              continue;
            }

            const elapsed =
              sampleTime -
              this.startTime;

            let pitchCents = 0;

            for (
              let n = 0;
              n <
                this.pitchLfos.length;
              n++
            ) {
              const config =
                this.pitchLfos[n];

              pitchCents +=
                this.lfoWaveValue(
                  config,
                  elapsed,
                  this.randomStates[n]
                ) *
                this.pitchDepthToCents(
                  config
                );
            }

            const carrierFrequency =
              baseFrequency *
              Math.pow(
                2,
                pitchCents / 1200
              );

            const fmAmount =
              carrierFrequency *
              this.fmDepth *
              0.1;

            const modulatorValue =
              Math.sin(
                this.modulatorPhase
              );

            const instantaneousFrequency =
              carrierFrequency +
              modulatorValue *
                fmAmount;

            channel[i] =
              Math.sin(
                this.carrierPhase
              );

            this.carrierPhase +=
              2 *
              Math.PI *
              instantaneousFrequency /
              sampleRate;

            this.modulatorPhase +=
              2 *
              Math.PI *
              (
                baseFrequency *
                this.fmRatio
              ) /
              sampleRate;

            if (
              this.carrierPhase >
              Math.PI * 2
            ) {
              this.carrierPhase %=
                Math.PI * 2;
            }

            if (
              this.modulatorPhase >
              Math.PI * 2
            ) {
              this.modulatorPhase %=
                Math.PI * 2;
            }
          }

          return true;
        }
      }

      registerProcessor(
        "mokton-fm-voice",
        MoktonFmVoiceProcessor
      );
    `;

    const blob =
      new Blob(
        [processorSource],
        {
          type:
            "application/javascript"
        }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    fmVoiceWorkletReady =
      context.audioWorklet
        .addModule(url)
        .then(() => true)
        .catch(error => {
          console.warn(
            "FM AudioWorklet unavailable:",
            error
          );

          return false;
        })
        .finally(
          () =>
            URL.revokeObjectURL(
              url
            )
        );
  }

  return fmVoiceWorkletReady;
}


export async function initializeAudio() {
  if (
    playbackStartCapture &&
    playbackStartCapture
      .initEnteredAt === null
  ) {
    playbackStartCapture.initEnteredAt =
      performance.now();
  }

  if (!context) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    context = new AudioContextClass();

    startSprootoDebugOverlay();
    audioClockReady = false;
    audioClockReadyPromise = null;
    master = sprootoDebugNode(context.createGain());
    master.gain.value = 0.7;

    mixInput = sprootoDebugNode(context.createGain());

    eqNodes = EQ_FREQUENCIES.map((frequency, index) => {
      const filter = sprootoDebugNode(context.createBiquadFilter());
      filter.type = index === 0
        ? "lowshelf"
        : index === EQ_FREQUENCIES.length - 1
          ? "highshelf"
          : "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = 1;
      filter.gain.value = masterMixSettings.eq[index];
      return filter;
    });

    reverbConvolver = context.createConvolver();
    reverbConvolver.buffer = createMasterReverbImpulse();

    reverbDryGain = sprootoDebugNode(context.createGain());
    reverbWetGain = sprootoDebugNode(context.createGain());

    mixGain = sprootoDebugNode(context.createGain());
    limiter = context.createDynamicsCompressor();
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    let previousNode = mixInput;
    eqNodes.forEach(filter => {
      previousNode.connect(filter);
      previousNode = filter;
    });

    spectrumAnalyser = context.createAnalyser();
    spectrumAnalyser.fftSize = 2048;
    spectrumAnalyser.smoothingTimeConstant = 0.72;
    previousNode.connect(spectrumAnalyser);

    previousNode.connect(reverbDryGain);
reverbDryGain.connect(mixGain);

previousNode.connect(reverbConvolver);
reverbWetGain.connect(mixGain);

reverbPathConnected = false;

    mixGain.connect(limiter);

    outputAnalyser = context.createAnalyser();
    outputAnalyser.fftSize = 1024;
    outputAnalyser.smoothingTimeConstant = 0.6;

    limiter.connect(outputAnalyser);
    outputAnalyser.connect(master);
    master.connect(context.destination);

    applyMasterMixSettings();
    document.addEventListener(
  "visibilitychange",
  resumeAudioContext
);

window.addEventListener(
  "pageshow",
  resumeAudioContext
);

window.addEventListener(
  "focus",
  resumeAudioContext
);

context.addEventListener(
  "statechange",
  () => {
    const nextState =
      context?.state ?? "none";

    if (
      nextState !==
      sprootoDebugLastState
    ) {
      sprootoDebugStateChanges += 1;
      sprootoDebugLastState =
        nextState;
    }
  }
);
  }

  await initializeFmVoiceWorklet();

  if (!offlineRenderMode) {
    sprootoDebugStartHeartbeat();
  }

  if (offlineRenderMode) {
    return;
  }

  if (context.state === "suspended") {
    audioClockReady = false;
    audioClockReadyPromise = null;
    await context.resume();
  }

  await ensureAudioClockReady();

if (
  playbackStartCapture &&
  playbackStartCapture
    .audioReadyAt === null
) {
  playbackStartCapture.audioReadyAt =
    performance.now();

  updatePlaybackStartCapture();
}
}

export function setMasterVolume(value) {
  if (!master || !context) return;
  master.gain.setTargetAtTime(clamp(Number(value), 0, 1), context.currentTime, 0.01);
}

function createMasterReverbImpulse() {
  const duration = 2.2;
  const sampleRate = context.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = context.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let seed = (0x5f3759df + channel * 104729) >>> 0;

    const nextRandom = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };

    for (let index = 0; index < length; index++) {
      const progress = index / length;
      const envelope = Math.pow(1 - progress, 2.6);
      data[index] = nextRandom() * envelope;
    }
  }

  return buffer;
}

function updateMasterReverbPath(reverbAmount) {
  if (
    !reverbConvolver ||
    !reverbWetGain ||
    offlineRenderMode
  ) {
    return;
  }

  if (reverbDisconnectTimer !== null) {
    clearTimeout(reverbDisconnectTimer);
    reverbDisconnectTimer = null;
  }

  if (reverbAmount > 0) {
    if (!reverbPathConnected) {
      reverbConvolver.connect(reverbWetGain);
      reverbPathConnected = true;
    }

    return;
  }

  if (!reverbPathConnected) {
    return;
  }

const convolver =
  reverbConvolver;

const wetGain =
  reverbWetGain;

  /*
   * Wet Gainの10msスムージングが終わってから
   * Convolver経路を切る。
   */
  reverbDisconnectTimer = setTimeout(() => {
    reverbDisconnectTimer = null;

    if (
      masterMixSettings.reverb > 0 ||
      !reverbPathConnected
    ) {
      return;
    }

    try {
      convolver.disconnect(wetGain);
    } catch (_) {
      // already disconnected
    }

    reverbPathConnected = false;
  }, 50);
}

function applyMasterMixSettings() {
  if (!context) return;

  const now = context.currentTime;

  eqNodes.forEach((filter, index) => {
    filter.gain.setTargetAtTime(
      masterMixSettings.eq[index] ?? 0,
      now,
      0.01
    );
  });

  mixGain?.gain.setTargetAtTime(
    clamp(masterMixSettings.volume, 0, 100) / 100,
    now,
    0.01
  );

  if (limiter) {
    limiter.threshold.setTargetAtTime(
      clamp(masterMixSettings.limiter, -24, 0),
      now,
      0.01
    );
  }

  const reverbAmount =
    clamp(masterMixSettings.reverb, 0, 100) / 100;

  reverbDryGain?.gain.setTargetAtTime(
    1,
    now,
    0.01
  );

  reverbWetGain?.gain.setTargetAtTime(
    reverbAmount,
    now,
    0.01
  );

  updateMasterReverbPath(reverbAmount);

}

export function setMasterMixEqBand(index, value) {
  if (index < 0 || index >= 8) return;
  masterMixSettings.eq[index] = clamp(Number(value) || 0, -12, 12);
  applyMasterMixSettings();
}

export function setMasterMixVolume(value) {
  masterMixSettings.volume = clamp(Number(value) || 0, 0, 100);
  applyMasterMixSettings();
}

export function setMasterLimiterThreshold(value) {
  masterMixSettings.limiter = clamp(Number(value) || 0, -24, 0);
  applyMasterMixSettings();
}

export function setMasterReverb(value) {
  masterMixSettings.reverb = clamp(Number(value) || 0, 0, 100);
  applyMasterMixSettings();
}

export function getMasterMixMeterData() {
  /*
   * Audio初期化前も新しいObjectを作らず、
   * 同じmeterデータを0にして返す。
   */
  if (
    !context ||
    !spectrumAnalyser ||
    !outputAnalyser
  ) {
    masterMixMeterData.bands.fill(0);
    masterMixMeterData.level = 0;
    masterMixMeterData.limiterReduction = 0;

    return masterMixMeterData;
  }

  /*
   * Analyserサイズが変わった時だけ確保。
   * 通常再生中は同じ配列を使い続ける。
   */
  if (
    !spectrumData ||
    spectrumData.length !==
      spectrumAnalyser.frequencyBinCount
  ) {
    spectrumData =
      new Uint8Array(
        spectrumAnalyser.frequencyBinCount
      );
  }

  if (
    !outputTimeData ||
    outputTimeData.length !==
      outputAnalyser.fftSize
  ) {
    outputTimeData =
      new Uint8Array(
        outputAnalyser.fftSize
      );
  }

  spectrumAnalyser.getByteFrequencyData(
    spectrumData
  );

  outputAnalyser.getByteTimeDomainData(
    outputTimeData
  );

  const nyquist =
    context.sampleRate / 2;

  const binHz =
    nyquist /
    spectrumAnalyser.frequencyBinCount;

  /*
   * 8バンドを既存のFloat32Arrayへ直接書く。
   * map()による新規Array生成を行わない。
   */
  for (
    let bandIndex = 0;
    bandIndex < 8;
    bandIndex++
  ) {
    const startBin =
      Math.max(
        0,
        Math.floor(
          EQ_BAND_EDGES[bandIndex] /
            binHz
        )
      );

    const endBin =
      Math.min(
        spectrumData.length - 1,
        Math.ceil(
          EQ_BAND_EDGES[
            bandIndex + 1
          ] /
            binHz
        )
      );

    let bandPeak = 0;
    let sum = 0;
    let count = 0;

    for (
      let binIndex = startBin;
      binIndex <= endBin;
      binIndex++
    ) {
      const normalized =
        spectrumData[binIndex] / 255;

      if (normalized > bandPeak) {
        bandPeak = normalized;
      }

      sum += normalized;
      count++;
    }

    const average =
      count > 0
        ? sum / count
        : 0;

    masterMixMeterData.bands[
  bandIndex
] =
  clamp(
    (
      bandPeak * 0.55 +
      average * 0.75
    ) /
    1.3,
    0,
    1
  );
  }

  /*
   * Master output level
   */
  let sumSquares = 0;
  let outputPeak = 0;

  for (
    let index = 0;
    index < outputTimeData.length;
    index++
  ) {
    const value =
      (
        outputTimeData[index] -
        128
      ) /
      128;

    const absolute =
      Math.abs(value);

    if (absolute > outputPeak) {
      outputPeak = absolute;
    }

    sumSquares +=
      value * value;
  }

  const rms =
    Math.sqrt(
      sumSquares /
        Math.max(
          1,
          outputTimeData.length
        )
    );

  masterMixMeterData.level =
    clamp(
      outputPeak * 0.7 +
        rms * 1.1,
      0,
      1
    );

  masterMixMeterData.limiterReduction =
  limiter
    ? Math.max(
        0,
        -(
          Number(
            limiter.reduction
          ) || 0
        )
      )
    : 0;

return masterMixMeterData;
}

function frequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/*
 * LFO Rate：
 * UI上の1〜100を0.1〜10Hzへ変換。
 */
function lfoRateToHz(
  value,
  syncMode = "free",
  bpm = 120
) {
  if (syncMode !== "bpm") {
    return (
      clamp(
        Number(value) || 1,
        1,
        100
      ) / 10
    );
  }

  const beatRatios = [
    1 / 16,
    1 / 12,
    1 / 8,
    1 / 6,
    1 / 4,
    1 / 3,
    1 / 2,
    2 / 3,
    1,
    4 / 3,
    2,
    4,
    8,
    16
  ];

  const index =
    clamp(
      Math.round(
        Number(value) || 0
      ),
      0,
      beatRatios.length - 1
    );

  const durationSeconds =
    (
      60 /
      Math.max(
        1,
        Number(bpm) || 120
      )
    ) *
    beatRatios[index];

  return (
    1 /
    Math.max(
      0.001,
      durationSeconds
    )
  );
}

const filterLfoCurveCache =
  new Map();

const FILTER_LFO_CURVE_CACHE_LIMIT =
  128;

function getFilterLfoCurve({
  wave,
  rateHz,
  modulationDuration,
  amountCents,
  sampleCount
}) {
  const key =
    `${wave}|` +
    `${rateHz}|` +
    `${modulationDuration}|` +
    `${amountCents}|` +
    `${sampleCount}`;

  const cached =
    filterLfoCurveCache.get(key);

  if (cached) {
    return cached;
  }

  const curve =
    new Float32Array(
      sampleCount
    );

  for (
    let sampleIndex = 0;
    sampleIndex < sampleCount;
    sampleIndex++
  ) {
    const progress =
      sampleCount <= 1
        ? 0
        : sampleIndex /
          (sampleCount - 1);

    const elapsedSeconds =
      progress *
      modulationDuration;

    const phase =
      2 *
      Math.PI *
      rateHz *
      elapsedSeconds;

    let waveValue = 0;

    switch (wave) {
      case "triangle":
        waveValue =
          (
            2 /
            Math.PI
          ) *
          Math.asin(
            Math.sin(phase)
          );
        break;

      case "square":
        waveValue =
          Math.sin(phase) >= 0
            ? 1
            : -1;
        break;

      case "sawUp": {
        const cyclePosition =
          (
            phase /
            (
              2 *
              Math.PI
            )
          ) % 1;

        waveValue =
          cyclePosition *
            2 -
          1;
        break;
      }

      case "sawDown": {
        const cyclePosition =
          (
            phase /
            (
              2 *
              Math.PI
            )
          ) % 1;

        waveValue =
          1 -
          cyclePosition *
            2;
        break;
      }

      case "sine":
      default:
        waveValue =
          Math.sin(phase);
        break;
    }

    curve[sampleIndex] =
      waveValue *
      amountCents;
  }

  /*
   * 曲中で大量の異なる設定を使っても
   * キャッシュが無制限に増えないよう制限。
   */
  if (
    filterLfoCurveCache.size >=
    FILTER_LFO_CURVE_CACHE_LIMIT
  ) {
    const oldestKey =
      filterLfoCurveCache
        .keys()
        .next()
        .value;

    filterLfoCurveCache.delete(
      oldestKey
    );
  }

  filterLfoCurveCache.set(
    key,
    curve
  );

  return curve;
}

/*
 * Random LFO
 *
 * 一定間隔ごとにランダム値を作り、
 * 次の更新時刻までその値を保持する。
 */
function createSampleAndHoldLfo({
  audioParam,
  depth,
  rateHz,
  startTime,
  stopTime
}) {
  const source =
    sprootoDebugNode(context.createConstantSource(), "lfo");

  const safeRate =
    Math.max(
      0.001,
      Number(rateHz) || 1
    );

  const interval =
    1 / safeRate;

  const safeDepth =
    Number.isFinite(
      Number(depth)
    )
      ? Number(depth)
      : 0;

  /*
   * ConstantSourceの出力を
   * AudioParamへ加算する。
   */
  source.connect(
    audioParam
  );

  /*
   * 発音開始時点から、
   * Rate間隔で新しいランダム値を設定する。
   */
  let time =
    startTime;

  let eventCount = 0;

  while (
    time <= stopTime &&
    eventCount < 4096
  ) {
    const randomValue =
      (
        Math.random() * 2 -
        1
      ) *
      safeDepth;

    source.offset.setValueAtTime(
      randomValue,
      time
    );

    time +=
      interval;

    eventCount += 1;
  }

  source.start(
    startTime
  );

  return source;
}


let sharedNoiseBuffer = null;
let sharedNoiseBufferContext = null;

function ensureSharedNoiseBuffer() {
  if (
    !context ||
    (
      sharedNoiseBuffer &&
      sharedNoiseBufferContext ===
        context
    )
  ) {
    return sharedNoiseBuffer;
  }

  const durationSeconds = 12;

  const length =
    Math.max(
      1,
      Math.ceil(
        context.sampleRate *
        durationSeconds
      )
    );

  const buffer =
    context.createBuffer(
      1,
      length,
      context.sampleRate
    );

  const data =
    buffer.getChannelData(0);

  /*
   * 毎発音Bufferを生成しない。
   * 1 AudioContextにつき1本だけ作り、
   * Rhythm Voiceから使い回す。
   */
  let seed = 0x6d6f6b74;

  for (
    let index = 0;
    index < length;
    index++
  ) {
    seed =
      (
        Math.imul(
          seed,
          1664525
        ) +
        1013904223
      ) >>> 0;

    data[index] =
      (
        seed /
        0xffffffff
      ) *
        2 -
      1;
  }

  sharedNoiseBuffer =
    buffer;

  sharedNoiseBufferContext =
    context;

  return buffer;
}

function soundLfoList(
  sound,
  bpm
) {
  return [sound?.lfo1, sound?.lfo2]
    .filter(
      lfo =>
        lfo &&
        typeof lfo === "object" &&
        clamp(
          Number(lfo.depth) || 0,
          0,
          100
        ) > 0
    )
    .map(lfo => ({
      target:
        String(
          lfo.target ??
          "pitch"
        ),

      wave:
        String(
          lfo.wave ??
          "sine"
        ),

      depth:
        clamp(
          Number(lfo.depth) || 0,
          0,
          100
        ),

      rateHz:
        lfoRateToHz(
          lfo.rate,
          lfo.syncMode === "bpm"
            ? "bpm"
            : "free",
          bpm
        )
    }));
}

function stepChordOffsets(chord) {
  /*
   * Chordの保存形式はまだ最終確定していない。
   * audio側は以下だけ受け入れ、勝手に新形式を決めない。
   *
   * null      -> 単音
   * number    -> 現行Chord index互換
   * number[]  -> 構成音の半音offset
   */
  if (
    Array.isArray(chord)
  ) {
    const offsets =
      chord
        .map(Number)
        .filter(
          Number.isFinite
        );

    return offsets.length
      ? offsets
      : [0];
  }

  if (
    Number.isFinite(
      Number(chord)
    )
  ) {
    return resolveChordNoteOffsets(
      Number(chord)
    );
  }

  return [0];
}

function envelopeSeconds(sound) {
  const attackValue =
    clamp(
      Number(
        sound?.attack
      ) || 1,
      1,
      100
    );

  const attackNormalized =
    (
      attackValue -
      1
    ) / 99;

  const attack =
    0.001 +
    0.999 *
      Math.pow(
        attackNormalized,
        2.4
      );

  const holdDecayValue =
    clamp(
      Number(
        sound?.holdDecay
      ) || 0,
      -50,
      50
    );

  const amount =
    Math.abs(
      holdDecayValue
    );

  const normalized =
    amount / 50;

  const duration =
    amount === 0
      ? 0.005
      : 0.005 +
        9.995 *
          Math.pow(
            normalized,
            3
          );

  return {
    attack,
    holdDecayValue,
    duration
  };
}

function layerPanValue(
  performanceData
) {
  return (
    clamp(
      Number(
        performanceData?.pan
      ) || 0,
      -25,
      25
    ) / 25
  );
}

function soundGainValue(
  sound,
  performanceData,
  velocityScale
) {
  const soundGain =
    clamp(
      Number(
        sound?.gain
      ) || 0,
      0,
      150
    ) / 100;

  const stepGain =
    clamp(
      Number(
        performanceData?.gain
      ) || 0,
      0,
      150
    ) / 100;

  return (
    soundGain *
    stepGain *
    clamp(
      Number(
        velocityScale
      ) || 1,
      0,
      1
    )
  );
}

function layerProbabilityPass(
  performanceData,
  options
) {
  if (
    options.ignoreProbability
  ) {
    return true;
  }

  const probability =
    clamp(
      Number(
        performanceData?.probability
      ) || 0,
      0,
      100
    );

  return (
    probability >= 100 ||
    Math.random() * 100 <
      probability
  );
}

function filterFrequencyFromValue(
  value
) {
  const normalized =
    clamp(
      Number(value) || 0,
      -50,
      50
    );

  if (normalized === 0) {
    return null;
  }

  if (normalized > 0) {
    /*
     * FIL upper side = High-pass / LOW CUT.
     * +1 is almost open; +50 removes the low range strongly.
     */
    const t =
      normalized / 50;

    return {
      type: "highpass",
      frequency:
        20 *
        Math.pow(
          7000 / 20,
          t
        )
    };
  }

  /*
   * FIL lower side = Low-pass / HIGH CUT.
   * -1 is almost open; -50 removes the high range strongly.
   */
  const t =
    Math.abs(
      normalized
    ) / 50;

  return {
    type: "lowpass",
    frequency:
      18000 *
      Math.pow(
        90 / 18000,
        t
      )
  };
}

function connectPanLfoForVoice({
  panner,
  lfos,
  startTime,
  stopTime,
  cleanupSources,
  cleanupGains
}) {
  if (!panner) {
    return;
  }

  lfos
    .filter(
      lfo =>
        lfo.target === "pan"
    )
    .forEach(lfo => {
      const depth =
        (
          lfo.depth /
          100
        );

      if (
        lfo.wave ===
        "random"
      ) {
        const source =
          createSampleAndHoldLfo({
            audioParam:
              panner.pan,
            depth,
            rateHz:
              lfo.rateHz,
            startTime,
            stopTime
          });

        source.stop(
          stopTime
        );

        cleanupSources.push(
          source
        );

        return;
      }

      const oscillator =
        sprootoDebugNode(
          context.createOscillator(),
          "lfo"
        );

      const gain =
        sprootoDebugNode(
          context.createGain(),
          "lfoGain"
        );

      const waveMap = {
        sine: "sine",
        triangle:
          "triangle",
        square:
          "square",
        sawUp:
          "sawtooth",
        sawDown:
          "sawtooth"
      };

      oscillator.type =
        waveMap[lfo.wave] ??
        "sine";

      oscillator.frequency
        .setValueAtTime(
          lfo.rateHz,
          startTime
        );

      gain.gain
        .setValueAtTime(
          lfo.wave ===
            "sawDown"
            ? -depth
            : depth,
          startTime
        );

      oscillator
        .connect(gain)
        .connect(
          panner.pan
        );

      oscillator.start(
        startTime
      );

      oscillator.stop(
        stopTime
      );

      cleanupSources.push(
        oscillator
      );

      cleanupGains.push(
        gain
      );
    });
}

function connectGainLfoForVoice({
  gainNode,
  lfos,
  peakLevel,
  startTime,
  stopTime,
  cleanupSources,
  cleanupGains
}) {
  lfos
    .filter(
      lfo =>
        lfo.target === "gain"
    )
    .forEach(lfo => {
      const depth =
        peakLevel *
        (
          lfo.depth /
          100
        );

      if (
        depth <= 0
      ) {
        return;
      }

      if (
        lfo.wave ===
        "random"
      ) {
        const source =
          createSampleAndHoldLfo({
            audioParam:
              gainNode.gain,
            depth,
            rateHz:
              lfo.rateHz,
            startTime,
            stopTime
          });

        source.stop(
          stopTime
        );

        cleanupSources.push(
          source
        );

        return;
      }

      const oscillator =
        sprootoDebugNode(
          context.createOscillator(),
          "lfo"
        );

      const gain =
        sprootoDebugNode(
          context.createGain(),
          "lfoGain"
        );

      const waveMap = {
        sine: "sine",
        triangle:
          "triangle",
        square:
          "square",
        sawUp:
          "sawtooth",
        sawDown:
          "sawtooth"
      };

      oscillator.type =
        waveMap[lfo.wave] ??
        "sine";

      oscillator.frequency
        .setValueAtTime(
          lfo.rateHz,
          startTime
        );

      gain.gain
        .setValueAtTime(
          lfo.wave ===
            "sawDown"
            ? -depth
            : depth,
          startTime
        );

      oscillator
        .connect(gain)
        .connect(
          gainNode.gain
        );

      oscillator.start(
        startTime
      );

      oscillator.stop(
        stopTime
      );

      cleanupSources.push(
        oscillator
      );

      cleanupGains.push(
        gain
      );
    });
}

function connectFilterLfoForVoice({
  filter,
  lfos,
  startTime,
  stopTime,
  cleanupSources,
  cleanupGains
}) {
  if (!filter) {
    return;
  }

  lfos
    .filter(
      lfo =>
        lfo.target ===
        "filter"
    )
    .forEach(lfo => {
      const depthCents =
        lfo.depth *
        24;

      if (
        lfo.wave ===
        "random"
      ) {
        const source =
          createSampleAndHoldLfo({
            audioParam:
              filter.detune,
            depth:
              depthCents,
            rateHz:
              lfo.rateHz,
            startTime,
            stopTime
          });

        source.stop(
          stopTime
        );

        cleanupSources.push(
          source
        );

        return;
      }

      const oscillator =
        sprootoDebugNode(
          context.createOscillator(),
          "lfo"
        );

      const gain =
        sprootoDebugNode(
          context.createGain(),
          "lfoGain"
        );

      const waveMap = {
        sine: "sine",
        triangle:
          "triangle",
        square:
          "square",
        sawUp:
          "sawtooth",
        sawDown:
          "sawtooth"
      };

      oscillator.type =
        waveMap[lfo.wave] ??
        "sine";

      oscillator.frequency
        .setValueAtTime(
          lfo.rateHz,
          startTime
        );

      gain.gain
        .setValueAtTime(
          lfo.wave ===
            "sawDown"
            ? -depthCents
            : depthCents,
          startTime
        );

      oscillator
        .connect(gain)
        .connect(
          filter.detune
        );

      oscillator.start(
        startTime
      );

      oscillator.stop(
        stopTime
      );

      cleanupSources.push(
        oscillator
      );

      cleanupGains.push(
        gain
      );
    });
}

async function playLayerVoice({
  layer,
  sound,
  performanceData,
  startTime,
  bpm,
  options
}) {
  if (
    !sound ||
    !performanceData ||
    !performanceData.soundId
  ) {
    return false;
  }

  if (
    !layerProbabilityPass(
      performanceData,
      options
    )
  ) {
    return false;
  }

  const {
    attack,
    holdDecayValue,
    duration
  } =
    envelopeSeconds(
      sound
    );

  const strumValue =
    layer === "melodic"
      ? clamp(
          Math.round(
            Number(
              performanceData.strum
            ) || 0
          ),
          -8,
          8
        )
      : 0;

  const soundNote =
    layer === "rhythm"
      ? (
          Number(
            sound.note
          ) || 0
        )
      : 0;

  const note =
    clamp(
      60 +
        soundNote +
        (
          Number(
            performanceData.note
          ) || 0
        ),
      0,
      127
    );

  const chordNotes =
    layer === "melodic"
      ? stepChordOffsets(
          performanceData.chord
        ).map(
          offset =>
            clamp(
              note + offset,
              0,
              127
            )
        )
      : [note];

  const strumGapSeconds =
    Math.abs(
      strumValue
    ) *
    (
      (
        60 /
        Math.max(
          1,
          bpm
        )
      ) /
      64
    );

  const maximumStrumDelay =
    chordNotes.length > 1
      ? (
          chordNotes.length -
          1
        ) *
        strumGapSeconds
      : 0;

  const gateEnd =
    startTime +
    duration +
    maximumStrumDelay;

  const releaseTime =
    0.05;

  const releaseEnd =
    gateEnd +
    releaseTime;

  const peakLevel =
    Math.max(
      0.0001,
      soundGainValue(
        sound,
        performanceData,
        options.velocityScale
      )
    );

  const voiceGain =
    sprootoDebugNode(
      context.createGain(),
      "voiceGain"
    );

  const attackEnd =
    startTime +
    attack;

  voiceGain.gain
    .setValueAtTime(
      0.0001,
      startTime
    );

  voiceGain.gain
    .exponentialRampToValueAtTime(
      peakLevel,
      attackEnd
    );

  if (
    holdDecayValue > 0
  ) {
    voiceGain.gain
      .linearRampToValueAtTime(
        0.0001,
        Math.max(
          attackEnd +
            0.001,
          gateEnd
        )
      );
  } else {
    voiceGain.gain
      .setValueAtTime(
        peakLevel,
        gateEnd
      );
  }

  voiceGain.gain
    .exponentialRampToValueAtTime(
      0.0001,
      releaseEnd
    );

  const lfos =
    soundLfoList(
      sound,
      bpm
    );

  const panValue =
    layerPanValue(
      performanceData
    );

  const panLfoActive =
    lfos.some(
      lfo =>
        lfo.target === "pan"
    );

  const panner =
    (
      panValue !== 0 ||
      panLfoActive
    )
      ? sprootoDebugNode(
          context.createStereoPanner(),
          "pan"
        )
      : null;

  if (panner) {
    panner.pan
      .setValueAtTime(
        panValue,
        startTime
      );
  }

  const filterDefinition =
    filterFrequencyFromValue(
      sound.filterCutoff
    );

  const filter =
    filterDefinition
      ? sprootoDebugNode(
          context.createBiquadFilter(),
          "filter"
        )
      : null;

  if (filter) {
    filter.type =
      filterDefinition.type;

    filter.frequency
      .setValueAtTime(
        filterDefinition.frequency,
        startTime
      );

    filter.Q
      .setValueAtTime(
        clamp(
          Number(
            sound.filterResonance
          ) || 0,
          0,
          50
        ) /
          2,
        startTime
      );
  }

  let outputNode =
    voiceGain;

  if (filter) {
    voiceGain.connect(
      filter
    );

    outputNode =
      filter;
  }

  if (panner) {
    outputNode.connect(
      panner
    );

    outputNode =
      panner;
  }

  let exportFadeGain = null;

  const fadeEnvelope =
    options.fadeEnvelope;

  if (
    offlineRenderMode ||
    fadeEnvelope
  ) {
    exportFadeGain =
      sprootoDebugNode(
        context.createGain(),
        "exportFade"
      );

    exportFadeGain.gain
      .setValueAtTime(
        1,
        0
      );

    if (fadeEnvelope) {
      const fadeInStart =
        Number(
          fadeEnvelope.fadeInStart
        );

      const fadeInEnd =
        Number(
          fadeEnvelope.fadeInEnd
        );

      const fadeOutStart =
        Number(
          fadeEnvelope.fadeOutStart
        );

      const fadeOutEnd =
        Number(
          fadeEnvelope.fadeOutEnd
        );

      if (
        Number.isFinite(
          fadeInStart
        ) &&
        Number.isFinite(
          fadeInEnd
        ) &&
        fadeInEnd >
          fadeInStart
      ) {
        exportFadeGain.gain
          .setValueAtTime(
            0,
            fadeInStart
          );

        exportFadeGain.gain
          .linearRampToValueAtTime(
            1,
            fadeInEnd
          );
      }

      if (
        Number.isFinite(
          fadeOutStart
        ) &&
        Number.isFinite(
          fadeOutEnd
        ) &&
        fadeOutEnd >
          fadeOutStart
      ) {
        exportFadeGain.gain
          .setValueAtTime(
            1,
            fadeOutStart
          );

        exportFadeGain.gain
          .linearRampToValueAtTime(
            0,
            fadeOutEnd
          );
      }
    }

    outputNode.connect(
      exportFadeGain
    );

    exportFadeGain.connect(
      mixInput
    );
  } else {
    outputNode.connect(
      mixInput
    );
  }

  const cleanupSources = [];
  const cleanupGains = [];

  connectPanLfoForVoice({
    panner,
    lfos,
    startTime,
    stopTime:
      releaseEnd,
    cleanupSources,
    cleanupGains
  });

  connectGainLfoForVoice({
    gainNode:
      voiceGain,
    lfos,
    peakLevel,
    startTime,
    stopTime:
      releaseEnd,
    cleanupSources,
    cleanupGains
  });

  connectFilterLfoForVoice({
    filter,
    lfos,
    startTime,
    stopTime:
      releaseEnd,
    cleanupSources,
    cleanupGains
  });

  const soundKey =
    `${layer}:${
      performanceData.soundId
    }`;

  const previousVoice =
    activeTrackVoices.get(
      soundKey
    );

  if (
    previousVoice?.gainNode &&
    previousVoice.endTime >
      startTime
  ) {
    const closeStart =
      Math.max(
        context.currentTime,
        startTime -
          0.004
      );

    try {
      previousVoice.gainNode.gain
        .cancelScheduledValues(
          closeStart
        );

      previousVoice.gainNode.gain
        .setValueAtTime(
          Math.max(
            0.0001,
            previousVoice.gainNode.gain.value
          ),
          closeStart
        );

      previousVoice.gainNode.gain
        .exponentialRampToValueAtTime(
          0.0001,
          startTime
        );
    } catch {}
  }

  activeTrackVoices.set(
    soundKey,
    {
      gainNode:
        voiceGain,
      startTime,
      endTime:
        releaseEnd
    }
  );

  const voiceGainScale =
    1 /
    Math.sqrt(
      Math.max(
        1,
        chordNotes.length
      )
    );

  const pitchLfos =
    lfos
      .filter(
        lfo =>
          lfo.target ===
          "pitch"
      )
      .map(lfo => ({
        depth:
          lfo.depth,
        rateHz:
          lfo.rateHz,
        wave:
          lfo.wave
      }));

  const fmDepth =
    layer === "melodic"
      ? clamp(
          Number(
            sound.fmDepth
          ) || 0,
          0,
          20
        )
      : 0;

  const fmRatio =
    layer === "melodic"
      ? clamp(
          Number(
            sound.fmRatio
          ) || 1,
          0.25,
          8
        )
      : 1;

  const sineMix =
    layer === "rhythm"
      ? (
          1 -
          clamp(
            Number(
              sound.noiseMix
            ) || 0,
            0,
            100
          ) /
            100
        )
      : 1;

  const noiseMix =
    layer === "rhythm"
      ? clamp(
          Number(
            sound.noiseMix
          ) || 0,
          0,
          100
        ) /
          100
      : 0;

  for (
    let voiceIndex = 0;
    voiceIndex <
      chordNotes.length;
    voiceIndex++
  ) {
    const voiceNote =
      chordNotes[
        voiceIndex
      ];

    const strumVoiceIndex =
      strumValue < 0
        ? chordNotes.length -
          1 -
          voiceIndex
        : voiceIndex;

    const voiceStartDelay =
      chordNotes.length > 1
        ? strumVoiceIndex *
          strumGapSeconds
        : 0;

    const voiceStartTime =
      startTime +
      voiceStartDelay;

    const voiceStopAt =
      releaseEnd +
      0.01 +
      voiceStartDelay;

    if (
      sineMix > 0
    ) {
      const sineGain =
        sprootoDebugNode(
          context.createGain(),
          "sineGain"
        );

      sineGain.gain
        .setValueAtTime(
          Math.max(
            0.0001,
            sineMix *
              voiceGainScale
          ),
          voiceStartTime
        );

      const canUseNativeSine =
        (
          layer === "rhythm" ||
          fmDepth <= 0
        ) &&
        pitchLfos.length === 0;

      if (
        canUseNativeSine
      ) {
        const oscillator =
          sprootoDebugNode(
            context.createOscillator(),
            "osc"
          );

        oscillator.type =
          "sine";

        oscillator.frequency
          .setValueAtTime(
            frequency(
              voiceNote
            ),
            voiceStartTime
          );

        oscillator
          .connect(
            sineGain
          )
          .connect(
            voiceGain
          );

        oscillator.start(
          voiceStartTime
        );

        oscillator.stop(
          voiceStopAt
        );

        if (
          !offlineRenderMode
        ) {
          sprootoDebugTimeout(
            () => {
              sprootoDebugOscEndedWindow +=
                1;

              sprootoDebugReleaseNode(
                oscillator
              );

              sprootoDebugReleaseNode(
                sineGain
              );
            },
            Math.max(
              20,
              (
                voiceStopAt -
                context.currentTime +
                0.05
              ) *
                1000
            )
          );
        }
      } else if (
        fmVoiceWorkletReady
      ) {
        sprootoDebugFmWorkletCreatedTotal +=
          1;

        const fmVoice =
          sprootoDebugNode(
            new AudioWorkletNode(
              context,
              "mokton-fm-voice",
              {
                numberOfInputs:
                  0,

                numberOfOutputs:
                  1,

                outputChannelCount:
                  [1],

                processorOptions: {
                  startTime:
                    voiceStartTime,

                  stopTime:
                    voiceStopAt,

                  note:
                    voiceNote,

                  fmDepth,

                  fmRatio,

                  pitchLfos
                }
              }
            ),
            "fmVoice"
          );

        fmVoice
          .connect(
            sineGain
          )
          .connect(
            voiceGain
          );

        if (
          !offlineRenderMode
        ) {
          sprootoDebugTimeout(
            () => {
              sprootoDebugReleaseNode(
                fmVoice
              );

              sprootoDebugReleaseNode(
                sineGain
              );
            },
            Math.max(
              50,
              (
                voiceStopAt -
                context.currentTime +
                0.05
              ) *
                1000
            )
          );
        }
      }
    }

    /*
     * RhythmだけNoiseを持つ。
     * noiseMix=0ならBufferSource自体を作らない。
     */
    if (
      layer === "rhythm" &&
      noiseMix > 0
    ) {
      const noiseSource =
        sprootoDebugNode(
          context.createBufferSource(),
          "noise"
        );

      const noiseGain =
        sprootoDebugNode(
          context.createGain(),
          "noiseGain"
        );

      noiseSource.buffer =
        ensureSharedNoiseBuffer();

      noiseSource.loop = true;

      noiseGain.gain
        .setValueAtTime(
          Math.max(
            0.0001,
            noiseMix
          ),
          voiceStartTime
        );

      noiseSource
        .connect(
          noiseGain
        )
        .connect(
          voiceGain
        );

      noiseSource.start(
        voiceStartTime
      );

      noiseSource.stop(
        voiceStopAt
      );

      if (
        !offlineRenderMode
      ) {
        sprootoDebugTimeout(
          () => {
            sprootoDebugReleaseNode(
              noiseSource
            );

            sprootoDebugReleaseNode(
              noiseGain
            );
          },
          Math.max(
            20,
            (
              voiceStopAt -
              context.currentTime +
              0.05
            ) *
              1000
          )
        );
      }
    }
  }

  if (
    !offlineRenderMode
  ) {
    sprootoDebugTimeout(
      () => {
        if (
          activeTrackVoices.get(
            soundKey
          )?.gainNode ===
          voiceGain
        ) {
          activeTrackVoices.delete(
            soundKey
          );
        }
      },
      Math.max(
        20,
        (
          releaseEnd -
          context.currentTime +
          0.05
        ) *
          1000
      )
    );

    sprootoDebugTimeout(
      () => {
        sprootoDebugCleanups +=
          1;

        cleanupSources.forEach(
          sprootoDebugReleaseNode
        );

        cleanupGains.forEach(
          sprootoDebugReleaseNode
        );

        [
          voiceGain,
          filter,
          panner,
          exportFadeGain
        ].forEach(
          sprootoDebugReleaseNode
        );
      },
      Math.max(
        100,
        (
          releaseEnd +
          0.15 -
          context.currentTime
        ) *
          1000
      )
    );
  }

  return true;
}

/*
 * New mokton playback entry.
 *
 * STEPにはMELODIC / RHYTHMの2層があるが、
 * Schedulerから見れば1つの時刻を予約する。
 */
export async function playSequenceStep(
  step,
  soundBank,
  delaySeconds = 0,
  options = {}
) {
  sprootoDebugPlayCallsTotal +=
    1;

  sprootoDebugPlayCallsWindow +=
    1;

  if (
    playbackStartCapture &&
    playbackStartCapture
      .firstTrackCallAt === null
  ) {
    playbackStartCapture
      .firstTrackCallAt =
      performance.now();
  }

  await initializeAudio();

  if (
    !step ||
    !soundBank
  ) {
    return false;
  }

  const requestedStartTime =
    context.currentTime +
    Math.max(
      0,
      Number(
        delaySeconds
      ) || 0
    );

  const minimumStartTime =
    context.currentTime +
    (
      offlineRenderMode
        ? 0
        : 0.03
    );

  const baseStartTime =
    Math.max(
      requestedStartTime,
      minimumStartTime
    );

  const bpm =
    Number(
      options.bpm
    ) ||
    Number(
      document.getElementById(
        "bpm-input"
      )?.value
    ) ||
    120;

  const jobs = [];

  const melodic =
    step.melodic;

  if (
    melodic?.soundId
  ) {
    const sound =
      soundBank.melodic?.[
        melodic.soundId
      ];

    if (sound) {
      const nudgeSeconds =
        (
          Number(
            melodic.nudge
          ) || 0
        ) *
        (
          (
            60 /
            Math.max(
              1,
              bpm
            )
          ) /
          64
        );

      jobs.push(
        playLayerVoice({
          layer:
            "melodic",

          sound,

          performanceData:
            melodic,

          startTime:
            Math.max(
              context.currentTime,
              baseStartTime +
                nudgeSeconds
            ),

          bpm,

          options
        })
      );
    }
  }

  const rhythm =
    step.rhythm;

  if (
    rhythm?.soundId
  ) {
    const sound =
      soundBank.rhythm?.[
        rhythm.soundId
      ];

    if (sound) {
      const nudgeSeconds =
        (
          Number(
            rhythm.nudge
          ) || 0
        ) *
        (
          (
            60 /
            Math.max(
              1,
              bpm
            )
          ) /
          64
        );

      jobs.push(
        playLayerVoice({
          layer:
            "rhythm",

          sound,

          performanceData:
            rhythm,

          startTime:
            Math.max(
              context.currentTime,
              baseStartTime +
                nudgeSeconds
            ),

          bpm,

          options
        })
      );
    }
  }

  if (
    jobs.length === 0
  ) {
    return false;
  }

  await Promise.all(
    jobs
  );

  return true;
}

/*
 * Transitional compatibility only.
 *
 * main.js / export.js are migrated next.
 * Old Track data is deliberately not synthesized anymore.
 */
export async function playTrackStep(
  track,
  stepIndex,
  delaySeconds = 0,
  options = {}
) {
  if (
    track?.sequenceStep &&
    track?.soundBank
  ) {
    return playSequenceStep(
      track.sequenceStep,
      track.soundBank,
      delaySeconds,
      options
    );
  }

  return false;
}

export function resetTrackPitchHistory() {
  /*
   * Glideは廃止。
   * 旧main.jsのimportを切り替えるまでexport名だけ残す。
   */
}

export function resumeAudio() {
  resumeAudioContext();
}

/*
 * iOS can return from a long background period with an AudioContext
 * that reports a usable state while its real output path is still stale.
 *
 * When the app was backgrounded while playback was stopped, main.js
 * uses this before the next PLAY so the first playback starts from a
 * fresh AudioContext / output clock instead of inheriting that stale state.
 */
export async function resetAudioForForegroundPlayback() {
  if (offlineRenderMode) {
    return;
  }

  if (reverbDisconnectTimer !== null) {
    clearTimeout(
      reverbDisconnectTimer
    );
    reverbDisconnectTimer = null;
  }

  stopPlaybackStartProbe();

  activeTrackVoices.clear();

  const oldContext =
    context;

  context = null;
  master = null;
  mixInput = null;
  mixGain = null;
  limiter = null;
  reverbConvolver = null;
  reverbDryGain = null;
  reverbWetGain = null;
  reverbPathConnected = false;
  spectrumAnalyser = null;
  outputAnalyser = null;
  eqNodes = [];
  spectrumData = null;
  outputTimeData = null;
  fmVoiceWorkletReady = null;

  audioClockReady = false;
  audioClockReadyPromise = null;

  sharedNoiseBuffer = null;
  sharedNoiseBufferContext = null;

  if (
    oldContext &&
    oldContext.state !== "closed"
  ) {
    try {
      await oldContext.close();
    } catch {}
  }
}

/* =========================
 * Offline export support
 * ========================= */
export async function beginOfflineAudioRender(
  offlineContext,
  {
    masterMix = {},
    masterVolume = 70
  } = {}
) {
  if (!offlineContext) {
    throw new Error("offline audio context is required");
  }

  const backup = {
    context,
    master,
    mixInput,
    mixGain,
    limiter,
    reverbConvolver,
    reverbDryGain,
    reverbWetGain,
    spectrumAnalyser,
    outputAnalyser,
    eqNodes,
    spectrumData,
    outputTimeData,
    fmVoiceWorkletReady,
    audioClockReady,
    audioClockReadyPromise,
    offlineRenderMode,
    activeTrackVoices: [...activeTrackVoices.entries()]
  };

  context = offlineContext;
  sharedNoiseBuffer = null;
  sharedNoiseBufferContext = null;

  offlineRenderMode = true;
  audioClockReady = true;
  audioClockReadyPromise = null;
  fmVoiceWorkletReady = null;
  spectrumData = null;
  outputTimeData = null;
  spectrumAnalyser = null;
  outputAnalyser = null;

  activeTrackVoices.clear();

  master = sprootoDebugNode(context.createGain());
  master.gain.value = clamp(Number(masterVolume) || 0, 0, 100) / 100;

  mixInput = sprootoDebugNode(context.createGain());

  const eqValues = Array.isArray(masterMix.eq)
    ? masterMix.eq
    : Array(8).fill(0);

  eqNodes = EQ_FREQUENCIES.map((frequency, index) => {
    const filter = sprootoDebugNode(context.createBiquadFilter());
    filter.type = index === 0
      ? "lowshelf"
      : index === EQ_FREQUENCIES.length - 1
        ? "highshelf"
        : "peaking";
    filter.frequency.value = frequency;
    filter.Q.value = 1;
    filter.gain.value = clamp(Number(eqValues[index]) || 0, -12, 12);
    return filter;
  });

  reverbConvolver = context.createConvolver();
  reverbConvolver.buffer = createMasterReverbImpulse();

  reverbDryGain = sprootoDebugNode(context.createGain());
  reverbWetGain = sprootoDebugNode(context.createGain());

  mixGain = sprootoDebugNode(context.createGain());
  mixGain.gain.value = clamp(Number(masterMix.volume ?? 100) || 0, 0, 100) / 100;

  limiter = context.createDynamicsCompressor();
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  limiter.threshold.value = clamp(Number(masterMix.limiter ?? -1) || 0, -24, 0);

  let previousNode = mixInput;
  eqNodes.forEach(filter => {
    previousNode.connect(filter);
    previousNode = filter;
  });

  previousNode.connect(reverbDryGain);
  reverbDryGain.connect(mixGain);

  previousNode.connect(reverbConvolver);
  reverbConvolver.connect(reverbWetGain);
  reverbWetGain.connect(mixGain);

  reverbDryGain.gain.value = 1;
  reverbWetGain.gain.value = clamp(Number(masterMix.reverb ?? 0) || 0, 0, 100) / 100;

  mixGain.connect(limiter);
  limiter.connect(master);
  master.connect(context.destination);


  await initializeFmVoiceWorklet();

  let restored = false;

  return function restoreOfflineAudioRender() {
    if (restored) return;
    restored = true;

    activeTrackVoices.clear();
    backup.activeTrackVoices.forEach(([key, value]) => {
      activeTrackVoices.set(key, value);
    });
context = backup.context;

    master = backup.master;
    mixInput = backup.mixInput;
    mixGain = backup.mixGain;
    limiter = backup.limiter;
    reverbConvolver = backup.reverbConvolver;
    reverbDryGain = backup.reverbDryGain;
    reverbWetGain = backup.reverbWetGain;
    spectrumAnalyser = backup.spectrumAnalyser;
    outputAnalyser = backup.outputAnalyser;
    eqNodes = backup.eqNodes;
    spectrumData = backup.spectrumData;
    outputTimeData = backup.outputTimeData;
    fmVoiceWorkletReady = backup.fmVoiceWorkletReady;
    audioClockReady = backup.audioClockReady;
    audioClockReadyPromise = backup.audioClockReadyPromise;
    offlineRenderMode = backup.offlineRenderMode;
  };
}

