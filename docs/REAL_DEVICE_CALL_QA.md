# Real-device call QA

Automated tests prove orchestration. They do not prove that a call works on a
phone somebody is holding.

Chromium with fake devices cannot tell you whether iOS Safari plays remote audio
after a screen lock, whether an Android camera flips without dropping the track,
or whether a call survives moving from Wi-Fi to cellular. Those need hardware.

**Record the result honestly. An untested row stays NOT TESTED.** A checklist
full of optimistic ticks is worse than no checklist, because it stops anyone
looking again.

## Before you start

You need HTTPS on both devices. See
[`docs/PHYSICAL_DEVICE_TESTING.md`](./PHYSICAL_DEVICE_TESTING.md) — a phone
opening `http://192.168.x.x` gets no camera and no microphone, because the
`localhost` secure-context exception does not extend to it.

Also required:

- the signalling service reachable from both devices over `wss://`
- the web app's origin in `SIGNALING_ALLOWED_ORIGINS`
- the same profile present on both devices (local mode resolves Call IDs in each
  browser's own storage)
- **TURN configured** for anything beyond one Wi-Fi network. Without it, a
  cellular-to-cellular call is expected to fail, and that failure is not a bug —
  it is the missing relay.

## Device matrix

| # | Guest | Host | Result | Date | Notes |
|---|---|---|---|---|---|
| 1 | iPhone Safari | Android Chrome | NOT TESTED | | |
| 2 | Android Chrome | iPhone Safari | NOT TESTED | | |
| 3 | iPhone Safari | iPhone Safari | NOT TESTED | | |
| 4 | Android Chrome | Android Chrome | NOT TESTED | | |

## Per-combination checklist — video

Run every row for each combination above.

| Check | Expected | Result |
|---|---|---|
| Call ID resolves | Host's name and avatar shown | NOT TESTED |
| Permission screen appears **before** the browser prompt | CallaStar explains first | NOT TESTED |
| Host rings | Full-screen incoming call, caller's name correct | NOT TESTED |
| Answer | Source sheet appears; camera **not** yet on | NOT TESTED |
| Live Camera selected | Camera permission asked only now | NOT TESTED |
| Guest sees host's live camera | Fills the portrait frame, not stretched | NOT TESTED |
| Host sees guest's live camera | Same | NOT TESTED |
| Audio both directions | Each hears the other | NOT TESTED |
| Mute | Other side stops hearing; no reconnect | NOT TESTED |
| Camera off / on | Other side loses and regains picture; call survives | NOT TESTED |
| Flip camera | Switches front/rear; **same** call, timer unbroken | NOT TESTED |
| Rotate to landscape | "Rotate your phone" overlay; call still running underneath | NOT TESTED |
| Return to portrait | Overlay goes; same call, same timer, no re-prompt | NOT TESTED |
| Background the app ~10s | Call survives; audio may pause on iOS | NOT TESTED |
| Wi-Fi → cellular | Reconnects, or fails honestly. **Needs TURN** | NOT TESTED |
| Hangup from guest | Host leaves the call promptly | NOT TESTED |
| Hangup from host | Guest sees "Call ended" | NOT TESTED |
| **Camera indicator goes out** | OS indicator off on both devices after the call | NOT TESTED |
| **Microphone indicator goes out** | Same | NOT TESTED |

The last two matter more than they look. A camera light still on after a call is
the single worst bug this product can ship.

## Per-combination checklist — audio

| Check | Expected | Result |
|---|---|---|
| Audio call from a phone | Connects, both hear each other | NOT TESTED |
| Audio call from desktop | Connects, both hear each other | NOT TESTED |
| **No camera prompt anywhere** | Camera never requested | NOT TESTED |
| Mute | Other side stops hearing | NOT TESTED |
| Hangup | Both leave; microphone indicator off | NOT TESTED |

## Device policy

| Check | Expected | Result |
|---|---|---|
| Desktop → Video Call | **Blocked** before any camera, peer connection or invitation | NOT TESTED |
| Desktop → "Continue with Audio" | Audio call proceeds normally | NOT TESTED |
| Desktop → Audio Call directly | Works | NOT TESTED |
| Desktop window narrowed to 390px → Video | Still blocked; still a desktop | NOT TESTED |
| Tablet → Video Call | Blocked (tablet is deliberately not a supported video device) | NOT TESTED |
| Tablet → Audio Call | Works | NOT TESTED |

Automated coverage exists for the four desktop rows in `tests/e2e/`, in Chromium
only. Confirming them on a real machine is still worth doing once.

## Portrait layout

Check the live call at each width, in portrait:

| Width | Check | Result |
|---|---|---|
| 375×812 | Fills the screen, no horizontal scroll | NOT TESTED |
| 390×844 | Same | NOT TESTED |
| 393×852 | Same | NOT TESTED |
| 430×932 | Same | NOT TESTED |

At every width: the top bar clears the notch, the controls clear the home
indicator, the self-view stays portrait and does not cover the controls, and
neither camera is stretched.

## Known failures that are not bugs

- **Cellular-to-cellular fails without TURN.** Expected. Configure a relay.
- **iOS audio pauses when the screen locks.** A browser is not a native phone
  app; the product says "Keep CallaStar open" for this reason.
- **Uploaded Source does not reach the other device.** The asset lives in the
  operator's browser storage. The host is told so rather than the caller being
  shown a frame that never loads.
