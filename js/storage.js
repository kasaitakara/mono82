import {
  createProjectSnapshot,
  createNewProjectSnapshot,
  restoreProjectSnapshot,
  restoreSnapshot,
  clearHistory
} from "./sequencer.js";

/*
 * 旧localStorage autosave。
 * IndexedDB移行後も当面は削除せず、安全用バックアップとして残す。
 */
const LEGACY_STORAGE_KEY =
  "sprooto-autosave-v1";

/*
 * Project本体はIndexedDBへ保存する。
 * localStorageには小さい管理情報だけを置く。
 */
const DB_NAME =
  "sprooto-projects-v1";

const DB_VERSION = 2;
const PROJECT_STORE =
  "projects";
const RECOVERY_STORE = "recoveries";

const CURRENT_PROJECT_ID_KEY =
  "sprooto-current-project-id-v1";

/*
 * 旧autosaveを一度Project化したことを示す。
 * 旧autosave自体は残すが、二重Importはしない。
 */
const PROJECT_MIGRATION_KEY =
  "sprooto-project-migration-idb-v1";

const PROJECT_SCHEMA_VERSION = 1;
const AUTOSAVE_DELAY = 250;
const EMERGENCY_RECOVERY_KEY = "mono82-emergency-recovery-v1";

/*
 * Stage 36:
 * Existing IndexedDB recovery/autosave is reused as the temporary save.
 * No new project-management UI is added here.
 */


let autosaveTimer = null;
let databasePromise = null;
let dirty = false;
let recoveryDirty = false;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener(
      "success",
      () => resolve(request.result),
      { once: true }
    );

    request.addEventListener(
      "error",
      () => reject(request.error),
      { once: true }
    );
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener(
      "complete",
      () => resolve(true),
      { once: true }
    );

    transaction.addEventListener(
      "abort",
      () => reject(transaction.error),
      { once: true }
    );

    transaction.addEventListener(
      "error",
      () => reject(transaction.error),
      { once: true }
    );
  });
}

function openProjectDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise =
    new Promise((resolve, reject) => {
      const request =
        indexedDB.open(
          DB_NAME,
          DB_VERSION
        );

      request.addEventListener(
        "upgradeneeded",
        () => {
          const database =
            request.result;

          if (
            !database.objectStoreNames.contains(
              PROJECT_STORE
            )
          ) {
            const store =
              database.createObjectStore(
                PROJECT_STORE,
                {
                  keyPath: "id"
                }
              );

            store.createIndex(
              "createdAt",
              "createdAt",
              { unique: false }
            );

            store.createIndex(
              "updatedAt",
              "updatedAt",
              { unique: false }
            );
          }


          if (!database.objectStoreNames.contains(RECOVERY_STORE)) {
            database.createObjectStore(RECOVERY_STORE, { keyPath: "id" });
          }        }
      );

      request.addEventListener(
        "success",
        () => resolve(request.result),
        { once: true }
      );

      request.addEventListener(
        "error",
        () => reject(request.error),
        { once: true }
      );

      request.addEventListener(
        "blocked",
        () => {
          console.warn(
            "sprooto IndexedDB open blocked"
          );
        }
      );
    });

  return databasePromise;
}

async function readRecoveryRecord(id) {
  if (!id) return null;
  const db = await openProjectDatabase();
  const tx = db.transaction(RECOVERY_STORE, "readonly");
  return (await requestToPromise(tx.objectStore(RECOVERY_STORE).get(id))) ?? null;
}
async function writeRecoveryRecord(record) {
  const db = await openProjectDatabase();
  const tx = db.transaction(RECOVERY_STORE, "readwrite");
  tx.objectStore(RECOVERY_STORE).put(record);
  await transactionToPromise(tx);
}
async function removeRecoveryRecord(id) {
  if (!id) return;
  const db = await openProjectDatabase();
  const tx = db.transaction(RECOVERY_STORE, "readwrite");
  tx.objectStore(RECOVERY_STORE).delete(id);
  await transactionToPromise(tx);
}

