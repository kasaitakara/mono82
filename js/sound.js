import { FACTORY_SOUND_PRESETS } from "./sound-presets.js";
import { normalizeSound } from "./sound-defaults.js";

const USER_PRESET_STORAGE_KEY = "sprooto-user-sound-presets-v1";

function clonePreset(preset) {
  return {
    ...preset,
    sound: normalizeSound(preset.sound)
  };
}

export function getFactoryPresets() {
  return FACTORY_SOUND_PRESETS.map(clonePreset);
}

export function getUserPresets() {
  try {
    const value =
      JSON.parse(
        localStorage.getItem(
          USER_PRESET_STORAGE_KEY
        ) || "[]"
      );

    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter(
        item =>
          item &&
          typeof item.id ===
            "string"
      )
      .map(item => ({
        id: item.id,
        name:
          String(
            item.name ||
            "User Sound"
          ),
        sound:
          normalizeSound(
            item.sound
          )
      }));
  } catch {
    return [];
  }
}

function writeUserPresets(presets) {
  localStorage.setItem(USER_PRESET_STORAGE_KEY, JSON.stringify(presets));
}

export function saveUserPreset({ id = null, name, sound }) {
  const presets = getUserPresets();
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;

  if (id) {
    const index = presets.findIndex(preset => preset.id === id);
    if (index < 0) return null;
    presets[index] = {
      ...presets[index],
      name: normalizedName,
      sound: normalizeSound(sound)
    };
    writeUserPresets(presets);
    return clonePreset(presets[index]);
  }

  const preset = {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: normalizedName,
    sound: normalizeSound(sound)
  };

  presets.push(preset);
  writeUserPresets(presets);
  return clonePreset(preset);
}

export function deleteUserPreset(id) {
  const presets = getUserPresets();
  const next = presets.filter(preset => preset.id !== id);
  if (next.length === presets.length) return false;
  writeUserPresets(next);
  return true;
}

export function captureTrackSound(track) {
  return normalizeSound({
    base: track.base,
    offsets: track.offsets,
    envelopeSelectedId: track.envelopeSelectedId,
    articulationSelectedId: track.articulationSelectedId,
    lfoSelected: track.lfoSelected
  });
}

export function applyTrackSound(track, sound, soundName) {
  const normalized = normalizeSound(sound);
  track.base = structuredClone(normalized.base);
  track.envelopeSelectedId = normalized.envelopeSelectedId;
  track.articulationSelectedId = normalized.articulationSelectedId;
  track.lfoSelected = normalized.lfoSelected;
  track.soundName = String(soundName || "sound");
}

export function soundsEqual(a, b) {
  return JSON.stringify(normalizeSound(a)) === JSON.stringify(normalizeSound(b));
}
