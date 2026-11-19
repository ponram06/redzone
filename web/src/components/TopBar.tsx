import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Simple line icons for the menu (24x24, stroke = currentColor). */
const ICONS: Record<string, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5h4v5" />,
  trophy: (
    <path d="M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 20h7M10 17h4v3h-4z" />
  ),
  build: (
    <path d="M9 4h6v3H9zM6 7h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM9.5 12h.01M14.5 12h.01M9.5 15h5M2 11v3M22 11v3" />
  ),
  report: <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6M10 9h2" />,
  help: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2.9-1.2 1.7v.4M12 16.8h.01" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export const NAV = [
  { path: "", label: "Home", icon: "home", hint: "The arena, live" },
  { path: "robots", label: "Leaderboard", icon: "trophy", hint: "Safest robots and best players" },
  { path: "owners", label: "Build a robot", icon: "build", hint: "Add your robot and set a bounty" },
  { path: "report", label: "Report", icon: "report", hint: "How RedZone works, audits, tests" },
  { path: "help", label: "Help", icon: "help", hint: "Questions and answers" },
] as const;

/**
 * The site's top bar: a floating glass strip with the logo, the menu (a highlight slides to the
 * current page), Play now and the account. On phones the menu folds into a full-width panel.
 */
export function TopBar({ page, account }: { page: string; account: ReactNode }) {
  const current = page === "players" ? "robots" : page;
  const nav = useRef<HTMLElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Move the highlight under the current page's link (and keep it there on resize).
  useLayoutEffect(() => {
    const place = () => {
      const el = nav.current?.querySelector<HTMLElement>(`a[data-path="${current}"]`);
      setInd(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    place();
    window.addEventListener("resize", place);
    document.fonts?.ready.then(place).catch(() => {});
    return () => window.removeEventListener("resize", place);
  }, [current]);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  // The phone menu closes on navigation and on Escape, and stops the page scrolling while open.
  useEffect(() => setOpen(false), [page]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = before;
    };
  }, [open]);

  return (
    <header className={`tb ${scrolled ? "scrolled" : ""}`}>
      <div className="tb-inner">
        <a className="tb-brand" href="#/" aria-label="RedZone home">
          <span className="tb-logo" aria-hidden="true">
            <span className="tb-logo-core" />
          </span>
          <span className="tb-word">RedZone</span>
          <span className="tb-net">testnet</span>
        </a>

        <nav className="tb-nav" ref={nav} aria-label="Main">
          {ind && <span className="tb-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} aria-hidden="true" />}
          {NAV.map((n) => (
            <a key={n.path} data-path={n.path} href={`#/${n.path}`} className={`tb-link ${current === n.path ? "on" : ""}`} aria-current={current === n.path ? "page" : undefined}>
              <Icon name={n.icon} size={16} />
              {n.label}
            </a>
          ))}
        </nav>

        <div className="tb-end">
          <a className={`tb-play ${page === "play" ? "on" : ""}`} href="#/play" aria-current={page === "play" ? "page" : undefined}>
            <Icon name="play" size={14} />
            <span>Play now</span>
          </a>
          {account}
          <button className="tb-menu-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Close menu" : "Open menu"}>
            <Icon name={open ? "close" : "menu"} size={20} />
          </button>
        </div>
      </div>

      {open && (
        <div className="tb-sheet" role="dialog" aria-label="Menu">
          {NAV.map((n, i) => (
            <a key={n.path} href={`#/${n.path}`} className={`tb-sheet-link ${current === n.path ? "on" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
              <span className="tb-sheet-ico">
                <Icon name={n.icon} size={20} />
              </span>
              <span>
                <b>{n.label}</b>
                <small>{n.hint}</small>
              </span>
            </a>
          ))}
          <a className="btn primary big tb-sheet-play" href="#/play">
            Play now
          </a>
        </div>
      )}
    </header>
  );
}
