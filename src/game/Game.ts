import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  Engine,
  HemisphericLight,
  ImageProcessingConfiguration,
  LinesMesh,
  Matrix,
  MeshBuilder,
  PointLight,
  Scene,
  ShadowGenerator,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";

import {
  GAME_CONFIG,
  type DifficultyId,
} from "./GameConfig";
import { MonsterController } from "../monster/MonsterController";
import { GunController } from "../weapon/GunController";
import { GrenadeLauncherController } from "../weapon/GrenadeLauncherController";
import { RoadController } from "../world/RoadController";
import { HudController } from "../ui/HudController";
import {
  getScoreDifficultyId,
  LocalStorageLeaderboardRepository,
  SupabaseLeaderboardRepository,
} from "../score/LeaderboardRepository";
import { ScoreController } from "../score/ScoreController";
import rifleFireSoundUrl from "../assets/sounds/m4_fire.mp3?url";
import rifleReloadSoundUrl from "../assets/sounds/m4_reload.mp3?url";
import grenadeFireSoundUrl from "../assets/sounds/grenade_fire.mp3?url";
import grenadeExplosionSoundUrl from "../assets/sounds/grenade_explode.mp3?url";
import backgroundMusicUrl from "../assets/sounds/Before_the_Breach.mp3?url";

type GameState =
  | "title"
  | "playing"
  | "gameOver";

type GraphicsQuality = "low" | "medium" | "high";

// Skip the MP3 lead-in and use only the source recording's first report.
const RIFLE_SINGLE_SHOT_START_SECONDS = 0.08;
const RIFLE_SINGLE_SHOT_DURATION_MS = 180;
const RIFLE_RELOAD_PLAYBACK_RATE = 1.5;
const RIFLE_RELOAD_GAIN = 2;

interface BulletVisualPoolItem {
  tracer: LinesMesh;
  points: [Vector3, Vector3];
  active: boolean;
}

export class Game {
  private readonly soundUrls = {
    rifleFire: rifleFireSoundUrl,
    rifleReload: rifleReloadSoundUrl,
    grenadeFire: grenadeFireSoundUrl,
    grenadeExplosion: grenadeExplosionSoundUrl,
  } as const;

  private readonly backgroundMusic = new Audio(backgroundMusicUrl);
  private readonly soundAudioContext = new AudioContext();
  private readonly soundPools = new Map<string, HTMLAudioElement[]>();
  private readonly soundPlaybackIds = new WeakMap<HTMLAudioElement, number>();
  private soundEnabled = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly muzzleFlashLight: PointLight;
  private readonly identityMatrix = Matrix.Identity();
  private readonly bulletVisualPool: BulletVisualPoolItem[] = [];

  private readonly road: RoadController;
  private readonly monster: MonsterController;
  private readonly gun: GunController;
  private readonly grenade: GrenadeLauncherController;
  private readonly score: ScoreController;
  private readonly hud: HudController;
  private readonly renderingPipeline: DefaultRenderingPipeline;
  private readonly graphicsQuality: GraphicsQuality;
  private readonly isTouchDevice: boolean;
  private renderScale = 1;
  private performanceSampleTime = 0;
  private performanceSampleFrames = 0;
  private lowPerformanceSamples = 0;
  private recoveredPerformanceSamples = 0;
  private postProcessingReduced = false;

  private state: GameState = "title";

  private selectedDifficulty:
    DifficultyId =
      GAME_CONFIG.defaultDifficulty;

  private grenadePointerId:
    number | null = null;

  private mobileAimPointerId:
    number | null = null;

  private mobileGrenadePointerId:
    number | null = null;

  private elapsedTime = 0;
  private hitCount = 0;
  private nextGrenadeRewardAt =
    GAME_CONFIG.grenade.rewardEveryHits;

  private pointerInsideCanvas = true;
  private scoreSubmitted = false;
  private scoreSubmitting = false;
  private cameraShakeTrauma = 0;
  private cameraShakeTime = 0;
  private muzzleFlashRemaining = 0;
  private resourcesReady = false;
  private gameOverSequence = 0;

  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.isTouchDevice =
      navigator.maxTouchPoints > 0 ||
      window.matchMedia(
        "(any-pointer: coarse)",
      ).matches;

    document.documentElement.classList.toggle(
      "touch-input",
      this.isTouchDevice,
    );

