import type { Design, DesignFile } from "./types";

export const PREVIEW_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
export const SUPPORT_EXTENSIONS = [".ai", ".psd", ".svg", ".pdf", ".eps", ".zip", ".txt"];

export function normalizeExtension(extension: string) {
  const value = extension.trim().toLowerCase();
  return value.startsWith(".") ? value : `.${value}`;
}

export function classifyExtension(extension: string): "preview" | "support" | "other" {
  const normalized = normalizeExtension(extension);
  if (PREVIEW_EXTENSIONS.includes(normalized)) return "preview";
  if (SUPPORT_EXTENSIONS.includes(normalized)) return "support";
  return "other";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];

  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

export function fileAssetLabel(file: DesignFile) {
  return file.extension.replace(".", "").toUpperCase();
}

export function designSearchText(design: Design) {
  return [
    design.name,
    design.classification.category,
    design.classification.tags.join(" "),
    design.autoTags.join(" "),
    design.files.map((file) => file.fileName).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
