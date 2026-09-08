import { FACTORY_SOUND_PRESETS } from "./sound-presets.js";
import {
  normalizeMelodicSound,
  normalizeRhythmSound
} from "./sound-defaults.js";

const USER_PRESET_STORAGE_KEY =
  "mono82-user-sound-presets-v1";

const PRESET_CATEGORIES = Object.freeze([
  "melodic",
  "rhythm"
]);

function normalizeCategory(category) {
  return PRESET_CATEGORIES.includes(category)
    ? category
    : null;
}

function normalizePresetSound(
  category,
  sound
) {
  const normalized =
    category === "rhythm"
      ? normalizeRhythmSound(
          sound,
          "a"
        )
      : normalizeMelodicSound(
          sound,
          "1"
        );

  /*
   * Presets describe timbre only.
   * Slot id / display name / mute / solo belong to the destination Sound.
   */
  const {
    id,
    name,
    muted,
    solo,
    ...presetSound
  } = normalized;

  return structuredClone(
    presetSound
  );
}

function clonePreset(preset) {
  const category =
    normalizeCategory(
      preset?.category
    );

  if (!category) {
    return null;
  }

  return {
    id: String(preset.id),
    category,
    name:
      String(
        preset.name ||
          "user sound"
      ),
    sound:
      normalizePresetSound(
        category,
        preset.sound
      )
  };
}

export function getFactoryPresets(
  category = null
) {
  const requested =
    normalizeCategory(category);

  return FACTORY_SOUND_PRESETS
    .map(clonePreset)
    .filter(Boolean)
    .filter(
      preset =>
        !requested ||
        preset.category === requested
    );
}

export function getUserPresets(
  category = null
) {
  const requested =
    normalizeCategory(category);

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
      .map(clonePreset)
      .filter(Boolean)
      .filter(
        preset =>
          !requested ||
          preset.category ===
            requested
      );
  } catch {
    return [];
  }
}

function writeUserPresets(
  presets
) {
  localStorage.setItem(
    USER_PRESET_STORAGE_KEY,
    JSON.stringify(presets)
  );
}

export function saveUserPreset({
  id = null,
  category,
  name,
  sound
}) {
  const normalizedCategory =
    normalizeCategory(category);

  const normalizedName =
    String(name || "")
      .trim()
      .toLowerCase();

  if (
    !normalizedCategory ||
    !normalizedName
  ) {
    return null;
  }

  /*
   * Read all categories so overwrite never discards presets from the
   * opposite mono82 layer.
   */
  const presets =
    getUserPresets();

  if (id) {
    const index =
      presets.findIndex(
        preset =>
          preset.id === id
      );

    if (index < 0) {
      return null;
    }

    /*
     * A preset cannot change layer through overwrite.
     * This protects melodic/rhythm compatibility permanently.
     */
    if (
      presets[index].category !==
      normalizedCategory
    ) {
      return null;
    }

    presets[index] = {
      ...presets[index],
      name: normalizedName,
      sound:
        normalizePresetSound(
          normalizedCategory,
          sound
        )
    };

    writeUserPresets(presets);
    return clonePreset(
      presets[index]
    );
  }

  const preset = {
    id:
      `user-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    category:
      normalizedCategory,
    name:
      normalizedName,
    sound:
      normalizePresetSound(
        normalizedCategory,
        sound
      )
  };

  presets.push(preset);
  writeUserPresets(presets);
  return clonePreset(preset);
}

export function deleteUserPreset(id) {
  const presets =
    getUserPresets();

  const next =
    presets.filter(
      preset =>
        preset.id !== id
    );

  if (
    next.length ===
    presets.length
  ) {
    return false;
  }

  writeUserPresets(next);
  return true;
}

export function captureSoundPreset(
  sound,
  category
) {
  const normalizedCategory =
    normalizeCategory(category);

  if (!normalizedCategory) {
    return null;
  }

  return normalizePresetSound(
    normalizedCategory,
    sound
  );
}

export function applySoundPreset(
  targetSound,
  category,
  presetSound,
  soundName = null
) {
  const normalizedCategory =
    normalizeCategory(category);

  if (
    !targetSound ||
    !normalizedCategory
  ) {
    return false;
  }

  const id =
    String(
      targetSound.id ??
      (
        normalizedCategory ===
          "rhythm"
          ? "a"
          : "1"
      )
    );

  const muted =
    Boolean(targetSound.muted);
  const solo =
    Boolean(targetSound.solo);

  const normalized =
    normalizedCategory === "rhythm"
      ? normalizeRhythmSound(
          presetSound,
          id
        )
      : normalizeMelodicSound(
          presetSound,
          id
        );

  normalized.id = id;
  normalized.name =
    String(
      soundName ||
      targetSound.name ||
      `sound ${id}`
    );
  normalized.muted = muted;
  normalized.solo = solo;

  Object.keys(targetSound)
    .forEach(key => {
      delete targetSound[key];
    });

  Object.assign(
    targetSound,
    structuredClone(
      normalized
    )
  );

  return true;
}

export function soundsEqual(
  a,
  b,
  category
) {
  const normalizedCategory =
    normalizeCategory(category);

  if (!normalizedCategory) {
    return false;
  }

  return (
    JSON.stringify(
      normalizePresetSound(
        normalizedCategory,
        a
      )
    ) ===
    JSON.stringify(
      normalizePresetSound(
        normalizedCategory,
        b
      )
    )
  );
}
