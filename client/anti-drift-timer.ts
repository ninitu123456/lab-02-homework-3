/** Frame cadence may pause; the absolute deadline never moves with delayed callbacks. */
export function createAntiDriftTimer(durationMs: number, onTick: (remaining: number) => void) {
  if (!Number.isFinite(durationMs)) throw new RangeError('durationMs must be finite');
  const targetTime = Date.now() + Math.max(0, durationMs);
  let rafId: number;
  let active = true;
  function tick() {
    if (!active) return;
    const remaining = Math.max(0, targetTime - Date.now());
    onTick(remaining);
    if (active && remaining > 0) rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
  return () => { active = false; cancelAnimationFrame(rafId); };
}
