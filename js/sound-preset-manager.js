import { FACTORY_SOUND_PRESETS } from "./sound-presets.js";
import {
  normalizeMelodicSound,
  normalizeRhythmSound
} from "./sound-defaults.js";

const USER_PRESET_STORAGE_KEYS =
  Object.freeze({
    melodic:
      "mono82-user-sound-presets-melodic-v1",
    rhythm:
      "mono82-user-sound-presets-rhythm-v1"
  });

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

  /*
   * mono82 keeps melodic / rhythm user presets in separate storage.
   * This makes cross-layer display impossible by construction.
   */
  const categories =
    requested
      ? [requested]
      : PRESET_CATEGORIES;

  const result = [];

  for (const currentCategory of categories) {
    try {
      const value =
        JSON.parse(
          localStorage.getItem(
            USER_PRESET_STORAGE_KEYS[
              currentCategory
            ]
          ) || "[]"
        );

      if (!Array.isArray(value)) {
        continue;
      }

      value
        .filter(
          item =>
            item &&
            typeof item.id === "string"
        )
        .map(item =>
          clonePreset({
            ...item,
            category:
              currentCategory
          })
        )
        .filter(Boolean)
        .forEach(preset =>
          result.push(preset)
        );
    } catch {
      // Ignore only the broken category store.
    }
  }

  return result;
}

function writeUserPresets(
  category,
  presets
) {
  const normalizedCategory =
    normalizeCategory(category);

  if (!normalizedCategory) {
    return;
  }

  const categoryPresets =
    presets
      .filter(
        preset =>
          preset?.category ===
          normalizedCategory
      )
      .map(preset => ({
        ...preset,
        category:
          normalizedCategory
      }));

  localStorage.setItem(
    USER_PRESET_STORAGE_KEYS[
      normalizedCategory
    ],
    JSON.stringify(
      categoryPresets
    )
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

    writeUserPresets(
      normalizedCategory,
      presets
    );
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
  writeUserPresets(
    normalizedCategory,
    presets
  );
  return clonePreset(preset);
}


export function renameUserPreset({
  id,
  name
}) {
  const normalizedName =
    String(name || "")
      .trim()
      .toLowerCase();

  if (
    !id ||
    !normalizedName
  ) {
    return null;
  }

  const presets =
    getUserPresets();

  const index =
    presets.findIndex(
      preset =>
        preset.id === id
    );

  if (index < 0) {
    return null;
  }

  presets[index] = {
    ...presets[index],
    name: normalizedName
  };

  writeUserPresets(
    presets[index].category,
    presets
  );
  return clonePreset(
    presets[index]
  );
}

export function deleteUserPreset(id) {
  if (!id) {
    return false;
  }

  const presets =
    getUserPresets();

  const target =
    presets.find(
      preset =>
        preset.id === id
    );

  if (!target) {
    return false;
  }

  const categoryPresets =
    presets.filter(
      preset =>
        preset.category ===
          target.category &&
        preset.id !== id
    );

  writeUserPresets(
    target.category,
    categoryPresets
  );

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
