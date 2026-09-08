import {
  STEP_COUNT,
  patterns,
  soundBank,
  song,
  state,
  clamp,
  soundIsAudible
} from "./sequencer.js";

import {
  playSequenceStep,
  beginOfflineAudioRender
} from "./audio.js";

const EXPORT_SAMPLE_RATE = 48000;
const EXPORT_CHANNELS = 2;
const EXPORT_TAIL_MAX_SECONDS = 30;
const EXPORT_TAIL_MIN_SECONDS = 0.75;
const TAIL_SILENCE_THRESHOLD = 0.0001;
const TAIL_SILENCE_HOLD_SECONDS = 0.5;

/*
 * SONG export:
 * Safari / iPhoneで長いSong全体を1個のOfflineAudioContextへ
 * 一括予約するとstartRendering()が戻らないケースを避けるため、
 * source単位の小さなchunkへ分割して順番にrenderする。
 *
 * 1 chunkを小さめに保ち、AudioWorklet / AudioNode graphの
 * 同時生成数を抑える。
 */
const SONG_CHUNK_MAX_SECONDS = 12;

const SUB_PATTERNS = Object.freeze([
  { divisions: 2, hits: [0, 1] },
  { divisions: 2, hits: [1] },
  { divisions: 3, hits: [0, 1, 2] },
  { divisions: 4, hits: [0, 1, 2, 3] },
  { divisions: 4, hits: [0, 2] },
  { divisions: 4, hits: [0, 1] },
  { divisions: 6, hits: [0, 1, 2, 3, 4, 5] }
]);

export class ExportCancelledError extends Error {
  constructor() {
    super("export cancelled");
    this.name = "ExportCancelledError";
  }
}

function assertNotCancelled(signal) {
  if (signal?.cancelled) {
    throw new ExportCancelledError();
  }
}

function sourceData(type, index) {
  return patterns[index] ?? null;
}

function sourceLength(source) {
  return STEP_COUNT;
}

function sourceDuration(item, bpm) {
  const source = sourceData(item.type, item.index);
  return source
    ? sourceLength(source) *
        ((60 / Math.max(1, bpm)) / 4)
    : 0;
}

function flattenTarget(target) {
  if (target === "song") {
    const order = Array.isArray(song.order)
      ? song.order
      : [];

    return order
      .filter(index =>
        Number.isInteger(index) &&
        patterns[index]
      )
      .map(index => ({
        type: "pattern",
        index
      }));
  }

  const selectedIndex =
    Number.isInteger(
      state.selectedPatternIndex
    )
      ? state.selectedPatternIndex
      : 0;

  return patterns[selectedIndex]
    ? [{
        type: "pattern",
        index: selectedIndex
      }]
    : [];
}

