# Review remediation converges by checked root cause

Current status: superseded. The append-only finding ledger and blocking-burden repair loop are gone. Release review still classifies guard findings as `must_fix` or `advisory`; it does not persist a ledger.

Hanoon records independently verified review root causes in an append-only finding ledger and continues repair only while the number of open confirmed `must_fix` root causes decreases, apart from one bounded recovery. Advisory findings do not block. A final fresh two-axis review must pass on the exact remote head. This preserves independent review without rerunning every expensive gate after every repair or allowing repeated reviewer wording to create an unbounded loop.
