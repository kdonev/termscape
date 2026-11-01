import { helpRows } from '../canvas/keymap.js';
import { Dialog } from './Dialog.js';

/**
 * Every shortcut, listed (issue 52).
 *
 * The rows come from keymap.ts rather than being written out here, so the list
 * cannot drift from the keys that actually work - which is the usual fate of a
 * hand-maintained shortcut sheet.
 */
export function ShortcutsDialog() {
  // Spelled the way the keyboard in front of the user is labelled. Cheap to
  // read off the platform here, and the keymap stays free of the question.
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

  return (
    <Dialog title="Keyboard shortcuts">
      <div className="shortcut-sheet">
        {helpRows(mod).map((group) => (
          <section key={group.title}>
            <h4>{group.title}</h4>
            <dl>
              {group.rows.map((row) => (
                <div key={row.keys}>
                  <dt>
                    <kbd>{row.keys}</kbd>
                  </dt>
                  <dd>{row.what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
