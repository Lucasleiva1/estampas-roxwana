/**
 * Pared tipo Pinterest: columnas de ancho fijo y alturas libres.
 *
 * La forma de cada imagen se respeta tal cual, pero apretada dentro de una
 * banda de proporciones. Sin ese limite, una imagen de 500x5000 se comeria
 * tres pantallas y dejaria la columna colgando; con el, la altura de cualquier
 * tarjeta es siempre un numero acotado y el calculo es una sola cuenta.
 */

/** Lo mas alta que puede ser una tarjeta: el doble de su ancho. */
export const MAX_ASPECT = 2;
/** Lo mas ancha que puede ser una tarjeta: el doble de su alto. */
export const MIN_ASPECT = 0.5;
/** Forma supuesta cuando todavia no sabemos las medidas reales del archivo. */
export const FALLBACK_ASPECT = 1.25;

const MIN_COLUMNS = 2;
/** Cuanto puede estirarse una columna mas alla del tamano pedido. */
const MAX_STRETCH = 1.1;

export interface MasonrySource {
  id: string;
  width: number | null;
  height: number | null;
}

export interface MasonryTile<T> {
  item: T;
  left: number;
  top: number;
  width: number;
  height: number;
  /** La imagen es mas extrema que la banda permitida y se muestra recortada. */
  cropped: boolean;
}

export interface MasonryLayout<T> {
  tiles: MasonryTile<T>[];
  height: number;
  columns: number;
}

/**
 * Proporcion alto/ancho que se le va a dar a la tarjeta, ya apretada dentro de
 * la banda. Devuelve tambien si hubo que recortar para llegar ahi.
 */
export function tileAspect(source: MasonrySource) {
  const { width, height } = source;
  if (!width || !height || width <= 0 || height <= 0) {
    return { aspect: FALLBACK_ASPECT, cropped: false };
  }

  const natural = height / width;
  if (natural > MAX_ASPECT) return { aspect: MAX_ASPECT, cropped: true };
  if (natural < MIN_ASPECT) return { aspect: MIN_ASPECT, cropped: true };
  return { aspect: natural, cropped: false };
}

/** Ancho de cada columna una vez repartido el sobrante entre todas. */
export function columnWidth(containerWidth: number, columns: number, gap: number) {
  return (containerWidth - gap * (columns - 1)) / columns;
}

/**
 * Cuantas columnas entran, buscando acercarse al ancho pedido sin bajar de dos.
 *
 * Las columnas se estiran para llenar el ancho, pero solo hasta cierto punto:
 * estirar una columna muy por encima del tamano pedido agranda la imagen mas
 * de lo que da el archivo y la deja borrosa. Antes de llegar a eso conviene
 * sumar una columna mas y que queden todas un poco mas chicas.
 */
export function columnCount(containerWidth: number, targetWidth: number, gap: number) {
  if (containerWidth <= 0 || targetWidth <= 0) return MIN_COLUMNS;
  let columns = Math.max(MIN_COLUMNS, Math.floor((containerWidth + gap) / (targetWidth + gap)));
  while (columnWidth(containerWidth, columns, gap) > targetWidth * MAX_STRETCH) {
    columns += 1;
  }
  return columns;
}

/**
 * Reparte las tarjetas colgando cada una de la columna que en ese momento esta
 * mas corta, que es lo que produce el borde de abajo desparejo de Pinterest.
 */
export function buildMasonryLayout<T extends MasonrySource>(
  items: T[],
  containerWidth: number,
  targetWidth: number,
  gap: number,
): MasonryLayout<T> {
  const columns = columnCount(containerWidth, targetWidth, gap);
  const width = Math.max(1, columnWidth(containerWidth, columns, gap));
  const heights = new Array<number>(columns).fill(0);
  const tiles: MasonryTile<T>[] = [];

  for (const item of items) {
    let target = 0;
    for (let index = 1; index < columns; index += 1) {
      if (heights[index] < heights[target] - 0.5) target = index;
    }

    const { aspect, cropped } = tileAspect(item);
    const height = Math.round(width * aspect);
    tiles.push({
      item,
      left: target * (width + gap),
      top: heights[target],
      width,
      height,
      cropped,
    });
    heights[target] += height + gap;
  }

  const tallest = heights.reduce((max, value) => Math.max(max, value), 0);
  return { tiles, height: Math.max(0, tallest - gap), columns };
}
