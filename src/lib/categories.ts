export type CategoryDropPosition = "before" | "after";

function sameCategory(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

export function reorderCategoryList(
  categories: string[],
  source: string,
  target: string,
  position: CategoryDropPosition,
) {
  if (sameCategory(source, target) || !categories.some((category) => sameCategory(category, source))) return categories;

  const nextOrder = categories.filter((category) => !sameCategory(category, source));
  const targetIndex = nextOrder.findIndex((category) => sameCategory(category, target));
  if (targetIndex < 0) return categories;

  nextOrder.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, source);
  return nextOrder;
}
