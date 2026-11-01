import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store.js';
import { agentsOn, startableAgent } from '../state/agents.js';
import { Dialog } from '../dialog/Dialog.js';
import { commandEntries, rank, startEntries, type PaletteEntry } from './commands.js';

/**
 * The command palette (issue 52).
 *
 * Two lists in one: every window, under the address on its title bar, and
 * every command that is worth picking from a list. That pairing is the point
 * - "where is that agent" and "what was that key" are the same question when
 * the canvas is bigger than the screen, and answering both from one box means
 * the keymap never has to grow a chord for everything.
 *
 * Rendered by the canvas rather than through `openDialog`, because picking an
 * entry runs one of the canvas's own commands. It still uses the shared
 * Dialog shell, so Escape, the backdrop, the focus trap and returning focus
 * afterwards all behave like every other dialog.
 */
export function Palette({
  isMac,
  onPick,
  onClose,
}: {
  isMac: boolean;
  onPick: (entry: PaletteEntry) => void;
  onClose: () => void;
}) {
  // Read here rather than passed down: the palette is mounted only while it
  // is open, so subscribing to half the store costs nothing the rest of the
  // time, and the canvas has no business knowing about templates.
  const { sessions, selectedId, workspaces, templates, profiles, hostProfiles } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      selectedId: s.selectedId,
      workspaces: s.workspaces,
      templates: s.templates,
      profiles: s.profiles,
      hostProfiles: s.hostProfiles,
    })),
  );
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo((): PaletteEntry[] => {
    const windows = sessions.map((s): PaletteEntry => {
      // The program's own title when it set one, exactly as the title bar
      // chooses it, so the list reads the way the canvas looks.
      const title = s.title || s.address;
      return {
        kind: 'session',
        id: s.id,
        title,
        // The address is how you message a window, so it stays visible even
        // when a title has taken the main line.
        hint: title === s.address ? '' : s.address,
      };
    });
    /*
     * Every workspace crossed with every template it could start.
     *
     * The join is per workspace because a template names an agent and each
     * machine has its own PATH: `claude` may be installed here and missing on
     * the peer holding the next workspace, and offering it there would fail
     * inside a fresh window where the error reads like the hub is broken.
     */
    const starts = startEntries(
      workspaces.map((w) => {
        const agents = agentsOn(w.hostId ?? null, profiles, hostProfiles);
        return {
          workspace: { id: w.id, name: w.name },
          templates: templates.filter((t) => !t.error && startableAgent(t, agents)),
        };
      }),
    );

    // Windows first: on a canvas with agents running, "go there" is what the
    // palette is opened for far more often than "run that". Starting a new
    // one comes last, because it is the longest list and the rarest want.
    return [...windows, ...commandEntries(isMac ? 'Cmd' : 'Ctrl'), ...starts];
  }, [sessions, isMac, workspaces, templates, profiles, hostProfiles]);

  // Both lines are searchable - an agent found by its address and one found
  // by what it is currently doing are equally worth finding.
  const hits = useMemo(
    () => rank(entries, query, (e) => (e.hint ? `${e.title} ${e.hint}` : e.title)),
    [entries, query],
  );

  // Typing moves the cursor back to the top: after a keystroke the old
  // position means nothing, and leaving it where it was is how you press
  // Enter on something you did not read.
  useEffect(() => setAt(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('.palette-row.on')?.scrollIntoView({ block: 'nearest' });
  }, [at, hits]);

  const pick = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    // Shut first: a command that opens another dialog - new agent, the
    // shortcut sheet - must not find this one still up.
    onClose();
    onPick(entry);
  };

  return (
    <Dialog title="Go to, or run" onClose={onClose}>
      <div className="dialog-body palette">
        <input
          className="input"
          placeholder="an agent, or a command"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl+N/P alongside the arrows: the people this is for spend
            // all day in terminals, where that is how a list is walked.
            const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
            const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
            if (down || up) {
              e.preventDefault();
              if (hits.length === 0) return;
              // Wraps, because a list you can run off the end of makes you
              // look at the cursor instead of at the list.
              setAt((i) => (i + (down ? 1 : -1) + hits.length) % hits.length);
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              pick(hits[at]?.item);
            }
          }}
        />

        <div className="palette-list" ref={listRef}>
          {hits.length === 0 && <div className="palette-empty">Nothing matches</div>}
          {hits.map(({ item, indices }, i) => (
            <div
              key={keyOf(item)}
              className={`palette-row${i === at ? ' on' : ''}`}
              // Enter and a click have to mean the same thing, and the mouse
              // is often how someone finds out the palette exists.
              onPointerDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
              onPointerEnter={() => setAt(i)}
            >
              <span className="palette-kind">
                {item.kind === 'session'
                  ? item.id === selectedId
                    ? '◉'
                    : '○'
                  : item.kind === 'start'
                    ? '+'
                    : '›'}
              </span>
              <span className="palette-title">
                <Marked text={item.title} indices={indices} />
              </span>
              {item.hint && <span className="palette-hint">{item.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/** Stable per row, and distinct across the three kinds. */
function keyOf(item: PaletteEntry): string {
  switch (item.kind) {
    case 'session':
      return `s:${item.id}`;
    case 'command':
      return `c:${item.action}`;
    case 'start':
      return `n:${item.workspaceId}:${item.profile}`;
  }
}

/**
 * The title with the matched characters picked out.
 *
 * `indices` are into the searched text, which is the title and the hint
 * joined; anything past the title belongs to the hint and is simply not
 * marked here rather than being clamped onto the last character.
 */
function Marked({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const hit = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        hit.has(i) ? (
          <b key={i} className="palette-hit">
            {ch}
          </b>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}
