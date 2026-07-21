export type FireResult =
  | "fired"
  | "reloading"
  | "cooldown"
  | "empty";

export type ReloadResult =
  | "started"
  | "alreadyReloading"
  | "full";

export interface GunUpdateResult {
  reloadCompleted: boolean;
}

export interface GunControllerConfig {
  magazineSize: number;
  shotCooldownDuration: number;
  reloadDuration: number;
}

export class GunController {
  private readonly config: GunControllerConfig;
  private magazineCapacity: number;

  private ammo: number;
  private cooldownRemaining = 0;
  private reloading = false;
  private reloadRemainingTime = 0;

  public constructor(
    config: GunControllerConfig,
  ) {
    this.config = config;
    this.magazineCapacity = config.magazineSize;
    this.ammo = this.magazineCapacity;
  }

  public update(
    deltaTime: number,
  ): GunUpdateResult {
    this.cooldownRemaining = Math.max(
      0,
      this.cooldownRemaining - deltaTime,
    );

    if (!this.reloading) {
      return {
        reloadCompleted: false,
      };
    }

    this.reloadRemainingTime = Math.max(
      0,
      this.reloadRemainingTime - deltaTime,
    );

    if (this.reloadRemainingTime > 0) {
      return {
        reloadCompleted: false,
      };
    }

    this.ammo = this.magazineCapacity;
    this.reloading = false;
    this.reloadRemainingTime = 0;

    return {
      reloadCompleted: true,
    };
  }

  public tryFire(): FireResult {
    if (this.reloading) {
      return "reloading";
    }

    if (this.cooldownRemaining > 0) {
      return "cooldown";
    }

    if (this.ammo <= 0) {
      return "empty";
    }

    this.ammo -= 1;

    this.cooldownRemaining =
      this.config.shotCooldownDuration;

    return "fired";
  }

  public startReload(): ReloadResult {
    if (this.reloading) {
      return "alreadyReloading";
    }

    if (
      this.ammo >=
      this.magazineCapacity
    ) {
      return "full";
    }

    this.reloading = true;
    this.reloadRemainingTime =
      this.config.reloadDuration;

    return "started";
  }

  public reset(): void {
    this.ammo = this.magazineCapacity;
    this.cooldownRemaining = 0;
    this.reloading = false;
    this.reloadRemainingTime = 0;
  }

  public get currentAmmo(): number {
    return this.ammo;
  }

  public get magazineSize(): number {
    return this.magazineCapacity;
  }

  public setMagazineSize(magazineSize: number): void {
    this.magazineCapacity = Math.max(1, Math.floor(magazineSize));
    this.ammo = Math.min(this.ammo, this.magazineCapacity);
  }

  public get shotCooldownRemaining(): number {
    return this.cooldownRemaining;
  }

  public get isReloading(): boolean {
    return this.reloading;
  }

  public get reloadRemaining(): number {
    return this.reloadRemainingTime;
  }

  public get reloadDuration(): number {
    return this.config.reloadDuration;
  }

  public get needsReload(): boolean {
    return (
      this.ammo <= 0 &&
      !this.reloading
    );
  }
}
