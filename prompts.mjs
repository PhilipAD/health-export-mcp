// prompts.mjs, the prompt library served over MCP prompts/list + prompts/get.
//
// A PLAIN, JSON-serializable array on purpose: the iOS app vendors this same content, so nothing
// here may be a function, a class, or environment-dependent. server.mjs substitutes {{name}}
// placeholders from prompts/get arguments; an argument left out becomes an instruction to pick
// sensibly, never a dangling template hole.
//
// House style, enforced by prompts.test.mjs: honest coverage before conclusions, association is
// never causation, no diagnosis, no prescriptions, and no em dashes or en dashes anywhere. These
// prompts speak to data the user may find frightening; the style rules are what keep a generated
// answer from quietly becoming medical advice.

const STYLE = ' Style rules: report coverage first (which days exist, which are missing, how fresh the data is) before any conclusion. Describe, do not prescribe: no diagnosis, no treatment advice, no invented scores, no verdicts. State association as association, never causation. Cite the actual numbers, units and dates used. Punctuate with commas, colons and full stops.';

const ABSENCE = ' Remember the absence rule: a missing file or field means it was not exported or not enabled, never that nothing happened.';

export const PROMPTS = [
  {
    name: 'daily_brief',
    description: 'A short morning readout of the most recent day against its trailing week.',
    text: 'Give me a daily brief from my Apple Health data. Call get_mcp_status first and name the most recent data date; if it is older than yesterday, say so plainly and limit every claim to that date. Then pull the latest day of sleep_analysis, heart_rate_variability, resting_heart_rate, step_count and active_energy with get_health_metrics, and set each against its trailing 7 days with get_trends. Keep it under 150 words.' + STYLE,
  },
  {
    name: 'weekly_review',
    description: 'This week against last week across sleep, heart and activity.',
    text: 'Review my week. Use compare_periods to set the last 7 full days against the 7 before them for: sleep_analysis, heart_rate_variability, resting_heart_rate, step_count, exercise_time. Use get_workouts for the same range and list what I actually did. If the answers carry segmentBoundaries, name the events and split the reading around them instead of averaging across. Close with the single largest change, stated with its numbers.' + STYLE,
  },
  {
    name: 'doctor_visit_prep',
    description: 'A one-page data brief to bring to an upcoming appointment.',
    arguments: [{ name: 'visitDate', description: 'The appointment date, YYYY-MM-DD.', required: false }],
    text: 'Help me prepare a one-page data brief for a doctor visit on {{visitDate}}. Call list_events with type visit to find my previous visit; if one exists, use compare_periods with anchor at that event to show what changed since, and list any medication or habit events logged between the visits. Add current values and 90 day trends for resting_heart_rate, heart_rate_variability, sleep_analysis, weight_body_mass and, when present, blood_glucose and its derived daily metrics. End with the questions this data raises, phrased as questions for the clinician, not conclusions. Interpretation belongs in the appointment, not in this brief.' + STYLE + ABSENCE,
  },
  {
    name: 'what_changed_since_last_visit',
    description: 'Changes in the data since the most recent logged doctor visit.',
    text: 'Tell me what changed since my last doctor visit. Call list_events with type visit and take the most recent one. Use compare_periods with anchor at that event (pick days to cover the time since, capped at 90) for resting_heart_rate, heart_rate_variability, sleep_analysis, weight_body_mass and step_count. List every medication, habit or life event logged since the visit, because those are the segment boundaries any change sits on. If no visit is logged, say so and offer the same review anchored on a date I give you.' + STYLE + ABSENCE,
  },
  {
    name: 'sleep_quality',
    description: 'A descriptive read of recent sleep: duration, stages, split nights.',
    text: 'Describe my recent sleep. Use get_sleep_sessions for the last 14 waking days and get_health_metrics for sleep_analysis over the same range. Report nightly duration, stage breakdown when stages exist, and call out split nights (multiple sessions on one waking day) as-is rather than merging them. Sessions are attributed to the waking day; keep that framing so dates match the daily numbers. Report what the numbers show and how they moved, not what they mean for my health.' + STYLE,
  },
  {
    name: 'sleep_regularity',
    description: 'How consistent sleep and wake times are, in minutes, with the sessions cited.',
    text: 'Measure my sleep regularity. Use get_sleep_sessions for the last 21 waking days and work from session start and end timestamps, which carry the local UTC offset. Report the spread of bedtimes and wake times in minutes (a simple range and a typical deviation), cite the sessions used by date, and note any timezone changes from the answers. Do not map the result onto rating bands, colors or labels: the minutes and their trend are the whole answer.' + STYLE,
  },
  {
    name: 'hrv_trend',
    description: 'Heart rate variability over the last month, segment-honest.',
    text: 'Read my HRV trend. Call get_trends for heart_rate_variability with window 30, then get_health_metrics for the same span at day granularity. If the answer carries segmentBoundaries, report the segments separately: an average across a medication start or habit change can be a number that was true on no actual day. HRV is measured under varying conditions, so compare like with like and say when the data cannot support a clean comparison.' + STYLE,
  },
  {
    name: 'training_week_in_review',
    description: 'The last 7 days of workouts with intensity and structure.',
    text: 'Review my training week. Use get_workouts for the last 7 days: list each session with type, duration, distance, average and max heart rate when present, and interval structure when the record carries intervals. Add exercise_time and active_energy daily totals from get_health_metrics. Older workout records may lack the newer fields; report a missing field as not recorded, never as zero.' + STYLE,
  },
  {
    name: 'race_week_prep',
    description: 'The training block a coach would want to see before race week.',
    text: 'Summarize my training block before race week. Use get_workouts over the last 6 weeks: weekly session count, weekly distance, the longest session, and the intensity spread from average heart rates. Then compare the final week to the average of the preceding weeks so the taper, if any, is visible in numbers. Do not prescribe a taper or predict performance: show the numbers a coach would ask for and where the data is thin.' + STYLE,
  },
  {
    name: 'zone_minutes_summary',
    description: 'Time by heart rate band across recent workouts, relative to this file.',
    text: 'Summarize my time by heart rate band. Use get_workouts for the last 28 days and band each session by its average heart rate relative to the maximum heart rate observed anywhere in this file (state that maximum and its date). Report minutes per band and per activity type. Say clearly that these bands are relative to my own recorded data, not clinical zones, and that a session average smooths over surges within it. Where avgHeartRate is absent, count the session as unbanded rather than guessing.' + STYLE,
  },
  {
    name: 'experiment',
    description: 'Run an n-of-1 before/after read around a logged intervention event.',
    arguments: [{ name: 'intervention', description: 'What was changed, e.g. magnesium at night.', required: false }],
    text: 'Help me evaluate an experiment: {{intervention}}. First call list_events to find the event that marks the change; if none is logged, tell me to log it in the iOS app (this server is read-only) and stop. With the event id, run compare_periods with anchor {eventId, days: 14} for the metrics the intervention could plausibly touch, then correlate_metrics between the intervention-relevant metric pairs with lag 0 and lag 1, since an evening change often lands on the next day. Narrate insufficiency honestly: if a window is thin, if r is withheld for too few pairs, or if segmentBoundaries show another change inside the window, say the experiment cannot be read cleanly yet and what more data would help. Association is not causation, and one person is one person.' + STYLE,
  },
  {
    name: 'medication_before_after',
    description: 'Before/after read around a logged medication start.',
    arguments: [{ name: 'medication', description: 'The medication name or event tag.', required: false }],
    text: 'Show me before and after for {{medication}}. Find the medication event with list_events (type medication, or the tag). Use compare_periods with anchor at the event, days 14 and again days 28, for resting_heart_rate, heart_rate_variability, sleep_analysis and any metric the tags point at. The event day is excluded from both sides by design. Report each change with its coverage, and keep segments honest if other events sit inside either window. This is a description of recorded data, not an assessment of the medication: if anything here prompts a thought about changing a dose, discuss changes with your prescriber, because nothing in this data can support that decision alone.' + STYLE + ABSENCE,
  },
  {
    name: 'glp1_dose_step_compare',
    description: 'Per-dose-step segments for weight and related metrics, honestly bounded.',
    text: 'Compare my GLP-1 dose steps. Call list_events (type medication) and treat each dose-step event as a segment boundary; read weight_body_mass, step_count and sleep_analysis per segment with get_health_metrics using each segment\'s date range, not one average across all of them. State each segment\'s coverage: sparse weigh-ins make a segment mean fragile, and say so when days are few. Weight alone cannot separate fat from lean mass: if lean_body_mass or body_fat_percentage exist in list_metrics report them alongside, and if they do not, say plainly that this data cannot tell the composition of the change. No dosing commentary: changes belong with the prescriber.' + STYLE,
  },
  {
    name: 'sobriety_milestone',
    description: 'The data story since a logged quit date, with the early window reported separately.',
    text: 'Show me what changed since my quit date. Find the habit event with list_events and use compare_periods with anchor at it for sleep_analysis, heart_rate_variability and resting_heart_rate, plus get_health_metrics at day granularity since the event. Report weeks 1 and 2 separately from the later trend: the early window after stopping often looks worse in sleep and heart data while the body adjusts, and folding it into one average would hide the later change. Mark the milestone by stating the number of days since the event date. Congratulate with numbers, not judgment.' + STYLE + ABSENCE,
  },
  {
    name: 'shift_block_compare',
    description: 'On-shift days against off days using the day filter.',
    text: 'Compare my shift blocks against days off. Use get_health_metrics with filterDays {eventType: "shift"} and again with filterDays {eventType: "shift", negate: true} for heart_rate_variability, sleep_analysis and resting_heart_rate. The answers state how many days each filter matched: report those counts first, because a 4-day filter against a 300-day remainder is an unbalanced comparison and the reader needs to see that. Sleep on shift days is attributed to the waking day, so say which side a sleep number belongs to. If no shift events are logged the filter will error; relay that as setup guidance, not as absence of shift work.' + STYLE,
  },
  {
    name: 'travel_honest_monthly_review',
    description: 'A monthly review with timezone-change days excluded and accounted for.',
    text: 'Review my last month with travel honesty. Run get_trends (window 30) and compare_periods (this month vs last) for step_count, sleep_analysis and heart_rate_variability with excludeTravelDays: true. Every answer reports how many days were excluded and why: repeat those counts in your summary, because a day on which the timezone changed was not 24 hours long and its totals are artifacts of the clock. If the answers say no timezone log exists, say the review could not be travel-adjusted rather than pretending it was.' + STYLE,
  },
  {
    name: 'cycle_aware_trend_read',
    description: 'Read a metric trend against cycle phase, comparing like phase with like phase.',
    arguments: [{ name: 'metric', description: 'The metric to read, e.g. heart_rate_variability.', required: false }],
    text: 'Give me a cycle-aware read of {{metric}}. Call get_cycle_context for the day-in-cycle and phase labels, which are derived from logged periods and are not predictive. Then compare the current phase with the SAME phase of prior cycles using compare_periods with explicit date ranges built from the cycle starts, not with the adjacent weeks: adjacent-week comparisons mix phases and manufacture trends. State the observed cycle lengths used and that phase labels are coarse (follicular to the observed midpoint, luteal after). Where fewer than two prior cycles exist, say a like-phase comparison is not yet possible.' + STYLE + ABSENCE,
  },
  {
    name: 'caregiver_daily_checkin',
    description: 'A calm daily check-in that separates data gaps from changes in the numbers.',
    text: 'Give me a caregiver check-in on this data. Coverage comes first and is most of the answer: call get_mcp_status and state when data last arrived; if the latest day is missing or partial, report a REPORTING GAP and stop there, because a missing day is a sync question, not a health finding. Only when coverage is current, summarize the last day of step_count, sleep_analysis, heart_rate and resting_heart_rate against the trailing week with get_trends. Never use alarm language: state numbers, their usual range in this file, and whether today sits inside it. If something looks unusual AND coverage is solid, suggest checking in with the person, which is always the right first step.' + STYLE,
  },
  {
    name: 'glucose_day_summary',
    description: 'One day of glucose in the consensus reporting metrics, no advice.',
    arguments: [{ name: 'date', description: 'The day to summarize, YYYY-MM-DD.', required: false }],
    text: 'Summarize my glucose for {{date}}. Use get_health_metrics for that day for: glucose_time_in_range_pct (70 to 180 mg/dL), glucose_time_below_range_pct, glucose_time_above_range_pct, glucose_cv_pct, glucose_gmi_pct and blood_glucose. These derived metrics are stored as 0 to 1 fractions: multiply by 100 to speak in percent. They exist only on days with at least 24 readings, so an absent day means insufficient readings, not a perfect or terrible day. Report the numbers in the standard consensus format (time in range, below, above, variability, GMI), and offer no interpretation beyond the numbers: glucose management decisions belong with the person\'s care team.' + STYLE + ABSENCE,
  },
  {
    name: 'long_term_activity_narrative',
    description: 'The multi-year activity story at monthly resolution.',
    text: 'Tell my long-term activity story. Call list_metrics first to see how far back the file goes and say it. Then use get_health_metrics with granularity month (or quarter for many years) for step_count, exercise_time, walking_running_distance and active_energy, and get_workouts paged over the full range for the workout mix by year. Narrate eras: sustained rises, plateaus, gaps. Label a gap as missing data when coverage says so, never as inactivity.' + STYLE,
  },
  {
    name: 'data_coverage_audit',
    description: 'What this export actually contains: surfaces, ranges, gaps.',
    text: 'Audit my data coverage. Call get_mcp_status for the source, freshness and which context files exist (events, profile, sessions, cycles, days), then list_metrics for every metric\'s day count and date range. Report: total metrics, the ten deepest histories, metrics that stopped updating (lastDate well before the newest data date), and which optional surfaces are absent. For each absent surface state what enabling it would add, and repeat that absence means not exported, not empty. This audit is about the data, so no health commentary at all.' + STYLE + ABSENCE,
  },
  {
    name: 'profile_aware_context_bootstrap',
    description: 'Open a session with the user\'s opted-in context loaded and its limits stated.',
    text: 'Bootstrap your context about me from this server. Call get_mcp_status, get_profile and list_events in that order. From the profile, note the fields I chose to share and treat presentFields as the complete list: any field not present was withheld or never enabled and must not be assumed empty or asked about as if missing. From events, note ongoing range events (shifts, travel, episodes) that frame current data. Then confirm in two sentences what context you are carrying and what you deliberately do not know. Do not fetch metric data yet: this prompt only sets the table.' + STYLE + ABSENCE,
  },
];
