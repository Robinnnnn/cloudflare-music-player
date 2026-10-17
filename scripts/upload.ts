import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCatalog } from "../src/catalog";
import { audioConfiguration, catalogPath, configPath, projectDirectory } from "./catalog";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" }, id: { type: "string" }, title: { type: "string" },
      artist: { type: "string" }, playlist: { type: "string", default: "default" },
      "external-url": { type: "string" }, local: { type: "boolean", default: false }, help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log('Usage: npm run track:add -- --file /path/song.mp3 --id song-id --title "Song title" --artist "Artist" [--playlist default] [--external-url https://...] [--local]');
    return;
  }
  for (const field of ["file", "id", "title", "artist"] as const) {
    if (!values[field]) throw new Error(`--${field} is required; use --help for usage`);
  }
  const audioPath = resolve(values.file!);
  const file = await stat(audioPath);
  if (!file.isFile() || extname(audioPath).toLowerCase() !== ".mp3" || file.size === 0) {
    throw new Error("--file must name a non-empty MP3 file");
  }
  if (file.size > 315_000_000) throw new Error("The MP3 exceeds Wrangler's 315 MB upload limit");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(audioPath)) digest.update(chunk);
  const objectKey = `v1/${values.id}-${digest.digest("hex")}.mp3`;
  const track = {
    id: values.id!, title: values.title!, artist: values.artist!, objectKey,
    ...(values["external-url"] !== undefined ? { externalUrl: values["external-url"] } : {}),
  };
  const stateDirectory = join(projectDirectory, ".wrangler");
  await mkdir(stateDirectory, { recursive: true });
  const lockPath = join(stateDirectory, "music-upload.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Another upload holds .wrangler/music-upload.lock. If an earlier upload was interrupted, remove that lock after confirming it has stopped.");
    throw error;
  });
  const temporaryCatalog = `${catalogPath}.${randomUUID()}.tmp`;
  try {
    await lock.writeFile(String(process.pid));
    const original = await readFile(catalogPath, "utf8");
    const catalog = parseCatalog(JSON.parse(original));
    const playlist = catalog.playlists.find((entry) => entry.id === values.playlist);
    if (!playlist) throw new Error(`Unknown playlist "${values.playlist}"; add it to catalog/catalog.json first`);
    catalog.tracks.push(track);
    playlist.trackIds.push(track.id);
    parseCatalog(catalog); // Reject invalid metadata or duplicate IDs before a remote write.
    const { binding } = await audioConfiguration();
    const wranglerScript = join(projectDirectory, "node_modules/wrangler/bin/wrangler.js");
    const args = [wranglerScript, "r2", "object", "put", `${binding.bucket_name}/${objectKey}`,
      "--file", audioPath, "--content-type", "audio/mpeg", "--cache-control", "public, max-age=31536000, immutable",
      "--config", configPath, values.local ? "--local" : "--remote"];
    if (binding.jurisdiction) args.push("--jurisdiction", binding.jurisdiction);
    await new Promise<void>((resolveUpload, reject) => {
      const child = spawn(process.execPath, args, { cwd: projectDirectory, stdio: "inherit", shell: false });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolveUpload() : reject(new Error(`Upload failed (${signal ?? code}); catalog was not changed`)));
    });
    if (await readFile(catalogPath, "utf8") !== original) {
      throw new Error(`Catalog changed during upload; ${objectKey} was uploaded but not added. Rerun after reviewing the catalog.`);
    }
    await writeFile(temporaryCatalog, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryCatalog, catalogPath);
    console.log(`Added "${track.title}" by ${track.artist} to ${playlist.id}.`);
    console.log(values.local
      ? "Audio exists in local R2 only. Upload it remotely before deploying this catalog."
      : "Audio uploaded. Review and commit catalog/catalog.json, then run npm run deploy to publish the track.");
  } finally {
    await rm(temporaryCatalog, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
