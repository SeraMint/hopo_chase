import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
} from "@babylonjs/core";

import { RoadController, type RoadSample } from "../world/RoadController";

export interface MonsterControllerConfig {
  startPosition: {
    x: number;
    y: number;
    z: number;
  };

  catchDistance: number;
  attackTriggerDistance: number;
  attackDuration: number;
  attackLungeSpeed: number;
  dangerDistance: number;
  maxDistance: number;

  minApproachSpeed: number;
  maxApproachSpeed: number;

  speedIncreasePerSecond: number;

  swayAmount: number;
  minSwaySpeed: number;
  maxSwaySpeed: number;

  bulletKnockbackImpulse: number;
  maxKnockbackVelocity: number;
  knockbackDrag: number;

  hitStunDuration: number;
  hitStunApproachMultiplier: number;
}

export interface MonsterDifficultySettings {
  approachSpeedMultiplier: number;
  speedIncreaseMultiplier: number;
  maximumTimeSpeedMultiplier: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function randomRange(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}

/**
 * 시작과 끝에서 속도가 자연스럽게 줄어드는 보간입니다.
 */
function smootherStep(value: number): number {
  const amount = clamp(value, 0, 1);

  return amount * amount * amount * (amount * (amount * 6 - 15) + 10);
}

export class MonsterController {
  public readonly mesh: Mesh;

  private readonly scene: Scene;
  private readonly config: MonsterControllerConfig;

  private readonly road: RoadController;

  /**
   * 투명 히트박스 아래에 배치되는 절차적 몬스터 모델입니다.
   */
  private modelRoot!: TransformNode;
  private torsoJoint!: TransformNode;
  private headJoint!: TransformNode;

  private frontLeftLimb!: TransformNode;
  private frontRightLimb!: TransformNode;
  private rearLeftLimb!: TransformNode;
  private rearRightLimb!: TransformNode;

  private frontLeftLower!: TransformNode;
  private frontRightLower!: TransformNode;
  private rearLeftLower!: TransformNode;
  private rearRightLower!: TransformNode;

  /**
   * 피격 시 함께 점멸할 피부 재질들입니다.
   */
  private readonly reactiveMaterials: PBRMaterial[] = [];
  private readonly reactiveBaseEmissiveColors: Color3[] = [];
  private monsterSkinNormalTexture!: RawTexture;
  private hitFlashRemaining = 0;
  private hitFlashDuration = 0;
  private hitFlashColor = Color3.Black();
  private hitFlashActive = false;
  private readonly jumpOffset = Vector3.Zero();

  /**
   * 달리기 애니메이션이 계산한 실제 도약 높이입니다.
   * modelRoot만 움직이지 않고 히트박스와 외형 전체를 들어 올립니다.
   */
  private currentRunJumpHeight = 0;

  /**
   * 실제 이동 거리를 기준으로 누적하는 질주 위상입니다.
   * 피격이나 난이도로 속도가 달라져도 발놀림과 전진 속도가 어긋나지 않습니다.
   */
  private gaitPhase = 0;

  private currentRunSpeed = 0;

  private randomSpeedMultiplier = 1;
  private randomSpeedStartMultiplier = 1;
  private randomSpeedTargetMultiplier = 1;
  private randomSpeedElapsed = 0;
  private randomSpeedDuration = 1;

  private attackElapsed = 0;
  private isJumpAttacking = false;

  /**
   * 차량으로부터 도로 중심선을 따라 떨어진 거리입니다.
   */
  private forwardDistance: number;

  /**
   * 몬스터의 자연스러운 좌우 이동 상태입니다.
   *
   * 일정한 사인파 대신 매 구간마다 목표 위치,
   * 이동 시간, 잠시 머무는 시간을 무작위로 정합니다.
   */
  private naturalLateralOffset = 0;
  private currentLateralOffset = 0;

  private swayStartOffset = 0;
  private swayTargetOffset = 0;

  private swayElapsedTime = 0;
  private swayDuration = 1;
  private swayHoldRemaining = 0;

  /**
   * 양수면 차량에서 멀어지고,
   * 음수면 차량 방향으로 밀립니다.
   */
  private knockbackVelocity = 0;

  private lateralKnockbackVelocity = 0;
  private lateralKnockbackOffset = 0;

  private hitStunRemaining = 0;
  private hitTilt = 0;
  private hitSquash = 0;

  private hitReactionElapsed = 0;
  private hitReactionDuration = 0;
  private hitReactionStrength = 0;

  private currentDifficultyMultiplier = 1;

  private difficultySettings: MonsterDifficultySettings = {
    approachSpeedMultiplier: 1,
    speedIncreaseMultiplier: 1,
    maximumTimeSpeedMultiplier: 1.8,
  };

  public constructor(
    scene: Scene,
    config: MonsterControllerConfig,
    road: RoadController,
  ) {
    this.scene = scene;
    this.config = config;
    this.road = road;

    this.forwardDistance = config.startPosition.z;

    this.mesh = this.createMesh();

    this.applyRoadPose(0);
  }

