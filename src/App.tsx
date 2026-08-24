import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { watch } from "@tauri-apps/plugin-fs";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileImage,
  FileText,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Heart,
  ImageOff,
  LayoutGrid,
  List,
  Loader2,
  Maximize2,
  Minus,
  MoreVertical,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Shuffle,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  addTag,
  createCategory as createLibraryCategory,
  createCategoryGroup as createLibraryGroup,
  deleteCategory as deleteLibraryCategory,
  deleteCategoryGroup as deleteLibraryGroup,
  generatePreview,
  generatePreviewsBulk,
  generateThumbnail,
  generateThumbnailsBulk,
  getBrandLogo,
  getDesignDetail,
  getInitialState,
  openDesignFolder,
  openBackupFolder,
  removeBrandLogo,
  removeTag,
  rescanPaths,
  renameCategory as renameLibraryCategory,
  renameCategoryGroup as renameLibraryGroup,
  saveSidebarLayout,
  setCategoryGroupCollapsed,
  restoreDatabaseBackup,
  scanLibrary,
  saveDatabaseBackup,
  saveBrandLogo,
  updateCategory,
  updateFavorite,
  updateStatus,
  type BrandLogo,
} from "./lib/api";
import { UNCATEGORIZED_CATEGORY, chooseRandomDesign, countForExtension, createDefaultFilters, filterDesigns } from "./lib/filtering";
import {
  categoryNode,
  flattenSidebar,
  moveSidebarNode,
  removeCategoryFromSidebar,
  removeGroupFromSidebar,
  renameInSidebar,
  sidebarFromCategories,
  type CategoryDropPosition,
  type SidebarDragSource,
  type SidebarNode,
  type SidebarNodeKind,
} from "./lib/categories";
import { formatBytes } from "./lib/fileTypes";
import type { Design, DesignStatus, Filters, LibraryResponse } from "./lib/types";
import illustratorIcon from "./assets/illustrator.png";
import photoshopIcon from "./assets/photoshop.png";

const DEFAULT_LIBRARY_PATH = "C:\\Users\\jaell\\Documents\\estampas-roxwana";
const PAGE_SIZE = 50;
const supportFilters = [".png", ".jpg", ".ai", ".psd", ".eps", ".txt"];
const defaultZoom = 100;
const UI_SCALE_STORAGE_KEY = "roxwana-ui-scale";
const UI_SCALE_MIN = 60;
const UI_SCALE_MAX = 125;
const UI_SCALE_STEP = 5;
const UI_SCALE_PRESETS = [60, 65, 70, 75, 80, 85, 90, 95];
const LEFT_PANEL_WIDTH_STORAGE_KEY = "roxwana-left-panel-width";
const LEFT_PANEL_WIDTH_DEFAULT = 210;
const LEFT_PANEL_WIDTH_MIN = 170;
const LEFT_PANEL_WIDTH_MAX = 380;
const LEFT_PANEL_RESERVED_WIDTH = 640;
const RANDOM_HISTORY_STORAGE_KEY = "roxwana-random-history";

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getMaxLeftPanelWidth() {
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
  return Math.max(LEFT_PANEL_WIDTH_MIN, Math.min(LEFT_PANEL_WIDTH_MAX, viewportWidth - LEFT_PANEL_RESERVED_WIDTH));
}

function getInitialUiScale() {
  try {
    const stored = Number(window.localStorage.getItem(UI_SCALE_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= UI_SCALE_MIN && stored <= UI_SCALE_MAX) return stored;
  } catch {
    // Local storage can be unavailable in restricted webview contexts.
  }
  return 100;
}

function getInitialLeftPanelWidth() {
  try {
    const stored = Number(window.localStorage.getItem(LEFT_PANEL_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored)) return Math.round(clampNumber(stored, LEFT_PANEL_WIDTH_MIN, getMaxLeftPanelWidth()));
  } catch {
    // Keep the default width when local storage is unavailable.
  }
  return LEFT_PANEL_WIDTH_DEFAULT;
}

const statusOptions: Array<{ value: DesignStatus; label: string }> = [
  { value: "pending", label: "Pendiente" },
  { value: "working", label: "Trabajando" },
  { value: "ready", label: "Listo" },
  { value: "discarded", label: "Descartar" },
];

type UpdatePhase = "idle" | "checking" | "downloading" | "installing" | "none" | "done" | "error";

type AppUpdateState = {
  phase: UpdatePhase;
  message: string | null;
  progress: number | null;
};

type ThumbnailPrepState = {
  phase: "idle" | "running" | "done" | "error";
  done: number;
  total: number;
  message: string | null;
};

type BackupState = {
  phase: "idle" | "saving" | "saved" | "opening" | "loading" | "loaded" | "error";
  message: string | null;
  path: string | null;
};

type BrandLogoState = {
  phase: "idle" | "saving" | "saved" | "removing" | "removed" | "error";
  message: string | null;
};

type RandomProgress = {
  seen: number;
  total: number;
};

type RandomHistory = {
  rootPath: string;
  usedIds: string[];
};

type DropTarget = {
  kind: SidebarDragSource["kind"];
  name: string;
  position: CategoryDropPosition;
};

type PointerDragState = {
  kind: "category" | "group" | "design";
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  target: DropTarget | null;
};

const GROUP_EDGE_ZONE = 11;
/** Mantener presionado este tiempo muestra el cursor de arrastre; un clic normal no llega. */
const HOLD_CURSOR_DELAY_MS = 190;

/**
 * A category row splits in halves (drop above or below). A group header keeps
 * thin edges for those two and gives the middle to "drop inside the group".
 */
function dropTargetAt(x: number, y: number): DropTarget | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-name]");
  const name = row?.dataset.dropName ?? "";
  if (!row || !name) return null;
  const bounds = row.getBoundingClientRect();

  if (row.dataset.dropKind === "group-body") {
    return { kind: "group", name, position: "inside" };
  }

  if (row.dataset.dropKind === "group") {
    const edge = Math.min(GROUP_EDGE_ZONE, bounds.height / 3);
    if (y < bounds.top + edge) return { kind: "group", name, position: "before" };
    if (y > bounds.bottom - edge) return { kind: "group", name, position: "after" };
    return { kind: "group", name, position: "inside" };
  }

  return {
    kind: "category",
    name,
    position: y < bounds.top + bounds.height / 2 ? "before" : "after",
  };
}

function sameDropTarget(left: DropTarget | null, right: DropTarget | null) {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.name === right.name && left.position === right.position;
}

/** A design only lands on a category: groups just hold categories. */
function dropTargetForDrag(dragKind: PointerDragState["kind"], id: string, target: DropTarget | null) {
  if (!target) return null;
  if (dragKind === "design") return target.kind === "category" ? target : null;
  if (target.kind === dragKind && sameCategory(id, target.name)) return null;
  return target;
}

const initialUpdateState: AppUpdateState = {
  phase: "idle",
  message: null,
  progress: null,
};

const initialThumbnailPrepState: ThumbnailPrepState = {
  phase: "idle",
  done: 0,
  total: 0,
  message: null,
};

const initialBackupState: BackupState = {
  phase: "idle",
  message: null,
  path: null,
};

