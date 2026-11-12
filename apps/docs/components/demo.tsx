"use client";

import type { Player } from "asciinema-player";
import { Check, Clipboard, FolderGit2, GitBranch, Pause, Play, RotateCcw } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import recordings from "../lib/demos.generated.json";
import { asset } from "../lib/site.mjs";

type DemoId = keyof typeof recordings.demos;
type Size = "compact" | "wide";
type Checkout = { name: string; status: string; pending?: boolean };
type Chapter = {
  time: number;
  seek: number;
  title: string;
  description: string;
  command: string;
  lines: string[];
};

const titles: Record<DemoId, string> = {
  create: "Create a worktree",
  parallel: "Create two worktrees",
  handoff: "Hand off local changes",
  cleanup: "Remove a worktree safely",
};

const main = { name: "main/", status: "Current checkout" };
const search = { name: "feature-search/", status: "Modified" };
const api = { name: "feature-api/", status: "API agent" };
const ui = { name: "feature-ui/", status: "UI agent" };
const review = { name: "review-ui/", status: "Clean" };

const scenes: Record<DemoId, Checkout[][]> = {
  create: [
    [main],
    [main, { name: "feature-search/", status: "Planned", pending: true }],
    [main, { name: "feature-search/", status: "Setup complete" }],
    [main, { name: "feature-search/", status: "Clean" }],
  ],
  parallel: [
    [main, api],
    [main, api, ui],
    [main, api, ui],
  ],
  handoff: [
    [search],
    [search, { name: "feature-review/", status: "Changes copied" }],
    [search, { name: "feature-review/", status: "Modified" }],
  ],
  cleanup: [[search, review], [search, review], [search]],
};

