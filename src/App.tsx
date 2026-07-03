import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { watch } from "@tauri-apps/plugin-fs";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Crown,
  FileArchive,
  FileImage,
  FileText,
  FolderOpen,
  Grid2X2,
  Heart,
  Home,
  ImageOff,
  LayoutGrid,
  Layers,
  List,
  Loader2,
  Maximize2,
  Minus,
  MoreVertical,
  Music,
  PenTool,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Star,
  Tags,
  Type,
  User,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  addTag,
  generateThumbnail,
  getInitialState,
  openDesignFolder,
  removeTag,
  revealDesignFile,
  rescanPaths,
  scanLibrary,
  updateCategory,
  updateFavorite,
  updateStatus,
} from "./lib/api";
import { chooseRandomDesign, countForExtension, createDefaultFilters, filterDesigns } from "./lib/filtering";
import { formatBytes } from "./lib/fileTypes";
import type { Design, DesignStatus, Filters, LibraryResponse } from "./lib/types";

const DEFAULT_LIBRARY_PATH = "C:\\Users\\jaell\\Documents\\estampas-roxwana";
const supportFilters = [".png", ".jpg", ".ai", ".psd", ".eps", ".zip", ".txt"];
const defaultZoom = 100;

const statusOptions: Array<{ value: DesignStatus; label: string }> = [
  { value: "pending", label: "Pendiente" },
  { value: "working", label: "Trabajando" },
  { value: "ready", label: "Listo" },
  { value: "discarded", label: "Descartar" },
];

type QuickFilter =
  | { id: string; label: string; icon: typeof Star; kind: "all" }
  | { id: string; label: string; icon: typeof Star; kind: "favorite" }
  | { id: string; label: string; icon: typeof Star; kind: "status"; status: DesignStatus }
  | { id: string; label: string; icon: typeof Star; kind: "tag"; tag: string }
  | { id: string; label: string; icon: typeof Star; kind: "category"; category: string };

const quickFilters: QuickFilter[] = [
  { id: "all", label: "Todos los disenos", icon: FileText, kind: "all" },
  { id: "favorites", label: "Favoritas", icon: Star, kind: "favorite" },
  { id: "working", label: "Trabajando", icon: Clock3, kind: "status", status: "working" },
  { id: "men", label: "Hombre", icon: User, kind: "tag", tag: "hombre" },
  { id: "women", label: "Mujer", icon: UserRound, kind: "tag", tag: "mujer" },
  { id: "skater", label: "Skater", icon: Circle, kind: "tag", tag: "skate" },
  { id: "rock", label: "Rock", icon: Music, kind: "tag", tag: "rock" },
  { id: "urban", label: "Urbano", icon: Home, kind: "category", category: "Urbano" },
];

