# Threat model & trust audits

This is the honest version of what Scriptorium can and cannot claim. The framing
matters as much as the code: several "convenient" implementation choices silently
break the security model, and the design refuses them.

## The one invariant

> **The client is never trusted for time or for final document state.**

If any code path ever trusts a client-supplied timestamp or a client-supplied "final
document," that is the exact gap this tool exists to close.

## Resisted

| Threat | How it is defeated |
| --- | --- |
| **Post-hoc document fabrication** — a finished document produced elsewhere, submitted as if composed in-tool. | There is no "submit a file" path. The only document that exists is the one the server reconstructs from the steps it received live. |
| **Forged timestamps / fabricated pacing.** | Timing comes from server **receipt time** (`server_received_at`), stamped when the server accepts a batch — never from the client clock. |
| **Tampering with the stored record after the fact.** | A hash-chained, append-only log. Altering any entry invalidates that entry and every entry after it, detectably (see the tamper test). `UPDATE` on `edit_log` is additionally blocked by a database trigger. |
| **Paste-as-typing.** | A large insertion is surfaced as a discrete, **server-derived** event computed purely from the edit stream — independent of anything the client claims. |

### Receipt, not authorship

The server timestamps *when it saw* an edit. v1 requires connectivity and the client
submits steps **eagerly** (small batches, low latency), so receipt time tracks
authorship closely. Any client-side buffering would clump receipt times and distort
pacing — hence connectivity is required and eager submission is mandatory. Active-time
figures are labeled "receipt-based" everywhere they appear; they are not a claim about
authorship effort.

## NOT resisted — stated plainly

**The retype attack.** A determined student can hand-retype text produced elsewhere and
generate a trace that looks authored. **Scriptorium does not classify this.** Its value
is that authentic composition has a recognizable *shape* — recursive, mid-paragraph
insertions, deletions, reordering, returns to earlier sections — whereas retyping a
finished text tends to be linear, front-to-back, low-revision, steady-cadence. The
replay surfaces the shape; a human reads it. The tool asserts nothing.

This limit is a feature of the framing, not a bug to hide. The tool's most important
output is often **exculpatory**: it gives an honestly-working student who has been
wrongly flagged by an external AI detector positive evidence of how they actually wrote.

## Hard constraints (Non-Goals)

- **No AI score, probability, verdict, or classifier of any kind** — not in an endpoint,
  not in the UI, not as a hidden field. This is enforced by a test
  (`packages/core/test/trust-audit.test.ts`) that fails CI if a verdict-like identifier
  appears in source, and by an HTTP test asserting the evidence payload carries no
  score/probability/verdict/likelihood/cheat field.
- **No LTI 1.3 / Canvas integration** in v1.
- **No offline mode** — v1 requires connectivity.
- **No real-time multi-author collaboration** — every document is single-author; we
  borrow only the collab *authority* pattern.

## Trust audits (Definition of Done §11)

**Trust audit — time.** No server code path treats a client-supplied time as
authoritative. `server_received_at` is set inside `WritingService.submit` from the
server clock at accept time. Any client-asserted annotation lives only in the
explicitly-untrusted `client_meta` field and feeds no timing claim. A test scans source
for a receipt/timing field being assigned from a request/client body.

**Trust audit — no score.** No endpoint, field, or UI element returns or displays a
verdict, probability, classification, or "cheating" flag. The evidence endpoint ships an
explicit disclaimer and surfaces only: server-derived large insertions, receipt-based
active time, and clearly-labeled untrusted client annotations.

## Why identity (M2) is deferred but designed-for

"A student wrote this" presupposes knowing *which* student, so identity is genuinely
in-scope for a complete v1 (build spec §9). It is deferred here because real accounts,
per-student/per-assignment links, and the dashboard are a multi-week build of their
own, and the spec sequences the **integrity invariant** first (M1 is the first hard
deliverable; it hardcodes one author + assignment). The database schema already models
the eventual identity (`users`, `assignments`, `assignment_tokens`, and the unforgeable
`(assignment_id, author_id)` binding on `writing_sessions`), so M2 adds auth and link
issuance without reshaping the record.

## If you change anything here

Per the working conventions, stop and ask a human before: any change that weakens the
append-only or hash-chain guarantee; adding any feature that scores, classifies, ranks,
or flags; or storing a client-asserted time as authoritative.
