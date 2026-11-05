import { ChevronRight, House } from "./icons";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

interface Segment {
  label: string;
  path: string;
  home?: boolean;
}

function segmentsFor(path: string, home: string): Segment[] {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) {
    const rest = path.slice(home.length).split("/").filter(Boolean);
    const segments: Segment[] = [{ label: "Home", path: home, home: true }];
    let current = home;
    for (const part of rest) {
      current = `${current}/${part}`;
      segments.push({ label: part, path: current });
    }
    return segments;
  }
  const segments: Segment[] = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current = `${current}/${part}`;
    segments.push({ label: part, path: current });
  }
  return segments;
}

export function PathBar({ path, home, onNavigate }: { path: string; home: string; onNavigate: (path: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);
  const crumbs = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth;
  }, [path, editing]);

  useEffect(() => {
    if (editing) {
      setValue(path);
      requestAnimationFrame(() => input.current?.select());
    }
  }, [editing, path]);

  if (editing) {
    return (
      <input
        ref={input}
        className="path-input"
        value={value}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setEditing(false);
            const target = value.trim();
            if (target && target !== path) onNavigate(target);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
    );
  }

  const segments = path ? segmentsFor(path, home) : [];
  return (
    <div
      ref={crumbs}
      className="path-bar"
      title="Click to type a path"
      onClick={(e) => e.target === e.currentTarget && setEditing(true)}
    >
      {segments.map((segment, i) => (
        <Fragment key={segment.path}>
          {i > 0 && segments[i - 1].label !== "/" && <ChevronRight size={12} className="crumb-sep" />}
          <button
            type="button"
            className={`crumb${i === segments.length - 1 ? " current" : ""}`}
            onClick={() => onNavigate(segment.path)}
          >
            {segment.home && <House size={12} />}
            {segment.label}
          </button>
        </Fragment>
      ))}
      <span className="crumb-fill" onClick={() => setEditing(true)} />
    </div>
  );
}
