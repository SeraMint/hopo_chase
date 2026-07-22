import type {
  ScoreEntry,
} from "../score/LeaderboardRepository";
import {
  getScoreDifficultyId,
} from "../score/LeaderboardRepository";

import type {
  DifficultyId,
} from "../game/GameConfig";

export interface HudViewModel {
  hitCount: number;
  monsterDistance: number;

  currentAmmo: number;
  magazineSize: number;

  shotCooldownRemaining: number;
  isReloading: boolean;
  reloadRemaining: number;
  reloadDuration: number;
  needsReload: boolean;

  grenadeAmmo: number;
  grenadeCooldownRemaining: number;
  grenadeCooldownDuration: number;
  isGrenadeAiming: boolean;
  grenadeReady: boolean;
  grenadeAimRangeFactor: number;
  grenadeEstimatedDistance: number;

  difficultyLabel: string;

  distanceTravelled: number;
  survivalTime: number;
  rank: string;
  monsterSpeedMultiplier: number;

  isPlaying: boolean;
}

export interface FinalScoreViewModel {
  distanceTravelled: number;
  survivalTime: number;
  rank: string;
  difficultyLabel: string;
}

type ReloadAnimationStage =
  | "remove"
  | "insert"
  | "charge";

interface ReloadCombatUi {
  overlay: HTMLDivElement;
  progressCircle: SVGCircleElement;
  stageElement: HTMLElement;
  timeElement: HTMLElement;
  percentElement: HTMLElement;
  ammoRack: HTMLDivElement;
  ammoSlotsElement: HTMLDivElement;
  ammoCountElement: HTMLElement;
  ammoStageElement: HTMLElement;
  completeFlash: HTMLDivElement;
}

function getElement<
  T extends HTMLElement
>(
  selector: string,
): T {
  const element =
    document.querySelector<T>(
      selector,
    );

  if (!element) {
    throw new Error(
      `HTML 요소를 찾지 못했습니다: ${selector}`,
    );
  }

  return element;
}

function clamp(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(
    Math.max(value, min),
    max,
  );
}

export class HudController {
  private readonly hud =
    getElement<HTMLElement>("#hud");

  private readonly crosshair =
    getElement<HTMLDivElement>(
      "#crosshair",
    );

  private readonly hitCountElement =
    getElement<HTMLElement>(
      "#hit-count",
    );

  private readonly distanceElement =
    getElement<HTMLElement>(
      "#nearest-distance",
    );

  private readonly statusElement =
    getElement<HTMLElement>(
      "#status-message",
    );

  private readonly titleScreenElement =
    getElement<HTMLElement>(
      "#title-screen",
    );

  public readonly startButton =
    getElement<HTMLButtonElement>(
      "#start-button",
    );

  public readonly soundToggleButton =
    getElement<HTMLButtonElement>(
      "#sound-toggle",
    );

  public readonly mobileFireButton =
    getElement<HTMLButtonElement>(
      "#mobile-fire-button",
    );

  public readonly mobileGrenadeButton =
    getElement<HTMLButtonElement>(
      "#mobile-grenade-button",
    );

  public readonly mobileReloadButton =
    getElement<HTMLButtonElement>(
      "#mobile-reload-button",
    );

  private readonly mobileControlsElement =
    getElement<HTMLDivElement>(
      "#mobile-controls",
    );

  private readonly mobileFireAmmoElement =
    getElement<HTMLElement>(
      "#mobile-fire-ammo",
    );

  private readonly mobileGrenadeAmmoElement =
    getElement<HTMLElement>(
      "#mobile-grenade-ammo",
    );

  private readonly helpElement =
    document.querySelector<HTMLElement>(
      "#help",
    );

  private readonly gameOverElement =
    getElement<HTMLDivElement>(
      "#game-over",
    );

  public readonly restartButton =
    getElement<HTMLButtonElement>(
      "#restart-button",
    );

  public readonly submitScoreButton =
    getElement<HTMLButtonElement>(
      "#submit-score-button",
    );

  public readonly playerNameInput =
    getElement<HTMLInputElement>(
      "#player-name",
    );

  private readonly scoreRegistrationElement =
    getElement<HTMLElement>(
      ".score-registration",
    );

  private readonly finalDistanceElement =
    getElement<HTMLElement>(
      "#final-distance",
    );

  private readonly finalTimeElement =
    getElement<HTMLElement>(
      "#final-time",
    );

