/**
 * Short unique ids. `crypto.randomUUID` is not available in every environment
 * this runs in (older Safari, the test runner), so fall back to a counter-plus-
 * randomness scheme that is still collision-safe within a session.
 */
let counter = 0;

export function newId(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${rand}`;
}
