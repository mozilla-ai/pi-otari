import { ConfigError } from "./config.js";
import { record } from "./model-mapper.js";

/** Otari model ids, each with what it is for, or null when the id says enough. */
export type Candidates = Record<string, string | null>;

export type RoutingSettings =
  | { enabled: false }
  | { enabled: true; candidates?: Candidates };

// The limits Otari's /routing/recommend puts on a sent list, checked here so a
// bad list is reported once rather than refused on every spawn.
const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 255;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 1024;

const SETTING = "otari.subagentRouting";

function isModelId(name: string): boolean {
  const separator = name.indexOf(":");
  return (
    separator > 0 &&
    name.slice(0, separator).trim() !== "" &&
    name.slice(separator + 1).trim() !== ""
  );
}

function readCandidates(value: unknown): Candidates {
  const map = record(value);
  if (!map) {
    throw new ConfigError(
      `${SETTING}.candidates must be a map of Otari model ids to descriptions.`,
    );
  }
  const entries = Object.entries(map);
  if (entries.length < MIN_CANDIDATES || entries.length > MAX_CANDIDATES) {
    throw new ConfigError(
      `${SETTING}.candidates needs two to ${MAX_CANDIDATES} models, not ${entries.length}.`,
    );
  }
  const candidates: Candidates = {};
  for (const [name, description] of entries) {
    if (!isModelId(name) || name.length > MAX_NAME_LENGTH) {
      throw new ConfigError(
        `${SETTING}.candidates must name each model by its Otari id ('<provider>:<model>'), not ${JSON.stringify(name)}.`,
      );
    }
    if (description !== null && typeof description !== "string") {
      throw new ConfigError(
        `${SETTING}.candidates gives ${name} a description that is neither text nor null.`,
      );
    }
    if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ConfigError(
        `${SETTING}.candidates gives ${name} a description longer than ${MAX_DESCRIPTION_LENGTH} characters.`,
      );
    }
    candidates[name] = description;
  }
  return candidates;
}

/**
 * Read subagent routing from pi's merged settings. Off unless
 * `otari.subagentRouting.enabled` is true; without `candidates`, Otari
 * chooses among its own list for pi. Throws {@link ConfigError} on a bad value.
 */
export function readRoutingSettings(settings: unknown): RoutingSettings {
  const block = record(record(record(settings)?.otari)?.subagentRouting);
  if (!block || block.enabled === undefined) {
    return { enabled: false };
  }
  if (typeof block.enabled !== "boolean") {
    throw new ConfigError(`${SETTING}.enabled must be true or false.`);
  }
  if (!block.enabled) return { enabled: false };
  if (block.candidates === undefined) return { enabled: true };
  return { enabled: true, candidates: readCandidates(block.candidates) };
}