  private readonly finalRankElement =
    getElement<HTMLElement>(
      "#final-rank",
    );

  private readonly finalDifficultyElement =
    getElement<HTMLElement>(
      "#final-difficulty",
    );

  private readonly scoreFeedbackElement =
    getElement<HTMLElement>(
      "#score-feedback",
    );

  private readonly scoreboardLists:
    Record<DifficultyId, HTMLOListElement> = {
      easy: getElement<HTMLOListElement>(
        '.scoreboard-list[data-difficulty="easy"]',
      ),
      normal: getElement<HTMLOListElement>(
        '.scoreboard-list[data-difficulty="normal"]',
      ),
      hard: getElement<HTMLOListElement>(
        '.scoreboard-list[data-difficulty="hard"]',
      ),
    };

  private readonly ammoElement:
    HTMLElement;

  private readonly weaponStatusElement:
    HTMLElement;

  private readonly travelledDistanceElement:
    HTMLElement;

  private readonly survivalTimeElement:
    HTMLElement;

  private readonly rankElement:
    HTMLElement;

  private readonly difficultyNameElement:
    HTMLElement;

  private readonly difficultyElement:
    HTMLElement;

  private readonly grenadeStatusElement:
    HTMLElement;

  private readonly grenadeAimHint:
    HTMLDivElement;

  private readonly grenadeAimDistanceElement:
    HTMLElement;

  private readonly grenadeAimPowerElement:
    HTMLElement;

  private readonly reloadWarning:
    HTMLDivElement;

  private readonly reloadOverlay:
    HTMLDivElement;

  private readonly reloadProgressCircle:
    SVGCircleElement;

  private readonly reloadStageElement:
    HTMLElement;

  private readonly reloadTimeElement:
    HTMLElement;

  private readonly reloadPercentElement:
    HTMLElement;

  private readonly ammoRack:
    HTMLDivElement;

  private readonly ammoSlotsElement:
    HTMLDivElement;

  private readonly ammoRackCountElement:
    HTMLElement;

  private readonly ammoRackStageElement:
    HTMLElement;

  private readonly reloadCompleteFlash:
    HTMLDivElement;

  private ammoSlots:
    HTMLSpanElement[] = [];

  private reloadStage:
    ReloadAnimationStage | null = null;

  private statusTimer:
    number | undefined;

  private reloadCompleteTimer:
    number | undefined;

  private focusPlayerNameTimer:
    number | undefined;

  private readonly textCache = new WeakMap<Node, string>();
  private readonly hiddenCache = new WeakMap<HTMLElement, boolean>();
  private readonly styleCache = new WeakMap<Element, Map<string, string>>();
  private readonly classCache = new WeakMap<Element, Map<string, boolean>>();

  public constructor() {
    this.ammoElement =
      this.createHudValue(
        "ammo-count",
        "탄약",
      );

    this.weaponStatusElement =
      this.createHudValue(
        "weapon-status",
        "무기",
      );

    this.travelledDistanceElement =
      this.createHudValue(
        "distance-travelled",
        "주행 거리",
      );

    this.survivalTimeElement =
      this.createHudValue(
        "survival-time",
        "생존 시간",
      );

    this.rankElement =
      this.createHudValue(
        "current-rank",
        "랭크",
      );

    this.difficultyNameElement =
      this.createHudValue(
        "difficulty-name",
        "난이도",
      );

    this.difficultyElement =
      this.createHudValue(
        "difficulty-multiplier",
        "위협 배율",
      );

    this.grenadeStatusElement =
      this.createHudValue(
        "grenade-status",
        "유탄",
      );

    this.grenadeAimHint =
      this.createGrenadeAimHint();

    const grenadeAimDistanceElement =
      this.grenadeAimHint
        .querySelector<HTMLElement>(
          ".grenade-aim-hint__distance",
        );

    const grenadeAimPowerElement =
      this.grenadeAimHint
        .querySelector<HTMLElement>(
          ".grenade-aim-hint__power-value",
        );

    if (
      !grenadeAimDistanceElement ||
      !grenadeAimPowerElement
    ) {
      throw new Error(
        "유탄 사거리 UI 생성에 실패했습니다.",
      );
    }

    this.grenadeAimDistanceElement =
      grenadeAimDistanceElement;

    this.grenadeAimPowerElement =
      grenadeAimPowerElement;

    this.reloadWarning =
      this.createReloadWarning();

    const reloadUi =
      this.createReloadCombatUi();

    this.reloadOverlay =
      reloadUi.overlay;

    this.reloadProgressCircle =
      reloadUi.progressCircle;

    this.reloadStageElement =
      reloadUi.stageElement;

    this.reloadTimeElement =
      reloadUi.timeElement;

    this.reloadPercentElement =
      reloadUi.percentElement;

    this.ammoRack =
      reloadUi.ammoRack;

    this.ammoSlotsElement =
      reloadUi.ammoSlotsElement;

    this.ammoRackCountElement =
      reloadUi.ammoCountElement;

    this.ammoRackStageElement =
      reloadUi.ammoStageElement;

    this.reloadCompleteFlash =
      reloadUi.completeFlash;

    const helpElement =
      document.querySelector<HTMLElement>(
        "#help",
      );

    if (helpElement) {
      helpElement.textContent =
        "마우스 이동: 조준 · 왼쪽 클릭: 사격 · 우클릭: 재장전 · 휠 버튼 홀드/릴리스: 유탄";
    }
  }

