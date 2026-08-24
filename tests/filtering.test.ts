import { describe, expect, it } from "vitest";
import { classifyExtension } from "../src/lib/fileTypes";
import { UNCATEGORIZED_CATEGORY, chooseRandomDesign, createDefaultFilters, filterDesigns } from "../src/lib/filtering";
import {
  categoryNode,
  flattenSidebar,
  moveSidebarNode,
  removeGroupFromSidebar,
  sidebarFromCategories,
  type SidebarNode,
} from "../src/lib/categories";
import type { Design } from "../src/lib/types";

function design(overrides: Partial<Design>): Design {
  return {
    id: "1",
    name: "Skate skull",
    path: "C:/lib/skate",
    directory: "C:/lib/skate",
    groupType: "folder",
    previewPath: "C:/lib/skate/skate.jpg",
    thumbnailPath: null,
    totalFiles: 2,
    updatedAt: 1,
    counts: { ai: 1, psd: 0, svg: 0, pdf: 0, eps: 0, zip: 0, txt: 0, other: 0 },
    files: [],
    classification: {
      favorite: false,
      status: "pending",
      category: "Skater",
      tags: ["skate", "calavera"],
      categoryUserSet: false,
    },
    autoCategory: "Skaters",
    autoTags: ["skate", "calavera"],
    ...overrides,
  };
}

describe("file type helpers", () => {
  it("classifies preview and support extensions", () => {
    expect(classifyExtension("JPG")).toBe("preview");
    expect(classifyExtension(".psd")).toBe("support");
    expect(classifyExtension(".zip")).toBe("support");
    expect(classifyExtension(".docx")).toBe("other");
  });
});

describe("filtering", () => {
  it("filters by query, category, tags and support files", () => {
    const filters = createDefaultFilters();
    filters.query = "skull";
    filters.categories = ["Skater"];
    filters.tags = ["calavera"];
    filters.support = [".ai"];

    const results = filterDesigns([design({}), design({ id: "2", name: "Surf", counts: { ai: 0, psd: 0, svg: 0, pdf: 0, eps: 0, zip: 0, txt: 0, other: 0 } })], filters);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
  });

  it("filters uncategorized designs through the Sin categoria bucket", () => {
    const filters = createDefaultFilters();
    filters.categories = [UNCATEGORIZED_CATEGORY];

    const results = filterDesigns([
      design({ id: "1", classification: { ...design({}).classification, category: null } }),
      design({ id: "2", classification: { ...design({}).classification, category: "Skater" } }),
    ], filters);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
  });

  it("shows favorites independently of their category", () => {
    const filters = createDefaultFilters();
    filters.favoritesOnly = true;

    const results = filterDesigns([
      design({ id: "1", classification: { ...design({}).classification, favorite: true, category: "Skater" } }),
      design({ id: "2", classification: { ...design({}).classification, favorite: true, category: "Infantil" } }),
      design({ id: "3", classification: { ...design({}).classification, favorite: false, category: "Skater" } }),
    ], filters);

    expect(results.map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("chooses a stable random item when a random function is provided", () => {
    expect(chooseRandomDesign(["a", "b", "c"], () => 0.5)).toBe("b");
    expect(chooseRandomDesign([], () => 0.5)).toBeNull();
  });
});

function group(name: string, children: string[], collapsed = false): SidebarNode {
  return { kind: "group", name, collapsed, children };
}

describe("category panel layout", () => {
  const layout = sidebarFromCategories(["Skater", "Calaveras", "Surf"]);

  it("moves a category before the drop target", () => {
    const next = moveSidebarNode(layout, { kind: "category", name: "Surf" }, { kind: "category", name: "Skater" }, "before");
    expect(flattenSidebar(next)).toEqual(["Surf", "Skater", "Calaveras"]);
  });

  it("moves a category after the drop target", () => {
    const next = moveSidebarNode(layout, { kind: "category", name: "Skater" }, { kind: "category", name: "Surf" }, "after");
    expect(flattenSidebar(next)).toEqual(["Calaveras", "Surf", "Skater"]);
  });

  it("drops a category inside a group", () => {
    const withGroup = [categoryNode("Skater"), group("Verano", ["Surf"]), categoryNode("Calaveras")];
    const next = moveSidebarNode(withGroup, { kind: "category", name: "Calaveras" }, { kind: "group", name: "Verano" }, "inside");
    expect(next).toEqual([categoryNode("Skater"), group("Verano", ["Surf", "Calaveras"])]);
  });

  it("orders the categories a group already holds", () => {
    const withGroup = [group("Verano", ["Surf", "Playa", "Palmeras"])];
    const next = moveSidebarNode(withGroup, { kind: "category", name: "Palmeras" }, { kind: "category", name: "Surf" }, "before");
    expect(next).toEqual([group("Verano", ["Palmeras", "Surf", "Playa"])]);
  });

  it("takes a category out of a group when it lands on a loose one", () => {
    const withGroup = [categoryNode("Skater"), group("Verano", ["Surf", "Playa"])];
    const next = moveSidebarNode(withGroup, { kind: "category", name: "Playa" }, { kind: "category", name: "Skater" }, "before");
    expect(next).toEqual([categoryNode("Playa"), categoryNode("Skater"), group("Verano", ["Surf"])]);
  });

  it("moves a group between the categories without nesting it", () => {
    const withGroup = [categoryNode("Skater"), group("Verano", ["Surf"]), group("Invierno", ["Nieve"])];
    const next = moveSidebarNode(withGroup, { kind: "group", name: "Invierno" }, { kind: "group", name: "Verano" }, "inside");
    expect(next).toEqual([categoryNode("Skater"), group("Verano", ["Surf"]), group("Invierno", ["Nieve"])]);
  });

  it("keeps the categories of a deleted group in its spot", () => {
    const withGroup = [categoryNode("Skater"), group("Verano", ["Surf", "Playa"]), categoryNode("Calaveras")];
    expect(flattenSidebar(removeGroupFromSidebar(withGroup, "Verano")))
      .toEqual(["Skater", "Surf", "Playa", "Calaveras"]);
  });
});
