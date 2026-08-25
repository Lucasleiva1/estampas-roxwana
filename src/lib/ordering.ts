/**
 * Orden de la pared de Referencias.
 *
 * En "Todos" las imagenes salen mezcladas, pero la mezcla no puede cambiar cada
 * vez que se abre la aplicacion: se elige una vez por dia y se queda quieta. Asi
 * uno reconoce donde estaban las cosas durante la jornada, y al dia siguiente la
 * pared se siente nueva sin haber tocado nada.
 */

/**
 * Semilla del dia. Cambia a la medianoche local, no a la de UTC, porque el dia
 * que importa es el de quien mira la pantalla.
 *
 * No se guarda en ningun lado: se calcula del reloj, asi que dos aperturas del
 * mismo dia dan el mismo orden sin necesidad de recordar nada.
 */
export function dailySeed(now: Date = new Date()) {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

/**
 * Puesto pseudoaleatorio pero estable de una referencia para una semilla dada.
 * La misma referencia con la misma semilla siempre cae en el mismo lugar.
 */
export function referenceRandomRank(id: string, seed: number) {
  let hash = seed | 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

/** Orden natural de cada vista: mezclado en "Todos", por fecha dentro de una carpeta. */
export function defaultSortFor(category: string) {
  return category === "Todos" ? "random" : "recent";
}