  private setText(element: Node, value: string): void {
    if (
      this.textCache.get(element) === value &&
      element.textContent === value
    ) {
      return;
    }

    element.textContent = value;
    this.textCache.set(element, value);
  }

  private setHidden(element: HTMLElement, hidden: boolean): void {
    if (
      this.hiddenCache.get(element) === hidden &&
      element.hidden === hidden
    ) {
      return;
    }

    element.hidden = hidden;
    this.hiddenCache.set(element, hidden);
  }

  private setStyle(element: Element, property: string, value: string): void {
    let values = this.styleCache.get(element);

    if (!values) {
      values = new Map<string, string>();
      this.styleCache.set(element, values);
    }

    const style =
      (element as HTMLElement | SVGElement).style;

    if (
      values.get(property) === value &&
      style.getPropertyValue(property) === value
    ) {
      return;
    }

    style.setProperty(property, value);
    values.set(property, value);
  }

  private toggleClass(element: Element, className: string, enabled: boolean): void {
    let values = this.classCache.get(element);

    if (!values) {
      values = new Map<string, boolean>();
      this.classCache.set(element, values);
    }

    if (
      values.get(className) === enabled &&
      element.classList.contains(className) === enabled
    ) {
      return;
    }

    element.classList.toggle(className, enabled);
    values.set(className, enabled);
  }

  private createHudValue(
    id: string,
    label: string,
  ): HTMLElement {
    const existing =
      document.querySelector<HTMLElement>(
        `#${id}`,
      );

    if (existing) {
      return existing;
    }

    const row =
      document.createElement("div");

    const value =
      document.createElement("strong");

    value.id = id;
    row.className = "hud-value-row";
    row.dataset.hudValue = id;

    row.append(
      document.createTextNode(
        `${label}: `,
      ),
      value,
    );

    this.hud.insertBefore(
      row,
      this.statusElement,
    );

    return value;
  }

  private createGrenadeAimHint():
    HTMLDivElement {
    const existing =
      document.querySelector<HTMLDivElement>(
        "#grenade-aim-hint",
      );

    if (existing) {
      return existing;
    }

    const hint =
      document.createElement("div");

    hint.id = "grenade-aim-hint";
    hint.hidden = true;

    hint.innerHTML = `
      <strong>GRENADE AIM</strong>
      <span>
        마우스 ↑ 멀리 · ↓ 가까이
      </span>
      <small>
        예상 거리
        <b class="grenade-aim-hint__distance">
          0m
        </b>
        · 휠 버튼 릴리스 발사
      </small>
      <span
        class="grenade-aim-hint__power"
        aria-hidden="true"
      >
        <i
          class="grenade-aim-hint__power-value"
        ></i>
      </span>
    `;

    document.body.appendChild(hint);

    return hint;
  }

  private createReloadWarning():
    HTMLDivElement {
    const existing =
      document.querySelector<HTMLDivElement>(
        "#reload-warning",
      );

    if (existing) {
      return existing;
    }

    const warning =
      document.createElement("div");

    warning.id = "reload-warning";
    warning.hidden = true;

    warning.setAttribute(
      "role",
      "status",
    );

    warning.setAttribute(
      "aria-live",
      "assertive",
    );

    warning.innerHTML = `
      <div class="reload-warning__panel">
        <span
          class="reload-warning__mouse"
          aria-hidden="true"
        >
          <span
            class="reload-warning__right-button"
          ></span>
        </span>

        <span class="reload-warning__text">
          <strong>탄약 없음</strong>
          <span>
            마우스 우클릭으로 재장전
          </span>
        </span>
      </div>
    `;

    document.body.appendChild(
      warning,
    );

    return warning;
  }

