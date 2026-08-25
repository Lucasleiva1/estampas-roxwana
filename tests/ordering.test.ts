import { describe, expect, it } from "vitest";
import { dailySeed, defaultSortFor, referenceRandomRank } from "../src/lib/ordering";

describe("semilla del dia", () => {
  it("es la misma a cualquier hora del mismo dia", () => {
    const manana = new Date(2026, 7, 25, 6, 30, 0);
    const noche = new Date(2026, 7, 25, 23, 59, 59);
    expect(dailySeed(manana)).toBe(dailySeed(noche));
  });

  it("cambia al pasar la medianoche", () => {
    const hoy = new Date(2026, 7, 25, 23, 59, 59);
    const manana = new Date(2026, 7, 26, 0, 0, 1);
    expect(dailySeed(hoy)).not.toBe(dailySeed(manana));
  });

  it("no repite un dia de otro mes ni de otro anio", () => {
    const vistos = new Set<number>();
    for (let mes = 0; mes < 12; mes += 1) {
      for (let dia = 1; dia <= 28; dia += 1) {
        vistos.add(dailySeed(new Date(2026, mes, dia)));
        vistos.add(dailySeed(new Date(2027, mes, dia)));
      }
    }
    expect(vistos.size).toBe(12 * 28 * 2);
  });
});

describe("orden mezclado", () => {
  const ids = Array.from({ length: 60 }, (_, index) => `referencia-${index}`);
  const mezclar = (seed: number) =>
    [...ids].sort((left, right) => referenceRandomRank(left, seed) - referenceRandomRank(right, seed));

  it("el mismo dia devuelve siempre el mismo orden", () => {
    expect(mezclar(20260825)).toEqual(mezclar(20260825));
  });

  it("al dia siguiente el orden cambia", () => {
    expect(mezclar(20260825)).not.toEqual(mezclar(20260826));
  });

  it("mezcla de verdad: no deja casi nada en su posicion original", () => {
    const mezclado = mezclar(20260825);
    const quietos = mezclado.filter((id, posicion) => id === ids[posicion]).length;
    expect(quietos).toBeLessThan(5);
  });

  it("no pierde ni duplica ninguna referencia", () => {
    const mezclado = mezclar(20260825);
    expect(mezclado.length).toBe(ids.length);
    expect(new Set(mezclado).size).toBe(ids.length);
  });
});

describe("orden natural de cada vista", () => {
  it("mezcla en Todos", () => {
    expect(defaultSortFor("Todos")).toBe("random");
  });

  it("ordena por fecha dentro de una carpeta", () => {
    expect(defaultSortFor("che")).toBe("recent");
    expect(defaultSortFor("Che Guevara")).toBe("recent");
  });
});
