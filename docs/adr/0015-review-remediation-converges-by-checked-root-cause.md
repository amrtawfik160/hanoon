# Review remediation converges by checked root cause

Hanoon records independently verified review root causes in an append-only finding ledger and continues repair only while the number of open confirmed `must_fix` root causes decreases, apart from one bounded recovery. Advisory findings do not block. A final fresh two-axis review must pass on the exact remote head. This preserves independent review without rerunning every expensive gate after every repair or allowing repeated reviewer wording to create an unbounded loop.
