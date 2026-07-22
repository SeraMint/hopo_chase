import type { User } from "@supabase/supabase-js";

import type { DifficultyId } from "../game/GameConfig";
import { supabase } from "../lib/supabase";

const LEADERBOARD_REQUEST_TIMEOUT_MS = 4_000;

export interface ScoreEntry {
  id: string;
  playerName: string;
  distance: number;
  survivalTime: number;
  rank: string;
  difficulty?: string;
  createdAt: string;
}

export function getScoreDifficultyId(
  entry: ScoreEntry,
): DifficultyId | undefined {
  switch (entry.difficulty) {
    case "easy":
    case "\uC26C\uC6C0":
      return "easy";
    case "normal":
    case "\uBCF4\uD1B5":
      return "normal";
    case "hard":
    case "\uC5B4\uB824\uC6C0":
      return "hard";
    default:
      return undefined;
  }
}

function sortScores(
  entries: ScoreEntry[],
): ScoreEntry[] {
  return entries.sort(
    (left, right) =>
      right.distance - left.distance ||
      right.survivalTime - left.survivalTime,
  );
}

export interface LeaderboardRepository {
  getAll(): Promise<ScoreEntry[]>;
  save(entry: ScoreEntry): Promise<ScoreEntry>;
  clear(): Promise<void>;
}

function isScoreEntry(
  value: unknown,
): value is ScoreEntry {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const candidate =
    value as Partial<ScoreEntry>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.playerName ===
      "string" &&
    typeof candidate.distance ===
      "number" &&
    Number.isFinite(candidate.distance) &&
    typeof candidate.survivalTime ===
      "number" &&
    Number.isFinite(
      candidate.survivalTime,
    ) &&
    typeof candidate.rank === "string" &&
    (
      candidate.difficulty === undefined ||
      typeof candidate.difficulty ===
        "string"
    ) &&
    typeof candidate.createdAt ===
      "string"
  );
}

export class LocalStorageLeaderboardRepository
implements LeaderboardRepository {
  private readonly storageKey: string;
  private readonly maximumEntries: number;

  public constructor(
    storageKey: string,
    maximumEntries: number,
  ) {
    this.storageKey = storageKey;
    this.maximumEntries = maximumEntries;
  }

  public async getAll(): Promise<ScoreEntry[]> {
    return this.readAll();
  }

  public readAll(): ScoreEntry[] {
    try {
      const rawValue =
        window.localStorage.getItem(
          this.storageKey,
        );

      if (!rawValue) {
        return [];
      }

      const parsedValue: unknown =
        JSON.parse(rawValue);

      if (!Array.isArray(parsedValue)) {
        return [];
      }

      const validEntries =
        parsedValue.filter(isScoreEntry);

      return (["easy", "normal", "hard"] as const)
        .flatMap((difficulty) =>
          sortScores(
            validEntries.filter(
              (entry) =>
                getScoreDifficultyId(entry) === difficulty,
            ),
          ).slice(0, this.maximumEntries),
        );
    } catch {
      return [];
    }
  }

  public async save(
    entry: ScoreEntry,
  ): Promise<ScoreEntry> {
    this.saveLocally(entry);
    return entry;
  }

  public saveLocally(entry: ScoreEntry): ScoreEntry[] {
    const allEntries = [
      ...this.readAll(),
      entry,
    ];

    const updatedEntries =
      (["easy", "normal", "hard"] as const)
        .flatMap((difficulty) =>
          sortScores(
            allEntries.filter(
              (score) =>
                getScoreDifficultyId(score) === difficulty,
            ),
          ).slice(0, this.maximumEntries),
        );

    try {
      window.localStorage.setItem(
        this.storageKey,
        JSON.stringify(updatedEntries),
      );
    } catch {
      /**
       * 저장 공간 사용이 차단되어도
       * 현재 실행에서는 정렬된 결과를 반환합니다.
       */
    }

    return updatedEntries;
  }

  public replaceAll(entries: ScoreEntry[]): void {
    try {
      window.localStorage.setItem(
        this.storageKey,
        JSON.stringify(entries),
      );
    } catch {
      // 저장 공간이 차단된 환경에서는 원격 결과만 사용합니다.
    }
  }

  public async clear(): Promise<void> {
    try {
      window.localStorage.removeItem(
        this.storageKey,
      );
    } catch {
      // 로컬 저장소가 차단된 환경에서는 무시합니다.
    }
  }
}

