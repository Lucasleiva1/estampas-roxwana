export type CategoryDropPosition = "before" | "after" | "inside";

export type SidebarNodeKind = "category" | "group";

export interface SidebarNode {
  kind: SidebarNodeKind;
  name: string;
  collapsed: boolean;
  children: string[];
}

export interface SidebarDragSource {
  kind: SidebarNodeKind;
  name: string;
}

function sameCategory(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function cloneLayout(layout: SidebarNode[]) {
  return layout.map((node) => ({ ...node, children: [...node.children] }));
}

export function categoryNode(name: string): SidebarNode {
  return { kind: "category", name, collapsed: false, children: [] };
}

export function sidebarFromCategories(categories: string[]) {
  return categories.map(categoryNode);
}

export function flattenSidebar(layout: SidebarNode[]) {
  return layout.flatMap((node) => (node.kind === "group" ? node.children : [node.name]));
}

export function groupOf(layout: SidebarNode[], category: string) {
  return layout.find(
    (node) => node.kind === "group" && node.children.some((child) => sameCategory(child, category)),
  )?.name ?? null;
}

export function renameInSidebar(layout: SidebarNode[], currentName: string, newName: string) {
  return layout.map((node) => ({
    ...node,
    name: node.kind === "category" && sameCategory(node.name, currentName) ? newName : node.name,
    children: node.children.map((child) => (sameCategory(child, currentName) ? newName : child)),
  }));
}

export function removeCategoryFromSidebar(layout: SidebarNode[], category: string) {
  return layout
    .filter((node) => node.kind === "group" || !sameCategory(node.name, category))
    .map((node) => ({
      ...node,
      children: node.children.filter((child) => !sameCategory(child, category)),
    }));
}

// Deleting a group keeps its categories: they take the spot the group had.
export function removeGroupFromSidebar(layout: SidebarNode[], group: string) {
  return layout.flatMap((node) =>
    node.kind === "group" && sameCategory(node.name, group)
      ? node.children.map(categoryNode)
      : [node],
  );
}

/**
 * Moves a category or a group inside the panel. A category can land between the
 * loose rows, inside a group, or between the categories a group already holds.
 * A group always stays at the top level: it never goes inside another group.
 */
export function moveSidebarNode(
  layout: SidebarNode[],
  source: SidebarDragSource,
  target: SidebarDragSource,
  position: CategoryDropPosition,
): SidebarNode[] {
  if (source.kind === target.kind && sameCategory(source.name, target.name)) return layout;

  const next = cloneLayout(layout);
  let moving: SidebarNode | null = null;

  if (source.kind === "group") {
    const index = next.findIndex((node) => node.kind === "group" && sameCategory(node.name, source.name));
    if (index < 0) return layout;
    moving = next.splice(index, 1)[0];
  } else {
    const rootIndex = next.findIndex((node) => node.kind === "category" && sameCategory(node.name, source.name));
    if (rootIndex >= 0) {
      moving = next.splice(rootIndex, 1)[0];
    } else {
      for (const node of next) {
        if (node.kind !== "group") continue;
        const childIndex = node.children.findIndex((child) => sameCategory(child, source.name));
        if (childIndex < 0) continue;
        moving = categoryNode(node.children.splice(childIndex, 1)[0]);
        break;
      }
    }
  }
  if (!moving) return layout;

  const goesInside = position === "inside" && source.kind === "category" && target.kind === "group";
  const sidePosition = position === "inside" ? "after" : position;

  if (goesInside) {
    const group = next.find((node) => node.kind === "group" && sameCategory(node.name, target.name));
    if (!group) return layout;
    group.children.push(moving.name);
    // Si estaba plegado se abre, asi se ve entrar la categoria.
    group.collapsed = false;
    return next;
  }

  if (target.kind === "group") {
    const index = next.findIndex((node) => node.kind === "group" && sameCategory(node.name, target.name));
    if (index < 0) return layout;
    next.splice(sidePosition === "after" ? index + 1 : index, 0, moving);
    return next;
  }

  const rootIndex = next.findIndex((node) => node.kind === "category" && sameCategory(node.name, target.name));
  if (rootIndex >= 0) {
    next.splice(sidePosition === "after" ? rootIndex + 1 : rootIndex, 0, moving);
    return next;
  }

  for (let index = 0; index < next.length; index += 1) {
    const node = next[index];
    if (node.kind !== "group") continue;
    const childIndex = node.children.findIndex((child) => sameCategory(child, target.name));
    if (childIndex < 0) continue;
    if (source.kind === "group") {
      next.splice(sidePosition === "after" ? index + 1 : index, 0, moving);
    } else {
      node.children.splice(sidePosition === "after" ? childIndex + 1 : childIndex, 0, moving.name);
    }
    return next;
  }

  return layout;
}
