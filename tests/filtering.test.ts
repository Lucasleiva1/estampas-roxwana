import { describe, expect, it } from "vitest";
import { classifyExtension } from "../src/lib/fileTypes";
import { UNCATEGORIZED_CATEGORY, chooseRandomDesign, createDefaultFilters, filterDesigns } from "../src/lib/filtering";
import { reorderCategoryList } from "../src/lib/categories";
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

  it("chooses a stable random item when a random function is provided", () => {
    expect(chooseRandomDesign(["a", "b", "c"], () => 0.5)).toBe("b");
    expect(chooseRandomDesign([], () => 0.5)).toBeNull();
  });
});

describe("category ordering", () => {
  it("moves a category before the drop target", () => {
    expect(reorderCategoryList(["Skater", "Calaveras", "Surf"], "Surf", "Skater", "before"))
      .toEqual(["Surf", "Skater", "Calaveras"]);
  });

  it("moves a category after the drop target", () => {
    expect(reorderCategoryList(["Skater", "Calaveras", "Surf"], "Skater", "Surf", "after"))
      .toEqual(["Calaveras", "Surf", "Skater"]);
  });
});
