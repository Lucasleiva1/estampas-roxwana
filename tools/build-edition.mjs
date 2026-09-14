import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const edition = process.argv[2];
if (!new Set(["development", "commercial"]).has(edition)) {
  throw new Error("Uso: node tools/build-edition.mjs development|commercial");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = new Set([packageJson.version, tauriConfig.version, cargoVersion]);
if (versions.size !== 1 || versions.has(undefined)) {
  throw new Error("Las versiones de package.json, tauri.conf.json y Cargo.toml no coinciden.");
}

const version = packageJson.version;
const artifacts = join(root, "artifacts");
const prefix = `Biblioteca-Visual-${edition === "development" ? "desarrollo" : "comercial"}-v${version}`;
const requiredTargets = [join(artifacts, `${prefix}.exe`), join(artifacts, `${prefix}-setup.exe`)];
for (const target of requiredTargets) {
  if (existsSync(target)) {
    throw new Error(`No se sobrescribe un artefacto versionado existente: ${target}`);
  }
}

const config = join("src-tauri", `tauri.${edition}.conf.json`);
const args = ["run", "tauri", "--", "build", "--bundles", "nsis", "--config", config];
if (edition === "commercial") args.push("--features", "commercial");
const executable = process.platform === "win32" ? "npm.cmd" : "npm";
const build = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [executable, ...args].join(" ")], {
      cwd: root,
      stdio: "inherit",
    })
  : spawnSync(executable, args, { cwd: root, stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const releaseDirectory = join(root, "src-tauri", "target", "release");
const nsisDirectory = join(releaseDirectory, "bundle", "nsis");
const setup = readdirSync(nsisDirectory)
  .filter((name) => name.toLowerCase().endsWith(".exe"))
  .map((name) => join(nsisDirectory, name))
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
const standalone = join(releaseDirectory, "roxwana-biblioteca-visual.exe");
if (!setup || !existsSync(standalone)) {
  throw new Error("Tauri terminó sin producir el ejecutable o el instalador NSIS esperado.");
}

mkdirSync(artifacts, { recursive: true });
const copies = [
  [standalone, join(artifacts, `${prefix}.exe`)],
  [setup, join(artifacts, `${prefix}-setup.exe`)],
];
for (const [source, target] of [...copies]) {
  const signature = `${source}.sig`;
  if (existsSync(signature)) copies.push([signature, `${target}.sig`]);
}
for (const [source, target] of copies) {
  if (existsSync(target)) throw new Error(`No se sobrescribe: ${target}`);
  copyFileSync(source, target);
  console.log(`Artefacto: ${target}`);
}
