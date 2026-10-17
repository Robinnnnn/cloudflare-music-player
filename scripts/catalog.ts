import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCatalog } from "../src/catalog";
import type { Catalog } from "../src/types";

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const catalogPath = join(projectDirectory, "catalog/catalog.json");
export const configPath = join(projectDirectory, "wrangler.jsonc");

interface AudioBinding {
  binding: string;
  bucket_name?: string;
  preview_bucket_name?: string;
  jurisdiction?: string;
  remote?: boolean;
}

interface AudioConfiguration {
  name?: string;
  account_id?: string;
  compatibility_date?: string;
  r2_buckets: AudioBinding[];
}

export async function readCatalog(): Promise<Catalog> {
  let input: unknown;
  try { input = JSON.parse(await readFile(catalogPath, "utf8")); }
  catch (error) { throw new Error(`Cannot read catalog/catalog.json: ${error instanceof Error ? error.message : String(error)}`); }
  return parseCatalog(input);
}

export async function audioConfiguration() {
  // Use Wrangler's own JSONC reader so comments and schema validation behave as in deploy.
  const { unstable_readConfig } = await import("wrangler");
  const config = unstable_readConfig({ config: configPath }) as AudioConfiguration;
  const binding = config.r2_buckets.find((entry) => entry.binding === "AUDIO");
  if (!binding?.bucket_name) throw new Error("wrangler.jsonc must define an AUDIO R2 binding with bucket_name");
  return { config, binding };
}

export async function verifyRemoteAudio(catalog: Catalog): Promise<void> {
  if (!catalog.tracks.length) {
    console.log("No audio files are referenced; remote file verification is empty.");
    return;
  }
  const { config, binding } = await audioConfiguration();
  const { getPlatformProxy } = await import("wrangler");
  const directory = await mkdtemp(join(tmpdir(), "music-catalog-check-"));
  try {
    const temporaryConfig = join(directory, "wrangler.json");
    await writeFile(temporaryConfig, JSON.stringify({
      name: config.name,
      account_id: config.account_id,
      compatibility_date: config.compatibility_date,
      r2_buckets: [{ ...binding, preview_bucket_name: undefined, remote: true }],
    }));
    // Only metadata is requested. Wrangler handles authentication and credential refresh.
    const platform = await getPlatformProxy<{ AUDIO: R2Bucket }>({
      configPath: temporaryConfig,
      remoteBindings: true,
      persist: false,
      envFiles: [],
    });
    try {
      const problems: string[] = [];
      for (const track of catalog.tracks) {
        const object = await platform.env.AUDIO.head(track.objectKey);
        if (!object) problems.push(`${track.id}: missing ${track.objectKey}`);
        else if (object.size === 0) problems.push(`${track.id}: ${track.objectKey} is empty`);
      }
      if (problems.length) throw new Error(`Remote audio validation failed:\n${problems.join("\n")}`);
      console.log(`Verified ${catalog.tracks.length} audio files in ${binding.bucket_name} using R2 HEAD.`);
    } finally {
      await platform.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { remote: { type: "boolean" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    console.log("Usage: npm run catalog:check [-- --remote]\nValidates catalog metadata; --remote also checks referenced R2 files without downloading audio.");
    return;
  }
  const catalog = await readCatalog();
  console.log(`Catalog valid: ${catalog.tracks.length} tracks, ${catalog.playlists.length} playlists.`);
  if (values.remote) await verifyRemoteAudio(catalog);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
