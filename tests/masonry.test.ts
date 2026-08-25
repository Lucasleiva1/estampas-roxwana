import { describe, expect, it } from "vitest";
import {
  FALLBACK_ASPECT,
  MAX_ASPECT,
  MIN_ASPECT,
  buildMasonryLayout,
  columnCount,
  columnWidth,
  tileAspect,
} from "../src/lib/masonry";

function source(width: number | null, height: number | null, id = "x") {
  return { id, width, height };
}

describe("forma de cada tarjeta", () => {
  it("respeta la proporcion cuando entra en la banda", () => {
    expect(tileAspect(source(1200, 1579))).toEqual({ aspect: 1579 / 1200, cropped: false });
  });

  it("recorta la imagen demasiado alta hasta el limite", () => {
    expect(tileAspect(source(500, 5000))).toEqual({ aspect: MAX_ASPECT, cropped: true });
  });

  it("recorta la imagen demasiado ancha hasta el limite", () => {
    expect(tileAspect(source(4000, 500))).toEqual({ aspect: MIN_ASPECT, cropped: true });
  });

  it("no depende de los pixeles: dos imagenes de la misma forma miden igual", () => {
    expect(tileAspect(source(4000, 6000)).aspect).toBe(tileAspect(source(200, 300)).aspect);
  });

  it("supone una forma cuando todavia no sabe las medidas", () => {
    expect(tileAspect(source(null, null))).toEqual({ aspect: FALLBACK_ASPECT, cropped: false });
    expect(tileAspect(source(0, 0))).toEqual({ aspect: FALLBACK_ASPECT, cropped: false });
  });

  it("deja enteras las referencias reales de la biblioteca", () => {
    const reales = [
      source(180, 320),
      source(259, 320),
      source(276, 320),
      source(736, 1313),
      source(768, 1086),
      source(1200, 1579),
      source(1200, 2132),
      source(653, 960),
      source(405, 450),
      source(941, 1672),
    ];
    expect(reales.map((item) => tileAspect(item).cropped)).toEqual(reales.map(() => false));
  });
});

describe("columnas", () => {
  it("acomoda la cantidad al ancho disponible", () => {
    expect(columnCount(1000, 220, 13)).toBe(4);
    expect(columnCount(1000, 150, 13)).toBe(6);
    expect(columnCount(1000, 310, 13)).toBe(3);
  });

  it("nunca baja de dos columnas por angosta que este la ventana", () => {
    expect(columnCount(200, 310, 13)).toBe(2);
    expect(columnCount(0, 310, 13)).toBe(2);
  });

  it("suma una columna antes que estirarlas mucho mas alla del tamano pedido", () => {
    // Con 798px de ancho, dos columnas de 310 darian 392 cada una: la imagen se
    // agranda un 26% y se pone borrosa. Prefiere tres de 257.
    expect(columnCount(798, 310, 14)).toBe(3);
    expect(columnCount(798, 220, 14)).toBe(4);
    expect(columnCount(798, 150, 14)).toBe(5);
  });

  it("ninguna columna termina mucho mas ancha de lo pedido", () => {
    for (const target of [150, 220, 310]) {
      for (let container = 400; container <= 2400; container += 37) {
        const columns = columnCount(container, target, 14);
        expect(columnWidth(container, columns, 14)).toBeLessThanOrEqual(target * 1.1 + 0.001);
      }
    }
  });
});

describe("armado de la pared", () => {
  it("cuelga cada tarjeta de la columna mas corta", () => {
    const items = [
      source(100, 200, "alta"),
      source(100, 100, "cuadrada"),
      source(100, 100, "tercera"),
    ];
    const { tiles } = buildMasonryLayout(items, 213, 100, 13);

    expect(tiles[0].left).toBe(0);
    expect(tiles[1].left).toBe(113);
    expect(tiles[2].item.id).toBe("tercera");
    expect(tiles[2].left).toBe(113);
    expect(tiles[2].top).toBe(tiles[1].height + 13);
  });

  it("las columnas suman el ancho completo sin sobrar espacio", () => {
    const { tiles, columns } = buildMasonryLayout([source(100, 100)], 1000, 220, 13);
    const total = tiles[0].width * columns + 13 * (columns - 1);
    expect(Math.round(total)).toBe(1000);
  });

  it("el alto total es el de la columna mas larga, sin el hueco final", () => {
    const { height } = buildMasonryLayout([source(100, 200), source(100, 100)], 213, 100, 13);
    expect(height).toBe(200);
  });

  it("no se cae con la pared vacia", () => {
    expect(buildMasonryLayout([], 1000, 220, 13)).toMatchObject({ tiles: [], height: 0 });
  });
});
