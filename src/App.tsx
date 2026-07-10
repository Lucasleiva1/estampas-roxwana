import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Crown,
  FileImage,
  FileText,
  FolderOpen,
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
  deleteCategory as deleteLibraryCategory,
  generatePreview,
  generateThumbnail,
  getDesignDetail,
  getInitialState,
  openDesignFolder,
  openBackupFolder,
  removeTag,
  renameCategory as renameLibraryCategory,
  reorderCategories as reorderLibraryCategories,
  restoreDatabaseBackup,
  scanLibrary,
  saveDatabaseBackup,
  updateCategory,
  updateFavorite,
  updateStatus,
} from "./lib/api";
import { UNCATEGORIZED_CATEGORY, chooseRandomDesign, countForExtension, createDefaultFilters, filterDesigns } from "./lib/filtering";
import { reorderCategoryList, type CategoryDropPosition } from "./lib/categories";
import { formatBytes } from "./lib/fileTypes";
import type { Design, DesignStatus, Filters, LibraryResponse } from "./lib/types";
import illustratorIcon from "./assets/illustrator.png";
import photoshopIcon from "./assets/photoshop.png";

const DEFAULT_LIBRARY_PATH = "C:\\Users\\jaell\\Documents\\estampas-roxwana";
const PAGE_SIZE = 50;
const supportFilters = [".png", ".jpg", ".ai", ".psd", ".eps", ".txt"];
const defaultZoom = 100;
const UI_SCALE_STORAGE_KEY = "roxwana-ui-scale";
const UI_SCALE_MIN = 70;
const UI_SCALE_MAX = 125;
const UI_SCALE_STEP = 5;
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
    if (Number.isFinite(stored)) return clampNumber(stored, LEFT_PANEL_WIDTH_MIN, getMaxLeftPanelWidth());
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

type RandomProgress = {
  seen: number;
  total: number;
};

type RandomHistory = {
  rootPath: string;
  usedIds: string[];
};

type PointerDragState = {
  kind: "category" | "design";
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  targetCategory: string | null;
  targetPosition: CategoryDropPosition;
};

