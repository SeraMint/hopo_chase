export type DifficultyId = "easy" | "normal" | "hard";

export interface DifficultyDefinition {
  label: string;
  description: string;
  magazineSize: number;

  /**
   * 기본 접근 속도에 곱해지는 배율입니다.
   */
  approachSpeedMultiplier: number;

  /**
   * 시간에 따른 속도 증가율에 곱해지는 배율입니다.
   */
  speedIncreaseMultiplier: number;

  /**
   * 시간 가속의 최대 배율입니다.
   */
  maximumTimeSpeedMultiplier: number;
}

export const GAME_CONFIG = {
  defaultDifficulty: "normal" as DifficultyId,

  difficulties: {
    easy: {
      label: "쉬움",
      description: "느린 초기 속도와 완만한 난이도 상승",
      magazineSize: 30,
      approachSpeedMultiplier: 0.78,
      speedIncreaseMultiplier: 0.6,
      maximumTimeSpeedMultiplier: 1.45,
    },

    normal: {
      label: "보통",
      description: "기존 게임과 동일한 표준 밸런스",
      magazineSize: 20,
      approachSpeedMultiplier: 1,
      speedIncreaseMultiplier: 1,
      maximumTimeSpeedMultiplier: 1.8,
    },

    hard: {
      label: "어려움",
      description: "빠른 접근과 강한 시간 가속",
      magazineSize: 10,
      approachSpeedMultiplier: 1.18,
      speedIncreaseMultiplier: 1.35,
      maximumTimeSpeedMultiplier: 2.15,
    },
  } satisfies Record<DifficultyId, DifficultyDefinition>,

  camera: {
    position: {
      x: 0,
      y: 4.2,
      z: -10,
    },
    target: {
      x: 0,
      y: 1.6,
      z: 25,
    },
    fov: 0.9,
    minZ: 0.1,
  },

  road: {
    speed: 22,

    /**
     * 짧은 도로 조각을 이어 붙여 곡선과 언덕을 표현합니다.
     */
    segmentLength: 4.5,
    segmentCount: 46,
    startDistance: -16,

    roadWidth: 12,
    shoulderWidth: 34,
    roadThickness: 0.18,

    curve: {
      horizontalPrimaryAmplitude: 6.2,
      horizontalPrimaryLength: 42,

      horizontalSecondaryAmplitude: 2.1,
      horizontalSecondaryLength: 18,

      verticalPrimaryAmplitude: 2.6,
      verticalPrimaryLength: 56,

      verticalSecondaryAmplitude: 0.75,
      verticalSecondaryLength: 24,
    },

    camera: {
      distanceBehind: 10,
      height: 4.35,
      lookAheadDistance: 23,
      targetHeight: 1.55,
      followSharpness: 5.5,
      maximumRoll: 0.055,
    },
  },

  monster: {
    startPosition: {
      x: 0,
      y: 1.6,
      z: 70,
    },

    catchDistance: 0.75,
    attackTriggerDistance: 8.5,
    attackDuration: 0.86,
    attackLungeSpeed: 18,
    dangerDistance: 15,
    maxDistance: 115,

    minApproachSpeed: 7,
    maxApproachSpeed: 16,

    speedIncreasePerSecond: 0.005,

    swayAmount: 2.8,
    minSwaySpeed: 2.4,
    maxSwaySpeed: 5.5,

    bulletKnockbackImpulse: 34,
    maxKnockbackVelocity: 55,
    knockbackDrag: 4.2,

    hitStunDuration: 0.12,
    hitStunApproachMultiplier: 0.35,
  },

  gun: {
    magazineSize: 30,
    shotCooldownDuration: 0,
    reloadDuration: 2,
  },

  grenade: {
    launchOrigin: {
      x: 0,
      y: 2.25,
      z: -3.6,
    },

    /**
     * 휠 버튼을 누른 위치가 기본 사거리 50%가 됩니다.
     * 홀드 중 위로 움직이면 멀리, 아래로 움직이면 가까워집니다.
     */
    defaultRangeFactor: 0.5,
    rangeDragSensitivity: 1.55,

    /**
     * 사거리 조절은 수평 속도를 중심으로 변화시켜
     * 포물선 각도가 과도하게 높아지지 않게 합니다.
     */
    minHorizontalSpeed: 28,
    maxHorizontalSpeed: 72,

    minVerticalSpeed: 4,
    maxVerticalSpeed: 7,
    gravity: 18,

    grenadeRadius: 0.22,
    groundHeight: 0.06,
    maximumFlightTime: 5,

    cooldownDuration: 4,

    initialAmmo: 3,
    rewardEveryHits: 10,
    rewardAmount: 1,

    explosionRadius: 6,
    explosionKnockbackImpulse: 78,
    explosionLateralImpulse: 14,

    guidePointCount: 48,
    guideTimeStep: 0.07,
  },

  scoring: {
    vehicleMetersPerSecond: 22,

    leaderboardSize: 10,
    storageKey: "hopo-chase-local-leaderboard-v2",

    ranks: [
      {
        name: "브론즈",
        minDistance: 0,
      },
      {
        name: "실버",
        minDistance: 500,
      },
      {
        name: "골드",
        minDistance: 1000,
      },
      {
        name: "플래티넘",
        minDistance: 1800,
      },
      {
        name: "다이아몬드",
        minDistance: 3000,
      },
    ],
  },
} as const;