async function readProjectRecord(
  projectId
) {
  if (!projectId) {
    return null;
  }

  const database =
    await openProjectDatabase();

  const transaction =
    database.transaction(
      PROJECT_STORE,
      "readonly"
    );

  const request =
    transaction
      .objectStore(PROJECT_STORE)
      .get(projectId);

  const result =
    await requestToPromise(request);

  return result ?? null;
}

async function writeProjectRecord(
  record
) {
  const database =
    await openProjectDatabase();

  const transaction =
    database.transaction(
      PROJECT_STORE,
      "readwrite"
    );

  transaction
    .objectStore(PROJECT_STORE)
    .put(record);

  await transactionToPromise(
    transaction
  );

  return record;
}

async function removeProjectRecord(
  projectId
) {
  const database =
    await openProjectDatabase();

  const transaction =
    database.transaction(
      PROJECT_STORE,
      "readwrite"
    );

  transaction
    .objectStore(PROJECT_STORE)
    .delete(projectId);

  await transactionToPromise(
    transaction
  );
}

async function readAllProjectRecords() {
  const database =
    await openProjectDatabase();

  const transaction =
    database.transaction(
      PROJECT_STORE,
      "readonly"
    );

  const request =
    transaction
      .objectStore(PROJECT_STORE)
      .getAll();

  const result =
    await requestToPromise(request);

  return Array.isArray(result)
    ? result
    : [];
}

function makeProjectId() {
  if (
    globalThis.crypto?.randomUUID
  ) {
    return `pj_${crypto.randomUUID()}`;
  }

  return (
    "pj_" +
    Date.now().toString(36) +
    "_" +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );
}

function localDateCode(
  date = new Date()
) {
  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      date.getDate()
    ).padStart(2, "0");

  return `${year}${month}${day}`;
}

async function makeAutomaticProjectName() {
  const records =
    await readAllProjectRecords();

  const todayCode =
    localDateCode();

  const usedNumbers =
    records
      .map(record => {
        const match =
          String(record?.name ?? "")
            .match(
              new RegExp(
                `^${todayCode}-(\\d+)$`
              )
            );

        return match
          ? Number(match[1])
          : null;
      })
      .filter(Number.isFinite);

  let nextNumber = 1;

  while (
    usedNumbers.includes(
      nextNumber
    )
  ) {
    nextNumber += 1;
  }

  return `${todayCode}-${nextNumber}`;
}

function currentProjectSettings() {
  const bpmInput =
    document.getElementById(
      "bpm-input"
    );

  const masterVolumeInput =
    document.getElementById(
      "master-volume"
    );

  return {
    bpm:
      Number(
        bpmInput?.value
      ) || 120,

    masterVolume:
      Number.isFinite(
        Number(
          masterVolumeInput?.value
        )
      )
        ? Number(
            masterVolumeInput.value
          )
        : 70
  };
}

function restoreProjectSettings(
  settings
) {
  if (!settings) {
    return;
  }

  const bpmInput =
    document.getElementById(
      "bpm-input"
    );

  const masterVolumeInput =
    document.getElementById(
      "master-volume"
    );

  const masterVolumeValue =
    document.getElementById(
      "master-volume-value"
    );

  if (bpmInput) {
    const bpm =
      Math.min(
        300,
        Math.max(
          40,
          Math.round(
            Number(
              settings.bpm
            ) || 120
          )
        )
      );

    bpmInput.value =
      String(bpm);
  }

  if (masterVolumeInput) {
    const masterVolume =
      Math.min(
        100,
        Math.max(
          0,
          Math.round(
            Number.isFinite(
              Number(
                settings.masterVolume
              )
            )
              ? Number(
                  settings.masterVolume
                )
              : 70
          )
        )
      );

    masterVolumeInput.value =
      String(masterVolume);

    if (masterVolumeValue) {
      masterVolumeValue.value =
        String(masterVolume);

      masterVolumeValue.textContent =
        String(masterVolume);
    }
  }
}

