# Remote media: what Uploaded Source needs

Uploaded Source does not work between two physical devices, and nothing in the
product pretends otherwise. This document is the contract that has to be
satisfied before it can.

## Why it does not work today

A profile's call source is uploaded through the admin dashboard and stored in
that browser's **IndexedDB**. A blob in one browser has no address any other
device can request. Not a slow one, not a restricted one — none. No amount of
signalling changes that, because there is nothing to fetch.

So `LocalMediaAssetProvider.reachableAcrossDevices` is `false`, and everything
above it behaves accordingly:

- the source-selection sheet disables Uploaded Source and says why
- choosing it anyway is refused, and the operator is told
- the signalling service answers `call.source_ready` with
  `unavailableReason: "storage_unreachable"` — never a URL
- the media page labels the asset **Local only**

`storage_unreachable` is deliberately distinct from `not_uploaded`. One is a
deployment that has not been built yet; the other is an operator who has not
uploaded a video. An admin who saw one message for both would go looking in the
wrong place.

**Live Camera is unaffected and works end to end.**

## What a production provider must do

Implement `MediaAssetProvider` (`src/services/media/mediaAssetProvider.ts`) with
`reachableAcrossDevices: true`, backed by storage that satisfies all of the
following. Partial support is worse than none, because each gap fails at a
different and less obvious moment.

### 1. Remotely reachable storage
Object storage or a CDN the caller's device can actually reach. Not the
operator's browser, and not a host that is only routable on an internal network.

### 2. Authorised access
An asset is a specific person's likeness. Access must be granted per request,
tied to a call attempt that is actually in progress. A public bucket URL would
make every profile's source permanently downloadable by anyone who saw one link.

### 3. Short-lived signed playback URLs
The service resolves `mediaAssetId` + `callAttemptId` into a signed URL that
expires in minutes. The browser never mints it — a URL produced by one client is
not something the other should trust. `call.source_ready` already carries
`playbackUrl` and `playbackExpiresAt` for exactly this.

### 4. CORS on the storage origin
The playing device fetches across origins. The storage response needs
`Access-Control-Allow-Origin` for the web app's origin, and must allow the
`Range` header. This is the same class of failure as the signalling CORS problem
in `PHYSICAL_DEVICE_TESTING.md`, and it fails the same confusing way.

### 5. Range requests
A `<video>` element seeks and buffers with `Range` requests. Storage that only
serves whole objects gives a video that will not scrub and may not start until
fully downloaded — on a phone, on cellular, that is not a call.

### 6. Correct MIME type
`video/mp4` or `video/webm`, from the stored metadata. A generic
`application/octet-stream` makes Safari in particular refuse to play it at all.

### 7. Expiry
The URL stops working after the call. A playback link that outlives the call it
was minted for is a permanent copy of somebody's likeness handed to whoever held
it.

### 8. Revocation on change
Replacing or removing a profile's source must invalidate URLs already issued.
Otherwise a caller mid-call keeps playing media the operator has withdrawn.

## Where the code changes

| Piece | Change |
|---|---|
| `mediaAssetProvider.ts` | Implement `remoteMediaAssetProvider`; it currently returns `storage_unreachable` on purpose |
| Admin upload | Write to remote storage as well as, or instead of, IndexedDB |
| `server/signaling` | `onSourceSelected` resolves `mediaAssetId` to a signed URL instead of reporting it unreachable |
| Nothing else | The sheet, the protocol and the guest playback path already handle a real `playbackUrl` |

That last row is the point of the seam. When storage exists, this becomes a
provider implementation and a service method — not a change to any call screen.

## How to know it works

Not by the admin page saying "Ready for calls". By two physical devices: the
host picks Uploaded Source, and the guest — on a different network — sees the
video play full-frame in portrait, without looping, with the subscription
checkpoint still firing at its original scheduled time.

Until that has happened, Uploaded Source is **remote storage required**.
