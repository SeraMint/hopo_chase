import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
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
  leftPost: Mesh | null;
  rightPost: Mesh | null;
  distanceAhead: number;
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

  private readonly segments:
    RoadSegment[] = [];

  private readonly vehicleRoot:
    TransformNode;

  private progress = 0;

  public constructor(
    scene: Scene,
    config: RoadControllerConfig,
  ) {
    this.scene = scene;
    this.config = config;

    this.vehicleRoot =
      new TransformNode(
        "vehicle-root",
        scene,
      );

    this.createRoad();
    this.createVehicle();
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

  private createRoad(): void {
    const shoulderMaterial =
      this.createMaterial(
        "curved-shoulder-material",
        new Color3(
          0.37,
          0.61,
          0.27,
        ),
      );

    const roadMaterial =
      this.createMaterial(
        "curved-road-material",
        new Color3(
          0.39,
          0.41,
          0.43,
        ),
      );

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

    const segmentDepth =
      this.config.segmentLength *
      1.12;

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

      let leftPost: Mesh | null = null;
      let rightPost: Mesh | null = null;

      if (index % 3 === 0) {
        leftPost =
          MeshBuilder.CreateBox(
            `road-left-post-${index}`,
            {
              width: 0.22,
              height: 1.25,
              depth: 0.22,
            },
            this.scene,
          );

        rightPost =
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
      }

      this.segments.push({
        root,
        shoulder,
        road,
        centerLine,
        leftPost,
        rightPost,

        distanceAhead:
          this.config.startDistance +
          index *
            this.config
              .segmentLength,
      });
    }
  }

  private createVehicle(): void {
    const vehicleMaterial =
      this.createMaterial(
        "vehicle-material",
        new Color3(
          0.18,
          0.23,
          0.27,
        ),
      );

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
  }

  private getCurvePoint(
    progress: number,
  ): CurvePoint {
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

    return {
      position: new Vector3(
        x,
        y,
        progress,
      ),

      derivative: new Vector3(
        derivativeX,
        derivativeY,
        1,
      ),

      horizontalSecondDerivative:
        secondDerivativeX,
    };
  }

  /**
   * 차량 위치를 원점으로 보고, 현재 도로 진행 방향을
   * 화면의 +Z 방향에 맞춘 상대 좌표를 반환합니다.
   */
  public sample(
    distanceAhead: number,
    lateralOffset = 0,
    verticalOffset = 0,
  ): RoadSample {
    const currentPoint =
      this.getCurvePoint(
        this.progress,
      );

    const targetPoint =
      this.getCurvePoint(
        this.progress +
          distanceAhead,
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

    const delta =
      targetPoint.position.subtract(
        currentPoint.position,
      );

    const localPosition =
      new Vector3(
        cosine * delta.x -
          sine * delta.z,

        delta.y,

        sine * delta.x +
          cosine * delta.z,
      );

    const derivative =
      targetPoint.derivative;

    const localTangent =
      new Vector3(
        cosine * derivative.x -
          sine * derivative.z,

        derivative.y,

        sine * derivative.x +
          cosine * derivative.z,
      ).normalize();

    const right =
      new Vector3(
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

    const up =
      Vector3.Cross(
        localTangent,
        right,
      ).normalize();

    localPosition.addInPlace(
      right.scale(
        lateralOffset,
      ),
    );

    localPosition.addInPlace(
      up.scale(
        verticalOffset,
      ),
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
    );
  }

  public getGroundHeight(
    worldPosition: Vector3,
  ): number {
    return (
      this.getNearestSample(
        worldPosition,
      ).position.y +
      this.config.roadThickness *
        0.55
    );
  }

  public getLaunchOrigin(
    distanceAhead: number,
    lateralOffset: number,
    heightOffset: number,
  ): Vector3 {
    return this.sample(
      distanceAhead,
      lateralOffset,
      heightOffset,
    ).position;
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

    const totalRoadLength =
      this.config.segmentLength *
      this.config.segmentCount;

    const wrapForwardDistance =
      this.config.startDistance +
      totalRoadLength;

    for (
      const segment
      of this.segments
    ) {
      segment.distanceAhead +=
        travelledDistance;

      if (
        segment.distanceAhead >
        wrapForwardDistance
      ) {
        segment.distanceAhead -=
          totalRoadLength;
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
        );

      segment.root.position.copyFrom(
        sample.position,
      );

      segment.root.rotation.set(
        sample.pitch,
        sample.yaw,
        sample.roll,
      );

      if (segment.leftPost) {
        const leftSample =
          this.sample(
            segment.distanceAhead,
            -(
              this.config.roadWidth /
                2 +
              1.05
            ),
            0.62,
          );

        segment.leftPost.position.copyFrom(
          leftSample.position,
        );

        segment.leftPost.rotation.y =
          leftSample.yaw;
      }

      if (segment.rightPost) {
        const rightSample =
          this.sample(
            segment.distanceAhead,
            this.config.roadWidth /
                2 +
              1.05,
            0.62,
          );

        segment.rightPost.position.copyFrom(
          rightSample.position,
        );

        segment.rightPost.rotation.y =
          rightSample.yaw;
      }
    }

    const vehicleSample =
      this.sample(0);

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
      );

    const targetSample =
      this.sample(
        cameraConfig
          .lookAheadDistance,
        0,
        cameraConfig.targetHeight,
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

    camera.position.copyFrom(
      Vector3.Lerp(
        camera.position,
        cameraRoadSample.position,
        interpolation,
      ),
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