  private createReloadCombatUi():
    ReloadCombatUi {
    const overlay =
      document.createElement("div");

    overlay.id =
      "reload-progress-overlay";

    overlay.hidden = true;

    overlay.setAttribute(
      "aria-live",
      "polite",
    );

    overlay.innerHTML = `
      <div class="reload-reticle-shell">
        <svg
          class="reload-progress-gauge"
          viewBox="0 0 120 120"
          aria-hidden="true"
        >
          <circle
            class="reload-progress-track"
            cx="60"
            cy="60"
            r="52"
            pathLength="100"
          ></circle>

          <circle
            class="reload-progress-value"
            cx="60"
            cy="60"
            r="52"
            pathLength="100"
          ></circle>
        </svg>

        <div class="reload-progress-copy">
          <strong>RELOADING</strong>
          <span class="reload-progress-stage">
            탄창 제거
          </span>
          <span class="reload-progress-time">
            2.0s
          </span>
          <small class="reload-progress-percent">
            0%
          </small>
        </div>
      </div>
    `;

    const progressCircle =
      overlay.querySelector<SVGCircleElement>(
        ".reload-progress-value",
      );

    const stageElement =
      overlay.querySelector<HTMLElement>(
        ".reload-progress-stage",
      );

    const timeElement =
      overlay.querySelector<HTMLElement>(
        ".reload-progress-time",
      );

    const percentElement =
      overlay.querySelector<HTMLElement>(
        ".reload-progress-percent",
      );

    if (
      !progressCircle ||
      !stageElement ||
      !timeElement ||
      !percentElement
    ) {
      throw new Error(
        "재장전 진행 UI 생성에 실패했습니다.",
      );
    }

    const ammoRack =
      document.createElement("div");

    ammoRack.id = "ammo-rack";

    ammoRack.innerHTML = `
      <div class="ammo-rack__header">
        <span>MAGAZINE</span>
        <strong class="ammo-rack__count">
          0 / 0
        </strong>
      </div>

      <div
        class="ammo-rack__slots"
        aria-label="탄창 상태"
      ></div>

      <div class="ammo-rack__stage">
        발사 준비
      </div>
    `;

    const ammoSlotsElement =
      ammoRack.querySelector<HTMLDivElement>(
        ".ammo-rack__slots",
      );

    const ammoCountElement =
      ammoRack.querySelector<HTMLElement>(
        ".ammo-rack__count",
      );

    const ammoStageElement =
      ammoRack.querySelector<HTMLElement>(
        ".ammo-rack__stage",
      );

    if (
      !ammoSlotsElement ||
      !ammoCountElement ||
      !ammoStageElement
    ) {
      throw new Error(
        "탄창 슬롯 UI 생성에 실패했습니다.",
      );
    }

    const completeFlash =
      document.createElement("div");

    completeFlash.id =
      "reload-complete-flash";

    completeFlash.hidden = true;

    completeFlash.innerHTML = `
      <span>READY</span>
    `;

    document.body.append(
      overlay,
      ammoRack,
      completeFlash,
    );

    return {
      overlay,
      progressCircle,
      stageElement,
      timeElement,
      percentElement,
      ammoRack,
      ammoSlotsElement,
      ammoCountElement,
      ammoStageElement,
      completeFlash,
    };
  }

  private ensureAmmoSlots(
    magazineSize: number,
  ): void {
    if (
      this.ammoSlots.length ===
      magazineSize
    ) {
      return;
    }

    this.ammoSlotsElement
      .replaceChildren();

    this.ammoSlots = [];

    for (
      let index = 0;
      index < magazineSize;
      index += 1
    ) {
      const slot =
        document.createElement("span");

      slot.className =
        "ammo-rack__bullet";

      slot.setAttribute(
        "aria-hidden",
        "true",
      );

      slot.style.setProperty(
        "--ammo-index",
        String(index),
      );

      this.ammoSlotsElement
        .appendChild(slot);

      this.ammoSlots.push(slot);
    }
  }

