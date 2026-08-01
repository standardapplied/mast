# Architecture Decision Records

One decision record per fix. When a non-obvious choice is made — or a bug fix
turns on a subtlety worth remembering — capture it here as a short, dated ADR so
the *why* survives past the diff.

- Number files sequentially: `NNNN-short-title.md`.
- Keep them short: Context → Decision → Consequences.
- Every record describes the system as it stands. When a decision is reversed and
  the thing it chose is gone from the tree, delete the record with it. A reader
  should never have to work out which of these still apply.
