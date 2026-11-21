/** Source of "now". Injected so tests can pin time (e.g. Friday 16:30 London). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can pin and move. */
export function fixedClock(initial: Date): Clock & { set(now: Date): void } {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set: (now: Date) => {
      current = new Date(now);
    },
  };
}
