import {
  state,
  tracks
} from "./sequencer.js";

import {
  render
} from "./ui.js";

const NAVIGATION_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex="0"]'
].join(", ");

const ARROW_DIRECTIONS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down"
};

let lastFocusedElement = null;

function visibleElements(selector = NAVIGATION_SELECTOR, root = document) {
  return Array.from(
    root.querySelectorAll(selector)
  ).filter(element => {
    const rect =
      element.getBoundingClientRect();

    const style =
      window.getComputedStyle(element);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  });
}

function elementCenter(element) {
  const rect = element.getBoundingClientRect();

  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function areaOf(element) {
  if (!element) return null;

  if (element.closest(".app-header")) {
    return "header";
  }

  if (element.closest(".sequence-toolbar")) {
    return "sequence-toolbar";
  }

  if (element.closest(".sequence-grid")) {
    return "sequence-grid";
  }

  if (
    element.closest(
      ".editor-header, .edit-toolbar"
    )
  ) {
    return "editor-header";
  }

  if (
  element.closest(
    ".parameter-menu, .offset-grid, .lfo-settings"
  )
) {
  return "editor-content";
}

  if (element.closest(".pattern-section")) {
    return "pattern-manager";
  }

  return null;
}

function areaRoot(area) {
  const selectors = {
    header: ".app-header",

    "sequence-toolbar":
      ".sequence-toolbar",

    "sequence-grid":
      ".sequence-grid",

    "editor-header":
      ".editor-header, .edit-toolbar",

    "editor-content":
  ".parameter-menu, .offset-grid, .lfo-settings",

    "pattern-manager":
      ".pattern-section"
  };

  const selector = selectors[area];

  return selector
    ? document.querySelector(selector)
    : null;
}

function targetsInArea(area) {
  const root = areaRoot(area);
  return root ? visibleElements(NAVIGATION_SELECTOR, root) : [];
}

function directionalTarget(currentElement, candidates, direction) {
  const current = elementCenter(currentElement);
  let bestTarget = null;
  let bestScore = Infinity;

  candidates.forEach(candidate => {
    if (candidate === currentElement) return;

    const next = elementCenter(candidate);
    const differenceX = next.x - current.x;
    const differenceY = next.y - current.y;

    let primaryDistance;
    let secondaryDistance;

    if (direction === "left") {
      if (differenceX >= -1) return;
      primaryDistance = Math.abs(differenceX);
      secondaryDistance = Math.abs(differenceY);
    } else if (direction === "right") {
      if (differenceX <= 1) return;
      primaryDistance = Math.abs(differenceX);
      secondaryDistance = Math.abs(differenceY);
    } else if (direction === "up") {
      if (differenceY >= -1) return;
      primaryDistance = Math.abs(differenceY);
      secondaryDistance = Math.abs(differenceX);
    } else if (direction === "down") {
      if (differenceY <= 1) return;
      primaryDistance = Math.abs(differenceY);
      secondaryDistance = Math.abs(differenceX);
    }

    const score = primaryDistance + secondaryDistance * 4;

    if (score < bestScore) {
      bestScore = score;
      bestTarget = candidate;
    }
  });

  return bestTarget;
}

function nearestByHorizontalPosition(currentElement, candidates) {
  if (!candidates.length) return null;

  const currentX = elementCenter(currentElement).x;
  let bestTarget = null;
  let bestDistance = Infinity;

  candidates.forEach(candidate => {
    const distance = Math.abs(elementCenter(candidate).x - currentX);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestTarget = candidate;
    }
  });

  return bestTarget;
}

function sequenceRowTargets(position) {
  const targets =
    targetsInArea("sequence-grid");

  if (!targets.length) {
    return [];
  }

  const rows = [];

  targets.forEach(target => {
    const top =
      target.getBoundingClientRect().top;

    let row = rows.find(item => {
      return Math.abs(item.top - top) < 4;
    });

    if (!row) {
      row = {
        top,
        targets: []
      };

      rows.push(row);
    }

    row.targets.push(target);
  });

  rows.sort((a, b) => a.top - b.top);

  if (position === "top") {
    return rows[0]?.targets ?? [];
  }

  return rows.at(-1)?.targets ?? [];
}

