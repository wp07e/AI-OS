"use client";

import { useEffect, useState } from "react";

/**
 * Mobile breakpoint (px). Below this, the 3-pane shell should switch to its
 * mobile fallback (rail = drawer, agent = slide-over, canvas = full-width).
 * Mobile is deferred for the MVP, but this hook is in place so future
 * mobile-aware layouts can read it without re-architecting.
 *
 * Usage:
 *   const { isMobile } = useBreakpoint();
 *   <div className={isMobile ? "mobile-layout" : "desktop-layout"} />
 */
export function useBreakpoint(breakpoint = 1024): {
  isMobile: boolean;
  width: number;
} {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { isMobile: width < breakpoint, width };
}
