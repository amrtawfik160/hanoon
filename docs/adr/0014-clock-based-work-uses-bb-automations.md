# Clock-based work uses BB automations

BB is the source of truth for clock-based project and owner automations. Hanoon stores a governed binding to the BB automation and its evidence, but does not run a duplicate cron schedule. Hanoon keeps event monitors for thread and job lifecycle obligations because they are not clock jobs. This split gives Hanoon the full BB automation engine without weakening its authority, credential, evidence, or Telegram contracts, and prevents one task from firing through two schedulers.
