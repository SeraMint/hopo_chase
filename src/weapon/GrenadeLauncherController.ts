import {
  Color3,
  Color4,
  GPUParticleSystem,
  LinesMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  PointLight,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";

import { RoadController } from "../world/RoadController";

export type GrenadeAimResult =
  | "started"
  | "alreadyAiming"
  | "cooldown"
  | "empty";

export type GrenadeFireResult =
  | "fired"
  | "notAiming"
  | "empty";

export interface GrenadeExplosionEvent {
  position: Vector3;
  radius: number;
  knockbackImpulse: number;
  lateralImpulse: number;
}

export interface GrenadeUpdateResult {
  explosions: GrenadeExplosionEvent[];
}

export interface GrenadeLauncherConfig {
  launchOrigin: {
    x: number;
    y: number;
    z: number;
  };

  defaultRangeFactor: number;
  rangeDragSensitivity: number;

  minHorizontalSpeed: number;
  maxHorizontalSpeed: number;

  minVerticalSpeed: number;
  maxVerticalSpeed: number;
  gravity: number;

  grenadeRadius: number;
  groundHeight: number;
  maximumFlightTime: number;

  cooldownDuration: number;
  initialAmmo: number;

  explosionRadius: number;
  explosionKnockbackImpulse: number;
  explosionLateralImpulse: number;

  guidePointCount: number;
  guideTimeStep: number;
}

interface ActiveGrenade {
  mesh: Mesh;
  origin: Vector3;
  initialVelocity: Vector3;
  elapsedTime: number;
}

interface ExplosionVisual {
  mesh: Mesh;
  material: StandardMaterial;
  shockwave: Mesh;
  shockwaveMaterial: StandardMaterial;
  smoke: Array<{
    mesh: Mesh;
    material: StandardMaterial;
    velocity: Vector3;
  }>;
  smokeParticles?: GPUParticleSystem;
  fragments: Array<{
    mesh: Mesh;
    velocity: Vector3;
    spin: Vector3;
  }>;
  fragmentMaterial: StandardMaterial;
  light: PointLight;
  elapsedTime: number;
  duration: number;
  radius: number;
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(
    Math.max(value, minimum),
    maximum,
  );
}

function lerp(
  from: number,
  to: number,
  amount: number,
): number {
  return from + (to - from) * amount;
}

export class GrenadeLauncherController {
  private readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly config:
    GrenadeLauncherConfig;

  private readonly road:
    RoadController;
  private readonly graphicsQuality: "low" | "medium" | "high";

  private readonly launchOrigin:
    Vector3;

  private readonly guidePoints:
    Vector3[];

  private readonly guideLine: LinesMesh;
  private readonly landingMarker: Mesh;

  private readonly grenadeMaterial:
    StandardMaterial;

  private readonly grenadeMetalMaterial:
    StandardMaterial;

  private readonly grenadeBandMaterial:
    StandardMaterial;

  private aiming = false;
  private cooldownRemainingTime = 0;
  private ammo: number;

  private pointerX = 0;
  private pointerY = 0;

  private aimStartNormalizedPointerY = 0.5;
  private rangeFactor: number;

  private aimVelocity = Vector3.Zero();
  private landingPosition = Vector3.Zero();
  private estimatedLandingDistanceValue = 0;

  private readonly activeGrenades:
    ActiveGrenade[] = [];

  private readonly grenadeMeshPool:
    Mesh[] = [];

  private readonly explosionVisuals:
    ExplosionVisual[] = [];

  private readonly explosionVisualPool:
    ExplosionVisual[] = [];

  private readonly explosionSmokeParticleTexture:
    RawTexture | null;

  public constructor(
    scene: Scene,
    camera: UniversalCamera,
    config: GrenadeLauncherConfig,
    road: RoadController,
    graphicsQuality: "low" | "medium" | "high" = "high",
  ) {
    this.scene = scene;
    this.camera = camera;
    this.config = config;
    this.road = road;
    this.graphicsQuality = graphicsQuality;
    this.explosionSmokeParticleTexture =
      GPUParticleSystem.IsSupported
        ? this.createExplosionSmokeParticleTexture()
        : null;
    this.ammo = config.initialAmmo;
    this.rangeFactor =
      config.defaultRangeFactor;

    this.launchOrigin = new Vector3(
      config.launchOrigin.x,
      config.launchOrigin.y,
      config.launchOrigin.z,
    );

    this.guidePoints = Array.from(
      { length: config.guidePointCount },
      () => this.launchOrigin.clone(),
    );

    this.grenadeMaterial =
      this.createGrenadeMaterial();

    this.grenadeMetalMaterial =
      this.createGrenadeMetalMaterial();

    this.grenadeBandMaterial =
      this.createGrenadeBandMaterial();

    this.guideLine =
      this.createGuideLine();

    this.landingMarker =
      this.createLandingMarker();

    this.setGuideVisible(false);
  }

  private createGrenadeMaterial():
    StandardMaterial {
    const material = new StandardMaterial(
      "grenade-material",
      this.scene,
    );

    material.diffuseColor = new Color3(
      0.12,
      0.16,
      0.1,
    );

    material.emissiveColor = new Color3(0.015, 0.02, 0.01);

    material.specularColor = new Color3(
      0.35,
      0.35,
      0.35,
    );

    return material;
  }

  private createGrenadeMetalMaterial(): StandardMaterial {
    const material = new StandardMaterial(
      "grenade-metal-material",
      this.scene,
    );

    material.diffuseColor = new Color3(0.1, 0.11, 0.09);
    material.specularColor = new Color3(0.65, 0.68, 0.62);

    return material;
  }

  private createGrenadeBandMaterial(): StandardMaterial {
    const material = new StandardMaterial(
      "grenade-band-material",
      this.scene,
    );

    material.diffuseColor = new Color3(0.55, 0.42, 0.12);
    material.specularColor = new Color3(0.8, 0.68, 0.28);

    return material;
  }

  private createGuideLine(): LinesMesh {
    const line = MeshBuilder.CreateLines(
      "grenade-trajectory-guide",
      {
        points: this.guidePoints,
        updatable: true,
      },
      this.scene,
    );

    line.color = new Color3(
      1,
      0.78,
      0.2,
    );

    line.alpha = 0.82;
    line.isPickable = false;

    return line;
  }

  private createLandingMarker(): Mesh {
    const marker = MeshBuilder.CreateTorus(
      "grenade-landing-marker",
      {
        diameter:
          this.config.explosionRadius * 2,
        thickness: 0.08,
        tessellation: 48,
      },
      this.scene,
    );

    marker.position.y =
      this.config.groundHeight + 0.05;

    marker.isPickable = false;

    const material = new StandardMaterial(
      "grenade-landing-marker-material",
      this.scene,
    );

    material.diffuseColor = new Color3(
      0.9,
      0.45,
      0.05,
    );

    material.emissiveColor = new Color3(
      0.7,
      0.24,
      0.02,
    );

    material.alpha = 0.62;
    material.disableLighting = true;

    marker.material = material;

    return marker;
  }

  public setAimPointer(
    pointerX: number,
    pointerY: number,
    normalizedPointerY: number,
  ): void {
    this.pointerX = pointerX;
    this.pointerY = pointerY;

    if (!this.aiming) {
      return;
    }

    const clampedPointerY = clamp(
      normalizedPointerY,
      0,
      1,
    );

    const dragDistance =
      this.aimStartNormalizedPointerY -
      clampedPointerY;

    this.rangeFactor = clamp(
      this.config.defaultRangeFactor +
        dragDistance *
          this.config
            .rangeDragSensitivity,
      0,
      1,
    );

    this.refreshGuide();
  }

  public beginAim(
    pointerX: number,
    pointerY: number,
    normalizedPointerY: number,
  ): GrenadeAimResult {
    if (this.aiming) {
      return "alreadyAiming";
    }

    if (this.ammo <= 0) {
      return "empty";
    }

    if (this.cooldownRemainingTime > 0) {
      return "cooldown";
    }

    this.pointerX = pointerX;
    this.pointerY = pointerY;

    this.aimStartNormalizedPointerY =
      clamp(
        normalizedPointerY,
        0,
        1,
      );

    this.rangeFactor =
      this.config.defaultRangeFactor;

    this.aiming = true;

    this.setGuideVisible(true);
    this.refreshGuide();

    return "started";
  }

  public releaseFire(): GrenadeFireResult {
    if (!this.aiming) {
      return "notAiming";
    }

    this.aiming = false;
    this.setGuideVisible(false);

    if (this.ammo <= 0) {
      return "empty";
    }

    this.ammo -= 1;

    this.updateLaunchOrigin();

    this.spawnGrenade(
      this.launchOrigin,
      this.aimVelocity,
    );

    this.cooldownRemainingTime =
      this.config.cooldownDuration;

    return "fired";
  }

  public cancelAim(): void {
    this.aiming = false;
    this.setGuideVisible(false);
  }

  public addAmmo(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }

    this.ammo += Math.floor(amount);
  }

  private spawnGrenade(
    origin: Vector3,
    velocity: Vector3,
  ): void {
    const mesh =
      this.grenadeMeshPool.pop() ??
      this.createGrenadeMesh();

    mesh.position.copyFrom(origin);
    mesh.rotation.set(0, 0, 0);
    mesh.setEnabled(true);

    this.activeGrenades.push({
      mesh,
      origin: origin.clone(),
      initialVelocity:
        velocity.clone(),
      elapsedTime: 0,
    });
  }

  private createGrenadeMesh(): Mesh {
    const name = `grenade-${Date.now()}`;
    const radius = this.config.grenadeRadius;
    const mesh = new Mesh(name, this.scene);

    const body = MeshBuilder.CreateCylinder(
      `${name}-body`,
      {
        height: radius * 1.45,
        diameter: radius * 1.25,
        tessellation: 12,
      },
      this.scene,
    );
    body.parent = mesh;
    body.position.y = -radius * 0.18;
    body.material = this.grenadeMaterial;
    body.isPickable = false;

    const nose = MeshBuilder.CreateCylinder(
      `${name}-nose`,
      {
        height: radius * 0.65,
        diameterBottom: radius * 1.25,
        diameterTop: radius * 0.52,
        tessellation: 12,
      },
      this.scene,
    );
    nose.parent = mesh;
    nose.position.y = radius * 0.82;
    nose.material = this.grenadeMaterial;
    nose.isPickable = false;

    const fuse = MeshBuilder.CreateCylinder(
      `${name}-fuse`,
      {
        height: radius * 0.18,
        diameter: radius * 0.48,
        tessellation: 10,
      },
      this.scene,
    );
    fuse.parent = mesh;
    fuse.position.y = radius * 1.22;
    fuse.material = this.grenadeMetalMaterial;
    fuse.isPickable = false;

    const base = MeshBuilder.CreateCylinder(
      `${name}-base`,
      {
        height: radius * 0.18,
        diameter: radius * 1.3,
        tessellation: 12,
      },
      this.scene,
    );
    base.parent = mesh;
    base.position.y = -radius * 0.98;
    base.material = this.grenadeMetalMaterial;
    base.isPickable = false;

    const band = MeshBuilder.CreateCylinder(
      `${name}-band`,
      {
        height: radius * 0.12,
        diameter: radius * 1.34,
        tessellation: 12,
      },
      this.scene,
    );
    band.parent = mesh;
    band.position.y = -radius * 0.72;
    band.material = this.grenadeBandMaterial;
    band.isPickable = false;

    mesh.isPickable = false;
    return mesh;
  }

  private releaseGrenadeMesh(mesh: Mesh): void {
    mesh.setEnabled(false);

    if (this.grenadeMeshPool.length < 4) {
      this.grenadeMeshPool.push(mesh);
      return;
    }

    mesh.dispose();
  }

  private updateLaunchOrigin(): void {
    this.launchOrigin.copyFrom(
      this.road.getLaunchOrigin(
        this.config.launchOrigin.z,
        this.config.launchOrigin.x,
        this.config.launchOrigin.y,
      ),
    );
  }

  private refreshGuide(): void {
    if (!this.aiming) {
      return;
    }

    this.updateLaunchOrigin();

    this.aimVelocity =
      this.calculateLaunchVelocity();

    this.calculateTrajectoryPoints(
      this.launchOrigin,
      this.aimVelocity,
    );

    MeshBuilder.CreateLines(
      "grenade-trajectory-guide",
      {
        points: this.guidePoints,
        instance: this.guideLine,
      },
      this.scene,
    );

    const finalPoint =
      this.guidePoints[
        this.guidePoints.length - 1
      ];

    this.landingPosition.copyFrom(
      finalPoint,
    );

    this.landingPosition.y =
      this.road.getGroundHeight(
        this.landingPosition,
      ) + 0.06;

    this.landingMarker.position.copyFrom(
      this.landingPosition,
    );

    const landingRoadSample =
      this.road.getNearestSample(
        this.landingPosition,
      );

    this.landingMarker.rotation.set(
      landingRoadSample.pitch,
      landingRoadSample.yaw,
      landingRoadSample.roll,
    );

    this.estimatedLandingDistanceValue =
      Math.hypot(
        this.landingPosition.x -
          this.launchOrigin.x,
        this.landingPosition.z -
          this.launchOrigin.z,
      );
  }

  private calculateLaunchVelocity():
    Vector3 {
    const ray = this.scene.createPickingRay(
      this.pointerX,
      this.pointerY,
      Matrix.Identity(),
      this.camera,
    );

    const horizontalDirection =
      new Vector3(
        ray.direction.x,
        0,
        ray.direction.z,
      );

    if (
      horizontalDirection.lengthSquared() <
      0.0001
    ) {
      horizontalDirection.set(
        0,
        0,
        1,
      );
    } else {
      horizontalDirection.normalize();
    }

    if (horizontalDirection.z < 0.08) {
      horizontalDirection.z = 0.08;
      horizontalDirection.normalize();
    }

    const horizontalSpeed = lerp(
      this.config.minHorizontalSpeed,
      this.config.maxHorizontalSpeed,
      this.rangeFactor,
    );

    const verticalSpeed = lerp(
      this.config.minVerticalSpeed,
      this.config.maxVerticalSpeed,
      this.rangeFactor,
    );

    const velocity =
      horizontalDirection.scale(
        horizontalSpeed,
      );

    velocity.y = verticalSpeed;

    return velocity;
  }

  private calculateTrajectoryPoints(
    origin: Vector3,
    initialVelocity: Vector3,
  ): void {
    let landingPointIndex = -1;

    for (
      let index = 0;
      index <
      this.config.guidePointCount;
      index += 1
    ) {
      const point = this.guidePoints[index];

      if (landingPointIndex >= 0) {
        point.copyFrom(
          this.guidePoints[landingPointIndex],
        );

        continue;
      }

      const time =
        index *
        this.config.guideTimeStep;

      this.sampleTrajectoryToRef(
        origin,
        initialVelocity,
        time,
        point,
      );

      const groundHeight =
        this.road.getGroundHeight(
          point,
        );

      if (
        point.y <= groundHeight
      ) {
        point.y = groundHeight;

        landingPointIndex = index;
      }
    }
  }

  private sampleTrajectoryToRef(
    origin: Vector3,
    initialVelocity: Vector3,
    time: number,
    result: Vector3,
  ): void {
    result.set(
      origin.x +
        initialVelocity.x * time,

      origin.y +
        initialVelocity.y * time -
        0.5 *
          this.config.gravity *
          time *
          time,

      origin.z +
        initialVelocity.z * time,
    );
  }

  private setGuideVisible(
    visible: boolean,
  ): void {
    this.guideLine.setEnabled(visible);
    this.landingMarker.setEnabled(
      visible,
    );
  }

  public update(
    deltaTime: number,
  ): GrenadeUpdateResult {
    this.cooldownRemainingTime =
      Math.max(
        0,
        this.cooldownRemainingTime -
          deltaTime,
      );

    if (this.aiming) {
      this.refreshGuide();
    }

    const explosions:
      GrenadeExplosionEvent[] = [];

    for (
      let index =
        this.activeGrenades.length - 1;
      index >= 0;
      index -= 1
    ) {
      const grenade =
        this.activeGrenades[index];

      grenade.elapsedTime += deltaTime;

      this.sampleTrajectoryToRef(
        grenade.origin,
        grenade.initialVelocity,
        grenade.elapsedTime,
        grenade.mesh.position,
      );

      grenade.mesh.rotation.x +=
        deltaTime * 9;

      grenade.mesh.rotation.z +=
        deltaTime * 6;

      const currentGroundHeight =
        this.road.getGroundHeight(
          grenade.mesh.position,
        );

      const touchedGround =
        grenade.mesh.position.y <=
        currentGroundHeight +
          this.config.grenadeRadius;

      const timedOut =
        grenade.elapsedTime >=
        this.config.maximumFlightTime;

      if (!touchedGround && !timedOut) {
        continue;
      }

      const explosionPosition =
        grenade.mesh.position.clone();

      explosionPosition.y =
        this.road.getGroundHeight(
          explosionPosition,
        );

      this.releaseGrenadeMesh(
        grenade.mesh,
      );

      this.activeGrenades.splice(
        index,
        1,
      );

      this.createExplosionVisual(
        explosionPosition,
      );

      explosions.push({
        position: explosionPosition,
        radius:
          this.config.explosionRadius,
        knockbackImpulse:
          this.config
            .explosionKnockbackImpulse,
        lateralImpulse:
          this.config
            .explosionLateralImpulse,
      });
    }

    this.updateExplosionVisuals(
      deltaTime,
    );

    return {
      explosions,
    };
  }

  private createExplosionVisual(
    position: Vector3,
  ): void {
    const pooledVisual = this.explosionVisualPool.pop();

    if (pooledVisual) {
      this.resetExplosionVisual(pooledVisual, position);
      this.explosionVisuals.push(pooledVisual);
      return;
    }

    const material = new StandardMaterial(
      `grenade-explosion-material-${Date.now()}`,
      this.scene,
    );

    material.diffuseColor = new Color3(
      1,
      0.28,
      0.03,
    );

    material.emissiveColor = new Color3(
      1,
      0.18,
      0.01,
    );

    material.alpha = 0.62;
    material.disableLighting = true;

    const mesh = MeshBuilder.CreateSphere(
      `grenade-explosion-${Date.now()}`,
      {
        diameter: 1,
        segments: 16,
      },
      this.scene,
    );

    mesh.position.copyFrom(position);
    mesh.position.y += 0.45;
    mesh.scaling.setAll(0.15);
    mesh.material = material;
    mesh.isPickable = false;

    const shockwaveMaterial = new StandardMaterial(
      `grenade-shockwave-material-${Date.now()}`,
      this.scene,
    );
    shockwaveMaterial.emissiveColor = new Color3(1, 0.46, 0.08);
    shockwaveMaterial.diffuseColor = new Color3(0.3, 0.08, 0.01);
    shockwaveMaterial.alpha = 0.72;
    shockwaveMaterial.disableLighting = true;

    const shockwave = MeshBuilder.CreateTorus(
      `grenade-shockwave-${Date.now()}`,
      { diameter: 1, thickness: 0.045, tessellation: 32 },
      this.scene,
    );
    shockwave.position.copyFrom(position);
    shockwave.position.y += 0.08;
    shockwave.scaling.setAll(0.2);
    shockwave.material = shockwaveMaterial;
    shockwave.isPickable = false;

    const fallbackSmokeCount = this.graphicsQuality === "low"
      ? 3
      : this.graphicsQuality === "medium"
        ? 5
        : 7;
    const smoke = GPUParticleSystem.IsSupported
      ? []
      : Array.from({ length: fallbackSmokeCount }, (_, smokeIndex) => {
      const smokeMaterial = new StandardMaterial(
        `grenade-smoke-material-${Date.now()}-${smokeIndex}`,
        this.scene,
      );
      smokeMaterial.diffuseColor = new Color3(0.075, 0.065, 0.055);
      smokeMaterial.emissiveColor = new Color3(0.015, 0.009, 0.004);
      smokeMaterial.alpha = 0.5;
      smokeMaterial.specularColor = Color3.Black();

      const smokeMesh = MeshBuilder.CreateSphere(
        `grenade-smoke-${Date.now()}-${smokeIndex}`,
        { diameter: 0.7 + (smokeIndex % 3) * 0.18, segments: 6 },
        this.scene,
      );
      const angle = (smokeIndex / fallbackSmokeCount) * Math.PI * 2;
      smokeMesh.position.copyFrom(position);
      smokeMesh.position.addInPlace(
        new Vector3(Math.cos(angle) * 0.35, 0.35 + (smokeIndex % 2) * 0.2, Math.sin(angle) * 0.35),
      );
      smokeMesh.scaling.setAll(0.15);
      smokeMesh.material = smokeMaterial;
      smokeMesh.isPickable = false;

      return {
        mesh: smokeMesh,
        material: smokeMaterial,
        velocity: new Vector3(
          Math.cos(angle) * (0.8 + (smokeIndex % 2) * 0.25),
          1.4 + (smokeIndex % 3) * 0.32,
          Math.sin(angle) * (0.8 + (smokeIndex % 2) * 0.25),
        ),
      };
        });

    const smokeParticleEffect = GPUParticleSystem.IsSupported
      ? this.createExplosionSmokeParticles(position)
      : undefined;

    if (smokeParticleEffect) {
      smokeParticleEffect.system.manualEmitCount = this.explosionSmokeParticleCount;
      smokeParticleEffect.system.start();
    }

    const fragmentMaterial = new StandardMaterial(
      `grenade-fragment-material-${Date.now()}`,
      this.scene,
    );
    fragmentMaterial.diffuseColor = new Color3(0.14, 0.11, 0.07);
    fragmentMaterial.emissiveColor = new Color3(0.32, 0.09, 0.01);

    const fragments = Array.from({ length: 12 }, (_, fragmentIndex) => {
      const fragment = MeshBuilder.CreateBox(
        `grenade-fragment-${Date.now()}-${fragmentIndex}`,
        { size: 0.1 + (fragmentIndex % 3) * 0.025 },
        this.scene,
      );
      const angle = (fragmentIndex / 12) * Math.PI * 2;
      const speed = 4.2 + (fragmentIndex % 4) * 0.8;
      fragment.position.copyFrom(position);
      fragment.position.y += 0.25;
      fragment.scaling.set(0.45, 0.18, 1.4);
      fragment.material = fragmentMaterial;
      fragment.isPickable = false;

      return {
        mesh: fragment,
        velocity: new Vector3(
          Math.cos(angle) * speed,
          2.8 + (fragmentIndex % 5) * 0.55,
          Math.sin(angle) * speed,
        ),
        spin: new Vector3(4 + fragmentIndex * 0.2, 6 + fragmentIndex * 0.15, 5),
      };
    });

    const light = new PointLight(
      `grenade-explosion-light-${Date.now()}`,
      position.add(new Vector3(0, 1.1, 0)),
      this.scene,
    );
    light.diffuse = new Color3(1, 0.24, 0.025);
    light.intensity = 42;
    light.range = this.config.explosionRadius * 2.8;

    this.explosionVisuals.push({
      mesh,
      material,
      shockwave,
      shockwaveMaterial,
      smoke,
      smokeParticles: smokeParticleEffect?.system,
      fragments,
      fragmentMaterial,
      light,
      elapsedTime: 0,
      duration: 0.88,
      radius:
        this.config.explosionRadius,
    });
  }

  private createExplosionSmokeParticleTexture(): RawTexture {
    const size = 48;
    const data = new Uint8Array(size * size * 4);
    const center = (size - 1) * 0.5;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4;
        const normalizedX = (x - center) / center;
        const normalizedY = (y - center) / center;
        const distance = Math.sqrt(normalizedX ** 2 + normalizedY ** 2);
        const edge = Math.max(0, 1 - distance);
        const turbulence = 0.78 + 0.22 * Math.sin(x * 0.71 + y * 1.13);
        const alpha = Math.max(0, edge * edge * turbulence);

        data[index] = 128;
        data[index + 1] = 116;
        data[index + 2] = 102;
        data[index + 3] = Math.round(alpha * 235);
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
    texture.name = "grenade-smoke-particle-texture";
    return texture;
  }

  private createExplosionSmokeParticles(position: Vector3): {
    system: GPUParticleSystem;
  } {
    if (!this.explosionSmokeParticleTexture) {
      throw new Error("Explosion smoke texture is not available.");
    }

    const system = new GPUParticleSystem(
      `grenade-smoke-particles-${Date.now()}`,
      { capacity: this.explosionSmokeParticleCount + 24 },
      this.scene,
    );
    system.particleTexture = this.explosionSmokeParticleTexture;
    system.emitter = position.add(new Vector3(0, 0.32, 0));
    system.minEmitBox = new Vector3(-0.28, 0, -0.28);
    system.maxEmitBox = new Vector3(0.28, 0.18, 0.28);
    system.direction1 = new Vector3(-1.35, 1.1, -1.35);
    system.direction2 = new Vector3(1.35, 2.7, 1.35);
    system.color1 = new Color4(0.16, 0.125, 0.095, 0.72);
    system.color2 = new Color4(0.055, 0.05, 0.046, 0.48);
    system.colorDead = new Color4(0.035, 0.035, 0.035, 0);
    system.minLifeTime = 0.5;
    system.maxLifeTime = 1.15;
    system.minSize = 0.34;
    system.maxSize = 1.55;
    system.minEmitPower = 1.2;
    system.maxEmitPower = 3.4;
    system.emitRate = 0;
    system.minAngularSpeed = -2.2;
    system.maxAngularSpeed = 2.2;
    system.gravity = new Vector3(0, 0.42, 0);
    system.targetStopDuration = 0.08;

    return { system };
  }

  private resetExplosionVisual(
    visual: ExplosionVisual,
    position: Vector3,
  ): void {
    visual.elapsedTime = 0;
    visual.mesh.position.copyFrom(position);
    visual.mesh.position.y += 0.45;
    visual.mesh.scaling.setAll(0.15);
    visual.mesh.setEnabled(true);
    visual.material.alpha = 0.62;

    visual.shockwave.position.copyFrom(position);
    visual.shockwave.position.y += 0.08;
    visual.shockwave.scaling.setAll(0.2);
    visual.shockwave.setEnabled(true);
    visual.shockwaveMaterial.alpha = 0.72;

    visual.smoke.forEach((smokePuff, smokeIndex) => {
      const angle = (smokeIndex / visual.smoke.length) * Math.PI * 2;
      smokePuff.mesh.position.copyFrom(position);
      smokePuff.mesh.position.addInPlace(
        new Vector3(Math.cos(angle) * 0.35, 0.35 + (smokeIndex % 2) * 0.2, Math.sin(angle) * 0.35),
      );
      smokePuff.mesh.scaling.setAll(0.15);
      smokePuff.mesh.setEnabled(true);
      smokePuff.material.alpha = 0.5;
      smokePuff.velocity.set(
        Math.cos(angle) * (0.8 + (smokeIndex % 2) * 0.25),
        1.4 + (smokeIndex % 3) * 0.32,
        Math.sin(angle) * (0.8 + (smokeIndex % 2) * 0.25),
      );
    });

    if (visual.smokeParticles) {
      visual.smokeParticles.emitter = position.add(new Vector3(0, 0.32, 0));
      visual.smokeParticles.reset();
      visual.smokeParticles.manualEmitCount = this.explosionSmokeParticleCount;
      visual.smokeParticles.start();
    }

    visual.fragments.forEach((fragment, fragmentIndex) => {
      const angle = (fragmentIndex / visual.fragments.length) * Math.PI * 2;
      const speed = 4.2 + (fragmentIndex % 4) * 0.8;
      fragment.mesh.position.copyFrom(position);
      fragment.mesh.position.y += 0.25;
      fragment.mesh.rotation.set(0, 0, 0);
      fragment.mesh.visibility = 1;
      fragment.mesh.setEnabled(true);
      fragment.velocity.set(
        Math.cos(angle) * speed,
        2.8 + (fragmentIndex % 5) * 0.55,
        Math.sin(angle) * speed,
      );
    });

    visual.light.position.copyFrom(position);
    visual.light.position.y += 1.1;
    visual.light.intensity = 42;
    visual.light.setEnabled(true);
  }

  private releaseExplosionVisual(visual: ExplosionVisual): void {
    visual.mesh.setEnabled(false);
    visual.shockwave.setEnabled(false);
    visual.light.intensity = 0;
    visual.light.setEnabled(false);
    visual.smoke.forEach((smokePuff) => smokePuff.mesh.setEnabled(false));
    visual.smokeParticles?.stop();
    visual.fragments.forEach((fragment) => fragment.mesh.setEnabled(false));

    if (this.explosionVisualPool.length < 2) {
      this.explosionVisualPool.push(visual);
      return;
    }

    this.disposeExplosionVisual(visual);
  }

  private disposeExplosionVisual(visual: ExplosionVisual): void {
    visual.mesh.dispose();
    visual.material.dispose();
    visual.shockwave.dispose();
    visual.shockwaveMaterial.dispose();
    visual.light.dispose();
    for (const smokePuff of visual.smoke) {
      smokePuff.mesh.dispose();
      smokePuff.material.dispose();
    }
    visual.smokeParticles?.dispose();
    for (const fragment of visual.fragments) {
      fragment.mesh.dispose();
    }
    visual.fragmentMaterial.dispose();
  }

  private updateExplosionVisuals(
    deltaTime: number,
  ): void {
    for (
      let index =
        this.explosionVisuals.length - 1;
      index >= 0;
      index -= 1
    ) {
      const visual =
        this.explosionVisuals[index];

      visual.elapsedTime += deltaTime;

      const progress = clamp(
        visual.elapsedTime /
          visual.duration,
        0,
        1,
      );

      const easedProgress =
        1 -
        Math.pow(1 - progress, 3);

      const diameter = lerp(
        0.15,
        visual.radius * 2,
        easedProgress,
      );

      visual.mesh.scaling.setAll(
        diameter,
      );

      visual.material.alpha =
        0.62 * (1 - progress);

      const shockwaveScale = lerp(0.2, visual.radius * 2.25, easedProgress);
      visual.shockwave.scaling.setAll(shockwaveScale);
      visual.shockwaveMaterial.alpha = 0.72 * Math.pow(1 - progress, 2);
      visual.light.intensity = 42 * Math.pow(1 - progress, 3);

      for (const smokePuff of visual.smoke) {
        smokePuff.mesh.position.addInPlace(smokePuff.velocity.scale(deltaTime));
        smokePuff.velocity.scaleInPlace(Math.max(0, 1 - deltaTime * 0.7));
        smokePuff.mesh.scaling.setAll(lerp(0.15, 2.2, easedProgress));
        smokePuff.material.alpha = 0.5 * Math.sin(progress * Math.PI);
      }

      for (const fragment of visual.fragments) {
        fragment.velocity.y -= 9.8 * deltaTime;
        fragment.mesh.position.addInPlace(fragment.velocity.scale(deltaTime));
        fragment.mesh.rotation.x += fragment.spin.x * deltaTime;
        fragment.mesh.rotation.y += fragment.spin.y * deltaTime;
        fragment.mesh.rotation.z += fragment.spin.z * deltaTime;
        fragment.mesh.visibility = Math.max(0, 1 - progress * 0.85);
      }

      if (progress < 1) {
        continue;
      }

      this.releaseExplosionVisual(visual);

      this.explosionVisuals.splice(
        index,
        1,
      );
    }
  }

  public reset(): void {
    this.cancelAim();
    this.cooldownRemainingTime = 0;
    this.ammo = this.config.initialAmmo;
    this.rangeFactor =
      this.config.defaultRangeFactor;
    this.estimatedLandingDistanceValue = 0;

    for (
      const grenade
      of this.activeGrenades
    ) {
      this.releaseGrenadeMesh(
        grenade.mesh,
      );
    }

    this.activeGrenades.length = 0;

    for (
      const visual
      of this.explosionVisuals
    ) {
      this.disposeExplosionVisual(visual);
    }

    this.explosionVisuals.length = 0;

    for (const visual of this.explosionVisualPool) {
      this.disposeExplosionVisual(visual);
    }

    this.explosionVisualPool.length = 0;
  }

  public get isAiming(): boolean {
    return this.aiming;
  }

  private get explosionSmokeParticleCount(): number {
    return this.graphicsQuality === "low"
      ? 16
      : this.graphicsQuality === "medium"
        ? 28
        : 42;
  }

  public get cooldownRemaining(): number {
    return this.cooldownRemainingTime;
  }

  public get cooldownDuration(): number {
    return this.config.cooldownDuration;
  }

  public get currentAmmo(): number {
    return this.ammo;
  }

  public get aimRangeFactor(): number {
    return this.rangeFactor;
  }

  public get estimatedLandingDistance():
    number {
    return this.estimatedLandingDistanceValue;
  }

  public get isReady(): boolean {
    return (
      this.ammo > 0 &&
      this.cooldownRemainingTime <= 0 &&
      !this.aiming
    );
  }
}
