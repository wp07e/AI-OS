import { AppShell } from "./_components/AppShell";

/**
 * The AI OS app home. Renders the 3-pane shell (rail + canvas + agent panel).
 * Auth + ready-container gating happens in layout.tsx; this page just mounts
 * the shell.
 */
export default function AppHome() {
  return <AppShell />;
}