  private createMesh(): Mesh {
    /**
     * 실제 사격 판정은 단순한 투명 박스로 유지합니다.
     * 팔다리 사이로 총알이 빠지는 문제를 줄여줍니다.
     */
    const hitbox = MeshBuilder.CreateBox(
      "monster",
      {
        width: 2.35,
        height: 2.7,
        depth: 3.6,
      },
      this.scene,
    );

    hitbox.isPickable = true;

    hitbox.metadata = {
      kind: "monster",
    };

    const hitboxMaterial = new StandardMaterial(
      "monster-hitbox-material",
      this.scene,
    );

    hitboxMaterial.alpha = 0;

    hitbox.material = hitboxMaterial;

    this.modelRoot = new TransformNode("monster-model-root", this.scene);

    this.modelRoot.parent = hitbox;
    this.modelRoot.position.y = -0.08;

    this.monsterSkinNormalTexture = this.createMonsterSkinNormalTexture();

    const skinMaterial = this.createMonsterMaterial(
      "monster-skin-material",
      new Color3(0.17, 0.065, 0.032),
      new Color3(0.012, 0.002, 0.001),
      true,
    );

    const dirtySkinMaterial = this.createMonsterMaterial(
      "monster-dirty-skin-material",
      new Color3(0.025, 0.012, 0.009),
      new Color3(0.002, 0.0005, 0.0004),
      true,
    );

    const crustMaterial = this.createMonsterMaterial(
      "monster-crust-material",
      new Color3(0.085, 0.018, 0.012),
      new Color3(0.003, 0.0004, 0),
      true,
    );

    const ochreMaterial = this.createMonsterMaterial(
      "monster-ochre-grime-material",
      new Color3(0.31, 0.145, 0.038),
      new Color3(0.004, 0.0015, 0),
      true,
    );

    const mouthMaterial = this.createMonsterMaterial(
      "monster-mouth-material",
      new Color3(0.035, 0.004, 0.005),
      new Color3(0.02, 0, 0),
    );

    const clawMaterial = this.createMonsterMaterial(
      "monster-claw-material",
      new Color3(0.055, 0.045, 0.04),
      new Color3(0.003, 0.003, 0.003),
    );

    const eyeMaterial = this.createMonsterMaterial(
      "monster-eye-material",
      new Color3(0.22, 0.005, 0.003),
      new Color3(0.85, 0.015, 0.005),
    );

    this.torsoJoint = new TransformNode("monster-torso-joint", this.scene);

    this.torsoJoint.parent = this.modelRoot;

    this.torsoJoint.position.set(0, 0.08, -0.1);

    const ribCage = MeshBuilder.CreateSphere(
      "monster-rib-cage",
      {
        diameter: 1.6,
        segments: 7,
      },
      this.scene,
    );

    ribCage.parent = this.torsoJoint;

    ribCage.scaling.set(1.05, 0.72, 1.28);

    ribCage.material = skinMaterial;

    ribCage.isPickable = false;

    const abdomen = MeshBuilder.CreateCapsule(
      "monster-abdomen",
      {
        height: 1.55,
        radius: 0.5,
        tessellation: 7,
      },
      this.scene,
    );

    abdomen.parent = this.torsoJoint;

    abdomen.position.set(0, -0.08, -0.78);

    abdomen.rotation.x = Math.PI / 2;

    abdomen.scaling.set(0.88, 0.88, 1.15);

    abdomen.material = dirtySkinMaterial;

    abdomen.isPickable = false;

    const shoulderMass = MeshBuilder.CreateSphere(
      "monster-shoulder-mass",
      {
        diameter: 1.65,
        segments: 7,
      },
      this.scene,
    );

    shoulderMass.parent = this.torsoJoint;

    shoulderMass.position.z = 0.55;

    shoulderMass.scaling.set(1.18, 0.68, 0.72);

    shoulderMass.material = skinMaterial;

    shoulderMass.isPickable = false;

    /**
     * 에일리언과 유사한 뒤로 길게 늘어난 머리입니다.
     */
    this.headJoint = new TransformNode("monster-head-joint", this.scene);

    this.headJoint.parent = this.torsoJoint;

    this.headJoint.position.set(0, 0.27, 1.1);

    const cranium = MeshBuilder.CreateSphere(
      "monster-cranium",
      {
        diameter: 1.15,
        segments: 8,
      },
      this.scene,
    );

    cranium.parent = this.headJoint;

    cranium.position.z = -0.05;

    cranium.scaling.set(0.88, 0.7, 1.48);

    cranium.material = skinMaterial;

    cranium.isPickable = false;

    const rearCranium = MeshBuilder.CreateSphere(
      "monster-rear-cranium",
      {
        diameter: 0.95,
        segments: 7,
      },
      this.scene,
    );

    rearCranium.parent = this.headJoint;

    rearCranium.position.set(0, 0.04, -0.68);

    rearCranium.scaling.set(0.88, 0.72, 1.35);

    rearCranium.material = dirtySkinMaterial;

    rearCranium.isPickable = false;

    const muzzle = MeshBuilder.CreateSphere(
      "monster-muzzle",
      {
        diameter: 0.72,
        segments: 7,
      },
      this.scene,
    );

    muzzle.parent = this.headJoint;

    muzzle.position.set(0, -0.15, 0.72);

    muzzle.scaling.set(0.9, 0.55, 1.2);

    muzzle.material = skinMaterial;

    muzzle.isPickable = false;

    const mouth = MeshBuilder.CreateBox(
      "monster-mouth",
      {
        width: 0.54,
        height: 0.11,
        depth: 0.38,
      },
      this.scene,
    );

    mouth.parent = this.headJoint;

    mouth.position.set(0, -0.28, 1.03);

    mouth.material = mouthMaterial;

    mouth.isPickable = false;

    for (const side of [-1, 1]) {
      const eye = MeshBuilder.CreateSphere(
        `monster-eye-${side}`,
        {
          diameter: 0.15,
          segments: 8,
        },
        this.scene,
      );

      eye.parent = this.headJoint;

      eye.position.set(side * 0.25, 0.02, 0.55);

      eye.scaling.set(1, 0.55, 0.42);

      eye.material = eyeMaterial;

      eye.isPickable = false;
    }

    /**
     * 4족 보행용 관절 구조를 만듭니다.
     * 앞다리는 사람 팔처럼 길고, 뒷다리는 개처럼 접힙니다.
     */
    const frontLeft = this.createCreatureLimb(
      "front-left",
      -0.73,
      0.48,
      true,
      skinMaterial,
      dirtySkinMaterial,
      clawMaterial,
    );

    this.frontLeftLimb = frontLeft.upperJoint;

    this.frontLeftLower = frontLeft.lowerJoint;

    const frontRight = this.createCreatureLimb(
      "front-right",
      0.73,
      0.48,
      true,
      skinMaterial,
      dirtySkinMaterial,
      clawMaterial,
    );

    this.frontRightLimb = frontRight.upperJoint;

    this.frontRightLower = frontRight.lowerJoint;

    const rearLeft = this.createCreatureLimb(
      "rear-left",
      -0.66,
      -0.88,
      false,
      skinMaterial,
      dirtySkinMaterial,
      clawMaterial,
    );

    this.rearLeftLimb = rearLeft.upperJoint;

    this.rearLeftLower = rearLeft.lowerJoint;

    const rearRight = this.createCreatureLimb(
      "rear-right",
      0.66,
      -0.88,
      false,
      skinMaterial,
      dirtySkinMaterial,
      clawMaterial,
    );

    this.rearRightLimb = rearRight.upperJoint;

    this.rearRightLower = rearRight.lowerJoint;

    /**
     * 피부의 얼룩과 상처처럼 보이는 어두운 패치를 추가합니다.
     */
    const patchPositions = [
      new Vector3(-0.48, 0.34, 0.23),
      new Vector3(0.38, -0.22, 0.42),
      new Vector3(-0.32, 0.15, -0.88),
      new Vector3(0.27, 0.34, -0.38),
      new Vector3(-0.58, -0.08, 0.62),
      new Vector3(0.53, 0.18, 0.05),
      new Vector3(-0.42, -0.3, -0.48),
      new Vector3(0.46, 0.02, -0.92),
      new Vector3(-0.15, 0.47, 0.48),
      new Vector3(0.12, 0.45, -0.72),
    ];

    patchPositions.forEach((position, index) => {
      const patch = MeshBuilder.CreateSphere(
        `monster-dirt-patch-${index}`,
        {
          diameter: 0.32,
          segments: 5,
        },
        this.scene,
      );

      patch.parent = this.torsoJoint;

      patch.position.copyFrom(position);

      patch.scaling.set(
        0.9 + (index % 3) * 0.24,
        0.13 + (index % 2) * 0.07,
        0.72 + ((index + 1) % 4) * 0.12,
      );

      patch.material =
        index % 4 === 0
          ? ochreMaterial
          : index % 3 === 0
            ? crustMaterial
            : dirtySkinMaterial;

      patch.isPickable = false;
    });

    /**
     * 매끈한 구체 실루엣을 깨뜨리는 불규칙한 혹과 딱지입니다.
     * 위치와 크기를 고정된 수식으로 만들어 매 실행마다 형태가
     * 바뀌지 않도록 합니다.
     */
    this.createRoughSkinDetails(
      this.torsoJoint,
      "torso",
      crustMaterial,
      [
        new Vector3(-0.62, 0.28, 0.58),
        new Vector3(0.58, 0.18, 0.42),
        new Vector3(-0.5, -0.18, 0.16),
        new Vector3(0.54, -0.25, -0.08),
        new Vector3(-0.42, 0.36, -0.28),
        new Vector3(0.38, 0.42, -0.55),
        new Vector3(-0.3, -0.22, -0.82),
        new Vector3(0.34, -0.12, -1.03),
        new Vector3(-0.12, 0.48, 0.72),
        new Vector3(0.1, 0.5, -0.72),
      ],
      0.2,
    );

    this.createRoughSkinDetails(
      this.headJoint,
      "head",
      crustMaterial,
      [
        new Vector3(-0.38, 0.24, 0.18),
        new Vector3(0.36, 0.18, 0.12),
        new Vector3(-0.31, -0.08, -0.3),
        new Vector3(0.28, 0.28, -0.48),
        new Vector3(-0.16, 0.38, -0.72),
        new Vector3(0.18, -0.12, 0.52),
      ],
      0.15,
    );

    /**
     * 등뼈가 피부 밖으로 튀어나온 것처럼 작은 골판을 배치합니다.
     */
    for (let plateIndex = 0; plateIndex < 7; plateIndex += 1) {
      const plate = MeshBuilder.CreateSphere(
        `monster-back-plate-${plateIndex}`,
        {
          diameter: 0.18 + (plateIndex % 3) * 0.025,
          segments: 5,
        },
        this.scene,
      );

      plate.parent = this.torsoJoint;

      plate.position.set(
        Math.sin(plateIndex * 1.7) * 0.06,
        0.55,
        0.68 - plateIndex * 0.27,
      );

      plate.scaling.set(0.65, 1.35, 0.72);

      plate.material = crustMaterial;

      plate.isPickable = false;
      plate.convertToFlatShadedMesh();
    }

    return hitbox;
  }

