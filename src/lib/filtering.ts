import type { Design, Filters } from "./types";
import { designSearchText } from "./fileTypes";

export const UNCATEGORIZED_CATEGORY = "Sin categoria";

const defaultFilters: Filters = {
  query: "",
  favoritesOnly: false,
  statuses: [],
  categories: [],
  tags: [],
  support: [],
  withoutPreview: false,
};

export function createDefaultFilters(): Filters {
  return { ...defaultFilters, statuses: [], categories: [], tags: [], support: [] };
}

export function filterDesigns(designs: Design[], filters: Filters) {
  const query = filters.query.trim().toLowerCase();

  return designs.filter((design) => {
    if (query && !designSearchText(design).includes(query)) return false;
    if (filters.favoritesOnly && !design.classification.favorite) return false;
    if (filters.withoutPreview && design.previewPath) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(design.classification.status)) return false;
    if (filters.categories.length > 0) {
      const category = design.classification.category ?? UNCATEGORIZED_CATEGORY;
      if (!filters.categories.includes(category)) return false;
    }
    if (filters.tags.length > 0) {
      const tagSet = new Set(design.classification.tags);
      if (!filters.tags.every((tag) => tagSet.has(tag))) return false;
    }
    if (filters.support.length > 0) {
      if (!filters.support.every((extension) => countForExtension(design, extension) > 0)) return false;
    }

    return true;
  });
}

export function chooseRandomDesign<T>(items: T[], random = Math.random): T | null {
  if (items.length === 0) return null;
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  return items[index];
}

export function countForExtension(design: Design, extension: string) {
  const key = extension.replace(".", "").toLowerCase();
  if (key in design.counts) {
    return design.counts[key as keyof typeof design.counts];
  }

  return design.files.filter((file) => file.extension.toLowerCase() === `.${key}`).length;
}

function normalizedDirectory(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

export function designsInSameDirectory(designs: Design[], selected: Design) {
  const directory = normalizedDirectory(selected.directory);
  const matches = designs.filter((design) => normalizedDirectory(design.directory) === directory);
  return matches.length > 0 ? matches : [selected];
}

export function countForExtensionAcrossDesigns(designs: Design[], extension: string) {
  return designs.reduce((total, design) => total + countForExtension(design, extension), 0);
}

export function countPreviewFiles(design: Design) {
  if (design.files.length > 0) {
    return design.files.filter((file) => file.kind === "preview").length;
  }

  const supportFiles = Object.values(design.counts).reduce((total, count) => total + count, 0);
  return Math.max(0, design.totalFiles - supportFiles);
}

export function countPreviewFilesAcrossDesigns(designs: Design[]) {
  return designs.reduce((total, design) => total + countPreviewFiles(design), 0);
}

export function toggleValue<T>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}
