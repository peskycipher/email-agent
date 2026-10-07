# Run records are immutable; gate evidence is scanned, not accumulated

The expansion gate needs cumulative pilot evidence (≥500 processed, ≥98% archive
precision, zero no-touch misses, sign-off). A first implementation wrote the
tallies into a mutable `aggregate-metrics.json` ledger updated by every live run
— a read-merge-write race where a lost update could understate miss counts, i.e.
fail open on a safety gate.

We deleted the ledger. Each live run persists its own evidence
(`message_ids`, `archive_attempt_tallies`) in its already-immutable run record,
and the gate computes cumulative evidence by scanning the account's live run
records: unioning processed ids, summing attempts/successes/misses. Dry runs
contribute no evidence; precision of zero total attempts fails closed at `0`.

Consequences: the gate does one directory scan per evaluation (fine for a pilot's
scale — revisit only if run counts grow into the thousands), run records gained
two evidence fields, and evidence can never be silently corrupted by a
concurrent writer.