function projectDataIsValid(
  data
) {
  /*
   * mokton temporary-save compatibility:
   *
   * The old sprooto validator required fills / sections.
   * Those collections no longer exist in the mokton project model,
   * so valid autosaves were being rejected on the next launch.
   *
   * Current minimum project shape:
   * - project-fixed soundBank
   * - patterns[]
   * - song
   */
  return Boolean(
    data &&
    data.soundBank &&
    typeof data.soundBank === "object" &&
    Array.isArray(data.patterns) &&
    data.song &&
    typeof data.song === "object"
  );
}

function legacySnapshotIsValid(
  snapshot
) {
  return Boolean(
    snapshot &&
    Array.isArray(snapshot.patterns) &&
    Array.isArray(snapshot.fills) &&
    Array.isArray(snapshot.sections) &&
    snapshot.state
  );
}

function dispatchProjectChange(
  type,
  record
) {
  window.dispatchEvent(
    new CustomEvent(
      "projectchange",
      {
        detail: {
          type,
          project:
            record
              ? {
                  id:
                    record.id,
                  name:
                    record.name,
                  createdAt:
                    record.createdAt,
                  updatedAt:
                    record.updatedAt
                }
              : null
        }
      }
    )
  );
}

async function createProjectRecord({
  name = null,
  data,
  settings,
  createdAt = null
}) {
  const now =
    new Date().toISOString();

  const id =
    makeProjectId();

  const record = {
    schemaVersion:
      PROJECT_SCHEMA_VERSION,

    id,

    name:
      (
        typeof name === "string" &&
        name.trim()
      )
        ? name.trim()
        : await makeAutomaticProjectName(),

    createdAt:
      createdAt ?? now,

    updatedAt:
      now,

    settings:
      settings ?? {
        bpm: 120,
        masterVolume: 70
      },

    data
  };

  await writeProjectRecord(
    record
  );

  return record;
}

function setCurrentProjectId(
  projectId
) {
  if (!projectId) {
    localStorage.removeItem(
      CURRENT_PROJECT_ID_KEY
    );

    return;
  }

  localStorage.setItem(
    CURRENT_PROJECT_ID_KEY,
    projectId
  );
}

export function getCurrentProjectId() {
  return (
    localStorage.getItem(
      CURRENT_PROJECT_ID_KEY
    ) || null
  );
}

export async function getProjectList() {
  const records =
    await readAllProjectRecords();

  return records
    .map(record => ({
      id:
        record.id,
      name:
        record.name,
      createdAt:
        record.createdAt,
      updatedAt:
        record.updatedAt
    }))
    .sort(
      (a, b) =>
        new Date(b.updatedAt) -
        new Date(a.updatedAt)
    );
}

export async function getCurrentProjectMeta() {
  const record =
    await readProjectRecord(
      getCurrentProjectId()
    );

  if (!record) {
    return null;
  }

  return {
    id:
      record.id,
    name:
      record.name,
    createdAt:
      record.createdAt,
    updatedAt:
      record.updatedAt
  };
}

async function saveRecoveryNow() {
  const id =
    getCurrentProjectId();

  if (!id || !recoveryDirty) {
    return false;
  }

  await writeRecoveryRecord({
    id,
    updatedAt:
      new Date().toISOString(),
    settings:
      currentProjectSettings(),
    data:
      createProjectSnapshot()
  });

  recoveryDirty = false;

  return true;
}

function writeEmergencyRecovery() {
  const id = getCurrentProjectId();
  if (!id || !recoveryDirty) return false;

  try {
    localStorage.setItem(
      EMERGENCY_RECOVERY_KEY,
      JSON.stringify({
        id,
        updatedAt: new Date().toISOString(),
        settings: currentProjectSettings(),
        data: createProjectSnapshot()
      })
    );
    return true;
  } catch (error) {
    console.warn("mono82 emergency recovery unavailable:", error);
    return false;
  }
}