function layerOnlyStep(
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

function layerProbabilityPass(
  performanceData
) {
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

async function scheduleLayer({
  layer,
  performanceData,
  baseStart,
  stepSeconds,
  bpm
}) {
  if (
    !performanceData?.soundId ||
    !soundIsAudible(
      layer,
      performanceData.soundId
    ) ||
    !layerProbabilityPass(
      performanceData
    )
  ) {
    return;
  }

  const patternIndex =
    Math.round(
      Number(
        performanceData.subPattern
      ) || -1
    );

  const pattern =
    patternIndex >= 0
      ? SUB_PATTERNS[patternIndex]
      : null;

  const playAt = async (
    eventTime
  ) => {
    await playSequenceStep(
      layerOnlyStep(
        layer,
        performanceData
      ),
      soundBank,
      Math.max(0, eventTime),
      {
        bpm,
        ignoreProbability: true
      }
    );
  };

  if (!pattern) {
    await playAt(baseStart);
    return;
  }

  if (layer === "rhythm") {
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
      await playAt(baseStart);
      return;
    }
  }

  for (
    const subIndex of pattern.hits
  ) {
    await playAt(
      baseStart +
      stepSeconds *
        (
          subIndex /
          pattern.divisions
        )
    );
  }
}

function timingGuardSeconds(bpm) {
  return (
    (60 / Math.max(1, bpm)) /
    64 *
    12
  );
}

function estimateTailSafetySeconds(
  sources,
  bpm,
  masterReverbAmount = 0
) {
  let required =
    Number(masterReverbAmount) > 0
      ? 2.7
      : EXPORT_TAIL_MIN_SECONDS;

  const inspectSound = sound => {
    if (!sound) return;

    const holdDecayValue =
      clamp(
        Number(
          sound.holdDecay
        ) || 0,
        -50,
        50
      );

    const amount =
      Math.abs(holdDecayValue);

    const normalized =
      amount / 50;

    const envelopeSeconds =
      amount === 0
        ? 0.005
        : 0.005 +
          9.995 *
          Math.pow(
            normalized,
            3
          );

    required =
      Math.max(
        required,
        envelopeSeconds + 0.15
      );
  };

  sources.forEach(item => {
    const source =
      sourceData(
        item.type,
        item.index
      );

    source?.sequence?.forEach(
      step => {
        if (step?.melodic?.soundId) {
          inspectSound(
            soundBank.melodic?.[
              step.melodic.soundId
            ]
          );
        }

        if (step?.rhythm?.soundId) {
          inspectSound(
            soundBank.rhythm?.[
              step.rhythm.soundId
            ]
          );
        }
      }
    );
  });

  return clamp(
    required,
    EXPORT_TAIL_MIN_SECONDS,
    EXPORT_TAIL_MAX_SECONDS
  );
}

async function scheduleSource({
  source,
  sourceStartSeconds,
  bpm,
  headSeconds,
  guardSeconds,
  signal
}) {
  const stepSeconds =
    (60 / Math.max(1, bpm)) / 4;

  for (
    let tick = 0;
    tick < STEP_COUNT;
    tick++
  ) {
    assertNotCancelled(signal);

    const step =
      source?.sequence?.[tick];

    if (!step) {
      continue;
    }

    const baseStart =
      guardSeconds +
      headSeconds +
      sourceStartSeconds +
      tick * stepSeconds;

    await scheduleLayer({
      layer: "melodic",
      performanceData:
        step.melodic,
      baseStart,
      stepSeconds,
      bpm
    });

    await scheduleLayer({
      layer: "rhythm",
      performanceData:
        step.rhythm,
      baseStart,
      stepSeconds,
      bpm
    });
  }

  return STEP_COUNT *
    stepSeconds;
}

function findTailEndFrame(
  buffer,
  bodyEndFrame
) {
  const holdFrames =
    Math.max(
      1,
      Math.round(
        TAIL_SILENCE_HOLD_SECONDS *
        buffer.sampleRate
      )
    );

  const blockFrames =
    Math.max(
      1,
      Math.round(
        buffer.sampleRate * 0.01
      )
    );

  let silenceFrames = 0;
  let silenceStart = bodyEndFrame;

  for (
    let start = bodyEndFrame;
    start < buffer.length;
    start += blockFrames
  ) {
    const end =
      Math.min(
        buffer.length,
        start + blockFrames
      );

    let peak = 0;

    for (
      let channel = 0;
      channel <
      buffer.numberOfChannels;
      channel++
    ) {
      const data =
        buffer.getChannelData(
          channel
        );

      for (
        let frame = start;
        frame < end;
        frame++
      ) {
        const absolute =
          Math.abs(data[frame]);

        if (absolute > peak) {
          peak = absolute;
        }
      }
    }

    if (
      peak <=
      TAIL_SILENCE_THRESHOLD
    ) {
      if (
        silenceFrames === 0
      ) {
        silenceStart = start;
      }

      silenceFrames +=
        end - start;

      if (
        silenceFrames >=
        holdFrames
      ) {
        return Math.max(
          bodyEndFrame,
          silenceStart
        );
      }
    } else {
      silenceFrames = 0;
      silenceStart = end;
    }
  }

  return buffer.length;
}

function applyFades({
  channels,
  headSeconds,
  bodyDuration,
  fadeInSeconds,
  fadeOutSeconds
}) {
  const outputLength =
    channels[0]?.length ?? 0;

  const bodyStart =
    Math.round(
      headSeconds *
      EXPORT_SAMPLE_RATE
    );

  const bodyEnd =
    Math.min(
      outputLength,
      Math.round(
        (
          headSeconds +
          bodyDuration
        ) *
        EXPORT_SAMPLE_RATE
      )
    );

  const fadeInFrames =
    Math.min(
      Math.round(
        Math.max(
          0,
          fadeInSeconds
        ) *
        EXPORT_SAMPLE_RATE
      ),
      Math.max(
        0,
        bodyEnd - bodyStart
      )
    );

  const fadeOutFrames =
    Math.min(
      Math.round(
        Math.max(
          0,
          fadeOutSeconds
        ) *
        EXPORT_SAMPLE_RATE
      ),
      Math.max(
        0,
        bodyEnd - bodyStart
      )
    );

  channels.forEach(data => {
    for (
      let index = 0;
      index < fadeInFrames;
      index++
    ) {
      const gain =
        fadeInFrames <= 1
          ? 1
          : index /
            (fadeInFrames - 1);

      data[
        bodyStart + index
      ] *= gain;
    }

    const fadeOutStart =
      Math.max(
        bodyStart,
        bodyEnd -
        fadeOutFrames
      );

    for (
      let frame = fadeOutStart;
      frame < bodyEnd;
      frame++
    ) {
      const gain =
        fadeOutFrames <= 1
          ? 0
          : (
              bodyEnd -
              1 -
              frame
            ) /
            (
              fadeOutFrames -
              1
            );

      data[frame] *=
        clamp(
          gain,
          0,
          1
        );
    }
  });
}

function copyProcessedChannels({
  buffer,
  guardFrames,
  outputEndFrame,
  headSeconds,
  bodyDuration,
  fadeInSeconds,
  fadeOutSeconds
}) {
  const channels =
    Array.from(
      {
        length:
          EXPORT_CHANNELS
      },
      (_, channelIndex) => {
        const source =
          buffer.getChannelData(
            Math.min(
              channelIndex,
              buffer.numberOfChannels -
              1
            )
          );

        return source.slice(
          guardFrames,
          outputEndFrame
        );
      }
    );

  applyFades({
    channels,
    headSeconds,
    bodyDuration,
    fadeInSeconds,
    fadeOutSeconds
  });

  return channels;
}

function buildSongChunks(
  sources,
  bpm
) {
  const chunks = [];
  let current = [];
  let currentDuration = 0;

  sources.forEach(item => {
    const duration =
      sourceDuration(
        item,
        bpm
      );

    if (
      current.length > 0 &&
      currentDuration + duration >
        SONG_CHUNK_MAX_SECONDS
    ) {
      chunks.push(current);
      current = [];
      currentDuration = 0;
    }

    current.push(item);
    currentDuration += duration;
  });

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function renderSongChunk({
  items,
  bpm,
  guardSeconds,
  tailSafety,
  masterVolume,
  signal
}) {
  const OfflineAudioContextClass =
    window.OfflineAudioContext ||
    window.webkitOfflineAudioContext;

  let chunkBodyDuration = 0;

  items.forEach(item => {
    chunkBodyDuration +=
      sourceDuration(
        item,
        bpm
      );
  });

  const renderDuration =
    Math.max(
      0.1,
      guardSeconds +
      chunkBodyDuration +
      tailSafety
    );

  const frameLength =
    Math.ceil(
      renderDuration *
      EXPORT_SAMPLE_RATE
    );

  const offlineContext =
    new OfflineAudioContextClass(
      EXPORT_CHANNELS,
      frameLength,
      EXPORT_SAMPLE_RATE
    );

  const restoreAudio =
    await beginOfflineAudioRender(
      offlineContext,
      {
        masterMix:
          song.masterMix,
        masterVolume
      }
    );

  try {
    let sourceStartSeconds = 0;

    for (
      const item of items
    ) {
      assertNotCancelled(
        signal
      );

      const source =
        sourceData(
          item.type,
          item.index
        );

      await scheduleSource({
        source,
        sourceStartSeconds,
        bpm,
        headSeconds: 0,
        guardSeconds,
        signal
      });

      sourceStartSeconds +=
        sourceDuration(
          item,
          bpm
        );
    }

    assertNotCancelled(
      signal
    );

    const renderedBuffer =
      await offlineContext
        .startRendering();

    assertNotCancelled(
      signal
    );

    const guardFrames =
      Math.round(
        guardSeconds *
        EXPORT_SAMPLE_RATE
      );

    const bodyFrames =
      Math.round(
        chunkBodyDuration *
        EXPORT_SAMPLE_RATE
      );

    const rawBodyEndFrame =
      Math.min(
        renderedBuffer.length,
        guardFrames +
        bodyFrames
      );

    const rawEndFrame =
      findTailEndFrame(
        renderedBuffer,
        rawBodyEndFrame
      );

    const channels =
      Array.from(
        {
          length:
            EXPORT_CHANNELS
        },
        (_, channelIndex) => {
          const source =
            renderedBuffer
              .getChannelData(
                Math.min(
                  channelIndex,
                  renderedBuffer
                    .numberOfChannels -
                  1
                )
              );

          return source.slice(
            guardFrames,
            rawEndFrame
          );
        }
      );

    return {
      channels,
      bodyDuration:
        chunkBodyDuration
    };
  } finally {
    restoreAudio();
  }
}

async function renderSongChunked({
  sources,
  bpm,
  guardSeconds,
  tailSafety,
  headSeconds,
  endMode,
  masterVolume,
  signal,
  onProgress
}) {
  const chunks =
    buildSongChunks(
      sources,
      bpm
    );

  const bodyDuration =
    sources.reduce(
      (
        total,
        item
      ) =>
        total +
        sourceDuration(
          item,
          bpm
        ),
      0
    );

  const outputTailSeconds =
    endMode === "tail"
      ? tailSafety
      : 0;

  const outputLength =
    Math.max(
      1,
      Math.ceil(
        (
          headSeconds +
          bodyDuration +
          outputTailSeconds
        ) *
        EXPORT_SAMPLE_RATE
      )
    );

  const outputChannels =
    Array.from(
      {
        length:
          EXPORT_CHANNELS
      },
      () =>
        new Float32Array(
          outputLength
        )
    );

  let bodyWriteSeconds = 0;

  for (
    let chunkIndex = 0;
    chunkIndex <
    chunks.length;
    chunkIndex++
  ) {
    assertNotCancelled(
      signal
    );

    const rendered =
      await renderSongChunk({
        items:
          chunks[chunkIndex],
        bpm,
        guardSeconds,
        tailSafety:
          endMode === "tail"
            ? tailSafety
            : EXPORT_TAIL_MIN_SECONDS,
        masterVolume,
        signal
      });

    const writeStart =
      Math.round(
        (
          headSeconds +
          bodyWriteSeconds
        ) *
        EXPORT_SAMPLE_RATE
      );

    for (
      let channel = 0;
      channel <
      EXPORT_CHANNELS;
      channel++
    ) {
      const source =
        rendered.channels[
          channel
        ];

      const destination =
        outputChannels[
          channel
        ];

      const available =
        Math.max(
          0,
          destination.length -
          writeStart
        );

      const copyLength =
        Math.min(
          source.length,
          available
        );

      for (
        let frame = 0;
        frame < copyLength;
        frame++
      ) {
        destination[
          writeStart + frame
        ] += source[frame];
      }
    }

    bodyWriteSeconds +=
      rendered.bodyDuration;

    onProgress?.(
      25 +
      Math.round(
        (
          (chunkIndex + 1) /
          chunks.length
        ) *
        65
      ),
      "rendering"
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          0
        )
    );
  }

  let outputEndFrame;

  if (endMode === "loop") {
    outputEndFrame =
      Math.min(
        outputLength,
        Math.round(
          (
            headSeconds +
            bodyDuration
          ) *
          EXPORT_SAMPLE_RATE
        )
      );
  } else {
    const bodyEndFrame =
      Math.min(
        outputLength,
        Math.round(
          (
            headSeconds +
            bodyDuration
          ) *
          EXPORT_SAMPLE_RATE
        )
      );

    const holdFrames =
      Math.max(
        1,
        Math.round(
          TAIL_SILENCE_HOLD_SECONDS *
          EXPORT_SAMPLE_RATE
        )
      );

    const blockFrames =
      Math.max(
        1,
        Math.round(
          EXPORT_SAMPLE_RATE *
          0.01
        )
      );

    let silenceFrames = 0;
    let silenceStart =
      bodyEndFrame;

    outputEndFrame =
      outputLength;

    for (
      let start = bodyEndFrame;
      start < outputLength;
      start += blockFrames
    ) {
      const end =
        Math.min(
          outputLength,
          start + blockFrames
        );

      let peak = 0;

      for (
        let channel = 0;
        channel <
        EXPORT_CHANNELS;
        channel++
      ) {
        const data =
          outputChannels[
            channel
          ];

        for (
          let frame = start;
          frame < end;
          frame++
        ) {
          peak =
            Math.max(
              peak,
              Math.abs(
                data[frame]
              )
            );
        }
      }

      if (
        peak <=
        TAIL_SILENCE_THRESHOLD
      ) {
        if (
          silenceFrames === 0
        ) {
          silenceStart =
            start;
        }

        silenceFrames +=
          end - start;

        if (
          silenceFrames >=
          holdFrames
        ) {
          outputEndFrame =
            Math.max(
              bodyEndFrame,
              silenceStart
            );
          break;
        }
      } else {
        silenceFrames = 0;
        silenceStart = end;
      }
    }
  }

  return {
    channels:
      outputChannels.map(
        data =>
          data.slice(
            0,
            outputEndFrame
          )
      ),
    bodyDuration
  };
}

function writeAscii(
  view,
  offset,
  text
) {
  for (
    let index = 0;
    index < text.length;
    index++
  ) {
    view.setUint8(
      offset + index,
      text.charCodeAt(index)
    );
  }
}

function encodeWav24(
  channels,
  sampleRate
) {
  const frameCount =
    channels[0]?.length ?? 0;

  const bytesPerSample = 3;

  const blockAlign =
    channels.length *
    bytesPerSample;

  const dataSize =
    frameCount *
    blockAlign;

  const arrayBuffer =
    new ArrayBuffer(
      44 + dataSize
    );

  const view =
    new DataView(
      arrayBuffer
    );

  writeAscii(
    view,
    0,
    "RIFF"
  );

  view.setUint32(
    4,
    36 + dataSize,
    true
  );

  writeAscii(
    view,
    8,
    "WAVE"
  );

  writeAscii(
    view,
    12,
    "fmt "
  );

  view.setUint32(
    16,
    16,
    true
  );

  view.setUint16(
    20,
    1,
    true
  );

  view.setUint16(
    22,
    channels.length,
    true
  );

  view.setUint32(
    24,
    sampleRate,
    true
  );

  view.setUint32(
    28,
    sampleRate *
    blockAlign,
    true
  );

  view.setUint16(
    32,
    blockAlign,
    true
  );

  view.setUint16(
    34,
    24,
    true
  );

  writeAscii(
    view,
    36,
    "data"
  );

  view.setUint32(
    40,
    dataSize,
    true
  );

  let offset = 44;

  for (
    let frame = 0;
    frame < frameCount;
    frame++
  ) {
    for (
      let channel = 0;
      channel <
      channels.length;
      channel++
    ) {
      const sample =
        clamp(
          channels[channel][frame] ||
          0,
          -1,
          1
        );

      let integer =
        sample < 0
          ? Math.round(
              sample *
              0x800000
            )
          : Math.round(
              sample *
              0x7fffff
            );

      if (
        integer < 0
      ) {
        integer +=
          0x1000000;
      }

      view.setUint8(
        offset,
        integer & 0xff
      );

      view.setUint8(
        offset + 1,
        (
          integer >> 8
        ) & 0xff
      );

      view.setUint8(
        offset + 2,
        (
          integer >> 16
        ) & 0xff
      );

      offset += 3;
    }
  }

  return new Blob(
    [arrayBuffer],
    {
      type: "audio/wav"
    }
  );
}

/*
 * PART / Section:
 * 従来どおり1個のOfflineAudioContextでrender。
 */
async function renderSingleContext({
  sources,
  endMode,
  safeHead,
  safeFadeIn,
  safeFadeOut,
  safeBpm,
  masterVolume,
  guardSeconds,
  tailSafety,
  bodyDuration,
  signal,
  onProgress
}) {
  const OfflineAudioContextClass =
    window.OfflineAudioContext ||
    window.webkitOfflineAudioContext;

  const renderDuration =
    Math.max(
      0.1,
      guardSeconds +
      safeHead +
      bodyDuration +
      tailSafety
    );

  const frameLength =
    Math.ceil(
      renderDuration *
      EXPORT_SAMPLE_RATE
    );

  const offlineContext =
    new OfflineAudioContextClass(
      EXPORT_CHANNELS,
      frameLength,
      EXPORT_SAMPLE_RATE
    );

  const restoreAudio =
    await beginOfflineAudioRender(
      offlineContext,
      {
        masterMix:
          song.masterMix,
        masterVolume
      }
    );

  try {
    let sourceStartSeconds = 0;

    for (
      let index = 0;
      index < sources.length;
      index++
    ) {
      assertNotCancelled(
        signal
      );

      const item =
        sources[index];

      const source =
        sourceData(
          item.type,
          item.index
        );

      await scheduleSource({
        source,
        sourceStartSeconds,
        bpm: safeBpm,
        headSeconds:
          safeHead,
        guardSeconds,
        signal
      });

      sourceStartSeconds +=
        sourceDuration(
          item,
          safeBpm
        );

      onProgress?.(
        8 +
        Math.round(
          (
            (index + 1) /
            sources.length
          ) *
          16
        ),
        "preparing"
      );
    }

    assertNotCancelled(
      signal
    );

    onProgress?.(
      25,
      "rendering"
    );

    const renderedBuffer =
      await offlineContext
        .startRendering();

    assertNotCancelled(
      signal
    );

    onProgress?.(
      93,
      "processing"
    );

    const guardFrames =
      Math.round(
        guardSeconds *
        EXPORT_SAMPLE_RATE
      );

    const rawBodyEndFrame =
      Math.min(
        renderedBuffer.length,
        Math.round(
          (
            guardSeconds +
            safeHead +
            bodyDuration
          ) *
          EXPORT_SAMPLE_RATE
        )
      );

    const rawEndFrame =
      endMode === "loop"
        ? rawBodyEndFrame
        : findTailEndFrame(
            renderedBuffer,
            rawBodyEndFrame
          );

    return copyProcessedChannels({
      buffer:
        renderedBuffer,
      guardFrames,
      outputEndFrame:
        rawEndFrame,
      headSeconds:
        safeHead,
      bodyDuration,
      fadeInSeconds:
        safeFadeIn,
      fadeOutSeconds:
        safeFadeOut
    });
  } finally {
    restoreAudio();
  }
}

export async function renderExportWav({
  target = "song",
  endMode = "tail",
  headSeconds = 0,
  fadeInSeconds = 0,
  fadeOutSeconds = 0,
  bpm = 120,
  masterVolume = 70,
  signal = null,
  onProgress = null
} = {}) {
  assertNotCancelled(
    signal
  );

  const sources =
    flattenTarget(
      target
    );

  if (!sources.length) {
    throw new Error(
      target === "song"
        ? "song is empty"
        : "part is empty"
    );
  }

  const safeBpm =
    clamp(
      Number(bpm) || 120,
      40,
      300
    );

  const safeHead =
    endMode === "loop"
      ? 0
      : clamp(
          Number(
            headSeconds
          ) || 0,
          0,
          5
        );

  const safeFadeIn =
    endMode === "loop"
      ? 0
      : clamp(
          Number(
            fadeInSeconds
          ) || 0,
          0,
          30
        );

  const safeFadeOut =
    endMode === "loop"
      ? 0
      : clamp(
          Number(
            fadeOutSeconds
          ) || 0,
          0,
          30
        );

  const guardSeconds =
    timingGuardSeconds(
      safeBpm
    );

  const bodyDuration =
    sources.reduce(
      (
        total,
        item
      ) =>
        total +
        sourceDuration(
          item,
          safeBpm
        ),
      0
    );

  const tailSafety =
    endMode === "tail"
      ? estimateTailSafetySeconds(
          sources,
          safeBpm,
          song.masterMix?.reverb ??
          0
        )
      : 0;

  const OfflineAudioContextClass =
    window.OfflineAudioContext ||
    window.webkitOfflineAudioContext;

  if (
    !OfflineAudioContextClass
  ) {
    throw new Error(
      "offline audio rendering is not supported in this browser"
    );
  }

  onProgress?.(
    4,
    "preparing"
  );

  let channels;

  if (
    target === "song"
  ) {
    /*
     * SONGだけchunk render。
     */
    onProgress?.(
      25,
      "rendering"
    );

    const rendered =
      await renderSongChunked({
        sources,
        bpm:
          safeBpm,
        guardSeconds,
        tailSafety,
        headSeconds:
          safeHead,
        endMode,
        masterVolume,
        signal,
        onProgress
      });

    channels =
      rendered.channels;

    applyFades({
      channels,
      headSeconds:
        safeHead,
      bodyDuration:
        rendered.bodyDuration,
      fadeInSeconds:
        safeFadeIn,
      fadeOutSeconds:
        safeFadeOut
    });

    onProgress?.(
      93,
      "processing"
    );
  } else {
    /*
     * PARTは既存方式を維持。
     */
    channels =
      await renderSingleContext({
        sources,
        endMode,
        safeHead,
        safeFadeIn,
        safeFadeOut,
        safeBpm,
        masterVolume,
        guardSeconds,
        tailSafety,
        bodyDuration,
        signal,
        onProgress
      });
  }

  assertNotCancelled(
    signal
  );

  const blob =
    encodeWav24(
      channels,
      EXPORT_SAMPLE_RATE
    );

  onProgress?.(
    100,
    "done"
  );

  return {
    blob,
    sampleRate:
      EXPORT_SAMPLE_RATE,
    bitDepth: 24,
    channels:
      EXPORT_CHANNELS,
    duration:
      channels[0].length /
      EXPORT_SAMPLE_RATE,
    bodyDuration,
    headSeconds:
      safeHead
  };
}