export default function App() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [filters, setFilters] = useState<Filters>(() => createDefaultFilters());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [zoom, setZoom] = useState(defaultZoom);
  const [thumbMode, setThumbMode] = useState<"compact" | "grid" | "list">("compact");
  const [showIconLabels, setShowIconLabels] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rescanTimer = useRef<number | null>(null);
  const attemptedThumbnails = useRef<Set<string>>(new Set());
  const deferredFilters = useDeferredValue(filters);

  const applyLibrary = useCallback((next: LibraryResponse) => {
    setLibrary(next);
    setSelectedId((current) => {
      if (current && next.designs.some((design) => design.id === current)) return current;
      return next.designs.find((design) => design.previewPath)?.id ?? next.designs[0]?.id ?? null;
    });
  }, []);

  const runScan = useCallback(
    async (rootPath = library?.rootPath ?? DEFAULT_LIBRARY_PATH) => {
      setLoading(true);
      setError(null);
      try {
        const response = await scanLibrary(rootPath);
        applyLibrary(response);
      } catch (scanError) {
        setError(String(scanError));
      } finally {
        setLoading(false);
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
    if (!library?.rootPath) return;
    let unwatch: (() => void) | null = null;
    let active = true;

    const startWatch = async () => {
      try {
        const unwatchFn = await watch(
          library.rootPath,
          () => {
            if (rescanTimer.current) window.clearTimeout(rescanTimer.current);
            rescanTimer.current = window.setTimeout(async () => {
              try {
                const response = await rescanPaths(library.rootPath, []);
                if (active) applyLibrary(response);
              } catch (watchError) {
                if (active) setError(String(watchError));
              }
            }, 1400);
          },
          { recursive: true, delayMs: 800 },
        );
        unwatch = unwatchFn;
        if (active) setWatching(true);
      } catch (watchError) {
        setWatching(false);
        setError(`No pude activar el watcher: ${String(watchError)}`);
      }
    };

    startWatch();

    return () => {
      active = false;
      setWatching(false);
      if (rescanTimer.current) window.clearTimeout(rescanTimer.current);
      if (unwatch) unwatch();
    };
  }, [applyLibrary, library?.rootPath]);

  const filteredDesigns = useMemo(() => filterDesigns(library?.designs ?? [], deferredFilters), [deferredFilters, library?.designs]);
  const selectedIndex = useMemo(
    () => Math.max(0, filteredDesigns.findIndex((design) => design.id === selectedId)),
    [filteredDesigns, selectedId],
  );
  const selectedDesign = filteredDesigns[selectedIndex] ?? filteredDesigns[0] ?? null;

  const updateDesignLocal = useCallback((designId: string, updater: (design: Design) => Design) => {
    setLibrary((current) => {
      if (!current) return current;
      return {
        ...current,
        designs: current.designs.map((design) => (design.id === designId ? updater(design) : design)),
      };
    });
  }, []);

  const thumbnailCandidates = useMemo(() => {
    const start = Math.max(0, selectedIndex - 8);
    return filteredDesigns
      .slice(start, start + 20)
      .filter((design) => {
        if (!design.previewPath || design.thumbnailPath) return false;
        return !attemptedThumbnails.current.has(`${design.previewPath}:${design.updatedAt}`);
      })
      .slice(0, 10);
  }, [filteredDesigns, selectedIndex]);

  useEffect(() => {
    if (thumbnailCandidates.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const design of thumbnailCandidates) {
          if (cancelled || !design.previewPath) break;
          const key = `${design.previewPath}:${design.updatedAt}`;
          if (attemptedThumbnails.current.has(key)) continue;
          attemptedThumbnails.current.add(key);

          try {
            const thumbnailPath = await generateThumbnail(design.previewPath, design.updatedAt);
            if (!cancelled && thumbnailPath) {
              updateDesignLocal(design.id, (item) => ({ ...item, thumbnailPath }));
            }
          } catch {
            // A broken image should not block navigation or scrolling.
          }

          if (!cancelled) {
            await new Promise((resolve) => window.setTimeout(resolve, 55));
          }
        }
      })();
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [thumbnailCandidates, updateDesignLocal]);

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
    const normalized = category?.trim() || null;
    updateDesignLocal(design.id, (item) => ({
      ...item,
      classification: { ...item.classification, category: normalized, categoryUserSet: true },
    }));
    setLibrary((current) => {
      if (!current || !normalized || current.categories.includes(normalized)) return current;
      return { ...current, categories: [...current.categories, normalized].sort((a, b) => a.localeCompare(b)) };
    });
    try {
      await updateCategory(design.id, normalized);
    } catch (categoryError) {
      setError(String(categoryError));
    }
  }, [updateDesignLocal]);

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

  const chooseRandom = () => {
    const random = chooseRandomDesign(filteredDesigns);
    if (random) setSelectedId(random.id);
  };

  const goToOffset = (offset: number) => {
    if (filteredDesigns.length === 0) return;
    const nextIndex = (selectedIndex + offset + filteredDesigns.length) % filteredDesigns.length;
    setSelectedId(filteredDesigns[nextIndex].id);
  };

  const applyQuickFilter = (filter: QuickFilter) => {
    setFilters((current) => {
      if (filter.kind === "all") return { ...createDefaultFilters(), query: current.query };
      const base = { ...createDefaultFilters(), query: current.query };
      if (filter.kind === "favorite") return { ...base, favoritesOnly: true };
      if (filter.kind === "status") return { ...base, statuses: [filter.status] };
      if (filter.kind === "tag") return { ...base, tags: [filter.tag] };
      return { ...base, categories: [filter.category] };
    });
  };

  const addQuickTag = () => {
    if (!selectedDesign) return;
    const tag = window.prompt("Nueva etiqueta para esta estampa");
    if (tag) addTagToDesign(selectedDesign, tag);
  };

  const openFolderForDesign = useCallback(async (design: Design) => {
    try {
      await openDesignFolder(design.directory);
    } catch (openError) {
      setError(String(openError));
    }
  }, []);

  const revealFileForDesign = useCallback(async (design: Design) => {
    const filePath = design.previewPath ?? design.files[0]?.path;
    if (!filePath) {
      setError("Esta estampa no tiene archivo para mostrar.");
      return;
    }

    try {
      await revealDesignFile(filePath);
    } catch (openError) {
      setError(String(openError));
    }
  }, []);

  return (
    <main className="visual-shell">
      <Header
        library={library}
        filters={filters}
        setFilters={setFilters}
        selectedDesign={selectedDesign}
        loading={loading}
        onQuickFilter={applyQuickFilter}
        onAddTag={addQuickTag}
        onChooseFolder={chooseFolder}
        onRunScan={() => runScan()}
        onFavorite={setFavorite}
        showIconLabels={showIconLabels}
        setShowIconLabels={setShowIconLabels}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
      />

      {error && (
        <div className="error-strip">
          <span>{error}</span>
          <button onClick={() => setError(null)} title="Cerrar">
            <X size={16} />
          </button>
        </div>
      )}

      <section className="visual-workspace">
        <LeftFilters
          filters={filters}
          library={library}
          allDesigns={library?.designs ?? []}
          filteredCount={filteredDesigns.length}
          watching={watching}
          onQuickFilter={applyQuickFilter}
          onClear={() => setFilters(createDefaultFilters())}
        />

        <Viewer
          design={selectedDesign}
          loading={loading}
        zoom={zoom}
        setZoom={setZoom}
        onPrev={() => goToOffset(-1)}
        onNext={() => goToOffset(1)}
        onOpenFolder={openFolderForDesign}
        onRevealFile={revealFileForDesign}
      />

        <RightRail
          designs={filteredDesigns}
          selectedId={selectedDesign?.id ?? null}
          filters={filters}
          setFilters={setFilters}
          thumbMode={thumbMode}
          setThumbMode={setThumbMode}
          onSelect={setSelectedId}
          onFavorite={setFavorite}
        />
      </section>

      <BottomTray
        design={selectedDesign}
        categories={library?.categories ?? []}
        onOpenFolder={openFolderForDesign}
        onRevealFile={revealFileForDesign}
        onFavorite={setFavorite}
        onStatus={setStatus}
        onCategory={saveCategory}
        onAddTag={addTagToDesign}
        onRemoveTag={removeTagFromDesign}
        showIconLabels={showIconLabels}
      />
    </main>
  );
}