export function Demo({ id, hero = false }: { id: DemoId; hero?: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const terminal = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const generation = useRef(0);
  const [size, setSize] = useState<Size>("compact");
  const [chapterIndex, setChapterIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const { chapters, file } = recordings.demos[id][size];
  const chapter = chapters[chapterIndex] ?? chapters[0];
  const poster = recordings.demos[id].wide.chapters[0];

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      const next = (entry?.contentRect.width ?? 0) >= 730 ? "wide" : "compact";
      if (next === size) return;
      player.current?.dispose();
      player.current = null;
      generation.current += 1;
      setSize(next);
      setLoaded(false);
      setPlaying(false);
      setEnded(false);
      setBusy(false);
      setChapterIndex(0);
    });
    const visibility = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) void player.current?.pause();
    });
    resize.observe(element);
    visibility.observe(element);
    return () => {
      resize.disconnect();
      visibility.disconnect();
    };
  }, [size]);

  useEffect(() => {
    return () => {
      generation.current += 1;
      player.current?.dispose();
      player.current = null;
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    function follow() {
      const time = player.current?.getCurrentTime() ?? 0;
      const index = chapters.findLastIndex((step) => step.time <= time);
      if (index >= 0) setChapterIndex(index);
      frame = requestAnimationFrame(follow);
    }
    follow();
    return () => cancelAnimationFrame(frame);
  }, [playing, chapters]);

  async function withPlayer(action: (instance: Player) => Promise<unknown>) {
    if (busy) return;
    const request = generation.current;
    setBusy(true);
    setError(false);
    try {
      if (!player.current) {
        const [{ create }, response] = await Promise.all([
          import("asciinema-player"),
          fetch(asset(`/demos/${file}`)),
        ]);
        if (!response.ok) throw new Error("Recording unavailable.");
        const data = await response.text();
        if (request !== generation.current || !terminal.current) return;
        const instance = create({ data }, terminal.current, {
          controls: false,
          fit: "width",
          cursorMode: "steady",
          terminalFontFamily: "var(--font-geist-mono), monospace",
          terminalLineHeight: 1.35,
          theme: "asciinema",
        });
        instance.addEventListener("playing", () => {
          setPlaying(true);
          setEnded(false);
        });
        instance.addEventListener("pause", () => setPlaying(false));
        instance.addEventListener("ended", () => {
          setPlaying(false);
          setEnded(true);
          setChapterIndex(chapters.length - 1);
        });
        player.current = instance;
      }
      await action(player.current);
      if (request === generation.current) setLoaded(true);
    } catch {
      if (request !== generation.current) return;
      player.current?.dispose();
      player.current = null;
      setLoaded(false);
      setPlaying(false);
      setError(true);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  function seek(index: number) {
    const step = chapters[index];
    if (!step) return;
    void withPlayer(async (instance) => {
      await instance.pause();
      await instance.seek(step.seek);
      setChapterIndex(index);
      setEnded(false);
    });
  }

  if (!chapter || !poster) return null;

  return (
    <section className={`demo${hero ? " demo-hero" : ""}`} aria-label={titles[id]} ref={surface}>
      <div className="terminal-frame">
        <div className="terminal-header">
          <span className="terminal-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{titles[id]}</span>
          <span className="terminal-tag">wald CLI</span>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users can scroll the terminal horizontally. */}
        <section className="terminal-window" aria-label="Terminal recording" tabIndex={0}>
          {!loaded && <Poster chapter={poster} />}
          <div
            ref={terminal}
            aria-hidden={!loaded}
            className={loaded ? "terminal-player" : "terminal-player hidden-player"}
          />
        </section>
        <div className="terminal-controls">
          <button
            type="button"
            className="play-button"
            disabled={busy}
            onClick={() =>
              void withPlayer(async (instance) => {
                if (playing) {
                  await instance.pause();
                  return;
                }
                if (ended) {
                  await instance.seek(0);
                  setChapterIndex(0);
                }
                await instance.play();
              })
            }
          >
            {playing ? <Pause size={16} /> : ended ? <RotateCcw size={16} /> : <Play size={16} />}
            {playing ? "Pause" : ended ? "Replay" : "Play demo"}
          </button>
          <span aria-hidden="true" className="terminal-step">
            {chapterIndex + 1} / {chapters.length}
          </span>
          <span className="terminal-control-label">Recorded CLI session</span>
        </div>
      </div>

      {error && (
        <p role="status" className="demo-error">
          The recording could not load. Try again or read the transcript below.
        </p>
      )}

      <div className="demo-caption">
        <fieldset className="demo-steps">
          <legend className="sr-only">Recording chapters</legend>
          {chapters.map((step, index) => (
            <button
              type="button"
              key={step.title}
              className="demo-step"
              aria-pressed={index === chapterIndex}
              disabled={busy}
              onClick={() => seek(index)}
            >
              {step.title}
            </button>
          ))}
        </fieldset>
        <p>{chapter.description}</p>
      </div>

      {!hero && (
        <WorkspaceMap
          checkouts={scenes[id][chapterIndex] ?? scenes[id][0] ?? []}
          rootLabel={
            id === "cleanup" && chapterIndex === 2
              ? "Git repository · review/ui branch kept"
              : "Shared Git repository"
          }
        />
      )}

      <details className="demo-transcript">
        <summary>Read transcript</summary>
        {recordings.demos[id].wide.chapters.map((step) => (
          <div key={step.title} className="transcript-chapter">
            <strong>{step.title}</strong>
            <p>{step.description}</p>
            <pre>{(step.command ? `❯ ${step.command}\n\n` : "") + step.lines.join("\n")}</pre>
          </div>
        ))}
        <p className="transcript-note">Selected CLI output. Example paths use /demo/canopy.</p>
      </details>
    </section>
  );
}

function Poster({ chapter }: { chapter: Chapter }) {
  return (
    <div className="terminal-poster">
      <div className="poster-prompt">
        <span>❯</span> {chapter.command}
      </div>
      {chapter.lines.map((line) => (
        <div
          key={line}
          className={line.includes("●") || line.includes("🌲") ? "poster-active" : undefined}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

export function WorkspaceMap({
  checkouts,
  rootLabel = "Shared Git repository",
}: {
  checkouts: Checkout[];
  rootLabel?: string;
}) {
  const reducedMotion = useReducedMotion();
  const transition = { duration: reducedMotion ? 0 : 0.27, ease: "easeOut" as const };
  return (
    <div className="workspace-map">
      <div className="workspace-folders">
        <AnimatePresence initial={false}>
          {checkouts.map((checkout) => (
            <motion.div
              layout={reducedMotion ? false : "position"}
              initial={{ opacity: 0, y: reducedMotion ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transition}
              className={`workspace-folder${checkout.pending ? " pending" : ""}`}
              key={checkout.name}
            >
              <FolderGit2 size={18} aria-hidden="true" />
              <code>{checkout.name}</code>
              <span>{checkout.status}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <div className="workspace-root">
        <GitBranch size={16} aria-hidden="true" /> {rootLabel}
      </div>
    </div>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-command"
      title="Copy command"
      aria-label={copied ? "Command copied" : "Copy command"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(command);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check size={16} /> : <Clipboard size={16} />}
    </button>
  );
}
