import { useEffect, useState } from "react";

const DEFAULT_DURATION_MS = 880;

export function useCountUpProgress(
  active: boolean,
  restartKey: string | number = "initial",
  durationMs = DEFAULT_DURATION_MS,
): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setProgress(1);
      return;
    }

    let frame = 0;
    let startedAt: number | null = null;
    setProgress(0);

    const animate = (now: number) => {
      if (startedAt === null) startedAt = now;
      const elapsed = Math.min(1, (now - startedAt) / Math.max(1, durationMs));
      const eased = 1 - Math.pow(1 - elapsed, 4);
      setProgress(eased);
      if (elapsed < 1) frame = window.requestAnimationFrame(animate);
    };

    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [active, durationMs, restartKey]);

  return progress;
}
