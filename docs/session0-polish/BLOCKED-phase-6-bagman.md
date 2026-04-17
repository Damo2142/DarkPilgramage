# BLOCKED — Phase 6: Bagman escalation

**Status:** deferred to follow-up session.

**Why blocked:** Phase 6 requires a new REST endpoint, server-side d20 rolls, per-tier escalation state, DM panel button additions in `dashboard/public/index.html` — multi-file code change.

**Quick manual workaround for Sunday:** The Bagman flag is already wired at `state.items.bag-of-holding-cellar.bagman:true` (pre-existing). Dave narrates the 8-tier escalation at the table using the spec below, no endpoint required. The hook file `futureHooks.bagman` (already in session-0.json) exists to trigger the full Bagman encounter on the road to Houska — that's the payoff, not Sunday.

## What the follow-up session needs to build

### 6.1 State extension (item-state-service or inline on map-service)

```js
state.items['bag-of-holding-cellar'].bagmanState = {
  reachCount: 0,
  lastReachTurn: null,    // combat turn index if in combat
  carrier: null,          // playerId currently carrying the bag
  awareOfParty: false     // flips true at reachCount >= 5
}
```

### 6.2 Escalation outcomes (spec from work order)

| Reach # | Outcome |
|---|---|
| 1 | Safe. Correct item. Slightly cold inside. |
| 2 | Safe. Correct item. Reaching hand feels briefly watched. |
| 3 | Correct item + a second item (dry leaf, lock of grey hair, child's tooth). |
| 4 | Correct item, damp. |
| 5 | Voice whispers "Thank you." Sets awareOfParty=true. |
| 6 | Cold breath on the back of the hand. Item warmer than it should be. |
| 7 | d20: 1-5 pale finger grazes wrist; 6-20 item only. |
| 8+ | STR save DC 12 to withdraw. Something held them for half a second. |

All outcomes deliver the requested item regardless. Whispers route private to the reaching PC's Chromebook; DM earbud gets mechanical context.

### 6.3 Endpoint

```
POST /api/items/bag-of-holding/reach
  body: { playerId, requestedItem }
  response: {
    itemDelivered: true,
    tier: 3,
    privateWhisperToPlayer: "...",
    dmEarbudContext: "..."
  }
```

### 6.4 Ambient passive

Every ~20 minutes while bag is closed + unattended, dispatch a DC 14 passive-perception observation on the nearest PC to the bag's position: "The flap of the bag shifts. Nothing inside moves, but the flap opens slightly, then closes when you look."

### 6.5 DM panel button

In the DM's section for whichever PC carries the bag (state.items...carrier), add a "Reach into bag" button that opens a modal: "Which item?" + requested-item text input. Calls the new endpoint.

## Effort estimate

~3 hours: state model, endpoint, 8-tier resolver, DM button, one whisper dispatch. No complex UI.

## Risk if not landed Sunday

The bag is narratively live — Ed will probably pick it up from Gregor's body at 21:12. Without the escalation system, Dave narrates the tiered outcomes manually from the spec above. The futureHook payoff at Houska remains intact because the `bagman:true` flag is already set when Ed takes the bag.
