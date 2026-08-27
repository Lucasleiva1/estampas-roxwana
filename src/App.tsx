import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { watch } from "@tauri-apps/plugin-fs";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import {
  ArrowRight,
  Check,
  BriefcaseBusiness,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Crop,
  FileImage,
  FileText,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Heart,
  Image as ImageIcon,
  ImageOff,
  LayoutGrid,
  List,
  Loader2,
  Maximize2,
  Minus,
  Moon,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Shuffle,
  Sparkles,
  Sun,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  addTag,
  createCategory as createLibraryCategory,
  createCategoryGroup as createLibraryGroup,
  createReferenceCategory,
  detectReferenceChanges,
  detectLibraryChanges,
  deleteCategory as deleteLibraryCategory,
  deleteCategoryGroup as deleteLibraryGroup,
  generatePreview,
  generatePreviewsBulk,
  generateThumbnail,
  generateThumbnailsBulk,
  getBrandLogo,
  getDesignDetail,
  getInitialState,
  getReferences,
  listSystemFonts,
  openDesignFolder,
  openBackupFolder,
  removeBrandLogo,
  removeTag,
  reloadPreferencesIfUnusable,
  rescanReferencePaths,
  rescanPaths,
  revealDesignFile,
  renameCategory as renameLibraryCategory,
  renameCategoryGroup as renameLibraryGroup,
  saveSidebarLayout,
  setCategoryGroupCollapsed,
  restoreDatabaseBackup,
  scanLibrary,
  saveDatabaseBackup,
  saveBrandLogo,
  scanReferences,
  sendReferenceToWork,
  updateCategory,
  updateFavorite,
  updateReferenceFavorite,
  updateReferenceStatus,
  updateStatus,
  type BrandLogo,
} from "./lib/api";
import {
  UNCATEGORIZED_CATEGORY,
  chooseRandomDesign,
  countForExtension,
  countForExtensionAcrossDesigns,
  countPreviewFilesAcrossDesigns,
  createDefaultFilters,
  designsInSameDirectory,
  filterDesigns,
} from "./lib/filtering";
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
import { buildMasonryLayout, type MasonryTile } from "./lib/masonry";
import { dailySeed, defaultSortFor, referenceRandomRank } from "./lib/ordering";
import type { Design, DesignStatus, Filters, LibraryResponse, ReferenceItem, ReferenceStatus, ReferencesResponse } from "./lib/types";
import illustratorIcon from "./assets/illustrator.png";
import photoshopIcon from "./assets/photoshop.png";

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
const REFERENCES_SIDEBAR_STORAGE_KEY = "roxwana-references-sidebar-open";
const REFERENCE_VIEWER_STORAGE_KEY = "roxwana-reference-viewer";
const THEME_STORAGE_KEY = "roxwana-theme";
const BRAND_PRESENTATION_STORAGE_KEY = "roxwana-brand-presentation";
const WELCOME_DISMISSED_STORAGE_KEY = "roxwana-welcome-dismissed";
const SYSTEM_FONT_FALLBACKS = [
  "Arial",
  "Arial Black",
  "Bahnschrift",
  "Calibri",
  "Cambria",
  "Candara",
  "Century Gothic",
  "Comic Sans MS",
  "Consolas",
  "Courier New",
  "Georgia",
  "Impact",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];
/// Colores listos para tocar de una, sin abrir el selector de Windows.
const BRAND_COLOR_SWATCHES = [
  "#f5eee2",
  "#ffffff",
  "#d29332",
  "#e5b769",
  "#c0392b",
  "#821c1f",
  "#e2725b",
  "#7d9a6d",
  "#3f7f8c",
  "#5b4b8a",
  "#c46a9b",
  "#1a1a1a",
];
/// El encabezado y el hueco del logo miden siempre lo mismo: el porcentaje
/// agranda o achica unicamente la imagen. El tope es el mayor tamano que entra
/// dentro de la barra sin tocarle los bordes (ver los `max-height` / `max-width`
/// de `.brand-logo` en styles.css).
const BRAND_LOGO_SCALE_MIN = 75;
const BRAND_LOGO_SCALE_MAX = 150;

type AppTheme = "dark" | "light";

type BrandPresentation = {
  logoScale: number;
  logoOffsetX: number;
  logoOffsetY: number;
  name: string;
  nameFont: string;
  nameColor: string;
  nameSize: number;
};

const DEFAULT_BRAND_PRESENTATION: BrandPresentation = {
  logoScale: 100,
  logoOffsetX: 0,
  logoOffsetY: 0,
  name: "",
  nameFont: "Impact",
  nameColor: "#f5eee2",
  nameSize: 30,
};

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

function getInitialReferenceViewer(): ReferenceViewerMode {
  try {
    return window.localStorage.getItem(REFERENCE_VIEWER_STORAGE_KEY) === "window" ? "window" : "full";
  } catch {
    // Keep the full screen viewer when local storage is unavailable.
  }
  return "full";
}

function getInitialTheme(): AppTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    // Keep the original dark appearance when local storage is unavailable.
  }
  return "dark";
}

function getInitialBrandPresentation(): BrandPresentation {
  try {
    const stored = JSON.parse(window.localStorage.getItem(BRAND_PRESENTATION_STORAGE_KEY) ?? "null") as Partial<BrandPresentation> | null;
    if (!stored) return DEFAULT_BRAND_PRESENTATION;
    return {
      logoScale: Math.round(clampNumber(Number(stored.logoScale) || 100, BRAND_LOGO_SCALE_MIN, BRAND_LOGO_SCALE_MAX)),
      logoOffsetX: Math.round(clampNumber(Number(stored.logoOffsetX) || 0, -24, 24)),
      logoOffsetY: Math.round(clampNumber(Number(stored.logoOffsetY) || 0, -18, 18)),
      name: typeof stored.name === "string" ? stored.name.slice(0, 40) : "",
      nameFont: typeof stored.nameFont === "string" && stored.nameFont.trim() ? stored.nameFont.trim().slice(0, 80) : "Impact",
      nameColor: typeof stored.nameColor === "string" && /^#[0-9a-f]{6}$/i.test(stored.nameColor) ? stored.nameColor : "#f5eee2",
      nameSize: Math.round(clampNumber(Number(stored.nameSize) || 30, 14, 44)),
    };
  } catch {
    return DEFAULT_BRAND_PRESENTATION;
  }
}

/// El tamano viaja como variable CSS al encabezado, pero alla adentro solo
/// afecta al tamano maximo de la imagen: el hueco, la columna y el alto del
/// encabezado quedan fijos. Se escala el limite de la imagen y no un
/// `transform`, asi el logo se vuelve a dibujar nitido en vez de agrandarse
/// borroso.
function brandHeaderStyle(presentation: BrandPresentation): CSSProperties {
  return { "--brand-logo-scale": presentation.logoScale / 100 } as CSSProperties;
}

function brandLogoStyle(presentation: BrandPresentation): CSSProperties {
  return {
    transform: `translate(${presentation.logoOffsetX}px, ${presentation.logoOffsetY}px)`,
  };
}