function categoryTargetAt(x: number, y: number) {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-category-drop]");
  const category = row?.dataset.categoryDrop ?? null;
  if (!row || !category) return { category: null, position: "after" as CategoryDropPosition };
  const bounds = row.getBoundingClientRect();
  return {
    category,
    position: (y < bounds.top + bounds.height / 2 ? "before" : "after") as CategoryDropPosition,
  };
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
  const [backupState, setBackupState] = useState<BackupState>(initialBackupState);
  const [randomProgress, setRandomProgress] = useState<RandomProgress>({ seen: 0, total: 0 });
  const [pointerDrag, setPointerDrag] = useState<PointerDragState | null>(null);
  const attemptedPreviews = useRef<Set<string>>(new Set());
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const leftPanelResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const suppressClickUntil = useRef(0);
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
      setLeftPanelWidth((current) => clampNumber(current, LEFT_PANEL_WIDTH_MIN, getMaxLeftPanelWidth()));
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
      setLeftPanelWidth(clampNumber(nextWidth, LEFT_PANEL_WIDTH_MIN, getMaxLeftPanelWidth()));
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
    if (!selectedDesign?.previewPath || selectedDesign.previewCachePath) return;
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
  }, [selectedDesign?.id, selectedDesign?.previewCachePath, selectedDesign?.previewPath, selectedDesign?.updatedAt, updateDesignLocal]);

  const chooseFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: library?.rootPath ?? DEFAULT_LIBRARY_PATH,
      title: "Elegir carpeta de estampas",
    });
    if (typeof selected === "string") await runScan(selected);
  };

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
      return { ...current, categories: [...current.categories, normalized].sort((a, b) => a.localeCompare(b)) };
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
        return { ...current, categories: [...current.categories, savedCategory] };
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
        return { ...current, categories: [...current.categories, category] };
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

  const saveCategoryOrder = useCallback(async (nextOrder: string[]) => {
    const previousOrder = library?.categories ?? [];
    if (
      nextOrder.length !== previousOrder.length
      || nextOrder.every((category, index) => sameCategory(category, previousOrder[index]))
    ) return;
    setLibrary((current) => (current ? { ...current, categories: nextOrder } : current));

    try {
      const savedOrder = await reorderLibraryCategories(nextOrder);
      setLibrary((current) => (current ? { ...current, categories: savedOrder } : current));
    } catch (categoryError) {
      setLibrary((current) => (current ? { ...current, categories: previousOrder } : current));
      setError(String(categoryError));
    }
  }, [library?.categories]);

  const assignCategoryFromDrop = useCallback((designId: string, category: string) => {
    const design = library?.designs.find((item) => item.id === designId);
    if (design) void saveCategory(design, sameCategory(category, UNCATEGORIZED_CATEGORY) ? null : category);
  }, [library?.designs, saveCategory]);

  const startPointerDrag = useCallback(
    (kind: PointerDragState["kind"], id: string, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const next: PointerDragState = {
        kind,
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        targetCategory: null,
        targetPosition: "after",
      };
      pointerDragRef.current = next;
      setPointerDrag(next);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Window-level listeners continue tracking if capture is unavailable.
      }
    },
    [],
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
      const target = categoryTargetAt(x, y);
      const targetCategory = current.kind === "category" && target.category && sameCategory(current.id, target.category)
        ? null
        : target.category;
      const next = {
        ...current,
        x,
        y,
        active: true,
        targetCategory,
        targetPosition: target.position,
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
      document.body.classList.add("pointer-dragging");
      updateAt(current, event.clientX, event.clientY);
    };

    const finishPointerDrag = (event: PointerEvent) => {
      const current = pointerDragRef.current;
      if (!current || event.pointerId !== trackedPointerId) return;
      const finalState = current;
      if (finalState.active) {
        suppressClickUntil.current = Date.now() + 350;
        if (finalState.targetCategory) {
          if (finalState.kind === "category") {
            const nextOrder = reorderCategoryList(
              library?.categories ?? [],
              finalState.id,
              finalState.targetCategory,
              finalState.targetPosition,
            );
            void saveCategoryOrder(nextOrder);
          } else {
            assignCategoryFromDrop(finalState.id, finalState.targetCategory);
          }
        }
      }
      document.body.classList.remove("pointer-dragging");
      pointerDragRef.current = null;
      setPointerDrag(null);
    };

    const cancelPointerDrag = (event: PointerEvent) => {
      if (event.pointerId !== trackedPointerId) return;
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
  }, [assignCategoryFromDrop, library?.categories, pointerDrag?.pointerId, saveCategoryOrder]);

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
          const target = categoryTargetAt(current.x, current.y);
          const targetCategory = current.kind === "category" && target.category && sameCategory(current.id, target.category)
            ? null
            : target.category;
          if (targetCategory !== current.targetCategory || target.position !== current.targetPosition) {
            const next = { ...current, targetCategory, targetPosition: target.position };
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

    let completed = 0;
    let failed = 0;
    for (const design of queue) {
      try {
        const thumbnailPath = await generateThumbnail(design.previewPath!, design.updatedAt);
        if (thumbnailPath) {
          updateDesignLocal(design.id, (item) => ({ ...item, thumbnailPath }));
        }
      } catch {
        // Some source files can be invalid or too large; keep preparing the rest.
        failed += 1;
      }

      completed += 1;
      setThumbnailPrep({
        phase: "running",
        done: completed,
        total: queue.length,
        message: "Preparando miniaturas cacheadas...",
      });

      await new Promise((resolve) => window.setTimeout(resolve, 35));
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
      title: "Cargar copia de seguridad de ROXWANA",
      filters: [{ name: "Copia de seguridad ROXWANA", extensions: ["sqlite", "db"] }],
    });
    if (typeof selected !== "string") return;
    if (!window.confirm("Cargar esta copia reemplaza el guardado actual de ROXWANA. Antes de reemplazarlo, la app guarda una copia de seguridad del estado actual. Continuar?")) return;

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

  return (
    <main className="visual-shell">
      <Header
        library={library}
        setFilters={setFilters}
        selectedDesign={selectedDesign}
        loading={loading || scanning}
        onChooseFolder={chooseFolder}
        onRunScan={() => runScan()}
        onFavorite={setFavorite}
        onRandomDesign={chooseRandom}
        randomProgress={randomProgress}
        showIconLabels={showIconLabels}
        setShowIconLabels={setShowIconLabels}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        updateState={updateState}
        onCheckForUpdates={checkForUpdates}
        thumbnailPrep={thumbnailPrep}
        onPrepareThumbnails={prepareThumbnails}
        backupState={backupState}
        onSaveBackup={saveBackupCopy}
        onOpenBackupFolder={openBackupLocation}
        onRestoreBackup={restoreBackupCopy}
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
          categories={library?.categories ?? []}
          allDesigns={library?.designs ?? []}
          filteredCount={filteredDesigns.length}
          scanning={scanning}
          onCategoryFilter={(category) =>
            setFilters((current) => ({ ...createDefaultFilters(), query: current.query, categories: [category] }))
          }
          onClear={() => setFilters(createDefaultFilters())}
          onCreateCategory={createCategory}
          onRenameCategory={renameCategory}
          onDeleteCategory={removeCategory}
          dragState={pointerDrag?.active ? pointerDrag : null}
          onStartCategoryDrag={(category, event) => startPointerDrag("category", category, event)}
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
          {pointerDrag.kind === "category" ? <Tags size={15} /> : <FileImage size={15} />}
          <span>
            {pointerDrag.kind === "category"
              ? pointerDrag.id
              : library?.designs.find((design) => design.id === pointerDrag.id)?.name ?? "Estampa"}
          </span>
        </div>
      )}

    </main>
  );
}

