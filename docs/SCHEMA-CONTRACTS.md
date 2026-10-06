# Schema contracts: events, profile, sessions, cycles, days, workouts (2026-08-19)

The single source of truth for the file formats added by the NOW+NEXT feature wave. Both the iOS
app (writer) and the MCP server (reader) implement against this document. All additions here are
**additive**: the daily cache stays schema 1, the workouts cache stays a bare array with new
optional keys, and every new file carries its own independent `schema` integer so either side can
version them separately.

House rules that apply to every payload below:
- Dates are `YYYY-MM-DD` local calendar days (same bucketing as the daily cache) unless a field is
  explicitly an ISO 8601 timestamp.
- No em dashes or en dashes in any user-visible string, note, or template.
- Caveats travel IN the payload (an agent or PDF recipient strips surrounding context).
- Absence semantics: a consumer must never read a missing file as "no data recorded"; every reader
  reports present/absent explicitly.

## 1. `health-events.json` (NEW, visible filename)

The one logging surface. Medication starts, habit changes, doctor visits, life events, shift
blocks, episodes, travel: all are event types in this one file. Whole-file replace on every export
(the app owns CRUD; the file is small).

```json
{
  "schema": 1,
  "app": "1.5",
  "writtenAt": "2026-08-19T10:00:00Z",
  "events": [
    {
      "id": "UUID",
      "date": "2026-06-03",
      "endDate": "2026-06-05",
      "type": "medication",
      "title": "Started propranolol 40mg",
      "note": "free text, optional",
      "tags": ["propranolol"]
    }
  ]
}
```

- `type` enum (app UI + server both know it, unknown types must pass through unharmed):
  `medication` | `habit` | `visit` | `life` | `shift` | `episode` | `travel` | `other`.
- `endDate` optional; present = the event covers a closed day range (shift block, trip, episode).
  Absent = a point-in-time boundary (med start, quit date, visit).
- `tags` optional, free strings, used by day-filtered queries.
- Events are sorted by `date` ascending in the file. IDs are stable across exports (edit/delete
  propagate by whole-file replace).

## 2. `health-profile.json` (NEW, visible filename)

Per-field opt-in context the user chose to share with agents. A field the user did not enable is
ABSENT (not null). The reader reports which fields are present and never invents defaults.

```json
{
  "schema": 1,
  "writtenAt": "2026-08-19T10:00:00Z",
  "fields": {
    "conditions": ["..."],
    "medications": ["..."],
    "goals": ["..."],
    "allergies": [".."],
    "notes": "free text"
  }
}
```

Age/sex/height/weight stay OUT of the profile (they are already HealthKit metrics in the cache).
The profile is context that HealthKit cannot hold.

## 3. `health-sessions.json` (NEW, visible filename)

Sleep sessions: the clustered sessions the app already computes for daily attribution (v1.2 sleep
fix), serialized. Sessions are attributed to the WAKING day (`day`), matching the daily cache's
`sleep_analysis` attribution so the two never disagree.

```json
{
  "schema": 1,
  "writtenAt": "...",
  "sessions": [
    {
      "start": "2026-08-18T23:04:00+01:00",
      "end": "2026-08-19T06:52:00+01:00",
      "day": "2026-08-19",
      "hours": 7.8,
      "stages": {"core": 4.1, "deep": 1.2, "rem": 1.9, "awake": 0.6}
    }
  ]
}
```

- Timestamps carry the LOCAL UTC offset at the time of the sample (this is the tz honesty channel
  for sleep; the daily cache cannot carry it).
- `stages` present only when stage data exists; hours are the unioned (not summed) durations.
- Split nights = multiple sessions with the same `day`.

## 4. `health-cycles.json` (NEW, visible filename)

Cycle context from user-logged menstrual flow only (no ovulation estimates; Apple exposes no
public type for its retrospective estimates, and prediction is regulated territory).

```json
{
  "schema": 1,
  "writtenAt": "...",
  "cycleStarts": ["2026-06-02", "2026-06-30", "2026-07-29"]
}
```

The SERVER derives day-in-cycle and coarse phase labels at query time with stated assumptions
(follicular = day 1 to 14 or observed midpoint, luteal = remainder), always labelled as derived
from logged periods, never predictive. The app writes only observed starts.

## 5. `health-days.json` (NEW, visible filename)

Per-day annotations the {d,v} cache cannot hold: the timezone change log. Coverage begins the day
the feature ships (historic tz is unknowable from the cache; the file says so).

```json
{
  "schema": 1,
  "writtenAt": "...",
  "currentTz": "Europe/London",
  "changes": [
    {"from": "2026-08-12", "tz": "America/New_York", "utcOffsetMin": -240}
  ],
  "note": "Timezone history is recorded from 2026-08-19 onward. Days before the first change entry were bucketed in the timezone current at export time."
}
```

