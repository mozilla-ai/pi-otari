export type ModelSource = "standard" | "managed-catalog" | "environment" | "stale-cache";
export type DiagnosticLevel = "warning" | "error";

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OtariModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  source: ModelSource;
}

export interface OtariConfig {
  baseUrl: string;
  token?: string;
  discoveryTimeoutMs: number;
  environmentModels: string[];
  officialHosted: boolean;
}

export interface ModelCache {
  schemaVersion: 1;
  fetchedAt: string;
  models: OtariModel[];
}

export interface DiscoveryResult {
  models: OtariModel[];
  source: ModelSource | "none";
  diagnostics: Diagnostic[];
  cacheUpdate?: OtariModel[];
}

export interface RuntimeState {
  config?: OtariConfig;
  models: OtariModel[];
  diagnostics: Diagnostic[];
  discoverySource: DiscoveryResult["source"];
}