function Header({
  library,
  setFilters,
  selectedDesign,
  loading,
  onChooseFolder,
  onRunScan,
  onFavorite,
  onRandomDesign,
  randomProgress,
  showIconLabels,
  setShowIconLabels,
  settingsOpen,
  setSettingsOpen,
  updateState,
  onCheckForUpdates,
  thumbnailPrep,
  onPrepareThumbnails,
  backupState,
  onSaveBackup,
  onOpenBackupFolder,
  onRestoreBackup,
  uiScale,
  setUiScale,
}: {
  library: LibraryResponse | null;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  selectedDesign: Design | null;
  loading: boolean;
  onChooseFolder: () => void;
  onRunScan: () => void;
  onFavorite: (design: Design, favorite: boolean) => void;
  onRandomDesign: () => void;
  randomProgress: RandomProgress;
  showIconLabels: boolean;
  setShowIconLabels: (show: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  updateState: AppUpdateState;
  onCheckForUpdates: () => void;
  thumbnailPrep: ThumbnailPrepState;
  onPrepareThumbnails: () => void;
  backupState: BackupState;
  onSaveBackup: () => void;
  onOpenBackupFolder: () => void;
  onRestoreBackup: () => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
}) {
  const updateBusy = updateState.phase === "checking" || updateState.phase === "downloading" || updateState.phase === "installing";
  const thumbnailBusy = thumbnailPrep.phase === "running";
  const thumbnailProgress = thumbnailPrep.total > 0 ? Math.round((thumbnailPrep.done / thumbnailPrep.total) * 100) : null;
  const backupBusy = backupState.phase === "saving" || backupState.phase === "opening" || backupState.phase === "loading";
  const randomRemaining = Math.max(0, randomProgress.total - randomProgress.seen);

  return (
    <header className="visual-header">
      <section className="logo-area" title={library?.rootPath ?? DEFAULT_LIBRARY_PATH}>
        <div className="rx-logo">
          <Crown size={17} />
          <strong>RXW</strong>
          <span>Visual Library</span>
        </div>
      </section>

      <section className="window-actions">
        <button className="action-button" onClick={onChooseFolder} title="Cambiar biblioteca de estampas">
          <FolderOpen size={17} />
          <span>Elegir biblioteca</span>
        </button>
        <button className="icon-only danger" disabled={!selectedDesign} onClick={() => selectedDesign && onFavorite(selectedDesign, !selectedDesign.classification.favorite)} title="Favorita">
          <Heart size={18} fill={selectedDesign?.classification.favorite ? "currentColor" : "none"} />
        </button>
        <button className="icon-only" onClick={onRunScan} title="Reescanear">
          <RefreshCw size={18} className={loading ? "spin" : ""} />
        </button>
        <button className="icon-only" onClick={() => setFilters(createDefaultFilters())} title="Limpiar filtros">
          <MoreVertical size={18} />
        </button>
        <button
          className="action-button random-action"
          onClick={onRandomDesign}
          disabled={randomProgress.total === 0}
          title={`Elegir una estampa al azar sin repetir. Quedan ${randomRemaining.toLocaleString("es-AR")} de ${randomProgress.total.toLocaleString("es-AR")}.`}
        >
          <Shuffle size={17} />
          <span>Random</span>
          <b>{randomRemaining.toLocaleString("es-AR")}</b>
        </button>
        <div className="settings-menu">
          <button className={settingsOpen ? "icon-only active" : "icon-only"} title="Ajustes" onClick={() => setSettingsOpen(!settingsOpen)}>
            <Settings size={18} />
          </button>
          {settingsOpen && (
            <div className="settings-popover">
              <button className="settings-action" onClick={onRunScan} disabled={loading}>
                <RefreshCw size={16} className={loading ? "spin" : ""} />
                <span>Escanear biblioteca</span>
              </button>
              <button className="settings-action secondary" onClick={onPrepareThumbnails} disabled={thumbnailBusy || !library}>
                {thumbnailBusy ? <Loader2 size={16} className="spin" /> : <FileImage size={16} />}
                <span>{thumbnailBusy ? "Preparando..." : "Preparar miniaturas"}</span>
              </button>
              {thumbnailPrep.message && (
                <div className={`update-status ${thumbnailPrep.phase}`}>
                  <span>{thumbnailPrep.message}</span>
                  {thumbnailPrep.total > 0 && (
                    <>
                      <small>
                        {thumbnailPrep.done.toLocaleString("es-AR")} de {thumbnailPrep.total.toLocaleString("es-AR")}
                      </small>
                      <div className="update-progress" aria-label={`Progreso ${thumbnailProgress ?? 0}%`}>
                        <span style={{ width: `${thumbnailProgress ?? 0}%` }} />
                      </div>
                    </>
                  )}
                </div>
              )}
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
                  <div className={`update-status ${backupState.phase}`}>
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
                <div className={`update-status ${updateState.phase}`}>
                  <span>{updateState.message}</span>
                  {updateState.progress !== null && (
                    <div className="update-progress" aria-label={`Progreso ${updateState.progress}%`}>
                      <span style={{ width: `${updateState.progress}%` }} />
                    </div>
                  )}
                </div>
              )}
              <div className="settings-scale">
                <div className="settings-scale-label">
                  <span>Tamano de la interfaz</span>
                  <strong>{uiScale}%</strong>
                </div>
                <div className="settings-scale-controls">
                  <button
                    type="button"
                    onClick={() => setUiScale(Math.max(UI_SCALE_MIN, uiScale - UI_SCALE_STEP))}
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
                    value={uiScale}
                    onChange={(event) => setUiScale(Number(event.target.value))}
                    aria-label="Tamano de la interfaz"
                  />
                  <button
                    type="button"
                    onClick={() => setUiScale(Math.min(UI_SCALE_MAX, uiScale + UI_SCALE_STEP))}
                    disabled={uiScale >= UI_SCALE_MAX}
                    title="Agrandar interfaz"
                    aria-label="Agrandar interfaz"
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setUiScale(100)}
                    disabled={uiScale === 100}
                    title="Restablecer al 100%"
                    aria-label="Restablecer tamano"
                  >
                    <RotateCcw size={14} />
                  </button>
                </div>
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

function LeftFilters({
  filters,
  categories,
  allDesigns,
  filteredCount,
  scanning,
  onCategoryFilter,
  onClear,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
  dragState,
  onStartCategoryDrag,
  shouldSuppressDragClick,
}: {
  filters: Filters;
  categories: string[];
  allDesigns: Design[];
  filteredCount: number;
  scanning: boolean;
  onCategoryFilter: (category: string) => void;
  onClear: () => void;
  onCreateCategory: (name: string) => Promise<string | null>;
  onRenameCategory: (currentName: string, newName: string) => Promise<string | null>;
  onDeleteCategory: (category: string) => Promise<boolean>;
  dragState: PointerDragState | null;
  onStartCategoryDrag: (category: string, event: React.PointerEvent<HTMLElement>) => void;
  shouldSuppressDragClick: () => boolean;
}) {
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
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

  const submitNewCategory = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const created = await onCreateCategory(newCategoryName);
    if (created) {
      setNewCategoryName("");
      setAddingCategory(false);
    }
  };

  const commitRename = async (category: string) => {
    if (sameCategory(category, editingName.trim())) {
      setEditingCategory(null);
      setEditingName("");
      return;
    }
    const renamed = await onRenameCategory(category, editingName);
    if (renamed) {
      setEditingCategory(null);
      setEditingName("");
    }
  };

  const beginRename = (category: string) => {
    renameCancelled.current = false;
    setEditingCategory(category);
    setEditingName(category);
  };

  const deleteCurrentCategory = async (category: string) => {
    if (!window.confirm(`Eliminar la categoria "${category}"? Las estampas quedaran sin categoria.`)) return;
    const deleted = await onDeleteCategory(category);
    if (deleted && editingCategory === category) {
      setEditingCategory(null);
      setEditingName("");
    }
  };

  return (
    <aside className="left-panel">
      <div className="panel-head">
        <span>Categorias</span>
        <div className="panel-actions">
          <button className="panel-icon-button" onClick={() => setAddingCategory((current) => !current)} title="Nueva categoria" aria-label="Nueva categoria">
            <Plus size={15} />
          </button>
          <button className="panel-icon-button" onClick={onClear} title="Limpiar filtros" aria-label="Limpiar filtros">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="filter-stack">
        {addingCategory && (
          <form className="category-edit-form new-category" onSubmit={submitNewCategory}>
            <input autoFocus value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="Nueva categoria" />
            <button type="submit" title="Crear categoria" aria-label="Crear categoria">
              <Check size={15} />
            </button>
            <button type="button" title="Cancelar" aria-label="Cancelar" onClick={() => { setAddingCategory(false); setNewCategoryName(""); }}>
              <X size={15} />
            </button>
          </form>
        )}
        <button
          className={filters.categories.length === 0 ? "filter-row active" : "filter-row"}
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
            dragState?.kind === "design" && dragState.targetCategory && sameCategory(dragState.targetCategory, UNCATEGORIZED_CATEGORY)
              ? "design-drop-target"
              : "",
          ].filter(Boolean).join(" ")}
          data-category-drop={UNCATEGORIZED_CATEGORY}
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
        {categories.map((category) => {
          const categoryCount = categoryCounts.get(category) ?? 0;
          const rowClassName = [
            "category-row",
            dragState?.kind === "category" && sameCategory(dragState.id, category) ? "category-dragging" : "",
            dragState?.kind === "design" && dragState.targetCategory && sameCategory(dragState.targetCategory, category)
              ? "design-drop-target"
              : "",
            dragState?.kind === "category" && dragState.targetCategory && sameCategory(dragState.targetCategory, category)
              ? `category-drop-${dragState.targetPosition}`
              : "",
          ].filter(Boolean).join(" ");

          return (
          <div
            key={category}
            className={rowClassName}
            data-category-drop={category}
            title="Arrastrar para ordenar. Doble clic para renombrar."
          >
            {editingCategory === category ? (
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
                    if (!renameCancelled.current) void commitRename(category);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      renameCancelled.current = true;
                      setEditingCategory(null);
                      setEditingName("");
                    }
                  }}
                  aria-label={`Renombrar ${category}`}
                />
              </form>
            ) : (
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
                    beginRename(category);
                  }}
                >
                  <span className="filter-name">
                    <span className="category-count" aria-label={`${categoryCount.toLocaleString("es-AR")} estampas`}>
                      {categoryCount.toLocaleString("es-AR")}
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
                    onClick={() => void deleteCurrentCategory(category)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </>
            )}
          </div>
          );
        })}
      </div>

      <div className="left-status">
        <div className={scanning ? "pulse active" : "pulse"} />
        <span>{scanning ? "Escaneando biblioteca" : "Escaneo manual"}</span>
      </div>
      <div className="result-count">{filteredCount.toLocaleString("es-AR")} visibles</div>
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
  const previewPath = previewPaths[previewSourceIndex] ?? null;
  const preview = previewPath ? convertFileSrc(previewPath) : null;
  const previewFile = design?.files.find((file) => file.path === design.previewPath) ?? design?.files[0] ?? null;
  const imageCount = design ? countForExtension(design, ".jpg") + countForExtension(design, ".jpeg") + countForExtension(design, ".png") + countForExtension(design, ".webp") : 0;
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const artboardRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStart = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const assetItems = design
    ? [
        { id: "img", kind: "image" as const, label: "Imagen", value: imageCount, tone: "red" as const },
        { id: "ai", kind: "ai" as const, label: "Illustrator", value: countForExtension(design, ".ai"), tone: "gold" as const },
        { id: "psd", kind: "psd" as const, label: "Photoshop", value: countForExtension(design, ".psd"), tone: "blue" as const },
        { id: "eps", kind: "eps" as const, label: "EPS", value: countForExtension(design, ".eps"), tone: "gold" as const },
        { id: "pdf", kind: "pdf" as const, label: "PDF", value: countForExtension(design, ".pdf"), tone: "neutral" as const },
        { id: "txt", kind: "txt" as const, label: "Texto", value: countForExtension(design, ".txt"), tone: "neutral" as const },
      ].filter((item) => item.value > 0)
    : [];

  useEffect(() => {
    setPreviewSourceIndex(0);
  }, [design?.id, design?.previewCachePath, design?.previewPath]);

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
  const editableAssets = [
    { kind: "ai" as const, label: "Illustrator", count: countForExtension(design, ".ai") },
    { kind: "psd" as const, label: "Photoshop", count: countForExtension(design, ".psd") },
  ].filter((asset) => asset.count > 0);

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