  public update(
    view: HudViewModel,
  ): void {
    this.setText(this.hitCountElement, String(view.hitCount));
    this.setText(
      this.distanceElement,
      `${Math.max(0, view.monsterDistance).toFixed(1)} m`,
    );
    this.setText(
      this.ammoElement,
      `${view.currentAmmo} / ${view.magazineSize}`,
    );
    this.setText(
      this.mobileFireAmmoElement,
      String(view.currentAmmo),
    );
    this.setText(
      this.mobileGrenadeAmmoElement,
      String(view.grenadeAmmo),
    );
    this.setText(
      this.travelledDistanceElement,
      `${Math.floor(view.distanceTravelled).toLocaleString()} m`,
    );
    this.setText(
      this.survivalTimeElement,
      `${view.survivalTime.toFixed(1)}초`,
    );
    this.setText(this.rankElement, view.rank);
    this.setText(this.difficultyNameElement, view.difficultyLabel);
    this.setText(
      this.difficultyElement,
      `x${view.monsterSpeedMultiplier.toFixed(2)}`,
    );

    let grenadeStatus: string;
    if (view.grenadeAmmo <= 0) {
      grenadeStatus = "0발 · 탄약 없음";
    } else if (view.isGrenadeAiming) {
      grenadeStatus = `${view.grenadeAmmo}발 · 조준 ${Math.round(view.grenadeEstimatedDistance)}m`;
    } else if (
      view.grenadeCooldownRemaining > 0
    ) {
      grenadeStatus = `${view.grenadeAmmo}발 · 재사용 ${view.grenadeCooldownRemaining.toFixed(1)}초`;
    } else {
      grenadeStatus = `${view.grenadeAmmo}발 · 발사 준비`;
    }
    this.setText(this.grenadeStatusElement, grenadeStatus);

    let weaponStatus: string;
    if (view.isReloading) {
      weaponStatus = `재장전 중 ${view.reloadRemaining.toFixed(1)}초`;
    } else if (
      view.shotCooldownRemaining > 0
    ) {
      weaponStatus = `발사 대기 ${view.shotCooldownRemaining.toFixed(1)}초`;
    } else if (view.needsReload) {
      weaponStatus = "재장전 필요";
    } else {
      weaponStatus = "발사 준비";
    }
    this.setText(this.weaponStatusElement, weaponStatus);

    this.toggleClass(
      this.crosshair,
      "crosshair--cooldown",
      view.shotCooldownRemaining > 0 &&
        !view.isReloading &&
        !view.needsReload,
    );

    this.toggleClass(
      this.crosshair,
      "crosshair--reloading",
      view.isReloading,
    );

    this.toggleClass(
      this.crosshair,
      "crosshair--empty",
      view.needsReload,
    );

    this.toggleClass(
      this.crosshair,
      "crosshair--grenade-aiming",
      view.isGrenadeAiming,
    );

    this.toggleClass(
      this.mobileFireButton,
      "mobile-control-button--empty",
      view.needsReload,
    );

    this.toggleClass(
      this.mobileFireButton,
      "mobile-control-button--busy",
      view.isReloading ||
        view.shotCooldownRemaining > 0,
    );

    this.toggleClass(
      this.mobileReloadButton,
      "mobile-control-button--active",
      view.isReloading,
    );

    this.toggleClass(
      this.mobileGrenadeButton,
      "mobile-control-button--empty",
      view.grenadeAmmo <= 0,
    );

    this.toggleClass(
      this.mobileGrenadeButton,
      "mobile-control-button--busy",
      view.grenadeCooldownRemaining > 0,
    );

    this.mobileFireButton.setAttribute(
      "aria-disabled",
      String(
        !view.isPlaying ||
        view.needsReload ||
        view.isReloading ||
        view.shotCooldownRemaining > 0 ||
        view.isGrenadeAiming,
      ),
    );

    this.mobileReloadButton.setAttribute(
      "aria-disabled",
      String(
        !view.isPlaying ||
        view.isReloading ||
        view.currentAmmo >= view.magazineSize,
      ),
    );

    this.mobileGrenadeButton.setAttribute(
      "aria-disabled",
      String(
        !view.isPlaying ||
        view.isReloading ||
        view.grenadeAmmo <= 0 ||
        view.grenadeCooldownRemaining > 0,
      ),
    );

    this.setHidden(
      this.grenadeAimHint,
      !(
        view.isGrenadeAiming &&
        view.isPlaying
      ),
    );

    this.setText(
      this.grenadeAimDistanceElement,
      `${Math.round(view.grenadeEstimatedDistance)}m`,
    );

    this.setStyle(
      this.grenadeAimPowerElement,
      "width",
      `${Math.round(
        clamp(
          view.grenadeAimRangeFactor,
          0,
          1,
        ) * 100,
      )}%`,
    );

    this.setHidden(
      this.reloadWarning,
      !(
        view.needsReload &&
        view.isPlaying
      ),
    );

    this.updateReloadUi(view);
  }

