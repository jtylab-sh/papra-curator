# Contributing

## Development

Source imports use the `#~/` alias for `src/` (package.json `imports`, resolved
natively by Node, tsc and eslint alike).

The state DB is Prisma over SQLite; `@prisma/client` and its adapter are runtime
dependencies and `prisma generate` is a build step, so nothing runs from a clone
until `npm ci`.

```bash
npm ci
npm test              # generates the Prisma client first, then runs the tests
npm run typecheck
npm run lint          # eslint
npm run format        # prettier
```

Changing `prisma/schema.prisma` means a migration:

```bash
DATABASE_URL="file:./dev.db" npx prisma migrate dev --name what-changed
```

Tests live next to the code they cover (`src/**/*.test.ts`) with shared fixtures
in `src/test-helpers.ts`. No network and no Papra — the outside world is behind
one `Ports` interface, and each test gets its own in-memory database built from
the real migration SQL, so the tests and production cannot drift. They cover the
invariants whose failure costs money or data: no model call while `spend` is
false, no second call for a non-travel document, nothing written by a dry run, no
flight filed for a document the owner did not fly, no unsigned webhook accepted,
no invented tag, no filename that is a path.

## Releases

Every push to `main` releases a version. CI reads the conventional-commit
subjects since the last tag and bumps accordingly:

| Commit                                                      | Bump  |
| ----------------------------------------------------------- | ----- |
| `feat(x)!: …`, or any type with a `BREAKING CHANGE:` footer | major |
| `feat: …`                                                   | minor |
| anything else (`fix`, `docs`, `chore`, …)                   | patch |

While the major is still `0` a breaking change is capped at a minor bump: there
is no compatibility promise to break yet, so nothing reaches `1.0.0` by accident.
Releasing `1.0.0` is a deliberate act — tag it by hand.

It then creates the tag and a GitHub release with generated notes, and publishes
the image as `:MAJOR.MINOR.PATCH`, `:MAJOR.MINOR` and `:latest`. Pin a version in
production; `:latest` moves on every push. Git tags are the source of truth —
`package.json`'s `version` field is not read by anything.
