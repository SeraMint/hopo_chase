import type {
  LeaderboardRepository,
  ScoreEntry,
} from "./LeaderboardRepository";
import type {
  DifficultyId,
} from "../game/GameConfig";

export interface RankDefinition {
  name: string;
  minDistance: number;
}

export interface ScoreControllerConfig {
  vehicleMetersPerSecond: number;
  ranks: readonly RankDefinition[];
}

function normalizePlayerName(
  name: string,
): string {
  const normalized =
    name.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return "PLAYER";
  }

  return normalized.slice(0, 12);
}

export class ScoreController {
  private readonly config: ScoreControllerConfig;
  private readonly repository: LeaderboardRepository;
  private elapsedTime = 0;
  private distanceTravelled = 0;

  public constructor(
    config: ScoreControllerConfig,
    repository: LeaderboardRepository,
  ) {
    this.config = config;
    this.repository = repository;
  }

  public update(deltaTime: number): void {
    this.elapsedTime += deltaTime;

    this.distanceTravelled +=
      this.config.vehicleMetersPerSecond *
      deltaTime;
  }

  public reset(): void {
    this.elapsedTime = 0;
    this.distanceTravelled = 0;
  }

  public async registerScore(
    playerName: string,
    difficulty: DifficultyId,
  ): Promise<ScoreEntry> {
    const entry: ScoreEntry = {
      id:
        `${Date.now()}-` +
        Math.random()
          .toString(36)
          .slice(2, 10),

      playerName:
        normalizePlayerName(
          playerName,
        ),

      distance:
        Math.floor(
          this.distanceTravelled,
        ),

      survivalTime:
        Number(
          this.elapsedTime.toFixed(2),
        ),

      rank:
        this.currentRank,

      difficulty,

      createdAt:
        new Date().toISOString(),
    };

    return this.repository.save(entry);
  }

  public getLeaderboard(): Promise<ScoreEntry[]> {
    return this.repository.getAll();
  }

  public get distance(): number {
    return this.distanceTravelled;
  }

  public get time(): number {
    return this.elapsedTime;
  }

  public get currentRank(): string {
    let currentRank =
      this.config.ranks[0]?.name ??
      "브론즈";

    for (
      const rank
      of this.config.ranks
    ) {
      if (
        this.distanceTravelled >=
        rank.minDistance
      ) {
        currentRank = rank.name;
      }
    }

    return currentRank;
  }
}