  private updateReloadUi(
    view: HudViewModel,
  ): void {
    this.ensureAmmoSlots(
      view.magazineSize,
    );

    const progress =
      view.reloadDuration > 0
        ? clamp(
            1 -
              view.reloadRemaining /
                view.reloadDuration,
            0,
            1,
          )
        : view.isReloading
          ? 1
          : 0;

    this.setHidden(
      this.reloadOverlay,
      !(view.isReloading && view.isPlaying),
    );

    this.setHidden(this.ammoRack, !view.isPlaying);

    this.setStyle(
      this.reloadProgressCircle,
      "stroke-dashoffset",
      String(100 - progress * 100),
    );

    this.setText(
      this.reloadTimeElement,
      `${view.reloadRemaining.toFixed(1)}s`,
    );

    this.setText(
      this.reloadPercentElement,
      `${Math.round(progress * 100)}%`,
    );

    const stage =
      this.getReloadStage(progress);

    this.applyReloadStage(
      stage,
      view.isReloading,
    );

    this.updateAmmoRack(
      view,
      progress,
      stage,
    );
  }

  private getReloadStage(
    progress: number,
  ): ReloadAnimationStage {
    if (progress < 0.24) {
      return "remove";
    }

    if (progress < 0.82) {
      return "insert";
    }

    return "charge";
  }

  private applyReloadStage(
    stage: ReloadAnimationStage,
    isReloading: boolean,
  ): void {
    if (!isReloading) {
      this.reloadStage = null;

      this.reloadOverlay.removeAttribute(
        "data-stage",
      );

      this.ammoRack.removeAttribute(
        "data-stage",
      );

      return;
    }

    if (this.reloadStage === stage) {
      return;
    }

    this.reloadStage = stage;

    this.reloadOverlay.dataset.stage =
      stage;

    this.ammoRack.dataset.stage =
      stage;

    switch (stage) {
      case "remove":
        this.reloadStageElement.textContent =
          "탄창 제거";
        break;

      case "insert":
        this.reloadStageElement.textContent =
          "새 탄창 삽입";
        break;

      case "charge":
        this.reloadStageElement.textContent =
          "장전 손잡이";
        break;
    }
  }

  private updateAmmoRack(
    view: HudViewModel,
    progress: number,
    stage: ReloadAnimationStage,
  ): void {
    let displayedAmmo =
      view.currentAmmo;

    if (view.isReloading) {
      if (progress < 0.24) {
        const removeProgress =
          progress / 0.24;

        displayedAmmo =
          Math.max(
            0,
            Math.ceil(
              view.currentAmmo *
                (1 - removeProgress),
            ),
          );
      } else {
        const insertProgress =
          clamp(
            (progress - 0.24) /
              0.76,
            0,
            1,
          );

        displayedAmmo =
          Math.min(
            view.magazineSize,
            Math.floor(
              insertProgress *
                view.magazineSize,
            ),
          );
      }
    }

    this.ammoSlots.forEach(
      (slot, index) => {
        const isFilled =
          index < displayedAmmo;

        const isNewestRound =
          view.isReloading &&
          stage !== "remove" &&
          index === displayedAmmo - 1;

        this.toggleClass(
          slot,
          "ammo-rack__bullet--filled",
          isFilled,
        );

        this.toggleClass(
          slot,
          "ammo-rack__bullet--loading",
          isNewestRound,
        );
      },
    );

    this.setText(
      this.ammoRackCountElement,
      `${displayedAmmo} / ${view.magazineSize}`,
    );

    let ammoStageText: string;
    if (view.isReloading) {
      ammoStageText =
        this.reloadStageElement.textContent ?? "재장전 중";
    } else if (view.needsReload) {
      ammoStageText = "우클릭으로 재장전";
    } else if (view.shotCooldownRemaining > 0) {
      ammoStageText = "발사 준비 중";
    } else {
      ammoStageText = "발사 준비";
    }
    this.setText(this.ammoRackStageElement, ammoStageText);

    this.toggleClass(
      this.ammoRack,
      "ammo-rack--reloading",
      view.isReloading,
    );

    this.toggleClass(
      this.ammoRack,
      "ammo-rack--empty",
      view.needsReload,
    );
  }

