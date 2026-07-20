import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, ModelCache, ModelCost, ModelSource, OtariModel } from "./types.js";

const MODEL_SOURCES = new Set<ModelSource>([
  "standard",
  "managed-catalog",
  "environment",
  "stale-cache",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalPositiveNumber(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function validCost(value: unknown): value is ModelCost {
  const cost = record(value);
  return cost !== undefined
    && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]
      .every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0);
}

function validModel(value: unknown): value is OtariModel {
  const model = record(value);
  if (!model || typeof model.id !== "string" || model.id.trim() === "") return false;
  if (typeof model.source !== "string" || !MODEL_SOURCES.has(model.source as ModelSource)) return false;
  if (model.name !== undefined && typeof model.name !== "string") return false;
  if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") return false;
  if (model.input !== undefined && (!Array.isArray(model.input)
    || model.input.some((item) => item !== "text" && item !== "image"))) return false;
  if (!optionalPositiveNumber(model.contextWindow) || !optionalPositiveNumber(model.maxTokens)) return false;
  return model.cost === undefined || validCost(model.cost);
}

export function stateDir(agentDir: string): string {
  return join(agentDir, "pi-otari");
}

export function cachePath(agentDir: string): string {
  return join(stateDir(agentDir), "models-cache.json");
}

export async function readModelCache(agentDir: string): Promise<{ cache?: ModelCache; diagnostic?: Diagnostic }> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(agentDir), "utf8")) as Partial<ModelCache>;
    if (parsed.schemaVersion !== 1) {
      return {
        diagnostic: {
          level: "warning",
          code: "cache-version",
          message: "Ignoring unsupported Pi–Otari cache version",
        },
      };
    }
    if (!Array.isArray(parsed.models)
      || !parsed.models.every(validModel)
      || typeof parsed.fetchedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.fetchedAt))) {
      return {
        diagnostic: {
          level: "warning",
          code: "cache-invalid",
          message: "Ignoring invalid Pi–Otari model cache",
        },
      };
    }
    return { cache: parsed as ModelCache };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      diagnostic: {
        level: "warning",
        code: "cache-invalid",
        message: "Ignoring unreadable Pi–Otari model cache",
      },
    };
  }
}

export async function writeModelCache(agentDir: string, models: OtariModel[]): Promise<void> {
  const dir = stateDir(agentDir);
  const target = cachePath(agentDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700);
  try {
    const payload: ModelCache = {
      schemaVersion: 1,
      fetchedAt: new Date().toISOString(),
      models,
    };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    if (process.platform !== "win32") await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}