    this.graphicsQuality = this.detectGraphicsQuality();

    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
    });
    this.renderScale = this.getInitialRenderScale();
    this.engine.setHardwareScalingLevel(this.renderScale);

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(
      0.48,
      0.64,
      0.72,
      1,
    );

    this.configureAtmosphere();

    this.camera = this.createCamera();
    this.createLighting();
    this.muzzleFlashLight = this.createMuzzleFlashLight();

    this.road = new RoadController(
      this.scene,
      GAME_CONFIG.road,
      this.graphicsQuality,
    );

    this.road.updateCamera(
      this.camera,
      0,
      true,
    );

    this.monster = new MonsterController(
      this.scene,
      GAME_CONFIG.monster,
      this.road,
    );

    this.createShadows();
    this.renderingPipeline = this.createPostProcessing();

    this.gun = new GunController(
      GAME_CONFIG.gun,
    );

    this.applySelectedDifficulty();

    this.grenade =
      new GrenadeLauncherController(
        this.scene,
        this.camera,
        GAME_CONFIG.grenade,
        this.road,
        this.graphicsQuality,
      );

    const localLeaderboardRepository =
      new LocalStorageLeaderboardRepository(
        GAME_CONFIG.scoring.storageKey,
        GAME_CONFIG.scoring.leaderboardSize,
      );

    const leaderboardRepository =
      new SupabaseLeaderboardRepository(
        localLeaderboardRepository,
        GAME_CONFIG.scoring.leaderboardSize,
      );

    this.score = new ScoreController(
      GAME_CONFIG.scoring,
      leaderboardRepository,
    );

    this.hud = new HudController();

    this.registerInputEvents();
    this.registerMobileInputEvents();
    this.registerWindowEvents();
    this.registerUiEvents();

    void this.refreshLeaderboard();

    this.hud.setGameOverVisible(false);
    this.hud.setTitleVisible(true);
    this.updateHud();

    this.backgroundMusic.loop = true;
    this.backgroundMusic.preload = "auto";
    this.backgroundMusic.volume = 0.45;
    this.preloadSounds();
    void this.prepareGameResources();
  }

  private createMuzzleFlashLight(): PointLight {
    const light = new PointLight(
      "muzzle-flash-light",
      Vector3.Zero(),
      this.scene,
    );
    light.diffuse = new Color3(1, 0.36, 0.06);
    light.range = 7;
    light.intensity = 0;
    return light;
  }

  private async prepareGameResources(): Promise<void> {
    const startButton = this.hud.startButton;
    startButton.disabled = true;
    startButton.textContent = "게임 준비 중...";

    const visual = this.acquireBulletVisual();
    visual.tracer.alpha = 0;
    visual.tracer.setEnabled(true);

    try {
      await this.scene.whenReadyAsync();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    } finally {
      visual.tracer.setEnabled(false);
      visual.active = false;
      this.resourcesReady = true;
      startButton.disabled = false;
      startButton.textContent = "게임 시작";
    }
  }

  private preloadSounds(): void {
    for (const url of Object.values(this.soundUrls)) {
      const initialChannelCount =
        url === this.soundUrls.rifleFire ? 3 : 1;
      const channels = Array.from(
        { length: initialChannelCount },
        () => this.createSoundChannel(url),
      );
      this.soundPools.set(url, channels);
    }
  }

  private createSoundChannel(url: string): HTMLAudioElement {
    const audio = new Audio(url);
    audio.preload = "auto";

    const source = this.soundAudioContext.createMediaElementSource(audio);
    const gain = this.soundAudioContext.createGain();
    gain.gain.value = url === this.soundUrls.rifleReload
      ? RIFLE_RELOAD_GAIN
      : 1;
    source.connect(gain).connect(this.soundAudioContext.destination);

    audio.load();
    return audio;
  }

  private getMaximumSoundChannels(url: string): number {
    if (url === this.soundUrls.rifleFire) {
      return 6;
    }

    if (url === this.soundUrls.grenadeExplosion) {
      return 3;
    }

    return 2;
  }

  private playSound(url: string): void {
    if (!this.soundEnabled) {
      return;
    }

    const channels = this.soundPools.get(url) ?? [];
    let audio = channels.find(
      (channel) => channel.paused || channel.ended,
    );

    if (!audio && channels.length < this.getMaximumSoundChannels(url)) {
      audio = this.createSoundChannel(url);
      channels.push(audio);
      this.soundPools.set(url, channels);
    }

    if (!audio) {
      return;
    }

    const playbackId = (this.soundPlaybackIds.get(audio) ?? 0) + 1;
    this.soundPlaybackIds.set(audio, playbackId);
    audio.playbackRate = url === this.soundUrls.rifleReload
      ? RIFLE_RELOAD_PLAYBACK_RATE
      : 1;
    audio.currentTime = url === this.soundUrls.rifleFire
      ? RIFLE_SINGLE_SHOT_START_SECONDS
      : 0;

    void this.soundAudioContext.resume();
    void audio.play().then(() => {
      if (url !== this.soundUrls.rifleFire) {
        return;
      }

      window.setTimeout(() => {
        if (this.soundPlaybackIds.get(audio) !== playbackId) {
          return;
        }

        audio.pause();
        audio.currentTime = RIFLE_SINGLE_SHOT_START_SECONDS;
      }, RIFLE_SINGLE_SHOT_DURATION_MS);
    }).catch(() => {
      // 브라우저가 사용자 입력 전 자동 재생을 차단하면 재생을 건너뜁니다.
    });
  }

  private startBackgroundMusic(): void {
    if (!this.soundEnabled || !this.backgroundMusic.paused) {
      return;
    }

    void this.backgroundMusic.play().catch(() => {
      // 첫 사용자 입력 전에는 브라우저가 자동 재생을 차단할 수 있습니다.
    });
  }

  private toggleSound(): void {
    this.soundEnabled = !this.soundEnabled;

    if (this.soundEnabled) {
      this.startBackgroundMusic();
    } else {
      this.backgroundMusic.pause();
      for (const channels of this.soundPools.values()) {
        for (const audio of channels) {
          audio.pause();
          audio.currentTime = 0;
        }
      }
    }

    this.hud.soundToggleButton.setAttribute(
      "aria-pressed",
      String(this.soundEnabled),
    );
    this.hud.soundToggleButton.setAttribute(
      "aria-label",
      this.soundEnabled ? "게임 소리 끄기" : "게임 소리 켜기",
    );
    this.hud.soundToggleButton.textContent =
      this.soundEnabled ? "🔊 소리 켜짐" : "🔇 소리 꺼짐";
  }

  private createCamera(): UniversalCamera {
    const config = GAME_CONFIG.camera;

    const camera = new UniversalCamera(
      "rear-camera",
      new Vector3(
        config.position.x,
        config.position.y,
        config.position.z,
      ),
      this.scene,
    );

    camera.setTarget(
      new Vector3(
        config.target.x,
        config.target.y,
        config.target.z,
      ),
    );

    camera.fov = config.fov;
    camera.minZ = config.minZ;
    camera.inputs.clear();

    this.scene.activeCamera = camera;

    return camera;
  }

  private detectGraphicsQuality(): GraphicsQuality {
    const cores = navigator.hardwareConcurrency ?? 4;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;

    if (cores <= 4 || memory <= 4) {
      return "low";
    }

    if (cores >= 8 && memory >= 8) {
      // 터치 기기는 발열과 배터리 소모를 고려해 중간 품질을 상한으로 둡니다.
      if (this.isTouchDevice) {
        return "medium";
      }

      return "high";
    }

    return "medium";
  }

  private getInitialRenderScale(): number {
    if (this.isTouchDevice) {
      return this.graphicsQuality === "low" ? 1.6 : 1.35;
    }

    return this.graphicsQuality === "low"
      ? 1.5
      : this.graphicsQuality === "medium"
        ? 1.2
        : 1;
  }

  private createLighting(): void {
    const light = new HemisphericLight(
      "hemispheric-light",
      new Vector3(0, 1, -0.25),
      this.scene,
    );

    light.intensity = 0.72;
    light.groundColor = new Color3(
      0.22,
      0.27,
      0.2,
    );

    const sunlight = new DirectionalLight(
      "sun-light",
      new Vector3(-0.38, -0.82, 0.42),
      this.scene,
    );

    sunlight.position = new Vector3(35, 55, -45);
    sunlight.intensity = 2.35;
    sunlight.diffuse = new Color3(1, 0.88, 0.69);
    sunlight.specular = new Color3(1, 0.92, 0.8);
  }

  private configureAtmosphere(): void {
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.0065;
    this.scene.fogColor = new Color3(0.48, 0.61, 0.66);

    const imageProcessing = this.scene.imageProcessingConfiguration;
    imageProcessing.toneMappingEnabled = true;
    imageProcessing.toneMappingType =
      ImageProcessingConfiguration.TONEMAPPING_ACES;
    imageProcessing.exposure = 1.08;
    imageProcessing.contrast = 1.16;
  }

  private createShadows(): void {
    const sunlight = this.scene.getLightByName("sun-light");

    if (!(sunlight instanceof DirectionalLight)) {
      return;
    }

    const shadowMapSize = this.isTouchDevice
      ? 512
      : this.graphicsQuality === "high"
      ? 1024
      : this.graphicsQuality === "medium"
        ? 768
        : 512;
    const shadows = new ShadowGenerator(shadowMapSize, sunlight, true);

    if (this.graphicsQuality === "low") {
      shadows.usePoissonSampling = true;
    } else {
      shadows.useBlurExponentialShadowMap = true;
      shadows.blurKernel = this.graphicsQuality === "high" ? 12 : 8;
    }

    shadows.bias = 0.0005;
    shadows.normalBias = 0.025;
    shadows.darkness = 0.3;
    shadows.frustumEdgeFalloff = 0.18;

    const monsterShadowParts = [
      "monster-rib-cage",
      "monster-abdomen",
      "monster-shoulder-mass",
      "monster-cranium",
      "monster-rear-cranium",
      "monster-muzzle",
    ];

    for (const mesh of this.monster.mesh.getChildMeshes()) {
      const isLimbPart =
        mesh.name.endsWith("-upper") ||
        mesh.name.endsWith("-lower") ||
        mesh.name.endsWith("-foot");

      if (
        monsterShadowParts.includes(mesh.name) ||
        isLimbPart
      ) {
        shadows.addShadowCaster(mesh);
      }
    }

    for (const mesh of this.road.getVehicleMeshes()) {
      const castsUsefulShadow =
        mesh.name === "vehicle-body" ||
        mesh.name === "vehicle-cabin" ||
        mesh.name.startsWith("vehicle-wheel-");

      if (castsUsefulShadow) {
        shadows.addShadowCaster(mesh);
      }
    }
  }

  private createPostProcessing(): DefaultRenderingPipeline {
    const pipeline = new DefaultRenderingPipeline(
      "cinematic-rendering-pipeline",
      true,
      this.scene,
      [this.camera],
    );

    const useCinematicPostProcessing = !this.isTouchDevice;

    pipeline.samples =
      !this.isTouchDevice && this.graphicsQuality === "high" ? 2 : 1;
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled =
      useCinematicPostProcessing && this.graphicsQuality !== "low";
    pipeline.bloomThreshold = 0.88;
    pipeline.bloomWeight = 0.12;
    pipeline.bloomKernel = 48;
    pipeline.sharpenEnabled = useCinematicPostProcessing;
    pipeline.sharpen.edgeAmount = 0.18;

    return pipeline;
  }

  private updateDynamicResolution(deltaTime: number): void {
    this.performanceSampleTime += deltaTime;
    this.performanceSampleFrames += 1;

    if (this.performanceSampleTime < 2) {
      return;
    }

    const fps = this.performanceSampleFrames / this.performanceSampleTime;
    const minimumScale = this.isTouchDevice
      ? this.graphicsQuality === "low" ? 1.45 : 1.25
      : this.graphicsQuality === "high" ? 1 : 1.15;
    const maximumScale = this.isTouchDevice
      ? 2
      : this.graphicsQuality === "low" ? 1.85 : 1.65;
    let nextScale = this.renderScale;

    if (fps < 48) {
      nextScale = Math.min(maximumScale, this.renderScale + 0.1);
    } else if (fps > 57) {
      nextScale = Math.max(minimumScale, this.renderScale - 0.05);
    }

    if (Math.abs(nextScale - this.renderScale) >= 0.049) {
      this.renderScale = nextScale;
      this.engine.setHardwareScalingLevel(this.renderScale);
      this.engine.resize();
    }

    if (fps < 46) {
      this.lowPerformanceSamples += 1;
      this.recoveredPerformanceSamples = 0;
    } else if (fps > 56) {
      this.recoveredPerformanceSamples += 1;
      this.lowPerformanceSamples = 0;
    } else {
      this.lowPerformanceSamples = 0;
      this.recoveredPerformanceSamples = 0;
    }

    if (
      !this.isTouchDevice &&
      !this.postProcessingReduced &&
      this.lowPerformanceSamples >= 2
    ) {
      this.renderingPipeline.bloomEnabled = false;
      this.renderingPipeline.sharpenEnabled = false;
      this.postProcessingReduced = true;
      this.lowPerformanceSamples = 0;
    } else if (
      !this.isTouchDevice &&
      this.postProcessingReduced &&
      this.recoveredPerformanceSamples >= 3
    ) {
      this.renderingPipeline.bloomEnabled = this.graphicsQuality !== "low";
      this.renderingPipeline.sharpenEnabled = true;
      this.postProcessingReduced = false;
      this.recoveredPerformanceSamples = 0;
    }

    this.performanceSampleTime = 0;
    this.performanceSampleFrames = 0;
  }

  private registerUiEvents(): void {
    this.hud.startButton.addEventListener(
      "click",
      () => this.startRun(),
    );

    this.hud.soundToggleButton.addEventListener(
      "click",
      () => this.toggleSound(),
    );

    this.hud.restartButton.addEventListener(
      "click",
      () => this.returnToTitle(),
    );

    this.hud.submitScoreButton.addEventListener(
      "click",
      () => this.submitScore(),
    );

    this.hud.playerNameInput.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") {
          this.submitScore();
        }
      },
    );
  }

  private registerInputEvents(): void {
    this.canvas.addEventListener(
      "pointerdown",
      (event) => this.handlePointerDown(event),
    );

    this.canvas.addEventListener(
      "pointermove",
      (event) => {
        if (
          event.pointerType === "touch" &&
          event.pointerId !==
            this.mobileAimPointerId
        ) {
          return;
        }

        if (event.pointerType === "touch") {
          event.preventDefault();
        }

        this.updateAimFromClientPosition(
          event.clientX,
          event.clientY,
        );
      },
    );

    this.canvas.addEventListener(
      "pointerup",
      (event) => {
        if (
          event.pointerType === "touch" &&
          event.pointerId ===
            this.mobileAimPointerId
        ) {
          this.releaseMobileAimPointer(
            event.pointerId,
          );
        }
      },
    );

    this.canvas.addEventListener(
      "pointercancel",
      (event) => {
        if (
          event.pointerId ===
          this.mobileAimPointerId
        ) {
          this.releaseMobileAimPointer(
            event.pointerId,
          );
        }
      },
    );

    this.canvas.addEventListener(
      "lostpointercapture",
      (event) => {
        if (
          event.pointerId ===
          this.mobileAimPointerId
        ) {
          this.mobileAimPointerId = null;
        }
      },
    );

    this.canvas.addEventListener(
      "pointerenter",
      () => {
        this.pointerInsideCanvas = true;

        if (this.state === "playing") {
          this.hud.setCrosshairVisible(true);
        }
      },
    );

    this.canvas.addEventListener(
      "pointerleave",
      (event) => {
        if (
          event.pointerType === "touch" &&
          event.pointerId === this.mobileAimPointerId
        ) {
          return;
        }

        this.pointerInsideCanvas = false;
        this.hud.setCrosshairVisible(false);
      },
    );

    this.canvas.addEventListener(
      "contextmenu",
      (event) => event.preventDefault(),
    );

    this.canvas.addEventListener(
      "auxclick",
      (event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      },
    );

    window.addEventListener(
      "pointerup",
      (event) => {
        if (event.button === 1) {
          this.handleGrenadeRelease(
            event,
          );
        }
      },
    );
  }

  private updateAimFromClientPosition(
    clientX: number,
    clientY: number,
  ): void {
    this.hud.moveCrosshair(
      clientX,
      clientY,
    );

    const rect =
      this.canvas.getBoundingClientRect();

    const normalizedY =
      rect.height > 0
        ? (clientY - rect.top) /
          rect.height
        : 0.5;

    this.grenade.setAimPointer(
      this.scene.pointerX,
      this.scene.pointerY,
      normalizedY,
    );

    if (this.state === "playing") {
      this.hud.setCrosshairVisible(true);
    }
  }

  private registerMobileInputEvents(): void {
    if (!this.isTouchDevice) {
      return;
    }

    const stopTouchEvent = (
      event: PointerEvent,
    ): void => {
      event.preventDefault();
      event.stopPropagation();
    };

    this.hud.mobileFireButton.addEventListener(
      "pointerdown",
      (event) => {
        stopTouchEvent(event);

        if (
          event.pointerType === "touch" &&
          this.state === "playing"
        ) {
          this.handleFire();
        }
      },
    );

    this.hud.mobileReloadButton.addEventListener(
      "pointerdown",
      (event) => {
        stopTouchEvent(event);

        if (
          event.pointerType === "touch" &&
          this.state === "playing"
        ) {
          this.handleReload();
        }
      },
    );

    this.hud.mobileGrenadeButton.addEventListener(
      "pointerdown",
      (event) => {
        stopTouchEvent(event);

        if (
          event.pointerType !== "touch" ||
          this.state !== "playing" ||
          this.mobileGrenadePointerId !== null
        ) {
          return;
        }

        if (
          !this.handleMobileGrenadeAimStart(
            event.clientY,
          )
        ) {
          return;
        }

        this.mobileGrenadePointerId =
          event.pointerId;

        try {
          this.hud.mobileGrenadeButton
            .setPointerCapture(
              event.pointerId,
            );
        } catch {
          this.mobileGrenadePointerId = null;
          this.grenade.cancelAim();
          this.updateHud();
        }
      },
    );

    this.hud.mobileGrenadeButton.addEventListener(
      "pointermove",
      (event) => {
        if (
          event.pointerId !==
            this.mobileGrenadePointerId ||
          !this.grenade.isAiming
        ) {
          return;
        }

        stopTouchEvent(event);

        const rect =
          this.canvas.getBoundingClientRect();

        const normalizedY =
          rect.height > 0
            ? (event.clientY - rect.top) /
              rect.height
            : 0.5;

        this.grenade.setAimPointer(
          this.scene.pointerX,
          this.scene.pointerY,
          normalizedY,
        );
      },
    );

    this.hud.mobileGrenadeButton.addEventListener(
      "pointerup",
      (event) => {
        if (
          event.pointerId !==
          this.mobileGrenadePointerId
        ) {
          return;
        }

        stopTouchEvent(event);
        this.mobileGrenadePointerId = null;
        this.handleGrenadeRelease();
      },
    );

    const cancelMobileGrenade = (
      event: PointerEvent,
    ): void => {
      if (
        event.pointerId !==
        this.mobileGrenadePointerId
      ) {
        return;
      }

      stopTouchEvent(event);
      this.mobileGrenadePointerId = null;
      this.grenade.cancelAim();
      this.updateHud();
    };

    this.hud.mobileGrenadeButton.addEventListener(
      "pointercancel",
      cancelMobileGrenade,
    );

    this.hud.mobileGrenadeButton.addEventListener(
      "lostpointercapture",
      cancelMobileGrenade,
    );
  }

  private handleMobileGrenadeAimStart(
    clientY: number,
  ): boolean {
    if (this.gun.isReloading) {
      this.showTemporaryStatus(
        "재장전 중에는 수류탄을 사용할 수 없습니다.",
      );
      return false;
    }

    const rect =
      this.canvas.getBoundingClientRect();

    const normalizedY =
      rect.height > 0
        ? (clientY - rect.top) /
          rect.height
        : 0.5;

    const result = this.grenade.beginAim(
      this.scene.pointerX,
      this.scene.pointerY,
      normalizedY,
    );

    if (result === "empty") {
      this.showTemporaryStatus(
        "수류탄이 없습니다. 몬스터를 10회 타격하면 1발을 획득합니다.",
      );
      return false;
    }

    if (result === "cooldown") {
      this.showTemporaryStatus(
        `수류탄 재사용까지 ${this.grenade.cooldownRemaining.toFixed(1)}초`,
      );
      return false;
    }

    if (result !== "started") {
      return false;
    }

    this.hud.setStatus(
      "수류탄 버튼을 위로 밀면 멀리, 아래로 밀면 가까워집니다.",
    );
    this.updateHud();
    return true;
  }

  private registerWindowEvents(): void {
    window.addEventListener(
      "resize",
      () => this.engine.resize(),
    );

    if (this.isTouchDevice) {
      const resizeForMobileViewport =
        (): void => {
          requestAnimationFrame(() => {
            this.engine.resize();
          });
        };

      window.addEventListener(
        "orientationchange",
        () => {
          this.cancelMobileInteractions();
          resizeForMobileViewport();
        },
      );

      window.visualViewport?.addEventListener(
        "resize",
        resizeForMobileViewport,
      );
    }

    window.addEventListener(
      "blur",
      () => this.cancelMobileInteractions(),
    );

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) {
          this.cancelMobileInteractions();
        }
      },
    );
  }

  private cancelMobileInteractions(): void {
    this.clearMobilePointerState();

    if (this.grenade.isAiming) {
      this.grenade.cancelAim();
      this.releaseGrenadePointerCapture();
      this.updateHud();
    }
  }

  private clearMobilePointerState(): void {
    const aimPointerId =
      this.mobileAimPointerId;
    const grenadePointerId =
      this.mobileGrenadePointerId;

    this.mobileGrenadePointerId = null;

    if (aimPointerId !== null) {
      this.releaseMobileAimPointer(
        aimPointerId,
      );
    }

    if (grenadePointerId === null) {
      return;
    }

    try {
      if (
        this.hud.mobileGrenadeButton
          .hasPointerCapture(
            grenadePointerId,
          )
      ) {
        this.hud.mobileGrenadeButton
          .releasePointerCapture(
            grenadePointerId,
          );
      }
    } catch {
      // The browser may already have released the touch pointer.
    }
  }

  private releaseMobileAimPointer(
    pointerId: number,
  ): void {
    if (this.mobileAimPointerId === pointerId) {
      this.mobileAimPointerId = null;
    }

    try {
      if (this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may already have released the touch pointer.
    }
  }

  private handlePointerDown(
    event: PointerEvent,
  ): void {
    if (this.state !== "playing") {
      return;
    }

    if (event.pointerType === "touch") {
      event.preventDefault();

      if (this.mobileAimPointerId === null) {
        this.mobileAimPointerId =
          event.pointerId;

        try {
          this.canvas.setPointerCapture(
            event.pointerId,
          );
        } catch {
          // Continue tracking while the pointer remains on the canvas.
        }

        this.updateAimFromClientPosition(
          event.clientX,
          event.clientY,
        );
      }

      return;
    }

    if (event.button === 1) {
      event.preventDefault();
      this.handleGrenadeAimStart(event);
      return;
    }

    if (event.button === 2) {
      event.preventDefault();
      this.handleReload();
      return;
    }

    if (event.button === 0) {
      this.handleFire();
    }
  }

  private handleGrenadeAimStart(
    event: PointerEvent,
  ): void {
    if (this.gun.isReloading) {
      this.showTemporaryStatus(
        "재장전 중에는 유탄을 사용할 수 없습니다.",
      );
      return;
    }

    const rect =
      this.canvas.getBoundingClientRect();

    const normalizedY =
      rect.height > 0
        ? (event.clientY - rect.top) /
          rect.height
        : 0.5;

    const result = this.grenade.beginAim(
      this.scene.pointerX,
      this.scene.pointerY,
      normalizedY,
    );

    if (result === "empty") {
      this.showTemporaryStatus(
        "유탄이 없습니다. 몬스터를 10회 타격하면 1발을 획득합니다.",
      );
      return;
    }

    if (result === "cooldown") {
      this.showTemporaryStatus(
        `유탄 재사용까지 ${this.grenade.cooldownRemaining.toFixed(1)}초`,
      );
      return;
    }

    if (result === "started") {
      this.grenadePointerId =
        event.pointerId;

      try {
        this.canvas.setPointerCapture(
          event.pointerId,
        );
      } catch {
        this.grenadePointerId = null;
      }

      this.hud.setStatus(
        "유탄 조준 중: 위로 이동하면 멀리, 아래로 이동하면 가까워집니다.",
      );
    }

    this.updateHud();
  }

  private handleGrenadeRelease(
    event?: PointerEvent,
  ): void {
    if (
      this.state !== "playing" ||
      !this.grenade.isAiming
    ) {
      return;
    }

    const result = this.grenade.releaseFire();

    this.releaseGrenadePointerCapture(
      event?.pointerId,
    );

    if (result === "fired") {
      this.playSound(this.soundUrls.grenadeFire);
      this.showTemporaryStatus(
        "유탄 발사! 낙하지점을 확인하세요.",
      );
    } else if (result === "empty") {
      this.showTemporaryStatus(
        "유탄이 없습니다.",
      );
    }

    this.updateHud();
  }

  private releaseGrenadePointerCapture(
    pointerId = this.grenadePointerId,
  ): void {
    if (pointerId === null) {
      return;
    }

    try {
      if (
        this.canvas.hasPointerCapture(
          pointerId,
        )
      ) {
        this.canvas.releasePointerCapture(
          pointerId,
        );
      }
    } catch {
      // 브라우저가 이미 캡처를 해제한 경우 무시합니다.
    }

    if (
      this.grenadePointerId ===
      pointerId
    ) {
      this.grenadePointerId = null;
    }
  }

  private handleFire(): void {
    if (this.grenade.isAiming) {
      this.showTemporaryStatus(
        "유탄 조준 중에는 소총을 발사할 수 없습니다.",
      );
      return;
    }

    const fireResult = this.gun.tryFire();

    switch (fireResult) {
      case "reloading":
        this.showTemporaryStatus(
          "재장전 중에는 사격할 수 없습니다.",
        );
        return;

      case "cooldown":
        this.showTemporaryStatus(
          "아직 다음 탄환을 발사할 수 없습니다.",
        );
        return;

      case "empty":
        this.hud.setStatus(
          "탄약이 없습니다. 우클릭으로 재장전하세요.",
        );
        this.updateHud();
        return;

      case "fired":
        break;
    }

    this.playSound(this.soundUrls.rifleFire);

    const pickResult = this.scene.pick(
      this.scene.pointerX,
      this.scene.pointerY,
      (mesh) => mesh === this.monster.mesh,
    );

    this.spawnBulletVisual(
      pickResult?.pickedPoint ?? null,
    );

    if (
      pickResult?.hit &&
      pickResult.pickedMesh ===
        this.monster.mesh
    ) {
      this.monster.applyBulletHit();
      this.registerMonsterHit(
        "명중! 몬스터가 뒤로 밀려납니다.",
      );
    } else {
      this.showTemporaryStatus("빗나갔습니다.");
    }

    if (this.gun.needsReload) {
      this.hud.setStatus(
        "탄약이 없습니다. 우클릭으로 재장전하세요.",
      );
    }

    this.updateHud();
  }

  private spawnBulletVisual(
    hitPoint: Vector3 | null,
  ): void {
    const ray = this.scene.createPickingRay(
      this.scene.pointerX,
      this.scene.pointerY,
      this.identityMatrix,
      this.camera,
    );

    const visual = this.acquireBulletVisual();
    const [origin, tracerEnd] = visual.points;
    origin.copyFrom(ray.origin);
    origin.addInPlaceFromFloats(
      ray.direction.x * 0.8,
      ray.direction.y * 0.8,
      ray.direction.z * 0.8,
    );

    if (hitPoint) {
      Vector3.LerpToRef(origin, hitPoint, 0.92, tracerEnd);
    } else {
      tracerEnd.set(
        ray.origin.x + ray.direction.x * 120,
        ray.origin.y + ray.direction.y * 120,
        ray.origin.z + ray.direction.z * 120,
      );
      Vector3.LerpToRef(origin, tracerEnd, 0.92, tracerEnd);
    }

    const tracer = MeshBuilder.CreateLines(
      "bullet-tracer",
      {
        points: visual.points,
        instance: visual.tracer,
      },
      this.scene,
    );
    const flashLight = this.muzzleFlashLight;

    tracer.alpha = 0.95;
    tracer.setEnabled(true);
    flashLight.position.copyFrom(origin);
    flashLight.intensity = 8;
    this.muzzleFlashRemaining = 0.09;

    this.addCameraShake(0.065);

    let elapsed = 0;
    const lifetime = 0.09;

    const observer = this.scene.onBeforeRenderObservable.add(() => {
      elapsed += Math.min(this.engine.getDeltaTime() / 1000, 0.05);

      const progress = Math.min(elapsed / lifetime, 1);

      tracer.alpha = 1 - progress;

      if (progress < 1) {
        return;
      }

      this.scene.onBeforeRenderObservable.remove(observer);
      tracer.setEnabled(false);
      visual.active = false;
    });
  }

  private acquireBulletVisual(): BulletVisualPoolItem {
    const available = this.bulletVisualPool.find((visual) => !visual.active);

    if (available) {
      available.active = true;
      return available;
    }

    const points: [Vector3, Vector3] = [
      Vector3.Zero(),
      Vector3.Zero(),
    ];
    const tracer = MeshBuilder.CreateLines(
      "bullet-tracer-pooled",
      { points, updatable: true },
      this.scene,
    );
    tracer.color = new Color3(1, 0.72, 0.18);
    tracer.isPickable = false;
    tracer.setEnabled(false);

    const visual = { tracer, points, active: true };
    this.bulletVisualPool.push(visual);
    return visual;
  }

  private updateMuzzleFlash(deltaTime: number): void {
    this.muzzleFlashRemaining = Math.max(
      0,
      this.muzzleFlashRemaining - deltaTime,
    );

    const progress = this.muzzleFlashRemaining / 0.09;
    this.muzzleFlashLight.intensity =
      8 * Math.min(1, progress * 3.5);
  }

  private addCameraShake(amount: number): void {
    this.cameraShakeTrauma = Math.min(1, this.cameraShakeTrauma + amount);
  }

  private updateCameraShake(deltaTime: number): void {
    if (this.cameraShakeTrauma <= 0) {
      return;
    }

    this.cameraShakeTime += deltaTime;
    const strength = this.cameraShakeTrauma * this.cameraShakeTrauma;
    this.camera.rotation.x += Math.sin(this.cameraShakeTime * 38) * strength * 0.022;
    this.camera.rotation.y += Math.sin(this.cameraShakeTime * 31 + 1.7) * strength * 0.028;
    this.camera.rotation.z += Math.sin(this.cameraShakeTime * 43 + 0.8) * strength * 0.018;
    this.cameraShakeTrauma = Math.max(0, this.cameraShakeTrauma - deltaTime * 1.45);
  }

  private registerMonsterHit(
    hitMessage: string,
  ): void {
    this.hitCount += 1;

    let awardedGrenades = 0;

    while (
      this.hitCount >=
      this.nextGrenadeRewardAt
    ) {
      awardedGrenades +=
        GAME_CONFIG.grenade.rewardAmount;

      this.nextGrenadeRewardAt +=
        GAME_CONFIG.grenade.rewardEveryHits;
    }

    if (awardedGrenades > 0) {
      this.grenade.addAmmo(
        awardedGrenades,
      );

      this.showTemporaryStatus(
        `${hitMessage} 타격 보상으로 유탄 +${awardedGrenades}발!`,
      );

      return;
    }

    this.showTemporaryStatus(hitMessage);
  }

  private handleReload(): void {
    if (this.grenade.isAiming) {
      this.showTemporaryStatus(
        "유탄 조준을 먼저 해제하세요.",
      );
      return;
    }

    const reloadResult =
      this.gun.startReload();

    if (reloadResult === "started") {
      this.playSound(this.soundUrls.rifleReload);
    }

    switch (reloadResult) {
      case "alreadyReloading":
        this.showTemporaryStatus(
          "이미 재장전 중입니다.",
        );
        break;

      case "full":
        this.showTemporaryStatus(
          "탄창이 이미 가득 찼습니다.",
        );
        break;

      case "started":
        this.hud.setStatus("재장전 중입니다.");
        break;
    }

    this.updateHud();
  }

  private async submitScore(): Promise<void> {
    if (
      this.state !== "gameOver" ||
      this.scoreSubmitted ||
      this.scoreSubmitting
    ) {
      return;
    }

    this.scoreSubmitting = true;
    this.hud.markScoreSubmitting();

    try {
      const entry = await this.score.registerScore(
        this.hud.getPlayerName(),
        this.selectedDifficulty,
      );

      this.scoreSubmitted = true;

      this.hud.markScoreSubmitted(
      `${entry.playerName} 기록이 등록되었습니다.`,
    );

      await this.refreshLeaderboard();
    } catch (error) {
      console.error("Failed to submit leaderboard score", error);
      this.hud.markScoreSubmissionFailed(
        "등록에 실패했습니다. 네트워크 연결을 확인한 뒤 다시 시도하세요.",
      );
    } finally {
      this.scoreSubmitting = false;
    }
  }

  private async refreshLeaderboard(): Promise<void> {
    const entries = await this.score.getLeaderboard();
    this.hud.renderLeaderboard(entries);
  }

  private async prepareGameOverLeaderboard(
    sequence: number,
  ): Promise<void> {
    const difficulty = this.selectedDifficulty;
    const distance = Math.floor(this.score.distance);
    const survivalTime = Number(this.score.time.toFixed(2));

    try {
      const entries = await this.score.getLeaderboard();

      if (
        sequence !== this.gameOverSequence ||
        this.state !== "gameOver"
      ) {
        return;
      }

      this.hud.renderLeaderboard(entries);

      const difficultyEntries = entries.filter(
        (entry) => getScoreDifficultyId(entry) === difficulty,
      );
      const fifthEntry =
        difficultyEntries[GAME_CONFIG.scoring.leaderboardSize - 1];
      const canEnterTopFive =
        !fifthEntry ||
        distance > fifthEntry.distance ||
        (
          distance === fifthEntry.distance &&
          survivalTime > fifthEntry.survivalTime
        );

      this.hud.setScoreRegistrationVisible(canEnterTopFive);

      if (canEnterTopFive) {
        this.hud.resetScoreRegistration();
        this.hud.focusPlayerName();
      }
    } catch (error) {
      console.error("Failed to prepare leaderboard registration", error);

      if (
        sequence === this.gameOverSequence &&
        this.state === "gameOver"
      ) {
        // 조회 장애 때문에 정상 기록 등록까지 막지는 않습니다.
        this.hud.setScoreRegistrationVisible(true);
        this.hud.resetScoreRegistration();
        this.hud.focusPlayerName();
      }
    }
  }

  private showTemporaryStatus(
    message: string,
  ): void {
    this.hud.showTemporaryStatus(
      message,
      () => this.getDefaultStatus(),
    );
  }

  private getDefaultStatus(): string {
    if (this.state === "title") {
      return "게임 시작 버튼을 눌러주세요.";
    }

    if (this.state === "gameOver") {
      return "괴물이 차량을 따라잡았습니다.";
    }

    if (this.grenade.isAiming) {
      return "유탄 조준 중: 위로 이동하면 멀리, 아래로 이동하면 가까워집니다.";
    }

    if (this.gun.isReloading) {
      return "재장전 중입니다.";
    }

    if (this.gun.needsReload) {
      return "탄약이 없습니다. 우클릭으로 재장전하세요.";
    }

    return "괴물이 접근 중입니다.";
  }

  private update(deltaTime: number): void {
    if (this.state !== "playing") {
      return;
    }

    this.elapsedTime += deltaTime;
    this.updateMuzzleFlash(deltaTime);
    this.updateDynamicResolution(deltaTime);
    this.score.update(deltaTime);

    const gunUpdate = this.gun.update(deltaTime);

    if (gunUpdate.reloadCompleted) {
      this.hud.showReloadComplete();
      this.showTemporaryStatus("재장전 완료.");
    }

    this.road.update(deltaTime);

    this.road.updateCamera(
      this.camera,
      deltaTime,
    );

    this.monster.update(
      deltaTime,
      this.elapsedTime,
    );

    const grenadeUpdate =
      this.grenade.update(deltaTime);

    for (
      const explosion
      of grenadeUpdate.explosions
    ) {
      this.playSound(this.soundUrls.grenadeExplosion);
      const explosionDistance = Vector3.Distance(
        explosion.position,
        this.camera.globalPosition,
      );
      this.addCameraShake(Math.max(0.16, 0.92 - explosionDistance / 95));

      const hit =
        this.monster.applyGrenadeExplosion(
          explosion.position,
          explosion.radius,
          explosion.knockbackImpulse,
          explosion.lateralImpulse,
        );

      if (hit) {
        this.registerMonsterHit(
          "유탄 명중! 폭발 충격으로 몬스터가 밀려났습니다.",
        );
      } else {
        this.showTemporaryStatus(
          "유탄이 빗나갔습니다.",
        );
      }
    }

    this.updateCameraShake(deltaTime);

    if (this.monster.hasCaughtVehicle) {
      this.endGame();
      return;
    }

    this.updateHud();
  }

  private updateHud(): void {
    this.hud.update({
      hitCount: this.hitCount,
      monsterDistance: this.monster.distance,
      currentAmmo: this.gun.currentAmmo,
      magazineSize: this.gun.magazineSize,
      shotCooldownRemaining:
        this.gun.shotCooldownRemaining,
      isReloading: this.gun.isReloading,
      reloadRemaining: this.gun.reloadRemaining,
      reloadDuration: this.gun.reloadDuration,
      needsReload: this.gun.needsReload,
      grenadeAmmo: this.grenade.currentAmmo,
      grenadeCooldownRemaining:
        this.grenade.cooldownRemaining,
      grenadeCooldownDuration:
        this.grenade.cooldownDuration,
      isGrenadeAiming:
        this.grenade.isAiming,
      grenadeReady: this.grenade.isReady,
      grenadeAimRangeFactor:
        this.grenade.aimRangeFactor,
      grenadeEstimatedDistance:
        this.grenade
          .estimatedLandingDistance,
      difficultyLabel:
        this.currentDifficulty.label,
      distanceTravelled: this.score.distance,
      survivalTime: this.score.time,
      rank: this.score.currentRank,
      monsterSpeedMultiplier:
        this.monster.speedMultiplier,
      isPlaying: this.state === "playing",
    });
  }

  private endGame(): void {
    if (this.state === "gameOver") {
      return;
    }

    this.clearMobilePointerState();
    const gameOverSequence = ++this.gameOverSequence;
    this.state = "gameOver";
    this.grenade.cancelAim();
    this.releaseGrenadePointerCapture();
    this.hud.clearTransientEffects();
    this.hud.setStatus(
      "괴물이 차량을 따라잡았습니다.",
    );

    this.hud.setFinalScore({
      distanceTravelled: this.score.distance,
      survivalTime: this.score.time,
      rank: this.score.currentRank,
      difficultyLabel:
        this.currentDifficulty.label,
    });

    this.hud.setScoreRegistrationVisible(false);
    this.hud.setGameOverVisible(true);
    this.hud.setCrosshairVisible(false);
    void this.prepareGameOverLeaderboard(gameOverSequence);
    this.updateHud();
  }

  private get currentDifficulty() {
    return GAME_CONFIG.difficulties[
      this.selectedDifficulty
    ];
  }

  private applySelectedDifficulty():
    void {
    const difficulty =
      this.currentDifficulty;

    this.monster.setDifficulty({
      approachSpeedMultiplier:
        difficulty
          .approachSpeedMultiplier,

      speedIncreaseMultiplier:
        difficulty
          .speedIncreaseMultiplier,

      maximumTimeSpeedMultiplier:
        difficulty
          .maximumTimeSpeedMultiplier,
    });

    this.gun.setMagazineSize(
      difficulty.magazineSize,
    );
  }

  private returnToTitle(): void {
    this.gameOverSequence += 1;
    this.clearMobilePointerState();
    this.state = "title";
    this.cameraShakeTrauma = 0;
    this.cameraShakeTime = 0;

    this.grenade.cancelAim();
    this.releaseGrenadePointerCapture();

    this.elapsedTime = 0;
    this.hitCount = 0;
    this.nextGrenadeRewardAt =
      GAME_CONFIG.grenade.rewardEveryHits;
    this.scoreSubmitted = false;
    this.scoreSubmitting = false;

    this.road.reset();

    this.road.updateCamera(
      this.camera,
      0,
      true,
    );

    this.monster.reset();
    this.gun.reset();
    this.grenade.reset();
    this.score.reset();

    this.hud.clearTransientEffects();
    this.hud.resetScoreRegistration();
    this.hud.setGameOverVisible(false);
    this.hud.setTitleVisible(true);
    this.hud.setCrosshairVisible(false);
    this.hud.setStatus(
      "게임 시작 버튼을 눌러주세요.",
    );

    this.updateHud();
  }

  private startRun(): void {
    if (!this.resourcesReady) {
      return;
    }

    this.clearMobilePointerState();
    this.gameOverSequence += 1;
    this.startBackgroundMusic();
    this.cameraShakeTrauma = 0;
    this.cameraShakeTime = 0;

    this.selectedDifficulty =
      this.hud.getSelectedDifficulty();

    this.applySelectedDifficulty();

    this.state = "playing";
    this.elapsedTime = 0;
    this.hitCount = 0;
    this.nextGrenadeRewardAt =
      GAME_CONFIG.grenade.rewardEveryHits;
    this.scoreSubmitted = false;
    this.scoreSubmitting = false;

    this.road.reset();

    this.road.updateCamera(
      this.camera,
      0,
      true,
    );

    this.monster.reset();
    this.gun.reset();
    this.grenade.reset();
    this.score.reset();

    this.hud.clearTransientEffects();
    this.hud.resetScoreRegistration();
    this.hud.setTitleVisible(false);
    this.hud.setGameOverVisible(false);
    this.hud.setCrosshairVisible(
      this.pointerInsideCanvas,
    );
    this.hud.setStatus(
      "괴물이 접근 중입니다.",
    );
    this.updateHud();
  }

  public start(): void {
    this.engine.runRenderLoop(() => {
      const deltaTime = Math.min(
        this.engine.getDeltaTime() / 1000,
        0.05,
      );

      this.update(deltaTime);
      this.scene.render();
    });
  }
}