  public showReloadComplete(): void {
    if (
      this.reloadCompleteTimer !==
      undefined
    ) {
      window.clearTimeout(
        this.reloadCompleteTimer,
      );
    }

    this.reloadCompleteFlash.hidden =
      false;

    this.reloadCompleteFlash.classList
      .remove(
        "reload-complete-flash--active",
      );

    this.ammoRack.classList.remove(
      "ammo-rack--complete",
    );

    void this.reloadCompleteFlash
      .offsetWidth;

    this.reloadCompleteFlash.classList
      .add(
        "reload-complete-flash--active",
      );

    this.ammoRack.classList.add(
      "ammo-rack--complete",
    );

    this.reloadCompleteTimer =
      window.setTimeout(() => {
        this.reloadCompleteTimer =
          undefined;

        this.reloadCompleteFlash.hidden =
          true;

        this.reloadCompleteFlash.classList
          .remove(
            "reload-complete-flash--active",
          );

        this.ammoRack.classList.remove(
          "ammo-rack--complete",
        );
      }, 520);
  }

  public setFinalScore(
    view: FinalScoreViewModel,
  ): void {
    this.finalDistanceElement.textContent =
      `${Math.floor(
        view.distanceTravelled,
      ).toLocaleString()} m`;

    this.finalTimeElement.textContent =
      `${view.survivalTime.toFixed(1)}초`;

    this.finalRankElement.textContent =
      view.rank;

    this.finalDifficultyElement.textContent =
      view.difficultyLabel;
  }

  public renderLeaderboard(
    entries: ScoreEntry[],
  ): void {
    const difficulties:
      readonly DifficultyId[] = [
        "easy",
        "normal",
        "hard",
      ];

    difficulties.forEach((difficulty) => {
      const list =
        this.scoreboardLists[difficulty];
      const difficultyEntries =
        entries.filter(
          (entry) =>
            getScoreDifficultyId(entry) ===
            difficulty,
        );

      list.replaceChildren();

      if (difficultyEntries.length === 0) {
        const emptyItem =
          document.createElement("li");

        emptyItem.className =
          "scoreboard-empty";
        emptyItem.textContent =
          "등록된 기록이 없습니다.";
        list.appendChild(emptyItem);

        return;
      }

      difficultyEntries.forEach(
        (entry, index) => {
        const item =
          document.createElement("li");

        const position =
          document.createElement("span");

        const name =
          document.createElement("strong");

        const score =
          document.createElement("span");

        const rank =
          document.createElement("small");

        position.className =
          "scoreboard-position";

        name.className =
          "scoreboard-name";

        score.className =
          "scoreboard-score";

        rank.className =
          "scoreboard-rank";

        position.textContent =
          `${index + 1}`;

        name.textContent =
          entry.playerName;

        score.textContent =
          `${Math.floor(
            entry.distance,
          ).toLocaleString()} m`;

        rank.textContent =
          `${entry.rank} · ${entry.survivalTime.toFixed(1)}초`;

        item.append(
          position,
          name,
          score,
          rank,
        );

        list.appendChild(item);
        },
      );
    });
  }

  public resetScoreRegistration(): void {
    this.submitScoreButton.disabled =
      false;

    this.submitScoreButton.textContent =
      "기록 등록";

    this.playerNameInput.disabled =
      false;

    this.playerNameInput.value = "";

    this.scoreFeedbackElement.textContent =
      "";
  }

  public setScoreRegistrationVisible(
    visible: boolean,
  ): void {
    this.scoreRegistrationElement.hidden = !visible;
  }

  public markScoreSubmitted(
    message: string,
  ): void {
    this.submitScoreButton.disabled =
      true;

    this.submitScoreButton.textContent =
      "등록 완료";

    this.playerNameInput.disabled =
      true;

    this.scoreFeedbackElement.textContent =
      message;
  }

  public markScoreSubmitting(): void {
    this.submitScoreButton.disabled = true;
    this.submitScoreButton.textContent = "등록 중...";
    this.playerNameInput.disabled = true;
    this.scoreFeedbackElement.textContent =
      "글로벌 리더보드에 기록을 등록하고 있습니다.";
  }

  public markScoreSubmissionFailed(message: string): void {
    this.submitScoreButton.disabled = false;
    this.submitScoreButton.textContent = "다시 시도";
    this.playerNameInput.disabled = false;
    this.scoreFeedbackElement.textContent = message;
  }

