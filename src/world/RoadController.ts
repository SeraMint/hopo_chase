import {
  type AbstractMesh,
  Color3,
  Color4,
  GPUParticleSystem,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";

export interface RoadCurveConfig {
  horizontalPrimaryAmplitude: number;
  horizontalPrimaryLength: number;

  horizontalSecondaryAmplitude: number;
  horizontalSecondaryLength: number;

  verticalPrimaryAmplitude: number;
  verticalPrimaryLength: number;

  verticalSecondaryAmplitude: number;
  verticalSecondaryLength: number;
}

export interface RoadCameraConfig {
  distanceBehind: number;
  height: number;
  lookAheadDistance: number;
  targetHeight: number;
  followSharpness: number;
  maximumRoll: number;
}

export interface RoadControllerConfig {
  speed: number;

  segmentLength: number;
  segmentCount: number;
  startDistance: number;

  roadWidth: number;
  shoulderWidth: number;
  roadThickness: number;

  curve: RoadCurveConfig;
  camera: RoadCameraConfig;
}

export interface RoadSample {
  position: Vector3;
  tangent: Vector3;
  right: Vector3;
  up: Vector3;

  yaw: number;
  pitch: number;
  roll: number;

  distanceAhead: number;
}

interface CurvePoint {
  position: Vector3;
  derivative: Vector3;
  horizontalSecondDerivative: number;
}

interface RoadSegment {
  root: TransformNode;
  shoulder: Mesh;
  road: Mesh;
  centerLine: Mesh;
  sample: RoadSample;
  distanceAhead: number;
}

function createRoadSample(): RoadSample {
  return {
    position: Vector3.Zero(),
    tangent: Vector3.Zero(),
    right: Vector3.Zero(),
    up: Vector3.Zero(),
    yaw: 0,
    pitch: 0,
    roll: 0,
    distanceAhead: 0,
  };
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

function damp(
  current: number,
  target: number,
  sharpness: number,
  deltaTime: number,
): number {
  return current +
    (target - current) *
      (
        1 -
        Math.exp(
          -sharpness * deltaTime,
        )
      );
}

export class RoadController {
  private readonly scene: Scene;
  private readonly config:
    RoadControllerConfig;
  private readonly graphicsQuality: "low" | "medium" | "high";
  private readonly totalRoadLength: number;
  private readonly wrapForwardDistance: number;

  private readonly segments:
    RoadSegment[] = [];

  private readonly vehicleRoot:
    TransformNode;
  private vehicleDustEmitter!: Mesh;

  private readonly currentCurvePoint: CurvePoint = {
    position: Vector3.Zero(),
    derivative: Vector3.Zero(),
    horizontalSecondDerivative: 0,
  };

  private readonly targetCurvePoint: CurvePoint = {
    position: Vector3.Zero(),
    derivative: Vector3.Zero(),
    horizontalSecondDerivative: 0,
  };

  private readonly vehicleSample = createRoadSample();
  private readonly cameraPositionSample = createRoadSample();
  private readonly cameraTargetSample = createRoadSample();
  private readonly nearestSearchSample = createRoadSample();
  private readonly groundHeightSample = createRoadSample();
  private readonly launchOriginSample = createRoadSample();

  private progress = 0;

  public constructor(
    scene: Scene,
    config: RoadControllerConfig,
    graphicsQuality: "low" | "medium" | "high" = "high",
  ) {
    this.scene = scene;
    this.config = config;
    this.graphicsQuality = graphicsQuality;
    this.totalRoadLength = config.segmentLength * config.segmentCount;
    this.wrapForwardDistance = config.startDistance + this.totalRoadLength;

    this.vehicleRoot =
      new TransformNode(
        "vehicle-root",
        scene,
      );

    this.createRoad();
    this.createVehicle();
    this.createVehicleDust();
    this.refreshGeometry();
  }

  private createMaterial(
    name: string,
    diffuseColor: Color3,
    specularColor = new Color3(
      0.08,
      0.08,
      0.08,
    ),
  ): StandardMaterial {
    const material =
      new StandardMaterial(
        name,
        this.scene,
      );

    material.diffuseColor =
      diffuseColor;

    material.specularColor =
      specularColor;

    return material;
  }

  private createSurfaceTexture(
    name: string,
    baseColor: readonly [number, number, number],
    variation: number,
  ): RawTexture {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    let seed = name.length * 7919;

    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967295;
    };

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4;
        const broadNoise =
          Math.sin(x * 0.11) * 0.16 +
          Math.sin(y * 0.073) * 0.13;
        const grain = (random() - 0.5) * 2;
        const value = 1 + (broadNoise + grain) * variation;

        data[index] = Math.max(0, Math.min(255, baseColor[0] * value));
        data[index + 1] = Math.max(0, Math.min(255, baseColor[1] * value));
        data[index + 2] = Math.max(0, Math.min(255, baseColor[2] * value));
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

    texture.name = name;
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.uScale = 2.5;
    texture.vScale = 2.5;

    return texture;
  }

  private createSurfaceDetailTextures(
    name: string,
    normalStrength: number,
    baseRoughness: number,
  ): {
    normal: RawTexture;
    surface: RawTexture;
  } {
    const size = 256;
    const heights = new Float32Array(size * size);
    const normalData = new Uint8Array(size * size * 4);
    const surfaceData = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const broad =
          Math.sin(x * 0.19 + y * 0.07) * 0.3 +
          Math.sin(x * 0.47 - y * 0.31) * 0.18;
        const grain = Math.sin(x * 2.17 + y * 1.73) * 0.12;
        heights[y * size + x] = broad + grain;
      }
    }

    const sampleHeight = (x: number, y: number): number =>
      heights[((y + size) % size) * size + ((x + size) % size)];

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4;
        const dx = (sampleHeight(x + 1, y) - sampleHeight(x - 1, y)) * normalStrength;
        const dy = (sampleHeight(x, y + 1) - sampleHeight(x, y - 1)) * normalStrength;
        const length = Math.sqrt(dx * dx + dy * dy + 1);
        const height = sampleHeight(x, y);
        const roughness = Math.max(
          0,
          Math.min(1, baseRoughness + height * 0.09),
        );

        normalData[index] = Math.round((-dx / length * 0.5 + 0.5) * 255);
        normalData[index + 1] = Math.round((-dy / length * 0.5 + 0.5) * 255);
        normalData[index + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
        normalData[index + 3] = 255;

        surfaceData[index] = 0;
        surfaceData[index + 1] = Math.round(roughness * 255);
        surfaceData[index + 2] = 0;
        surfaceData[index + 3] = 255;
      }
    }

    const normal = RawTexture.CreateRGBATexture(
      normalData,
      size,
      size,
      this.scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    const surface = RawTexture.CreateRGBATexture(
      surfaceData,
      size,
      size,
      this.scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );

    for (const texture of [normal, surface]) {
      texture.wrapU = Texture.WRAP_ADDRESSMODE;
      texture.wrapV = Texture.WRAP_ADDRESSMODE;
      texture.uScale = 2.5;
      texture.vScale = 2.5;
    }

    normal.name = `${name}-normal`;
    surface.name = `${name}-roughness`;
    return { normal, surface };
  }

  private createRoadSurfaceMaterial(): PBRMaterial {
    const material = new PBRMaterial("curved-road-pbr-material", this.scene);
    const detail = this.createSurfaceDetailTextures(
      "asphalt-surface-detail",
      1.35,
      0.86,
    );
    material.albedoColor = new Color3(0.32, 0.34, 0.35);
    material.albedoTexture = this.createSurfaceTexture(
      "asphalt-surface-texture",
      [82, 86, 88],
      0.2,
    );
    material.metallic = 0;
    material.roughness = 1;
    material.bumpTexture = detail.normal;
    material.bumpTexture.level = 0.82;
    material.metallicTexture = detail.surface;
    material.useRoughnessFromMetallicTextureGreen = true;
    material.useMetallnessFromMetallicTextureBlue = true;
    material.useRoughnessFromMetallicTextureAlpha = false;
    material.environmentIntensity = 0.72;
    return material;
  }

  private createShoulderSurfaceMaterial(): PBRMaterial {
    const material = new PBRMaterial("curved-shoulder-pbr-material", this.scene);
    const detail = this.createSurfaceDetailTextures(
      "grass-and-soil-surface-detail",
      1.8,
      0.94,
    );
    material.albedoColor = new Color3(0.25, 0.38, 0.17);
    material.albedoTexture = this.createSurfaceTexture(
      "grass-and-soil-surface-texture",
      [72, 101, 51],
      0.36,
    );
    material.metallic = 0;
    material.roughness = 1;
    material.bumpTexture = detail.normal;
    material.bumpTexture.level = 0.68;
    material.metallicTexture = detail.surface;
    material.useRoughnessFromMetallicTextureGreen = true;
    material.useMetallnessFromMetallicTextureBlue = true;
    material.useRoughnessFromMetallicTextureAlpha = false;
    material.environmentIntensity = 0.55;
    return material;
  }

  private createPbrColorMaterial(
    name: string,
    color: Color3,
    roughness: number,
    metallic = 0,
  ): PBRMaterial {
    const material = new PBRMaterial(name, this.scene);
    material.albedoColor = color;
    material.roughness = roughness;
    material.metallic = metallic;
    material.environmentIntensity = 0.7;
    return material;
  }

  private createRoad(): void {
    const shoulderMaterial = this.createShoulderSurfaceMaterial();

    const roadMaterial = this.createRoadSurfaceMaterial();

    const lineMaterial =
      this.createMaterial(
        "curved-line-material",
        new Color3(
          0.98,
          0.75,
          0.07,
        ),
      );

    lineMaterial.emissiveColor =
      new Color3(
        0.12,
        0.085,
        0.005,
      );

    const postMaterial =
      this.createMaterial(
        "curved-post-material",
        new Color3(
          0.93,
          0.93,
          0.88,
        ),
      );

    const trunkMaterial = this.createPbrColorMaterial(
      "roadside-tree-trunk-material",
      new Color3(0.19, 0.105, 0.055),
      1,
    );
    const foliageMaterial = this.createPbrColorMaterial(
      "roadside-tree-foliage-material",
      new Color3(0.105, 0.235, 0.075),
      0.96,
    );
    const rockMaterial = this.createPbrColorMaterial(
      "roadside-rock-material",
      new Color3(0.27, 0.255, 0.22),
      0.98,
    );
    const signMaterial = this.createPbrColorMaterial(
      "roadside-sign-material",
      new Color3(0.68, 0.65, 0.51),
      0.6,
      0.18,
    );
    const distantHillMaterial = this.createPbrColorMaterial(
      "distant-hill-material",
      new Color3(0.105, 0.145, 0.105),
      1,
    );
    distantHillMaterial.environmentIntensity = 0.32;
    const distantForestMaterial = this.createPbrColorMaterial(
      "distant-forest-material",
      new Color3(0.055, 0.105, 0.062),
      1,
    );
    distantForestMaterial.environmentIntensity = 0.28;
    const scrubMaterial = this.createPbrColorMaterial(
      "roadside-scrub-material",
      new Color3(0.16, 0.285, 0.105),
      0.98,
    );

    const treeTrunkTemplate = MeshBuilder.CreateCylinder(
      "roadside-tree-trunk-template",
      { height: 3.5, diameterTop: 0.26, diameterBottom: 0.46, tessellation: 7 },
      this.scene,
    );
    treeTrunkTemplate.material = trunkMaterial;
    treeTrunkTemplate.isVisible = false;
    treeTrunkTemplate.isPickable = false;

    const treeCrownTemplate = MeshBuilder.CreateSphere(
      "roadside-tree-crown-template",
      { diameter: 2.45, segments: 6 },
      this.scene,
    );
    treeCrownTemplate.material = foliageMaterial;
    treeCrownTemplate.isVisible = false;
    treeCrownTemplate.isPickable = false;
    treeCrownTemplate.convertToFlatShadedMesh();

    const rockTemplate = MeshBuilder.CreateSphere(
      "roadside-rock-template",
      { diameter: 1.05, segments: 5 },
      this.scene,
    );
    rockTemplate.material = rockMaterial;
    rockTemplate.isVisible = false;
    rockTemplate.isPickable = false;
    rockTemplate.convertToFlatShadedMesh();

    const signPostTemplate = MeshBuilder.CreateCylinder(
      "roadside-sign-post-template",
      { height: 2.25, diameter: 0.1, tessellation: 8 },
      this.scene,
    );
    signPostTemplate.material = signMaterial;
    signPostTemplate.isVisible = false;
    signPostTemplate.isPickable = false;

    const signPlateTemplate = MeshBuilder.CreateBox(
      "roadside-sign-plate-template",
      { width: 0.95, height: 0.72, depth: 0.07 },
      this.scene,
    );
    signPlateTemplate.material = signMaterial;
    signPlateTemplate.isVisible = false;
    signPlateTemplate.isPickable = false;

    const distantHillTemplate = MeshBuilder.CreateSphere(
      "distant-hill-template",
      { diameter: 8, segments: 7 },
      this.scene,
    );
    distantHillTemplate.material = distantHillMaterial;
    distantHillTemplate.isVisible = false;
    distantHillTemplate.isPickable = false;
    distantHillTemplate.convertToFlatShadedMesh();

    const distantPineTemplate = MeshBuilder.CreateCylinder(
      "distant-pine-template",
      {
        height: 7.5,
        diameterTop: 0.05,
        diameterBottom: 3.5,
        tessellation: 6,
      },
      this.scene,
    );
    distantPineTemplate.material = distantForestMaterial;
    distantPineTemplate.isVisible = false;
    distantPineTemplate.isPickable = false;

    const scrubTemplate = MeshBuilder.CreateSphere(
      "roadside-scrub-template",
      { diameter: 1.35, segments: 5 },
      this.scene,
    );
    scrubTemplate.material = scrubMaterial;
    scrubTemplate.isVisible = false;
    scrubTemplate.isPickable = false;
    scrubTemplate.convertToFlatShadedMesh();

    const segmentDepth =
      this.config.segmentLength *
      1.12;

    const treeInterval = this.graphicsQuality === "high"
      ? 5
      : this.graphicsQuality === "medium"
        ? 8
        : 10;
    const rockInterval = this.graphicsQuality === "high"
      ? 7
      : this.graphicsQuality === "medium"
        ? 9
        : 13;
    const distantSceneryStride = this.graphicsQuality === "high"
      ? 2
      : this.graphicsQuality === "medium"
        ? 3
        : 4;

    for (
      let index = 0;
      index <
      this.config.segmentCount;
      index += 1
    ) {
      const root =
        new TransformNode(
          `road-segment-root-${index}`,
          this.scene,
        );

      const shoulder =
        MeshBuilder.CreateBox(
          `road-shoulder-${index}`,
          {
            width:
              this.config.shoulderWidth,
            height:
              this.config
                .roadThickness,
            depth: segmentDepth,
          },
          this.scene,
        );

      shoulder.parent = root;
      shoulder.position.y =
        -this.config
          .roadThickness *
        0.65;

      shoulder.material =
        shoulderMaterial;

      shoulder.isPickable = false;
      shoulder.receiveShadows = true;

      const road =
        MeshBuilder.CreateBox(
          `road-surface-${index}`,
          {
            width:
              this.config.roadWidth,
            height:
              this.config
                .roadThickness,
            depth: segmentDepth,
          },
          this.scene,
        );

      road.parent = root;
      road.material = roadMaterial;
      road.isPickable = false;
      road.receiveShadows = true;

      const centerLine =
        MeshBuilder.CreateBox(
          `road-center-line-${index}`,
          {
            width: 0.17,
            height: 0.025,
            depth:
              this.config
                .segmentLength *
              0.58,
          },
          this.scene,
        );

      centerLine.parent = root;
      centerLine.position.y =
        this.config
          .roadThickness *
          0.58;

      centerLine.material =
        lineMaterial;

      centerLine.isPickable = false;

      /**
       * 한 세그먼트씩 건너뛰어 황색 점선을 만듭니다.
       */
      centerLine.setEnabled(
        index % 2 === 0,
      );

      if (index % 3 === 0) {
        const leftPost =
          MeshBuilder.CreateBox(
            `road-left-post-${index}`,
            {
              width: 0.22,
              height: 1.25,
              depth: 0.22,
            },
            this.scene,
          );

        const rightPost =
          MeshBuilder.CreateBox(
            `road-right-post-${index}`,
            {
              width: 0.22,
              height: 1.25,
              depth: 0.22,
            },
            this.scene,
          );

        leftPost.material =
          postMaterial;

        rightPost.material =
          postMaterial;

        leftPost.isPickable = false;
        rightPost.isPickable = false;

        leftPost.parent = root;
        leftPost.position.set(
          -(this.config.roadWidth * 0.5 + 1.05),
          0.62,
          0,
        );

        rightPost.parent = root;
        rightPost.position.set(
          this.config.roadWidth * 0.5 + 1.05,
          0.62,
          0,
        );
      }

      if (index % treeInterval === 1) {
        const side = index % 8 < 4 ? -1 : 1;
        const offset = this.config.roadWidth * 0.5 + 4.2 + (index % 3);
        const treeRoot = new TransformNode(`roadside-tree-${index}`, this.scene);
        treeRoot.parent = root;
        treeRoot.position.set(side * offset, 0, -0.7);
        treeRoot.scaling.setAll(0.82 + (index % 5) * 0.075);

        const trunk = treeTrunkTemplate.createInstance(`roadside-tree-trunk-${index}`);
        trunk.parent = treeRoot;
        trunk.position.y = 1.65;
        trunk.material = trunkMaterial;
        trunk.isPickable = false;

        for (let crownIndex = 0; crownIndex < 3; crownIndex += 1) {
          const crown = treeCrownTemplate.createInstance(
            `roadside-tree-crown-${index}-${crownIndex}`,
          );
          crown.parent = treeRoot;
          crown.position.set(
            (crownIndex - 1) * 0.42,
            3.2 + crownIndex * 0.56,
            (crownIndex % 2) * 0.35,
          );
          const crownScale = 1 - crownIndex * 0.115;
          crown.scaling.set(1.05 * crownScale, 0.85 * crownScale, 1.12 * crownScale);
          crown.isPickable = false;
        }
      }

      if (index % rockInterval === 2) {
        const side = index % 10 < 5 ? 1 : -1;
        const rock = rockTemplate.createInstance(`roadside-rock-${index}`);
        rock.parent = root;
        rock.position.set(
          side * (this.config.roadWidth * 0.5 + 2.4 + (index % 4) * 0.55),
          0.15,
          0.65,
        );
        const rockScale = 1 + (index % 3) * 0.17;
        rock.scaling.set(1.3 * rockScale, 0.68 * rockScale, 0.9 * rockScale);
        rock.rotation.set(index * 0.19, index * 0.31, index * 0.11);
        rock.isPickable = false;
      }

      if (index % 11 === 4) {
        const side = index % 22 < 11 ? -1 : 1;
        const signRoot = new TransformNode(`roadside-sign-${index}`, this.scene);
        signRoot.parent = root;
        signRoot.position.set(side * (this.config.roadWidth * 0.5 + 1.6), 0, 0);
        signRoot.rotation.y = side < 0 ? 0.08 : -0.08;

        const signPost = signPostTemplate.createInstance(`roadside-sign-post-${index}`);
        signPost.parent = signRoot;
        signPost.position.y = 1.05;
        signPost.isPickable = false;

        const signPlate = signPlateTemplate.createInstance(`roadside-sign-plate-${index}`);
        signPlate.parent = signRoot;
        signPlate.position.y = 2.02;
        signPlate.isPickable = false;
      }

      // Recycled with each road segment so the horizon stays populated without
      // constructing and destroying scenery while the vehicle advances.
      for (const side of [-1, 1]) {
        const hasDistantScenery =
          index % distantSceneryStride === 0;

        if (
          hasDistantScenery &&
          (index + (side > 0 ? 1 : 0)) % 3 === 0
        ) {
          const hill = distantHillTemplate.createInstance(
            `distant-hill-${index}-${side}`,
          );
          hill.parent = root;
          hill.position.set(
            side * (28 + (index % 4) * 7),
            -2.4,
            1.5 - (index % 3) * 1.2,
          );
          hill.scaling.set(2.6 + (index % 3) * 0.45, 0.72, 1.65);
          hill.rotation.y = index * 0.37;
          hill.isPickable = false;
        }

        if (hasDistantScenery) {
          const pine = distantPineTemplate.createInstance(
            `distant-pine-${index}-${side}`,
          );
          pine.parent = root;
          pine.position.set(
            side * (15.5 + (index % 5) * 2.8),
            3.1,
            (index % 3 - 1) * 2.1,
          );
          const pineScale = 0.72 + (index % 4) * 0.12;
          pine.scaling.set(pineScale, pineScale, pineScale);
          pine.rotation.y = index * 0.41 + side;
          pine.isPickable = false;
        }

        if (
          hasDistantScenery &&
          (index + (side > 0 ? 2 : 0)) % 3 === 1
        ) {
          const scrub = scrubTemplate.createInstance(
            `roadside-scrub-${index}-${side}`,
          );
          scrub.parent = root;
          scrub.position.set(
            side * (this.config.roadWidth * 0.5 + 2.7 + (index % 3) * 0.8),
            0.34,
            -1.6 + (index % 4) * 0.9,
          );
          scrub.scaling.set(1.15, 0.62 + (index % 2) * 0.16, 0.82);
          scrub.rotation.y = index * 0.63;
          scrub.isPickable = false;
        }
      }

      this.segments.push({
        root,
        shoulder,
        road,
        centerLine,
        sample: createRoadSample(),

        distanceAhead:
          this.config.startDistance +
          index *
            this.config
              .segmentLength,
      });
    }
  }

  private createVehicle(): void {
    const vehicleMaterial = this.createPbrColorMaterial(
      "vehicle-body-material",
      new Color3(0.095, 0.14, 0.17),
      0.34,
      0.72,
    );
    const darkMetalMaterial = this.createPbrColorMaterial(
      "vehicle-dark-metal-material",
      new Color3(0.025, 0.03, 0.032),
      0.46,
      0.65,
    );
    const tireMaterial = this.createPbrColorMaterial(
      "vehicle-tire-material",
      new Color3(0.012, 0.013, 0.014),
      0.98,
    );
    const glassMaterial = this.createPbrColorMaterial(
      "vehicle-glass-material",
      new Color3(0.055, 0.12, 0.15),
      0.12,
      0.15,
    );
    glassMaterial.alpha = 0.82;
    glassMaterial.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;

    const tailLightMaterial = this.createPbrColorMaterial(
      "vehicle-tail-light-material",
      new Color3(0.42, 0.015, 0.008),
      0.28,
    );
    tailLightMaterial.emissiveColor = new Color3(1, 0.025, 0.008);
    tailLightMaterial.emissiveIntensity = 1.8;

    const body =
      MeshBuilder.CreateBox(
        "vehicle-body",
        {
          width: 5.8,
          height: 1.2,
          depth: 3,
        },
        this.scene,
      );

    body.parent = this.vehicleRoot;
    body.position.y = 0.72;
    body.position.z = -0.4;
    body.material = vehicleMaterial;
    body.isPickable = false;
    this.vehicleDustEmitter = body;

    const cabin = MeshBuilder.CreateBox(
      "vehicle-cabin",
      { width: 3.65, height: 1.25, depth: 1.45 },
      this.scene,
    );
    cabin.parent = this.vehicleRoot;
    cabin.position.set(0, 1.58, -0.58);
    cabin.material = vehicleMaterial;
    cabin.isPickable = false;

    const rearWindow = MeshBuilder.CreateBox(
      "vehicle-rear-window",
      { width: 2.7, height: 0.72, depth: 0.045 },
      this.scene,
    );
    rearWindow.parent = this.vehicleRoot;
    rearWindow.position.set(0, 1.72, 0.17);
    rearWindow.material = glassMaterial;
    rearWindow.isPickable = false;

    const rail =
      MeshBuilder.CreateBox(
        "vehicle-rail",
        {
          width: 6.2,
          height: 0.22,
          depth: 0.25,
        },
        this.scene,
      );

    rail.parent = this.vehicleRoot;
    rail.position.y = 1.55;
    rail.position.z = 1.05;
    rail.material = vehicleMaterial;
    rail.isPickable = false;

    const bumper = MeshBuilder.CreateBox(
      "vehicle-rear-bumper",
      { width: 5.95, height: 0.28, depth: 0.34 },
      this.scene,
    );
    bumper.parent = this.vehicleRoot;
    bumper.position.set(0, 0.52, -1.86);
    bumper.material = darkMetalMaterial;
    bumper.isPickable = false;

    for (const side of [-1, 1]) {
      for (const axleZ of [-1.15, 0.88]) {
        const wheel = MeshBuilder.CreateCylinder(
          `vehicle-wheel-${side}-${axleZ}`,
          { height: 0.42, diameter: 0.92, tessellation: 18 },
          this.scene,
        );
        wheel.parent = this.vehicleRoot;
        wheel.position.set(side * 2.72, 0.52, axleZ);
        wheel.rotation.z = Math.PI / 2;
        wheel.material = tireMaterial;
        wheel.isPickable = false;
      }

      const tailLight = MeshBuilder.CreateBox(
        `vehicle-tail-light-${side}`,
        { width: 0.68, height: 0.32, depth: 0.08 },
        this.scene,
      );
      tailLight.parent = this.vehicleRoot;
      tailLight.position.set(side * 2.05, 0.92, -1.93);
      tailLight.material = tailLightMaterial;
      tailLight.isPickable = false;
    }
  }

  private createVehicleDust(): void {
    if (!GPUParticleSystem.IsSupported) {
      return;
    }

    const size = 32;
    const data = new Uint8Array(size * size * 4);
    const center = (size - 1) * 0.5;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4;
        const distance = Math.sqrt((x - center) ** 2 + (y - center) ** 2) / center;
        const alpha = Math.max(0, 1 - distance);
        data[index] = 214;
        data[index + 1] = 191;
        data[index + 2] = 151;
        data[index + 3] = Math.round(alpha * alpha * 210);
      }
    }

    const particleTexture = RawTexture.CreateRGBATexture(
      data,
      size,
      size,
      this.scene,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    particleTexture.name = "vehicle-dust-particle-texture";

    const particleCapacity = this.graphicsQuality === "low"
      ? 90
      : this.graphicsQuality === "medium"
        ? 180
        : 280;
    const dust = new GPUParticleSystem(
      "vehicle-road-dust",
      { capacity: particleCapacity },
      this.scene,
    );
    dust.particleTexture = particleTexture;
    dust.emitter = this.vehicleDustEmitter;
    dust.minEmitBox = new Vector3(-2.2, 0.08, -1.45);
    dust.maxEmitBox = new Vector3(2.2, 0.25, -1.1);
    dust.direction1 = new Vector3(-0.35, 0.45, -2.8);
    dust.direction2 = new Vector3(0.35, 1.05, -4.2);
    dust.color1 = new Color4(0.58, 0.46, 0.31, 0.34);
    dust.color2 = new Color4(0.38, 0.32, 0.24, 0.18);
    dust.colorDead = new Color4(0.25, 0.25, 0.24, 0);
    dust.minLifeTime = 0.45;
    dust.maxLifeTime = 1.15;
    dust.minSize = 0.28;
    dust.maxSize = 1.25;
    dust.emitRate = this.graphicsQuality === "low"
      ? 18
      : this.graphicsQuality === "medium"
        ? 36
        : 55;
    dust.minEmitPower = 0.45;
    dust.maxEmitPower = 1.2;
    dust.gravity = new Vector3(0, 0.22, 0);
    dust.start();
  }

  public getVehicleMeshes(): readonly AbstractMesh[] {
    return this.vehicleRoot.getChildMeshes();
  }

  private getCurvePointToRef(
    progress: number,
    result: CurvePoint,
  ): void {
    const curve =
      this.config.curve;

    const primaryHorizontalPhase =
      progress /
      curve.horizontalPrimaryLength;

    const secondaryHorizontalPhase =
      progress /
        curve
          .horizontalSecondaryLength +
      0.85;

    const primaryVerticalPhase =
      progress /
        curve.verticalPrimaryLength +
      0.5;

    const secondaryVerticalPhase =
      progress /
        curve
          .verticalSecondaryLength +
      1.4;

    const x =
      curve
        .horizontalPrimaryAmplitude *
        Math.sin(
          primaryHorizontalPhase,
        ) +
      curve
        .horizontalSecondaryAmplitude *
        Math.sin(
          secondaryHorizontalPhase,
        );

    const y =
      curve.verticalPrimaryAmplitude *
        Math.sin(
          primaryVerticalPhase,
        ) +
      curve
        .verticalSecondaryAmplitude *
        Math.sin(
          secondaryVerticalPhase,
        );

    const derivativeX =
      (
        curve
          .horizontalPrimaryAmplitude /
        curve.horizontalPrimaryLength
      ) *
        Math.cos(
          primaryHorizontalPhase,
        ) +
      (
        curve
          .horizontalSecondaryAmplitude /
        curve.horizontalSecondaryLength
      ) *
        Math.cos(
          secondaryHorizontalPhase,
        );

    const derivativeY =
      (
        curve
          .verticalPrimaryAmplitude /
        curve.verticalPrimaryLength
      ) *
        Math.cos(
          primaryVerticalPhase,
        ) +
      (
        curve
          .verticalSecondaryAmplitude /
        curve.verticalSecondaryLength
      ) *
        Math.cos(
          secondaryVerticalPhase,
        );

    const secondDerivativeX =
      -(
        curve
          .horizontalPrimaryAmplitude /
        (
          curve
            .horizontalPrimaryLength *
          curve
            .horizontalPrimaryLength
        )
      ) *
        Math.sin(
          primaryHorizontalPhase,
        ) -
      (
        curve
          .horizontalSecondaryAmplitude /
        (
          curve
            .horizontalSecondaryLength *
          curve
            .horizontalSecondaryLength
        )
      ) *
        Math.sin(
          secondaryHorizontalPhase,
        );

    result.position.set(
      x,
      y,
      progress,
    );

    result.derivative.set(
      derivativeX,
      derivativeY,
      1,
    );

    result.horizontalSecondDerivative =
      secondDerivativeX;
  }

  /**
   * 차량 위치를 원점으로 보고, 현재 도로 진행 방향을
   * 화면의 +Z 방향에 맞춘 상대 좌표를 반환합니다.
   */
  public sample(
    distanceAhead: number,
    lateralOffset = 0,
    verticalOffset = 0,
    result?: RoadSample,
  ): RoadSample {
    const currentPoint =
      this.currentCurvePoint;
    const targetPoint =
      this.targetCurvePoint;

    this.getCurvePointToRef(
      this.progress,
      currentPoint,
    );

    this.getCurvePointToRef(
      this.progress + distanceAhead,
      targetPoint,
    );

    const currentHeading =
      Math.atan2(
        currentPoint.derivative.x,
        currentPoint.derivative.z,
      );

    const cosine =
      Math.cos(currentHeading);

    const sine =
      Math.sin(currentHeading);

    const deltaX =
      targetPoint.position.x -
      currentPoint.position.x;
    const deltaY =
      targetPoint.position.y -
      currentPoint.position.y;
    const deltaZ =
      targetPoint.position.z -
      currentPoint.position.z;

    const localPosition =
      result?.position ?? Vector3.Zero();

    localPosition.set(
      cosine * deltaX - sine * deltaZ,
      deltaY,
      sine * deltaX + cosine * deltaZ,
    );

    const derivative =
      targetPoint.derivative;

    const localTangent =
      result?.tangent ?? Vector3.Zero();

    localTangent.set(
      cosine * derivative.x - sine * derivative.z,
      derivative.y,
      sine * derivative.x + cosine * derivative.z,
    ).normalize();

    const right =
      result?.right ?? Vector3.Zero();

    right.set(
      localTangent.z,
      0,
      -localTangent.x,
    );

    if (
      right.lengthSquared() <
      0.0001
    ) {
      right.set(1, 0, 0);
    } else {
      right.normalize();
    }

    const up = result?.up ?? Vector3.Zero();

    up.set(
      localTangent.y * right.z,
      localTangent.z * right.x -
        localTangent.x * right.z,
      -localTangent.y * right.x,
    ).normalize();

    localPosition.addInPlaceFromFloats(
      right.x * lateralOffset +
        up.x * verticalOffset,
      right.y * lateralOffset +
        up.y * verticalOffset,
      right.z * lateralOffset +
        up.z * verticalOffset,
    );

    const yaw =
      Math.atan2(
        localTangent.x,
        localTangent.z,
      );

    const pitch =
      -Math.asin(
        clamp(
          localTangent.y,
          -1,
          1,
        ),
      );

    const roll = clamp(
      -targetPoint
        .horizontalSecondDerivative *
        12,
      -0.075,
      0.075,
    );

    if (result) {
      result.yaw = yaw;
      result.pitch = pitch;
      result.roll = roll;
      result.distanceAhead = distanceAhead;
      return result;
    }

    return {
      position: localPosition,
      tangent: localTangent,
      right,
      up,
      yaw,
      pitch,
      roll,
      distanceAhead,
    };
  }

  /**
   * 임의의 월드 좌표와 가장 가까운 도로 진행 거리를
   * 반복 투영으로 근사합니다.
   */
  public getNearestSample(
    worldPosition: Vector3,
    result?: RoadSample,
  ): RoadSample {
    let distanceAhead =
      clamp(
        worldPosition.z,
        this.config.startDistance,
        this.config.startDistance +
          this.config.segmentLength *
            (
              this.config
                .segmentCount -
              1
            ),
      );

    for (
      let iteration = 0;
      iteration < 5;
      iteration += 1
    ) {
      const sample =
        this.sample(
          distanceAhead,
          0,
          0,
          this.nearestSearchSample,
        );

      const errorX =
        worldPosition.x -
        sample.position.x;

      const errorZ =
        worldPosition.z -
        sample.position.z;

      const tangentLengthSquared =
        sample.tangent.x *
          sample.tangent.x +
        sample.tangent.z *
          sample.tangent.z;

      if (
        tangentLengthSquared <
        0.0001
      ) {
        break;
      }

      distanceAhead +=
        (
          errorX *
            sample.tangent.x +
          errorZ *
            sample.tangent.z
        ) /
        tangentLengthSquared;

      distanceAhead =
        clamp(
          distanceAhead,
          this.config.startDistance,
          this.config.startDistance +
            this.config
              .segmentLength *
              (
                this.config
                  .segmentCount -
                1
              ),
        );
    }

    return this.sample(
      distanceAhead,
      0,
      0,
      result,
    );
  }

  public getGroundHeight(
    worldPosition: Vector3,
  ): number {
    return (
      this.getNearestSample(
        worldPosition,
        this.groundHeightSample,
      ).position.y +
      this.config.roadThickness *
        0.55
    );
  }

  public getLaunchOrigin(
    distanceAhead: number,
    lateralOffset: number,
    heightOffset: number,
    result?: Vector3,
  ): Vector3 {
    if (!result) {
      return this.sample(
        distanceAhead,
        lateralOffset,
        heightOffset,
      ).position;
    }

    this.sample(
      distanceAhead,
      lateralOffset,
      heightOffset,
      this.launchOriginSample,
    );

    result.copyFrom(
      this.launchOriginSample.position,
    );

    return result;
  }

  public update(
    deltaTime: number,
  ): void {
    const travelledDistance =
      this.config.speed *
      deltaTime;

    /**
     * 카메라는 차량 앞쪽에서 뒤를 바라봅니다.
     * 따라서 차량의 실제 진행 방향은 도로 곡선의
     * 음수 방향이며, 뒤쪽 풍경은 화면의 +Z 방향으로
     * 흘러가야 몬스터가 차량을 추격하는 구도가 됩니다.
     */
    this.progress -=
      travelledDistance;

    for (
      const segment
      of this.segments
    ) {
      segment.distanceAhead +=
        travelledDistance;

      if (
        segment.distanceAhead >
        this.wrapForwardDistance
      ) {
        segment.distanceAhead -=
          this.totalRoadLength;
      }
    }

    this.refreshGeometry();
  }

  private refreshGeometry(): void {
    for (
      const segment
      of this.segments
    ) {
      const sample =
        this.sample(
          segment.distanceAhead,
          0,
          0,
          segment.sample,
        );

      segment.root.position.copyFrom(
        sample.position,
      );

      segment.root.rotation.set(
        sample.pitch,
        sample.yaw,
        sample.roll,
      );

    }

    const vehicleSample =
      this.sample(0, 0, 0, this.vehicleSample);

    this.vehicleRoot.position.copyFrom(
      vehicleSample.position,
    );

    /**
     * RoadSample의 tangent는 차량 뒤쪽(+거리)을 향합니다.
     * 차량은 반대쪽인 실제 진행 방향을 바라봐야 합니다.
     */
    this.vehicleRoot.rotation.set(
      -vehicleSample.pitch,
      vehicleSample.yaw +
        Math.PI,
      -vehicleSample.roll * 0.55,
    );
  }

  public updateCamera(
    camera: UniversalCamera,
    deltaTime: number,
    immediate = false,
  ): void {
    const cameraConfig =
      this.config.camera;

    const cameraRoadSample =
      this.sample(
        -cameraConfig
          .distanceBehind,
        0,
        cameraConfig.height,
        this.cameraPositionSample,
      );

    const targetSample =
      this.sample(
        cameraConfig
          .lookAheadDistance,
        0,
        cameraConfig.targetHeight,
        this.cameraTargetSample,
      );

    const interpolation =
      immediate
        ? 1
        : (
          1 -
          Math.exp(
            -cameraConfig
              .followSharpness *
              deltaTime,
          )
        );

    Vector3.LerpToRef(
      camera.position,
      cameraRoadSample.position,
      interpolation,
      camera.position,
    );

    camera.setTarget(
      targetSample.position,
    );

    const desiredRoll =
      clamp(
        targetSample.roll * 0.72,
        -cameraConfig.maximumRoll,
        cameraConfig.maximumRoll,
      );

    camera.rotation.z =
      immediate
        ? desiredRoll
        : damp(
          camera.rotation.z,
          desiredRoll,
          cameraConfig
            .followSharpness,
          deltaTime,
        );
  }

  public reset(): void {
    this.progress = 0;

    this.segments.forEach(
      (segment, index) => {
        segment.distanceAhead =
          this.config.startDistance +
          index *
            this.config
              .segmentLength;
      },
    );

    this.refreshGeometry();
  }
}