- `changes` is a sparse ascending log: each entry says "from this local day onward the device was
  in `tz`". A travel day = any day on which a change lands (day length was not 24h).
- Server exposes `excludeTravelDays` on trend/compare paths using this file.

## 6. Workouts cache: additive keys (`.health-workouts-cache.json` stays a bare array)

Existing keys unchanged: `id,name,activityType,start,end,duration,activeEnergyBurned,
distanceMeters,distanceSource`. New OPTIONAL keys per workout:

- `avgHeartRate`, `maxHeartRate` (bpm)
- `elevationAscendedMeters`
- `runningPowerAvgWatts`, `strideLengthAvgMeters`, `verticalOscillationAvgCm`,
  `groundContactTimeAvgMs` (running dynamics, when present)
- `cyclingPowerAvgWatts`, `cadenceAvg`
- `intervals`: `[{start, end, duration, kind}]` from HKWorkoutEvents/activities
  (`kind`: `segment` | `lap` | `pause` | `activity:<subtype>`), the per-interval structure HAE
  loses (their open issue #54)
- `hasRoute`: true when a workout route exists (GPX exported separately on demand as
  `workout-<id>.gpx`)

Readers ignore unknown keys; old files simply lack them. No `_meta` is added (shape compatibility
with every existing consumer).

## 7. Derived daily metrics (inside the EXISTING daily cache, schema stays 1)

New metric names, computed on-device at export time from raw samples. Names are catalog-style
snake case; units in the entry as usual:

- `glucose_time_in_range_pct` (fraction 0..1, 70-180 mg/dL, consensus TIR)
- `glucose_time_below_range_pct` (fraction, <70)
- `glucose_time_above_range_pct` (fraction, >180)
- `glucose_cv_pct` (fraction: SD/mean of the day's readings)
- `glucose_gmi_pct` (fraction: GMI = 3.31 + 0.02392 x mean mg/dL, per Bergenstal 2018; stored /100)

Only written on days with >= 24 glucose readings (a sparse fingerstick day must not masquerade as
CGM coverage; the threshold is stated in the methods page). Values follow the existing rule that
percentage metrics are 0..1 fractions.

## 8. Server surfaces added against these files

- `list_events` (reads 1), `get_profile` (reads 2), `get_workouts` (reads 6, query+pagination),
  `get_sleep_sessions` (reads 3), `get_cycle_context` (reads 4)
- Segment honesty: `get_trends`/`compare_periods`/`get_health_metrics` gain `segmentBoundaries`
  (events inside the window) + a note recommending an event-anchored comparison; `compare_periods`
  gains optional `anchor: {eventId, days}` building equal before/after windows.
- Day filters: `get_health_metrics` gains `filterDays: {eventType?, eventTag?, negate?}` (shift
  work: "HRV on night blocks vs days off").
- `correlate_metrics(metricA, metricB, lag 0..3, start, end)`: aligned-pair counts, direction of
  attribution stated, association-not-causation caveat IN the payload.
- `excludeTravelDays` boolean on trends/compare (reads 5).
- MCP `prompts/list` + `prompts/get` (prompt library, shared source of truth `prompts.mjs`).
- Tool annotations: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` on every
  tool.
- `--demo`: deterministic synthetic dataset for every file above; every payload watermarked
  `demo: true` and every text answer prefixed `[SYNTHETIC DEMO DATA]`.
- CLI: `--doctor` (diagnostics), `status --max-age <hours>` (freshness gate, exit code for cron),
  `receive` (standalone receiver, localhost bind by default).
- 1.6.0: `get_freshness` (stale flag against `HEALTH_STALE_AFTER_HOURS`, default 26 h, or `maxAgeHours`;
  same rule as `status --max-age`) and `get_mcp_status.freshness`; `resolve_metric` plus alias
  resolution (`resolvedFrom`) in the data tools, from the canonical naming and unit table
  (`normalize.mjs`, generated `metric-catalog.mjs`). No file format changed.

## 9. Late-arrival recompute provenance (daily cache schema 1, MINOR 1) (2026-10-02, PR #14)

Why: the daily automation re-reads only the trailing days (today and the two before it; seven
after a timezone move). Apps that write samples into Apple Health long after the moment they
describe (a scale or toothbrush syncing after a gap, a back-logged entry, a resting heart rate
written hours later) left those older days stale in the cache for ever. The app now detects added
and deleted samples with `HKAnchoredObjectQuery` (HealthKit exposes no write date on a sample; the
anchor is the supported "changed since" mechanism), RE-READS every affected local day from
HealthKit statistics (the value is replaced, never appended to), and records provenance here.

Versioning: `_meta.schema` stays **1** (every addition is optional, so a schema-1 reader keeps
working and must not refuse the file). `_meta.schemaMinor: 1` declares that the writer knows this
section. A cache without `schemaMinor` was written before it: no day carries `r`, and past days are
only as fresh as the run that last covered them.

Per point, inside `daily`:

```json
{ "d": "2026-09-20", "v": 1250, "r": "2026-10-02T08:15:00Z" }
```

- `r` (optional): ISO 8601 UTC instant at which this past day was rebuilt because samples arrived
  late or were deleted. ABSENT on every untouched day. Survives later ordinary merges of the same day
  (the rebuild still happened); replaced by a newer rebuild.
- Readers that do not know `r` ignore it (it sits beside `d` and `v`).

In `_meta`:

```json
"_meta": {
  "schema": 1, "schemaMinor": 1, "app": "1.9", "writtenAt": "...",
  "recompute": {
    "capDays": 90,
    "lastRebuiltAt": "2026-10-02T08:15:00Z",
    "lastRebuiltDays": 3,
    "lastRebuiltMetrics": ["step_count", "weight_body_mass"],
    "capped": {
      "weight_body_mass": {
        "at": "2026-10-02T08:15:00Z",
        "reason": "late_samples",
        "oldest": "2025-01-10", "newest": "2025-03-01", "lastDays": 4,
        "uncheckedBefore": "2026-07-04"
      }
    }
  }
}
```

- `capDays`: how far back one run rebuilds. Older affected days are NOT rebuilt (a multi-year bulk
  write must not turn a background wake into a years-long recompute); instead:
- `capped[metric]`: the explicit marker. `reason` is `late_samples` (with the affected date range
  `oldest`..`newest`, widened across runs, and `lastDays` from the most recent detection) or
  `deleted_samples` (HealthKit does not reveal a deleted sample's dates, so only
  `uncheckedBefore` is known: days before it were not re-checked; recorded only when the metric has
  stored days before it; nothing can resolve a dateless marker, so it EXPIRES 30 days after `at`,
  in the app on its next write and in the server when reading). Carried forward on every write. A clean full-history export clears the
  `late_samples` markers set before it started; `deleted_samples` markers stay, because that walk
  merges without a prune and cannot remove a fully deleted day. Purging a metric drops its marker.
- `lastRebuilt*`: the most recent run that rebuilt at least one day.

Writer rules (iOS app, `Sources/BackfillRecompute.swift`):
- Day keys are LOCAL calendar days, the same bucketing as `daily[].d` and the statistics query.
- A day inside the trailing window is never treated as late (that window is re-read anyway).
- Deletions and anchor loss (first run, reinstall, restore onto another phone, unreadable anchor)
  re-read the whole capped window once and stamp only days whose value actually changed; they never
  extend a metric's history backwards past its oldest stored day. No re-read rewrites a day
  bucketed in an earlier time zone (from the timezone log, contract section 5) unless late samples
  were detected on that very day.
- The window's oldest day stays eligible for a detected late sample (detection runs after the
  window read; this closes the race between the two reads at no cost when nothing moved).
- A stored day is REMOVED only when HealthKit reported deletions for that metric. An empty re-read
  (revoked read permission, a new phone still syncing Health) changes nothing.
- Sleep is filed under the waking day, so a late pre-midnight segment also dirties the next day.
- Anchors advance only after the rebuilt days reached every destination that carries them (iCloud,
  folder, local network), so a failed write loses nothing. They are bound to a backup-excluded
  install token, so a backup restore re-bootstraps instead of trusting another store's position.
- No network: every read is a local HealthKit query.
- Local-network (receiver) destination: only the detected late-sample days are pushed, with `r`; the
  receiver keeps a valid ISO `r` and cannot prune, so deletions reach the iCloud and folder caches only.
- Webhook destination: receives the window envelope only, never rebuilt days. A receiver that missed
  days uses Settings > Resend past days instead (section 10).

Reader surfaces (MCP server, `mcp/healthstore.mjs`):
- `get_health_metrics` (day granularity): each point may carry `recomputed_at`; rolled-up buckets
  carry `backfilled_days` (how many of their days were rebuilt). Per metric, a `recompute` block
  `{backfilled_days, recomputed_at, rebuiltDays, capped?, note}` appears only when the range holds
  rebuilt days or reaches back before an applicable `capped.uncheckedBefore` (a `deleted_samples`
  marker only when the caller passed an explicit `start` before it).
- `get_structured_export`: per-day `r` passes through; same per-metric `recompute` block.
- `get_trends`: `recompute` over the compared span; `compare_periods`: `recompute.periodA` /
  `recompute.periodB`, so an agent sees which side holds rebuilt days.
- `get_mcp_status`: `recompute: {supported, capDays, recomputed_at, lastRebuiltDays,
  backfilled_days, metricsWithRebuiltDays, capped[], cappedNote}`.
- Notes are plain mechanics (no judgement about the values, no dashes).
