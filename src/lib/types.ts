export type DesignStatus = "pending" | "working" | "ready" | "discarded";
export type ViewMode = "grid" | "masonry" | "list" | "detail";

export type FileKind = "preview" | "support" | "other";

export interface DesignFile {
  id: string;
  designId: string;
  path: string;
  fileName: string;
  extension: string;
  kind: FileKind;
  size: number;
  modified: number;
}

export interface SupportCounts {
  ai: number;
  psd: number;
  svg: number;
  pdf: number;
  eps: number;
  zip: number;
  txt: number;
  other: number;
}

export interface Classification {
  favorite: boolean;
  status: DesignStatus;
  category: string | null;
  tags: string[];
  categoryUserSet: boolean;
}

export interface Design {
  id: string;
  name: string;
  path: string;
  directory: string;
  groupType: "folder" | "loose_file";
  previewPath: string | null;
  previewCachePath?: string | null;
  thumbnailPath: string | null;
  totalFiles: number;
  updatedAt: number;
  counts: SupportCounts;
  files: DesignFile[];
  classification: Classification;
  autoCategory: string | null;
  autoTags: string[];
}

export interface LibraryStats {
  designs: number;
  files: number;
  previews: number;
  support: number;
  missing: number;
  byExtension: Record<string, number>;
}

export interface LibraryResponse {
  rootPath: string;
  designs: Design[];
  stats: LibraryStats;
  categories: string[];
  tags: string[];
}

export interface Filters {
  query: string;
  favoritesOnly: boolean;
  statuses: DesignStatus[];
  categories: string[];
  tags: string[];
  support: string[];
  withoutPreview: boolean;
}