function brandNameStyle(presentation: BrandPresentation): CSSProperties {
  const safeFont = presentation.nameFont.replace(/["\\]/g, "");
  return {
    color: presentation.nameColor,
    fontFamily: `"${safeFont}", sans-serif`,
    fontSize: `${presentation.nameSize}px`,
  };
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

type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "installing" | "none" | "done" | "error";

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

function getInitialWelcomeDismissed() {
  try {
    return window.localStorage.getItem(WELCOME_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const [appMode, setAppMode] = useState<"library" | "references">("library");
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [referencesData, setReferencesData] = useState<ReferencesResponse | null>(null);
  const [referencesLoading, setReferencesLoading] = useState(true);
  const [referencesScanning, setReferencesScanning] = useState(false);
  const [referencesError, setReferencesError] = useState<string | null>(null);
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
  const [referenceViewer, setReferenceViewer] = useState<ReferenceViewerMode>(getInitialReferenceViewer);
  const [theme, setTheme] = useState<AppTheme>(getInitialTheme);
  const [brandPresentation, setBrandPresentation] = useState<BrandPresentation>(getInitialBrandPresentation);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(getInitialWelcomeDismissed);
  const [detailsById, setDetailsById] = useState<Record<string, Design>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [isChangingPage, setIsChangingPage] = useState(false);
  const [updateState, setUpdateState] = useState<AppUpdateState>(initialUpdateState);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
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

  const changeTheme = useCallback((nextTheme: AppTheme) => {
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The selected theme still applies for the current session.
    }
    setTheme(nextTheme);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The selected theme still applies for the current session.
    }
  }, [theme]);

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
      window.localStorage.setItem(BRAND_PRESENTATION_STORAGE_KEY, JSON.stringify(brandPresentation));
    } catch {
      // El ajuste sigue aplicado durante la sesion aunque no se pueda persistir.
    }
  }, [brandPresentation]);

  useEffect(() => {
    try {
      window.localStorage.setItem(REFERENCE_VIEWER_STORAGE_KEY, referenceViewer);
    } catch {
      // The chosen viewer still applies for the current session.
    }
  }, [referenceViewer]);

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
    async (rootPath = library?.rootPath ?? "") => {
      if (!rootPath) return;
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

  const refreshReferences = useCallback(
    async (manual = false) => {
      const rootPath = library?.rootPath ?? "";
      if (!rootPath) return;
      if (manual) setReferencesScanning(true);
      setReferencesError(null);
      try {
        const response = manual ? await scanReferences(rootPath) : await getReferences(rootPath);
        setReferencesData(response);
      } finally {
        if (manual) setReferencesScanning(false);
      }
    },
    [library?.rootPath],
  );

  // Referencias abre siempre desde el indice guardado. Una comprobacion del
  // disco corre despues, sin bloquear ni vaciar la pantalla que ve el usuario.
  useEffect(() => {
    const rootPath = library?.rootPath;
    if (!rootPath) return;
    let disposed = false;
    let backgroundTimer = 0;
    setReferencesData((current) => (current?.rootPath === rootPath ? current : null));
    setReferencesLoading(true);
    setReferencesError(null);
    void getReferences(rootPath)
      .then((response) => {
        if (disposed) return;
        setReferencesData(response);
        backgroundTimer = window.setTimeout(() => {
          void detectReferenceChanges(rootPath)
            .then((updated) => {
              if (!disposed && updated) setReferencesData(updated);
            })
            .catch((checkError) => {
              if (!disposed) setReferencesError(`No pude comprobar los cambios recientes de Referencias: ${String(checkError)}`);
            });
        }, 700);
      })
      .catch((referencesLoadError) => {
        if (!disposed) setReferencesError(String(referencesLoadError));
      })
      .finally(() => {
        if (!disposed) setReferencesLoading(false);
      });

    return () => {
      disposed = true;
      window.clearTimeout(backgroundTimer);
    };
  }, [library?.rootPath]);

  // Este vigilante pertenece a la aplicacion, no a la pantalla de Referencias:
  // sigue activo mientras el usuario navega por la Biblioteca y sincroniza solo
  // las rutas notificadas, agrupando las rafagas de copiado en una sola tarea.
  useEffect(() => {
    const rootPath = referencesData?.rootPath;
    const referencesPath = referencesData?.referencesPath;
    if (!rootPath || !referencesPath) return;
    let disposed = false;
    let stopWatching: (() => void) | null = null;
    let flushTimer = 0;
    let syncRunning = false;
    const pendingPaths = new Set<string>();

    const scheduleFlush = () => {
      window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => void flushChanges(), 900);
    };

    const flushChanges = async () => {
      if (disposed || syncRunning || pendingPaths.size === 0) return;
      const paths = Array.from(pendingPaths);
      pendingPaths.clear();
      syncRunning = true;
      setReferencesError(null);
      try {
        const response = await rescanReferencePaths(rootPath, paths);
        if (!disposed) setReferencesData(response);
      } catch (watchError) {
        if (!disposed) setReferencesError(`No pude actualizar Referencias: ${String(watchError)}`);
      } finally {
        syncRunning = false;
        if (!disposed && pendingPaths.size > 0) scheduleFlush();
      }
    };

    void watch(
      referencesPath,
      (event) => {
        if (typeof event.type === "object" && "access" in event.type) return;
        for (const path of event.paths) {
          const normalized = path.replace(/\\/g, "/").toLocaleLowerCase();
          if (normalized.split("/").includes("_roxwana-cache")) continue;
          pendingPaths.add(path);
        }
        if (pendingPaths.size > 0) scheduleFlush();
      },
      { recursive: true, delayMs: 600 },
    )
      .then((stop) => {
        if (disposed) stop();
        else stopWatching = stop;
      })
      .catch((watchError) => {
        if (!disposed) setReferencesError(`No pude vigilar Referencias: ${String(watchError)}`);
      });

    return () => {
      disposed = true;
      window.clearTimeout(flushTimer);
      stopWatching?.();
    };
  }, [referencesData?.referencesPath, referencesData?.rootPath]);

  // La biblioteca guardada queda disponible de inmediato. Después se compara
  // el disco en segundo plano y solo se reescanean las carpetas que cambiaron
  // mientras ROXWANA estuvo cerrada.
  const backgroundCheckRoot = useRef<string | null>(null);
  useEffect(() => {
    const rootPath = library?.rootPath;
    if (!rootPath || backgroundCheckRoot.current === rootPath) return;
    backgroundCheckRoot.current = rootPath;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void detectLibraryChanges(rootPath)
        .then((response) => {
          if (!disposed && response) {
            applyLibrary(response);
            setDetailsById({});
          }
        })
        .catch((checkError) => {
          if (!disposed) setError(`No pude comprobar los cambios recientes: ${String(checkError)}`);
        });
    }, 700);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [applyLibrary, library?.rootPath]);

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
    const preferencesPrefix = `${normalizedRoot}/preferences`;

    let disposed = false;
    let stopWatching: (() => void) | null = null;
    let flushTimer = 0;
    let rescanRunning = false;
    let preferencesReloadRunning = false;
    const pendingPaths = new Set<string>();

    const reloadUnusablePreferences = async () => {
      if (disposed || preferencesReloadRunning) return;
      preferencesReloadRunning = true;
      try {
        const response = await reloadPreferencesIfUnusable(rootPath);
        if (!disposed && response) {
          applyLibrary(response);
          setDetailsById({});
        }
      } catch (preferencesError) {
        if (!disposed) setError(`No pude reiniciar las preferencias: ${String(preferencesError)}`);
      } finally {
        preferencesReloadRunning = false;
      }
    };

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
        let preferencesChanged = false;
        for (const path of event.paths) {
          const normalized = path.replace(/\\/g, "/").toLocaleLowerCase();
          if (normalized.split("/").includes("_roxwana-cache")) continue;
          if (normalized === referencesPrefix || normalized.startsWith(`${referencesPrefix}/`)) continue;
          if (normalized === preferencesPrefix || normalized.startsWith(`${preferencesPrefix}/`)) {
            preferencesChanged = true;
            continue;
          }
          pendingPaths.add(path);
        }
        if (preferencesChanged) void reloadUnusablePreferences();
        if (pendingPaths.size > 0) scheduleFlush();
      },
      { recursive: true, delayMs: 750 },
    )
      .then((stop) => {
        if (disposed) stop();
        else stopWatching = stop;
      })
      .catch((watchError) => {
        if (!disposed) setError(`No pude vigilar la carpeta de imagenes: ${String(watchError)}`);
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
  const selectedDirectoryDesigns = useMemo(
    () => (selectedDesign ? designsInSameDirectory(library?.designs ?? [], selectedDesign) : []),
    [library?.designs, selectedDesign],
  );

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
      defaultPath: library?.rootPath || undefined,
      title: "Elegir carpeta de imagenes",
    });
    if (typeof selected !== "string") return;

    const currentPath = library?.rootPath ?? "";
    const normalizePath = (path: string) => path.replace(/[\\/]+$/, "").toLocaleLowerCase();
    if (
      currentPath
      && normalizePath(selected) !== normalizePath(currentPath)
      && !window.confirm(`Vas a cambiar la biblioteca.\n\nActual:\n${currentPath}\n\nNueva:\n${selected}\n\n¿Continuar?`)
    ) {
      return;
    }

    await runScan(selected);
  };

  const continueWithoutFolder = useCallback(() => {
    try {
      window.localStorage.setItem(WELCOME_DISMISSED_STORAGE_KEY, "1");
    } catch {
      // La decision sigue aplicada durante esta sesion.
    }
    setWelcomeDismissed(true);
  }, []);

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
      setError("No hay imagenes para elegir al azar.");
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
    // Arranca en la primera carga y cada vez que aparecen imagenes nuevas sin
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

    setAvailableUpdate(null);
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

      setAvailableUpdate(update);
      setUpdateState({
        phase: "available",
        message: `Nueva actualizacion encontrada: ROXWANA v${update.version}.`,
        progress: null,
      });
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
        message: `No se pudo buscar la actualizacion: ${message}`,
        progress: null,
      });
    }
  }, [updateState.phase]);

  const installAvailableUpdate = useCallback(async () => {
    if (!availableUpdate || ["checking", "downloading", "installing"].includes(updateState.phase)) return;

    try {
      let downloaded = 0;
      let contentLength = 0;
      setUpdateState({
        phase: "downloading",
        message: `Descargando ROXWANA v${availableUpdate.version}...`,
        progress: 0,
      });

      await availableUpdate.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
          setUpdateState({
            phase: "downloading",
            message: `Descargando ROXWANA v${availableUpdate.version}...`,
            progress: contentLength > 0 ? 0 : null,
          });
        }

        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateState({
            phase: "downloading",
            message: `Descargando ROXWANA v${availableUpdate.version}...`,
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

      setAvailableUpdate(null);
      setUpdateState({
        phase: "done",
        message: "Actualizacion instalada. Reiniciando...",
        progress: 100,
      });
      await relaunch();
    } catch (updateError) {
      setUpdateState({
        phase: "error",
        message: `No se pudo instalar la actualizacion: ${String(updateError)}`,
        progress: null,
      });
    }
  }, [availableUpdate, updateState.phase]);

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

  const openWorkInLibrary = useCallback(
    async (workName: string) => {
      await runScan();
      setFilters({ ...createDefaultFilters(), categories: [workName] });
      setAppMode("library");
    },
    [runScan],
  );

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
        message: `Copia cargada: ${response.categories.length.toLocaleString("es-AR")} categorias y ${response.designs.length.toLocaleString("es-AR")} imagenes.`,
        path: selected,
      });
    } catch (backupError) {
      setBackupState({ phase: "error", message: `No se pudo cargar: ${String(backupError)}`, path: selected });
    }
  }, [applyLibrary]);

  // Instalacion nueva: todavia no se eligio ninguna carpeta de imagenes. Sin
  // esto la aplicacion abriria vacia y sin decir que hacer.
  if (!loading && !library?.rootPath && !welcomeDismissed) {
    return (
      <WelcomeScreen
        onChooseFolder={chooseFolder}
        onContinueWithoutFolder={continueWithoutFolder}
        error={error}
        onDismissError={() => setError(null)}
      />
    );
  }

  if (settingsOpen) {
    return (
      <main className="settings-shell">
        <SettingsScreen
          library={library}
          brandLogo={brandLogo}
          brandPresentation={brandPresentation}
          onChangeBrandPresentation={setBrandPresentation}
          brandLogoState={brandLogoState}
          onChooseBrandLogo={chooseBrandLogo}
          onDropBrandLogo={saveBrandLogoPath}
          onRemoveBrandLogo={clearBrandLogo}
          loading={loading || scanning}
          onChooseFolder={chooseFolder}
          onRunScan={() => runScan()}
          updateState={updateState}
          availableUpdateVersion={availableUpdate?.version ?? null}
          onCheckForUpdates={checkForUpdates}
          onInstallUpdate={installAvailableUpdate}
          thumbnailPrep={thumbnailPrep}
          onPrepareThumbnails={prepareThumbnails}
          previewPrep={previewPrep}
          onPreparePreviews={preparePreviews}
          backupState={backupState}
          onSaveBackup={saveBackupCopy}
          onOpenBackupFolder={openBackupLocation}
          onRestoreBackup={restoreBackupCopy}
          referenceViewer={referenceViewer}
          onChangeReferenceViewer={setReferenceViewer}
          theme={theme}
          onChangeTheme={changeTheme}
          error={error}
          onDismissError={() => setError(null)}
          onBack={() => setSettingsOpen(false)}
        />
      </main>
    );
  }

  if (appMode === "references") {
    return (
      <ReferencesScreen
        rootPath={library?.rootPath ?? ""}
        brandLogo={brandLogo}
        brandPresentation={brandPresentation}
        data={referencesData}
        setData={setReferencesData}
        loading={referencesLoading}
        scanning={referencesScanning}
        syncError={referencesError}
        onDismissSyncError={() => setReferencesError(null)}
        onRefresh={refreshReferences}
        onBackToLibrary={() => setAppMode("library")}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenWork={openWorkInLibrary}
        viewerMode={referenceViewer}
      />
    );
  }

  return (
    <main className="visual-shell">
      <Header
        brandLogo={brandLogo}
        brandPresentation={brandPresentation}
        libraryPath={library?.rootPath ?? ""}
        setFilters={setFilters}
        loading={loading || scanning}
        onRunScan={() => runScan()}
        onRandomDesign={chooseRandom}
        randomProgress={randomProgress}
        showIconLabels={showIconLabels}
        setShowIconLabels={setShowIconLabels}
        setSettingsOpen={setSettingsOpen}
        onOpenReferences={() => setAppMode("references")}
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
          directoryDesigns={selectedDirectoryDesigns}
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
              ? library?.designs.find((design) => design.id === pointerDrag.id)?.name ?? "Imagen"
              : pointerDrag.id}
          </span>
        </div>
      )}

    </main>
  );
}

