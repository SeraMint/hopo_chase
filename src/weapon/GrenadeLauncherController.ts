import {
  Color3,
  LinesMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
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

  private readonly launchOrigin:
    Vector3;

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

  private readonly explosionVisuals:
    ExplosionVisual[] = [];

  public constructor(
    scene: Scene,
    camera: UniversalCamera,
    config: GrenadeLauncherConfig,
    road: RoadController,
  ) {
    this.scene = scene;
    this.camera = camera;
    this.config = config;
    this.road = road;
    this.ammo = config.initialAmmo;
    this.rangeFactor =
      config.defaultRangeFactor;

    this.launchOrigin = new Vector3(
      config.launchOrigin.x,
      config.launchOrigin.y,
      config.launchOrigin.z,
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
    const points = Array.from(
      {
        length:
          this.config.guidePointCount,
      },
      () => this.launchOrigin.clone(),
    );

    const line = MeshBuilder.CreateLines(
      "grenade-trajectory-guide",
      {
        points,
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

    mesh.position.copyFrom(origin);
    mesh.isPickable = false;

    this.activeGrenades.push({
      mesh,
      origin: origin.clone(),
      initialVelocity:
        velocity.clone(),
      elapsedTime: 0,
    });
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

    const points =
      this.calculateTrajectoryPoints(
        this.launchOrigin,
        this.aimVelocity,
      );

    MeshBuilder.CreateLines(
      "grenade-trajectory-guide",
      {
        points,
        instance: this.guideLine,
      },
      this.scene,
    );

    const finalPoint =
      points[points.length - 1];

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
  ): Vector3[] {
    const points: Vector3[] = [];

    let landingPoint =
      origin.clone();

    let hasLanded = false;

    for (
      let index = 0;
      index <
      this.config.guidePointCount;
      index += 1
    ) {
      if (hasLanded) {
        points.push(
          landingPoint.clone(),
        );

        continue;
      }

      const time =
        index *
        this.config.guideTimeStep;

      const point =
        this.sampleTrajectory(
          origin,
          initialVelocity,
          time,
        );

      const groundHeight =
        this.road.getGroundHeight(
          point,
        );

      if (
        point.y <= groundHeight
      ) {
        point.y = groundHeight;

        landingPoint = point.clone();
        hasLanded = true;
      }

      points.push(point);
    }

    return points;
  }

  private sampleTrajectory(
    origin: Vector3,
    initialVelocity: Vector3,
    time: number,
  ): Vector3 {
    return new Vector3(
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

      const position =
        this.sampleTrajectory(
          grenade.origin,
          grenade.initialVelocity,
          grenade.elapsedTime,
        );

      grenade.mesh.position.copyFrom(
        position,
      );

      grenade.mesh.rotation.x +=
        deltaTime * 9;

      grenade.mesh.rotation.z +=
        deltaTime * 6;

      const currentGroundHeight =
        this.road.getGroundHeight(
          position,
        );

      const touchedGround =
        position.y <=
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

      grenade.mesh.dispose();

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

    this.explosionVisuals.push({
      mesh,
      material,
      elapsedTime: 0,
      duration: 0.42,
      radius:
        this.config.explosionRadius,
    });
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

      if (progress < 1) {
        continue;
      }

      visual.mesh.dispose();
      visual.material.dispose();

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
      grenade.mesh.dispose();
    }

    this.activeGrenades.length = 0;

    for (
      const visual
      of this.explosionVisuals
    ) {
      visual.mesh.dispose();
      visual.material.dispose();
    }

    this.explosionVisuals.length = 0;
  }

  public get isAiming(): boolean {
    return this.aiming;
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
