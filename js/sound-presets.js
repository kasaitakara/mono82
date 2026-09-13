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
    name: "soft sine",
    sound: {
      gain: 100,
      attack: 24,
      holdDecay: 16,
      filterCutoff: 13,
      filterResonance: 20,
      fmDepth: 0,
      fmRatio: 1,
      lfo1: {
        target: "pitch",
        wave: "sine",
        depth: 1,
        rate: 100,
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
  },{
    id: "factory-melodic-init",
    category: "melodic",
    name: "keyboard",
    sound: {
      gain: 70,
      attack: 1,
      holdDecay: 30,
      filterCutoff: -15,
      filterResonance: 0,
      fmDepth: 5,
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
    id: "factory-melodic-init",
    category: "melodic",
    name: "pad",
    sound: {
      gain: 40,
      attack: 30,
      holdDecay: 25,
      filterCutoff: 19,
      filterResonance: 0,
      fmDepth: 0,
      fmRatio: 1,
      lfo1: {
        target: "level",
        wave: "sine",
        depth: 100,
        rate: 8,
        syncMode: "bpm"
      },
      lfo2: {
        target: "pan",
        wave: "sine",
        depth: 100,
        rate: 8,
        syncMode: "bpm"
      }
    }
  },
  {
    id: "factory-melodic-init",
    category: "melodic",
    name: "initialize tone",
    sound: {
      gain: 70,
      attack: 1,
      holdDecay: 15,
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
    name: "kick",
    sound: {
      gain: 70,
      noiseMix: 0,
      note: -35,
      attack: 1,
      holdDecay: 12,
      filterCutoff: 0,
      filterResonance: 0,
      lfo1: {
        target: "pitch",
        wave: "fall",
        depth: 94,
        rate: 120,
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
    name: "hat",
    sound: {
      gain: 14,
      noiseMix: 100,
      note: 0,
      attack: 1,
      holdDecay: 8,
      filterCutoff: 50,
      filterResonance: 25,
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
    name: "snare",
    sound: {
      gain: 130,
      noiseMix: 19,
      note: 0,
      attack: 1,
      holdDecay: 7,
      filterCutoff: 30,
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
  },
 {
    id: "factory-rhythm-init",
    category: "rhythm",
    name: "initialize rhythm",
    sound: {
      gain: 70,
      noiseMix: 0,
      note: 12,
      attack: 1,
      holdDecay: 11,
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