type ReferenceScope = "all" | "favorites" | "recent";
type ReferenceSort = "recent" | "name" | "random";
type ReferenceSize = "small" | "medium" | "large";
/** Como se abre una referencia: a pantalla completa o en una ventana centrada. */
type ReferenceViewerMode = "full" | "window";

const referenceStatusLabels: Record<ReferenceStatus, string> = {
  pending: "Pendiente",
  working: "En trabajo",
  done: "Realizada",
};

function initialReferencesSidebarOpen() {
  try {
    return window.localStorage.getItem(REFERENCES_SIDEBAR_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}


function ReferencesScreen({
  rootPath,
  brandLogo,
  brandPresentation,
  data,
  setData,
  loading,
  scanning,
  syncError,
  onDismissSyncError,
  onRefresh,
  onBackToLibrary,
  onOpenSettings,
  onOpenWork,
  viewerMode,
}: {
  rootPath: string;
  brandLogo: BrandLogo | null;
  brandPresentation: BrandPresentation;
  data: ReferencesResponse | null;
  setData: Dispatch<SetStateAction<ReferencesResponse | null>>;
  loading: boolean;
  scanning: boolean;
  syncError: string | null;
  onDismissSyncError: () => void;
  onRefresh: (manual?: boolean) => Promise<void>;
  onBackToLibrary: () => void;
  onOpenSettings: () => void;
  onOpenWork: (workName: string) => Promise<void>;
  viewerMode: ReferenceViewerMode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selectedCategory, setSelectedCategory] = useState("Todos");
  const [scope, setScope] = useState<ReferenceScope>("all");
  const [status, setStatusFilter] = useState<ReferenceStatus | "all">("all");
  const [sort, setSort] = useState<ReferenceSort>(() => defaultSortFor("Todos"));
  const [size, setSize] = useState<ReferenceSize>("medium");
  // Semilla del dia: la mezcla se queda quieta hasta la medianoche. El boton de
  // remezclar la reemplaza por la hora exacta para forzar un orden nuevo ya.
  const [randomSeed, setRandomSeed] = useState(dailySeed);
  const [sidebarOpen, setSidebarOpen] = useState(initialReferencesSidebarOpen);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [workReference, setWorkReference] = useState<ReferenceItem | null>(null);
  const [workName, setWorkName] = useState("");
  const [creatingWork, setCreatingWork] = useState(false);
  const thumbnailAttempts = useRef(new Set<string>());

  // Al cambiar de vista, el orden vuelve al natural de esa vista: mezclado en
  // "Todos", por fecha dentro de una carpeta. Despues se puede cambiar a mano
  // desde el desplegable y ese cambio manda hasta la proxima vez que cambies.
  const chooseCategory = useCallback((category: string) => {
    setSelectedCategory(category);
    setSort(defaultSortFor(category));
  }, []);

  const refresh = useCallback(
    async (manual = false) => {
      setError(null);
      try {
        await onRefresh(manual);
      } catch (refreshError) {
        setError(String(refreshError));
      }
    },
    [onRefresh],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(REFERENCES_SIDEBAR_STORAGE_KEY, String(sidebarOpen));
    } catch {
      // La preferencia sigue funcionando durante la sesion actual.
    }
  }, [sidebarOpen]);


  useEffect(() => {
    const candidates = (data?.references ?? [])
      .filter((reference) => !reference.thumbnailPath && !thumbnailAttempts.current.has(reference.path))
      .slice(0, 180);
    if (candidates.length === 0) return;
    candidates.forEach((reference) => thumbnailAttempts.current.add(reference.path));
    let cancelled = false;
    void generateThumbnailsBulk(candidates.map((reference) => [reference.path, reference.modified]))
      .then((generated) => {
        if (cancelled) return;
        const paths = new Map(generated.filter((item): item is [string, string] => Boolean(item[1])));
        if (paths.size === 0) return;
        setData((current) =>
          current
            ? {
                ...current,
                references: current.references.map((reference) => ({
                  ...reference,
                  thumbnailPath: paths.get(reference.path) ?? reference.thumbnailPath,
                })),
              }
            : current,
        );
      })
      .catch((thumbnailError) => {
        if (!cancelled) setError(`No pude preparar algunas miniaturas: ${String(thumbnailError)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [data?.references]);

  const visibleReferences = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    const recentLimit = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const filtered = (data?.references ?? []).filter((reference) => {
      if (selectedCategory !== "Todos" && reference.category !== selectedCategory) return false;
      if (scope === "favorites" && !reference.favorite) return false;
      if (scope === "recent" && reference.modified < recentLimit) return false;
      if (status !== "all" && reference.status !== status) return false;
      if (!normalizedQuery) return true;
      return [reference.name, reference.fileName, reference.category]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
    return [...filtered].sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name, "es", { sensitivity: "base" });
      if (sort === "random") return referenceRandomRank(left.id, randomSeed) - referenceRandomRank(right.id, randomSeed);
      return right.modified - left.modified || left.name.localeCompare(right.name, "es", { sensitivity: "base" });
    });
  }, [data?.references, deferredQuery, randomSeed, scope, selectedCategory, sort, status]);

  const selectedReference = data?.references.find((reference) => reference.id === selectedId) ?? null;
  const lightboxIndex = Math.max(0, visibleReferences.findIndex((reference) => reference.id === lightboxId));
  const lightboxReference = lightboxId ? visibleReferences[lightboxIndex] ?? null : null;

  useEffect(() => {
    if (!lightboxId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxId(null);
      if (event.key === "ArrowLeft" && visibleReferences.length > 0) {
        const next = (lightboxIndex - 1 + visibleReferences.length) % visibleReferences.length;
        setLightboxId(visibleReferences[next].id);
      }
      if (event.key === "ArrowRight" && visibleReferences.length > 0) {
        const next = (lightboxIndex + 1) % visibleReferences.length;
        setLightboxId(visibleReferences[next].id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxId, lightboxIndex, visibleReferences]);

  const replaceReference = useCallback((updated: ReferenceItem) => {
    setData((current) =>
      current
        ? { ...current, references: current.references.map((reference) => (reference.id === updated.id ? updated : reference)) }
        : current,
    );
  }, []);

  const toggleFavorite = useCallback(async (reference: ReferenceItem) => {
    const favorite = !reference.favorite;
    setData((current) =>
      current
        ? {
            ...current,
            references: current.references.map((item) => (item.id === reference.id ? { ...item, favorite } : item)),
          }
        : current,
    );
    try {
      await updateReferenceFavorite(reference.id, favorite);
    } catch (favoriteError) {
      setError(String(favoriteError));
      setData((current) =>
        current
          ? {
              ...current,
              references: current.references.map((item) => (item.id === reference.id ? { ...item, favorite: reference.favorite } : item)),
            }
          : current,
      );
    }
  }, []);

  const changeStatus = useCallback(async (reference: ReferenceItem, nextStatus: ReferenceStatus) => {
    setData((current) =>
      current
        ? {
            ...current,
            references: current.references.map((item) => (item.id === reference.id ? { ...item, status: nextStatus } : item)),
          }
        : current,
    );
    try {
      await updateReferenceStatus(reference.id, nextStatus);
    } catch (statusError) {
      setError(String(statusError));
      setData((current) =>
        current
          ? {
              ...current,
              references: current.references.map((item) => (item.id === reference.id ? { ...item, status: reference.status } : item)),
            }
          : current,
      );
    }
  }, []);

  const showWorkDialog = (reference: ReferenceItem) => {
    setWorkReference(reference);
    setWorkName(reference.name);
  };

  const createWork = async () => {
    if (!workReference || !workName.trim()) return;
    setCreatingWork(true);
    setError(null);
    try {
      const updated = await sendReferenceToWork(rootPath, workReference.id, workName.trim());
      replaceReference(updated);
      setWorkReference(null);
      setWorkName("");
    } catch (workError) {
      setError(String(workError));
    } finally {
      setCreatingWork(false);
    }
  };

  const openWork = async (reference: ReferenceItem) => {
    if (!reference.workPath) return;
    const pathParts = reference.workPath.split(/[\\/]/).filter(Boolean);
    const name = pathParts[pathParts.length - 1] ?? reference.name;
    await onOpenWork(name);
  };

  const addCategory = async () => {
    const name = window.prompt("Nombre de la nueva carpeta de referencias");
    if (!name?.trim()) return;
    try {
      const category = await createReferenceCategory(rootPath, name);
      await refresh(false);
      chooseCategory(category);
    } catch (categoryError) {
      setError(String(categoryError));
    }
  };

  const categoryCount = (category: string) =>
    (data?.references ?? []).filter((reference) => reference.category === category).length;

  // Los dos visores reciben lo mismo, asi que la preferencia solo elige cual se
  // monta. Las teclas Escape y las flechas ya viven mas arriba y sirven a ambos.
  const Viewer = viewerMode === "window" ? ReferenceWindow : ReferenceLightbox;

  return (
    <main className="references-shell">
      <header className="references-header">
        <section className="references-brand" style={brandHeaderStyle(brandPresentation)}>
          <div className="references-logo">
            {brandLogo ? <img src={brandLogo.dataUrl} alt="Logo de la marca" draggable={false} style={brandLogoStyle(brandPresentation)} /> : <Sparkles size={27} />}
          </div>
          <div>
            <strong>REFERENCIAS</strong>
            <span>Explorar ideas y empezar trabajos</span>
          </div>
        </section>
        <nav className="mode-switch single" aria-label="Volver a la biblioteca">
          <button type="button" onClick={onBackToLibrary}>Biblioteca</button>
        </nav>
        <label className="references-search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar referencias..." />
          {query && <button type="button" onClick={() => setQuery("")} title="Limpiar busqueda"><X size={15} /></button>}
        </label>
        <div className="references-header-actions">
          <button type="button" onClick={() => void refresh(true)} title="Rescanear referencias">
            <RefreshCw size={17} className={scanning ? "spin" : ""} />
          </button>
          <button type="button" onClick={onOpenSettings} title="Ajustes"><Settings size={17} /></button>
        </div>
      </header>

      <nav className="references-category-bar" aria-label="Categorias de referencias">
        <button
          type="button"
          className={selectedCategory === "Todos" ? "active" : ""}
          onClick={() => chooseCategory("Todos")}
        >
          Todos <b>{data?.references.length ?? 0}</b>
        </button>
        {(data?.categories ?? []).map((category) => (
          <button
            type="button"
            key={category}
            className={selectedCategory === category ? "active" : ""}
            onClick={() => chooseCategory(category)}
          >
            {category} <b>{categoryCount(category)}</b>
          </button>
        ))}
        <button type="button" className="add" onClick={() => void addCategory()} title="Crear carpeta de referencias"><Plus size={15} /></button>
      </nav>

      {(error || syncError) && (
        <div className="references-error" role="alert">
          <span>{error ?? syncError}</span>
          <button type="button" onClick={() => {
            setError(null);
            onDismissSyncError();
          }}><X size={15} /></button>
        </div>
      )}

      <section className={sidebarOpen ? "references-layout" : "references-layout sidebar-hidden"}>
        {sidebarOpen && (
          <aside className="references-sidebar">
            <div className="references-sidebar-title">
              <span>REFERENCIAS</span>
              <button type="button" onClick={() => setSidebarOpen(false)} title="Ocultar barra lateral"><PanelLeftClose size={17} /></button>
            </div>
            <button type="button" className={scope === "all" && selectedCategory === "Todos" ? "active" : ""} onClick={() => { setScope("all"); chooseCategory("Todos"); }}>
              <LayoutGrid size={16} /><span>Todas las referencias</span><b>{data?.references.length ?? 0}</b>
            </button>
            <button type="button" className={scope === "favorites" ? "active" : ""} onClick={() => { setScope("favorites"); chooseCategory("Todos"); }}>
              <Heart size={16} /><span>Favoritas</span><b>{data?.references.filter((item) => item.favorite).length ?? 0}</b>
            </button>
            <button type="button" className={scope === "recent" ? "active" : ""} onClick={() => { setScope("recent"); setSelectedCategory("Todos"); setSort("recent"); }}>
              <Clock3 size={16} /><span>Recientes</span>
            </button>
            <div className="references-sidebar-label">CARPETAS</div>
            {(data?.categories ?? []).map((category) => (
              <button type="button" key={category} className={selectedCategory === category ? "active" : ""} onClick={() => { setScope("all"); chooseCategory(category); }}>
                <FolderOpen size={15} /><span>{category}</span><b>{categoryCount(category)}</b>
              </button>
            ))}
            <div className="references-path" title={data?.referencesPath}>
              <small>Carpeta activa</small>
              <span>{data?.referencesPath ?? `${rootPath}\\Referencias`}</span>
            </div>
          </aside>
        )}

        <section className="references-content">
          <div className="references-toolbar">
            {!sidebarOpen && (
              <button type="button" className="show-sidebar" onClick={() => setSidebarOpen(true)} title="Mostrar barra lateral">
                <PanelLeftOpen size={17} /><span>Panel</span>
              </button>
            )}
            <div className="reference-status-tabs">
              {(["all", "pending", "working", "done"] as const).map((value) => (
                <button type="button" key={value} className={status === value ? "active" : ""} onClick={() => setStatusFilter(value)}>
                  {value !== "all" && <span className={`status-dot ${value}`} aria-hidden="true" />}
                  {value === "all" ? "Todas" : referenceStatusLabels[value]}
                </button>
              ))}
            </div>
            <div className="references-result-count">
              <strong>{visibleReferences.length.toLocaleString("es-AR")}</strong>
              <span>{visibleReferences.length === 1 ? "referencia" : "referencias"}</span>
            </div>
            <select value={sort} onChange={(event) => {
              // Volver a "Aleatorio" recupera el orden del dia, no inventa uno
              // nuevo: para eso esta el boton de mezclar.
              setSort(event.target.value as ReferenceSort);
            }} aria-label="Ordenar referencias">
              <option value="recent">Mas recientes</option>
              <option value="name">Nombre</option>
              <option value="random">Aleatorio</option>
            </select>
            {sort === "random" && <button type="button" className="shuffle-references" onClick={() => setRandomSeed(Date.now())} title="Mezclar de nuevo"><Shuffle size={16} /></button>}
            <div className="references-size-control" aria-label="Tamano de miniaturas">
              {(["small", "medium", "large"] as const).map((value) => (
                <button type="button" key={value} className={size === value ? "active" : ""} onClick={() => setSize(value)} title={`Miniaturas ${value}`} />
              ))}
            </div>
          </div>

          {loading ? (
            <div className="references-empty"><Loader2 size={28} className="spin" /><strong>Cargando referencias...</strong></div>
          ) : visibleReferences.length === 0 ? (
            <div className="references-empty">
              <Sparkles size={30} />
              <strong>No hay referencias para mostrar</strong>
              <span>Agrega imagenes dentro de las carpetas de Referencias o cambia los filtros.</span>
            </div>
          ) : (
            <ReferencesWall
              references={visibleReferences}
              size={size}
              selectedId={selectedReference?.id ?? null}
              onSelect={setSelectedId}
              onView={setLightboxId}
              onFavorite={(reference) => void toggleFavorite(reference)}
              onOpenFolder={(reference) =>
                // Abre la carpeta con el archivo ya seleccionado y resaltado:
                // apretar la carpeta es para ver esa imagen, no para buscarla.
                void revealDesignFile(reference.path).catch((openError) => setError(String(openError)))
              }
              onStartWork={showWorkDialog}
              onOpenWork={(reference) => void openWork(reference)}
            />
          )}
        </section>
      </section>

      {lightboxReference && (
        <Viewer
          reference={lightboxReference}
          index={lightboxIndex}
          total={visibleReferences.length}
          onClose={() => setLightboxId(null)}
          onPrevious={() => {
            const next = (lightboxIndex - 1 + visibleReferences.length) % visibleReferences.length;
            setLightboxId(visibleReferences[next].id);
          }}
          onNext={() => {
            const next = (lightboxIndex + 1) % visibleReferences.length;
            setLightboxId(visibleReferences[next].id);
          }}
          onFavorite={() => void toggleFavorite(lightboxReference)}
          onOpenFolder={() => void revealDesignFile(lightboxReference.path).catch((openError) => setError(String(openError)))}
          onStartWork={() => showWorkDialog(lightboxReference)}
          onOpenWork={() => void openWork(lightboxReference)}
          onStatus={(nextStatus) => void changeStatus(lightboxReference, nextStatus)}
        />
      )}

      {workReference && (
        <div className="reference-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !creatingWork) setWorkReference(null);
        }}>
          <form className="create-work-modal" onSubmit={(event) => { event.preventDefault(); void createWork(); }}>
            <div className="create-work-title">
              <BriefcaseBusiness size={21} />
              <div><strong>CREAR TRABAJO</strong><span>La referencia original no se mueve ni se modifica.</span></div>
              <button type="button" onClick={() => setWorkReference(null)} disabled={creatingWork}><X size={17} /></button>
            </div>
            <label>
              <span>Nombre</span>
              <input autoFocus value={workName} onChange={(event) => setWorkName(event.target.value)} />
            </label>
            <div className="create-work-reference">
              <img src={convertFileSrc(workReference.thumbnailPath ?? workReference.path)} alt="" />
              <div><strong>{workReference.fileName}</strong><span>{workReference.category}</span></div>
            </div>
            <p>Se creara una carpeta dentro de <b>Trabajos</b> y se copiara esta imagen. Luego podras agregar alli PNG, PSD, AI y los demas archivos.</p>
            <div className="create-work-actions">
              <button type="button" onClick={() => setWorkReference(null)} disabled={creatingWork}>Cancelar</button>
              <button type="submit" className="primary" disabled={creatingWork || !workName.trim()}>
                {creatingWork ? <Loader2 size={16} className="spin" /> : <BriefcaseBusiness size={16} />}
                Crear trabajo
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

const referenceColumnWidths = { small: 150, medium: 220, large: 310 } as const;
const REFERENCE_WALL_GAP = 14;

function ReferencesWall({
  references,
  size,
  selectedId,
  onSelect,
  onView,
  onFavorite,
  onOpenFolder,
  onStartWork,
  onOpenWork,
}: {
  references: ReferenceItem[];
  size: keyof typeof referenceColumnWidths;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onView: (id: string) => void;
  onFavorite: (reference: ReferenceItem) => void;
  onOpenFolder: (reference: ReferenceItem) => void;
  onStartWork: (reference: ReferenceItem) => void;
  onOpenWork: (reference: ReferenceItem) => void;
}) {
  const wallRef = useRef<HTMLDivElement>(null);
  const [wallWidth, setWallWidth] = useState(0);

  useEffect(() => {
    const node = wallRef.current;
    if (!node) return;
    // El ancho util cambia solo cuando aparece la barra de scroll o se pliega
    // el panel lateral, asi que hay que medirlo y no calcularlo.
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWallWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => buildMasonryLayout(references, wallWidth, referenceColumnWidths[size], REFERENCE_WALL_GAP),
    [references, wallWidth, size],
  );

  return (
    <div className="references-wall" ref={wallRef}>
      <div className="references-wall-canvas" style={{ height: layout.height }}>
        {wallWidth > 0 &&
          layout.tiles.map((tile) => (
            <ReferenceCard
              key={tile.item.id}
              tile={tile}
              selected={selectedId === tile.item.id}
              onSelect={() => onSelect(tile.item.id)}
              onView={() => onView(tile.item.id)}
              onFavorite={() => onFavorite(tile.item)}
              onOpenFolder={() => onOpenFolder(tile.item)}
              onStartWork={() => onStartWork(tile.item)}
              onOpenWork={() => onOpenWork(tile.item)}
            />
          ))}
      </div>
    </div>
  );
}

const ReferenceCard = memo(function ReferenceCard({
  tile,
  selected,
  onSelect,
  onView,
  onFavorite,
  onOpenFolder,
  onStartWork,
  onOpenWork,
}: {
  tile: MasonryTile<ReferenceItem>;
  selected: boolean;
  onSelect: () => void;
  onView: () => void;
  onFavorite: () => void;
  onOpenFolder: () => void;
  onStartWork: () => void;
  onOpenWork: () => void;
}) {
  const reference = tile.item;
  const [useOriginal, setUseOriginal] = useState(false);
  const source = convertFileSrc(useOriginal || !reference.thumbnailPath ? reference.path : reference.thumbnailPath);
  return (
    <article
      className={`reference-card ${selected ? "selected" : ""}`}
      style={{ left: tile.left, top: tile.top, width: tile.width, height: tile.height }}
      onClick={() => {
        // Marcarla ademas de abrirla: al cerrar el visor se ve donde estabas.
        onSelect();
        onView();
      }}
    >
      <img src={source} alt={reference.name} loading="lazy" decoding="async" draggable={false} onError={() => setUseOriginal(true)} />
      <span className={`reference-status ${reference.status}`} title={referenceStatusLabels[reference.status]} />
      <button type="button" className={`reference-heart ${reference.favorite ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); onFavorite(); }} title="Favorita">
        <Heart size={17} fill={reference.favorite ? "currentColor" : "none"} />
      </button>
      {tile.cropped && (
        <span className="reference-cropped" title="Es mas alargada que el limite de la pared: abrila para verla entera">
          <Crop size={14} />
        </span>
      )}
      <div className="reference-card-footer">
        <div className="reference-card-meta">
          <strong>{reference.name}</strong>
          <span>{reference.category}</span>
        </div>
        <div className="reference-hover-actions">
          <button type="button" onClick={(event) => { event.stopPropagation(); onOpenFolder(); }} title="Mostrar el archivo en su carpeta"><FolderOpen size={16} /></button>
          {reference.workPath ? (
            <button type="button" className="work" onClick={(event) => { event.stopPropagation(); onOpenWork(); }} title="Abrir trabajo"><BriefcaseBusiness size={16} /></button>
          ) : (
            <button type="button" className="work" onClick={(event) => { event.stopPropagation(); onStartWork(); }} title="Enviar a trabajo"><BriefcaseBusiness size={16} /></button>
          )}
        </div>
      </div>
    </article>
  );
});

function ReferenceStatusPicker({
  className,
  status,
  onStatus,
}: {
  className: string;
  status: ReferenceStatus;
  onStatus: (status: ReferenceStatus) => void;
}) {
  return (
    <div className={className}>
      {(["pending", "working", "done"] as const).map((value) => (
        <button
          type="button"
          key={value}
          className={`${value} ${status === value ? "active" : ""}`}
          onClick={() => onStatus(value)}
          title={referenceStatusLabels[value]}
        >
          <span className={`status-dot ${value}`} aria-hidden="true" />
          <span>{referenceStatusLabels[value]}</span>
        </button>
      ))}
    </div>
  );
}

function ReferenceLightbox({
  reference,
  index,
  total,
  onClose,
  onPrevious,
  onNext,
  onFavorite,
  onOpenFolder,
  onStartWork,
  onOpenWork,
  onStatus,
}: {
  reference: ReferenceItem;
  index: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onFavorite: () => void;
  onOpenFolder: () => void;
  onStartWork: () => void;
  onOpenWork: () => void;
  onStatus: (status: ReferenceStatus) => void;
}) {
  return (
    <div className="reference-lightbox" role="dialog" aria-modal="true" aria-label={reference.name}>
      <button type="button" className="lightbox-close" onClick={onClose} title="Cerrar"><X size={22} /></button>
      <button type="button" className="lightbox-arrow previous" onClick={onPrevious} title="Referencia anterior"><ChevronLeft size={30} /></button>
      <div className="lightbox-image-stage"><img src={convertFileSrc(reference.path)} alt={reference.name} /></div>
      <button type="button" className="lightbox-arrow next" onClick={onNext} title="Referencia siguiente"><ChevronRight size={30} /></button>
      <aside className="lightbox-info">
        <small>{index + 1} de {total}</small>
        <h2>{reference.name}</h2>
        <p>{reference.fileName}</p>
        <span className="lightbox-category">{reference.category}</span>
        <ReferenceStatusPicker className="lightbox-statuses" status={reference.status} onStatus={onStatus} />
        <div className="lightbox-actions">
          <button type="button" onClick={onFavorite}><Heart size={17} fill={reference.favorite ? "currentColor" : "none"} />{reference.favorite ? "Quitar favorita" : "Favorita"}</button>
          <button type="button" onClick={onOpenFolder}><FolderOpen size={17} />Mostrar en su carpeta</button>
          {reference.workPath ? (
            <button type="button" className="primary" onClick={onOpenWork}><BriefcaseBusiness size={17} />Abrir trabajo</button>
          ) : (
            <button type="button" className="primary" onClick={onStartWork}><BriefcaseBusiness size={17} />Enviar a trabajo</button>
          )}
        </div>
        <div className="lightbox-path" title={reference.path}>{reference.path}</div>
      </aside>
    </div>
  );
}

const VIEWER_CONTROLS_HIDE_MS = 2200;

const referenceStatusCycle: ReferenceStatus[] = ["pending", "working", "done"];

function nextReferenceStatus(status: ReferenceStatus) {
  const position = referenceStatusCycle.indexOf(status);
  return referenceStatusCycle[(position + 1) % referenceStatusCycle.length];
}

function ReferenceWindow({
  reference,
  index,
  total,
  onClose,
  onPrevious,
  onNext,
  onFavorite,
  onOpenFolder,
  onStartWork,
  onOpenWork,
  onStatus,
}: {
  reference: ReferenceItem;
  index: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onFavorite: () => void;
  onOpenFolder: () => void;
  onStartWork: () => void;
  onOpenWork: () => void;
  onStatus: (status: ReferenceStatus) => void;
}) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const [naturalAspect, setNaturalAspect] = useState<number | null>(null);
  const overControls = useRef(false);
  const hideTimer = useRef(0);

  // El marco copia la forma del archivo. Normalmente las medidas ya vienen del
  // escaneo; si a esa referencia todavia le faltan, se toman de la imagen al
  // cargar para que el marco nunca invente una forma que no es.
  const storedAspect =
    reference.width && reference.height ? reference.width / reference.height : null;
  const aspect = storedAspect ?? naturalAspect ?? 0.75;

  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      // Con el mouse encima de la barra no se esconde: si no, desaparece
      // justo cuando estas por elegir un estado.
      if (!overControls.current) setControlsVisible(false);
    }, VIEWER_CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    const wake = () => {
      setControlsVisible(true);
      scheduleHide();
    };
    wake();
    window.addEventListener("mousemove", wake);
    // Tambien con el teclado: pasando con las flechas y el mouse quieto, si no
    // no se ve el nombre ni el contador de la referencia a la que llegaste.
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      window.clearTimeout(hideTimer.current);
    };
  }, [scheduleHide]);

  const holdControls = {
    onMouseEnter: () => {
      overControls.current = true;
      setControlsVisible(true);
    },
    onMouseLeave: () => {
      overControls.current = false;
      scheduleHide();
    },
  };

  return (
    <div
      className="reference-window-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`reference-window ${controlsVisible ? "" : "controls-hidden"}`}
        style={{ "--reference-aspect": aspect } as CSSProperties}
        role="dialog"
        aria-modal="true"
        aria-label={reference.name}
      >
        <img
          src={convertFileSrc(reference.path)}
          alt={reference.name}
          draggable={false}
          onLoad={(event) =>
            setNaturalAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)
          }
        />

        {/* Un solo punto, el del estado actual, en el mismo lugar y del mismo
            tamano que en la pared. No se esconde con el resto de los controles. */}
        <button
          type="button"
          className={`reference-status ${reference.status}`}
          onClick={() => onStatus(nextReferenceStatus(reference.status))}
          title={`${referenceStatusLabels[reference.status]} (clic para cambiar)`}
        />

        <div className="reference-window-top" {...holdControls}>
          <div className="reference-window-title">
            <strong>{reference.name}</strong>
            <small>{index + 1} de {total} &middot; {reference.category}</small>
          </div>
          <button type="button" onClick={onClose} title="Cerrar"><X size={19} /></button>
        </div>

        <button type="button" className="reference-window-arrow previous" onClick={onPrevious} title="Referencia anterior" {...holdControls}>
          <ChevronLeft size={26} />
        </button>
        <button type="button" className="reference-window-arrow next" onClick={onNext} title="Referencia siguiente" {...holdControls}>
          <ChevronRight size={26} />
        </button>

        <div className="reference-window-bar" {...holdControls}>
          <div className="reference-window-actions">
            <button type="button" className={reference.favorite ? "favorite active" : "favorite"} onClick={onFavorite} title={reference.favorite ? "Quitar favorita" : "Favorita"}>
              <Heart size={17} fill={reference.favorite ? "currentColor" : "none"} />
            </button>
            <button type="button" onClick={onOpenFolder} title="Mostrar el archivo en su carpeta"><FolderOpen size={17} /></button>
            {reference.workPath ? (
              <button type="button" className="work" onClick={onOpenWork} title="Abrir trabajo"><BriefcaseBusiness size={17} /></button>
            ) : (
              <button type="button" className="work" onClick={onStartWork} title="Enviar a trabajo"><BriefcaseBusiness size={17} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({
  brandLogo,
  brandPresentation,
  libraryPath,
  setFilters,
  loading,
  onRunScan,
  onRandomDesign,
  randomProgress,
  showIconLabels,
  setShowIconLabels,
  setSettingsOpen,
  onOpenReferences,
  uiScale,
  setUiScale,
}: {
  brandLogo: BrandLogo | null;
  brandPresentation: BrandPresentation;
  libraryPath: string;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  loading: boolean;
  onRunScan: () => void;
  onRandomDesign: () => void;
  randomProgress: RandomProgress;
  showIconLabels: boolean;
  setShowIconLabels: (show: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  onOpenReferences: () => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
}) {
  // El zoom cambia el tamano del propio deslizador, asi que mientras se
  // arrastra solo se mueve este borrador y el zoom se aplica al soltar.
  const [scaleDraft, setScaleDraft] = useState<number | null>(null);
  const [interfaceOpen, setInterfaceOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const interfaceMenuRef = useRef<HTMLDivElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!libraryOpen) return;
    const closeLibraryMenu = (event: PointerEvent) => {
      if (!libraryMenuRef.current?.contains(event.target as Node)) setLibraryOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryOpen(false);
    };
    window.addEventListener("pointerdown", closeLibraryMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", closeLibraryMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [libraryOpen]);

  const applyScale = (scale: number) => {
    setScaleDraft(null);
    setUiScale(scale);
  };

  const randomRemaining = Math.max(0, randomProgress.total - randomProgress.seen);

  return (
    <header className="visual-header" style={brandHeaderStyle(brandPresentation)}>
      <section className={brandLogo ? "logo-area has-logo" : "logo-area empty"} aria-label="Logo de marca">
        {brandLogo && (
          <img
            className="brand-logo"
            src={brandLogo.dataUrl}
            alt="Logo de la marca"
            draggable={false}
            style={brandLogoStyle(brandPresentation)}
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        )}
      </section>

      <section className="window-actions">
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
          title={`Elegir una imagen al azar sin repetir. Quedan ${randomRemaining.toLocaleString("es-AR")} de ${randomProgress.total.toLocaleString("es-AR")}.`}
        >
          <Shuffle size={15} />
        </button>
      </section>

      {/* El nombre va entre los dos grupos de botones para que el hueco libre
          lo centre solo, aunque mas adelante se agreguen o saquen botones. */}
      {brandPresentation.name.trim() && (
        <div className="header-brand-name" style={brandNameStyle(brandPresentation)}>
          {brandPresentation.name.trim()}
        </div>
      )}

      {/* Controles de la aplicacion, contra el borde derecho: el engranaje en
          la punta como en cualquier programa, y Referencias a su izquierda. */}
      <section className="app-actions">
        <div ref={interfaceMenuRef} className="interface-menu">
          <button
            type="button"
            className={interfaceOpen ? "interface-trigger active" : "interface-trigger"}
            onClick={() => {
              setLibraryOpen(false);
              setInterfaceOpen((open) => !open);
            }}
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
        <div ref={libraryMenuRef} className="library-menu">
          <button
            type="button"
            className={libraryOpen ? "library-trigger active" : "library-trigger"}
            onClick={() => {
              setInterfaceOpen(false);
              setLibraryOpen((open) => !open);
            }}
            aria-expanded={libraryOpen}
            aria-controls="current-library-popover"
          >
            <FolderOpen size={15} />
            <span>Biblioteca actual</span>
            <ChevronDown size={14} className={libraryOpen ? "open" : ""} />
          </button>
          {libraryOpen && (
            <div id="current-library-popover" className="library-popover">
              <small>Ubicacion de la biblioteca</small>
              <strong title={libraryPath}>{libraryPath}</strong>
            </div>
          )}
        </div>
        <button className="action-button references-entry" onClick={onOpenReferences} title="Abrir el muro de referencias">
          <Sparkles size={17} />
          <span>Referencias</span>
        </button>
        <div className="settings-menu">
          <button className="icon-only" title="Ajustes" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} />
          </button>
        </div>
      </section>
    </header>
  );
}

/// Primera pantalla de una instalacion nueva. Explica que va a pasar antes de
/// abrir el explorador, porque elegir la carpeta crea contenido adentro.
function WelcomeScreen({
  onChooseFolder,
  onContinueWithoutFolder,
  error,
  onDismissError,
}: {
  onChooseFolder: () => void;
  onContinueWithoutFolder: () => void;
  error: string | null;
  onDismissError: () => void;
}) {
  return (
    <main className="welcome-shell">
      <section className="welcome-card">
        <div className="welcome-mark">
          <ImageIcon className="welcome-mark-image" size={42} strokeWidth={1.55} />
          <Sparkles className="welcome-mark-sparkle" size={21} strokeWidth={1.8} />
        </div>
        <h1>Biblioteca de imágenes</h1>
        <p className="welcome-lead">Elegí cómo querés empezar.</p>
        <div className="welcome-notice">
          <strong>Antes de continuar</strong>
          <p>
            Al elegir una carpeta para tu biblioteca, dentro de ella se crearán cuatro carpetas:
            Categorías, Trabajos, Referencias y Varios. Tus archivos actuales no se modifican.
          </p>
          <p>
            Si continuás sin carpeta, podés entrar igual. Para mostrar tus imágenes, después tendrás
            que elegir una desde Configuración.
          </p>
        </div>
        <button type="button" className="welcome-action" onClick={onChooseFolder}>
          <FolderOpen size={18} />
          <span>Elegir carpeta y empezar</span>
        </button>
        <button type="button" className="welcome-action welcome-action-secondary" onClick={onContinueWithoutFolder}>
          <span>Continuar sin carpeta</span>
          <ArrowRight size={18} />
        </button>
        {error && (
          <div className="welcome-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onDismissError}>Entendido</button>
          </div>
        )}
      </section>
    </main>
  );
}

function SettingsScreen({
  library,
  brandLogo,
  brandPresentation,
  onChangeBrandPresentation,
  brandLogoState,
  onChooseBrandLogo,
  onDropBrandLogo,
  onRemoveBrandLogo,
  loading,
  onChooseFolder,
  onRunScan,
  updateState,
  availableUpdateVersion,
  onCheckForUpdates,
  onInstallUpdate,
  thumbnailPrep,
  onPrepareThumbnails,
  previewPrep,
  onPreparePreviews,
  backupState,
  onSaveBackup,
  onOpenBackupFolder,
  onRestoreBackup,
  referenceViewer,
  onChangeReferenceViewer,
  theme,
  onChangeTheme,
  error,
  onDismissError,
  onBack,
}: {
  library: LibraryResponse | null;
  brandLogo: BrandLogo | null;
  brandPresentation: BrandPresentation;
  onChangeBrandPresentation: Dispatch<SetStateAction<BrandPresentation>>;
  brandLogoState: BrandLogoState;
  onChooseBrandLogo: () => void;
  onDropBrandLogo: (path: string) => void | Promise<void>;
  onRemoveBrandLogo: () => void;
  loading: boolean;
  onChooseFolder: () => void;
  onRunScan: () => void;
  updateState: AppUpdateState;
  availableUpdateVersion: string | null;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  thumbnailPrep: ThumbnailPrepState;
  onPrepareThumbnails: () => void;
  previewPrep: ThumbnailPrepState;
  onPreparePreviews: () => void;
  backupState: BackupState;
  onSaveBackup: () => void;
  onOpenBackupFolder: () => void;
  onRestoreBackup: () => void;
  referenceViewer: ReferenceViewerMode;
  onChangeReferenceViewer: (mode: ReferenceViewerMode) => void;
  theme: AppTheme;
  onChangeTheme: (theme: AppTheme) => void;
  error: string | null;
  onDismissError: () => void;
  onBack: () => void;
}) {
  const [brandDragActive, setBrandDragActive] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[]>(SYSTEM_FONT_FALLBACKS);
  const [fontLoadState, setFontLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [fontSearch, setFontSearch] = useState("");
  const [fontListOpen, setFontListOpen] = useState(false);
  const fontPickerRef = useRef<HTMLDivElement>(null);
  const fontPopoverRef = useRef<HTMLDivElement>(null);
  const brandDropRef = useRef<HTMLDivElement>(null);
  const draggedBrandPathsRef = useRef<string[]>([]);
  const updateBusy = updateState.phase === "checking" || updateState.phase === "downloading" || updateState.phase === "installing";
  const thumbnailBusy = thumbnailPrep.phase === "running";
  const thumbnailProgress = thumbnailPrep.total > 0 ? Math.round((thumbnailPrep.done / thumbnailPrep.total) * 100) : null;
  const previewBusy = previewPrep.phase === "running";
  const previewProgress = previewPrep.total > 0 ? Math.round((previewPrep.done / previewPrep.total) * 100) : null;
  const backupBusy = backupState.phase === "saving" || backupState.phase === "opening" || backupState.phase === "loading";
  const brandLogoBusy = brandLogoState.phase === "saving" || brandLogoState.phase === "removing";

  const updateBrandPresentation = <Key extends keyof BrandPresentation,>(key: Key, value: BrandPresentation[Key]) => {
    onChangeBrandPresentation((current) => ({ ...current, [key]: value }));
  };

  /// Primero le preguntamos a Windows por el backend (lee la carpeta de fuentes
  /// del equipo). Si eso falla probamos la API del navegador, y como ultimo
  /// recurso quedan las fuentes que Windows trae siempre.
  const loadSystemFonts = useCallback(async () => {
    setFontLoadState("loading");
    const mergeFamilies = (families: string[]) =>
      Array.from(new Set([...SYSTEM_FONT_FALLBACKS, ...families.map((family) => family.trim()).filter(Boolean)]))
        .sort((left, right) => left.localeCompare(right, "es", { sensitivity: "base" }));

    try {
      setSystemFonts(mergeFamilies(await listSystemFonts()));
      setFontLoadState("loaded");
      return;
    } catch {
      // El backend no pudo leer la carpeta de fuentes: seguimos con el navegador.
    }

    try {
      const queryLocalFonts = (window as Window & {
        queryLocalFonts?: () => Promise<Array<{ family: string }>>;
      }).queryLocalFonts;
      if (!queryLocalFonts) throw new Error("WebView2 no ofrece acceso a la lista local");
      const fonts = await queryLocalFonts.call(window);
      setSystemFonts(mergeFamilies(fonts.map((font) => font.family)));
      setFontLoadState("loaded");
    } catch {
      setSystemFonts(SYSTEM_FONT_FALLBACKS);
      setFontLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadSystemFonts();
  }, [loadSystemFonts]);

  const visibleFonts = useMemo(() => {
    const needle = fontSearch.trim().toLowerCase();
    if (!needle) return systemFonts;
    return systemFonts.filter((font) => font.toLowerCase().includes(needle));
  }, [fontSearch, systemFonts]);

  useEffect(() => {
    if (!fontListOpen) return;
    const closeFontList = (event: MouseEvent) => {
      if (!fontPickerRef.current?.contains(event.target as Node)) setFontListOpen(false);
    };
    window.addEventListener("pointerdown", closeFontList);
    return () => window.removeEventListener("pointerdown", closeFontList);
  }, [fontListOpen]);

  /// En pantallas bajas la lista se abriria por debajo del borde: la subimos
  /// arriba del boton o, si tampoco entra, acercamos el panel con un scroll.
  useLayoutEffect(() => {
    const popover = fontPopoverRef.current;
    const trigger = fontPickerRef.current;
    if (!fontListOpen || !popover || !trigger) return;
    popover.classList.remove("upwards");
    const triggerBounds = trigger.getBoundingClientRect();
    const needed = popover.offsetHeight + 12;
    if (triggerBounds.bottom + needed > window.innerHeight && triggerBounds.top > needed) {
      popover.classList.add("upwards");
    } else if (triggerBounds.bottom + needed > window.innerHeight) {
      popover.scrollIntoView({ block: "nearest" });
    }
  }, [fontListOpen, visibleFonts.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Con la lista de fuentes abierta, Escape cierra solo la lista: salir de
      // Configuracion de golpe seria perder de vista lo que se estaba ajustando.
      if (fontListOpen) {
        setFontListOpen(false);
        return;
      }
      onBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fontListOpen, onBack]);

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
          <section className="settings-card library-settings-card">
            <div className="settings-card-header">
              <FolderOpen size={19} />
              <div>
                <h2>Biblioteca y rendimiento</h2>
                <p>Consulta la ubicacion actual o cambia la carpeta principal.</p>
              </div>
            </div>
            <div className="settings-library-path">
              <small>Biblioteca actual</small>
              <strong title={library?.rootPath || "Sin carpeta elegida"}>{library?.rootPath || "Sin carpeta elegida"}</strong>
            </div>
            {/* Los cuatro botones van juntos en una sola fila de cuadrados. Los
                avisos de progreso quedan debajo, fuera de la fila, para no
                partirla en dos cuando aparecen. */}
            <div className="settings-action-list">
              <button className="settings-action" onClick={onChooseFolder} disabled={loading}>
                <FolderOpen size={24} />
                <span>Cambiar biblioteca</span>
              </button>
              <button className="settings-action secondary" onClick={onRunScan} disabled={loading}>
                <RefreshCw size={24} className={loading ? "spin" : ""} />
                <span>Escanear biblioteca</span>
              </button>
              <button className="settings-action secondary" onClick={onPrepareThumbnails} disabled={thumbnailBusy || !library}>
                {thumbnailBusy ? <Loader2 size={24} className="spin" /> : <FileImage size={24} />}
                <span>{thumbnailBusy ? "Preparando..." : "Preparar miniaturas"}</span>
              </button>
              <button className="settings-action secondary" onClick={onPreparePreviews} disabled={previewBusy || !library}>
                {previewBusy ? <Loader2 size={24} className="spin" /> : <Maximize2 size={24} />}
                <span>{previewBusy ? "Optimizando visor..." : "Optimizar visor"}</span>
              </button>
            </div>
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
              <small>
                Preferencias automáticas: versión actual y dos anteriores dentro de {(library?.rootPath ?? "").replace(/[\\/]+$/, "")}\Preferences
              </small>
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
            <div className="settings-update">
              <div className="settings-section-label">Actualizaciones</div>
              <button
                className="settings-action secondary"
                onClick={onCheckForUpdates}
                disabled={updateBusy || availableUpdateVersion !== null}
              >
                {updateState.phase === "none" || updateState.phase === "done" ? (
                  <Check size={16} />
                ) : (
                  <RefreshCw size={16} className={updateState.phase === "checking" ? "spin" : ""} />
                )}
                <span>{updateState.phase === "checking" ? "Buscando..." : "Buscar actualizacion"}</span>
              </button>
              {availableUpdateVersion && (
                <div className="update-available">
                  <div>
                    <small>Nueva version disponible</small>
                    <strong>ROXWANA v{availableUpdateVersion}</strong>
                  </div>
                  <button className="settings-action" onClick={onInstallUpdate} disabled={updateBusy}>
                    {updateState.phase === "downloading" || updateState.phase === "installing" ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <RefreshCw size={16} />
                    )}
                    <span>{updateBusy ? "Actualizando..." : "Actualizar ahora"}</span>
                  </button>
                </div>
              )}
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
            </div>
          </section>

          <section className="settings-card brand-settings-card">
            <div className="settings-card-header">
              <FileImage size={19} />
              <div>
                <h2>Identidad de marca</h2>
                <p>Logo y nombre que aparecen en el encabezado de la aplicacion.</p>
              </div>
            </div>
            <div className="settings-brand">
              <div className="brand-editor-stage-label">
                <span>Vista previa del encabezado, a tamaño real</span>
                <strong>
                  {brandLogo ? `Logo original: ${brandLogo.width} × ${brandLogo.height} px` : "Sin logo cargado"}
                </strong>
              </div>
              <div
                ref={brandDropRef}
                className={`settings-brand-preview brand-drop-zone ${brandLogo ? "has-logo" : "empty"} ${brandDragActive ? "drag-active" : ""}`}
              >
                {brandDragActive ? (
                  <div className="brand-drop-prompt">
                    <Upload size={24} />
                    <strong>Solta la imagen para usarla como logo</strong>
                  </div>
                ) : (
                  <div className="brand-header-preview" style={brandHeaderStyle(brandPresentation)}>
                    <div className={brandLogo ? "logo-area brand-preview-logo-slot has-logo" : "logo-area brand-preview-logo-slot empty"}>
                      {brandLogo && (
                        <img
                          className="brand-logo"
                          src={brandLogo.dataUrl}
                          alt="Vista previa del logo"
                          draggable={false}
                          style={brandLogoStyle(brandPresentation)}
                        />
                      )}
                    </div>
                    <div className="brand-preview-tools" aria-hidden="true">
                      <span>Rescaneo</span>
                    </div>
                    {brandPresentation.name.trim() && (
                      <div className="header-brand-name brand-preview-name" style={brandNameStyle(brandPresentation)}>
                        {brandPresentation.name.trim()}
                      </div>
                    )}
                    {!brandLogo && !brandPresentation.name.trim() && (
                      <div className="brand-preview-empty-hint">
                        <ImageOff size={18} />
                        <span>Carga un logo o escribe el nombre de tu marca</span>
                      </div>
                    )}
                    <div className="brand-preview-actions" aria-hidden="true">
                      <span>Interfaz</span>
                      <span>Biblioteca actual</span>
                    </div>
                  </div>
                )}
              </div>

              {brandLogo && (
                <div className="brand-logo-editor">
                  <div className="brand-control-heading">
                    <strong>Ajustar logo</strong>
                    <button
                      type="button"
                      onClick={() => onChangeBrandPresentation((current) => ({
                        ...current,
                        logoScale: DEFAULT_BRAND_PRESENTATION.logoScale,
                        logoOffsetX: DEFAULT_BRAND_PRESENTATION.logoOffsetX,
                        logoOffsetY: DEFAULT_BRAND_PRESENTATION.logoOffsetY,
                      }))}
                      disabled={brandPresentation.logoScale === 100 && brandPresentation.logoOffsetX === 0 && brandPresentation.logoOffsetY === 0}
                    >
                      <RotateCcw size={13} /> Restablecer
                    </button>
                  </div>
                  <label className="brand-range-control">
                    <span>Tamaño <b>{brandPresentation.logoScale}%</b></span>
                    <input
                      type="range"
                      min={BRAND_LOGO_SCALE_MIN}
                      max={BRAND_LOGO_SCALE_MAX}
                      step="5"
                      value={brandPresentation.logoScale}
                      onChange={(event) => updateBrandPresentation("logoScale", Number(event.target.value))}
                    />
                  </label>
                  <div className="brand-position-controls">
                    <label className="brand-range-control">
                      <span>Horizontal <b>{brandPresentation.logoOffsetX > 0 ? "+" : ""}{brandPresentation.logoOffsetX}px</b></span>
                      <input
                        type="range"
                        min="-24"
                        max="24"
                        step="1"
                        value={brandPresentation.logoOffsetX}
                        onChange={(event) => updateBrandPresentation("logoOffsetX", Number(event.target.value))}
                      />
                    </label>
                    <label className="brand-range-control">
                      <span>Vertical <b>{brandPresentation.logoOffsetY > 0 ? "+" : ""}{brandPresentation.logoOffsetY}px</b></span>
                      <input
                        type="range"
                        min="-18"
                        max="18"
                        step="1"
                        value={brandPresentation.logoOffsetY}
                        onChange={(event) => updateBrandPresentation("logoOffsetY", Number(event.target.value))}
                      />
                    </label>
                  </div>
                </div>
              )}

              <div className="brand-name-editor">
                <div className="brand-control-heading">
                  <strong>Nombre de marca</strong>
                  <small>Si queda vacío, no aparece en la aplicación.</small>
                </div>
                <input
                  className="brand-name-input"
                  type="text"
                  maxLength={40}
                  value={brandPresentation.name}
                  onChange={(event) => updateBrandPresentation("name", event.target.value)}
                  placeholder="Por ejemplo: ROXWANA"
                />
                <div className="brand-font-row">
                  <div ref={fontPickerRef} className="brand-font-picker">
                    <span className="brand-font-label">Fuente</span>
                    <button
                      type="button"
                      className={fontListOpen ? "brand-font-trigger open" : "brand-font-trigger"}
                      onClick={() => {
                        setFontSearch("");
                        setFontListOpen((open) => !open);
                      }}
                      aria-expanded={fontListOpen}
                    >
                      <b style={{ fontFamily: `"${brandPresentation.nameFont.replace(/["\\]/g, "")}", sans-serif` }}>
                        {brandPresentation.nameFont}
                      </b>
                      <ChevronDown size={14} />
                    </button>
                    {fontListOpen && (
                      <div ref={fontPopoverRef} className="brand-font-popover">
                        <input
                          autoFocus
                          type="text"
                          className="brand-font-search"
                          value={fontSearch}
                          onChange={(event) => setFontSearch(event.target.value)}
                          placeholder="Buscar entre tus fuentes..."
                        />
                        <div className="brand-font-options">
                          {visibleFonts.map((font) => (
                            <button
                              key={font}
                              type="button"
                              className={font === brandPresentation.nameFont ? "brand-font-option selected" : "brand-font-option"}
                              onClick={() => {
                                updateBrandPresentation("nameFont", font);
                                setFontListOpen(false);
                              }}
                            >
                              <span style={{ fontFamily: `"${font.replace(/["\\]/g, "")}", sans-serif` }}>
                                {brandPresentation.name.trim() || font}
                              </span>
                              <small>{font}</small>
                            </button>
                          ))}
                          {visibleFonts.length === 0 && (
                            <p className="brand-font-empty">Ninguna fuente coincide con "{fontSearch.trim()}".</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => void loadSystemFonts()} disabled={fontLoadState === "loading"}>
                    {fontLoadState === "loading" ? <Loader2 size={14} className="spin" /> : <FileText size={14} />}
                    {fontLoadState === "loaded" ? `${systemFonts.length} fuentes` : "Releer fuentes"}
                  </button>
                </div>
                {fontLoadState === "error" && (
                  <small className="brand-font-note">No se pudo leer la carpeta de fuentes de Windows, así que la lista muestra solo las fuentes básicas del sistema.</small>
                )}
                <div className="brand-color-swatches" role="group" aria-label="Colores para el nombre">
                  {BRAND_COLOR_SWATCHES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={color.toLowerCase() === brandPresentation.nameColor.toLowerCase() ? "brand-swatch selected" : "brand-swatch"}
                      style={{ backgroundColor: color }}
                      title={color.toUpperCase()}
                      aria-label={`Usar el color ${color.toUpperCase()}`}
                      onClick={() => updateBrandPresentation("nameColor", color)}
                    />
                  ))}
                </div>
                <div className="brand-name-style-row">
                  <label className="brand-color-control">
                    <span>Otro color</span>
                    <span className="brand-color-input">
                      <input
                        type="color"
                        value={brandPresentation.nameColor}
                        onChange={(event) => updateBrandPresentation("nameColor", event.target.value)}
                      />
                      <b>{brandPresentation.nameColor.toUpperCase()}</b>
                    </span>
                  </label>
                  <label className="brand-range-control">
                    <span>Tamaño del nombre <b>{brandPresentation.nameSize}px</b></span>
                    <input
                      type="range"
                      min="14"
                      max="44"
                      step="1"
                      value={brandPresentation.nameSize}
                      onChange={(event) => updateBrandPresentation("nameSize", Number(event.target.value))}
                    />
                  </label>
                </div>
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
              <small>Arrastra una imagen sobre el encabezado o elegila con el boton. Los cambios de tamaño, posición, nombre, fuente y color se guardan automáticamente.</small>
              {brandLogoState.message && (
                <div className={`update-status ${brandLogoState.phase}`} aria-live="polite">
                  <span>{brandLogoState.message}</span>
                </div>
              )}
            </div>
          </section>

          <section className="settings-card appearance-settings-card">
            <div className="settings-card-header">
              <Sun size={19} />
              <div>
                <h2>Apariencia</h2>
                <p>Colores de la aplicacion y apertura de referencias.</p>
              </div>
            </div>
            <div className="settings-section-label">Tema de la aplicacion</div>
            <div className="theme-mode-options" role="group" aria-label="Tema de la aplicacion">
              <button
                type="button"
                className={theme === "dark" ? "theme-mode-option active" : "theme-mode-option"}
                onClick={() => onChangeTheme("dark")}
                aria-pressed={theme === "dark"}
              >
                <Moon size={18} />
                <span>
                  <strong>Oscuro</strong>
                  <small>Fondo negro y paneles oscuros.</small>
                </span>
              </button>
              <button
                type="button"
                className={theme === "light" ? "theme-mode-option active" : "theme-mode-option"}
                onClick={() => onChangeTheme("light")}
                aria-pressed={theme === "light"}
              >
                <Sun size={18} />
                <span>
                  <strong>Claro</strong>
                  <small>Fondo blanco y texto oscuro.</small>
                </span>
              </button>
            </div>
            <div className="settings-section-label">Visor de referencias</div>
            <div className="viewer-mode-options">
              {([
                {
                  value: "full" as const,
                  title: "Pantalla completa",
                  detail: "Ocupa toda la ventana, con los datos y las acciones en un panel a la derecha.",
                },
                {
                  value: "window" as const,
                  title: "Ventana centrada",
                  detail: "Un recuadro en el medio con el fondo desenfocado. Los controles van sobre la imagen y se esconden solos.",
                },
              ]).map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={`viewer-mode-option ${referenceViewer === option.value ? "active" : ""}`}
                  onClick={() => onChangeReferenceViewer(option.value)}
                  aria-pressed={referenceViewer === option.value}
                >
                  <span className={`viewer-mode-preview ${option.value}`} aria-hidden="true"><span /></span>
                  <strong>{option.title}</strong>
                  <small>{option.detail}</small>
                </button>
              ))}
            </div>
            <small className="viewer-mode-note">En los dos casos cerras con Escape y pasas de una a otra con las flechas del teclado.</small>
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
      if (inside.length === 0) return "El grupo esta vacio. No se borra ninguna categoria ni ninguna imagen.";
      return inside.length === 1
        ? "La categoria que tiene adentro vuelve al panel. No se borra ninguna categoria ni ninguna imagen."
        : `Las ${inside.length.toLocaleString("es-AR")} categorias que tiene adentro vuelven al panel. No se borra ninguna categoria ni ninguna imagen.`;
    }
    const count = categoryCounts.get(node.name) ?? 0;
    if (count === 0) return "La categoria esta vacia. No se borra ningun archivo.";
    return count === 1
      ? "La imagen que tiene queda sin categoria. No se borra ningun archivo."
      : `Las ${count.toLocaleString("es-AR")} imagenes que tiene quedan sin categoria. No se borra ningun archivo.`;
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
                <span className="category-count" aria-label={`${(categoryCounts.get(category) ?? 0).toLocaleString("es-AR")} imagenes`}>
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
                  <span className="category-count" aria-label={`${total.toLocaleString("es-AR")} imagenes`}>
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
          title="Ver todas mis imagenes favoritas"
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
          title="Ver todas las imagenes"
        >
          <span className="filter-name">
            <FileText size={16} />
            Todas las imagenes
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
          title="Ver imagenes sin categoria. Arrastra una imagen aca para quitarle la categoria."
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
              <span className="category-count" aria-label={`${uncategorizedCount.toLocaleString("es-AR")} imagenes`}>
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
  directoryDesigns,
  loading,
  zoom,
  setZoom,
  onPrev,
  onNext,
  onOpenFolder,
}: {
  design: Design | null;
  directoryDesigns: Design[];
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
  const metricDesigns = directoryDesigns.length > 0 ? directoryDesigns : design ? [design] : [];
  const imageCount = countPreviewFilesAcrossDesigns(metricDesigns);
  const applicationAssets = editableApplicationAssets(metricDesigns);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const artboardRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStart = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const assetItems = design
      ? [
          { id: "img", kind: "image" as const, label: "Imagen", value: imageCount, tone: "red" as const },
          { id: "eps", kind: "eps" as const, label: "EPS", value: countForExtensionAcrossDesigns(metricDesigns, ".eps"), tone: "gold" as const },
        { id: "pdf", kind: "pdf" as const, label: "PDF", value: countForExtensionAcrossDesigns(metricDesigns, ".pdf"), tone: "neutral" as const },
        { id: "txt", kind: "txt" as const, label: "Texto", value: countForExtensionAcrossDesigns(metricDesigns, ".txt"), tone: "neutral" as const },
      ].filter((item) => item.value > 0)
    : [];

  useEffect(() => {
    setPreviewSourceIndex(0);
    setLoadingOriginal(false);
  }, [design?.id, design?.previewCachePath, design?.previewPath]);

  /**
   * Carga el archivo original a pedido para poder hacer zoom con detalle real.
   * Es temporal: al cambiar de imagen o cerrar la app se vuelve a la copia liviana.
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
            alt={design?.name ?? "Imagen"}
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
            <div className="viewer-app-badges" aria-label="Aplicaciones de los archivos editables de esta carpeta">
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
            <div className="overlay-assets" aria-label="Archivos de esta carpeta">
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

function editableApplicationAssets(designOrDesigns: Design | Design[]) {
  const designs = Array.isArray(designOrDesigns) ? designOrDesigns : [designOrDesigns];
  return [
    {
      kind: "ai" as const,
      label: "Illustrator",
      count: countForExtensionAcrossDesigns(designs, ".ai") + countForExtensionAcrossDesigns(designs, ".eps"),
    },
    { kind: "psd" as const, label: "Photoshop", count: countForExtensionAcrossDesigns(designs, ".psd") },
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
            placeholder="Buscar imagenes..."
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
    const category = window.prompt("Nueva categoria para esta imagen");
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
        aria-label="Clasificar imagen"
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
          <div className="extension-metrics" title="Archivos de esta imagen">
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
