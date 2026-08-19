# Logging data INTO Apple Health, without giving up read-only

MetricBridge is strictly read-only and stays that way: the 190 read permissions the app asks
for are defensible precisely because it can never write. So "log my weight: 82.4" said to your
agent cannot land in Apple Health through this app, by design.

The Shortcuts app closes the loop instead. Shortcuts has native, Apple-reviewed Health WRITE
actions, and a shortcut can be triggered by voice or by URL. The write authorization belongs to
Shortcuts, granted by you in the normal Health permission dialog, on the phone, per data type.

## Recipe: a "Log Weight" shortcut

1. Open Shortcuts on the iPhone, create a new shortcut named `Log Weight`.
2. Add action: "Ask for Input" (Number).
3. Add action: "Log Health Sample", type Weight, value: Provided Input.
4. Say "Hey Siri, log weight" and speak the number, or run it from the Shortcuts widget.

Repeat the pattern for water, caffeine, mindful minutes, or blood pressure: each is one
shortcut with one Health write action.

## Triggering from a desktop agent

A shortcut can be invoked over the shortcuts URL scheme from the phone itself. From a desktop
agent the honest path is a reminder, not a remote write: have the agent draft the entry and
send it to the phone (a message, a reminder, a note), and confirm it with one tap in Shortcuts
on the device. The number enters Health under your finger, not an agent's.

The next daily export then picks the new sample up like any other, and your agent sees the
value it asked you to log, exported by the same read-only pipeline as everything else.
