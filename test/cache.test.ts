import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachePath, readModelCache, writeModelCache } from "../src/cache.js";

async function tempAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-otari-cache-"));
}

describe("model cache", () => {
  it("round-trips normalized models", async () => {
    const agentDir = await tempAgentDir();
    await writeModelCache(agentDir, [{ id: "mzai:model", source: "managed-catalog" }]);
    expect((await readModelCache(agentDir)).cache?.models[0].id).toBe("mzai:model");
    if (process.platform !== "win32") {
      expect((await stat(cachePath(agentDir))).mode & 0o777).toBe(0o600);
    }
  });

  it("reports corrupt JSON without throwing", async () => {
    const agentDir = await tempAgentDir();
    await writeModelCache(agentDir, []);
    await writeFile(cachePath(agentDir), "not json", "utf8");
    const result = await readModelCache(agentDir);
    expect(result.cache).toBeUndefined();
    expect(result.diagnostic?.code).toBe("cache-invalid");
  });

  it("rejects an unknown schema version", async () => {
    const agentDir = await tempAgentDir();
    await writeModelCache(agentDir, []);
    await writeFile(
      cachePath(agentDir),
      JSON.stringify({ schemaVersion: 2, fetchedAt: new Date().toISOString(), models: [] }),
    );
    expect((await readModelCache(agentDir)).diagnostic?.code).toBe("cache-version");
  });

  it("rejects malformed model entries", async () => {
    const agentDir = await tempAgentDir();
    await writeModelCache(agentDir, []);
    await writeFile(
      cachePath(agentDir),
      JSON.stringify({
        schemaVersion: 1,
        fetchedAt: new Date().toISOString(),
        models: [{ source: "standard" }],
      }),
    );
    expect((await readModelCache(agentDir)).diagnostic?.code).toBe("cache-invalid");
  });
});
