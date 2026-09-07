# Contributing to Termscape

This file is for whoever builds the package. If you are here to *run* it, the
[README](README.md) is the whole story.

## From a clone

```bash
git clone https://github.com/kdonev/termscape.git
cd termscape
npm install
npm run build
npm run dev           # hub with the built UI
```

`npm run dev` takes the hub's own flags after a `--`, because npm reads them
itself otherwise: `npm run dev -- --listen lan`.

If `npm install` or `npm ci` tries to compile `better-sqlite3` and fails for
want of a C++ toolchain, install this way instead:

```bash
npm ci --ignore-scripts && npm rebuild node-pty
```

Any install that reads `package-lock.json` misses better-sqlite3's
`gypfile: false` and runs `node-gyp` on a module that already ships working
prebuilds. Skipping install scripts avoids that; the rebuild puts back the one
native build that is real, which is a no-op except on Linux. This is what CI
does. It does not affect anyone installing the published package.

## Tests and typecheck

```bash
npm test              # unit + integration, no LLM required
npm run typecheck
npm run dev:web       # vite dev server, expects a hub on :7777
```

The integration tests spawn real PTYs and drive the real MCP endpoint, so
`npm test` genuinely exercises message delivery and cross-host routing.

## Known quirks

- On Windows, node-pty prints `AttachConsole failed` to stderr when killing a
  PTY from a process with no console attached (notably under the test runner).
  It is noise from a helper process and does not affect behaviour.

## Releasing

The repo is a workspace of three private packages; what gets published is a
single package assembled by `packages/hub/scripts/pack-npm.mjs` — the hub,
the built UI it serves, and `@termscape/protocol` bundled inside it.

```bash
npm run pack:npm      # build everything, then stage and pack the tarball
```

Tagging `v<version>` runs `.github/workflows/release.yml`, which refuses a
tag that disagrees with `packages/hub/package.json`, installs the packed
tarball on macOS, Windows and Linux and checks each one starts and serves the
canvas, and only then publishes to npm with provenance.

Bump the version in `packages/hub/package.json` **and** `HUB_VERSION` in
`packages/hub/src/hub.ts` together: peer compatibility is gated on the
constant, so a hub that bumped only the manifest refuses to talk to hubs of
its own version — and it would only show on a second machine, which is exactly
where nobody tests. `packages/hub/test/version.test.ts` fails when the two
drift, and it runs before the tag check does.