  private createRoughSkinDetails(
    parent: TransformNode,
    name: string,
    material: PBRMaterial,
    positions: readonly Vector3[],
    baseDiameter: number,
  ): void {
    positions.forEach((position, index) => {
      const bump = MeshBuilder.CreateSphere(
        `monster-${name}-rough-${index}`,
        {
          diameter: baseDiameter * (0.78 + (index % 4) * 0.13),
          segments: 5,
        },
        this.scene,
      );

      bump.parent = parent;

      bump.position.copyFrom(position);

      bump.scaling.set(
        0.75 + (index % 3) * 0.18,
        0.46 + ((index + 1) % 4) * 0.13,
        0.72 + ((index + 2) % 3) * 0.16,
      );

      bump.rotation.set(index * 0.37, index * 0.61, index * 0.23);

      bump.material = material;
      bump.isPickable = false;

      bump.convertToFlatShadedMesh();
    });
  }

  private createMonsterMaterial(
    name: string,
    diffuseColor: Color3,
    emissiveColor: Color3,
    reactsToHit = false,
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);

    material.albedoColor = diffuseColor;

    material.emissiveColor = emissiveColor;

    material.metallic = 0;
    material.roughness = name.includes("eye") ? 0.28 : name.includes("claw") ? 0.7 : 0.93;
    material.environmentIntensity = name.includes("eye") ? 0.8 : 0.48;
    material.bumpTexture = this.monsterSkinNormalTexture;
    material.bumpTexture.level = name.includes("skin") ? 0.72 : 0.38;

    /**
     * 젖은 플라스틱처럼 보이는 광택을 줄이고,
     * 거칠고 마른 피부에 가깝게 만듭니다.
     */
    if (reactsToHit) {
      this.reactiveMaterials.push(material);
      this.reactiveBaseEmissiveColors.push(emissiveColor.clone());
    }

    return material;
  }

