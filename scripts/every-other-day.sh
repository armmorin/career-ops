# Shared run-day for the Career Ops timers. 2026-10-18 is a run day.
# The next run days are two Copenhagen midnights apart.
on_run_day() {
  local day parity
  day=$(TZ=Europe/Copenhagen date +%Y-%m-%d)
  parity=$(python3 -c 'import datetime,sys; start=datetime.date(2026,10,18); day=datetime.date.fromisoformat(sys.argv[1]); print((day-start).days % 2)' "$day")
  [ "$parity" -eq 0 ]
}