  public setScoreFeedback(
    message: string,
  ): void {
    this.scoreFeedbackElement.textContent =
      message;
  }

  public focusPlayerName(): void {
    if (
      this.focusPlayerNameTimer !==
      undefined
    ) {
      window.clearTimeout(
        this.focusPlayerNameTimer,
      );
    }

    this.focusPlayerNameTimer =
      window.setTimeout(() => {
        this.focusPlayerNameTimer =
          undefined;

        this.playerNameInput.focus();
        this.playerNameInput.select();
      }, 0);
  }

  public getPlayerName(): string {
    return this.playerNameInput.value;
  }

  public getSelectedDifficulty():
    DifficultyId {
    const checkedInput =
      document.querySelector<HTMLInputElement>(
        'input[name="difficulty"]:checked',
      );

    const value =
      checkedInput?.value;

    if (
      value === "easy" ||
      value === "normal" ||
      value === "hard"
    ) {
      return value;
    }

    return "normal";
  }

  public moveCrosshair(
    x: number,
    y: number,
  ): void {
    this.crosshair.style.left =
      `${x}px`;

    this.crosshair.style.top =
      `${y}px`;

    this.reloadOverlay.style.left =
      `${x}px`;

    this.reloadOverlay.style.top =
      `${y}px`;

    this.reloadCompleteFlash.style.left =
      `${x}px`;

    this.reloadCompleteFlash.style.top =
      `${y}px`;

    this.grenadeAimHint.style.left =
      `${x}px`;

    this.grenadeAimHint.style.top =
      `${y}px`;
  }

  public setCrosshairVisible(
    visible: boolean,
  ): void {
    this.crosshair.hidden =
      !visible;
  }

  public setMobileControlsVisible(
    visible: boolean,
  ): void {
    this.mobileControlsElement.hidden = !visible;
    this.mobileControlsElement.inert = !visible;
    this.mobileControlsElement.setAttribute(
      "aria-hidden",
      String(!visible),
    );
  }

  public setTitleVisible(
    visible: boolean,
  ): void {
    this.titleScreenElement.hidden =
      !visible;

    this.hud.hidden = visible;

    if (this.helpElement) {
      this.helpElement.hidden = visible;
    }

    if (visible) {
      this.crosshair.hidden = true;
      this.reloadWarning.hidden = true;
      this.reloadOverlay.hidden = true;
      this.ammoRack.hidden = true;
      this.reloadCompleteFlash.hidden = true;
      this.grenadeAimHint.hidden = true;
    }
  }

  public setGameOverVisible(
    visible: boolean,
  ): void {
    this.gameOverElement.hidden =
      !visible;

    if (visible) {
      this.reloadWarning.hidden =
        true;

      this.reloadOverlay.hidden =
        true;

      this.ammoRack.hidden =
        true;

      this.reloadCompleteFlash.hidden =
        true;

      this.grenadeAimHint.hidden =
        true;
    }
  }

  public setStatus(
    message: string,
  ): void {
    this.clearStatusTimer();
    this.statusElement.textContent =
      message;
  }

  public showTemporaryStatus(
    message: string,
    fallbackProvider:
      () => string,
    duration = 700,
  ): void {
    this.statusElement.textContent =
      message;

    this.clearStatusTimer();

    this.statusTimer =
      window.setTimeout(() => {
        this.statusTimer = undefined;

        this.statusElement.textContent =
          fallbackProvider();
      }, duration);
  }

  public clearStatusTimer(): void {
    if (
      this.statusTimer === undefined
    ) {
      return;
    }

    window.clearTimeout(
      this.statusTimer,
    );

    this.statusTimer = undefined;
  }

  public clearTransientEffects(): void {
    this.clearStatusTimer();

    if (
      this.reloadCompleteTimer !==
      undefined
    ) {
      window.clearTimeout(
        this.reloadCompleteTimer,
      );

      this.reloadCompleteTimer =
        undefined;
    }

    if (
      this.focusPlayerNameTimer !==
      undefined
    ) {
      window.clearTimeout(
        this.focusPlayerNameTimer,
      );

      this.focusPlayerNameTimer =
        undefined;
    }

    this.reloadCompleteFlash.hidden =
      true;

    this.reloadCompleteFlash.classList
      .remove(
        "reload-complete-flash--active",
      );

    this.ammoRack.classList.remove(
      "ammo-rack--complete",
    );
  }
}