function readRandomHistory(rootPath: string, validIds: Set<string>) {
  try {
    const stored = window.localStorage.getItem(RANDOM_HISTORY_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as Partial<RandomHistory>;
    if (parsed.rootPath !== rootPath || !Array.isArray(parsed.usedIds)) return [];
    return parsed.usedIds.filter((id) => validIds.has(id));
  } catch {
    return [];
  }
}

function writeRandomHistory(rootPath: string, usedIds: string[]) {
  try {
    window.localStorage.setItem(RANDOM_HISTORY_STORAGE_KEY, JSON.stringify({ rootPath, usedIds }));
  } catch {
    // Random still works for the current click if local storage is unavailable.
  }
}

export default function App() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [filters, setFilters] = useState<Filters>(() => createDefaultFilters());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(defaultZoom);
  const [uiScale, setUiScale] = useState(getInitialUiScale);
  const [leftPanelWidth, setLeftPanelWidth] = useState(getInitialLeftPanelWidth);
  const [isResizingLeftPanel, setIsResizingLeftPanel] = useState(false);
  const [thumbMode, setThumbMode] = useState<"compact" | "grid" | "list">("compact");
  const [showIconLabels, setShowIconLabels] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsById, setDetailsById] = useState<Record<string, Design>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [isChangingPage, setIsChangingPage] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateState>(initialUpdateState);
  const [thumbnailPrep, setThumbnailPrep] = useState<ThumbnailPrepState>(initialThumbnailPrepState);
  const [previewPrep, setPreviewPrep] = useState<ThumbnailPrepState>(initialThumbnailPrepState);
  const [backupState, setBackupState] = useState<BackupState>(initialBackupState);
  const [brandLogo, setBrandLogo] = useState<BrandLogo | null>(null);
  const [brandLogoState, setBrandLogoState] = useState<BrandLogoState>({ phase: "idle", message: null });
  const [randomProgress, setRandomProgress] = useState<RandomProgress>({ seen: 0, total: 0 });
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  const attemptedPreviews = useRef<Set<string>>(new Set());
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const leftPanelResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const holdCursorTimer = useRef(0);
  const deferredFilters = useDeferredValue(filters);

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(uiScale));
    } catch {
      // The zoom still applies for the current session.
    }

    document.documentElement.style.removeProperty("zoom");
    try {
      void getCurrentWebview()
        .setZoom(uiScale / 100)
        .catch(() => document.documentElement.style.setProperty("zoom", String(uiScale / 100)));
    } catch {
      document.documentElement.style.setProperty("zoom", String(uiScale / 100));
    }
  }, [uiScale]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LEFT_PANEL_WIDTH_STORAGE_KEY, String(leftPanelWidth));
    } catch {
      // The resized panel still applies for the current session.
    }
  }, [leftPanelWidth]);

  useEffect(() => {
    const handleResize = () => {
      setLeftPanelWidth((current) => Math.round(clampNumber(current, LEFT_PANEL_WIDTH_MIN, getMaxLeftPanelWidth())));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!isResizingLeftPanel) return;

    const handlePointerMove = (event: PointerEvent) => {
      const resize = leftPanelResizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      event.preventDefault();
      const nextWidth = resize.startWidth + event.clientX - resize.startX;
      setLeftPanelWidth(Math.round(clampNumber(nextWidth, LEFT_PANEL_WIDTH_MIN, getMaxLeftPanelWidth())));
    };

    const stopResize = (event: PointerEvent) => {
      const resize = leftPanelResizeRef.current;
      if (resize && event.pointerId !== resize.pointerId) return;
      leftPanelResizeRef.current = null;
      setIsResizingLeftPanel(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, [isResizingLeftPanel]);

  const startLeftPanelResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      leftPanelResizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: leftPanelWidth,
      };
      setIsResizingLeftPanel(true);
    },
    [leftPanelWidth],
  );

  const applyLibrary = useCallback((next: LibraryResponse) => {
    setLibrary(next);
    setSelectedId((current) => {
      if (current && next.designs.some((design) => design.id === current)) return current;
      return next.designs.find((design) => design.previewPath)?.id ?? next.designs[0]?.id ?? null;
    });
  }, []);

  const runScan = useCallback(
    async (rootPath = library?.rootPath ?? DEFAULT_LIBRARY_PATH) => {
      setScanning(true);
      setError(null);
      try {
        const response = await scanLibrary(rootPath);
        applyLibrary(response);
        setDetailsById({});
      } catch (scanError) {
        setError(String(scanError));
      } finally {
        setScanning(false);
      }
    },
    [applyLibrary, library?.rootPath],
  );

  useEffect(() => {
    let alive = true;
    getInitialState()
      .then((response) => {
        if (alive) applyLibrary(response);
      })
      .catch((initialError) => {
        if (alive) setError(String(initialError));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [applyLibrary]);

  useEffect(() => {
    let alive = true;
    getBrandLogo()
      .then((logo) => {
        if (alive) setBrandLogo(logo);
      })
      .catch((logoError) => {
        if (alive) {
          setBrandLogo(null);
          setBrandLogoState({ phase: "error", message: `No se pudo cargar el logo guardado: ${String(logoError)}` });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // Mantiene la biblioteca sincronizada con los archivos nuevos, modificados o
  // borrados. Se agrupan los eventos para que copiar una carpeta completa haga
  // un solo rescaneo localizado en vez de miles de rescaneos individuales.
  useEffect(() => {
    const rootPath = library?.rootPath;
    if (!rootPath) return;
    const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase();
    const referencesPrefix = `${normalizedRoot}/referencias`;

    let disposed = false;
    let stopWatching: (() => void) | null = null;
    let flushTimer = 0;
    let rescanRunning = false;
    const pendingPaths = new Set<string>();

    const scheduleFlush = () => {
      window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => void flushChanges(), 1200);
    };

    const flushChanges = async () => {
      if (disposed || rescanRunning || pendingPaths.size === 0) return;
      const paths = Array.from(pendingPaths);
      pendingPaths.clear();
      rescanRunning = true;
      try {
        const response = await rescanPaths(rootPath, paths);
        if (!disposed) {
          applyLibrary(response);
          setDetailsById({});
        }
      } catch (watchError) {
        if (!disposed) setError(`No pude actualizar los cambios de la biblioteca: ${String(watchError)}`);
      } finally {
        rescanRunning = false;
        if (!disposed && pendingPaths.size > 0) scheduleFlush();
      }
    };

    void watch(
      rootPath,
      (event) => {
        if (typeof event.type === "object" && "access" in event.type) return;
        for (const path of event.paths) {
          const normalized = path.replace(/\\/g, "/").toLocaleLowerCase();
          if (normalized.split("/").includes("_roxwana-cache")) continue;
          if (normalized === referencesPrefix || normalized.startsWith(`${referencesPrefix}/`)) continue;
          pendingPaths.add(path);
        }
        if (pendingPaths.size > 0) scheduleFlush();
      },
      { recursive: true, delayMs: 750 },
    )
      .then((stop) => {
        if (disposed) stop();
        else stopWatching = stop;
      })
      .catch((watchError) => {
        if (!disposed) setError(`No pude vigilar la carpeta de estampas: ${String(watchError)}`);
      });

    return () => {
      disposed = true;
      window.clearTimeout(flushTimer);
      stopWatching?.();
    };
  }, [applyLibrary, library?.rootPath]);

  const filteredDesigns = useMemo(() => filterDesigns(library?.designs ?? [], deferredFilters), [deferredFilters, library?.designs]);
  const randomDesigns = useMemo(() => (library?.designs ?? []).filter((design) => design.previewPath), [library?.designs]);
  const totalPages = Math.max(1, Math.ceil(filteredDesigns.length / PAGE_SIZE));
  const currentPageIndex = Math.min(pageIndex, totalPages - 1);
  const pageStart = currentPageIndex * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, filteredDesigns.length);
  const visibleDesigns = useMemo(() => filteredDesigns.slice(pageStart, pageEnd), [filteredDesigns, pageEnd, pageStart]);
  const selectedIndex = useMemo(
    () => Math.max(0, filteredDesigns.findIndex((design) => design.id === selectedId)),
    [filteredDesigns, selectedId],
  );
  const selectedSummary = filteredDesigns[selectedIndex] ?? filteredDesigns[0] ?? null;
  const selectedDesign = selectedSummary ? detailsById[selectedSummary.id] ?? selectedSummary : null;

  useEffect(() => {
    setPageIndex(0);
    setIsChangingPage(false);
  }, [deferredFilters, library?.rootPath]);

  useEffect(() => {
    if (!library) {
      setRandomProgress({ seen: 0, total: 0 });
      return;
    }

    const validIds = new Set(randomDesigns.map((design) => design.id));
    const usedIds = readRandomHistory(library.rootPath, validIds);
    setRandomProgress({ seen: usedIds.length, total: randomDesigns.length });
  }, [library, randomDesigns]);

  useEffect(() => {
    if (pageIndex !== currentPageIndex) {
      setPageIndex(currentPageIndex);
    }
  }, [currentPageIndex, pageIndex]);

  const updateDesignLocal = useCallback((designId: string, updater: (design: Design) => Design) => {
    setLibrary((current) => {
      if (!current) return current;
      return {
        ...current,
        designs: current.designs.map((design) => (design.id === designId ? updater(design) : design)),
      };
    });
    setDetailsById((current) => {
      const detail = current[designId];
      if (!detail) return current;
      return { ...current, [designId]: updater(detail) };
    });
  }, []);

  useEffect(() => {
    const candidates = [selectedSummary, filteredDesigns[selectedIndex - 1], filteredDesigns[selectedIndex + 1]].filter(Boolean) as Design[];
    if (candidates.length === 0) return;
    let cancelled = false;

    void (async () => {
      for (const design of candidates) {
        if (cancelled || detailsById[design.id]) continue;
        try {
          const detail = await getDesignDetail(design.id);
          if (!cancelled && detail) {
            setDetailsById((current) => (current[detail.id] ? current : { ...current, [detail.id]: detail }));
          }
        } catch (detailError) {
          if (!cancelled) setError(String(detailError));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [detailsById, filteredDesigns, selectedIndex, selectedSummary]);

  useEffect(() => {
    if (!selectedDesign?.previewPath || selectedDesign.previewCachePath || previewPrep.phase === "running") return;
    const key = `${selectedDesign.previewPath}:${selectedDesign.updatedAt}`;
    if (attemptedPreviews.current.has(key)) return;
    attemptedPreviews.current.add(key);
    let cancelled = false;

    void (async () => {
      try {
        const previewCachePath = await generatePreview(selectedDesign.previewPath!, selectedDesign.updatedAt);
        if (!cancelled && previewCachePath) {
          updateDesignLocal(selectedDesign.id, (item) => ({ ...item, previewCachePath }));
        }
      } catch (previewError) {
        if (!cancelled) setError(`No pude generar preview optimizado: ${String(previewError)}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [previewPrep.phase, selectedDesign?.id, selectedDesign?.previewCachePath, selectedDesign?.previewPath, selectedDesign?.updatedAt, updateDesignLocal]);

  const chooseFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: library?.rootPath ?? DEFAULT_LIBRARY_PATH,
      title: "Elegir carpeta de estampas",
    });
    if (typeof selected === "string") await runScan(selected);
  };

  const saveBrandLogoPath = useCallback(async (selected: string) => {
    setBrandLogoState({ phase: "saving", message: "Preparando y guardando el logo..." });
    try {
      const saved = await saveBrandLogo(selected);
      setBrandLogo(saved);
      setBrandLogoState({
        phase: "saved",
        message: `Logo guardado (${saved.width} × ${saved.height} px).`,
      });
    } catch (logoError) {
      setBrandLogoState({ phase: "error", message: `No se pudo guardar el logo: ${String(logoError)}` });
    }
  }, []);

  const chooseBrandLogo = useCallback(async () => {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      title: "Elegir logo de marca",
      filters: [{ name: "Imagen", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof selected === "string") await saveBrandLogoPath(selected);
  }, [saveBrandLogoPath]);

  const clearBrandLogo = useCallback(async () => {
    if (!brandLogo || !window.confirm("Quitar el logo de marca guardado?")) return;
    setBrandLogoState({ phase: "removing", message: "Quitando el logo..." });
    try {
      await removeBrandLogo();
      setBrandLogo(null);
      setBrandLogoState({ phase: "removed", message: "Logo quitado." });
    } catch (logoError) {
      setBrandLogoState({ phase: "error", message: `No se pudo quitar el logo: ${String(logoError)}` });
    }
  }, [brandLogo]);

  const setFavorite = useCallback(async (design: Design, favorite: boolean) => {
    updateDesignLocal(design.id, (item) => ({ ...item, classification: { ...item.classification, favorite } }));
    try {
      await updateFavorite(design.id, favorite);
    } catch (favoriteError) {
      setError(String(favoriteError));
    }
  }, [updateDesignLocal]);

  const setStatus = useCallback(async (design: Design, status: DesignStatus) => {
    updateDesignLocal(design.id, (item) => ({ ...item, classification: { ...item.classification, status } }));
    try {
      await updateStatus(design.id, status);
    } catch (statusError) {
      setError(String(statusError));
    }
  }, [updateDesignLocal]);

  const saveCategory = useCallback(async (design: Design, category: string | null) => {
    const categoryName = category?.trim() || "";
    const normalized = categoryName && !sameCategory(categoryName, UNCATEGORIZED_CATEGORY) ? categoryName : null;
    updateDesignLocal(design.id, (item) => ({
      ...item,
      classification: { ...item.classification, category: normalized, categoryUserSet: true },
    }));
    setLibrary((current) => {
      if (!current || !normalized || current.categories.includes(normalized)) return current;
      return {
        ...current,
        categories: [...current.categories, normalized],
        sidebar: [...current.sidebar, categoryNode(normalized)],
      };
    });
    try {
      const savedCategory = await updateCategory(design.id, normalized);
      if (savedCategory !== normalized) {
        updateDesignLocal(design.id, (item) => ({
          ...item,
          classification: { ...item.classification, category: savedCategory, categoryUserSet: true },
        }));
      }
      setLibrary((current) => {
        if (!current || !savedCategory || current.categories.some((item) => sameCategory(item, savedCategory))) return current;
        return {
          ...current,
          categories: [...current.categories, savedCategory],
          sidebar: [...current.sidebar, categoryNode(savedCategory)],
        };
      });
    } catch (categoryError) {
      setError(String(categoryError));
    }
  }, [updateDesignLocal]);

  const createCategory = useCallback(async (name: string) => {
    try {
      const category = await createLibraryCategory(name);
      setLibrary((current) => {
        if (!current || current.categories.some((item) => sameCategory(item, category))) return current;
        return {
          ...current,
          categories: [...current.categories, category],
          sidebar: [...current.sidebar, categoryNode(category)],
        };
      });
      return category;
    } catch (categoryError) {
      setError(String(categoryError));
      return null;
    }
  }, []);

  const renameCategory = useCallback(async (currentName: string, newName: string) => {
    try {
      const renamed = await renameLibraryCategory(currentName, newName);
      setLibrary((current) => {
        if (!current) return current;
        return {
          ...current,
          categories: current.categories.map((category) => (sameCategory(category, currentName) ? renamed : category)),
          sidebar: renameInSidebar(current.sidebar, currentName, renamed),
          designs: current.designs.map((design) =>
            sameCategory(design.classification.category, currentName)
              ? { ...design, classification: { ...design.classification, category: renamed, categoryUserSet: true } }
              : design,
          ),
        };
      });
      setDetailsById((current) => {
        const next = { ...current };
        for (const [id, design] of Object.entries(next)) {
          if (sameCategory(design.classification.category, currentName)) {
            next[id] = { ...design, classification: { ...design.classification, category: renamed, categoryUserSet: true } };
          }
        }
        return next;
      });
      setFilters((current) => ({
        ...current,
        categories: current.categories.map((category) => (sameCategory(category, currentName) ? renamed : category)),
      }));
      return renamed;
    } catch (categoryError) {
      setError(String(categoryError));
      return null;
    }
  }, []);

  const removeCategory = useCallback(async (category: string) => {
    try {
      await deleteLibraryCategory(category);
      setLibrary((current) => {
        if (!current) return current;
        return {
          ...current,
          categories: current.categories.filter((item) => !sameCategory(item, category)),
          sidebar: removeCategoryFromSidebar(current.sidebar, category),
          designs: current.designs.map((design) =>
            sameCategory(design.classification.category, category)
              ? { ...design, classification: { ...design.classification, category: null, categoryUserSet: true } }
              : design,
          ),
        };
      });
      setDetailsById((current) => {
        const next = { ...current };
        for (const [id, design] of Object.entries(next)) {
          if (sameCategory(design.classification.category, category)) {
            next[id] = { ...design, classification: { ...design.classification, category: null, categoryUserSet: true } };
          }
        }
        return next;
      });
      setFilters((current) => ({
        ...current,
        categories: current.categories.filter((item) => !sameCategory(item, category)),
      }));
      return true;
    } catch (categoryError) {
      setError(String(categoryError));
      return false;
    }
  }, []);

  const saveLayout = useCallback(async (nextLayout: SidebarNode[]) => {
    const previousLayout = library?.sidebar ?? [];
    setLibrary((current) =>
      current ? { ...current, sidebar: nextLayout, categories: flattenSidebar(nextLayout) } : current,
    );

    try {
      const savedLayout = await saveSidebarLayout(nextLayout);
      setLibrary((current) =>
        current ? { ...current, sidebar: savedLayout, categories: flattenSidebar(savedLayout) } : current,
      );
    } catch (layoutError) {
      setLibrary((current) =>
        current ? { ...current, sidebar: previousLayout, categories: flattenSidebar(previousLayout) } : current,
      );
      setError(String(layoutError));
    }
  }, [library?.sidebar]);

  const createGroup = useCallback(async (name: string) => {
    try {
      const group = await createLibraryGroup(name);
      setLibrary((current) =>
        current
          ? { ...current, sidebar: [...current.sidebar, { kind: "group", name: group, collapsed: false, children: [] }] }
          : current,
      );
      return group;
    } catch (groupError) {
      setError(String(groupError));
      return null;
    }
  }, []);

  const renameGroup = useCallback(async (currentName: string, newName: string) => {
    try {
      const renamed = await renameLibraryGroup(currentName, newName);
      setLibrary((current) =>
        current
          ? {
              ...current,
              sidebar: current.sidebar.map((node) =>
                node.kind === "group" && sameCategory(node.name, currentName) ? { ...node, name: renamed } : node,
              ),
            }
          : current,
      );
      return renamed;
    } catch (groupError) {
      setError(String(groupError));
      return null;
    }
  }, []);

  const removeGroup = useCallback(async (group: string) => {
    const previousLayout = library?.sidebar ?? [];
    try {
      await deleteLibraryGroup(group);
    } catch (groupError) {
      setError(String(groupError));
      return false;
    }
    // Las categorias que quedan sueltas guardan la posicion que tenia el grupo.
    await saveLayout(removeGroupFromSidebar(previousLayout, group));
    return true;
  }, [library?.sidebar, saveLayout]);

  const toggleGroup = useCallback((group: string) => {
    const node = library?.sidebar.find((item) => item.kind === "group" && sameCategory(item.name, group));
    if (!node) return;
    const collapsed = !node.collapsed;
    setLibrary((current) =>
      current
        ? {
            ...current,
            sidebar: current.sidebar.map((item) =>
              item.kind === "group" && sameCategory(item.name, group) ? { ...item, collapsed } : item,
            ),
          }
        : current,
    );
    void setCategoryGroupCollapsed(group, collapsed).catch((groupError) => setError(String(groupError)));
  }, [library?.sidebar]);

  const assignCategoryFromDrop = useCallback((designId: string, category: string) => {
    const design = library?.designs.find((item) => item.id === designId);
    if (design) void saveCategory(design, sameCategory(category, UNCATEGORIZED_CATEGORY) ? null : category);
  }, [library?.designs, saveCategory]);

  const clearHoldCursor = useCallback(() => {
    if (holdCursorTimer.current) {
      window.clearTimeout(holdCursorTimer.current);
      holdCursorTimer.current = 0;
    }
    document.body.classList.remove("pointer-holding");
  }, []);

  const startPointerDrag = useCallback(
    (kind: PointerDragState["kind"], id: string, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      clearHoldCursor();
      holdCursorTimer.current = window.setTimeout(() => {
        if (pointerDragRef.current) document.body.classList.add("pointer-holding");
      }, HOLD_CURSOR_DELAY_MS);
      const next: PointerDragState = {
        kind,
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        target: null,
      };
      pointerDragRef.current = next;
      setPointerDrag(next);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Window-level listeners continue tracking if capture is unavailable.
      }
    },
    [clearHoldCursor],
  );

  const shouldSuppressDragClick = useCallback(() => {
    if (Date.now() >= suppressClickUntil.current) return false;
    suppressClickUntil.current = 0;
    return true;
  }, []);

  useEffect(() => {
    const trackedPointerId = pointerDrag?.pointerId;
    if (trackedPointerId === undefined) return;

    const updateAt = (current: PointerDragState, x: number, y: number) => {
      const next = {
        ...current,
        x,
        y,
        active: true,
        target: dropTargetForDrag(current.kind, current.id, dropTargetAt(x, y)),
      };
      pointerDragRef.current = next;
      setPointerDrag(next);
      return next;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const current = pointerDragRef.current;
      if (!current || event.pointerId !== trackedPointerId) return;
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (!current.active && distance < 6) return;
      event.preventDefault();
      clearHoldCursor();
      document.body.classList.add("pointer-dragging");
      updateAt(current, event.clientX, event.clientY);
    };

    const finishPointerDrag = (event: PointerEvent) => {
      const current = pointerDragRef.current;
      if (!current || event.pointerId !== trackedPointerId) return;
      const finalState = current;
      if (finalState.active) {
        suppressClickUntil.current = Date.now() + 350;
        const target = finalState.target;
        if (target) {
          if (finalState.kind === "design") {
            assignCategoryFromDrop(finalState.id, target.name);
          } else if (library?.sidebar) {
            const nextLayout = moveSidebarNode(
              library.sidebar,
              { kind: finalState.kind, name: finalState.id },
              { kind: target.kind, name: target.name },
              target.position,
            );
            if (nextLayout !== library.sidebar) void saveLayout(nextLayout);
          }
        }
      }
      clearHoldCursor();
      document.body.classList.remove("pointer-dragging");
      pointerDragRef.current = null;
      setPointerDrag(null);
    };

    const cancelPointerDrag = (event: PointerEvent) => {
      if (event.pointerId !== trackedPointerId) return;
      clearHoldCursor();
      document.body.classList.remove("pointer-dragging");
      pointerDragRef.current = null;
      setPointerDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", cancelPointerDrag);
    };
  }, [assignCategoryFromDrop, clearHoldCursor, library?.sidebar, pointerDrag?.pointerId, saveLayout]);

  useEffect(() => {
    if (!pointerDrag?.active) return;
    let frame = 0;
    const scrollCategories = () => {
      const current = pointerDragRef.current;
      const stack = document.querySelector<HTMLElement>(".filter-stack");
      if (current?.active && stack) {
        const bounds = stack.getBoundingClientRect();
        let scrolled = false;
        if (current.y < bounds.top + 42) {
          stack.scrollTop -= 10;
          scrolled = true;
        }
        if (current.y > bounds.bottom - 42) {
          stack.scrollTop += 10;
          scrolled = true;
        }
        if (scrolled) {
          const target = dropTargetForDrag(current.kind, current.id, dropTargetAt(current.x, current.y));
          if (!sameDropTarget(target, current.target)) {
            const next = { ...current, target };
            pointerDragRef.current = next;
            setPointerDrag(next);
          }
        }
      }
      frame = window.requestAnimationFrame(scrollCategories);
    };
    frame = window.requestAnimationFrame(scrollCategories);
    return () => window.cancelAnimationFrame(frame);
  }, [pointerDrag?.active]);

  const addTagToDesign = useCallback(async (design: Design, tag: string) => {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return;
    updateDesignLocal(design.id, (item) => {
      if (item.classification.tags.includes(normalized)) return item;
      return { ...item, classification: { ...item.classification, tags: [...item.classification.tags, normalized].sort() } };
    });
    setLibrary((current) => {
      if (!current || current.tags.includes(normalized)) return current;
      return { ...current, tags: [...current.tags, normalized].sort((a, b) => a.localeCompare(b)) };
    });
    try {
      await addTag(design.id, normalized);
    } catch (tagError) {
      setError(String(tagError));
    }
  }, [updateDesignLocal]);

  const removeTagFromDesign = useCallback(async (design: Design, tag: string) => {
    updateDesignLocal(design.id, (item) => ({
      ...item,
      classification: { ...item.classification, tags: item.classification.tags.filter((itemTag) => itemTag !== tag) },
    }));
    try {
      await removeTag(design.id, tag);
    } catch (tagError) {
      setError(String(tagError));
    }
  }, [updateDesignLocal]);

  const chooseRandom = useCallback(() => {
    if (!library || randomDesigns.length === 0) {
      setError("No hay estampas con imagen para elegir al azar.");
      return;
    }

    const validIds = new Set(randomDesigns.map((design) => design.id));
    let usedIds = readRandomHistory(library.rootPath, validIds);
    let pool = randomDesigns.filter((design) => !usedIds.includes(design.id));

    if (pool.length === 0) {
      usedIds = [];
      pool = randomDesigns;
    }

    let candidatePool = pool;
    if (selectedId && pool.length > 1) {
      const withoutCurrent = pool.filter((design) => design.id !== selectedId);
      if (withoutCurrent.length > 0) candidatePool = withoutCurrent;
    }

    const random = chooseRandomDesign(candidatePool);
    if (!random) return;

    const nextUsedIds = Array.from(new Set([...usedIds, random.id]));
    writeRandomHistory(library.rootPath, nextUsedIds);
    setRandomProgress({ seen: nextUsedIds.length, total: randomDesigns.length });
    setFilters(createDefaultFilters());
    setSelectedId(random.id);
    setIsChangingPage(false);

    const designIndex = library.designs.findIndex((design) => design.id === random.id);
    if (designIndex >= 0) {
      setPageIndex(Math.floor(designIndex / PAGE_SIZE));
    }
  }, [library, randomDesigns, selectedId]);

  const prepareThumbnails = useCallback(async () => {
    if (!library || thumbnailPrep.phase === "running") return;

    const queue = library.designs.filter((design) => design.previewPath && !design.thumbnailPath);
    if (queue.length === 0) {
      setThumbnailPrep({
        phase: "done",
        done: 0,
        total: 0,
        message: "Todas las miniaturas ya estan preparadas.",
      });
      return;
    }

    setThumbnailPrep({
      phase: "running",
      done: 0,
      total: queue.length,
      message: "Preparando miniaturas cacheadas...",
    });

    // Lotes de 32 procesados en paralelo del lado de Rust (varios hilos a la
    // vez). Antes se pedia una imagen por vez desde aca, que dejaba el motor
    // trabajando con un solo hilo sin importar cuantos nucleos tuviera la PC.
    const BATCH_SIZE = 32;
    let completed = 0;
    let failed = 0;
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      try {
        const results = await generateThumbnailsBulk(
          batch.map((design) => [design.previewPath!, design.updatedAt]),
        );
        const byPath = new Map(results);
        for (const design of batch) {
          const thumbnailPath = byPath.get(design.previewPath!);
          if (thumbnailPath) {
            updateDesignLocal(design.id, (item) => ({ ...item, thumbnailPath }));
          } else {
            failed += 1;
          }
        }
      } catch {
        // Some source files can be invalid or too large; keep preparing the rest.
        failed += batch.length;
      }

      completed += batch.length;
      setThumbnailPrep({
        phase: "running",
        done: completed,
        total: queue.length,
        message: "Preparando miniaturas cacheadas...",
      });
    }

    setThumbnailPrep({
      phase: "done",
      done: completed,
      total: queue.length,
      message:
        failed > 0
          ? `Miniaturas preparadas. ${failed} imagenes no se pudieron convertir.`
          : "Miniaturas preparadas. La galeria lateral ya usa cache.",
    });
  }, [library, thumbnailPrep.phase, updateDesignLocal]);

  const preparePreviews = useCallback(async () => {
    if (!library || previewPrep.phase === "running") return;

    const queue = library.designs.filter((design) => design.previewPath && !design.previewCachePath);
    if (queue.length === 0) {
      setPreviewPrep({
        phase: "done",
        done: 0,
        total: 0,
        message: "Todos los previews del visor ya estan optimizados.",
      });
      return;
    }

    setPreviewPrep({
      phase: "running",
      done: 0,
      total: queue.length,
      message: "Optimizando previews del visor en segundo plano...",
    });

    const BATCH_SIZE = 24;
    let completed = 0;
    let failed = 0;
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      try {
        const results = await generatePreviewsBulk(
          batch.map((design) => [design.previewPath!, design.updatedAt]),
        );
        const byPath = new Map(results);
        for (const design of batch) {
          const previewCachePath = byPath.get(design.previewPath!);
          if (previewCachePath) {
            updateDesignLocal(design.id, (item) => ({ ...item, previewCachePath }));
          } else {
            failed += 1;
          }
        }
      } catch {
        failed += batch.length;
      }

      completed += batch.length;
      setPreviewPrep({
        phase: "running",
        done: completed,
        total: queue.length,
        message: "Optimizando previews del visor en segundo plano...",
      });
    }

    setPreviewPrep({
      phase: "done",
      done: completed,
      total: queue.length,
      message:
        failed > 0
          ? `Previews optimizados. ${failed} imagenes no se pudieron convertir.`
          : "Previews optimizados. El visor ya abre las imagenes desde cache liviano.",
    });
  }, [library, previewPrep.phase, updateDesignLocal]);

  // Las miniaturas se preparan solas en segundo plano: sin ellas la grilla
  // termina cargando las vistas previas grandes para cada tarjeta.
  const pendingBaseline = useRef<number | null>(null);
  const prepareThumbnailsRef = useRef(prepareThumbnails);
  useEffect(() => {
    prepareThumbnailsRef.current = prepareThumbnails;
  }, [prepareThumbnails]);
  useEffect(() => {
    if (!library || thumbnailPrep.phase === "running") return;
    const pending = library.designs.filter(
      (design) => design.previewPath && !design.thumbnailPath,
    ).length;
    const previous = pendingBaseline.current;
    pendingBaseline.current = pending;
    if (pending === 0) return;
    // Arranca en la primera carga y cada vez que aparecen estampas nuevas sin
    // miniatura (por ejemplo despues de un rescaneo). Comparar contra la marca
    // anterior evita reintentar en bucle los archivos que no se pueden convertir.
    if (previous !== null && pending <= previous) return;
    // Sin cleanup: la biblioteca se actualiza sola mientras corre el cache y
    // cancelar el temporizador dejaria las miniaturas sin generar nunca.
    window.setTimeout(() => void prepareThumbnailsRef.current(), 2500);
  }, [library, thumbnailPrep.phase]);

  const previewPendingBaseline = useRef<number | null>(null);
  const preparePreviewsRef = useRef(preparePreviews);
  useEffect(() => {
    preparePreviewsRef.current = preparePreviews;
  }, [preparePreviews]);
  useEffect(() => {
    if (!library || thumbnailPrep.phase === "running" || previewPrep.phase === "running") return;
    const thumbnailsPending = library.designs.some(
      (design) => design.previewPath && !design.thumbnailPath,
    );
    if (thumbnailsPending) return;

    const pending = library.designs.filter(
      (design) => design.previewPath && !design.previewCachePath,
    ).length;
    const previous = previewPendingBaseline.current;
    previewPendingBaseline.current = pending;
    if (pending === 0) return;
    if (previous !== null && pending <= previous) return;
    window.setTimeout(() => void preparePreviewsRef.current(), 3500);
  }, [library, previewPrep.phase, thumbnailPrep.phase]);

  const goToPage = useCallback((nextPageIndex: number) => {
    if (isChangingPage) return;
    const clampedPage = Math.max(0, Math.min(nextPageIndex, totalPages - 1));
    if (clampedPage === currentPageIndex) return;
    setIsChangingPage(true);
    window.setTimeout(() => {
      setPageIndex(clampedPage);
      setIsChangingPage(false);
    }, 120);
  }, [currentPageIndex, isChangingPage, totalPages]);

  const checkForUpdates = useCallback(async () => {
    if (["checking", "downloading", "installing"].includes(updateState.phase)) return;

    setUpdateState({
      phase: "checking",
      message: "Buscando actualizacion...",
      progress: null,
    });

    try {
      const update = await check({ timeout: 30000 });
      if (!update) {
        setUpdateState({
          phase: "none",
          message: "No hay actualizaciones disponibles.",
          progress: null,
        });
        return;
      }

      let downloaded = 0;
      let contentLength = 0;
      setUpdateState({
        phase: "downloading",
        message: `Descargando version ${update.version}...`,
        progress: 0,
      });

      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
          setUpdateState({
            phase: "downloading",
            message: `Descargando version ${update.version}...`,
            progress: contentLength > 0 ? 0 : null,
          });
        }

        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateState({
            phase: "downloading",
            message: `Descargando version ${update.version}...`,
            progress: contentLength > 0 ? Math.min(99, Math.round((downloaded / contentLength) * 100)) : null,
          });
        }

        if (event.event === "Finished") {
          setUpdateState({
            phase: "installing",
            message: "Instalando actualizacion...",
            progress: 100,
          });
        }
      });

      setUpdateState({
        phase: "done",
        message: "Actualizacion instalada. Reiniciando...",
        progress: 100,
      });
      await relaunch();
    } catch (updateError) {
      const message = String(updateError);
      if (message.includes("valid release JSON") || message.includes("latest.json") || message.includes("404")) {
        setUpdateState({
          phase: "none",
          message: "Todavia no hay una actualizacion publicada.",
          progress: null,
        });
        return;
      }

      setUpdateState({
        phase: "error",
        message: `No se pudo actualizar: ${message}`,
        progress: null,
      });
    }
  }, [updateState.phase]);

  const goToOffset = (offset: number) => {
    if (filteredDesigns.length === 0) return;
    const nextIndex = (selectedIndex + offset + filteredDesigns.length) % filteredDesigns.length;
    setSelectedId(filteredDesigns[nextIndex].id);
  };

  const openFolderForDesign = useCallback(async (design: Design) => {
    try {
      await openDesignFolder(design.directory);
    } catch (openError) {
      setError(String(openError));
    }
  }, []);

  const saveBackupCopy = useCallback(async () => {
    setBackupState({ phase: "saving", message: "Guardando copia de seguridad...", path: null });
    try {
      const backup = await saveDatabaseBackup();
      setBackupState({
        phase: "saved",
        message: `Copia guardada: ${backup.categories.toLocaleString("es-AR")} categorias, ${backup.manualCategoryDesigns.toLocaleString("es-AR")} categorias manuales.`,
        path: backup.path,
      });
    } catch (backupError) {
      setBackupState({ phase: "error", message: `No se pudo guardar: ${String(backupError)}`, path: null });
    }
  }, []);

  const openBackupLocation = useCallback(async () => {
    setBackupState((current) => ({ ...current, phase: "opening", message: current.message ?? "Abriendo carpeta de copias..." }));
    try {
      const folder = await openBackupFolder();
      setBackupState((current) => ({
        phase: current.phase === "opening" ? "idle" : current.phase,
        message: current.message,
        path: current.path ?? folder,
      }));
    } catch (backupError) {
      setBackupState({ phase: "error", message: `No se pudo abrir la carpeta: ${String(backupError)}`, path: null });
    }
  }, []);

  const restoreBackupCopy = useCallback(async () => {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      title: "Cargar copia de seguridad de Biblioteca Visual",
      filters: [{ name: "Copia de seguridad Biblioteca Visual", extensions: ["sqlite", "db"] }],
    });
    if (typeof selected !== "string") return;
    if (!window.confirm("Cargar esta copia reemplaza el guardado actual de Biblioteca Visual. Antes de reemplazarlo, la app guarda una copia de seguridad del estado actual. Continuar?")) return;

    setBackupState({ phase: "loading", message: "Cargando copia de seguridad...", path: selected });
    try {
      const response = await restoreDatabaseBackup(selected);
      applyLibrary(response);
      setDetailsById({});
      setFilters(createDefaultFilters());
      setBackupState({
        phase: "loaded",
        message: `Copia cargada: ${response.categories.length.toLocaleString("es-AR")} categorias y ${response.designs.length.toLocaleString("es-AR")} estampas.`,
        path: selected,
      });
    } catch (backupError) {
      setBackupState({ phase: "error", message: `No se pudo cargar: ${String(backupError)}`, path: selected });
    }
  }, [applyLibrary]);

  if (settingsOpen) {
    return (
      <main className="settings-shell">
        <SettingsScreen
          library={library}
          brandLogo={brandLogo}
          brandLogoState={brandLogoState}
          onChooseBrandLogo={chooseBrandLogo}
          onDropBrandLogo={saveBrandLogoPath}
          onRemoveBrandLogo={clearBrandLogo}
          loading={loading || scanning}
          onChooseFolder={chooseFolder}
          onRunScan={() => runScan()}
          updateState={updateState}
          onCheckForUpdates={checkForUpdates}
          thumbnailPrep={thumbnailPrep}
          onPrepareThumbnails={prepareThumbnails}
          previewPrep={previewPrep}
          onPreparePreviews={preparePreviews}
          backupState={backupState}
          onSaveBackup={saveBackupCopy}
          onOpenBackupFolder={openBackupLocation}
          onRestoreBackup={restoreBackupCopy}
          error={error}
          onDismissError={() => setError(null)}
          onBack={() => setSettingsOpen(false)}
        />
      </main>
    );
  }

  return (
    <main className="visual-shell">
      <Header
        brandLogo={brandLogo}
        setFilters={setFilters}
        loading={loading || scanning}
        onChooseFolder={chooseFolder}
        onRunScan={() => runScan()}
        onRandomDesign={chooseRandom}
        randomProgress={randomProgress}
        showIconLabels={showIconLabels}
        setShowIconLabels={setShowIconLabels}
        setSettingsOpen={setSettingsOpen}
        uiScale={uiScale}
        setUiScale={setUiScale}
      />

      {error && (
        <div className="error-strip">
          <span>{error}</span>
          <button onClick={() => setError(null)} title="Cerrar">
            <X size={16} />
          </button>
        </div>
      )}

      <section
        className={isResizingLeftPanel ? "visual-workspace resizing-left-panel" : "visual-workspace"}
        style={{ "--left-panel-width": `${leftPanelWidth}px` } as CSSProperties}
      >
        <LeftFilters
          filters={filters}
          sidebar={library?.sidebar ?? sidebarFromCategories(library?.categories ?? [])}
          allDesigns={library?.designs ?? []}
          filteredCount={filteredDesigns.length}
          scanning={scanning}
          onCategoryFilter={(category) =>
            setFilters((current) => ({ ...createDefaultFilters(), query: current.query, categories: [category] }))
          }
          onFavoritesFilter={() =>
            setFilters((current) => ({ ...createDefaultFilters(), query: current.query, favoritesOnly: true }))
          }
          onClear={() => setFilters(createDefaultFilters())}
          onCreateCategory={createCategory}
          onRenameCategory={renameCategory}
          onDeleteCategory={removeCategory}
          onCreateGroup={createGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={removeGroup}
          onToggleGroup={toggleGroup}
          dragState={pointerDrag?.active ? pointerDrag : null}
          onStartCategoryDrag={(category, event) => startPointerDrag("category", category, event)}
          onStartGroupDrag={(group, event) => startPointerDrag("group", group, event)}
          shouldSuppressDragClick={shouldSuppressDragClick}
        />

        <button
          type="button"
          className="left-panel-resizer"
          onPointerDown={startLeftPanelResize}
          title="Arrastrar para ajustar categorias"
          aria-label="Ajustar ancho del panel de categorias"
        />

        <Viewer
          design={selectedDesign}
          loading={loading || scanning}
          zoom={zoom}
          setZoom={setZoom}
          onPrev={() => goToOffset(-1)}
          onNext={() => goToOffset(1)}
          onOpenFolder={openFolderForDesign}
        />

        <RightRail
          designs={visibleDesigns}
          totalCount={filteredDesigns.length}
          pageStart={pageStart}
          pageEnd={pageEnd}
          pageIndex={currentPageIndex}
          totalPages={totalPages}
          isChangingPage={isChangingPage}
          selectedId={selectedDesign?.id ?? null}
          categories={library?.categories ?? []}
          filters={filters}
          setFilters={setFilters}
          thumbMode={thumbMode}
          setThumbMode={setThumbMode}
          onSelect={setSelectedId}
          onFavorite={setFavorite}
          onCategory={saveCategory}
          onPageChange={goToPage}
          dragState={pointerDrag?.active ? pointerDrag : null}
          onStartDesignDrag={(designId, event) => startPointerDrag("design", designId, event)}
          shouldSuppressDragClick={shouldSuppressDragClick}
        />
      </section>

      {pointerDrag?.active && (
        <div
          className={`pointer-drag-ghost ${pointerDrag.kind}`}
          style={{ left: pointerDrag.x + 16, top: pointerDrag.y + 16 }}
        >
          {pointerDrag.kind === "design" ? <FileImage size={15} /> : null}
          {pointerDrag.kind === "category" ? <Tags size={15} /> : null}
          {pointerDrag.kind === "group" ? <FolderPlus size={15} /> : null}
          <span>
            {pointerDrag.kind === "design"
              ? library?.designs.find((design) => design.id === pointerDrag.id)?.name ?? "Estampa"
              : pointerDrag.id}
          </span>
        </div>
      )}

    </main>
  );
}

function Header({
  brandLogo,
  setFilters,
  loading,
  onChooseFolder,
  onRunScan,
  onRandomDesign,
  randomProgress,
  showIconLabels,
  setShowIconLabels,
  setSettingsOpen,
  uiScale,
  setUiScale,
}: {
  brandLogo: BrandLogo | null;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  loading: boolean;
  onChooseFolder: () => void;
  onRunScan: () => void;
  onRandomDesign: () => void;
  randomProgress: RandomProgress;
  showIconLabels: boolean;
  setShowIconLabels: (show: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
}) {
  // El zoom cambia el tamano del propio deslizador, asi que mientras se
  // arrastra solo se mueve este borrador y el zoom se aplica al soltar.
  const [scaleDraft, setScaleDraft] = useState<number | null>(null);
  const [interfaceOpen, setInterfaceOpen] = useState(false);
  const interfaceMenuRef = useRef<HTMLDivElement>(null);
  const scaleValue = scaleDraft ?? uiScale;

  const commitScale = useCallback(() => {
    if (scaleDraft === null) return;
    if (scaleDraft !== uiScale) setUiScale(scaleDraft);
    setScaleDraft(null);
  }, [scaleDraft, setUiScale, uiScale]);

  useEffect(() => {
    if (scaleDraft === null) return;
    const release = () => commitScale();
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [commitScale, scaleDraft]);

  useEffect(() => {
    if (!interfaceOpen) return;
    const closeInterfaceMenu = (event: PointerEvent) => {
      if (!interfaceMenuRef.current?.contains(event.target as Node)) setInterfaceOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInterfaceOpen(false);
    };
    window.addEventListener("pointerdown", closeInterfaceMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", closeInterfaceMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [interfaceOpen]);

  const applyScale = (scale: number) => {
    setScaleDraft(null);
    setUiScale(scale);
  };

  const randomRemaining = Math.max(0, randomProgress.total - randomProgress.seen);

  return (
    <header className="visual-header">
      <section className={brandLogo ? "logo-area has-logo" : "logo-area empty"} aria-label="Logo de marca">
        {brandLogo && (
          <img
            className="brand-logo"
            src={brandLogo.dataUrl}
            alt="Logo de la marca"
            draggable={false}
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        )}
      </section>

      <section className="window-actions">
        <button className="action-button" onClick={onChooseFolder} title="Cambiar biblioteca de estampas">
          <FolderOpen size={17} />
          <span>Elegir biblioteca</span>
        </button>
        <button className="action-button rescan-action" onClick={onRunScan} title="Rescanear la biblioteca">
          <RefreshCw size={18} className={loading ? "spin" : ""} />
          <span>Rescaneo</span>
        </button>
        <button className="icon-only" onClick={() => setFilters(createDefaultFilters())} title="Limpiar filtros">
          <MoreVertical size={18} />
        </button>
        <button
          className="icon-only random-action"
          onClick={onRandomDesign}
          disabled={randomProgress.total === 0}
          title={`Elegir una estampa al azar sin repetir. Quedan ${randomRemaining.toLocaleString("es-AR")} de ${randomProgress.total.toLocaleString("es-AR")}.`}
        >
          <Shuffle size={15} />
        </button>
        <div className="settings-menu">
          <button className="icon-only" title="Ajustes" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} />
          </button>
        </div>
        <div ref={interfaceMenuRef} className="interface-menu">
          <button
            type="button"
            className={interfaceOpen ? "interface-trigger active" : "interface-trigger"}
            onClick={() => setInterfaceOpen((open) => !open)}
            aria-expanded={interfaceOpen}
          >
            Interfaz
          </button>
          {interfaceOpen && (
            <div className="interface-popover">
              <div className="settings-scale">
                <div className="settings-scale-label">
                  <span>Tamano de la interfaz</span>
                  <strong>{scaleValue}%</strong>
                </div>
                <div className="settings-scale-controls">
                  <button
                    type="button"
                    onClick={() => applyScale(Math.max(UI_SCALE_MIN, uiScale - UI_SCALE_STEP))}
                    disabled={uiScale <= UI_SCALE_MIN}
                    title="Achicar interfaz"
                    aria-label="Achicar interfaz"
                  >
                    <Minus size={14} />
                  </button>
                  <input
                    type="range"
                    min={UI_SCALE_MIN}
                    max={UI_SCALE_MAX}
                    step={UI_SCALE_STEP}
                    value={scaleValue}
                    onChange={(event) => setScaleDraft(Number(event.target.value))}
                    onPointerUp={commitScale}
                    onKeyUp={commitScale}
                    onBlur={commitScale}
                    aria-label="Tamano de la interfaz"
                    title="Arrastra tranquilo: el tamano cambia cuando soltas"
                  />
                  <button
                    type="button"
                    onClick={() => applyScale(Math.min(UI_SCALE_MAX, uiScale + UI_SCALE_STEP))}
                    disabled={uiScale >= UI_SCALE_MAX}
                    title="Agrandar interfaz"
                    aria-label="Agrandar interfaz"
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => applyScale(100)}
                    disabled={uiScale === 100}
                    title="Restablecer al 100%"
                    aria-label="Restablecer tamano"
                  >
                    <RotateCcw size={14} />
                  </button>
                </div>
                <div className="settings-scale-presets">
                  {UI_SCALE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={uiScale === preset ? "active" : ""}
                      onClick={() => applyScale(preset)}
                      title={`Interfaz al ${preset}%`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                {scaleDraft !== null && scaleDraft !== uiScale && (
                  <p className="settings-scale-hint">Solta para aplicar el {scaleDraft}%</p>
                )}
              </div>
              <label className="settings-toggle">
                <input type="checkbox" checked={showIconLabels} onChange={(event) => setShowIconLabels(event.target.checked)} />
                <span />
                <strong>Textos en iconos</strong>
              </label>
            </div>
          )}
        </div>
      </section>
    </header>
  );
}

function SettingsScreen({
  library,
  brandLogo,
  brandLogoState,
  onChooseBrandLogo,
  onDropBrandLogo,
  onRemoveBrandLogo,
  loading,
  onChooseFolder,
  onRunScan,
  updateState,
  onCheckForUpdates,
  thumbnailPrep,
  onPrepareThumbnails,
  previewPrep,
  onPreparePreviews,
  backupState,
  onSaveBackup,
  onOpenBackupFolder,
  onRestoreBackup,
  error,
  onDismissError,
  onBack,
}: {
  library: LibraryResponse | null;
  brandLogo: BrandLogo | null;
  brandLogoState: BrandLogoState;
  onChooseBrandLogo: () => void;
  onDropBrandLogo: (path: string) => void | Promise<void>;
  onRemoveBrandLogo: () => void;
  loading: boolean;
  onChooseFolder: () => void;
  onRunScan: () => void;
  updateState: AppUpdateState;
  onCheckForUpdates: () => void;
  thumbnailPrep: ThumbnailPrepState;
  onPrepareThumbnails: () => void;
  previewPrep: ThumbnailPrepState;
  onPreparePreviews: () => void;
  backupState: BackupState;
  onSaveBackup: () => void;
  onOpenBackupFolder: () => void;
  onRestoreBackup: () => void;
  error: string | null;
  onDismissError: () => void;
  onBack: () => void;
}) {
  const [brandDragActive, setBrandDragActive] = useState(false);
  const brandDropRef = useRef<HTMLDivElement>(null);
  const draggedBrandPathsRef = useRef<string[]>([]);
  const updateBusy = updateState.phase === "checking" || updateState.phase === "downloading" || updateState.phase === "installing";
  const thumbnailBusy = thumbnailPrep.phase === "running";
  const thumbnailProgress = thumbnailPrep.total > 0 ? Math.round((thumbnailPrep.done / thumbnailPrep.total) * 100) : null;
  const previewBusy = previewPrep.phase === "running";
  const previewProgress = previewPrep.total > 0 ? Math.round((previewPrep.done / previewPrep.total) * 100) : null;
  const backupBusy = backupState.phase === "saving" || backupState.phase === "opening" || backupState.phase === "loading";
  const brandLogoBusy = brandLogoState.phase === "saving" || brandLogoState.phase === "removing";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const isInsideBrandDrop = (position: { x: number; y: number }) => {
      const bounds = brandDropRef.current?.getBoundingClientRect();
      if (!bounds) return false;
      const pixelRatio = window.devicePixelRatio || 1;
      const x = position.x / pixelRatio;
      const y = position.y / pixelRatio;
      return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === "enter") {
          draggedBrandPathsRef.current = payload.paths;
          setBrandDragActive(payload.paths.length > 0 && isInsideBrandDrop(payload.position));
          return;
        }
        if (payload.type === "over") {
          setBrandDragActive(draggedBrandPathsRef.current.length > 0 && isInsideBrandDrop(payload.position));
          return;
        }
        if (payload.type === "drop") {
          const droppedPath = payload.paths[0];
          const shouldSave = droppedPath && isInsideBrandDrop(payload.position);
          draggedBrandPathsRef.current = [];
          setBrandDragActive(false);
          if (shouldSave) void onDropBrandLogo(droppedPath);
          return;
        }
        draggedBrandPathsRef.current = [];
        setBrandDragActive(false);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        if (!disposed) setBrandDragActive(false);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onDropBrandLogo]);

  return (
    <section className="settings-screen">
      <header className="settings-screen-header">
        <button type="button" className="settings-back" onClick={onBack} title="Volver a la biblioteca">
          <ChevronLeft size={20} />
          <span>Volver</span>
        </button>
        <div className="settings-screen-title">
          <Settings size={22} />
          <div>
            <h1>Configuracion</h1>
            <p>Personaliza la aplicacion y administra la biblioteca.</p>
          </div>
        </div>
      </header>

      {error && (
        <div className="error-strip settings-error">
          <span>{error}</span>
          <button onClick={onDismissError} title="Cerrar">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="settings-screen-scroll">
        <div className="settings-grid">
          <section className="settings-card">
            <div className="settings-card-header">
              <FileImage size={19} />
              <div>
                <h2>Identidad de marca</h2>
                <p>Logo que aparece en la esquina superior de la aplicacion.</p>
              </div>
            </div>
            <div className="settings-brand">
              <div
                ref={brandDropRef}
                className={`settings-brand-preview brand-drop-zone ${brandLogo ? "has-logo" : "empty"} ${brandDragActive ? "drag-active" : ""}`}
              >
                {brandDragActive ? (
                  <div className="brand-drop-prompt">
                    <Upload size={24} />
                    <strong>Solta la imagen para usarla como logo</strong>
                  </div>
                ) : brandLogo ? (
                  <img src={brandLogo.dataUrl} alt="Vista previa del logo" />
                ) : (
                  <>
                    <ImageOff size={20} />
                    <span>Arrastra una imagen aca o usa el boton</span>
                  </>
                )}
              </div>
              <div className="settings-brand-actions">
                <button type="button" onClick={onChooseBrandLogo} disabled={brandLogoBusy}>
                  {brandLogoState.phase === "saving" ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
                  <span>{brandLogo ? "Cambiar imagen" : "Cargar imagen"}</span>
                </button>
                {brandLogo && (
                  <button type="button" className="danger" onClick={onRemoveBrandLogo} disabled={brandLogoBusy} title="Quitar logo">
                    {brandLogoState.phase === "removing" ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
                  </button>
                )}
              </div>
              <small>Arrastra una imagen sobre la vista previa o elegila con el boton. PNG, JPG o WebP.</small>
              {brandLogoState.message && (
                <div className={`update-status ${brandLogoState.phase}`} aria-live="polite">
                  <span>{brandLogoState.message}</span>
                </div>
              )}
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-header">
              <FolderOpen size={19} />
              <div>
                <h2>Biblioteca y rendimiento</h2>
                <p>Ubicacion de las estampas y caches visuales.</p>
              </div>
            </div>
            <div className="settings-library-path">
              <small>Biblioteca actual</small>
              <strong title={library?.rootPath ?? DEFAULT_LIBRARY_PATH}>{library?.rootPath ?? DEFAULT_LIBRARY_PATH}</strong>
            </div>
            <div className="settings-action-list">
              <button className="settings-action secondary" onClick={onChooseFolder} disabled={loading}>
                <FolderOpen size={16} />
                <span>Cambiar biblioteca</span>
              </button>
              <button className="settings-action" onClick={onRunScan} disabled={loading}>
                <RefreshCw size={16} className={loading ? "spin" : ""} />
                <span>Escanear biblioteca</span>
              </button>
              <button className="settings-action secondary" onClick={onPrepareThumbnails} disabled={thumbnailBusy || !library}>
                {thumbnailBusy ? <Loader2 size={16} className="spin" /> : <FileImage size={16} />}
                <span>{thumbnailBusy ? "Preparando..." : "Preparar miniaturas"}</span>
              </button>
              {thumbnailPrep.message && (
                <div className={`update-status ${thumbnailPrep.phase}`} aria-live="polite">
                  <span>{thumbnailPrep.message}</span>
                  {thumbnailPrep.total > 0 && (
                    <>
                      <small>{thumbnailPrep.done.toLocaleString("es-AR")} de {thumbnailPrep.total.toLocaleString("es-AR")}</small>
                      <div className="update-progress" aria-label={`Progreso ${thumbnailProgress ?? 0}%`}>
                        <span style={{ width: `${thumbnailProgress ?? 0}%` }} />
                      </div>
                    </>
                  )}
                </div>
              )}
              <button className="settings-action secondary" onClick={onPreparePreviews} disabled={previewBusy || !library}>
                {previewBusy ? <Loader2 size={16} className="spin" /> : <Maximize2 size={16} />}
                <span>{previewBusy ? "Optimizando visor..." : "Optimizar visor"}</span>
              </button>
              {previewPrep.message && (
                <div className={`update-status ${previewPrep.phase}`} aria-live="polite">
                  <span>{previewPrep.message}</span>
                  {previewPrep.total > 0 && (
                    <>
                      <small>{previewPrep.done.toLocaleString("es-AR")} de {previewPrep.total.toLocaleString("es-AR")}</small>
                      <div className="update-progress" aria-label={`Progreso ${previewProgress ?? 0}%`}>
                        <span style={{ width: `${previewProgress ?? 0}%` }} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-header">
              <Save size={19} />
              <div>
                <h2>Datos y actualizaciones</h2>
                <p>Copias de seguridad y mantenimiento de la aplicacion.</p>
              </div>
            </div>
            <div className="settings-backup">
              <div className="settings-section-label">Copia de seguridad</div>
              <div className="settings-backup-actions">
                <button type="button" onClick={onSaveBackup} disabled={backupBusy} title="Guardar copia de seguridad">
                  {backupState.phase === "saving" ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
                  <span>Guardar</span>
                </button>
                <button type="button" onClick={onOpenBackupFolder} disabled={backupBusy} title="Abrir carpeta de copias">
                  <FolderOpen size={15} />
                  <span>Carpeta</span>
                </button>
                <button type="button" onClick={onRestoreBackup} disabled={backupBusy} title="Cargar copia de seguridad">
                  {backupState.phase === "loading" ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
                  <span>Cargar</span>
                </button>
              </div>
              {backupState.message && (
                <div className={`update-status ${backupState.phase}`} aria-live="polite">
                  <span>{backupState.message}</span>
                  {backupState.path && <small>{backupState.path}</small>}
                </div>
              )}
            </div>
            <button className="settings-action secondary" onClick={onCheckForUpdates} disabled={updateBusy}>
              {updateState.phase === "done" || updateState.phase === "none" ? (
                <Check size={16} />
              ) : (
                <RefreshCw size={16} className={updateBusy ? "spin" : ""} />
              )}
              <span>{updateBusy ? "Actualizando..." : "Buscar actualizacion"}</span>
            </button>
            {updateState.message && (
              <div className={`update-status ${updateState.phase}`} aria-live="polite">
                <span>{updateState.message}</span>
                {updateState.progress !== null && (
                  <div className="update-progress" aria-label={`Progreso ${updateState.progress}%`}>
                    <span style={{ width: `${updateState.progress}%` }} />
                  </div>
                )}
              </div>
            )}
          </section>

        </div>
      </div>
    </section>
  );
}

function LeftFilters({
  filters,
  sidebar,
  allDesigns,
  filteredCount,
  scanning,
  onCategoryFilter,
  onFavoritesFilter,
  onClear,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onToggleGroup,
  dragState,
  onStartCategoryDrag,
  onStartGroupDrag,
  shouldSuppressDragClick,
}: {
  filters: Filters;
  sidebar: SidebarNode[];
  allDesigns: Design[];
  filteredCount: number;
  scanning: boolean;
  onCategoryFilter: (category: string) => void;
  onFavoritesFilter: () => void;
  onClear: () => void;
  onCreateCategory: (name: string) => Promise<string | null>;
  onRenameCategory: (currentName: string, newName: string) => Promise<string | null>;
  onDeleteCategory: (category: string) => Promise<boolean>;
  onCreateGroup: (name: string) => Promise<string | null>;
  onRenameGroup: (currentName: string, newName: string) => Promise<string | null>;
  onDeleteGroup: (group: string) => Promise<boolean>;
  onToggleGroup: (group: string) => void;
  dragState: PointerDragState | null;
  onStartCategoryDrag: (category: string, event: React.PointerEvent<HTMLElement>) => void;
  onStartGroupDrag: (group: string, event: React.PointerEvent<HTMLElement>) => void;
  shouldSuppressDragClick: () => boolean;
}) {
  const [adding, setAdding] = useState<SidebarNodeKind | null>(null);
  const [newName, setNewName] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [editing, setEditing] = useState<SidebarDragSource | null>(null);
  const [editingName, setEditingName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SidebarDragSource | null>(null);
  const [deleting, setDeleting] = useState(false);
  const renameCancelled = useRef(false);
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const design of allDesigns) {
      const category = design.classification.category;
      if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return counts;
  }, [allDesigns]);
  const uncategorizedCount = useMemo(
    () => allDesigns.filter((design) => !design.classification.category).length,
    [allDesigns],
  );
  const favoritesCount = useMemo(
    () => allDesigns.filter((design) => design.classification.favorite).length,
    [allDesigns],
  );

  useEffect(() => {
    if (!createMenuOpen) return;
    const closeMenu = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && (event.target as HTMLElement | null)?.closest(".create-menu-anchor")) return;
      setCreateMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [createMenuOpen]);

  useEffect(() => {
    if (!pendingDelete) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPendingDelete(null);
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [pendingDelete]);

  const startAdding = (kind: SidebarNodeKind) => {
    setCreateMenuOpen(false);
    setNewName("");
    setAdding((current) => (current === kind ? null : kind));
  };

  const submitNew = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const created = adding === "group" ? await onCreateGroup(newName) : await onCreateCategory(newName);
    if (created) {
      setNewName("");
      setAdding(null);
    }
  };

  const commitRename = async (node: SidebarDragSource) => {
    if (sameCategory(node.name, editingName.trim())) {
      setEditing(null);
      setEditingName("");
      return;
    }
    const renamed = node.kind === "group"
      ? await onRenameGroup(node.name, editingName)
      : await onRenameCategory(node.name, editingName);
    if (renamed) {
      setEditing(null);
      setEditingName("");
    }
  };

  const beginRename = (node: SidebarDragSource) => {
    renameCancelled.current = false;
    setEditing(node);
    setEditingName(node.name);
  };

  const isEditing = (node: SidebarDragSource) =>
    editing?.kind === node.kind && sameCategory(editing.name, node.name);

  const confirmDelete = async () => {
    const node = pendingDelete;
    if (!node || deleting) return;
    setDeleting(true);
    const deleted = node.kind === "group" ? await onDeleteGroup(node.name) : await onDeleteCategory(node.name);
    setDeleting(false);
    if (!deleted) return;
    if (isEditing(node)) {
      setEditing(null);
      setEditingName("");
    }
    setPendingDelete(null);
  };

  const renameForm = (node: SidebarDragSource) => (
    <form
      className="category-edit-form inline-rename"
      onSubmit={(event) => {
        event.preventDefault();
        (event.currentTarget.elements.namedItem("categoryName") as HTMLInputElement | null)?.blur();
      }}
    >
      <input
        name="categoryName"
        autoFocus
        value={editingName}
        onChange={(event) => setEditingName(event.target.value)}
        onFocus={() => { renameCancelled.current = false; }}
        onBlur={() => {
          if (!renameCancelled.current) void commitRename(node);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            renameCancelled.current = true;
            setEditing(null);
            setEditingName("");
          }
        }}
        aria-label={`Renombrar ${node.name}`}
      />
    </form>
  );

  const deleteExplanation = (node: SidebarDragSource) => {
    if (node.kind === "group") {
      const inside = sidebar.find((item) => item.kind === "group" && sameCategory(item.name, node.name))?.children ?? [];
      if (inside.length === 0) return "El grupo esta vacio. No se borra ninguna categoria ni ninguna estampa.";
      return inside.length === 1
        ? "La categoria que tiene adentro vuelve al panel. No se borra ninguna categoria ni ninguna estampa."
        : `Las ${inside.length.toLocaleString("es-AR")} categorias que tiene adentro vuelven al panel. No se borra ninguna categoria ni ninguna estampa.`;
    }
    const count = categoryCounts.get(node.name) ?? 0;
    if (count === 0) return "La categoria esta vacia. No se borra ningun archivo.";
    return count === 1
      ? "La estampa que tiene queda sin categoria. No se borra ningun archivo."
      : `Las ${count.toLocaleString("es-AR")} estampas que tiene quedan sin categoria. No se borra ningun archivo.`;
  };

  const dropsOn = (kind: SidebarNodeKind, name: string) =>
    dragState?.target && dragState.target.kind === kind && sameCategory(dragState.target.name, name)
      ? dragState.target.position
      : null;

  const renderCategoryRow = (category: string, insideGroup: boolean) => {
    const node: SidebarDragSource = { kind: "category", name: category };
    const dropPosition = dropsOn("category", category);
    const rowClassName = [
      "category-row",
      insideGroup ? "grouped-category-row" : "",
      dragState?.kind === "category" && sameCategory(dragState.id, category) ? "category-dragging" : "",
      dragState?.kind === "design" && dropPosition ? "design-drop-target" : "",
      dragState?.kind !== "design" && dropPosition ? `category-drop-${dropPosition}` : "",
    ].filter(Boolean).join(" ");

    return (
      <div
        key={category}
        className={rowClassName}
        data-drop-name={category}
        data-drop-kind="category"
        title="Arrastrar para ordenar o meter en un grupo. Doble clic para renombrar."
      >
        {isEditing(node) ? renameForm(node) : (
          <>
            <button
              className={filters.categories.some((item) => sameCategory(item, category)) ? "filter-row active" : "filter-row"}
              onPointerDown={(event) => onStartCategoryDrag(category, event)}
              onClick={(event) => {
                if (shouldSuppressDragClick()) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                onCategoryFilter(category);
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                beginRename(node);
              }}
            >
              <span className="filter-name">
                <span className="category-count" aria-label={`${(categoryCounts.get(category) ?? 0).toLocaleString("es-AR")} estampas`}>
                  {(categoryCounts.get(category) ?? 0).toLocaleString("es-AR")}
                </span>
                <span className="category-label">{category}</span>
              </span>
            </button>
            <div className="category-actions">
              <button
                className="category-action delete"
                draggable={false}
                title={`Eliminar ${category}`}
                aria-label={`Eliminar ${category}`}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setPendingDelete(node)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderGroup = (group: SidebarNode) => {
    const node: SidebarDragSource = { kind: "group", name: group.name };
    const dropPosition = dropsOn("group", group.name);
    const total = group.children.reduce((sum, child) => sum + (categoryCounts.get(child) ?? 0), 0);
    const groupClassName = [
      "category-group",
      group.collapsed ? "collapsed" : "",
      dragState?.kind === "group" && sameCategory(dragState.id, group.name) ? "category-dragging" : "",
      dropPosition === "inside" ? "group-drop-inside" : "",
    ].filter(Boolean).join(" ");
    const headClassName = [
      "category-row",
      "group-head",
      dropPosition && dropPosition !== "inside" ? `category-drop-${dropPosition}` : "",
    ].filter(Boolean).join(" ");

    return (
      <div key={`group:${group.name}`} className={groupClassName}>
        <div
          className={headClassName}
          data-drop-name={group.name}
          data-drop-kind="group"
          title="Clic para desplegar o plegar. Arrastrar para mover el grupo. Doble clic para renombrar."
        >
          {isEditing(node) ? renameForm(node) : (
            <>
              <button
                className="filter-row group-row"
                onPointerDown={(event) => onStartGroupDrag(group.name, event)}
                onClick={(event) => {
                  if (shouldSuppressDragClick()) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  onToggleGroup(group.name);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  beginRename(node);
                }}
                aria-expanded={!group.collapsed}
              >
                <span className="filter-name">
                  {group.collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                  <span className="category-count" aria-label={`${total.toLocaleString("es-AR")} estampas`}>
                    {total.toLocaleString("es-AR")}
                  </span>
                  <span className="category-label">{group.name}</span>
                </span>
              </button>
              <div className="category-actions">
                <button
                  className="category-action delete"
                  draggable={false}
                  title={`Eliminar grupo ${group.name}`}
                  aria-label={`Eliminar grupo ${group.name}`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setPendingDelete(node)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </>
          )}
        </div>

        {!group.collapsed && (
          <div className="group-children" data-drop-name={group.name} data-drop-kind="group-body">
            {group.children.length > 0
              ? group.children.map((child) => renderCategoryRow(child, true))
              : <p className="group-empty">Arrastra categorias aca</p>}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="left-panel">
      <div className="panel-head">
        <span>Categorias</span>
        <div className="panel-actions">
          <div className="create-menu-anchor">
            <div className="split-button">
              <button
                className="panel-icon-button"
                onClick={() => startAdding("category")}
                title="Nueva categoria"
                aria-label="Nueva categoria"
              >
                <Plus size={15} />
              </button>
              <button
                className="panel-icon-button split-caret"
                onClick={() => setCreateMenuOpen((current) => !current)}
                title="Mas opciones"
                aria-label="Mas opciones"
                aria-expanded={createMenuOpen}
              >
                <ChevronDown size={12} />
              </button>
            </div>
            {createMenuOpen && (
              <div className="panel-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => startAdding("group")}>
                  <FolderPlus size={14} />
                  Crear grupo
                </button>
              </div>
            )}
          </div>
          <button className="panel-icon-button" onClick={onClear} title="Limpiar filtros" aria-label="Limpiar filtros">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="filter-stack">
        {adding && (
          <form className={adding === "group" ? "category-edit-form new-category new-group" : "category-edit-form new-category"} onSubmit={submitNew}>
            <input
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={adding === "group" ? "Nuevo grupo" : "Nueva categoria"}
            />
            <button type="submit" title="Crear" aria-label="Crear">
              <Check size={15} />
            </button>
            <button type="button" title="Cancelar" aria-label="Cancelar" onClick={() => { setAdding(null); setNewName(""); }}>
              <X size={15} />
            </button>
          </form>
        )}
        <button
          className={filters.favoritesOnly ? "filter-row favorites-row active" : "filter-row favorites-row"}
          onClick={onFavoritesFilter}
          title="Ver todas mis estampas favoritas"
        >
          <span className="filter-name">
            <Heart size={17} fill={filters.favoritesOnly ? "currentColor" : "none"} />
            Mis favoritos
          </span>
          <span className="favorites-count">{favoritesCount.toLocaleString("es-AR")}</span>
        </button>
        <button
          className={!filters.favoritesOnly && filters.categories.length === 0 ? "filter-row active" : "filter-row"}
          onClick={onClear}
          title="Ver todos los disenos"
        >
          <span className="filter-name">
            <FileText size={16} />
            Todos los disenos
          </span>
          <span>{allDesigns.length.toLocaleString("es-AR")}</span>
        </button>
        <div
          className={[
            "category-row",
            "uncategorized-category-row",
            dragState?.kind === "design" && dropsOn("category", UNCATEGORIZED_CATEGORY) ? "design-drop-target" : "",
          ].filter(Boolean).join(" ")}
          data-drop-name={UNCATEGORIZED_CATEGORY}
          data-drop-kind="category"
          title="Ver estampas sin categoria. Arrastra una estampa aca para quitarle la categoria."
        >
          <button
            className={filters.categories.some((item) => sameCategory(item, UNCATEGORIZED_CATEGORY)) ? "filter-row active" : "filter-row"}
            onClick={(event) => {
              if (shouldSuppressDragClick()) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              onCategoryFilter(UNCATEGORIZED_CATEGORY);
            }}
          >
            <span className="filter-name">
              <span className="category-count" aria-label={`${uncategorizedCount.toLocaleString("es-AR")} estampas`}>
                {uncategorizedCount.toLocaleString("es-AR")}
              </span>
              <span className="category-label">{UNCATEGORIZED_CATEGORY}</span>
            </span>
          </button>
        </div>
        {sidebar.map((node) => (node.kind === "group" ? renderGroup(node) : renderCategoryRow(node.name, false)))}
      </div>

      <div className="left-status">
        <div className={scanning ? "pulse active" : "pulse"} />
        <span>{scanning ? "Escaneando biblioteca" : "Escaneo manual"}</span>
      </div>
      <div className="result-count">{filteredCount.toLocaleString("es-AR")} visibles</div>

      {pendingDelete && (
        <div
          className="confirm-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
          }}
        >
          <div className="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
            <div className="confirm-icon">
              <Trash2 size={20} />
            </div>
            <h2 id="confirm-title">
              {pendingDelete.kind === "group"
                ? `Eliminar el grupo "${pendingDelete.name}"?`
                : `Eliminar la categoria "${pendingDelete.name}"?`}
            </h2>
            <p>{deleteExplanation(pendingDelete)}</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" autoFocus disabled={deleting} onClick={() => setPendingDelete(null)}>
                Cancelar
              </button>
              <button type="button" className="confirm-delete" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
                {pendingDelete.kind === "group" ? "Eliminar grupo" : "Eliminar categoria"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function Viewer({
  design,
  loading,
  zoom,
  setZoom,
  onPrev,
  onNext,
  onOpenFolder,
}: {
  design: Design | null;
  loading: boolean;
  zoom: number;
  setZoom: (zoom: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenFolder: (design: Design) => void;
}) {
  const previewPaths = useMemo(
    () =>
      [design?.previewCachePath, design?.previewPath].filter(
        (path, index, paths): path is string => Boolean(path) && paths.indexOf(path) === index,
      ),
    [design?.previewCachePath, design?.previewPath],
  );
  const [previewSourceIndex, setPreviewSourceIndex] = useState(0);
  const [loadingOriginal, setLoadingOriginal] = useState(false);
  const previewPath = previewPaths[previewSourceIndex] ?? null;
  const preview = previewPath ? convertFileSrc(previewPath) : null;
  // El original solo se ofrece si es un archivo distinto de la copia cacheada.
  const originalPath = design?.previewPath ?? null;
  const canLoadOriginal = Boolean(originalPath) && originalPath !== previewPaths[0];
  const showingOriginal = Boolean(originalPath) && previewPath === originalPath;
  const previewFile = design?.files.find((file) => file.path === design.previewPath) ?? design?.files[0] ?? null;
  const imageCount = design ? countForExtension(design, ".jpg") + countForExtension(design, ".jpeg") + countForExtension(design, ".png") + countForExtension(design, ".webp") : 0;
  const applicationAssets = design ? editableApplicationAssets(design) : [];
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const artboardRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStart = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const assetItems = design
      ? [
          { id: "img", kind: "image" as const, label: "Imagen", value: imageCount, tone: "red" as const },
          { id: "eps", kind: "eps" as const, label: "EPS", value: countForExtension(design, ".eps"), tone: "gold" as const },
        { id: "pdf", kind: "pdf" as const, label: "PDF", value: countForExtension(design, ".pdf"), tone: "neutral" as const },
        { id: "txt", kind: "txt" as const, label: "Texto", value: countForExtension(design, ".txt"), tone: "neutral" as const },
      ].filter((item) => item.value > 0)
    : [];

  useEffect(() => {
    setPreviewSourceIndex(0);
    setLoadingOriginal(false);
  }, [design?.id, design?.previewCachePath, design?.previewPath]);

  /**
   * Carga el archivo original a pedido para poder hacer zoom con detalle real.
   * Es temporal: al cambiar de estampa o cerrar la app se vuelve a la copia liviana.
   */
  const toggleOriginal = useCallback(() => {
    if (showingOriginal) {
      setPreviewSourceIndex(0);
      return;
    }
    const target = originalPath;
    if (!target || loadingOriginal) return;
    setLoadingOriginal(true);
    const loader = new Image();
    const finish = (success: boolean) => {
      setLoadingOriginal(false);
      if (success) setPreviewSourceIndex(previewPaths.indexOf(target));
    };
    loader.onload = () => finish(true);
    loader.onerror = () => finish(false);
    loader.src = convertFileSrc(target);
  }, [loadingOriginal, originalPath, previewPaths, showingOriginal]);

  const clampPan = useCallback(
    (next: { x: number; y: number }, nextZoom = zoom) => {
      const artboard = artboardRef.current;
      const image = imageRef.current;
      if (!artboard || !image) return { x: 0, y: 0 };

      const scale = nextZoom / 100;
      const naturalWidth = image.naturalWidth || artboard.clientWidth;
      const naturalHeight = image.naturalHeight || artboard.clientHeight;
      const fittedScale = Math.min(artboard.clientWidth / naturalWidth, artboard.clientHeight / naturalHeight);
      const renderedWidth = naturalWidth * fittedScale * scale;
      const renderedHeight = naturalHeight * fittedScale * scale;
      const widthOverflow = Math.max(0, renderedWidth - artboard.clientWidth);
      const heightOverflow = Math.max(0, renderedHeight - artboard.clientHeight);
      const maxX = widthOverflow / 2;
      const maxY = heightOverflow / 2;

      return {
        x: Math.max(-maxX, Math.min(maxX, next.x)),
        y: Math.max(-maxY, Math.min(maxY, next.y)),
      };
    },
    [zoom],
  );

  const zoomAt = useCallback(
    (requestedZoom: number, focalPoint = { x: 0, y: 0 }) => {
      const nextZoom = Math.max(25, Math.min(1000, requestedZoom));
      const ratio = nextZoom / zoom;
      const nextPan = {
        x: focalPoint.x - (focalPoint.x - pan.x) * ratio,
        y: focalPoint.y - (focalPoint.y - pan.y) * ratio,
      };
      setZoom(nextZoom);
      setPan(clampPan(nextPan, nextZoom));
    },
    [clampPan, pan.x, pan.y, setZoom, zoom],
  );

  const resetView = useCallback(() => {
    setZoom(defaultZoom);
    setPan({ x: 0, y: 0 });
  }, [setZoom]);

  useEffect(() => {
    resetView();
  }, [design?.id, resetView]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!preview) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      const focalPoint = {
        x: event.clientX - (bounds.left + bounds.width / 2),
        y: event.clientY - (bounds.top + bounds.height / 2),
      };
      zoomAt(event.deltaY > 0 ? zoom / 1.18 : zoom * 1.18, focalPoint);
    },
    [preview, zoom, zoomAt],
  );

  const startPan = useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      if (zoom <= 100) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    },
    [pan.x, pan.y, zoom],
  );

  const movePan = useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      const start = dragStart.current;
      if (!start || start.pointerId !== event.pointerId) return;
      setPan(clampPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y }));
    },
    [clampPan],
  );

  const endPan = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (dragStart.current?.pointerId === event.pointerId) {
      dragStart.current = null;
    }
  }, []);

  return (
    <section className="viewer-stage">
      <button className="nav-arrow left" onClick={onPrev} disabled={!design} title="Anterior">
        <ChevronLeft size={28} />
      </button>

      {design && canLoadOriginal && (
        <div className="viewer-original-bar">
          <button
            className={showingOriginal ? "original-toggle active" : "original-toggle"}
            onClick={toggleOriginal}
            disabled={loadingOriginal}
            title={
              showingOriginal
                ? "Estas viendo el archivo original. Tocá para volver a la vista liviana."
                : "Cargar el archivo original para hacer zoom con todo el detalle."
            }
          >
            {loadingOriginal ? (
              <>
                <Loader2 size={15} className="spin" />
                <span>Cargando original...</span>
              </>
            ) : showingOriginal ? (
              <>
                <Maximize2 size={15} />
                <span>Original</span>
              </>
            ) : (
              <>
                <Maximize2 size={15} />
                <span>Cargar original</span>
              </>
            )}
          </button>
        </div>
      )}

      <div ref={artboardRef} className="artboard" onWheel={handleWheel}>
        {loading && !design ? (
          <div className="viewer-empty">
            <Loader2 className="spin" size={34} />
            <span>Escaneando biblioteca</span>
          </div>
        ) : preview ? (
          <img
            ref={imageRef}
            src={preview}
            alt={design?.name ?? "Estampa"}
            className={zoom > 100 ? "is-zoomed" : ""}
            draggable={false}
            onError={() => setPreviewSourceIndex((current) => current + 1)}
            onLoad={() => setPan((current) => clampPan(current))}
            onDoubleClick={resetView}
            onPointerDown={startPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})` }}
          />
        ) : (
          <div className="viewer-empty">
            <ImageOff size={42} />
            <span>{design?.previewPath ? "No se pudo cargar la vista previa" : "Sin imagen previa"}</span>
          </div>
        )}

      </div>

      {design && (
        <div className="viewer-zoom-controls" aria-label="Controles de zoom">
          <button onClick={() => zoomAt(zoom / 1.25)} disabled={zoom <= 25} title="Alejar" aria-label="Alejar">
            <Minus size={16} />
          </button>
          <strong>{Math.round(zoom)}%</strong>
          <button onClick={() => zoomAt(zoom * 1.25)} disabled={zoom >= 1000} title="Acercar" aria-label="Acercar">
            <Plus size={16} />
          </button>
          <button onClick={resetView} disabled={zoom === 100 && pan.x === 0 && pan.y === 0} title="Ajustar imagen" aria-label="Ajustar imagen">
            <Maximize2 size={15} />
          </button>
        </div>
      )}

      {design && (
        <div className="viewer-file-overlay">
          <div className="overlay-file-main" title={previewFile?.path ?? design.directory}>
            <FileText size={18} />
            <span>{previewFile?.fileName ?? design.name}</span>
          </div>

          {applicationAssets.length > 0 && (
            <div className="viewer-app-badges" aria-label="Aplicaciones de los archivos editables">
              {applicationAssets.map((asset) => (
                <span
                  key={asset.kind}
                  className={`viewer-app-badge ${asset.kind}`}
                  title={`${asset.label}: ${asset.count.toLocaleString("es-AR")} archivo${asset.count === 1 ? "" : "s"}`}
                >
                  <AssetIcon kind={asset.kind} />
                  <small>{asset.count.toLocaleString("es-AR")}</small>
                </span>
              ))}
            </div>
          )}

          {assetItems.length > 0 && (
            <div className="overlay-assets" aria-label="Archivos de esta estampa">
              {assetItems.map((item) => (
                <AssetPill key={item.id} kind={item.kind} label={item.label} value={item.value} tone={item.tone} />
              ))}
            </div>
          )}

          <div className="overlay-folder" title={design.directory}>
            <span>{design.name}</span>
          </div>

          <button className="overlay-action primary icon-action" onClick={() => onOpenFolder(design)} title="Abrir carpeta" aria-label="Abrir carpeta">
            <FolderOpen size={16} />
          </button>
        </div>
      )}

      <button className="nav-arrow right" onClick={onNext} disabled={!design} title="Siguiente">
        <ChevronRight size={28} />
      </button>

    </section>
  );
}

type AssetKind = "image" | "ai" | "psd" | "eps" | "pdf" | "txt";

function editableApplicationAssets(design: Design) {
  return [
    {
      kind: "ai" as const,
      label: "Illustrator",
      count: countForExtension(design, ".ai") + countForExtension(design, ".eps"),
    },
    { kind: "psd" as const, label: "Photoshop", count: countForExtension(design, ".psd") },
  ].filter((asset) => asset.count > 0);
}

function AssetIcon({ kind }: { kind: AssetKind }) {
  if (kind === "ai") return <img className="brand-file-logo" src={illustratorIcon} alt="" />;
  if (kind === "psd") return <img className="brand-file-logo" src={photoshopIcon} alt="" />;
  if (kind === "eps") return <span className="brand-file-icon brand-eps">EPS</span>;
  return kind === "image" ? <FileImage size={15} /> : <FileText size={15} />;
}

function AssetPill({ kind, label, value, tone }: { kind: AssetKind; label: string; value: number; tone: "red" | "gold" | "blue" | "neutral" }) {
  return (
    <span className={`asset-pill ${tone}`} title={`${label}: ${value.toLocaleString("es-AR")}`}>
      <AssetIcon kind={kind} />
      <small>{value.toLocaleString("es-AR")}</small>
    </span>
  );
}

function RightRail({
  designs,
  totalCount,
  pageStart,
  pageEnd,
  pageIndex,
  totalPages,
  isChangingPage,
  selectedId,
  categories,
  filters,
  setFilters,
  thumbMode,
  setThumbMode,
  onSelect,
  onFavorite,
  onCategory,
  onPageChange,
  dragState,
  onStartDesignDrag,
  shouldSuppressDragClick,
}: {
  designs: Design[];
  totalCount: number;
  pageStart: number;
  pageEnd: number;
  pageIndex: number;
  totalPages: number;
  isChangingPage: boolean;
  selectedId: string | null;
  categories: string[];
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  thumbMode: "compact" | "grid" | "list";
  setThumbMode: (mode: "compact" | "grid" | "list") => void;
  onSelect: (id: string) => void;
  onFavorite: (design: Design, favorite: boolean) => void;
  onCategory: (design: Design, category: string | null) => void;
  onPageChange: (pageIndex: number) => void;
  dragState: PointerDragState | null;
  onStartDesignDrag: (designId: string, event: React.PointerEvent<HTMLElement>) => void;
  shouldSuppressDragClick: () => boolean;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const previousSelectedId = useRef<string | null>(null);
  const [categoryMenuId, setCategoryMenuId] = useState<string | null>(null);
  const selectedIndex = designs.findIndex((design) => design.id === selectedId);
  const rowHeight = thumbMode === "grid" ? 112 : thumbMode === "list" ? 76 : 88;
  const canGoPrevious = pageIndex > 0;
  const canGoNext = pageIndex < totalPages - 1;
  const virtualizer = useVirtualizer({
    count: designs.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => designs[index]?.id ?? index,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  useEffect(() => {
    if (selectedId && previousSelectedId.current !== selectedId && selectedIndex >= 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: "center" });
    }
    previousSelectedId.current = selectedId;
  }, [selectedId, selectedIndex, virtualizer]);

  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [pageStart, thumbMode]);

  return (
    <aside className="right-rail">
      <div className="right-tools">
        <label className="dark-search">
          <Search size={17} />
          <input
            value={filters.query}
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            placeholder="Buscar disenos..."
          />
        </label>
        <button className={thumbMode === "compact" ? "mini-toggle active" : "mini-toggle"} onClick={() => setThumbMode("compact")} title="Compacto">
          <Grid2X2 size={16} />
        </button>
        <button className={thumbMode === "grid" ? "mini-toggle active" : "mini-toggle"} onClick={() => setThumbMode("grid")} title="Grilla">
          <LayoutGrid size={16} />
        </button>
        <button className={thumbMode === "list" ? "mini-toggle active" : "mini-toggle"} onClick={() => setThumbMode("list")} title="Lista">
          <List size={16} />
        </button>
      </div>

      <div ref={parentRef} className={`thumb-list ${thumbMode}`}>
        {designs.length === 0 ? (
          <div className="rail-empty">
            <ImageOff size={28} />
            <span>Sin resultados</span>
          </div>
        ) : (
          <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const design = designs[virtualItem.index];
              return (
                <div
                  key={design.id}
                  className={categoryMenuId === design.id ? "virtual-row menu-open" : "virtual-row"}
                  style={{
                    height: virtualItem.size,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <ThumbCard
                    design={design}
                    selected={design.id === selectedId}
                    density={thumbMode}
                    categories={categories}
                    categoryMenuOpen={categoryMenuId === design.id}
                    onSelect={onSelect}
                    onFavorite={onFavorite}
                    dragging={dragState?.kind === "design" && dragState.id === design.id}
                    onStartDesignDrag={onStartDesignDrag}
                    shouldSuppressDragClick={shouldSuppressDragClick}
                    onToggleCategoryMenu={(id) => setCategoryMenuId((current) => (current === id ? null : id))}
                    onCategory={(targetDesign, category) => {
                      onCategory(targetDesign, category);
                      setCategoryMenuId(null);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="load-more-panel">
        <strong>
          {totalCount === 0
            ? "Mostrando 0 de 0"
            : `Mostrando ${(pageStart + 1).toLocaleString("es-AR")}-${pageEnd.toLocaleString("es-AR")} de ${totalCount.toLocaleString("es-AR")}`}
        </strong>
        <small>
          Pagina {(pageIndex + 1).toLocaleString("es-AR")} de {totalPages.toLocaleString("es-AR")}
        </small>
        <div className="page-buttons">
          <button onClick={() => onPageChange(pageIndex - 1)} disabled={!canGoPrevious || isChangingPage}>
            <ChevronLeft size={16} />
            Anteriores 50
          </button>
          <button onClick={() => onPageChange(pageIndex + 1)} disabled={!canGoNext || isChangingPage}>
            {isChangingPage ? (
              <>
                <Loader2 size={16} className="spin" />
                Cargando...
              </>
            ) : (
              <>
                Siguientes 50
                <ChevronRight size={16} />
              </>
            )}
          </button>
        </div>
        {!canGoNext && <span>No hay mas paginas para cargar</span>}
      </div>
    </aside>
  );
}

const ThumbCard = memo(function ThumbCard({
  design,
  selected,
  density,
  categories,
  categoryMenuOpen,
  onSelect,
  onFavorite,
  dragging,
  onStartDesignDrag,
  shouldSuppressDragClick,
  onToggleCategoryMenu,
  onCategory,
}: {
  design: Design;
  selected: boolean;
  density: "compact" | "grid" | "list";
  categories: string[];
  categoryMenuOpen: boolean;
  onSelect: (id: string) => void;
  onFavorite: (design: Design, favorite: boolean) => void;
  dragging: boolean;
  onStartDesignDrag: (designId: string, event: React.PointerEvent<HTMLElement>) => void;
  shouldSuppressDragClick: () => boolean;
  onToggleCategoryMenu: (id: string) => void;
  onCategory: (design: Design, category: string | null) => void;
}) {
  const sourcePaths = useMemo(
    () =>
      [design.thumbnailPath, design.previewCachePath, design.previewPath].filter(
        (path, index, paths): path is string => Boolean(path) && paths.indexOf(path) === index,
      ),
    [design.previewCachePath, design.previewPath, design.thumbnailPath],
  );
  const [sourceIndex, setSourceIndex] = useState(0);
  const sourcePath = sourcePaths[sourceIndex] ?? null;
  const source = sourcePath ? convertFileSrc(sourcePath) : null;
  const previewFile = design.files.find((file) => file.path === design.previewPath);
  const currentCategory = design.classification.category;
  const editableAssets = editableApplicationAssets(design);

  useEffect(() => {
    setSourceIndex(0);
  }, [design.id, design.previewCachePath, design.previewPath, design.thumbnailPath]);

  const createCategory = () => {
    const category = window.prompt("Nueva categoria para esta estampa");
    if (category?.trim()) {
      onCategory(design, category);
    }
  };

  return (
    <article
      className={[
        "thumb-card",
        density,
        selected ? "selected" : "",
        dragging ? "dragging" : "",
      ].filter(Boolean).join(" ")}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button, .category-menu")) {
          return;
        }
        onStartDesignDrag(design.id, event);
      }}
      onClick={(event) => {
        if (shouldSuppressDragClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onSelect(design.id);
      }}
    >
      <button
        draggable={false}
        className={design.classification.favorite ? "heart-button active" : "heart-button"}
        onClick={(event) => {
          event.stopPropagation();
          onFavorite(design, !design.classification.favorite);
        }}
        title="Favorita"
      >
        <Heart size={17} fill={design.classification.favorite ? "currentColor" : "none"} />
      </button>
      <button
        draggable={false}
        className={currentCategory ? "category-button active" : "category-button"}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCategoryMenu(design.id);
        }}
        title={currentCategory ? `Categoria: ${currentCategory}` : "Clasificar"}
        aria-label="Clasificar estampa"
      >
        <Tags size={16} />
      </button>
      {categoryMenuOpen && (
        <div className="category-menu" onClick={(event) => event.stopPropagation()}>
          <button className={!currentCategory ? "selected" : ""} onClick={() => onCategory(design, null)}>
            Sin categoria
          </button>
          {categories.map((category) => (
            <button
              key={category}
              className={currentCategory === category ? "selected" : ""}
              onClick={() => onCategory(design, category)}
            >
              {category}
            </button>
          ))}
          <button className="create" onClick={createCategory}>
            <Plus size={14} />
            Nueva categoria
          </button>
        </div>
      )}
      <div className="thumb-image">
        {source ? (
          <img
            src={source}
            alt={design.name}
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={() => setSourceIndex((current) => current + 1)}
          />
        ) : (
          <div className="thumb-fallback">IMG</div>
        )}
        {editableAssets.length > 0 && (
          <div className="thumb-app-badges" aria-label="Archivos editables">
            {editableAssets.map((asset) => (
              <span key={asset.kind} className="thumb-app-badge" title={`${asset.label}: ${asset.count}`}>
                <AssetIcon kind={asset.kind} />
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="thumb-meta">
        <span>{previewFile?.fileName ?? design.name}</span>
        <small>
          {currentCategory ? `${currentCategory} - ` : ""}
          {previewFile ? formatBytes(previewFile.size) : `${design.totalFiles} arch.`}
        </small>
      </div>
    </article>
  );
});

function BottomTray({
  design,
  categories,
  onOpenFolder,
  onFavorite,
  onStatus,
  onCategory,
  onAddTag,
  onRemoveTag,
  showIconLabels,
}: {
  design: Design | null;
  categories: string[];
  onOpenFolder: (design: Design) => void;
  onFavorite: (design: Design, favorite: boolean) => void;
  onStatus: (design: Design, status: DesignStatus) => void;
  onCategory: (design: Design, category: string | null) => void;
  onAddTag: (design: Design, tag: string) => void;
  onRemoveTag: (design: Design, tag: string) => void;
  showIconLabels: boolean;
}) {
  const [categoryDraft, setCategoryDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");

  useEffect(() => {
    setCategoryDraft(design?.classification.category ?? "");
    setTagDraft("");
  }, [design?.id, design?.classification.category]);

  if (!design) return null;
  const previewFile = design.files.find((file) => file.path === design.previewPath) ?? design.files[0];
  const imageCount =
    countForExtension(design, ".jpg") +
    countForExtension(design, ".jpeg") +
    countForExtension(design, ".png") +
    countForExtension(design, ".webp");
  const statusLabel = statusOptions.find((status) => status.value === design.classification.status)?.label ?? "Estado";
  const metricItems = [
    { id: "img", kind: "image" as const, label: "Imagen", value: imageCount, tone: "red" as const },
    { id: "ai", kind: "ai" as const, label: "Illustrator", value: countForExtension(design, ".ai"), tone: "gold" as const },
    { id: "psd", kind: "psd" as const, label: "Photoshop", value: countForExtension(design, ".psd"), tone: "blue" as const },
    { id: "eps", kind: "eps" as const, label: "EPS", value: countForExtension(design, ".eps"), tone: "gold" as const },
    { id: "pdf", kind: "pdf" as const, label: "PDF", value: countForExtension(design, ".pdf"), tone: "neutral" as const },
    { id: "txt", kind: "txt" as const, label: "Texto", value: countForExtension(design, ".txt"), tone: "neutral" as const },
  ].filter((item) => item.value > 0);

  return (
    <footer className={showIconLabels ? "bottom-tray labels-on" : "bottom-tray"}>
      <div className="tray-grip" />
      <section className="tray-main">
        <div className="file-chip" title={previewFile?.path ?? design.directory}>
          <FileText size={20} />
          <strong>{previewFile?.fileName ?? design.name}</strong>
          <button onClick={() => onFavorite(design, !design.classification.favorite)} title="Favorita">
            <Heart size={18} fill={design.classification.favorite ? "currentColor" : "none"} />
            {showIconLabels && <span>Favorita</span>}
          </button>
        </div>

        {metricItems.length > 0 && (
          <div className="extension-metrics" title="Archivos de esta estampa">
            {metricItems.map((item) => (
              <IconMetric key={item.id} kind={item.kind} label={item.label} value={item.value} tone={item.tone} />
            ))}
          </div>
        )}

        <div className="status-icon-select" title={statusLabel}>
          <Clock3 size={18} />
          <select value={design.classification.status} onChange={(event) => onStatus(design, event.target.value as DesignStatus)}>
            {statusOptions.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
          {showIconLabels && <span>{statusLabel}</span>}
        </div>

        <div className="folder-crumb" title={design.directory}>
          <FolderOpen size={17} />
          {showIconLabels && <span>{design.name}</span>}
        </div>

        <button className="tray-action" onClick={() => onOpenFolder(design)} title="Abrir carpeta">
          <FolderOpen size={17} />
          {showIconLabels && <span>Abrir carpeta</span>}
        </button>
      </section>

      <section className="tray-edit">
        <div className="category-editor">
          <input
            list="category-options"
            value={categoryDraft}
            onChange={(event) => setCategoryDraft(event.target.value)}
            onBlur={() => onCategory(design, categoryDraft)}
            placeholder="Categoria"
          />
          <datalist id="category-options">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
          <button onClick={() => onCategory(design, categoryDraft)}>Guardar</button>
        </div>

        <div className="tray-tags">
          {design.classification.tags.slice(0, 8).map((tag) => (
            <button key={tag} onClick={() => onRemoveTag(design, tag)}>
              {tag}
              <X size={12} />
            </button>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onAddTag(design, tagDraft);
              setTagDraft("");
            }}
          >
            <Tags size={15} />
            <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Etiqueta" />
          </form>
        </div>
      </section>
    </footer>
  );
}

function IconMetric({
  kind,
  label,
  value,
  tone,
}: {
  kind: AssetKind;
  label: string;
  value: number;
  tone: "red" | "gold" | "blue" | "neutral";
}) {
  return (
    <span className={`metric metric-${tone}`} title={`${label}: ${value.toLocaleString("es-AR")}`}>
      <b>
        <AssetIcon kind={kind} />
      </b>
      {value.toLocaleString("es-AR")}
    </span>
  );
}

function sameCategory(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