function adjacentArea(area, direction) {
  if (direction === "up") {
    if (area === "sequence-toolbar") {
      return "header";
    }

    if (area === "sequence-grid") {
      return "sequence-toolbar";
    }

    if (area === "editor-header") {
      return "sequence-grid";
    }

    if (area === "editor-content") {
      return "editor-header";
    }

    if (area === "pattern-manager") {
      return "editor-content";
    }
  }

  if (direction === "down") {
    if (area === "header") {
      return "sequence-toolbar";
    }

    if (area === "sequence-toolbar") {
      return "sequence-grid";
    }

    if (area === "sequence-grid") {
      return "editor-header";
    }

    if (area === "editor-header") {
      return "editor-content";
    }

    if (area === "editor-content") {
      return "pattern-manager";
    }
  }

  return null;
}

function isEditableControl(element) {
  return element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement;
}

function isEditing(element) {
  return isEditableControl(element) && element.dataset.keyboardEditing === "true";
}

function enterEditing(element) {
  if (!isEditableControl(element)) return false;

  element.dataset.keyboardEditing = "true";

  if (element instanceof HTMLInputElement && ["number", "text"].includes(element.type)) {
    element.select();
  }

  return true;
}

function leaveEditing(element) {
  if (!isEditableControl(element)) return false;
  delete element.dataset.keyboardEditing;
  return true;
}

function focusAfterRender(area, index) {
  requestAnimationFrame(() => {
    const targets = targetsInArea(area);
    const target = targets[Math.max(0, Math.min(targets.length - 1, index))];
    target?.focus();
  });
}

function handleTrackShortcut(event, activeElement) {
  if (!/^[1-4]$/.test(event.key)) return false;
  if (isEditing(activeElement)) return false;

  const nextTrackIndex = Number(event.key) - 1;
  if (nextTrackIndex === state.selectedTrackIndex) return true;

  const area = areaOf(activeElement) || "sequence";
  const targets = targetsInArea(area);
  const index = Math.max(0, targets.indexOf(activeElement));

  event.preventDefault();
  state.selectedTrackIndex = nextTrackIndex;
  render();
  focusAfterRender(area, index);
  return true;
}

function moveFocus(
  activeElement,
  direction
) {
  const area = areaOf(activeElement);

  if (!area) {
    const firstHeaderTarget =
      targetsInArea("header")[0];

    const patternLength =
      document.querySelector(
        ".pattern-length-input"
      );

    (
      firstHeaderTarget ||
      patternLength
    )?.focus();

    return true;
  }

  /*
   * ヘッダー ↓
   * 必ずシーケンサのステップ数へ
   */
  if (
    area === "header" &&
    direction === "down"
  ) {
    const patternLength =
      document.querySelector(
        ".pattern-length-input"
      );

    if (patternLength) {
      patternLength.focus();
      return true;
    }
  }

  /*
   * シーケンサ上部 ↓
   * シーケンサ最上段の最寄りへ
   */
  if (
    area === "sequence-toolbar" &&
    direction === "down"
  ) {
    const target =
      nearestByHorizontalPosition(
        activeElement,
        sequenceRowTargets("top")
      );

    if (target) {
      target.focus();
      return true;
    }
  }

  /*
   * シーケンサ上部 ↑
   * ヘッダーの最寄りへ
   */
  if (
    area === "sequence-toolbar" &&
    direction === "up"
  ) {
    const target =
      nearestByHorizontalPosition(
        activeElement,
        targetsInArea("header")
      );

    if (target) {
      target.focus();
      return true;
    }
  }

  /*
   * エディター上部 ↑
   * シーケンサ最下段の最寄りへ
   */
  if (
    area === "editor-header" &&
    direction === "up"
  ) {
    const target =
      nearestByHorizontalPosition(
        activeElement,
        sequenceRowTargets("bottom")
      );

    if (target) {
      target.focus();
      return true;
    }
  }

  /*
   * エディター上部 ↓
   * パラメータ／オフセットの最寄りへ
   */
  if (
    area === "editor-header" &&
    direction === "down"
  ) {
    const target =
      nearestByHorizontalPosition(
        activeElement,
        targetsInArea(
          "editor-content"
        )
      );

    if (target) {
      target.focus();
      return true;
    }
  }

  /*
 * Section編集記号 → Section内容
 */
if (
  area === "pattern-manager" &&
  direction === "right" &&
  activeElement.classList.contains(
    "section-editor-button"
  )
) {
  const firstSectionCell =
    document.querySelector(
      ".section-pattern-cell"
    );

  if (firstSectionCell) {
    firstSectionCell.focus();
    return true;
  }
}

/*
 * Section内容 ← Section編集記号
 */
if (
  area === "pattern-manager" &&
  direction === "left" &&
  activeElement.classList.contains(
    "section-pattern-cell"
  )
) {
  const editorButton =
    document.querySelector(
      ".section-editor-button"
    );

  if (editorButton) {
    editorButton.focus();
    return true;
  }
}
  /*
   * 通常のエリア内移動
   */
  const sameAreaTargets =
    targetsInArea(area);

  const sameAreaTarget =
    directionalTarget(
      activeElement,
      sameAreaTargets,
      direction
    );

  if (sameAreaTarget) {
    sameAreaTarget.focus();
    return true;
  }

  /*
   * エリア端に到達した時
   */
  const nextArea =
    adjacentArea(area, direction);

  if (!nextArea) {
    return false;
  }

  let nextAreaTargets =
    targetsInArea(nextArea);

  if (
    area === "sequence-grid" &&
    nextArea === "sequence-toolbar"
  ) {
    const patternLength =
      document.querySelector(
        ".pattern-length-input"
      );

    if (patternLength) {
      patternLength.focus();
      return true;
    }
  }

  if (
    area === "sequence-grid" &&
    nextArea === "editor-header"
  ) {
    nextAreaTargets =
      targetsInArea("editor-header");
  }

  const nextAreaTarget =
    nearestByHorizontalPosition(
      activeElement,
      nextAreaTargets
    );

  if (!nextAreaTarget) {
    return false;
  }

  nextAreaTarget.focus();

  return true;
}

