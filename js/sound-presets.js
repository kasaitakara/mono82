/*
 * mono82 factory Sound presets.
 *
 * category is an internal compatibility boundary only.
 * It is not exposed as a user-selectable category UI:
 * melodic Sounds see melodic presets, rhythm Sounds see rhythm presets.
 */

export const FACTORY_SOUND_PRESETS = [
  {
    id: "factory-melodic-init",
    category: "melodic",
    name: "initialize tone",
    sound: {
      gain: 100,
      attack: 1,
      holdDecay: 0,
      filterCutoff: 0,
      filterResonance: 0,
      fmDepth: 0,
      fmRatio: 1,
      lfo1: {
        target: "pitch",
        wave: "sine",
        depth: 0,
        rate: 25,
        syncMode: "free"
      },
      lfo2: {
        target: "pitch",
        wave: "sine",
        depth: 0,
        rate: 25,
        syncMode: "free"
      }
    }
  },
  {
    id: "factory-rhythm-init",
    category: "rhythm",
    name: "initialize rhythm",
    sound: {
      gain: 100,
      noiseMix: 0,
      note: 0,
      attack: 1,
      holdDecay: 0,
      filterCutoff: 0,
      filterResonance: 0,
      lfo1: {
        target: "pitch",
        wave: "sine",
        depth: 0,
        rate: 25,
        syncMode: "free"
      },
      lfo2: {
        target: "pitch",
        wave: "sine",
        depth: 0,
        rate: 25,
        syncMode: "free"
      }
    }
  }
];