function readEmergencyRecovery(id) {
  try {
    const raw = localStorage.getItem(EMERGENCY_RECOVERY_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record || record.id !== id || !projectDataIsValid(record.data)) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function recordTime(record) {
  const time = Date.parse(record?.updatedAt ?? "");
  return Number.isFinite(time) ? time : 0;
}

export function hasUnsavedChanges() { return dirty; }
export async function saveCurrentProject() {
  try {
    const id = getCurrentProjectId();
    const old = await readProjectRecord(id);
    if (!old) return false;
    const record = { ...old, updatedAt: new Date().toISOString(), settings: currentProjectSettings(), data: createProjectSnapshot() };
    await writeProjectRecord(record);
await writeRecoveryRecord({
  id,
  updatedAt: record.updatedAt,
  settings: record.settings,
  data: record.data
});

clearTimeout(
  autosaveTimer
);

autosaveTimer = null;
recoveryDirty = false;
dirty = false;
    dispatchProjectChange("save", record);
    return true;
  } catch (e) { console.error("sprooto save failed:", e); return false; }
}
export async function saveAutosave() { try { return await saveRecoveryNow(); } catch(e) { console.error("sprooto recovery autosave failed:",e); return false; } }
export function scheduleAutosave() {
  dirty = true;
  recoveryDirty = true;

  clearTimeout(
    autosaveTimer
  );

  autosaveTimer =
    setTimeout(
      () => void saveAutosave(),
      AUTOSAVE_DELAY
    );
}

function restoreProjectRecord(
  record
) {
  if (
    !record ||
    !projectDataIsValid(
      record.data
    )
  ) {
    return false;
  }

  const restored =
    restoreProjectSnapshot(
      record.data
    );

  if (!restored) {
    return false;
  }

  restoreProjectSettings(
    record.settings
  );

  return true;
}

/*
 * 旧autosaveを一度だけIndexedDB Projectへ移す。
 * 旧キーは削除しない。
 */
async function importLegacyAutosave() {
  const migrationId =
    localStorage.getItem(
      PROJECT_MIGRATION_KEY
    );

  if (migrationId) {
    return null;
  }

  const legacyText =
    localStorage.getItem(
      LEGACY_STORAGE_KEY
    );

  if (!legacyText) {
    return null;
  }

  try {
    const legacySnapshot =
      JSON.parse(
        legacyText
      );

    if (
      !legacySnapshotIsValid(
        legacySnapshot
      )
    ) {
      return null;
    }

    /*
     * 従来と同じrestoreSnapshot()をまず通す。
     * これで既存曲のmigration / normalizeも従来どおり適用される。
     */
    restoreSnapshot(
      legacySnapshot
    );

    restoreProjectSettings(
      legacySnapshot.appSettings
    );

    const record =
      await createProjectRecord({
        data:
          createProjectSnapshot(),

        settings:
          legacySnapshot.appSettings ?? {
            bpm: 120,
            masterVolume: 70
          }
      });

    setCurrentProjectId(
      record.id
    );

    localStorage.setItem(
      PROJECT_MIGRATION_KEY,
      record.id
    );

    return record;
  } catch (error) {
    console.error(
      "sprooto legacy autosave migration failed:",
      error
    );

    return null;
  }
}

async function createInitialProject() {
  const record =
    await createProjectRecord({
      data:
        createNewProjectSnapshot(),

      settings: {
        bpm: 120,
        masterVolume: 70
      }
    });

  setCurrentProjectId(
    record.id
  );

  return record;
}

export async function restoreAutosave() {
  try {
    await openProjectDatabase();

    const currentId =
      getCurrentProjectId();

    if (currentId) {
      const currentRecord = await readProjectRecord(currentId);
      const recovery = await readRecoveryRecord(currentId);
      const emergency = readEmergencyRecovery(currentId);

      const candidates = [
        currentRecord && projectDataIsValid(currentRecord.data)
          ? { kind: "project", record: currentRecord }
          : null,
        recovery && projectDataIsValid(recovery.data)
          ? { kind: "recovery", record: recovery }
          : null,
        emergency && projectDataIsValid(emergency.data)
          ? { kind: "emergency", record: emergency }
          : null
      ]
        .filter(Boolean)
        .sort((a, b) => recordTime(b.record) - recordTime(a.record));

      const newest = candidates[0];

      if (newest) {
        const restored = restoreProjectSnapshot(newest.record.data);
        if (restored) {
          restoreProjectSettings(newest.record.settings);

          /*
           * Rewrite the restored snapshot immediately. This permanently
           * migrates legacy numeric chord indexes to stable chord names.
           */
          const normalizedData = createProjectSnapshot();
          const normalizedRecovery = {
            id: currentId,
            updatedAt: newest.record.updatedAt ?? new Date().toISOString(),
            settings: newest.record.settings ?? currentProjectSettings(),
            data: normalizedData
          };
          await writeRecoveryRecord(normalizedRecovery);
          localStorage.removeItem(EMERGENCY_RECOVERY_KEY);

          dirty = newest.kind !== "project";
          recoveryDirty = false;
          return true;
        }
      }
    }

    const migrationId =
      localStorage.getItem(
        PROJECT_MIGRATION_KEY
      );

    if (migrationId) {
      const migratedRecord =
        await readProjectRecord(
          migrationId
        );

      if (
        migratedRecord &&
        restoreProjectRecord(
          migratedRecord
        )
      ) {
        setCurrentProjectId(
          migratedRecord.id
        );

        return true;
      }
    }

    const imported =
      await importLegacyAutosave();

    if (imported) {
      /*
       * importLegacyAutosave()内で旧snapshotをすでに復元済み。
       * ここでrestoreProjectSnapshot()を重ねず、その表示状態を維持する。
       */
      return true;
    }

    const records =
      await readAllProjectRecords();

    const latest =
      records
        .sort(
          (a, b) =>
            new Date(b.updatedAt) -
            new Date(a.updatedAt)
        )[0];

    if (
      latest &&
      restoreProjectRecord(
        latest
      )
    ) {
      setCurrentProjectId(
        latest.id
      );

      return true;
    }

    const created =
      await createInitialProject();

    return restoreProjectRecord(
      created
    );
  } catch (error) {
    console.error(
      "sprooto restore failed:",
      error
    );

    return false;
  }
}

export async function createNewProject() {
  try {
    const previousId = getCurrentProjectId();
    if (previousId) await removeRecoveryRecord(previousId);

    const record =
      await createProjectRecord({
        data:
          createNewProjectSnapshot(),

        settings: {
          bpm: 120,
          masterVolume: 70
        }
      });

    if (
      !restoreProjectRecord(
        record
      )
    ) {
      return null;
    }

    setCurrentProjectId(
      record.id
    );

    await writeRecoveryRecord({
  id: record.id,
  updatedAt: record.updatedAt,
  settings: record.settings,
  data: record.data
});

clearTimeout(
  autosaveTimer
);

autosaveTimer = null;
recoveryDirty = false;
dirty = false;

    dispatchProjectChange(
      "new",
      record
    );

    return record.id;
  } catch (error) {
    console.error(
      "sprooto new project failed:",
      error
    );

    return null;
  }
}

export async function openProject(projectId) {
  try {
    const target = await readProjectRecord(projectId);
    if (!target) return false;
    const previousId = getCurrentProjectId();
    if (previousId) await removeRecoveryRecord(previousId);
    if (!restoreProjectRecord(target)) return false;
    setCurrentProjectId(projectId);
    await writeRecoveryRecord({
  id: target.id,
  updatedAt: target.updatedAt,
  settings: target.settings,
  data: target.data
});

clearTimeout(
  autosaveTimer
);

autosaveTimer = null;
recoveryDirty = false;
dirty = false;

clearHistory();
dispatchProjectChange("open", target); return true;
  } catch(e) { console.error("sprooto open project failed:",e); return false; }
}

export async function saveAsProject(
  name = null
) {
  try {
    const previousId = getCurrentProjectId();

    const record =
  await createProjectRecord({
    name,

    data:
      createProjectSnapshot(),

    settings:
      currentProjectSettings()
  });

if (previousId) await removeRecoveryRecord(previousId);

setCurrentProjectId(record.id);

await writeRecoveryRecord({
  id: record.id,
  updatedAt: record.updatedAt,
  settings: record.settings,
  data: record.data
});

clearTimeout(
  autosaveTimer
);

autosaveTimer = null;
recoveryDirty = false;
dirty = false;

    clearHistory();

    dispatchProjectChange(
      "saveas",
      record
    );

    return record.id;
  } catch (error) {
    console.error(
      "sprooto save as failed:",
      error
    );

    return null;
  }
}

export async function renameProject(
  projectId,
  newName
) {
  try {
    const name =
      String(
        newName ?? ""
      ).trim();

    if (!name) {
      return false;
    }

    const record =
      await readProjectRecord(
        projectId
      );

    if (!record) {
      return false;
    }

    record.name =
      name;

    record.updatedAt =
      new Date().toISOString();

    await writeProjectRecord(
      record
    );

    dispatchProjectChange(
      "rename",
      record
    );

    return true;
  } catch (error) {
    console.error(
      "sprooto rename project failed:",
      error
    );

    return false;
  }
}

export async function deleteProject(
  projectId
) {
  try {
    const record =
      await readProjectRecord(
        projectId
      );

    if (!record) {
      return false;
    }

    const wasCurrent =
      getCurrentProjectId() ===
      projectId;

    await removeProjectRecord(projectId);
    await removeRecoveryRecord(projectId);

    if (!wasCurrent) {
      dispatchProjectChange(
        "delete",
        null
      );

      return true;
    }

    setCurrentProjectId(
      null
    );

    const records =
      await readAllProjectRecords();

    const nextRecord =
      records
        .sort(
          (a, b) =>
            new Date(b.updatedAt) -
            new Date(a.updatedAt)
        )[0];

    if (
      nextRecord &&
      restoreProjectRecord(
        nextRecord
      )
    ) {
      setCurrentProjectId(
        nextRecord.id
      );

      clearTimeout(
  autosaveTimer
);

autosaveTimer = null;
recoveryDirty = false;
dirty = false;

      dispatchProjectChange(
        "delete",
        nextRecord
      );

      return true;
    }

    const created =
  await createInitialProject();

restoreProjectRecord(
  created
);

clearTimeout(
  autosaveTimer
);

autosaveTimer = null;
recoveryDirty = false;
dirty = false;

dispatchProjectChange(
  "delete",
  created
);

return true;
  } catch (error) {
    console.error(
      "sprooto delete project failed:",
      error
    );

    return false;
  }
}

export function initializeAutosave() {
  [
  "change",
  "input"
].forEach(
  eventName => {
    document.addEventListener(
      eventName,
      event => {
        if (
          event.target?.id !==
            "bpm-input" &&
          event.target?.id !==
            "master-volume"
        ) {
          return;
        }

        scheduleAutosave();
      }
    );
  }
);

  document.addEventListener(
    "visibilitychange",
    () => {
      if (
        document.visibilityState ===
        "hidden"
      ) {
        clearTimeout(
          autosaveTimer
        );

        /* Synchronous last-chance snapshot for iOS app termination. */
        writeEmergencyRecovery();
        void saveAutosave();
      }
    }
  );

  window.addEventListener(
    "pagehide",
    () => {
      clearTimeout(autosaveTimer);
      writeEmergencyRecovery();
      void saveAutosave();
    }
  );
}
