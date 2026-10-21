---
'iwer': minor
'@iwer/extension-bridge': minor
---

`run_sequence` runs a whole hand interaction in one call (see "Sequences" in the Scripting Hand Interactions guide): `device.remote.runSequence()`, MCP `xr_run_sequence`.

- Steps place the hand by an anchor at a named target or a position (XR origin, or relative to the head or the floor under the body), press targets with the index fingertip (`press`), pinch on arrival, set a held object down on a surface, fade poses and turn the hand. Each move is one smooth arc (`approach` / `depart` come straight in and lift straight off), the head turns to each target first (`gaze`), the body leans toward low targets and steps closer to ones out of reach (`body`, or a step's own `body` move), and the other hand rests by the hip (`idleHand`).
- Every step property can be timed within its step (`{ value, start, end, easing }`); `duration: 'auto'` (the default for moves) scales with the path, the wrist turn and pose changes. Each step's end is shown for a frame and the frame's leftover time carries over, so uneven frame rates give the same motion; a press keeps the fingertip in touch for at most 0.35 s of sequence time.
- The page resolves target names with `device.remote.setTargetResolver({ resolve, list? })`; `list_targets` (MCP `xr_list_targets`) lists them. Targets are resolved when the sequence is sent and again when their step starts; listed boxes are also obstacles the hand arcs over.
- Sequences are validated before anything moves (strict keys, every error naming its step, targets, reach with `body: 'fixed'`, and the time budget: the sequence plus everything queued ahead must fit 25 s), need a live hand when they reach the head of the queue, and give up 28 s after they were sent. `dryRun: true` returns the expanded plan without moving.
- The result reports the steps' times, the select events the app saw (from the hand's own button edges, in native mode too), each press's real contact time, warnings and the final hand state; a failed step reports `failedStep` and `reason`.
- `cancel_sequence` (MCP `xr_cancel_sequence`) stops a running sequence at once, leaving the pinch as it is; `forceRelease()`, the session ending and the queue watchdog also stop one, and it resolves with its partial result instead of rejecting.
- `iwer/lib/remote/catalog.js` publishes JSON Schema for the parameters of every remote method (`REMOTE_METHOD_SCHEMAS`), for tool hosts; the extension bridge's schemas are tested against it.
- MCP: `CATALOG_VERSION` is 4; the new tools reject unknown parameters, top level and nested.
- Types: `RunSequenceParams`, `SequenceStep`, `SequenceResult`, `SequencePlan`, `TargetResolver`, `ResolvedTarget` and friends are exported; `TickAction` gains optional `abort`, `estimateMs` and `elapsedMs`.