interface LeaderboardRow {
  id: string;
  player_name: string;
  distance: number;
  survival_time: number | string;
  result_rank: string;
  difficulty: DifficultyId;
  created_at: string;
}

function mapRowToEntry(row: LeaderboardRow): ScoreEntry {
  return {
    id: row.id,
    playerName: row.player_name,
    distance: row.distance,
    survivalTime: Number(row.survival_time),
    rank: row.result_rank,
    difficulty: row.difficulty,
    createdAt: row.created_at,
  };
}

export class SupabaseLeaderboardRepository
implements LeaderboardRepository {
  private readonly cache: LocalStorageLeaderboardRepository;
  private readonly maximumEntries: number;
  private authenticationPromise: Promise<User> | null = null;

  public constructor(
    cache: LocalStorageLeaderboardRepository,
    maximumEntries: number,
  ) {
    this.cache = cache;
    this.maximumEntries = maximumEntries;
  }

  private async ensureAuthenticated(): Promise<User> {
    if (this.authenticationPromise) {
      return this.authenticationPromise;
    }

    this.authenticationPromise = (async () => {
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();

      if (sessionError) {
        throw sessionError;
      }

      if (sessionData.session?.user) {
        return sessionData.session.user;
      }

      const { data, error } =
        await supabase.auth.signInAnonymously();

      if (error || !data.user) {
        throw error ?? new Error("익명 사용자 인증에 실패했습니다.");
      }

      return data.user;
    })();

    try {
      return await this.authenticationPromise;
    } catch (error) {
      this.authenticationPromise = null;
      throw error;
    }
  }

  public async getAll(): Promise<ScoreEntry[]> {
    const difficulties: readonly DifficultyId[] = [
      "easy",
      "normal",
      "hard",
    ];

    const abortController = new AbortController();
    const timeoutId = window.setTimeout(
      () => abortController.abort(),
      LEADERBOARD_REQUEST_TIMEOUT_MS,
    );

    try {
      const results = await Promise.all(
        difficulties.map((difficulty) =>
          supabase
            .from("leaderboard_scores")
            .select(
              "id, player_name, distance, survival_time, result_rank, difficulty, created_at",
            )
            .eq("difficulty", difficulty)
            .order("distance", { ascending: false })
            .order("survival_time", { ascending: false })
            .order("created_at", { ascending: true })
            .limit(this.maximumEntries)
            .abortSignal(abortController.signal),
        ),
      );

      const entries = results.flatMap(({ data, error }) => {
        if (error) {
          throw error;
        }

        return (data as LeaderboardRow[]).map(mapRowToEntry);
      });

      this.cache.replaceAll(entries);
      return entries;
    } catch {
      return this.cache.readAll();
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  public async save(entry: ScoreEntry): Promise<ScoreEntry> {
    try {
      const user = await this.ensureAuthenticated();
      const { data, error } = await supabase
        .from("leaderboard_scores")
        .insert({
          user_id: user.id,
          player_name: entry.playerName,
          distance: entry.distance,
          survival_time: entry.survivalTime,
          result_rank: entry.rank,
          difficulty: entry.difficulty,
        })
        .select(
          "id, player_name, distance, survival_time, result_rank, difficulty, created_at",
        )
        .single();

    if (error || !data) {
      throw error ?? new Error("점수 등록 결과가 없습니다.");
    }

      const savedEntry = mapRowToEntry(data as LeaderboardRow);
      this.cache.saveLocally(savedEntry);
      return savedEntry;
    } catch (error) {
      this.cache.saveLocally(entry);
      throw error;
    }
  }

  public async clear(): Promise<void> {
    await this.cache.clear();
  }
}