document.addEventListener("focusin", event => {
  if (event.target instanceof HTMLElement) {
    lastFocusedElement = event.target;
  }
});

document.addEventListener("keydown", event => {
  const eventTarget = event.target;
  const activeElement = document.activeElement;

  /*
   * 実際にキーイベントが発生した要素を最優先する。
   * プリセット保存ダイアログを含む通常フォームでは、
   * アプリ共通のショートカット／カーソル移動を行わない。
   */
  const editingTarget =
    eventTarget instanceof HTMLElement
      ? eventTarget
      : activeElement;

  if (
    editingTarget?.closest?.(
      ".export-overlay, .global-overlay, .global-confirm-layer"
    )
  ) {
    return;
  }

  const isNativeTextEditing =
    editingTarget instanceof HTMLTextAreaElement ||
    editingTarget instanceof HTMLSelectElement ||
    editingTarget?.isContentEditable ||
    (
      editingTarget instanceof HTMLInputElement &&
      [
        "text",
        "search",
        "email",
        "password",
        "url",
        "tel"
      ].includes(editingTarget.type)
    ) ||
    Boolean(
      editingTarget?.closest?.(
        ".sound-preset-save-dialog input, .sound-preset-save-dialog select, .sound-preset-save-dialog textarea"
      )
    );

  if (isNativeTextEditing) {
    return;
  }

  if (!(activeElement instanceof HTMLElement)) return;

  if (handleTrackShortcut(event, activeElement)) return;

  if (event.key === "Enter" && isEditableControl(activeElement)) {
    if (!isEditing(activeElement)) {
      event.preventDefault();
      enterEditing(activeElement);
    } else {
      event.preventDefault();
      leaveEditing(activeElement);
    }
    return;
  }

  if (event.key === "Escape" && isEditing(activeElement)) {
    event.preventDefault();
    leaveEditing(activeElement);
    return;
  }

  const direction = ARROW_DIRECTIONS[event.key];
if (!direction) return;

/*
 * キーボード編集中は
 * グローバルカーソル移動を止める。
 */
if (
  activeElement.dataset.keyboardEditing ===
  "true"
) {
  return;
}

  if (isEditing(activeElement)) return;

  event.preventDefault();
  event.stopPropagation();
  moveFocus(activeElement || lastFocusedElement, direction);
}, true);