  private createMonsterSkinNormalTexture(): RawTexture {
    const size = 64;
    const heights = new Float32Array(size * size);
    const data = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const broadPores = Math.sin(x * 0.73) * Math.cos(y * 0.59) * 0.42;
        const finePores = Math.sin(x * 2.17 + y * 1.41) * 0.18;
        heights[y * size + x] = broadPores + finePores;
      }
    }

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const left = heights[y * size + ((x - 1 + size) % size)];
        const right = heights[y * size + ((x + 1) % size)];
        const top = heights[((y - 1 + size) % size) * size + x];
        const bottom = heights[((y + 1) % size) * size + x];
        const normal = new Vector3((left - right) * 1.7, (top - bottom) * 1.7, 1);
        normal.normalize();
        const index = (y * size + x) * 4;
        data[index] = Math.round((normal.x * 0.5 + 0.5) * 255);
        data[index + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
        data[index + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
        data[index + 3] = 255;
      }
    }

    const texture = RawTexture.CreateRGBATexture(
      data,
      size,
      size,
      this.scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    texture.name = "monster-skin-normal-texture";
    texture.uScale = 3.2;
    texture.vScale = 3.2;
    return texture;
  }

  private createCreatureLimb(
    name: string,
    x: number,
    z: number,
    isFront: boolean,
    skinMaterial: PBRMaterial,
    dirtySkinMaterial: PBRMaterial,
    clawMaterial: PBRMaterial,
  ): {
    upperJoint: TransformNode;
    lowerJoint: TransformNode;
  } {
    const sideDirection = x < 0 ? -1 : 1;

    const upperJoint = new TransformNode(
      `monster-${name}-upper-joint`,
      this.scene,
    );

    upperJoint.parent = this.torsoJoint;

    upperJoint.position.set(x, isFront ? -0.06 : -0.2, z);

    upperJoint.rotation.z = sideDirection * (isFront ? 0.15 : 0.1);

    const upperLimb = MeshBuilder.CreateCapsule(
      `monster-${name}-upper`,
      {
        height: isFront ? 1.32 : 1.18,
        radius: isFront ? 0.24 : 0.29,
        tessellation: 7,
      },
      this.scene,
    );

    upperLimb.parent = upperJoint;

    upperLimb.position.y = isFront ? -0.53 : -0.45;

    upperLimb.scaling.x = isFront ? 0.9 : 1.1;

    upperLimb.material = skinMaterial;

    upperLimb.isPickable = false;

    const lowerJoint = new TransformNode(
      `monster-${name}-lower-joint`,
      this.scene,
    );

    lowerJoint.parent = upperJoint;

    lowerJoint.position.y = isFront ? -1.02 : -0.9;

    const lowerLimb = MeshBuilder.CreateCapsule(
      `monster-${name}-lower`,
      {
        height: isFront ? 1.12 : 1.0,
        radius: isFront ? 0.19 : 0.22,
        tessellation: 7,
      },
      this.scene,
    );

    lowerLimb.parent = lowerJoint;

    lowerLimb.position.y = isFront ? -0.42 : -0.37;

    lowerLimb.material = dirtySkinMaterial;

    lowerLimb.isPickable = false;

    const foot = MeshBuilder.CreateSphere(
      `monster-${name}-foot`,
      {
        diameter: isFront ? 0.46 : 0.52,
        segments: 6,
      },
      this.scene,
    );

    foot.parent = lowerJoint;

    foot.position.set(0, isFront ? -0.92 : -0.82, isFront ? 0.16 : 0.22);

    foot.scaling.set(1.08, 0.5, 1.45);

    foot.material = dirtySkinMaterial;

    foot.isPickable = false;

    for (let clawIndex = -1; clawIndex <= 1; clawIndex += 1) {
      const claw = MeshBuilder.CreateCylinder(
        `monster-${name}-claw-${clawIndex}`,
        {
          height: 0.32,
          diameterTop: 0.025,
          diameterBottom: 0.09,
          tessellation: 6,
        },
        this.scene,
      );

      claw.parent = lowerJoint;

      claw.position.set(
        clawIndex * 0.12,
        isFront ? -0.94 : -0.84,
        isFront ? 0.48 : 0.56,
      );

      claw.rotation.x = Math.PI / 2;

      claw.material = clawMaterial;

      claw.isPickable = false;
    }

    return {
      upperJoint,
      lowerJoint,
    };
  }

  public update(deltaTime: number, elapsedTime: number): void {
    this.updateHitFlash(deltaTime);

    const proximity = clamp(
      (this.config.startPosition.z - this.forwardDistance) /
        (this.config.startPosition.z - this.config.dangerDistance),
      0,
      1,
    );

    const nearFactor = proximity * proximity;
    const farFactor = 1 - nearFactor;

    const timeSpeedMultiplier = Math.min(
      1 +
        elapsedTime *
          this.config.speedIncreasePerSecond *
          this.difficultySettings.speedIncreaseMultiplier,

      this.difficultySettings.maximumTimeSpeedMultiplier,
    );

    this.currentDifficultyMultiplier =
      this.difficultySettings.approachSpeedMultiplier * timeSpeedMultiplier;

    this.updateRandomSpeed(deltaTime);

    const distanceBasedSpeed = lerp(
      this.config.minApproachSpeed,
      this.config.maxApproachSpeed,
      smootherStep(farFactor),
    );

    const currentApproachSpeed =
      distanceBasedSpeed *
      this.currentDifficultyMultiplier *
      this.randomSpeedMultiplier;

    const currentSwaySpeed = lerp(
      this.config.minSwaySpeed,
      this.config.maxSwaySpeed,
      nearFactor,
    );

    this.hitStunRemaining = Math.max(0, this.hitStunRemaining - deltaTime);

    const isHitStunned = this.hitStunRemaining > 0;

    const approachMultiplier = isHitStunned
      ? this.config.hitStunApproachMultiplier
      : 1;

    if (
      !this.isJumpAttacking &&
      this.forwardDistance <= this.config.attackTriggerDistance &&
      !isHitStunned
    ) {
      this.isJumpAttacking = true;
      this.attackElapsed = 0;
    }

    if (this.isJumpAttacking) {
      this.attackElapsed = Math.min(
        this.attackElapsed + deltaTime,
        this.config.attackDuration,
      );

      /**
       * 한 번의 도약이 끝나면 공격 상태를 해제합니다.
       * 몬스터가 여전히 근접 범위에 있으면 다음 업데이트에서
       * 차량을 향한 새로운 도약이 다시 시작됩니다.
       */
      if (
        this.attackElapsed >=
        this.config.attackDuration
      ) {
        this.isJumpAttacking = false;
        this.attackElapsed = 0;
      }
    }

    const attackProgress = this.jumpAttackProgress;
    const attackLunge =
      this.isJumpAttacking
        ? Math.sin(Math.PI * clamp(attackProgress, 0, 1)) *
          this.config.attackLungeSpeed
        : 0;

    this.currentRunSpeed =
      currentApproachSpeed * approachMultiplier + attackLunge;

    this.forwardDistance -=
      this.currentRunSpeed * deltaTime;

    if (this.isJumpAttacking && attackProgress < 0.68) {
      this.forwardDistance = Math.max(
        this.forwardDistance,
        this.config.catchDistance,
      );
    }

    /**
     * Codex 수정본은 초당 3.8~8회의 지나치게 빠른 보행과
     * 별도의 느린 몸통 위상을 함께 사용해 다리는 떨리고
     * 몸은 미끄러지는 것처럼 보였습니다.
     *
     * 실제 이동 속도에 따라 보폭과 보행 횟수를 함께 조절하고,
     * 몸통 움직임은 gaitPhase 하나에 완전히 동기화합니다.
     */
    const speedRatio = clamp(
      (
        this.currentRunSpeed -
        this.config.minApproachSpeed
      ) /
        Math.max(
          0.001,
          this.config.maxApproachSpeed -
            this.config.minApproachSpeed,
        ),
      0,
      1,
    );

    const strideLength = lerp(
      3.1,
      4.35,
      speedRatio,
    );

    const gaitCyclesPerSecond = clamp(
      this.currentRunSpeed /
        strideLength,
      2.35,
      4.35,
    );

    this.gaitPhase =
      (
        this.gaitPhase +
        gaitCyclesPerSecond *
          deltaTime
      ) % 1;

    this.updateKnockback(deltaTime);

    this.updateSway(deltaTime, currentSwaySpeed, isHitStunned);

    this.applyRoadPose(deltaTime);
  }

  private updateRandomSpeed(deltaTime: number): void {
    this.randomSpeedElapsed += deltaTime;

    const progress = clamp(
      this.randomSpeedElapsed / this.randomSpeedDuration,
      0,
      1,
    );

    this.randomSpeedMultiplier = lerp(
      this.randomSpeedStartMultiplier,
      this.randomSpeedTargetMultiplier,
      smootherStep(progress),
    );

    if (progress < 1) {
      return;
    }

    this.randomSpeedStartMultiplier = this.randomSpeedMultiplier;
    this.randomSpeedTargetMultiplier = randomRange(0.82, 1.28);
    this.randomSpeedElapsed = 0;
    this.randomSpeedDuration = randomRange(0.55, 1.65);
  }

  private updateKnockback(deltaTime: number): void {
    if (Math.abs(this.knockbackVelocity) > 0.01) {
      this.forwardDistance += this.knockbackVelocity * deltaTime;

      this.knockbackVelocity *= Math.exp(
        -this.config.knockbackDrag * deltaTime,
      );
    } else {
      this.knockbackVelocity = 0;
    }

    if (Math.abs(this.lateralKnockbackVelocity) > 0.01) {
      this.lateralKnockbackOffset += this.lateralKnockbackVelocity * deltaTime;

      this.lateralKnockbackVelocity *= Math.exp(-5.2 * deltaTime);
    } else {
      this.lateralKnockbackVelocity = 0;
    }

    this.lateralKnockbackOffset *= Math.exp(-1.35 * deltaTime);

    this.forwardDistance = Math.min(
      this.forwardDistance,
      this.config.maxDistance,
    );
  }

  private updateSway(
    deltaTime: number,
    currentSwaySpeed: number,
    isHitStunned: boolean,
  ): void {
    const movementMultiplier = isHitStunned ? 0.28 : 1;

    const movementDeltaTime = deltaTime * movementMultiplier;

    if (this.swayHoldRemaining > 0) {
      this.swayHoldRemaining = Math.max(
        0,
        this.swayHoldRemaining - movementDeltaTime,
      );
    } else {
      this.swayElapsedTime += movementDeltaTime;

      const progress =
        this.swayDuration <= 0 ? 1 : this.swayElapsedTime / this.swayDuration;

      this.naturalLateralOffset = lerp(
        this.swayStartOffset,
        this.swayTargetOffset,
        smootherStep(progress),
      );

      if (progress >= 1) {
        this.naturalLateralOffset = this.swayTargetOffset;

        this.chooseNextSwayTarget(currentSwaySpeed);
      }
    }

    this.currentLateralOffset =
      this.config.startPosition.x +
      this.naturalLateralOffset +
      this.lateralKnockbackOffset;
  }

  private chooseNextSwayTarget(currentSwaySpeed: number): void {
    /**
     * 기존 swayAmount보다 약 95% 넓은 범위를 사용합니다.
     * 현재 2차선 도로의 가장자리 안쪽에 머무는 값입니다.
     */
    const maximumOffset = this.config.swayAmount * 1.95;

    const minimumTravelDistance = Math.max(1.35, maximumOffset * 0.3);

    let nextTarget = this.naturalLateralOffset;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      /**
       * 일정 확률로 도로 좌우 끝에 가까운 위치를 선택하고,
       * 나머지는 전체 범위에서 자유롭게 선택합니다.
       */
      const prefersOuterLane = Math.random() < 0.52;

      const candidate = prefersOuterLane
        ? (Math.random() < 0.5 ? -1 : 1) *
          randomRange(maximumOffset * 0.62, maximumOffset)
        : randomRange(-maximumOffset, maximumOffset);

      if (
        Math.abs(candidate - this.naturalLateralOffset) >= minimumTravelDistance
      ) {
        nextTarget = candidate;
        break;
      }

      nextTarget = candidate;
    }

    this.swayStartOffset = this.naturalLateralOffset;

    this.swayTargetOffset = clamp(nextTarget, -maximumOffset, maximumOffset);

    this.swayElapsedTime = 0;

    const travelDistance = Math.abs(
      this.swayTargetOffset - this.swayStartOffset,
    );

    /**
     * 몬스터가 가까워져 currentSwaySpeed가 커질수록
     * 같은 거리를 더 빠르게 횡단합니다.
     */
    const nominalDuration = travelDistance / Math.max(1.2, currentSwaySpeed);

    this.swayDuration = clamp(
      nominalDuration * randomRange(0.72, 1.48),
      0.42,
      2.05,
    );

    /**
     * 매 이동 후 잠깐 머물 수도 있고,
     * 바로 다음 방향으로 전환할 수도 있습니다.
     */
    this.swayHoldRemaining =
      Math.random() < 0.2 ? randomRange(0.08, 0.42) : randomRange(0, 0.07);
  }

  private applyRoadPose(deltaTime: number): void {
    const roadSample = this.road.sample(
      this.forwardDistance,
      this.currentLateralOffset,
      this.config.startPosition.y,
    );

    this.mesh.position.copyFrom(roadSample.position);

    this.hitTilt *= Math.exp(-10 * deltaTime);

    this.hitSquash *= Math.exp(-14 * deltaTime);

    const animationIntensity = this.hitStunRemaining > 0 ? 0.3 : 1;

    /**
     * 전신이 좌우로 굴러 보이지 않도록 롤링은 매우 작게 유지합니다.
     * 무게감은 관절의 착지와 몸통 압축으로 표현합니다.
     */
    /**
     * 보행 자체로 전신이 좌우 회전하면 공처럼 굴러 보이므로
     * 달리기 롤링은 제거합니다. 방향 전환 기울기는 모델 내부에서
     * 별도로 처리됩니다.
     */
    const runTilt = 0;

    this.updateCreatureAnimation(animationIntensity);
    this.updateHitReaction(deltaTime);
    this.updateJumpAttackPose();

    /**
     * 기존에는 modelRoot 내부만 0.3m 정도 움직여
     * 몸이 실제로 뜨지 않고 구르는 것처럼 보였습니다.
     *
     * 이번에는 투명 히트박스와 외형 전체를 도로의 up 방향으로
     * 들어 올려 발 네 개가 모두 지면에서 떨어지는 도약을 만듭니다.
     */
    roadSample.up.scaleToRef(
      this.currentRunJumpHeight,
      this.jumpOffset,
    );
    this.mesh.position.addInPlace(this.jumpOffset);

    /**
     * 몬스터는 차량 뒤쪽에서 실제 주행 방향으로
     * 달려오기 때문에 도로 뒤쪽 tangent의 반대 방향을
     * 바라보게 합니다.
     */
    this.mesh.rotation.x = -roadSample.pitch;

    this.mesh.rotation.y = roadSample.yaw + Math.PI;

    this.mesh.rotation.z = runTilt + this.hitTilt - roadSample.roll * 0.35;

    this.mesh.scaling.x = 1 + this.hitSquash * 0.32;

    this.mesh.scaling.y = 1 - this.hitSquash * 0.72;

    this.mesh.scaling.z = 1 + this.hitSquash * 0.32;
  }

  private updateCreatureAnimation(
    intensity: number,
  ): void {
    /**
     * 한 사이클의 순서:
     *
     * 오른쪽 앞발 이탈
     * → 왼쪽 앞발 이탈
     * → 양쪽 뒷발 동시 추진
     * → 네 발이 모두 뜨는 공중 구간
     * → 양쪽 뒷발 착지
     * → 왼쪽 앞발 착지
     * → 오른쪽 앞발 착지
     *
     * 모든 관절과 몸통은 같은 gaitPhase를 사용하므로
     * 발과 몸이 서로 다른 속도로 움직이지 않습니다.
     */
    const cycle = this.gaitPhase;

    type LimbPose = {
      phase: number;
      upper: number;
      lower: number;
      lift: number;
    };

    const samplePose = (
      keyframes: readonly LimbPose[],
    ): Omit<LimbPose, "phase"> => {
      for (
        let index = 0;
        index < keyframes.length - 1;
        index += 1
      ) {
        const from = keyframes[index];
        const to = keyframes[index + 1];

        if (
          cycle < from.phase ||
          cycle > to.phase
        ) {
          continue;
        }

        const amount =
          smootherStep(
            clamp(
              (
                cycle -
                from.phase
              ) /
                Math.max(
                  0.0001,
                  to.phase -
                    from.phase,
                ),
              0,
              1,
            ),
          );

        return {
          upper: lerp(
            from.upper,
            to.upper,
            amount,
          ),
          lower: lerp(
            from.lower,
            to.lower,
            amount,
          ),
          lift: lerp(
            from.lift,
            to.lift,
            amount,
          ),
        };
      }

      const fallback =
        keyframes[
          keyframes.length - 1
        ];

      return {
        upper: fallback.upper,
        lower: fallback.lower,
        lift: fallback.lift,
      };
    };

    const pulse = (
      center: number,
      width: number,
    ): number =>
      smootherStep(
        clamp(
          1 -
            Math.abs(
              cycle - center,
            ) /
              width,
          0,
          1,
        ),
      ) *
      intensity;

    /**
     * 오른쪽 앞발은 먼저 떨어지고 마지막에 착지합니다.
     */
    const frontRight =
      samplePose([
        {
          phase: 0,
          upper: -0.12,
          lower: 0.14,
          lift: 0,
        },
        {
          phase: 0.05,
          upper: 0.18,
          lower: 0.5,
          lift: 0.04,
        },
        {
          phase: 0.13,
          upper: 0.62,
          lower: 1.22,
          lift: 0.18,
        },
        {
          phase: 0.43,
          upper: 0.05,
          lower: 1.38,
          lift: 0.22,
        },
        {
          phase: 0.69,
          upper: -0.95,
          lower: 0.44,
          lift: 0.14,
        },
        {
          phase: 0.8,
          upper: -1.12,
          lower: 0.08,
          lift: 0.035,
        },
        {
          phase: 0.86,
          upper: -0.48,
          lower: -0.04,
          lift: 0,
        },
        {
          phase: 1,
          upper: -0.12,
          lower: 0.14,
          lift: 0,
        },
      ]);

    /**
     * 왼쪽 앞발은 조금 늦게 떨어지고 오른쪽보다 먼저 착지합니다.
     */
    const frontLeft =
      samplePose([
        {
          phase: 0,
          upper: -0.26,
          lower: 0.08,
          lift: 0,
        },
        {
          phase: 0.11,
          upper: -0.06,
          lower: 0.28,
          lift: 0.02,
        },
        {
          phase: 0.19,
          upper: 0.58,
          lower: 1.18,
          lift: 0.18,
        },
        {
          phase: 0.45,
          upper: 0.02,
          lower: 1.34,
          lift: 0.22,
        },
        {
          phase: 0.62,
          upper: -0.9,
          lower: 0.42,
          lift: 0.13,
        },
        {
          phase: 0.71,
          upper: -1.08,
          lower: 0.06,
          lift: 0.03,
        },
        {
          phase: 0.77,
          upper: -0.45,
          lower: -0.03,
          lift: 0,
        },
        {
          phase: 1,
          upper: -0.26,
          lower: 0.08,
          lift: 0,
        },
      ]);

    /**
     * 두 뒷발은 같은 키프레임을 사용해 동시에 웅크리고,
     * 지면을 밀고, 접히고, 착지합니다.
     */
    const rear =
      samplePose([
        {
          phase: 0,
          upper: 0.25,
          lower: -0.12,
          lift: 0,
        },
        {
          phase: 0.14,
          upper: 0.58,
          lower: 0.22,
          lift: 0,
        },
        {
          phase: 0.24,
          upper: -0.62,
          lower: -0.08,
          lift: 0.06,
        },
        {
          phase: 0.35,
          upper: 0.5,
          lower: -1.28,
          lift: 0.23,
        },
        {
          phase: 0.49,
          upper: 0.78,
          lower: -1.08,
          lift: 0.22,
        },
        {
          phase: 0.59,
          upper: 0.72,
          lower: -0.36,
          lift: 0.09,
        },
        {
          phase: 0.65,
          upper: 0.38,
          lower: 0.12,
          lift: 0,
        },
        {
          phase: 1,
          upper: 0.25,
          lower: -0.12,
          lift: 0,
        },
      ]);

    const flightStart = 0.255;
    const flightEnd = 0.64;

    const flightProgress =
      clamp(
        (
          cycle -
          flightStart
        ) /
          (
            flightEnd -
            flightStart
          ),
        0,
        1,
      );

    const jumpArc =
      (
        cycle >= flightStart &&
        cycle <= flightEnd
          ? Math.sin(
            Math.PI *
              flightProgress,
          )
          : 0
      ) *
      intensity;

    const speedRatio = clamp(
      (
        this.currentRunSpeed -
        this.config.minApproachSpeed
      ) /
        Math.max(
          0.001,
          this.config.maxApproachSpeed -
            this.config.minApproachSpeed,
        ),
      0,
      1,
    );

    const jumpHeight =
      lerp(
        0.43,
        0.62,
        speedRatio,
      );

    const crouch =
      pulse(
        0.18,
        0.12,
      );

    const rearImpact =
      pulse(
        0.65,
        0.045,
      );

    const leftFrontImpact =
      pulse(
        0.77,
        0.04,
      );

    const rightFrontImpact =
      pulse(
        0.86,
        0.04,
      );

    const frontImpact =
      leftFrontImpact *
        0.6 +
      rightFrontImpact *
        0.78;

    /**
     * 선행 앞발이 지면을 짚을 때 어깨와 흉곽이 착지한 쪽으로
     * 아주 조금 따라 돌아갑니다. 펄스가 짧게 끝나므로 몸 전체가
     * 좌우로 흔들리지 않고 발을 딛는 순간에만 무게가 실립니다.
     */
    const torsoStepTwist =
      clamp(
        (
          rightFrontImpact -
          leftFrontImpact
        ) *
          0.075 *
          intensity,
        -0.07,
        0.07,
      );

    /**
     * 도약은 히트박스와 외형 전체에 적용합니다.
     * 착지 충격은 내부 모델을 눌러 지면 아래로 잠기는 현상을 막습니다.
     */
    this.currentRunJumpHeight =
      jumpArc *
      jumpHeight;

    this.modelRoot.position.y =
      -0.11 -
      crouch * 0.085 -
      rearImpact * 0.06 -
      frontImpact * 0.045 -
      this.hitSquash * 0.16;

    this.modelRoot.position.z =
      -0.04 +
      jumpArc * 0.17 -
      crouch * 0.075;

    this.modelRoot.scaling.set(
      1,
      1,
      1,
    );

    this.torsoJoint.position.y =
      0.08 -
      crouch * 0.09 -
      rearImpact * 0.055 -
      frontImpact * 0.04;

    this.torsoJoint.position.z =
      -0.1 +
      jumpArc * 0.15 -
      crouch * 0.085;

    this.torsoJoint.scaling.set(
      1 +
        crouch * 0.025,
      1 -
        crouch * 0.095 -
        rearImpact * 0.06 -
        frontImpact * 0.045,
      1 +
        jumpArc * 0.12 -
        crouch * 0.06,
    );

    /**
     * 몸통은 앞뒤로 굽혔다 펴지만 좌우로 굴리지 않습니다.
     */
    this.torsoJoint.rotation.x =
      0.075 +
      crouch * 0.12 -
      jumpArc * 0.105 +
      rearImpact * 0.07 +
      frontImpact * 0.05;

    this.headJoint.rotation.x =
      -0.15 -
      crouch * 0.04 +
      jumpArc * 0.11 -
      rearImpact * 0.08 -
      frontImpact * 0.055;

    this.headJoint.rotation.y =
      (
        frontRight.lift -
        frontLeft.lift
      ) *
      0.035 *
      intensity -
      torsoStepTwist * 0.45;

    this.frontRightLimb.rotation.x =
      frontRight.upper *
      intensity;

    this.frontLeftLimb.rotation.x =
      frontLeft.upper *
      intensity;

    this.frontRightLower.rotation.x =
      frontRight.lower *
      intensity;

    this.frontLeftLower.rotation.x =
      frontLeft.lower *
      intensity;

    this.frontRightLimb.position.y =
      -0.06 +
      frontRight.lift *
        intensity;

    this.frontLeftLimb.position.y =
      -0.06 +
      frontLeft.lift *
        intensity;

    this.rearRightLimb.rotation.x =
      rear.upper *
      intensity;

    this.rearLeftLimb.rotation.x =
      rear.upper *
      intensity;

    this.rearRightLower.rotation.x =
      rear.lower *
      intensity;

    this.rearLeftLower.rotation.x =
      rear.lower *
      intensity;

    this.rearRightLimb.position.y =
      -0.2 +
      rear.lift *
        intensity;

    this.rearLeftLimb.position.y =
      -0.2 +
      rear.lift *
        intensity;

    const sideLean =
      clamp(
        (
          this.swayTargetOffset -
          this.naturalLateralOffset
        ) * 0.014,
        -0.05,
        0.05,
      );

    this.modelRoot.rotation.x =
      -jumpArc * 0.055 +
      rearImpact * 0.035 +
      frontImpact * 0.025;

    this.modelRoot.rotation.z =
      -sideLean +
      this.hitTilt * 0.18;

    /**
     * 앞발의 비대칭 순서에 따른 아주 작은 어깨 비틀림만 남깁니다.
     * 이 값을 크게 하면 다시 공처럼 구르는 인상이 생깁니다.
     */
    this.torsoJoint.rotation.z =
      -sideLean * 0.24 +
      (
        frontRight.lift -
        frontLeft.lift
      ) *
        0.025 *
        intensity;

    this.torsoJoint.rotation.y =
      torsoStepTwist;
  }

  /**
   * 피격 시 다리를 몸 안쪽으로 접고 뒤로 말렸다가 다시 지면을 짚습니다.
   * 실제 전진 위치는 기존 넉백이 담당하고 이 메서드는 외형 포즈만 담당합니다.
   */
  private updateHitReaction(deltaTime: number): void {
    if (
      this.hitReactionDuration <= 0 ||
      this.hitReactionElapsed >= this.hitReactionDuration
    ) {
      return;
    }

    this.hitReactionElapsed = Math.min(
      this.hitReactionElapsed + deltaTime,
      this.hitReactionDuration,
    );

    const progress = this.hitReactionElapsed / this.hitReactionDuration;
    const curlEnvelope = Math.sin(Math.PI * progress);
    const curl = smootherStep(curlEnvelope) * this.hitReactionStrength;
    const rollProgress = smootherStep(clamp(progress / 0.78, 0, 1));
    const recoveryProgress = smootherStep(
      clamp((progress - 0.72) / 0.28, 0, 1),
    );
    const backwardRoll =
      Math.sin(Math.PI * rollProgress) *
      (1 - recoveryProgress * 0.35) *
      this.hitReactionStrength;

    this.frontLeftLimb.rotation.x += curl * 0.72;
    this.frontRightLimb.rotation.x += curl * 0.72;
    this.frontLeftLower.rotation.x += curl * 1.05;
    this.frontRightLower.rotation.x += curl * 1.05;

    this.rearLeftLimb.rotation.x += curl * 0.88;
    this.rearRightLimb.rotation.x += curl * 0.88;
    this.rearLeftLower.rotation.x -= curl * 1.12;
    this.rearRightLower.rotation.x -= curl * 1.12;

    this.frontLeftLimb.position.y += curl * 0.2;
    this.frontRightLimb.position.y += curl * 0.2;
    this.rearLeftLimb.position.y += curl * 0.23;
    this.rearRightLimb.position.y += curl * 0.23;

    this.modelRoot.position.y += curlEnvelope * 0.2 * this.hitReactionStrength;
    this.modelRoot.position.z -= curl * 0.16;
    this.modelRoot.rotation.x -= backwardRoll * 1.65;

    this.torsoJoint.rotation.x += curl * 0.28;
    this.headJoint.rotation.x += curl * 0.42;
  }

  private startHitReaction(duration: number, strength: number): void {
    const isReactionActive =
      this.hitReactionElapsed < this.hitReactionDuration;

    this.hitReactionElapsed = 0;
    this.hitReactionDuration = isReactionActive
      ? Math.max(this.hitReactionDuration, duration)
      : duration;
    this.hitReactionStrength = isReactionActive
      ? Math.max(this.hitReactionStrength, strength)
      : strength;
  }

  private updateJumpAttackPose(): void {
    if (!this.isJumpAttacking) {
      return;
    }

    const progress = this.jumpAttackProgress;
    const leapArc = Math.sin(Math.PI * progress);
    const launch = smootherStep(clamp(progress / 0.28, 0, 1));
    const reach = smootherStep(clamp((progress - 0.18) / 0.34, 0, 1));
    const landing = smootherStep(clamp((progress - 0.68) / 0.32, 0, 1));
    const attackPose = Math.min(reach, 1 - landing * 0.82);
    const screenRush = smootherStep(
      clamp((progress - 0.46) / 0.42, 0, 1),
    );

    this.currentRunJumpHeight += leapArc * 1.72;

    this.modelRoot.position.y += leapArc * 0.24;
    this.modelRoot.position.z += launch * 0.38 + screenRush * 0.34;
    this.modelRoot.scaling.setAll(1 + screenRush * 0.58);
    this.modelRoot.rotation.x +=
      -launch * 0.16 + attackPose * 0.31 - landing * 0.18;

    this.torsoJoint.scaling.z += attackPose * 0.13;
    this.torsoJoint.rotation.x += attackPose * 0.22;
    this.headJoint.rotation.x -= attackPose * 0.48;

    this.frontLeftLimb.rotation.x =
      lerp(this.frontLeftLimb.rotation.x, -1.08, attackPose);
    this.frontRightLimb.rotation.x =
      lerp(this.frontRightLimb.rotation.x, -1.08, attackPose);
    this.frontLeftLower.rotation.x =
      lerp(this.frontLeftLower.rotation.x, -0.12, attackPose);
    this.frontRightLower.rotation.x =
      lerp(this.frontRightLower.rotation.x, -0.12, attackPose);

    const rearTuck = Math.sin(Math.PI * progress) * 0.92;

    this.rearLeftLimb.rotation.x += rearTuck;
    this.rearRightLimb.rotation.x += rearTuck;
    this.rearLeftLower.rotation.x -= rearTuck * 1.15;
    this.rearRightLower.rotation.x -= rearTuck * 1.15;
    this.rearLeftLimb.position.y += rearTuck * 0.18;
    this.rearRightLimb.position.y += rearTuck * 0.18;
  }

  private get jumpAttackProgress(): number {
    if (!this.isJumpAttacking || this.config.attackDuration <= 0) {
      return 0;
    }

    return clamp(this.attackElapsed / this.config.attackDuration, 0, 1);
  }

  public applyBulletHit(): void {
    this.knockbackVelocity = Math.min(
      this.knockbackVelocity + this.config.bulletKnockbackImpulse,

      this.config.maxKnockbackVelocity,
    );

    this.hitStunRemaining = this.config.hitStunDuration;

    const tiltDirection = Math.random() < 0.5 ? -1 : 1;

    this.hitTilt = tiltDirection * 0.24;

    this.hitSquash = 0.16;
    this.startHitReaction(0.46, 0.72);
    this.flashHitColor(new Color3(0.95, 0.075, 0.025), 95);
  }

  public applyGrenadeExplosion(
    explosionPosition: Vector3,
    explosionRadius: number,
    maximumKnockbackImpulse: number,
    maximumLateralImpulse: number,
  ): boolean {
    const offset = this.mesh.position.subtract(explosionPosition);

    const horizontalDistance = Math.hypot(offset.x, offset.z);

    if (horizontalDistance > explosionRadius) {
      return false;
    }

    const falloff = Math.max(0.18, 1 - horizontalDistance / explosionRadius);

    let direction = new Vector3(offset.x, 0, offset.z);

    if (direction.lengthSquared() < 0.0001) {
      direction = new Vector3(Math.random() < 0.5 ? -0.3 : 0.3, 0, 1);
    }

    direction.normalize();

    const roadSample: RoadSample = this.road.sample(this.forwardDistance);

    const alongDirection = Vector3.Dot(
      direction,
      new Vector3(roadSample.tangent.x, 0, roadSample.tangent.z).normalize(),
    );

    const lateralDirection = Vector3.Dot(direction, roadSample.right);

    this.knockbackVelocity = clamp(
      this.knockbackVelocity +
        alongDirection * maximumKnockbackImpulse * falloff,

      -this.config.maxKnockbackVelocity,

      this.config.maxKnockbackVelocity,
    );

    this.lateralKnockbackVelocity +=
      lateralDirection * maximumLateralImpulse * falloff;

    this.hitStunRemaining = Math.max(this.hitStunRemaining, 0.32);

    this.hitTilt = lateralDirection * 0.45;

    this.hitSquash = 0.3;
    this.startHitReaction(0.72, 1);

    this.flashHitColor(new Color3(1, 0.52, 0.04), 150);

    return true;
  }

  private flashHitColor(color: Color3, duration = 90): void {
    this.hitFlashDuration = Math.max(0.001, duration / 1000);
    this.hitFlashRemaining = this.hitFlashDuration;
    this.hitFlashColor.copyFrom(color);
    this.hitFlashActive = true;
  }

  private updateHitFlash(deltaTime: number): void {
    if (!this.hitFlashActive) {
      return;
    }

    this.hitFlashRemaining = Math.max(0, this.hitFlashRemaining - deltaTime);
    const intensity = this.hitFlashDuration > 0
      ? smootherStep(this.hitFlashRemaining / this.hitFlashDuration)
      : 0;

    for (let index = 0; index < this.reactiveMaterials.length; index += 1) {
      const material = this.reactiveMaterials[index];
      const baseColor = this.reactiveBaseEmissiveColors[index];

      if (!baseColor) {
        continue;
      }

      Color3.LerpToRef(
        baseColor,
        this.hitFlashColor,
        intensity,
        material.emissiveColor,
      );
    }

    if (this.hitFlashRemaining <= 0) {
      this.hitFlashActive = false;
    }
  }

  public setDifficulty(settings: MonsterDifficultySettings): void {
    this.difficultySettings = {
      ...settings,
    };

    this.currentDifficultyMultiplier = settings.approachSpeedMultiplier;
  }

  public reset(): void {
    this.forwardDistance = this.config.startPosition.z;

    this.naturalLateralOffset = 0;
    this.currentLateralOffset = this.config.startPosition.x;

    this.swayStartOffset = 0;
    this.swayTargetOffset = 0;
    this.swayElapsedTime = 0;
    this.swayDuration = 1;
    this.swayHoldRemaining = 0;

    this.knockbackVelocity = 0;
    this.lateralKnockbackVelocity = 0;
    this.lateralKnockbackOffset = 0;

    this.hitStunRemaining = 0;
    this.hitTilt = 0;
    this.hitSquash = 0;
    this.hitReactionElapsed = 0;
    this.hitReactionDuration = 0;
    this.hitReactionStrength = 0;
    this.hitFlashRemaining = 0;
    this.hitFlashDuration = 0;
    this.hitFlashActive = true;
    this.updateHitFlash(0);

    this.currentDifficultyMultiplier =
      this.difficultySettings.approachSpeedMultiplier;

    this.mesh.rotation.set(0, 0, 0);

    this.mesh.scaling.set(1, 1, 1);

    this.currentRunJumpHeight = 0;
    this.gaitPhase = 0;
    this.currentRunSpeed = 0;
    this.randomSpeedMultiplier = 1;
    this.randomSpeedStartMultiplier = 1;
    this.randomSpeedTargetMultiplier = randomRange(0.82, 1.28);
    this.randomSpeedElapsed = 0;
    this.randomSpeedDuration = randomRange(0.55, 1.65);
    this.attackElapsed = 0;
    this.isJumpAttacking = false;

    this.modelRoot.position.set(0, -0.11, -0.04);

    this.modelRoot.rotation.set(0, 0, 0);

    this.torsoJoint.position.set(0, 0.08, -0.1);

    this.torsoJoint.scaling.set(1, 1, 1);

    this.frontLeftLimb.position.y = -0.06;

    this.frontRightLimb.position.y = -0.06;

    this.rearLeftLimb.position.y = -0.2;

    this.rearRightLimb.position.y = -0.2;

    this.applyRoadPose(0);
  }

  public get distance(): number {
    return this.forwardDistance;
  }

  public get speedMultiplier(): number {
    return this.currentDifficultyMultiplier;
  }

  public get hasCaughtVehicle(): boolean {
    return (
      this.isJumpAttacking &&
      this.jumpAttackProgress >= 0.68 &&
      this.distance <= this.config.catchDistance
    );
  }
}
