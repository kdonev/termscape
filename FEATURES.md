# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

One, and it is a cut rather than something to build: the README has quietly
split into two audiences, and the half that speaks to whoever builds the
package is on the first page every visitor sees.

---

## 1. The README is for users, not its builders

**What it is.** `README.md` already opens as a tool for its users — what the
canvas is, how to start it, how the pieces fit, how to add a machine — and
then, about a third of the way down, it turns into a file for whoever builds
the package: native-module rebuild commands, `npm run pack:npm`, release
tagging. The main README is the first page of the GitHub repository, so
everything in it is shown to *every* visitor, most of whom are deciding whether
to run the tool, not how to build it. The development half should not be there;
the user half is the whole file.

**How it behaves.**

- **Users read it and know what the tool is for and how to run it.** The top
  half already does this — intro, `npx @kdonev/termscape`, the panel, shortcuts,
  requirements. That is the model for the whole file. It stays, maybe tightened,
  never shrinks the *what it is* question.
- **No implementation details on the main page.** Nothing about `node-gyp`,
  `--ignore-scripts`, workspace scripts, `HUB_VERSION`, `pack:npm`, or the
  release workflow belongs where a reader on the GitHub main page will see it.
  That is CI's concern and the maintainer's, not a user's, and a user reading
  the page should never be handed a fix for a build that only matters to the
  authors.
- **Where the build notes go.** The `Development`, `Known quirks` and
  `Releasing` sections are worth keeping — they are real and hard-won — but not
  on the main page. Options, argued in the file rather than chosen: a
  `CONTRIBUTING.md` (the conventional home for "from a clone" setup), or a
  shallow `docs/development.md` linked once from the README. Releasing moves
  into the release workflow or `CONTRIBUTING` too.
- **Getting started, requirements and the panel stay exactly where they are.**
  They are the answer to "what is the tool for and how do I use it," which is
  the entire job of this file — no restructuring to invent, just a cut.

**Where it lives.**

- `README.md`, `"## Development"` (`:391`) through the end of `"### Releasing"`
  (`:431`–`:447`) — the block that speaks to a builder. This is what moves off
  the main page. `"### Known quirks"` (`:425`) sits inside it and goes too.
- `README.md` `:1`–`:390` — everything above it is already user-faced; the
  entry's constraint is that the cut does not touch it. It has grown since this
  entry was written, because the agent-profile section now documents how each
  CLI reaches the hub, which is squarely a user's question.
- `README.md` `:449` — `## License` stays, and is what should follow the cut.
- `.github/workflows/release.yml` — already the home of the release process;
  the human-language description of it moves to the same place.