function Header({
  library,
  filters,
  setFilters,
  selectedDesign,
  loading,
  onQuickFilter,
  onAddTag,
  onChooseFolder,
  onRunScan,
  onFavorite,
  showIconLabels,
  setShowIconLabels,
  settingsOpen,
  setSettingsOpen,
}: {
  library: LibraryResponse | null;
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  selectedDesign: Design | null;
  loading: boolean;
  onQuickFilter: (filter: QuickFilter) => void;
  onAddTag: () => void;
  onChooseFolder: () => void;
  onRunScan: () => void;
  onFavorite: (design: Design, favorite: boolean) => void;
  showIconLabels: boolean;
  setShowIconLabels: (show: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}) {
  return (
    <header className="visual-header">
      <section className="logo-area" title={library?.rootPath ?? DEFAULT_LIBRARY_PATH}>
        <div className="rx-logo">
          <Crown size={17} />
          <strong>RXW</strong>
          <span>Visual Library</span>
        </div>
        <div className="brand-word">ROXWANA</div>
      </section>

      <nav className="quick-pills">
        {quickFilters.slice(1, 8).map((filter) => (
          <QuickPill key={filter.id} filter={filter} filters={filters} onClick={() => onQuickFilter(filter)} />
        ))}
        <button className="pill ghost" onClick={onAddTag} disabled={!selectedDesign}>
          <Plus size={16} />
          <span>Agregar etiqueta</span>
        </button>
      </nav>

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
        <div className="settings-menu">
          <button className={settingsOpen ? "icon-only active" : "icon-only"} title="Ajustes" onClick={() => setSettingsOpen(!settingsOpen)}>
            <Settings size={18} />
          </button>
          {settingsOpen && (
            <div className="settings-popover">
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

function QuickPill({ filter, filters, onClick }: { filter: QuickFilter; filters: Filters; onClick: () => void }) {
  const Icon = filter.icon;
  const active =
    (filter.kind === "favorite" && filters.favoritesOnly) ||
    (filter.kind === "status" && filters.statuses.includes(filter.status)) ||
    (filter.kind === "tag" && filters.tags.includes(filter.tag)) ||
    (filter.kind === "category" && filters.categories.includes(filter.category));

  return (
    <button className={active ? "pill active" : "pill"} onClick={onClick}>
      <Icon size={16} />
      <span>{filter.label}</span>
      {filter.kind === "status" && filter.status === "working" && <b>34</b>}
    </button>
  );
}

function LeftFilters({
  filters,
  library,
  allDesigns,
  filteredCount,
  watching,
  onQuickFilter,
  onClear,
}: {
  filters: Filters;
  library: LibraryResponse | null;
  allDesigns: Design[];
  filteredCount: number;
  watching: boolean;
  onQuickFilter: (filter: QuickFilter) => void;
  onClear: () => void;
}) {
  return (
    <aside className="left-panel">
      <div className="panel-head">
        <span>Filtros</span>
        <button onClick={onClear}>
          <Plus size={13} />
          Limpiar
        </button>
      </div>

      <div className="filter-stack">
        {quickFilters.map((filter) => (
          <button key={filter.id} className={isQuickActive(filter, filters) ? "filter-row active" : "filter-row"} onClick={() => onQuickFilter(filter)}>
            <span className="filter-name">
              <filter.icon size={16} />
              {filter.label}
            </span>
            <span>{countForQuickFilter(filter, allDesigns, library?.stats.designs ?? 0)}</span>
          </button>
        ))}
        <button className="filter-row muted">
          <span className="filter-name">
            <Plus size={16} />
            Nueva etiqueta
          </span>
        </button>
      </div>

      <div className="left-status">
        <div className={watching ? "pulse active" : "pulse"} />
        <span>{watching ? "Detectando cambios" : "Watcher inactivo"}</span>
      </div>
      <div className="result-count">{filteredCount.toLocaleString("es-AR")} visibles</div>
      <div className="side-icons">
        <Crown size={18} />
        <Settings size={19} />
        <span />
      </div>
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
  onRevealFile,
}: {
  design: Design | null;
  loading: boolean;
  zoom: number;
  setZoom: (zoom: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenFolder: (design: Design) => void;
  onRevealFile: (design: Design) => void;
}) {
  const preview = design?.previewPath ? convertFileSrc(design.previewPath) : null;
  const previewFile = design?.files.find((file) => file.path === design.previewPath) ?? design?.files[0] ?? null;
  const imageCount = design ? countForExtension(design, ".jpg") + countForExtension(design, ".jpeg") + countForExtension(design, ".png") + countForExtension(design, ".webp") : 0;

  return (
    <section className="viewer-stage">
      <button className="nav-arrow left" onClick={onPrev} disabled={!design} title="Anterior">
        <ChevronLeft size={28} />
      </button>

      <div className="artboard">
        {loading && !design ? (
          <div className="viewer-empty">
            <Loader2 className="spin" size={34} />
            <span>Escaneando biblioteca</span>
          </div>
        ) : preview ? (
          <img src={preview} alt={design?.name ?? "Estampa"} style={{ transform: `scale(${zoom / 100})` }} />
        ) : (
          <div className="viewer-empty">
            <ImageOff size={42} />
            <span>Sin imagen previa</span>
          </div>
        )}

        {design && (
          <div className="viewer-file-overlay">
            <div className="overlay-file-main" title={previewFile?.path ?? design.directory}>
              <FileText size={18} />
              <span>{previewFile?.fileName ?? design.name}</span>
            </div>

            <div className="overlay-assets" aria-label="Archivos de esta estampa">
              <AssetPill label="IMG" value={imageCount} tone="red" />
              <AssetPill label="AI" value={countForExtension(design, ".ai")} tone="gold" />
              <AssetPill label="PSD" value={countForExtension(design, ".psd")} tone="blue" />
              <AssetPill label="EPS" value={countForExtension(design, ".eps")} tone="gold" />
              <AssetPill label="ZIP" value={countForExtension(design, ".zip")} tone="neutral" />
              <AssetPill label="TXT" value={countForExtension(design, ".txt")} tone="neutral" />
            </div>

            <div className="overlay-folder" title={design.directory}>
              <FolderOpen size={17} />
              <span>{design.name}</span>
            </div>

            <button className="overlay-action primary" onClick={() => onOpenFolder(design)}>
              <FolderOpen size={16} />
              Abrir carpeta
            </button>
            <button className="overlay-action" onClick={() => onRevealFile(design)}>
              <Maximize2 size={15} />
              Mostrar archivo
            </button>
          </div>
        )}
      </div>

      <button className="nav-arrow right" onClick={onNext} disabled={!design} title="Siguiente">
        <ChevronRight size={28} />
      </button>

      <div className="zoom-controls">
        <button onClick={() => setZoom(Math.max(40, zoom - 10))} title="Alejar">
          <Minus size={18} />
        </button>
        <strong>{zoom}%</strong>
        <button onClick={() => setZoom(Math.min(200, zoom + 10))} title="Acercar">
          <Plus size={18} />
        </button>
        <button onClick={() => setZoom(defaultZoom)} title="Ajustar">
          <Maximize2 size={17} />
          <span>Ajustar</span>
        </button>
      </div>
    </section>
  );
}

function AssetPill({ label, value, tone }: { label: string; value: number; tone: "red" | "gold" | "blue" | "neutral" }) {
  return (
    <span className={`asset-pill ${tone} ${value > 0 ? "has-files" : ""}`}>
      <b>{label}</b>
      {value}
    </span>
  );
}

function RightRail({
  designs,
  selectedId,
  filters,
  setFilters,
  thumbMode,
  setThumbMode,
  onSelect,
  onFavorite,
}: {
  designs: Design[];
  selectedId: string | null;
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  thumbMode: "compact" | "grid" | "list";
  setThumbMode: (mode: "compact" | "grid" | "list") => void;
  onSelect: (id: string) => void;
  onFavorite: (design: Design, favorite: boolean) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = Math.max(0, designs.findIndex((design) => design.id === selectedId));
  const rowHeight = thumbMode === "grid" ? 112 : thumbMode === "list" ? 76 : 88;
  const virtualizer = useVirtualizer({
    count: designs.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => designs[index]?.id ?? index,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  useEffect(() => {
    if (selectedId && designs.length > 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: "center" });
    }
  }, [designs.length, selectedId, selectedIndex, virtualizer]);

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
                  className="virtual-row"
                  style={{
                    height: virtualItem.size,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <ThumbCard
                    design={design}
                    selected={design.id === selectedId}
                    density={thumbMode}
                    onSelect={onSelect}
                    onFavorite={onFavorite}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

const ThumbCard = memo(function ThumbCard({
  design,
  selected,
  density,
  onSelect,
  onFavorite,
}: {
  design: Design;
  selected: boolean;
  density: "compact" | "grid" | "list";
  onSelect: (id: string) => void;
  onFavorite: (design: Design, favorite: boolean) => void;
}) {
  const source = design.thumbnailPath ? convertFileSrc(design.thumbnailPath) : null;
  const previewFile = design.files.find((file) => file.path === design.previewPath);

  return (
    <article className={selected ? `thumb-card ${density} selected` : `thumb-card ${density}`} onClick={() => onSelect(design.id)}>
      <button
        className={design.classification.favorite ? "heart-button active" : "heart-button"}
        onClick={(event) => {
          event.stopPropagation();
          onFavorite(design, !design.classification.favorite);
        }}
        title="Favorita"
      >
        <Heart size={17} fill={design.classification.favorite ? "currentColor" : "none"} />
      </button>
      <div className="thumb-image">
        {source ? (
          <img src={source} alt={design.name} loading="lazy" decoding="async" />
        ) : (
          <div className="thumb-fallback">IMG</div>
        )}
      </div>
      <div className="thumb-meta">
        <span>{previewFile?.fileName ?? design.name}</span>
        <small>{previewFile ? formatBytes(previewFile.size) : `${design.totalFiles} arch.`}</small>
      </div>
    </article>
  );
});

function BottomTray({
  design,
  categories,
  onOpenFolder,
  onRevealFile,
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
  onRevealFile: (design: Design) => void;
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

        <div className="extension-metrics" title="Archivos de esta estampa">
          <IconMetric icon={FileImage} label="Imagenes" value={imageCount} showLabel={showIconLabels} tone="red" />
          <IconMetric icon={PenTool} label="Illustrator" value={countForExtension(design, ".ai")} showLabel={showIconLabels} tone="gold" />
          <IconMetric icon={Layers} label="Photoshop" value={countForExtension(design, ".psd")} showLabel={showIconLabels} tone="blue" />
          <IconMetric icon={FileArchive} label="ZIP" value={countForExtension(design, ".zip")} showLabel={showIconLabels} tone="neutral" />
          <IconMetric icon={Type} label="TXT" value={countForExtension(design, ".txt")} showLabel={showIconLabels} tone="neutral" />
        </div>

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
        <button className="tray-action subtle" onClick={() => onRevealFile(design)} title="Mostrar archivo">
          <Maximize2 size={15} />
          {showIconLabels && <span>Mostrar archivo</span>}
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
  icon: Icon,
  label,
  value,
  showLabel,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  showLabel: boolean;
  tone: "red" | "gold" | "blue" | "neutral";
}) {
  return (
    <span className={`metric metric-${tone}`} title={`${label}: ${value.toLocaleString("es-AR")}`}>
      <b>
        <Icon size={15} />
      </b>
      {showLabel && <em>{label}</em>}
      {value.toLocaleString("es-AR")}
    </span>
  );
}

function isQuickActive(filter: QuickFilter, filters: Filters) {
  if (filter.kind === "all") {
    return !filters.favoritesOnly && filters.statuses.length === 0 && filters.categories.length === 0 && filters.tags.length === 0;
  }
  if (filter.kind === "favorite") return filters.favoritesOnly;
  if (filter.kind === "status") return filters.statuses.includes(filter.status);
  if (filter.kind === "tag") return filters.tags.includes(filter.tag);
  return filters.categories.includes(filter.category);
}

function countForQuickFilter(filter: QuickFilter, designs: Design[], total: number) {
  if (filter.kind === "all") return total;
  if (filter.kind === "favorite") return designs.filter((design) => design.classification.favorite).length;
  if (filter.kind === "status") return designs.filter((design) => design.classification.status === filter.status).length;
  if (filter.kind === "tag") return designs.filter((design) => design.classification.tags.includes(filter.tag)).length;
  return designs.filter((design) => design.classification.category === filter.category).length;
}
